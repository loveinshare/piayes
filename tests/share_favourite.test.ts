// 分享链接 + 收藏夹 —— 纯逻辑 (不打服务端).
//
// 分享链接: `?song=<乐库条目 id>&scope=public|mine`
// 收藏夹: 存在 prefs 里 (localStorage + 账号那份 user_prefs), 跟着账号走.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildShareUrl, parseShareLink } from '../src/share'
import { useStore, type Favourite } from '../src/store'
import { findLibraryItemById, invalidateManifest } from '../src/library'

const PREFS_KEY = 'piayes.prefs.v1'

describe('分享链接', () => {
  it('生成的链接带着 song / scope 两个参数', () => {
    const url = buildShareUrl({ id: 'godowsky-waltz-csharp-minor', scope: 'public' })
    expect(url).toContain('song=godowsky-waltz-csharp-minor')
    expect(url).toContain('scope=public')
    expect(url.startsWith(window.location.origin)).toBe(true)
  })

  it('私有谱子带 scope=mine', () => {
    const url = buildShareUrl({ id: 'u-12', scope: 'mine' })
    expect(url).toContain('song=u-12')
    expect(url).toContain('scope=mine')
  })

  it('解析: 有 song 参数才认是分享链接', () => {
    expect(parseShareLink('?song=abc&scope=mine')).toEqual({ id: 'abc', scope: 'mine' })
    expect(parseShareLink('?song=abc')).toEqual({ id: 'abc', scope: 'public' })
    expect(parseShareLink('?autoload=0')).toBeNull()
    expect(parseShareLink('')).toBeNull()
  })
})

describe('收藏夹', () => {
  const fav = (over: Partial<Favourite> = {}): Favourite => ({
    scope: 'public',
    id: 'nocturne-eb-major-aigei',
    groupId: 'chopin',
    title: 'Nocturne in E♭ Major',
    composer: 'Chopin',
    at: 1,
    ...over,
  })

  beforeEach(() => {
    localStorage.clear()
    useStore.setState({ favorites: [] })
  })

  it('收藏 → 进收藏夹; 再点一次 → 取消', () => {
    const { toggleFavorite } = useStore.getState()
    toggleFavorite(fav())
    expect(useStore.getState().favorites).toHaveLength(1)
    toggleFavorite(fav())
    expect(useStore.getState().favorites).toHaveLength(0)
  })

  it('收藏两条 → 新的排在最前面', () => {
    const { toggleFavorite } = useStore.getState()
    toggleFavorite(fav())
    toggleFavorite(fav({ id: 'fantaisie-impromptu', title: 'Fantaisie-Impromptu' }))
    const list = useStore.getState().favorites
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('fantaisie-impromptu')
  })

  it('公共乐库和私有谱子是两条不同的收藏 (scope 不同)', () => {
    const { toggleFavorite } = useStore.getState()
    toggleFavorite(fav())
    toggleFavorite(fav({ scope: 'mine', id: 'u-3', groupId: 'mine', scoreId: 3 }))
    expect(useStore.getState().favorites).toHaveLength(2)
  })

  it('收藏写进 localStorage 的那份 prefs (换台设备登录同账号也跟着走)', () => {
    useStore.getState().toggleFavorite(fav())
    const raw = localStorage.getItem(PREFS_KEY)
    expect(raw).toBeTruthy()
    const saved = JSON.parse(raw as string) as { favorites?: Favourite[] }
    expect(saved.favorites).toHaveLength(1)
    expect(saved.favorites?.[0].id).toBe('nocturne-eb-major-aigei')
  })
})

describe('分享链接 · 按 id 找回乐库里那条', () => {
  const realFetch = globalThis.fetch

  const MANIFEST = {
    version: 1,
    groups: [
      {
        id: 'chopin',
        name: 'Chopin',
        items: [
          {
            id: 'fantaisie-impromptu',
            title: 'Fantaisie-Impromptu in C# minor',
            subtitle: '',
            composer: 'Chopin',
            key: 'C# minor',
            difficulty: 4,
            tags: [],
            file: 'chopin/fantaisie-impromptu.mid',
            tracks: 2,
          },
        ],
      },
    ],
  }

  beforeEach(() => {
    invalidateManifest()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/library/manifest.json')) {
          return new Response(JSON.stringify(MANIFEST), { status: 200 })
        }
        if (url.startsWith('/api/scores')) {
          return new Response(
            JSON.stringify({
              scores: [
                {
                  id: 12,
                  title: '我的曲子',
                  subtitle: '',
                  composer: '我',
                  key: 'C major',
                  duration: 10,
                  difficulty: 3,
                  tracks: '2',
                  tags: [],
                  filename: 'mine.mid',
                  size: 100,
                  createdAt: 1,
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response('{}', { status: 404 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    globalThis.fetch = realFetch
    invalidateManifest()
  })

  it('公共乐库那条 → 找得到, 而且带上分组 id', async () => {
    const item = await findLibraryItemById('public', 'fantaisie-impromptu')
    expect(item).toBeTruthy()
    expect(item?.title).toBe('Fantaisie-Impromptu in C# minor')
    expect(item?.groupId).toBe('chopin')
  })

  it('公共乐库里没有这一条 → null', async () => {
    expect(await findLibraryItemById('public', 'nope')).toBeNull()
  })

  it('私有谱子 → 走 /api/scores 找 (id 形如 u-<scoreId>)', async () => {
    const item = await findLibraryItemById('mine', 'u-12')
    expect(item?.title).toBe('我的曲子')
    expect(item?.scoreId).toBe(12)
    expect(item?.file).toBe('/api/scores/12/file')
  })
})
