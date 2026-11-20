// LED 点阵屏入口 + 设置浮窗
//
// 跟灯带的 <LedDock /> 一个套路, 但是**另一台设备**:
//   灯带   176 颗 WS2812, 端口 8080
//   点阵屏 128x64 HUB75 面板, 端口 8081
// 所以图标 / 状态 / 面板内容都是独立的一份, 互不影响.
//
// 摆在 TopBar 右上角图标排里 (跟灯带那个相邻).
//
// ★ 2026-11-14: 全屏不再隐藏顶栏 (用户: 「全屏只是页面全屏, 内容不需要隐藏」),
//   所以「全屏时浮在画面右上角」那种摆法删了 —— 只有顶栏这一种.
//
// ★ 2026-11-13: 用户要求「把 LED 屏幕从进阶设置里提出来, 放到首页右上角」——
//   原来是塞在设置抽屉最后一栏, 找起来太深; 现在跟灯带一样常驻右上角.

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { LedScreenSettings, LedScreenStatus } from './LedScreenSettings'
import { IconClose, IconGrid } from './icons'

export function LedScreenDock() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const enabled = useStore((s) => s.ledScreenEnabled)
  const connected = useStore((s) => s.ledScreenConnected)
  const error = useStore((s) => s.ledScreenError)
  const screens = useStore((s) => s.ledScreenScreens)

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      {/* ★ 2026-11-13: 按钮**一直挂载** (以前是 open 时把按钮整个换掉 ——
          面板一弹出来, 右上角那个格子图标就没了, 看着像按钮坏了).
          现在按钮常驻, 面板作为浮层盖在它下面, 点按钮开/关. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="size-9 grid place-items-center rounded-lg transition-colors text-muted hover:text-text hover:bg-raised"
        title={
          connected
            ? `点阵屏已连接 (${screens.join('/')} 号屏)`
            : enabled
              ? '点阵屏没连上 —— 点这里看原因'
              : 'LED 点阵屏设置'
        }
        aria-label="LED 点阵屏设置"
        aria-expanded={open}
      >
        <span className="relative inline-flex items-center justify-center">
          <span
            className={`absolute -top-0.5 -right-0.5 inline-block size-1.5 rounded-full ring-2 ring-panel ${
              connected ? 'bg-hit' : enabled ? 'bg-miss animate-pulse' : 'bg-muted'
            }`}
          />
          <IconGrid size={17} />
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 bg-panel/95 backdrop-blur border border-border rounded-xl shadow-2xl shadow-black/40 p-3.5 w-[320px] max-h-[75vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-text text-sm flex items-center gap-1.5">
              <span className="text-accent" aria-hidden>
                <IconGrid size={15} />
              </span>
              LED 点阵屏
            </span>
            <div className="flex items-center gap-2">
              {/* 状态牌跟设置栏共用一份 (LedScreenStatus), 别两处各写一套文案 */}
              <LedScreenStatus />
              <button
                onClick={() => setOpen(false)}
                className="size-6 grid place-items-center rounded-md text-muted hover:text-text hover:bg-raised transition-colors"
                title="关闭 (Esc)"
                aria-label="关闭"
              >
                <IconClose size={13} />
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-miss/90 leading-snug mb-2">{error}</p>}

          <LedScreenSettings compact />
        </div>
      )}
    </div>
  )
}
