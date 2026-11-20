// 乐库清单类型 + 加载器

import type { Song } from './types'
import { parseUrl } from './parser'
import { useStore } from './store'

export interface LibraryItem {
  id: string
  title: string
  subtitle: string
  composer: string
  key: string
  duration?: number
  difficulty: number
  tags: string[]
  file: string
  /**
   * 通道数: 1 = 单 track (声部聚类推断, 可能有错), 2 = 双 track (按音高分配, 准),
   * 'multi' = ≥3 track (按音符数分左右手, 大致), 'mxl' = MusicXML (按 part/clef, 最准)
   */
  tracks: 1 | 2 | 'multi' | 'mxl'
  /**
   * 谱子归属: 'public' = 公共乐库 (manifest.json, 所有人可见只读),
   * 'mine' = 当前用户自己上传的私有谱子 (走 /api/scores).
   */
  scope?: 'public' | 'mine'
  /** scope='mine' 时的服务端记录 id (删除用) */
  scoreId?: number
  /** 公共乐库里这条在哪个分组 (manifest 的 group.id) */
  groupId?: string
}

export interface LibraryGroup {
  id: string
  name: string
  items: LibraryItem[]
}

export interface LibraryManifest {
  version: number
  groups: LibraryGroup[]
}

let cached: LibraryManifest | null = null
let cachedAt = 0

/**
 * 清单缓存 TTL (ms) —— spec P2-5.
 * 以前缓存**永不失效**: 改了 public/library/manifest.json 必须硬刷新 (Ctrl+F5)
 * 才看得到, 很容易让人以为"改了没生效".
 */
const MANIFEST_TTL_MS = 60_000

export async function loadManifest(force = false): Promise<LibraryManifest> {
  const now = Date.now()
  if (!force && cached && now - cachedAt < MANIFEST_TTL_MS) return cached
  const resp = await fetch('/library/manifest.json')
  if (!resp.ok) throw new Error('Failed to load library manifest')
  cached = await resp.json()
  cachedAt = now
  return cached!
}

/** 强制下次 loadManifest() 重新拉 (改了 manifest.json 之后可用) */
export function invalidateManifest() {
  cached = null
  cachedAt = 0
}

export async function loadFromLibrary(item: LibraryItem): Promise<Song> {
  // 公共乐谱在 /library/ 下, 私有谱谱走 /api/scores/:id/file (需要 cookie 鉴权)
  const url = item.file.startsWith('/') ? item.file : `/library/${item.file}`
  const song = await parseUrl(url)
  // 清单里的曲名/作曲家**优先于** MIDI 文件内部的名字.
  //
  // 以前是反过来的 (`if (!song.title) song.title = item.title`) —— MIDI 内部名字
  // 优先, 于是曲名显示成文件里的垃圾值: "54954A" (Chopin 圆舞曲) / "666"
  // (Godowsky 版) / "Piano\u0000" / "eopn" / "prelude_c_dur_2h", 或者是
  // GBK 被当 latin-1 解的乱码. 清单是人工整理的, 永远是对的.
  if (item.title) song.title = item.title
  if (item.composer) song.composer = item.composer
  if (song.keyFifths === undefined) {
    const f = keyStringToFifths(item.key)
    if (f !== undefined) song.keyFifths = f
  }
  return song
}

/**
 * 从乐库加载一首曲子, 并**记下它的出处** (librarySource).
 *
 * 出处决定编辑器里「存到公共乐库」是**覆盖原来那一条**还是**新建一条**.
 *
 * ★ 以前只有乐库面板那两条路记出处 —— 启动时自动恢复上次弹的曲子
 *   (App 的 autoload effect)、「最近」banner 点开曲子, 都没记.
 *   结果: 用户刷新页面 → app 静默恢复了那首曲子 → 进编辑器改 → 存公共 →
 *   服务端收不到 itemId, **多出一条 admin 条目**, 原来那条纹丝不动 →
 *   「退出来刷新又是老的了」(用户 2026-11-04 报的).
 *
 * 所以「从乐库加载曲子」只有这一条路 —— 谁都别再自己 setSong + 忘了记出处.
 */
export async function loadLibrarySong(item: LibraryItem, groupId?: string): Promise<Song> {
  const song = await loadFromLibrary(item)
  let gid = groupId ?? item.groupId ?? ''
  // 公共乐库: 分组 id 从清单里找 (新建条目时要写到哪个分组)
  if (!gid && item.scope !== 'mine') {
    try {
      const m = await loadManifest()
      gid = m.groups.find((g) => g.items.some((it) => it.id === item.id))?.id ?? ''
    } catch {
      /* 清单拿不到就算了 —— 覆盖用 itemId 就够, groupId 只影响新建 */
    }
  }
  useStore.getState().setSong(song)
  useStore.getState().setLibrarySource({
    id: item.id,
    groupId: gid,
    scope: item.scope ?? 'public',
    file: item.file,
    scoreId: item.scoreId,
    title: item.title,
  })
  return song
}

/**
 * 按 id 找回乐库里的一条 (分享链接 / 收藏夹点开都用它).
 *
 * - scope='public' → 翻公共 manifest, 顺便把分组 id 补上
 * - scope='mine'   → 拉当前用户的私有谱子列表 (要登录)
 *
 * 找不到 → null (曲子在乐库里被删了 / 私有的那条不是这个用户的).
 */
export async function findLibraryItemById(
  scope: 'public' | 'mine',
  id: string,
): Promise<LibraryItem | null> {
  if (scope === 'mine') {
    const items = await loadMyScores()
    return items.find((it) => it.id === id) ?? null
  }
  const m = await loadManifest()
  for (const g of m.groups) {
    const it = g.items.find((x) => x.id === id)
    if (it) return { ...it, scope: 'public', groupId: g.id }
  }
  return null
}

/** 服务端返回的私有谱子记录 */export interface MyScore {  id: number
  title: string
  subtitle: string
  composer: string
  key: string
  duration: number | null
  difficulty: number
  tracks: string
  tags: string[]
  filename: string
  size: number
  createdAt: number
}

/**
 * 我的谱子列表 (需登录). 不进 manifest 缓存 —— 每次现拉, 上传完立刻能看到.
 */
export async function loadMyScores(): Promise<LibraryItem[]> {
  const resp = await fetch('/api/scores', { credentials: 'same-origin' })
  if (!resp.ok) {
    const text = await resp.text()
    let msg = `加载失败 (${resp.status})`
    try {
      const data = JSON.parse(text)
      if (data?.error) msg = data.error
    } catch {}
    throw new Error(msg)
  }
  const data = (await resp.json()) as { scores: MyScore[] }
  return (data.scores ?? []).map((s) => ({
    id: `u-${s.id}`,
    title: s.title,
    subtitle: s.subtitle || `我的上传 · ${s.filename}`,
    composer: s.composer || '未知',
    key: s.key || '—',
    duration: s.duration ?? undefined,
    difficulty: s.difficulty,
    tags: s.tags,
    file: `/api/scores/${s.id}/file`,
    tracks: s.tracks === 'mxl' ? 'mxl' : s.tracks === '2' ? 2 : 1,
    scope: 'mine' as const,
    scoreId: s.id,
  }))
}

/**
 * 上传时的元数据 —— 私有上传和公共乐库保存共用一套.
 */
function scoreParams(file: File, song: Song): URLSearchParams {
  const title = song.title?.trim() || file.name.replace(/\.[^.]+$/, '')
  const composer = song.composer?.trim() || '未知'
  const key = fifthsToKeyString(song.keyFifths) || '—'
  // 通道数: MusicXML 一律算 'mxl'; MIDI 看左右手是不是不同 track
  const tracks = song.source === 'xml' ? 'mxl' : song.hands.left !== song.hands.right ? '2' : '1'

  const params = new URLSearchParams({
    filename: file.name,
    title,
    composer,
    key,
    difficulty: '3',
    tracks,
  })
  if (song.duration > 0) params.set('duration', String(Math.round(song.duration)))
  return params
}

/**
 * 上传谱子到服务端 (自动保存到「我的谱子」).
 *
 * 文件字节直接当 body 发 (raw upload), 元数据走 query string —— 服务端
 * 就不用写 multipart 解析器了.
 */
export async function uploadMyScore(file: File, song: Song): Promise<MyScore> {
  const params = scoreParams(file, song)

  const resp = await fetch(`/api/scores?${params.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  const text = await resp.text()
  let data: { score?: MyScore; error?: string } | null = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!resp.ok) throw new Error(data?.error ?? `上传失败 (${resp.status})`)
  return data!.score!
}

/**
 * 保存到**公共乐库** (仅管理员 —— 服务端会校验, 非管理员 403).
 *
 * - 带 itemId → 覆盖公共乐库里那一条 (文件原地替换)
 * - 不带     → 新建一条
 *
 * 存完要让乐库列表立刻看到新东西 → 把 manifest 缓存作废.
 */
export async function saveToPublicLibrary(
  file: File,
  song: Song,
  opts?: { itemId?: string; groupId?: string },
): Promise<LibraryItem> {
  const params = scoreParams(file, song)
  if (opts?.itemId) params.set('itemId', opts.itemId)
  if (opts?.groupId) params.set('groupId', opts.groupId)

  const resp = await fetch(`/api/scores/public?${params.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  const text = await resp.text()
  let data: { item?: LibraryItem; error?: string } | null = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!resp.ok) throw new Error(data?.error ?? `保存到公共乐库失败 (${resp.status})`)
  if (!data?.item) throw new Error('保存到公共乐库失败 (服务端没返回条目)')

  // 公共乐库的清单变了 —— 下次 loadManifest() 得重新拉
  invalidateManifest()
  return { ...data.item, scope: 'public' }
}

/**
 * 从**公共乐库**里删掉一条 (仅管理员 —— 服务端会校验, 非管理员 403).
 *
 * 服务端把 manifest 里那一条去掉, 曲子文件挪进 public/library/_archive/
 * (不真删 —— 误删了还能从那儿捞回来).
 */
export async function deletePublicLibrary(itemId: string): Promise<void> {
  const resp = await fetch(`/api/scores/public/${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  const text = await resp.text()
  let data: { error?: string } | null = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {}
  if (!resp.ok) throw new Error(data?.error ?? `删除失败 (${resp.status})`)
  // 清单变了 —— 下次 loadManifest() 得重新拉
  invalidateManifest()
}

/** 调名字符串 -> -7..+7. 兼容大写/小写/♭/#/b/♯ 变体. 失败返回 undefined. */
function keyStringToFifths(s: string): number | undefined {
  if (!s) return undefined
  // "D major" / "B♭ minor" / "F#m" / "Bb" — 取空格前一段作根音
  const root = s.trim().split(/\s+/)[0]
  if (!root) return undefined
  // 标准化: 升降号统一, 大写
  const norm = root
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/♮/g, '')
  // 拆根音 + 是否 minor
  const isMinor = /m(in)?$/i.test(norm)
  const tonic = norm.replace(/m(in)?$/i, '')
  const sharp = tonic.includes('#')
  const flat = tonic.includes('b')
  const letter = tonic.replace(/[#b]/g, '').toUpperCase()
  // 大调 fifths
  const majorFifths: Record<string, number> = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
    F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  }
  const key = (sharp ? letter + '#' : flat ? letter + 'b' : letter)
  let f = majorFifths[key]
  if (f === undefined) return undefined
  // 小调 fifths: 相对大调 - 3 个升降 (例: A 小调无升降 = C 大调 0; E 小调 = G 大调 1)
  if (isMinor) f -= 3
  return f
}

/**
 * fifths (-7..+7) -> 调名字符串 ("E♭ major" / "C# minor").
 * keyStringToFifths 的反向函数 —— 用户上传的谱子只有 keyFifths, 要转成
 * 乐库那种人读的调名才能显示.
 */
export function fifthsToKeyString(fifths: number | undefined): string {
  if (fifths === undefined || fifths < -7 || fifths > 7) return ''
  // 数组下标 = fifths + 7
  const MAJOR = [
    'C♭ major', 'G♭ major', 'D♭ major', 'A♭ major', 'E♭ major', 'B♭ major', 'F major',
    'C major', 'G major', 'D major', 'A major', 'E major', 'B major', 'F♯ major', 'C♯ major',
  ]
  const i = Math.round(fifths) + 7
  return MAJOR[i]
}
