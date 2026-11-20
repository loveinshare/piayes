// 收藏夹 —— 乐库抽屉里, 「最近」banner 正下方的那一块.
//
// 默认**收起** (用户要求): 收藏是偶尔才翻的东西, 不该占着抽屉最上面.
// 点开是一列收藏的曲子, 点标题加载, 点 ▶ 加载并播放, 点 ✕ 取消收藏.
//
// 收藏跟着账号走 (存在 prefs 里), 所以没登录时这一块只有一句提示.

import { useState } from 'react'
import { useStore, type Favourite } from '../store'
import { useAuth, openAuthModal } from '../auth'
import { findLibraryItemById, loadLibrarySong } from '../library'
import { IconAlert, IconClose, IconLoader, IconPlay, IconStar } from './icons'

interface Props {
  /** 曲子加载完 —— 调用方一般用它关掉抽屉 */
  onLoaded?: () => void
  /** 加载并播放 (App 负责真正开播放器) */
  onPlayNow?: () => void
}

export function Favourites({ onLoaded, onPlayNow }: Props) {
  const favorites = useStore((s) => s.favorites)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const user = useAuth((s) => s.user)
  // 默认收起 —— 收藏夹不常用, 别占抽屉最上面
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const load = async (f: Favourite, autoPlay: boolean) => {
    setLoadingId(f.id)
    setError(null)
    try {
      const item = await findLibraryItemById(f.scope, f.id)
      if (!item) throw new Error('乐库里找不到这首了')
      // 私有谱子走 API (要登录), 公共的走 manifest —— groupId 决定走哪条
      const groupId = f.scope === 'mine' ? 'mine' : (item.groupId ?? '')
      await loadLibrarySong(item, groupId)
      useStore.getState().addLastPlayed({
        kind: 'library',
        itemId: item.id,
        groupId,
        title: item.title,
        composer: item.composer,
        at: Date.now(),
      })
      if (autoPlay) onPlayNow?.()
      onLoaded?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoadingId(null)
    }
  }

  return (
    <div className="border border-border rounded overflow-hidden mb-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-panel/60 hover:bg-panel text-sm font-semibold text-text transition"
        aria-expanded={open}
      >
        <Chevron open={open} />
        <IconStar size={13} filled={favorites.length > 0} className={favorites.length > 0 ? 'text-yellow-400' : 'text-muted'} />
        <span className="flex-1 text-left truncate">收藏夹</span>
        <span className="text-xs text-muted tabular-nums">{favorites.length}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-1 p-1.5 bg-bg/40">
          {!user && (
            <div className="text-xs text-muted px-1.5 py-2 flex items-center gap-2">
              <span>登录后才能收藏曲子</span>
              <button
                onClick={() => openAuthModal('login')}
                className="px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 transition"
              >
                登录 / 注册
              </button>
            </div>
          )}
          {user && favorites.length === 0 && (
            <div className="text-xs text-muted px-1.5 py-2">
              还没有收藏 —— 点乐库曲目右边的 ☆, 或顶栏曲名后面的 ☆
            </div>
          )}
          {error && (
            <div className="text-xs text-miss px-2 py-1 bg-miss/10 rounded-md flex items-center gap-1.5">
              <IconAlert size={12} />
              {error}
            </div>
          )}
          {favorites.map((f) => (
            <div
              key={`${f.scope}/${f.id}`}
              className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-accent/10 group"
            >
              <span className="text-yellow-400/80 shrink-0" aria-hidden>
                <IconStar size={13} filled />
              </span>
              <button
                onClick={() => load(f, false)}
                disabled={loadingId === f.id}
                className="min-w-0 flex-1 text-left disabled:opacity-50"
                title={`${f.composer} · 加载这首曲子`}
              >
                <div className="font-medium text-text truncate text-sm">{f.title}</div>
                <div className="text-xs text-muted truncate">{f.composer}</div>
              </button>
              <button
                onClick={() => load(f, true)}
                disabled={loadingId === f.id}
                className="size-7 grid place-items-center rounded text-muted hover:text-accent hover:bg-bg opacity-0 group-hover:opacity-100 disabled:opacity-50 shrink-0"
                title="加载并播放"
                aria-label={`加载并播放 ${f.title}`}
              >
                {loadingId === f.id ? <IconLoader size={14} className="anim-spin" /> : <IconPlay size={14} />}
              </button>
              <button
                onClick={() => toggleFavorite(f)}
                className="size-7 grid place-items-center rounded text-muted/60 hover:text-miss hover:bg-miss/10 shrink-0 transition"
                title="取消收藏"
                aria-label={`取消收藏 ${f.title}`}
              >
                <IconClose size={13} />
              </button>
            </div>
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
