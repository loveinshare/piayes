// 存到乐库 —— 存完乐库面板要刷新 (用户反馈: "存了没反应, 刷新了也看不见")
//
// 覆盖三件事:
//   1. 管理员点「存公共」→ 打 POST /api/scores/public, 并把出处记成刚存的那条
//   2. 存完 store 的 libraryVersion 自增 → 乐库面板重新拉列表
//   3. 乐库面板看到 libraryVersion 变了 → 重新拉 manifest (不再吃 60s 缓存)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ScoreEditor } from '../src/ui/ScoreEditor'
import { Library } from '../src/ui/Library'
import { useStore } from '../src/store'
import { useAuth } from '../src/auth'
import type { Song, SongNote } from '../src/types'

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))

function makeSong(over: Partial<Song> = {}): Song {
  return {
    notes: [],
    measures: [
      { number: 1, time: 0, duration: 2 },
      { number: 2, time: 2, duration: 2 },
    ],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 4,
    ppq: 480,
    hands: { left: 1, right: 0 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
    title: '测试曲',
    composer: '某人',
    ...over,
  }
}

const NOTES: SongNote[] = [
  { midiNote: 60, time: 0, duration: 0.5, track: 0, hand: 'right', velocity: 0.8 },
  { midiNote: 48, time: 0, duration: 2, track: 1, hand: 'left', velocity: 0.7 },
]

function fakeSynth() {
  return {
    noteOn: () => {},
    noteOff: () => {},
    start: () => {},
    stop: () => {},
    dispose: () => {},
    triggerAttack: () => {},
    triggerRelease: () => {},
  }
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

describe('存到乐库 · 存完要刷新列表', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  const realFetch = globalThis.fetch

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useStore.setState({ libraryVersion: 0, libraryFocusId: null, librarySource: null })
    useAuth.setState({
      user: { id: 1, username: 'loveinshare', isAdmin: true },
      checked: true,
    })
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    globalThis.fetch = realFetch
    useAuth.setState({ user: null, checked: false })
  })

  it('管理员点「存公共」→ 打公共乐库接口, 并记下刚存的那条', async () => {
    const { calls } = mockFetch((url) => {
      if (url.startsWith('/api/scores/public')) {
        return {
          status: 201,
          body: JSON.stringify({
            item: {
              id: 'admin-xyz',
              title: '测试曲',
              subtitle: '',
              composer: '某人',
              key: 'C major',
              difficulty: 3,
              tags: [],
              file: 'admin/test.mid',
              tracks: 2,
              groupId: 'admin',
            },
          }),
        }
      }
      return { body: '{}' }
    })

    root.render(
      React.createElement(ScoreEditor, {
        open: true,
        song: makeSong({ notes: NOTES }),
        synth: fakeSynth() as never,
        onClose: () => {},
        onApply: () => {},
      }),
    )
    await wait(80)

    const btn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('存公共'),
    )
    expect(btn).toBeTruthy()
    ;(btn as HTMLButtonElement).click()
    await wait(120)

    // 1. 请求确实打到公共乐库接口了
    expect(calls.some((u) => u.startsWith('/api/scores/public'))).toBe(true)

    // 2. 出处换成刚存的那条 —— 再存一次是覆盖它, 不是又多一条
    const src = useStore.getState().librarySource
    expect(src?.id).toBe('admin-xyz')
    expect(src?.scope).toBe('public')
    expect(src?.groupId).toBe('admin')

    // 3. 乐库刷新计数自增 → 乐库面板会重新拉列表
    expect(useStore.getState().libraryVersion).toBe(1)
    expect(useStore.getState().libraryFocusId).toBe('admin-xyz')
  })

  it('乐库面板看到 libraryVersion 变了 → 重新拉 manifest (不吃缓存)', async () => {
    const manifest = {
      version: 1,
      groups: [
        { id: 'chopin', name: 'Chopin', items: [] },
        {
          id: 'admin',
          name: '管理员上传',
          items: [
            {
              id: 'admin-xyz',
              title: '测试曲',
              subtitle: '',
              composer: '某人',
              key: 'C major',
              difficulty: 3,
              tags: [],
              file: 'admin/test.mid',
              tracks: 2,
            },
          ],
        },
      ],
    }
    const { calls } = mockFetch((url) => {
      if (url.includes('/library/manifest.json')) {
        return { body: JSON.stringify(manifest) }
      }
      return { body: '{}' }
    })

    root.render(React.createElement(Library, { scope: 'public' }))
    await wait(80)
    expect(calls.filter((u) => u.includes('/library/manifest.json')).length).toBe(1)

    // 存完 → 计数变了 → 面板重新拉
    useStore.getState().bumpLibrary('admin-xyz')
    await wait(120)
    expect(calls.filter((u) => u.includes('/library/manifest.json')).length).toBe(2)

    // 刚存的那条所在的分组要自动展开 —— 不展开等于没存 (它在最后一个折叠分组里)
    const adminGroup = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('管理员上传'),
    )
    expect(adminGroup).toBeTruthy()
    expect(host.textContent).toContain('测试曲')
  })
})
