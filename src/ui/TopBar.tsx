// 顶部信息条: 标题 + 当前曲目 + 右上角动作按钮 (账号 / 统计 / MIDI / 设置 / 全屏)
// 收紧: 删掉了 4 个 BPM/拍号/notes 数/时长 chip, 改到 StatusBar 跟手显示

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { useAuth, openAuthModal } from '../auth'
import { LedDock } from './LedDock'
import { LedScreenDock } from './LedScreenDock'
import { copyText } from './clipboard'
import { buildShareUrl } from '../share'
import {
  IconChart,
  IconCheck,
  IconClose,
  IconExpand,
  IconMidi,
  IconMusic,
  IconPiayes,
  IconShare,
  IconSliders,
  IconStar,
  IconUser,
} from './icons'

interface Props {
  onOpenSettings: () => void
  onOpenStats: () => void
  onOpenMidi: () => void
  onOpenLibrary: () => void
}

export function TopBar({ onOpenSettings, onOpenStats, onOpenMidi, onOpenLibrary }: Props) {
  const song = useStore((s) => s.song)
  const setSong = useStore((s) => s.setSong)
  const midiInputId = useStore((s) => s.midiInputId)
  const midiOutputId = useStore((s) => s.midiOutputId)
  const librarySource = useStore((s) => s.librarySource)
  const favorites = useStore((s) => s.favorites)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)

  const [isFs, setIsFs] = useState(false)
  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // 账号菜单: 已登录显示用户名 + 退出, 未登录显示「登录」按钮
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  const toggleFs = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      document.documentElement.requestFullscreen().catch((e) => {
        console.warn('requestFullscreen failed:', e)
      })
    }
  }

  const hasMidi = midiInputId !== null || midiOutputId !== null

  // 曲名点击复制: 悬浮变手型, 单击把「曲名」(不含作曲家) 写进剪贴板
  // copied: null | 'title' (曲名) | 'link' (分享链接) —— 用来显示提示条
  const [copied, setCopied] = useState<'title' | 'link' | null>(null)
  const copiedTimer = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    }
  }, [])
  useEffect(() => {
    setCopied(null)
  }, [song?.title])

  const flashCopied = (what: 'title' | 'link') => {
    setCopied(what)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1400)
  }

  const copyTitle = async () => {
    const title = song?.title
    if (!title) return
    if (!(await copyText(title))) return
    flashCopied('title')
  }

  // ---- 收藏 / 分享 ----
  //
  // 收藏和分享都只对**有出处**的曲子有意义 (从乐库/私有谱库加载的);
  // 本地拖进来的文件没有 id —— 分享不出一个能打开的链接.
  const faved = !!librarySource && favorites.some(
    (f) => f.scope === librarySource.scope && f.id === librarySource.id,
  )

  const onFavoriteClick = () => {
    if (!librarySource) return
    if (!user) {
      // 收藏是**跟着账号**的 —— 没登录先弹登录框
      openAuthModal('login')
      return
    }
    toggleFavorite({
      scope: librarySource.scope,
      id: librarySource.id,
      groupId: librarySource.groupId,
      title: librarySource.title,
      composer: song?.composer ?? '',
      scoreId: librarySource.scoreId,
    })
  }

  const onShareClick = async () => {
    if (!librarySource) return
    const url = buildShareUrl({ id: librarySource.id, scope: librarySource.scope })
    if (!(await copyText(url))) return
    flashCopied('link')
  }

  return (
    // relative z-30: backdrop-blur 会生成层叠上下文, 而 static 元素的绘制层级
    // 低于后面的兄弟节点 —— 不加这层, 顶栏里弹出的 LED 面板会被练习条盖住
    <div className="relative z-30 h-11 px-3 flex items-center border-b border-border bg-panel/60 backdrop-blur">
      {/* 左: logo */}
      <div className="flex items-center gap-2 shrink-0 z-10">
        <div className="size-7 grid place-items-center rounded-lg bg-accent/15 text-accent border border-accent/25">
          <IconPiayes size={18} />
        </div>
        <div className="font-semibold text-text hidden sm:block text-sm tracking-tight">Piayes</div>
      </div>

      {/* 中: 当前曲名 —— 绝对定位居中.
          之前它是 flex-1 的兄弟节点, 左右两栏宽度不同 (logo 窄 / 按钮排宽),
          所以"看起来居中"其实是偏的. 绝对定位后才是真正的中线. */}
      <div className="absolute inset-x-0 top-0 h-11 flex items-center justify-center pointer-events-none">
        <div className="max-w-[46%] min-w-0 flex items-center justify-center gap-2 pointer-events-auto">
        {song ? (
          <div className="flex items-center gap-2 min-w-0">
            {/* 复制提示: 占住「格式徽章」挪走后空出来的左槽 —— 不飘浮, 不压练习条 */}
            {copied && (
              <span className="shrink-0 flex items-center gap-1 rounded border border-hit/40 bg-hit/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-hit">
                <IconCheck size={10} />
                {copied === 'link' ? '链接已复制' : '已复制'}
              </span>
            )}
            <div className="min-w-0 flex-1 flex items-baseline gap-2">
              {song.title ? (
                <>
                  {/* 曲名可复制: 悬浮变手型, 单击只复制曲名 (不含作曲家) */}
                  <button
                    onClick={copyTitle}
                    title={copied ? '已复制曲名' : '点击复制曲名'}
                    className="min-w-0 truncate text-sm font-medium text-text hover:text-accent transition-colors cursor-pointer"
                  >
                    {song.title}
                  </button>
                  {song.composer && (
                    <span className="shrink-0 max-w-[35%] truncate text-xs text-muted">
                      {song.composer}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-xs text-muted">{song.notes.length} notes</span>
              )}
            </div>
            {/* 收藏 / 分享 —— 曲名后面这两个小图标.
                格式徽章 (MIDI/MXL) 已经去掉 —— 那不重要, 挤在曲名后面抢视线. */}
            <button
              onClick={onFavoriteClick}
              disabled={!librarySource}
              className={`size-5 grid place-items-center rounded transition shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${
                faved ? 'text-yellow-400 hover:text-yellow-300' : 'text-muted hover:text-text hover:bg-raised'
              }`}
              title={
                !librarySource
                  ? '这首曲子没有出处 (本地文件), 不能收藏'
                  : faved
                    ? '取消收藏'
                    : user
                      ? '收藏这首曲子'
                      : '收藏这首曲子 (需要登录)'
              }
              aria-label={faved ? '取消收藏' : '收藏'}
            >
              <IconStar size={13} filled={faved} />
            </button>
            <button
              onClick={onShareClick}
              disabled={!librarySource}
              className="size-5 grid place-items-center rounded text-muted hover:text-text hover:bg-raised transition shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
              title={librarySource ? '分享这首曲子 (复制链接)' : '这首曲子没有出处 (本地文件), 不能分享'}
              aria-label="分享"
            >
              <IconShare size={13} />
            </button>
            <button
              onClick={() => setSong(null)}
              className="size-5 grid place-items-center rounded text-muted hover:text-miss hover:bg-miss/10 transition shrink-0"
              title="清除当前曲目"
              aria-label="清除当前曲目"
            >
              <IconClose size={13} />
            </button>
          </div>
        ) : (
          <div className="text-xs text-muted truncate">
            点「乐库」选一首, 或拖入 .mid / .xml
          </div>
        )}
        </div>
      </div>

      {/* 右: 动作按钮 */}
      <div className="flex items-center gap-0.5 shrink-0 ml-auto z-10">
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => (user ? setMenuOpen((v) => !v) : openAuthModal('login'))}
            title={user ? `已登录: ${user.username}` : '登录 / 注册'}
            className={`h-9 px-2 rounded flex items-center gap-1 text-sm transition ${
              user
                ? 'text-accent bg-accent/10 hover:bg-accent/20'
                : 'text-muted hover:text-text hover:bg-bg'
            }`}
          >
            <IconUser size={17} />
            <span className="hidden md:inline max-w-[8rem] truncate">
              {user ? user.username : '登录'}
            </span>
          </button>
          {menuOpen && user && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-panel border border-border rounded shadow-xl overflow-hidden min-w-[9rem]">
              <div className="px-3 py-2 text-xs text-muted border-b border-border truncate">
                {user.username}
              </div>
              <button
                onClick={async () => {
                  setMenuOpen(false)
                  await logout()
                }}
                className="w-full text-left px-3 py-2 text-sm text-muted hover:text-text hover:bg-bg transition"
              >
                退出登录
              </button>
            </div>
          )}
        </div>
        {/* 图标成组 —— 原来 6 个光秃秃的图标跟「登录」按钮挤在一起,
            看不出哪几个是一组. 现在套一个圆角描边的底, 登录按钮单独在外. */}
        <div className="flex items-center gap-0.5 rounded-xl border border-border bg-bg/40 p-0.5">
          <IconBtn title="乐库 / 文件 (B)" onClick={onOpenLibrary}>
            <IconMusic size={17} />
          </IconBtn>
          <IconBtn title="统计" onClick={onOpenStats}>
            <IconChart size={17} />
          </IconBtn>
          <IconBtn title="MIDI 设备" onClick={onOpenMidi} active={hasMidi}>
            <IconMidi size={17} />
          </IconBtn>
          <LedDock variant="inline" />
          {/* 点阵屏是另一台设备 (8081), 单独一个图标; 2026-11-13 从设置抽屉挪到这儿 */}
          <LedScreenDock variant="inline" />
          <IconBtn title="练习设置" onClick={onOpenSettings}>
            <IconSliders size={17} />
          </IconBtn>
          <IconBtn title="全屏 (F)" onClick={toggleFs} active={isFs}>
            <IconExpand size={17} />
          </IconBtn>
        </div>
      </div>
    </div>
  )
}

function IconBtn({
  title,
  onClick,
  children,
  active,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`size-9 grid place-items-center rounded-lg transition-colors ${
        active
          ? 'bg-accent/15 text-accent ring-1 ring-accent/30'
          : 'text-muted hover:text-text hover:bg-raised'
      }`}
    >
      {children}
    </button>
  )
}
