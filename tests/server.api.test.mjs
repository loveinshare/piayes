// API 端到端测试 —— 真起一个 HTTP server, 用 fetch 打一遍
// 注册 / 登录 / 上传 / 列表 / 下载 / 删除.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { openDb } from '../scripts/server/db.mjs'
import { createHandler } from '../scripts/server/handler.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '..', 'dist')

let server
let base
let dir
let db
/** 手动带 cookie (node fetch 没有 cookie jar) */
let cookie = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-api-'))
  db = openDb(dir)
  const handler = createHandler({ db, dataDir: dir, root: DIST })
  server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server?.close()
  db?.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function api(path, opts = {}) {
  const headers = { ...(opts.headers ?? {}) }
  if (cookie) headers.Cookie = cookie
  const resp = await fetch(base + path, { ...opts, headers })
  const setCookie = resp.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  return resp
}

async function json(path, opts) {
  const resp = await api(path, opts)
  const text = await resp.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  return { resp, data }
}

const MIDI_BYTES = new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06])

describe('注册 / 登录', () => {
  it('注册成功并直接登录', async () => {
    const { resp, data } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret' }),
    })
    expect(resp.status).toBe(201)
    expect(data.user.username).toBe('violin')

    const me = await json('/api/auth/me')
    expect(me.resp.status).toBe(200)
    expect(me.data.user.username).toBe('violin')
  })

  it('用户名重复 (大小写不同) 被拒', async () => {
    const { resp } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'VIOLIN', password: 'hunter2secret' }),
    })
    expect(resp.status).toBe(409)
  })

  it('密码太短被拒', async () => {
    const { resp } = await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'shorty', password: '123' }),
    })
    expect(resp.status).toBe(400)
  })

  it('密码不对登录失败', async () => {
    const { resp } = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'wrong-one' }),
    })
    expect(resp.status).toBe(401)
  })

  it('登出后 me 返回 401', async () => {
    const login = await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret', remember: true }),
    })
    expect(login.resp.status).toBe(200)

    const out = await api('/api/auth/logout', { method: 'POST' })
    expect(out.status).toBe(204)

    const me = await json('/api/auth/me')
    expect(me.resp.status).toBe(401)
  })

  // 公网链路是 nginx → frps → frpc → 本机明文端口, frps 会把
  // X-Forwarded-Proto 覆写成 "http", 所以协议靠 X-Original-Proto 传.
  it('https 链路下发的 cookie 带 Secure', async () => {
    const resp = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Original-Proto': 'https' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret', remember: true }),
    })
    expect(resp.headers.get('set-cookie')).toContain('Secure')
    cookie = '' // 别把登录态留给后面的用例
  })

  it('明文链路下发的 cookie 不带 Secure', async () => {
    const resp = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret', remember: true }),
    })
    expect(resp.headers.get('set-cookie')).not.toContain('Secure')
    cookie = '' // 别把登录态留给后面的用例
  })
})

describe('私有谱子', () => {
  it('没登录不能上传/列自己的谱子', async () => {
    const list = await json('/api/scores')
    expect(list.resp.status).toBe(401)

    const up = await api('/api/scores?filename=x.mid', {
      method: 'POST',
      body: MIDI_BYTES,
    })
    expect(up.status).toBe(401)
  })

  it('上传 → 列表 → 下载 → 删除 走通', async () => {
    // 登录
    await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret' }),
    })

    // 上传
    const up = await json(
      '/api/scores?filename=moonlight.mid&title=Moonlight&composer=Beethoven&tracks=2&duration=180',
      { method: 'POST', body: MIDI_BYTES },
    )
    expect(up.resp.status).toBe(201)
    expect(up.data.score.title).toBe('Moonlight')
    expect(up.data.score.tracks).toBe('2')
    const id = up.data.score.id

    // 列表
    const list = await json('/api/scores')
    expect(list.resp.status).toBe(200)
    expect(list.data.scores).toHaveLength(1)
    expect(list.data.scores[0].id).toBe(id)

    // 下载 —— 字节要一致
    const dl = await api(`/api/scores/${id}/file`)
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('audio/midi')
    const got = new Uint8Array(await dl.arrayBuffer())
    expect(Array.from(got)).toEqual(Array.from(MIDI_BYTES))

    // 删除
    const del = await api(`/api/scores/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)

    const list2 = await json('/api/scores')
    expect(list2.data.scores).toHaveLength(0)
  })

  it('不接受的扩展名被拒', async () => {
    await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret' }),
    })
    const up = await json('/api/scores?filename=evil.exe', { method: 'POST', body: MIDI_BYTES })
    expect(up.resp.status).toBe(400)
  })

  it('文件名里的路径被吃掉, 不会写到目录外', async () => {
    await json('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'violin', password: 'hunter2secret' }),
    })
    const up = await json('/api/scores?filename=../../etc/passwd.mid', {
      method: 'POST',
      body: MIDI_BYTES,
    })
    expect(up.resp.status).toBe(201)
    expect(up.data.score.filename).toBe('passwd.mid')

    const files = fs.readdirSync(path.join(dir, 'uploads'))
    expect(files.length).toBe(1)
  })

  it('别人的谱子拿不到', async () => {
    // 另一个账号
    await json('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'otherguy', password: 'hunter2secret' }),
    })
    const list = await json('/api/scores')
    // 另一个用户看不到上一个人的谱子
    expect(list.data.scores.every((s) => s.filename !== 'passwd.mid')).toBe(true)
  })
})

describe('静态资源', () => {
  // dist/ 是构建产物 —— 干净克隆 (CI 的 npm test 之前) 还没 build, 这条就跳过
  const hasDist = fs.existsSync(path.join(DIST, 'index.html'))

  it.skipIf(!hasDist)('未知路径回退到 index.html', async () => {
    const resp = await api('/some/deep/route')
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toContain('text/html')
  })
})
