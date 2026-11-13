// 管理员删公共乐谱 —— UI + 请求 (用户需求: "给管理员账号 loveinshare 可以删除公共乐谱的能力和ui")
//
// 覆盖三件事:
//   1. 管理员看公共乐库 → 每条曲子旁边有垃圾桶
//   2. 普通用户看公共乐库 → 没有垃圾桶
//   3. 管理员点垃圾桶 → 打 DELETE /api/scores/public/<id>, 并刷新列表

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Library } from '../src/ui/Library'
import { useStore } from '../src/store'
import { useAuth } from '../src/auth'

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))

const MANIFEST = {
  version: 1,
  groups: [
    {
      id: 'chopin',
      name: 'Chopin',
      items: [
        {
          id: 'demo',
          title: '示例曲',
          subtitle: '',
          composer: 'Chopin',
          key: 'C# minor',
          difficulty: 4,
          tags: [],
          file: 'chopin/demo.mid',
          tracks: 2,
        },
      ],
    },
  ],
}

/** 假 fetch —— 只关心请求打到哪个 URL */
function mockFetch(handler: (url: string) => { ok?: boolean; status?: number; body?: string }) {
  const calls: string[] = []
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push(url)
    const r = handler(url)
    const body = r.body ?? ''
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', spy)
  return { calls, spy }
}

/** 找垃圾桶按钮 (aria-label 是「删除 <曲名>」) */
function trashButtons(host: HTMLElement) {
  return [...host.querySelectorAll('[aria-label^="删除 "]')] as HTMLElement[]
}

/**
 * 乐库的分组默认**收起** (2026-11-13 用户要求: chopin 不要默认打开),
 * 所以断言曲目之前得自己把分组点开.
 */
function expandGroup(host: HTMLElement, name: string) {
  const btn = [...host.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(name),
  )
  expect(btn, `找不到分组「${name}」`).toBeTruthy()
  ;(btn as HTMLButtonElement).click()
}

describe('管理员删公共乐谱', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  const realFetch = globalThis.fetch

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useStore.setState({ libraryVersion: 0, libraryFocusId: null, librarySource: null })
    vi.stubGlobal('confirm', () => true)
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    globalThis.fetch = realFetch
    useAuth.setState({ user: null, checked: false })
  })

  it('管理员看公共乐库 → 有垃圾桶', async () => {
    useAuth.setState({
      user: { id: 1, username: 'loveinshare', isAdmin: true },
      checked: true,
    })
    mockFetch((url) => {
      if (url.includes('/library/manifest.json')) return { body: JSON.stringify(MANIFEST) }
      return { body: '{}' }
    })

    root.render(React.createElement(Library, { scope: 'public' }))
    await wait(100)
    expandGroup(host, 'Chopin')
    await wait(50)

    expect(host.textContent).toContain('示例曲')
    expect(trashButtons(host).length).toBe(1)
  })

  it('普通用户看公共乐库 → 没有垃圾桶', async () => {
    useAuth.setState({
      user: { id: 2, username: 'pianist', isAdmin: false },
      checked: true,
    })
    mockFetch((url) => {
      if (url.includes('/library/manifest.json')) return { body: JSON.stringify(MANIFEST) }
      return { body: '{}' }
    })

    root.render(React.createElement(Library, { scope: 'public' }))
    await wait(100)
    expandGroup(host, 'Chopin')
    await wait(50)

    expect(host.textContent).toContain('示例曲')
    expect(trashButtons(host).length).toBe(0)
  })

  it('没登录看公共乐库 → 没有垃圾桶', async () => {
    useAuth.setState({ user: null, checked: true })
    mockFetch((url) => {
      if (url.includes('/library/manifest.json')) return { body: JSON.stringify(MANIFEST) }
      return { body: '{}' }
    })

    root.render(React.createElement(Library, { scope: 'public' }))
    await wait(100)

    expect(trashButtons(host).length).toBe(0)
  })

  it('管理员点垃圾桶 → 打 DELETE 接口, 列表跟着刷新', async () => {
    useAuth.setState({
      user: { id: 1, username: 'loveinshare', isAdmin: true },
      checked: true,
    })
    const { calls } = mockFetch((url) => {
      if (url.includes('/library/manifest.json')) return { body: JSON.stringify(MANIFEST) }
      if (url.startsWith('/api/scores/public/')) {
        return {
          body: JSON.stringify({
            ok: true,
            item: { id: 'demo', title: '示例曲', file: 'chopin/demo.mid', archived: true },
          }),
        }
      }
      return { body: '{}' }
    })

    root.render(React.createElement(Library, { scope: 'public' }))
    await wait(100)
    expandGroup(host, 'Chopin')
    await wait(50)

    const before = calls.filter((u) => u.includes('/library/manifest.json')).length
    const trash = trashButtons(host)[0]
    expect(trash).toBeTruthy()
    trash.click()
    await wait(120)

    // 请求打对了
    expect(calls.some((u) => u === '/api/scores/public/demo')).toBe(true)

    // 列表重新拉了一次 (libraryVersion 自增 → 面板重拉 manifest)
    expect(useStore.getState().libraryVersion).toBe(1)
    expect(calls.filter((u) => u.includes('/library/manifest.json')).length).toBe(before + 1)
  })

  it('服务端报错 → 面板上显示错误, 不刷新列表', async () => {
    useAuth.setState({
      user: { id: 1, username: 'loveinshare', isAdmin: true },
      checked: true,
    })
    mockFetch((url) => {
      if (url.includes('/library/manifest.json')) return { body: JSON.stringify(MANIFEST) }
      if (url.startsWith('/api/scores/public/')) {
        return { ok: false, status: 403, body: JSON.stringify({ error: '只有管理员能删除公共乐谱' }) }
      }
      return { body: '{}' }
    })

    root.render(React.createElement(Library, { scope: 'public' }))
    await wait(100)
    expandGroup(host, 'Chopin')
    await wait(50)

    trashButtons(host)[0].click()
    await wait(120)

    expect(host.textContent).toContain('只有管理员能删除公共乐谱')
    expect(useStore.getState().libraryVersion).toBe(0)
  })
})
