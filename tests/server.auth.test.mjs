// 后端认证模块单测 —— 密码哈希 / 会话 / cookie
//
// 后端是 JS, 测试也用 JS 写 (省掉 .mjs 的类型声明文件).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  hashPassword,
  verifyPassword,
  createSession,
  sessionUser,
  destroySession,
  parseCookies,
  serializeCookie,
} from '../scripts/server/auth.mjs'
import { openDb } from '../scripts/server/db.mjs'

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-auth-'))
  const db = openDb(dir)
  return {
    db,
    dir,
    cleanup() {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function makeUser(db, username = 'violin') {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(username, await hashPassword('hunter2secret'), Date.now())
  return Number(info.lastInsertRowid)
}

describe('hashPassword / verifyPassword', () => {
  it('正确密码验证通过', async () => {
    const h = await hashPassword('hunter2secret')
    expect(await verifyPassword('hunter2secret', h)).toBe(true)
  })

  it('错误密码验证失败', async () => {
    const h = await hashPassword('hunter2secret')
    expect(await verifyPassword('hunter2secre', h)).toBe(false)
    expect(await verifyPassword('', h)).toBe(false)
  })

  it('同一个密码两次哈希不同 (随机盐)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'))
  })

  it('不存明文', async () => {
    const h = await hashPassword('plaintext-password')
    expect(h).not.toContain('plaintext-password')
    expect(h.startsWith('scrypt$')).toBe(true)
  })

  it('哈希串被改坏时验证失败而不是抛异常', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', null)).toBe(false)
  })

  // ★ 2026-11-01 (审核报告 §2.2 P0-2): scrypt 改成异步, 不再阻塞事件循环.
  it('hashPassword 是异步的 (不阻塞事件循环)', () => {
    const p = hashPassword('x')
    expect(typeof p.then).toBe('function')
    return p
  })

  // ★ 2026-11-01 (审核报告 §2.5 P1-3): N/r/p 来自数据库, 必须有边界.
  it('哈希串里的 scrypt 参数被改过 → 拒绝 (不让 N=2^30 把进程 OOM 掉)', async () => {
    const h = await hashPassword('hunter2secret')
    const parts = h.split('$')
    const tampered = [parts[0], '1073741824', parts[2], parts[3], parts[4], parts[5]].join('$')
    expect(await verifyPassword('hunter2secret', tampered)).toBe(false)
  })

  it('输出长度越界的哈希串 → 拒绝', async () => {
    const h = await hashPassword('hunter2secret')
    const parts = h.split('$')
    const short = [parts[0], parts[1], parts[2], parts[3], parts[4], 'AAAA'].join('$')
    expect(await verifyPassword('hunter2secret', short)).toBe(false)
  })
})

describe('session', () => {
  it('建会话后能用 token 找回用户', async () => {
    const t = tmpDb()
    try {
      const userId = await makeUser(t.db)
      const { token } = createSession(t.db, userId, false)
      // sessionUser 还会带上 isAdmin / remember / expiresAt / token 等字段
      expect(sessionUser(t.db, token)).toMatchObject({
        id: userId,
        username: 'violin',
        isAdmin: false,
        remember: false,
      })
    } finally {
      t.cleanup()
    }
  })

  it('token 错了就认不出', async () => {
    const t = tmpDb()
    try {
      const userId = await makeUser(t.db)
      createSession(t.db, userId, false)
      expect(sessionUser(t.db, 'not-a-real-token')).toBeNull()
      expect(sessionUser(t.db, '')).toBeNull()
    } finally {
      t.cleanup()
    }
  })

  it('过期会话返回 null 并被清掉', async () => {
    const t = tmpDb()
    try {
      const userId = await makeUser(t.db)
      const { token } = createSession(t.db, userId, false)
      // 手动把过期时间拨到过去
      t.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1000)
      expect(sessionUser(t.db, token)).toBeNull()
      const left = t.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()
      expect(Number(left.n)).toBe(0)
    } finally {
      t.cleanup()
    }
  })

  it('登出后 token 失效', async () => {
    const t = tmpDb()
    try {
      const userId = await makeUser(t.db)
      const { token } = createSession(t.db, userId, false)
      destroySession(t.db, token)
      expect(sessionUser(t.db, token)).toBeNull()
    } finally {
      t.cleanup()
    }
  })

  it('记住我的会话有效期比普通登录长', async () => {
    const t = tmpDb()
    try {
      const userId = await makeUser(t.db)
      const short = createSession(t.db, userId, false)
      const long = createSession(t.db, userId, true)
      expect(long.maxAge).toBeGreaterThan(short.maxAge)
    } finally {
      t.cleanup()
    }
  })

  it('数据库里不存 token 原文', async () => {
    const t = tmpDb()
    try {
      const userId = await makeUser(t.db)
      const { token } = createSession(t.db, userId, true)
      const rows = t.db.prepare('SELECT token_hash FROM sessions').all()
      expect(rows.map((r) => r.token_hash)).not.toContain(token)
    } finally {
      t.cleanup()
    }
  })
})

describe('cookie 解析 / 序列化', () => {
  it('parseCookies 能拆出多个 cookie', () => {
    const out = parseCookies('pf_session=abc123; other=1')
    expect(out.pf_session).toBe('abc123')
    expect(out.other).toBe('1')
  })

  it('parseCookies 对空 header 返回空对象', () => {
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies('')).toEqual({})
  })

  it('serializeCookie 带 HttpOnly / SameSite, secure 可选', () => {
    const plain = serializeCookie('pf_session', 'tok', { maxAge: 60 })
    expect(plain).toContain('pf_session=tok')
    expect(plain).toContain('HttpOnly')
    expect(plain).toContain('SameSite=Lax')
    expect(plain).toContain('Max-Age=60')
    expect(plain).not.toContain('Secure')

    const secure = serializeCookie('pf_session', 'tok', { maxAge: 60, secure: true })
    expect(secure).toContain('Secure')
  })
})
