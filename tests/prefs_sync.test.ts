// 前端配置绑定账号 —— 本地一份 (localStorage) + 账号一份 (服务器).
//
// 规矩 (用户 2026-11-08):
// - 没登录 → 只存本地, 不发任何请求
// - 登录了 → 改配置时两边都改 (本地立刻写, 推给服务器)
// - 登录那一刻 → 把账号那份拉下来, 账号那份优先, 再落回 UI 状态

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const LS_KEY = 'piayes.prefs.v1'

/** 假的 fetch —— 只认 '/api/prefs' 这一个接口. */
function fakeFetch(serverPrefs: Record<string, unknown> = {}) {
  const calls: { url: string; method: string; body: unknown }[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const json = async () => (method === 'GET' ? { prefs: serverPrefs } : { ok: true })
    return { ok: true, status: 200, json } as unknown as Response
  })
  return { fn, calls }
}

/** 等到条件成立 (推/拉都是异步的). */
async function until(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('等超时了')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function saved(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
}

describe('配置绑定账号', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  afterEach(async () => {
    // 等 store 里那个 debounce 的推送定时器跑完 —— 不然它会在下一个用例里
    // 冒出来 (带着上一个用例的 prefs), 把用例之间的记录搅乱.
    await new Promise((r) => setTimeout(r, 500))
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('没登录 → 只写本地, 一个请求都不发', async () => {
    const { fn } = fakeFetch()
    vi.stubGlobal('fetch', fn)
    const { savePrefs } = await import('../src/store')

    savePrefs({ ledHost: '10.0.0.5' })

    expect(saved().ledHost).toBe('10.0.0.5')
    expect(fn).not.toHaveBeenCalled()
  })

  it('登录了 → 改配置时推给服务器 (本地那份也在)', async () => {
    const { fn, calls } = fakeFetch()
    vi.stubGlobal('fetch', fn)
    const { useAuth } = await import('../src/auth')
    const { savePrefs } = await import('../src/store')

    useAuth.setState({ user: { id: 1, username: 'u', isAdmin: false }, checked: true })
    // 登录 → 先拉一次账号那份
    await until(() => calls.some((c) => c.method === 'GET'))

    savePrefs({ ledHost: '10.0.0.5' })

    await until(() => calls.some((c) => c.method === 'PUT'))
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.url).toBe('/api/prefs')
    expect((put.body as { prefs: Record<string, unknown> }).prefs.ledHost).toBe('10.0.0.5')
    // 本地那份也改了
    expect(saved().ledHost).toBe('10.0.0.5')
  })

  it('登录那一刻 → 账号那份拉下来, 落进 UI 状态 + 本地', async () => {
    const { fn } = fakeFetch({ ledHost: '192.168.9.9', ledBrightness: 0.9, hand: 'right' })
    vi.stubGlobal('fetch', fn)
    const { useAuth } = await import('../src/auth')
    const { useStore } = await import('../src/store')

    useAuth.setState({ user: { id: 1, username: 'u', isAdmin: false }, checked: true })

    await until(() => useStore.getState().ledHost === '192.168.9.9')
    expect(useStore.getState().ledBrightness).toBe(0.9)
    expect(useStore.getState().hand).toBe('right')
    // 本地也留了一份
    expect(saved().ledHost).toBe('192.168.9.9')
  })

  it('账号那份优先于本地 (两台机器登录同一个号 → 用账号那套)', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ledHost: '1.1.1.1' }))
    const { fn } = fakeFetch({ ledHost: '2.2.2.2' })
    vi.stubGlobal('fetch', fn)
    const { useAuth } = await import('../src/auth')
    const { useStore } = await import('../src/store')

    useAuth.setState({ user: { id: 1, username: 'u', isAdmin: false }, checked: true })

    await until(() => useStore.getState().ledHost === '2.2.2.2')
    // 本地有、账号没有的字段保留
    expect(saved().ledHost).toBe('2.2.2.2')
  })

  it('账号那份拉下来后 → 合并结果推回服务器 (账号那份 = 两边并集)', async () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ ledHost: '1.1.1.1', ledToken: 'local-token' }))
    const { fn, calls } = fakeFetch({ ledHost: '2.2.2.2' })
    vi.stubGlobal('fetch', fn)
    const { useAuth } = await import('../src/auth')
    await import('../src/store') // 订阅登录状态 —— store 模块加载时挂上

    useAuth.setState({ user: { id: 1, username: 'u', isAdmin: false }, checked: true })

    await until(() => calls.some((c) => c.method === 'PUT'))
    const put = calls.find((c) => c.method === 'PUT')!
    const prefs = (put.body as { prefs: Record<string, unknown> }).prefs
    expect(prefs.ledHost).toBe('2.2.2.2')
    expect(prefs.ledToken).toBe('local-token')
  })

  it('老 key (piano-follow.prefs.v1) 也认 —— 改名不能弄丢老用户的配置', async () => {
    localStorage.setItem('piano-follow.prefs.v1', JSON.stringify({ ledHost: '9.9.9.9' }))
    const { fn } = fakeFetch()
    vi.stubGlobal('fetch', fn)
    const { useStore } = await import('../src/store')

    expect(useStore.getState().ledHost).toBe('9.9.9.9')
  })

  it('登出之后 → 只写本地, 不再推', async () => {
    const { fn, calls } = fakeFetch()
    vi.stubGlobal('fetch', fn)
    const { useAuth } = await import('../src/auth')
    const { savePrefs } = await import('../src/store')

    useAuth.setState({ user: { id: 1, username: 'u', isAdmin: false }, checked: true })
    // 登录 → 拉一次 + 把合并结果推回去
    await until(() => calls.some((c) => c.method === 'PUT'))
    const before = calls.length

    useAuth.setState({ user: null, checked: true })
    savePrefs({ ledHost: '3.3.3.3' })

    expect(saved().ledHost).toBe('3.3.3.3')
    // 登出后不该有新的请求
    await new Promise((r) => setTimeout(r, 600))
    expect(calls.length).toBe(before)
  })
})
