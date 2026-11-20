// 乐库面板
// 启动时 fetch manifest.json, 按 manifest 的分组渲染
// 搜索 (可匹配曲名 / 作曲家 / 调性 / 标签)
//
// UX:
// - 默认展开第一个分组, 其余折叠
// - 当前曲目高亮 (边框)
// - 行内只留曲名 / 通道数 / 作曲家 / 调性 / 时长 —— 难度和标签收进 title 提示
// - 选完后 onLoaded 回调 (用来关闭抽屉等)

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useAuth, openAuthModal } from '../auth'
import {
  IconAlert,
  IconEdit,
  IconPause,
  IconPlay,
  IconSearch,
  IconStar,
  IconTrash,
  IconUser,
} from './icons'
import {
  loadManifest,
  loadMyScores,
  loadLibrarySong,
  deletePublicLibrary,
  type LibraryItem,
  type LibraryGroup,
  type LibraryManifest,
} from '../library'

const DIFFICULTY_LABEL: Record<number, string> = {
  1: '入门',
  2: '简单',
  3: '中等',
  4: '进阶',
  5: '困难',
}

/** 通道数 chip: 绿底白字, 视觉统一. 准不准靠 title 提示. */
const TRACK_BADGE: Record<LibraryItem['tracks'], { label: string; cls: string; title: string }> = {
  2: { label: '2轨', cls: 'bg-emerald-500 text-white', title: '双 track MIDI, 按音高分配 LH/RH, 准确' },
  'mxl': { label: 'MXL', cls: 'bg-emerald-500 text-white', title: 'MusicXML 多 part, 按 clef 分配 LH/RH, 最准' },
  1: { label: '1轨', cls: 'bg-emerald-500 text-white', title: '单 track MIDI, 声部聚类推断, 可能有偏差' },
  'multi': { label: '多轨', cls: 'bg-amber-500 text-white', title: '多 track MIDI (≥3), 按音符数分左右手, 大致' },
}

interface Props {
  onLoaded?: () => void
  /** 双击曲目时: 已加载, 调用方负责触发播放. 用于双击立即跟弹 */
  onPlayNow?: () => void
  /** 切换播放/暂停 (当 item.id === recentId) */
  onTogglePlay?: () => void
  /** 播放中状态 (用于 ▶ 按钮 spin vs static 视觉) */
  isPlaying?: boolean
  /**
   * 'public' = 公共乐库 (public/library/manifest.json, 所有人可见),
   * 'mine'   = 当前登录用户上传的私有谱子 (走 /api/scores).
   */
  scope?: 'public' | 'mine'
  /**
   * 右键曲目 → 打开谱子编辑器.
   *
   * 用户需求 (2026-11-02): 「在乐谱文件那里右键打开和更改」——
   * 右键一首曲子就能进编辑器改音高 / 时值.
   * 调用时机: **曲子已经装成当前曲目之后** —— 编辑器改的是「当前曲目」.
   */
  onEditScore?: () => void
}

export function Library({
  onLoaded,
  onPlayNow,
  onTogglePlay,
  isPlaying: isPlayingProp,
  scope = 'public',
  onEditScore,
}: Props) {
  // 直接从 store 读 isPlaying, 避免 App 闭包陷阱; 道具传进来仅作 fallback
  const isPlaying = useStore((s) => s.isPlaying) || isPlayingProp
  const user = useAuth((s) => s.user)
  /** 乐库变动计数 —— 存完/删完自增, 面板跟着重新拉列表 */
  const libraryVersion = useStore((s) => s.libraryVersion)
  const [manifest, setManifest] = useState<LibraryManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [recentId, setRecentId] = useState<string | null>(null)
  /** 私有谱子列表 — 变动后要刷新 (上传/删除完) */
  const [mineVersion, setMineVersion] = useState(0)

  const [search, setSearch] = useState('')
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())

  // 乐库刷新计数变了 → 这次必须绕过 manifest 的 60s 缓存重新拉.
  // (不然存完虽然触发了刷新, 拿到的还是缓存里的旧清单)
  const lastVersionRef = useRef(libraryVersion)

  // 公共乐库: 静态 manifest (带 60s TTL 缓存)
  // 我的谱子: 走 API (不进 manifest 缓存 —— 上传完要立刻看到)
  useEffect(() => {
    const forced = lastVersionRef.current !== libraryVersion
    lastVersionRef.current = libraryVersion
    setError(null)
    if (scope === 'public') {
      loadManifest(forced)
        .then((m) => {
          setManifest(m)
          // ★ 2026-11-13: 不再默认展开第一个分组 (那是「Chopin」) ——
          //   用户要求「chopin 不要默认打开」. 刚存的那条所在分组仍然展开 ——
          //   新建的条目落在「管理员上传」分组里, 不展开就等于没存.
          const focusId = useStore.getState().libraryFocusId
          const open = new Set<string>()
          const hit = focusId
            ? m.groups.find((g) => g.items.some((it) => it.id === focusId))
            : undefined
          if (hit) open.add(hit.id)
          setOpenGroups(open)
        })
        .catch((e) => setError((e as Error).message))
      return
    }
    if (!user) {
      setManifest({ version: 1, groups: [] })
      return
    }
    loadMyScores()
      .then((items) => {
        setManifest({
          version: 1,
          groups: items.length > 0 ? [{ id: 'mine', name: '我的谱子', items }] : [],
        })
        setOpenGroups(new Set(['mine']))
      })
      .catch((e) => setError((e as Error).message))
  }, [scope, user?.id, mineVersion, libraryVersion])

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const matches = (it: LibraryItem) => {
    const q = search.trim().toLowerCase()
    if (q) {
      if (
        !it.title.toLowerCase().includes(q) &&
        !it.subtitle.toLowerCase().includes(q) &&
        !it.composer.toLowerCase().includes(q) &&
        !it.key.toLowerCase().includes(q) &&
        !it.tags.some((t) => t.toLowerCase().includes(q))
      ) return false
    }
    return true
  }

  const load = async (item: LibraryItem, autoPlay = false) => {
    setLoadingId(item.id)
    setError(null)
    try {
      // 加到最近 5 个 (自动去重, 移到头部, cap 5)
      let groupId = 'mine'
      if (scope === 'public') {
        const m = await loadManifest() // cheap, 已 cache
        groupId = m.groups.find((g) => g.items.some((it) => it.id === item.id))?.id ?? ''
      }
      // 装成当前曲目 + 记下出处 (编辑器保存时要知道覆盖哪一条)
      await loadLibrarySong(item, groupId)
      setRecentId(item.id)
      useStore.getState().addLastPlayed({
        kind: 'library',
        itemId: item.id,
        groupId,
        title: item.title,
        composer: item.composer,
        at: Date.now(),
      })
      // 关键: 不能在这里直接 onPlayNow — player 重建在 useEffect 里, 还没跑
      // 用挂起标志位让 App 在新 player 就绪后启动
      if (autoPlay) onPlayNow?.()
      onLoaded?.()
    } catch (e) {
      setError(`「${item.title}」加载失败: ${(e as Error).message}`)
    } finally {
      setLoadingId(null)
    }
  }

  if (scope === 'mine' && !user) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <div className="size-12 grid place-items-center rounded-2xl bg-panel border border-border text-muted">
          <IconUser size={22} />
        </div>
        <div className="text-sm text-muted">登录后可以上传谱子, 并在自己的谱库里管理</div>
        <button
          onClick={() => openAuthModal('login')}
          className="px-3 py-1.5 text-sm font-semibold rounded-lg bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 transition"
        >
          登录 / 注册
        </button>
      </div>
    )
  }

  /**
   * 右键 → 「编辑谱子」.
   *
   * 先把曲子装成**当前曲目**, 再叫上层开编辑器 —— 编辑器改的是当前曲目,
   * 顺序反了的话编辑器会拿着上一首 (或者空) 打开.
   */
  const openEditorFor = async (item: LibraryItem) => {
    if (!onEditScore) return
    setLoadingId(item.id)
    setError(null)
    try {
      // 出处也要记 —— 编辑器里直接「存到公共乐库」时要靠它决定覆盖哪一条
      let groupId = 'mine'
      if (scope === 'public') {
        const m = await loadManifest()
        groupId = m.groups.find((g) => g.items.some((it) => it.id === item.id))?.id ?? ''
      }
      await loadLibrarySong(item, groupId)
      setRecentId(item.id)
      onEditScore()
    } catch (e) {
      setError(`「${item.title}」加载失败: ${(e as Error).message}`)
    } finally {
      setLoadingId(null)
    }
  }

  /** 删除自己的谱子 (服务端记录 + 落盘文件一起删) */
  const remove = async (item: LibraryItem) => {
    if (item.scoreId === undefined) return
    if (!window.confirm(`删除「${item.title}」?`)) return
    try {
      const resp = await fetch(`/api/scores/${item.scoreId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => null)
        throw new Error(data?.error ?? `删除失败 (${resp.status})`)
      }
      setError(null)
      setMineVersion((v) => v + 1)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /**
   * 删除**公共乐库**里的曲子 (仅管理员 —— 服务端也会再校验一次).
   *
   * 服务端把 manifest 里那一条去掉, 曲子文件挪进 _archive/ (还能捞回来).
   * 删完要刷新面板 → bumpLibrary() 让清单重拉.
   */
  const removePublic = async (item: LibraryItem) => {
    if (!window.confirm(`从公共乐库删掉「${item.title}」?\n(曲子文件会挪到 _archive/, 还能捞回来)`)) return
    try {
      await deletePublicLibrary(item.id)
      setError(null)
      useStore.getState().bumpLibrary()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** 垃圾桶按钮的统一入口 —— 按 scope 分派到上面两个删除. */
  const handleDelete = (item: LibraryItem) => {
    if (item.scope === 'mine') return remove(item)
    return removePublic(item)
  }

  /** 公共乐库里能不能删 —— 只有管理员 (服务端也会再校验一遍). */
  const canDeletePublic = scope === 'public' && !!user?.isAdmin

  if (error && !manifest) {
    return (
      <div className="text-xs text-miss flex items-center gap-1.5">
        <IconAlert size={13} />
        {error}
      </div>
    )
  }
  if (!manifest) {
    return (
      <div className="text-xs text-muted flex items-center gap-2">
        <span className="inline-block size-3 border-2 border-border border-t-accent rounded-full anim-spin" />
        加载乐库…
      </div>
    )
  }

  const totalShown = manifest.groups.reduce(
    (n, g) => n + g.items.filter(matches).length, 0,
  )

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative">
        <span
          aria-hidden
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none grid place-items-center"
        >
          <IconSearch size={15} />
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索 (曲名 / 作曲家 / 调性)"
          className="w-full px-3 py-2 pl-9 text-sm bg-bg border border-border rounded-lg placeholder-muted focus:border-accent focus:outline-none transition"
          aria-label="搜索乐库"
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted">共 {totalShown} 首</span>
        <div className="flex gap-2">
          <button
            onClick={() => setOpenGroups(new Set(manifest.groups.map((g) => g.id)))}
            className="text-muted hover:text-accent"
          >
            全展开
          </button>
          <span className="text-border">·</span>
          <button
            onClick={() => setOpenGroups(new Set())}
            className="text-muted hover:text-accent"
          >
            全收起
          </button>
        </div>
      </div>

      {error && (
        <div className="text-xs text-miss px-2 py-1 bg-miss/10 rounded-md flex items-center gap-1.5">
          <IconAlert size={12} />
          {error}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {manifest.groups.map((g) => {
          const items = g.items.filter(matches)
          if (items.length === 0) return null
          // 搜索时自动展开有结果的分组 —— 分组默认收起 (chopin 不默认打开),
          // 不这样处理的话, 搜索框里打了字却一条都看不见.
          const open = openGroups.has(g.id) || (search.trim() !== '' && items.length > 0)
          return (
            <Group
              key={g.id}
              group={{ ...g, items }}
              open={open}
              onToggle={() => toggleGroup(g.id)}
              onLoad={load}
              onDelete={handleDelete}
              canDelete={canDeletePublic}
              loadingId={loadingId}
              recentId={recentId}
              isPlaying={isPlaying}
              onTogglePlay={onTogglePlay}
              onOpenEditor={openEditorFor}
            />
          )
        })}
      </div>
      {totalShown === 0 && (
        <div className="text-xs text-muted text-center py-4 border border-dashed border-border rounded">
          {scope === 'mine'
            ? (user ? '还没有上传谱子 —— 去「文件」页拖一个 .mid 进来, 会自动存到这里' : '')
            : '无匹配曲目'}
        </div>
      )}
    </div>
  )
}

function Group({
  group,
  open,
  onToggle,
  onLoad,
  onDelete,
  canDelete,
  loadingId,
  recentId,
  isPlaying,
  onTogglePlay,
  onOpenEditor,
}: {
  group: LibraryGroup
  open: boolean
  onToggle: () => void
  onLoad: (it: LibraryItem) => void
  onDelete: (it: LibraryItem) => void
  /** 公共乐库里也能显示删除按钮 (仅管理员) */
  canDelete?: boolean
  loadingId: string | null
  recentId: string | null
  isPlaying?: boolean
  onTogglePlay?: () => void
  /** 右键 → 编辑谱子 */
  onOpenEditor?: (it: LibraryItem) => void
}) {
  return (
    <div className="border border-border rounded overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-panel/60 hover:bg-panel text-sm font-semibold text-text transition"
      >
        <Chevron open={open} />
        <span className="flex-1 text-left truncate">{group.name}</span>
        <span className="text-xs text-muted tabular-nums">{group.items.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 p-1.5 bg-bg/40">
          {group.items.map((it) => (
            <Item
              key={it.id}
              item={it}
              groupId={group.id}
              onLoad={onLoad}
              onDelete={onDelete}
              canDelete={canDelete}
              loading={loadingId === it.id}
              isRecent={recentId === it.id}
              isCurrent={recentId === it.id}
              isPlaying={isPlaying}
              onTogglePlay={onTogglePlay}
              onOpenEditor={onOpenEditor}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      className={`inline-block w-0 h-0 transition-transform shrink-0 ${
        open ? 'rotate-90' : ''
      }`}
      style={{
        borderLeft: '5px solid currentColor',
        borderTop: '4px solid transparent',
        borderBottom: '4px solid transparent',
        color: 'var(--muted, #888)',
      }}
      aria-hidden
    />
  )
}

function Item({
  item,
  groupId,
  onLoad,
  onDelete,
  canDelete,
  loading,
  isRecent,
  isCurrent,
  isPlaying,
  onTogglePlay,
  onOpenEditor,
}: {
  item: LibraryItem
  /** 所在分组 id —— 收藏夹要靠它找回这一条 (私有谱子恒为 'mine') */
  groupId: string
  onLoad: (it: LibraryItem, autoPlay?: boolean) => void
  onDelete: (it: LibraryItem) => void
  /** 公共乐库里也能显示删除按钮 (仅管理员) */
  canDelete?: boolean
  loading: boolean
  isRecent: boolean
  isCurrent?: boolean
  isPlaying?: boolean
  onTogglePlay?: () => void
  /** 右键 → 编辑谱子 */
  onOpenEditor?: (it: LibraryItem) => void
}) {
  // 右键菜单 —— 「编辑谱子」入口 (用户需求 2026-11-02)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])
  // 用 timer 区分单击/双击, 比 React 的 onDoubleClick 可靠 (后者经常被 onClick 抢跑).
  // 关键设计: 第一次 click **延迟 200ms** 才 setSong. 这 200ms 内:
  //   - 没第二次 click → setSong(false) 单击加载
  //   - 有第二次 click → 立刻 setSong(true) 加载并播放, 清 timer
  // 200ms 延迟换来「双击一定 work」, 单击只是感觉稍微顿一下 (200ms 在感知阈值下).
  // 用 detail 属性太脆弱, timer 法更稳.
  const clickTimerRef = useRef<number | null>(null)
  const handleClick = () => {
    if (clickTimerRef.current !== null) {
      // 第二次 click 在 200ms 内 — 升级为「加载并播放」
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      onLoad(item, true)
      return
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      onLoad(item, false)
    }, 200)
  }
  // 内嵌 ▶ 按钮: 是当前曲目 → 切播放/暂停; 否则 → 加载并播放 (同双击).
  // 必须 stopPropagation 拦住外层按钮的 200ms timer, 不然会同时触发 setSong(false).
  const handlePlayClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isCurrent && onTogglePlay) {
      onTogglePlay()
    } else {
      onLoad(item, true)
    }
  }
  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
  }, [])
  // 删除按钮: 用 span role=button (不能套 <button> —— 外层已经是 button)
  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(item)
  }
  // 收藏: 收藏跟着账号走 —— 没登录先弹登录框
  const user = useAuth((s) => s.user)
  const favorites = useStore((s) => s.favorites)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const favScope = item.scope ?? 'public'
  const faved = favorites.some((f) => f.scope === favScope && f.id === item.id)
  const handleFavorite = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!user) {
      openAuthModal('login')
      return
    }
    toggleFavorite({
      scope: favScope,
      id: item.id,
      groupId,
      title: item.title,
      composer: item.composer,
      scoreId: item.scoreId,
    })
  }
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!onOpenEditor) return
    setMenu({ x: e.clientX, y: e.clientY })
  }
  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        disabled={loading}
        title={`${item.title} · 难度 ${DIFFICULTY_LABEL[item.difficulty] ?? '-'} · 单击加载 · 双击加载并开始跟弹 · 右键编辑谱子`}
      className={`text-left p-2.5 rounded text-sm transition border w-full ${
        isRecent
          ? 'border-accent bg-accent/10 shadow-sm shadow-accent/20'
          : 'border-transparent hover:border-border hover:bg-panel/60'
      } disabled:opacity-50`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-text min-w-0 flex-1 flex items-center gap-1.5">
          {loading && <span className="inline-block size-3 border-2 border-border border-t-accent rounded-full anim-spin shrink-0" />}
          {/* 始终显示 ▶ — 既是「当前曲目」指示, 也是可点击的播放按钮.
              是当前 + 播放中: 换成 ⏸; 静态 ▶ 0.85 opacity 区分"还没选". */}
          {!loading && (
            <span
              role="button"
              tabIndex={0}
              onClick={handlePlayClick}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  handlePlayClick(e as unknown as React.MouseEvent)
                }
              }}
              className={`shrink-0 cursor-pointer hover:text-text ${isCurrent ? 'text-accent' : 'text-accent/60'} ${isCurrent && isPlaying ? 'anim-spin-slow' : ''}`}
              title={isCurrent ? (isPlaying ? '暂停' : '继续播放') : '加载并播放'}
              aria-label={isCurrent ? (isPlaying ? '暂停' : '继续播放') : '加载并播放'}
            >
              {isCurrent && isPlaying ? <IconPause size={13} /> : <IconPlay size={13} />}
            </span>
          )}
          {/* 曲名长的话换行 (最多两行), 别截断 —— 截断了根本看不出是哪首 */}
          <span className="line-clamp-2 leading-snug break-words">{item.title}</span>
        </div>
        <span className="flex items-center gap-1.5 shrink-0">
          {/* 收藏星标 —— 收藏夹的入口 (顶栏也有一个, 那是当前曲目的). */}
          <span
            role="button"
            tabIndex={0}
            onClick={handleFavorite}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                handleFavorite(e as unknown as React.MouseEvent)
              }
            }}
            className={`shrink-0 cursor-pointer transition ${
              faved ? 'text-yellow-400 hover:text-yellow-300' : 'text-muted/50 hover:text-text'
            }`}
            title={faved ? '取消收藏' : user ? '收藏这首曲子' : '收藏这首曲子 (需要登录)'}
            aria-label={faved ? `取消收藏 ${item.title}` : `收藏 ${item.title}`}
          >
            <IconStar size={13} filled={faved} />
          </span>
          <span
            className={`px-1.5 py-0.5 rounded text-[11px] font-semibold leading-none ${TRACK_BADGE[item.tracks].cls}`}
            title={TRACK_BADGE[item.tracks].title}
          >
            {TRACK_BADGE[item.tracks].label}
          </span>
          {/* 垃圾桶: 私有谱子本人能删; 公共乐库只有管理员能删 (canDelete). */}
          {(item.scope === 'mine' || canDelete) && (
            <span
              role="button"
              tabIndex={0}
              onClick={handleDelete}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onDelete(item)
                }
              }}
              className="shrink-0 cursor-pointer text-muted/60 hover:text-miss transition"
              title={item.scope === 'mine' ? '删除这个谱子' : '从公共乐库删掉这首曲子'}
              aria-label={`删除 ${item.title}`}
            >
              <IconTrash size={13} />
            </span>
          )}
        </span>
      </div>
      {/* 副标题 + 元信息合并成一行 —— 难度圆点和标签 chip 已经按需求撤掉,
          一行放不下就截断, 别把列表撑高. */}
      <div className="flex items-baseline gap-1.5 mt-0.5 text-xs min-w-0">
        <span className="text-muted shrink-0">{item.composer}</span>
        <span className="text-border shrink-0">·</span>
        <span className="text-muted shrink-0">{item.key}</span>
        {item.duration && (
          <>
            <span className="text-border shrink-0">·</span>
            <span className="text-muted shrink-0 tabular-nums">
              {Math.round(item.duration / 60)}:{(item.duration % 60).toString().padStart(2, '0')}
            </span>
          </>
        )}
        <span className="text-border shrink-0">·</span>
        <span className="text-muted/80 truncate">{item.subtitle}</span>
      </div>
      </button>
      {/* 右键菜单 —— 独立于 <button> (button 里不能塞 div) */}
      {menu && (
        <div
          className="fixed z-[55] w-40 rounded-lg bg-panel border border-border shadow-xl shadow-black/50 py-1 anim-fade-in"
          style={{
            left: Math.min(menu.x, window.innerWidth - 170),
            top: Math.min(menu.y, window.innerHeight - 90),
          }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="w-full px-3 py-1.5 flex items-center gap-2 text-xs text-text hover:bg-accent/10 transition-colors cursor-pointer text-left"
            onClick={() => {
              setMenu(null)
              onLoad(item, true)
            }}
          >
            <IconPlay size={12} className="text-accent shrink-0" />
            加载并播放
          </button>
          <button
            className="w-full px-3 py-1.5 flex items-center gap-2 text-xs text-text hover:bg-accent/10 transition-colors cursor-pointer text-left"
            onClick={() => {
              setMenu(null)
              // 先把曲子装成当前曲目, 再开编辑器 (编辑器改的是「当前曲目」)
              onOpenEditor?.(item)
            }}
          >
            <IconEdit size={12} className="text-accent shrink-0" />
            编辑谱子
          </button>
        </div>
      )}
    </>
  )
}

