// 后端加固回归测试 —— 覆盖审核报告 §2.1 / §2.3 / §2.5 / §2.6 / §2.7 / §2.8
// (2026-11-01 实施)
//
// 这些都是"攻击面"用例 —— 原来的 41 个测试文件只覆盖了正常路径,
// 上面的 P0 就是因为没有这类用例才一直没被发现.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { openDb } from '../scripts/server/db.mjs'
import { createHandler } from '../scripts/server/handler.mjs'
import { hashPassword } from '../scripts/server/auth.mjs'

let server
let base
let dir
let db
let root
/** 手动带 cookie (node fetch 没有 cookie jar) */
let cookie = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hard-'))
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hard-root-'))
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>pf</title>')
  fs.writeFileSync(path.join(root, 'manifest.json'), '{"v":1}')
  fs.writeFileSync(path.join(root, 'assets', 'app.abc123.js'), 'console.log(1)')

  db = openDb(dir)
  const handler = createHandler({ db, dataDir: dir, root })
  server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  // 先注册一个账号, 后面的用例直接用它的登录态
  await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'hunter2secret' }),
  }).then((r) => {
    const sc = r.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0]
  })
})

afterAll(() => {
  server?.close()
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

async function api(p, opts = {}) {
  const headers = { ...(opts.headers ?? {}) }
  if (cookie) headers.Cookie = cookie
  const resp = await fetch(base + p, { ...opts, headers })
  const setCookie = resp.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return resp
}

async function json(p, opts) {
  const resp = await api(p, opts)
  const text = await resp.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  return { resp, data }
}

async function login(username = 'tester', password = 'hunter2secret') {
  const { resp } = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return resp
}

const MIDI_BYTES = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06])

// =============================================================================
describe('P0-1 · 坏 stored_path 不能把进程打崩', () => {
  it('stored_path 为空 → 404 (不是 EISDIR 崩溃)', async () => {
    await login()
    // 手工插一行"文件没落盘"的坏数据 (老版本两步写入留下的)
    const info = db
      .prepare(
        `INSERT INTO scores (user_id, title, subtitle, composer, key_name, duration, difficulty,
                             tracks, tags, filename, ext, size, stored_path, created_at)
         VALUES (1, '坏行', '', '', '', NULL, 3, '1', '', 'x.mid', 'mid', 8, '', ?)`,
      )
      .run(Date.now())
    const id = Number(info.lastInsertRowid)

    const resp = await api(`/api/scores/${id}/file`)
    expect(resp.status).toBe(404)

    // 服务还活着 (崩溃的话这里会 ECONNREFUSED)
    const health = await api('/api/health')
    expect(health.status).toBe(200)
  })

  it('stored_path 指向一个目录 → 404', async () => {
    await login()
    const info = db
      .prepare(
        `INSERT INTO scores (user_id, title, subtitle, composer, key_name, duration, difficulty,
                             tracks, tags, filename, ext, size, stored_path, created_at)
         VALUES (1, '指向目录', '', '', '', NULL, 3, '1', '', 'x.mid', 'mid', 8, ?, ?)`,
      )
      .run('uploads', Date.now())
    const id = Number(info.lastInsertRowid)

    const resp = await api(`/api/scores/${id}/file`)
    expect(resp.status).toBe(404)
  })

  it('上传成功后 stored_path 一次写全 (不留空串)', async () => {
    await login()
    const up = await json('/api/scores?filename=ok.mid&title=OK', {
      method: 'POST',
      body: MIDI_BYTES,
    })
    expect(up.resp.status).toBe(201)
    const row = db.prepare('SELECT stored_path FROM scores WHERE id = ?').get(up.data.score.id)
    expect(row.stored_path).toBeTruthy()
    expect(row.stored_path).not.toBe('')
    // 文件真的在磁盘上
    const abs = path.join(dir, row.stored_path)
    expect(fs.existsSync(abs)).toBe(true)
    expect(fs.statSync(abs).size).toBe(MIDI_BYTES.length)
  })
})

// =============================================================================
describe('P1-1 · X-Forwarded-For 不能伪造限流桶', () => {
  it('换不同的 XFF 前缀, 限流照样生效 (取的是最后一段)', async () => {
    let limited = false
    for (let i = 0; i < 30 && !limited; i++) {
      const resp = await api('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 每次伪造一个不同的第一段, 但"真客户端"那段固定不变
          'X-Forwarded-For': `10.0.0.${i}, 203.0.113.9`,
        },
        body: JSON.stringify({ username: 'nobody', password: 'wrong-password' }),
      })
      if (resp.status === 429) limited = true
    }
    expect(limited).toBe(true)
  })
})

// =============================================================================
describe('P1-4 · 非法百分号编码应该是 400', () => {
  it('/%ZZ → 400 (不是 500)', async () => {
    const resp = await api('/%ZZ')
    expect(resp.status).toBe(400)
  })

  it('/%E4% (截断的 UTF-8) → 400', async () => {
    const resp = await api('/%E4%')
    expect(resp.status).toBe(400)
  })
})

// =============================================================================
describe('P1-5 · 缓存策略', () => {
  it('vite 产物 (assets/) → 长缓存 + immutable', async () => {
    const resp = await api('/assets/app.abc123.js')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('cache-control')).toContain('immutable')
  })

  it('manifest.json → no-cache (改完要立刻生效)', async () => {
    const resp = await api('/manifest.json')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('cache-control')).toBe('no-cache')
  })

  it('index.html → no-cache', async () => {
    const resp = await api('/')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('cache-control')).toBe('no-cache')
  })
})

// =============================================================================
describe('P1-6 · 安全响应头', () => {
  it('静态资源带 nosniff / no-referrer / DENY / CSP', async () => {
    const resp = await api('/')
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resp.headers.get('referrer-policy')).toBe('no-referrer')
    expect(resp.headers.get('x-frame-options')).toBe('DENY')
    expect(resp.headers.get('content-security-policy')).toContain("default-src 'self'")
  })

  it('API 响应也带安全头', async () => {
    const resp = await api('/api/health')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff')
    expect(resp.headers.get('x-frame-options')).toBe('DENY')
  })
})

// =============================================================================
describe('健康检查', () => {
  it('/api/health → 200', async () => {
    const { resp, data } = await json('/api/health')
    expect(resp.status).toBe(200)
    expect(data.ok).toBe(true)
  })
})

// =============================================================================
describe('P0-2 · 密码哈希不能卡住事件循环', () => {
  // 旧实现用 scryptSync —— N=16384/r=8 要 16MB 内存 + 几十~上百毫秒纯 CPU,
  // 期间整个 Node 事件循环停摆: 静态资源 / LED 代理 / 所有 API 全部排队.
  // 这个后端同时扛着「静态站点 + 用户 API + WSS 反代(灯带控制)」,
  // 一次登录就能把灯带控制和网页一起卡住.
  it('hashPassword 跑的同时, 定时器仍在触发 (走线程池而非主线程)', async () => {
    const marks = []
    const timer = setInterval(() => marks.push(Date.now()), 2)
    const t0 = Date.now()
    await hashPassword('hunter2secret')
    const t1 = Date.now()
    clearInterval(timer)

    const during = marks.filter((m) => m >= t0 && m <= t1)
    // 同步实现 → 整段计算期间事件循环被占死, 一个心跳都跳不出来
    expect(during.length).toBeGreaterThan(0)
    expect(t1 - t0).toBeGreaterThan(5) // 别让测试"因为太快"而失去意义
  })

  it('登录还在算 hash 时, 其它 API 请求照样立刻返回', async () => {
    // 先量一次纯哈希耗时当基准
    const t0 = Date.now()
    await hashPassword('benchmark-password')
    const hashMs = Date.now() - t0

    const loginP = json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'hunter2secret' }),
    })

    // 连续打几个 health —— 同步实现下它们会全部排在 hash 后面
    const latencies = []
    for (let i = 0; i < 5; i++) {
      const t = Date.now()
      const { resp } = await json('/api/health')
      expect(resp.status).toBe(200)
      latencies.push(Date.now() - t)
    }
    await loginP

    expect(Math.max(...latencies)).toBeLessThan(hashMs)
  })
})
