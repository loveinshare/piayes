// 曲目的「出处」必须被记住 —— 编辑器里「存到公共乐库」靠它决定
// 覆盖原来那一条还是新建一条.
//
// ★ 回归测试 (用户 2026-11-04 报的「保存到公共乐谱一直没有实现」):
//   以前只有乐库面板那两条路记出处, 启动时自动恢复上次弹的曲子 /
//   「最近」banner 加载曲子都没记 → 服务端收不到 itemId → 多存一条,
//   原来那条纹丝不动 → 「退出来刷新又是老的了」.
//
//   现在「从乐库加载曲子」统一走 loadLibrarySong() —— 它顺手记出处.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { useAuth } from '../src/auth'
import { ScoreEditor } from '../src/ui/ScoreEditor'
import type { Song } from '../src/types'

// parser 打桩 —— 这里只关心「出处有没有被记住」, 不想真去解析 MIDI
vi.mock('../src/parser', () => ({
  parseUrl: vi.fn(async () => ({ notes: [], title: 'x', composer: 'y' })),
}))

const MANIFEST = {
  version: 1,
  groups: [
    {
      id: 'chopin',
      name: 'Chopin',
      items: [
        {
          id: 'prelude-bwv846',
          title: 'Prelude No.1 in C major',
          subtitle: '',
          composer: 'Bach',
          key: 'C major',
          difficulty: 3,
          tags: [],
          file: 'bach/prelude-bwv846.mid',
          tracks: 2,
        },
      ],
    },
  ],
}

async function loadLibrarySong() {
  const { loadLibrarySong } = await import('../src/library')
  return loadLibrarySong
}

describe('loadLibrarySong — 加载乐库曲子要记住出处', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    useStore.setState({ song: null, librarySource: null })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const body = url.includes('manifest.json') ? JSON.stringify(MANIFEST) : '{}'
        return {
          ok: true,
          status: 200,
          text: async () => body,
          json: async () => JSON.parse(body),
        } as unknown as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.fetch = realFetch
  })

  it('给了 groupId → 出处记成 public + 该分组', async () => {
    const load = await loadLibrarySong()
    await load(
      {
        id: 'prelude-bwv846',
        title: 'Prelude No.1 in C major',
        subtitle: '',
        composer: 'Bach',
        key: 'C major',
        difficulty: 3,
        tags: [],
        file: 'bach/prelude-bwv846.mid',
        tracks: 2,
      },
      'chopin',
    )
    const src = useStore.getState().librarySource
    expect(src).toMatchObject({
      id: 'prelude-bwv846',
      groupId: 'chopin',
      scope: 'public',
      file: 'bach/prelude-bwv846.mid',
    })
    expect(useStore.getState().song).toBeTruthy()
  })

  it('没给 groupId → 从 manifest 里查出来', async () => {
    const load = await loadLibrarySong()
    await load({
      id: 'prelude-bwv846',
      title: 'Prelude No.1 in C major',
      subtitle: '',
      composer: 'Bach',
      key: 'C major',
      difficulty: 3,
      tags: [],
      file: 'bach/prelude-bwv846.mid',
      tracks: 2,
    })
    expect(useStore.getState().librarySource?.groupId).toBe('chopin')
  })

  it('私有谱子 → scope = mine (不能拿去覆盖公共乐库)', async () => {
    const load = await loadLibrarySong()
    await load(
      {
        id: 'u-7',
        title: '我自己的谱子',
        subtitle: '',
        composer: '我',
        key: 'C major',
        difficulty: 3,
        tags: [],
        file: '/api/scores/7/file',
        tracks: 2,
        scope: 'mine',
        scoreId: 7,
      },
      'mine',
    )
    expect(useStore.getState().librarySource).toMatchObject({ scope: 'mine', scoreId: 7 })
  })
})

// ---------------------------------------------------------------------------
// 端到端一点: 编辑器点「存公共」时, 请求里到底带不带 itemId
//
// ★ 这就是用户报的「保存到公共乐谱一直没有实现」的最后一环:
//   没带 itemId → 服务端新建一条 → 原来那条没被覆盖 → 刷新还是老的.
// ---------------------------------------------------------------------------

describe('编辑器「存公共」→ 请求要带 itemId (覆盖原来那一条)', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  const calls: string[] = []
  const realFetch = globalThis.fetch

  function makeSong(): Song {
    return {
      notes: [],
      measures: [{ number: 1, time: 0, duration: 2 }],
      bpms: [{ time: 0, bpm: 120 }],
      duration: 2,
      ppq: 480,
      hands: { left: 1, right: 0 },
      timeSignature: { numerator: 4, denominator: 4 },
      source: 'midi',
      title: 'Prelude No.1 in C major',
      composer: 'Bach',
    }
  }

  function fakeSynth() {
    return {
      noteOn: () => {},
      noteOff: () => {},
      start: () => {},
      stop: () => {},
      dispose: () => {},
      triggerAttack: () => {},
      triggerRelease: () => {},
    } as never
  }

  beforeEach(() => {
    calls.length = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useAuth.setState({ user: { id: 1, username: 'loveinshare', isAdmin: true }, checked: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)
        const body = url.startsWith('/api/scores/public')
          ? JSON.stringify({
              item: {
                id: 'prelude-bwv846',
                title: 'Prelude No.1 in C major',
                subtitle: '',
                composer: 'Bach',
                key: 'C major',
                difficulty: 3,
                tags: [],
                file: 'bach/prelude-bwv846.mid',
                tracks: 2,
                groupId: 'bach',
              },
            })
          : '{}'
        return {
          ok: true,
          status: 201,
          text: async () => body,
          json: async () => JSON.parse(body),
        } as unknown as Response
      }),
    )
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    globalThis.fetch = realFetch
    useAuth.setState({ user: null, checked: false })
    useStore.setState({ librarySource: null })
  })

  async function clickSavePublic() {
    root.render(
      React.createElement(ScoreEditor, {
        open: true,
        song: makeSong(),
        synth: fakeSynth(),
        onClose: () => {},
        onApply: () => {},
      }),
    )
    await new Promise((r) => setTimeout(r, 120))
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('存公共'))
    expect(btn).toBeTruthy()
    ;(btn as HTMLButtonElement).click()
    await new Promise((r) => setTimeout(r, 150))
    return calls.find((u) => u.startsWith('/api/scores/public')) ?? ''
  }

  it('曲子来自公共乐库 → 请求带 itemId (服务端会原地覆盖)', async () => {
    useStore.setState({
      librarySource: {
        id: 'prelude-bwv846',
        groupId: 'bach',
        scope: 'public',
        file: 'bach/prelude-bwv846.mid',
        title: 'Prelude No.1 in C major',
      },
    })
    const url = await clickSavePublic()
    expect(url).toContain('itemId=prelude-bwv846')
    expect(url).toContain('groupId=bach')
  })

  it('曲子不是来自公共乐库 (本地文件) → 不带 itemId (服务端新建一条)', async () => {
    useStore.setState({ librarySource: null })
    const url = await clickSavePublic()
    expect(url).not.toContain('itemId=')
  })
})
