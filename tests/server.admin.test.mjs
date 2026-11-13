// 管理员 + 公共乐库保存 —— 真起一个 HTTP server 打一遍
//
// 覆盖:
//   - 启动时自动建管理员账号 (用户名 loveinshare, 密码这里显式给 ——
//     生产上没设 ADMIN_PASSWORD 就是随机生成的, 没有公开的默认口令)
//   - 非管理员存到公共乐库被拒 (403)
//   - 管理员存新曲目 → 文件落 public/library/ + manifest 加一条
//   - 管理员存已有曲目 (带 itemId) → 原地替换, 不多出重复条目
//   - 会话时长: 记住我 = 1 年, 普通 = 30 天, 滑动续期

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { openDb } from '../scripts/server/db.mjs'
import { createHandler } from '../scripts/server/handler.mjs'
import { ensureAdminUser, sessionUser } from '../scripts/server/auth.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')
/** 测试用的管理员口令 —— 生产上没设 ADMIN_PASSWORD 时是随机生成的. */
const ADMIN_PW = 'test-admin-pw'

let server
let base
let dir
let db
let libDir
let cookie = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-admin-'))
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lib-'))
  fs.mkdirSync(path.join(libDir, 'chopin'), { recursive: true })
  // 造一个公共乐库: 一首已有曲子 + manifest
  fs.writeFileSync(path.join(libDir, 'chopin', 'demo.mid'), 'OLD-BYTES')
  fs.writeFileSync(
    path.join(libDir, 'manifest.json'),
    JSON.stringify(
      {
        version: 1,
        groups: [
          {
            id: 'chopin',
            name: 'Chopin',
            items: [
              {
                id: 'demo',
                title: 'Demo',
                subtitle: '旧标题',
                composer: 'Chopin',
                key: 'C# minor',
                difficulty: 4,
                tags: ['famous'],
                file: 'chopin/demo.mid',
                tracks: 2,
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
  )

  db = openDb(dir)
  await ensureAdminUser(db, { password: ADMIN_PW })
  const handler = createHandler({ db, dataDir: dir, root: DIST, publicLibDir: libDir })
  server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server?.close()
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(libDir, { recursive: true, force: true })
})

/** 带 cookie 的请求 (node fetch 没有 cookie jar) */
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

async function login(username, password, remember = true) {
  cookie = ''
  const { resp, data } = await json('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, remember }),
  })
  expect(resp.status).toBe(200)
  return data
}

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(libDir, 'manifest.json'), 'utf8'))
}

describe('管理员账号', () => {
  it('ensureAdminUser 建出 loveinshare (管理员)', async () => {
    const row = db.prepare('SELECT username, is_admin FROM users WHERE username = ?').get('loveinshare')
    expect(row).toBeTruthy()
    expect(Number(row.is_admin)).toBe(1)
  })

  it('重复调用不会重复建, 也不会把已有的降级', async () => {
    const r = await ensureAdminUser(db, { password: ADMIN_PW })
    expect(r.created).toBe(false)
    const count = db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('loveinshare')
    expect(Number(count.n)).toBe(1)
  })

  it('不给密码 → 每次随机生成一个 (没有公开的默认口令)', async () => {
    const a = await ensureAdminUser(db, { username: 'rand-admin-1' })
    const b = await ensureAdminUser(db, { username: 'rand-admin-2' })
    expect(a.created).toBe(true)
    expect(a.generatedPassword).toBeTruthy()
    expect(b.generatedPassword).toBeTruthy()
    expect(a.generatedPassword).not.toBe(b.generatedPassword)
  })

  it('用建号时的密码能登录, 且 /api/auth/me 说自己是管理员', async () => {
    const data = await login('loveinshare', ADMIN_PW)
    expect(data.user.isAdmin).toBe(true)

    const me = await json('/api/auth/me')
    expect(me.data.user).toMatchObject({ username: 'loveinshare', isAdmin: true })
  })
})

describe('公共乐库保存', () => {
  it('普通用户存到公共乐库 → 403', async () => {
    await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pianist', password: 'hunter2secret' }),
    })
    const { resp } = await json('/api/scores/public?filename=x.mid&title=X', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(resp.status).toBe(403)
  })

  it('管理员存新曲目 → 文件落盘 + manifest 加一条', async () => {
    await login('loveinshare', ADMIN_PW)
    const { resp, data } = await json(
      '/api/scores/public?filename=new.mid&title=新曲子&composer=Someone&key=C%20major&tracks=2&duration=120',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new TextEncoder().encode('NEW-BYTES'),
      },
    )
    expect(resp.status).toBe(201)
    expect(data.item.title).toBe('新曲子')
    // groupId 要一起给回去 —— 前端要知道存到哪个分组了 (展开那个分组)
    expect(data.item.groupId).toBe('admin')

    // 文件真的落在乐库里
    const rel = data.item.file
    expect(rel.startsWith('admin/')).toBe(true)
    expect(fs.existsSync(path.join(libDir, rel))).toBe(true)
    expect(fs.readFileSync(path.join(libDir, rel), 'utf8')).toBe('NEW-BYTES')

    // manifest 里有这一条了
    const m = readManifest()
    const items = m.groups.flatMap((g) => g.items)
    expect(items.some((it) => it.title === '新曲子')).toBe(true)
    expect(items.find((it) => it.title === '新曲子').tracks).toBe(2)
  })

  it('管理员存已有曲目 (带 itemId) → 原地替换, 不多出条目', async () => {
    await login('loveinshare', ADMIN_PW)
    const before = readManifest()
    const beforeCount = before.groups.flatMap((g) => g.items).length

    const { resp, data } = await json(
      '/api/scores/public?filename=demo.mid&itemId=demo&title=Demo%20%E6%94%B9%E8%BF%87&composer=Chopin&key=C%23%20minor&tracks=2',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new TextEncoder().encode('EDITED'),
      },
    )
    expect(resp.status).toBe(201)
    expect(data.item.id).toBe('demo')
    expect(data.item.title).toBe('Demo 改过')

    // 条目数没变 (没多出一份重复的)
    const after = readManifest()
    expect(after.groups.flatMap((g) => g.items).length).toBe(beforeCount)

    // 文件被覆盖了, 路径没变
    const item = after.groups.flatMap((g) => g.items).find((it) => it.id === 'demo')
    expect(item.file).toBe('chopin/demo.mid')
    expect(fs.readFileSync(path.join(libDir, 'chopin', 'demo.mid'), 'utf8')).toBe('EDITED')
  })

  it('乐库文件能从 /library/ 取到', async () => {
    const resp = await api('/library/chopin/demo.mid')
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('EDITED')
  })

  it('乐库目录穿越被挡住', async () => {
    // %2f 不是路径分隔符, 浏览器不会提前规范化 —— 服务端解出来就是越界路径
    const resp = await api('/library/..%2f..%2fsecret')
    expect(resp.status).toBe(403)
  })
})

describe('公共乐库删除 (仅管理员)', () => {
  // 造一条独立的条目 —— 不动上面那些用例共用的 'demo'
  function seedItem(id) {
    const m = readManifest()
    m.groups[0].items.push({
      id,
      title: `待删 ${id}`,
      subtitle: '',
      composer: 'Chopin',
      key: 'C# minor',
      difficulty: 4,
      tags: [],
      file: `chopin/${id}.mid`,
      tracks: 2,
    })
    fs.writeFileSync(path.join(libDir, 'manifest.json'), JSON.stringify(m, null, 2))
    fs.writeFileSync(path.join(libDir, 'chopin', `${id}.mid`), 'BYTES')
  }

  it('普通用户删公共乐谱 → 403', async () => {
    await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'deleter', password: 'hunter2secret' }),
    })
    await login('deleter', 'hunter2secret')
    seedItem('nope')
    const { resp } = await json('/api/scores/public/nope', { method: 'DELETE' })
    expect(resp.status).toBe(403)
    // 403 之后清单不能被动过
    const items = readManifest().groups.flatMap((g) => g.items)
    expect(items.some((it) => it.id === 'nope')).toBe(true)
  })

  it('没登录 → 401', async () => {
    cookie = ''
    const { resp } = await json('/api/scores/public/nope', { method: 'DELETE' })
    expect(resp.status).toBe(401)
  })

  it('管理员删公共乐谱 → 清单里没了 + 文件挪进 _archive/', async () => {
    await login('loveinshare', ADMIN_PW)
    seedItem('doomed')

    const { resp, data } = await json('/api/scores/public/doomed', { method: 'DELETE' })
    expect(resp.status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.item.id).toBe('doomed')
    expect(data.item.archived).toBe(true)

    // 清单里没有了
    const items = readManifest().groups.flatMap((g) => g.items)
    expect(items.some((it) => it.id === 'doomed')).toBe(false)

    // 文件挪进 _archive/ —— 原路径空了, 归档里有
    expect(fs.existsSync(path.join(libDir, 'chopin', 'doomed.mid'))).toBe(false)
    const archived = path.join(libDir, '_archive', 'chopin', 'doomed.mid')
    expect(fs.existsSync(archived)).toBe(true)
    expect(fs.readFileSync(archived, 'utf8')).toBe('BYTES')
  })

  it('删完的文件不再对外提供 (原路径 404, 归档路径也 404)', async () => {
    const gone = await api('/library/chopin/doomed.mid')
    expect(gone.status).toBe(404)
    const archived = await api('/library/_archive/chopin/doomed.mid')
    expect(archived.status).toBe(404)
  })

  it('删不存在的 id → 404', async () => {
    await login('loveinshare', ADMIN_PW)
    const { resp } = await json('/api/scores/public/no-such-id', { method: 'DELETE' })
    expect(resp.status).toBe(404)
  })

  it('id 编码坏了 → 400', async () => {
    await login('loveinshare', ADMIN_PW)
    // 单独的 '%' 不是合法的 percent-encoding —— decodeURIComponent 会抛
    const { resp } = await json('/api/scores/public/%', { method: 'DELETE' })
    expect(resp.status).toBe(400)
  })
})

describe('会话时长', () => {
  it('记住我 = 1 年', async () => {
    await login('loveinshare', ADMIN_PW, true)
    const token = cookie.split('=')[1]
    const s = sessionUser(db, token)
    const days = (s.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(360)
    expect(days).toBeLessThanOrEqual(365)
  })

  it('普通登录 = 30 天', async () => {
    await login('loveinshare', ADMIN_PW, false)
    const token = cookie.split('=')[1]
    const s = sessionUser(db, token)
    const days = (s.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(29)
    expect(days).toBeLessThanOrEqual(30)
  })

  it('快过期时自动顺延 (滑动续期)', async () => {
    await login('loveinshare', ADMIN_PW, true)
    const token = cookie.split('=')[1]
    // 把会话改成「只剩 1 天」
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
      Date.now() + 24 * 60 * 60 * 1000,
      crypto.createHash('sha256').update(token).digest('hex'),
    )
    const s = sessionUser(db, token)
    expect(s.renewed).toBe(true)
    const days = (s.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)
    expect(days).toBeGreaterThan(360)
  })

  it('普通登录不续期 (remember=0 就老老实实到期)', async () => {
    await login('loveinshare', ADMIN_PW, false)
    const token = cookie.split('=')[1]
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(
      Date.now() + 24 * 60 * 60 * 1000,
      crypto.createHash('sha256').update(token).digest('hex'),
    )
    const s = sessionUser(db, token)
    expect(s.renewed).toBe(false)
  })
})
