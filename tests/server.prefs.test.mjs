// 账号那份前端配置 —— GET/PUT /api/prefs
//
// 前端的配置存两处: localStorage (本地那份) + 服务器 user_prefs 表 (账号那份).
// 这里测的是服务器这一侧: 存/取/覆盖/隔离/要登录.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { openDb } from '../scripts/server/db.mjs'
import { createHandler } from '../scripts/server/handler.mjs'

let server
let base
let dir
let db
/** node fetch 没有 cookie jar —— 手动带 */
let cookie = ''

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-prefs-'))
  db = openDb(dir)
  const handler = createHandler({ db, dataDir: dir, root: dir })
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

async function register(username) {
  const r = await json('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'hunter2secret' }),
  })
  expect(r.resp.status).toBe(201)
  return r
}

describe('账号那份前端配置', () => {
  it('没登录 → 存/取都 401', async () => {
    const save = await json('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: { ledHost: '1.2.3.4' } }),
    })
    expect(save.resp.status).toBe(401)

    const read = await json('/api/prefs')
    expect(read.resp.status).toBe(401)
  })

  it('注册后存进去 → 原样取回来 (树莓派 IP 这种)', async () => {
    await register('prefsuser')
    const prefs = {
      ledHost: '192.168.1.113',
      ledToken: 'tok-123',
      ledBackend: 'ws',
      ledBrightness: 0.42,
      hand: 'right',
    }
    const save = await json('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs }),
    })
    expect(save.resp.status).toBe(200)

    const read = await json('/api/prefs')
    expect(read.resp.status).toBe(200)
    expect(read.data.prefs).toEqual(prefs)
  })

  it('再存一次 → 覆盖 (不是叠加)', async () => {
    await json('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: { ledHost: '10.0.0.1', ledBrightness: 0.9 } }),
    })
    const read = await json('/api/prefs')
    expect(read.data.prefs).toEqual({ ledHost: '10.0.0.1', ledBrightness: 0.9 })
  })

  it('prefs 不是对象 → 400', async () => {
    const bad = await json('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: '不是对象' }),
    })
    expect(bad.resp.status).toBe(400)

    const arr = await json('/api/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: [1, 2, 3] }),
    })
    expect(arr.resp.status).toBe(400)
  })

  it('换个账号 → 看不见别人的配置', async () => {
    const before = await json('/api/prefs')
    expect(before.data.prefs.ledHost).toBe('10.0.0.1')

    cookie = ''
    await register('otheruser')
    const read = await json('/api/prefs')
    expect(read.resp.status).toBe(200)
    expect(read.data.prefs).toEqual({})
  })

  it('登出之后 → 又取不到了', async () => {
    await api('/api/auth/logout', { method: 'POST' })
    const read = await json('/api/prefs')
    expect(read.resp.status).toBe(401)
  })
})
