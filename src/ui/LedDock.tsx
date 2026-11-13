// LED 入口 + 设置面板
//
// 两种摆法:
//   inline  —— 放进 TopBar 右上角图标排, 跟统计/设置/MIDI 对齐
//   floating—— 全屏时 (顶栏整排都隐藏) 浮在画面右上角
// 面板内容: 开关/后端/模式/亮度/跟随源/校准/4 色调色板.
//
// ★ 2026-11-10: 蓝牙那条路删了 (ESP32 现在跟树莓派一样走 WebSocket).
//   设备选择在**这个浮窗**里 —— 底栏不再有「蓝牙」按钮.
//
// ★ 2026-11-01: 设置内容抽到 <LedSettings />, 跟进阶设置抽屉共用同一份 ——
//   之前两边各写一套, 同一份设置在两个地方长得不一样.

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { LedSettings } from './LedSettings'
import { ledDeviceLabel } from '../led/transport/ledConfig'
import { IconBulb, IconClose } from './icons'

export function LedDock({ variant = 'floating' }: { variant?: 'inline' | 'floating' }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const ledEnabled = useStore((s) => s.ledEnabled)
  const ledConnected = useStore((s) => s.ledConnected)
  const ledError = useStore((s) => s.ledError)
  const ledActiveDevice = useStore((s) => s.ledActiveDevice)
  const ledHost = useStore((s) => s.ledHost)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
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

  const inline = variant === 'inline'

  return (
    <div
      ref={wrapRef}
      className={inline ? 'relative' : 'absolute top-2 right-[52px] z-30'}
    >
      {/* ★ 2026-11-13: 按钮**一直挂载** (以前 open 时把按钮整个换掉 ——
          面板一弹出来, 右上角那个灯泡图标就没了, 看着像按钮坏了).
          现在按钮常驻, 面板作为浮层盖在它下面, 点按钮开/关. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          inline
            ? 'size-9 grid place-items-center rounded-lg transition-colors text-muted hover:text-text hover:bg-raised'
            : 'size-9 grid place-items-center rounded-lg bg-panel/90 border border-border text-muted hover:text-text hover:border-accent backdrop-blur transition-colors'
        }
        title={
          ledConnected
            ? `灯带已连接 (${ledDeviceLabel(ledActiveDevice, ledHost)})`
            : ledEnabled
              ? '灯带没连上 —— 点这里看原因'
              : 'LED 灯带设置'
        }
        aria-label="LED 灯带设置"
        aria-expanded={open}
      >
        <span className="relative inline-flex items-center justify-center">
          <span
            className={`absolute -top-0.5 -right-0.5 inline-block size-1.5 rounded-full ring-2 ring-panel ${
              ledConnected ? 'bg-hit' : ledEnabled ? 'bg-miss animate-pulse' : 'bg-muted'
            }`}
          />
          <IconBulb size={17} />
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-30 bg-panel/95 backdrop-blur border border-border rounded-xl shadow-2xl shadow-black/40 p-3.5 w-[320px]">
          <div className="flex items-center justify-between mb-3">
            <span className="font-semibold text-text text-sm flex items-center gap-1.5">
              <span className="text-accent" aria-hidden>
                <IconBulb size={15} />
              </span>
              LED 灯带
            </span>
            <div className="flex items-center gap-2">
              <span
                className={`text-[11px] px-1.5 py-0.5 rounded-full border ${
                  ledConnected
                    ? 'bg-hit/15 text-hit border-hit/30'
                    : ledEnabled
                      ? 'bg-miss/15 text-miss border-miss/30'
                      : 'bg-bg text-muted border-border'
                }`}
              >
                {ledConnected ? '已连接' : ledEnabled ? '连不上' : '未启用'}
              </span>
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

          {/* 状态提示 —— 连不上就说原因; 连上了说连的是哪台 */}
          {ledError && (
            <p className="text-xs text-miss/90 leading-snug mb-2">{ledError}</p>
          )}
          {ledConnected && (
            <p className="text-xs text-hit/80 mb-2">
              已连接 {ledDeviceLabel(ledActiveDevice, ledHost)}
            </p>
          )}

          <LedSettings />
        </div>
      )}
    </div>
  )
}
