// 主音量 —— 右下角可收起的**竖向**面板
//
// ★ 2026-11-06 (用户要求): 「音量挪到右下角, 并且是可收起的那种形式,
//   点击才有音量设置, 竖向的」.
//
// 之前它占着顶部练习条的一格 (横条里塞横滑块), 挤得慌, 而且练琴时根本不看.
// 现在收成右下角一个圆按钮 —— 点开才出现竖滑块, 再点收起.
//
// 竖滑块的做法: 拿横着的 <input type=range> 整体 rotate(-90deg) ——
//   转完「左端 (最小值)」跑到了下面, 所以已填充段是「从下往上」, 正是竖滑块该有的样子.
//   (writing-mode 那套各浏览器支持不齐, 旋转最稳.)

import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { Slider } from './controls'
import { IconVolume } from './icons'

export function VolumePanel() {
  const [open, setOpen] = useState(false)
  const volume = useStore((s) => s.volume)
  const setVolume = useStore((s) => s.setVolume)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点外面 / 按 Esc → 收起
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

  const pct = Math.round(volume * 100)
  const muted = pct === 0

  return (
    // ★ bottom-[122px]: 画布底部 110px 是**画出来的键盘** (KEYBOARD_HEIGHT),
    //   按钮原来贴在 bottom-3 → 正落在琴键上, 弹出来还挡键. 抬到键盘上方.
    <div
      ref={wrapRef}
      className="absolute bottom-[122px] right-3 z-20 flex flex-col items-end gap-2 select-none"
    >
      {open && (
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-panel/95 px-3 py-2.5 backdrop-blur shadow-xl shadow-black/40 anim-fade-in">
          <span className="text-[11px] text-muted tabular-nums leading-none">{pct}%</span>
          {/* 竖滑块: 容器 32×128, 滑块本体 112 宽横放, 转 -90° */}
          <div className="relative h-32 w-8 grid place-items-center">
            <Slider
              value={volume}
              min={0}
              max={1}
              step={0.01}
              onChange={setVolume}
              ariaLabel="主音量"
              title="主音量 (合成器 + MIDI Out 力度)"
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-28 rotate-[-90deg]"
            />
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={
          open
            ? 'size-9 grid place-items-center rounded-full bg-panel/95 border border-accent text-accent backdrop-blur shadow-lg shadow-black/40 transition-colors'
            : 'size-9 grid place-items-center rounded-full bg-panel/80 border border-border text-muted hover:text-text hover:border-accent backdrop-blur transition-colors'
        }
        title={open ? '收起音量' : `音量 ${pct}% (点击展开)`}
        aria-label={open ? '收起音量' : '展开音量'}
        aria-expanded={open}
      >
        <span aria-hidden>
          <IconVolume size={16} />
        </span>
      </button>
      {/* 静音时给个红点, 免得用户以为音量还在 */}
      {!open && muted && (
        <span className="absolute right-0 bottom-0 size-2 rounded-full bg-miss ring-2 ring-panel" aria-hidden />
      )}
    </div>
  )
}
