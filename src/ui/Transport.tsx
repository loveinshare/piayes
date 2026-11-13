// 底部播放控制: 重置 / 播放暂停 / 进度条(可点击跳转 / 显示当前小节)
// 速度滑块挪到了 SettingsDrawer

import { useState } from 'react'
import { useStore } from '../store'
import { IconPause, IconPlay, IconRewind } from './icons'

interface Props {
  onPlay: () => void
  onPause: () => void
  onRestart: () => void
  onSeek: (t: number) => void
  duration: number
  currentTime: number
}

export function Transport({ onPlay, onPause, onRestart, onSeek, duration, currentTime }: Props) {
  const song = useStore((s) => s.song)
  const isPlaying = useStore((s) => s.isPlaying)
  const loopRange = useStore((s) => s.loopRange)

  const total = duration
  // 拖动/按方向键时, 播放头的 currentTime 是 10Hz 节流更新的 —— 慢半拍.
  // 拖动期间用本地值顶着, 松手后再交还给播放头 (不然滑块会被弹回去).
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? currentTime
  const pct = total > 0 ? (shown / total) * 100 : 0

  return (
    <div className="flex flex-col gap-2">
      {/* 进度条 + 跳转 */}
      <div className="flex items-center gap-3">
        <button
          onClick={onRestart}
          disabled={!song}
          className="size-9 grid place-items-center rounded-lg text-muted hover:text-text hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="回到开头 (R)"
          aria-label="回到开头"
        >
          <IconRewind size={16} />
        </button>
        <button
          onClick={() => (isPlaying ? onPause() : onPlay())}
          disabled={!song}
          className="size-10 grid place-items-center rounded-full bg-accent text-bg font-semibold transition hover:scale-105 active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
          title={isPlaying ? '暂停 (Space)' : '播放 (Space)'}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? (
            <IconPause size={15} />
          ) : (
            <IconPlay size={15} />
          )}
        </button>
        <span className="text-xs text-muted tabular-nums w-12 text-right">{formatTime(currentTime)}</span>
        {/* 进度条 = 一个**看不见的原生 range** 盖在画的条上面.
            原来是个 div + onClick: 只能点, 不能拖, 键盘用不了, 读屏也读不出.
            现在底下那层 div 只负责画样子 (loop 区间 / 已播 / 当前点),
            交互 (点击 / 拖拽 / 方向键 / 触摸) 全交给原生 range. */}
        <div className="relative flex-1 h-6 flex items-center">
          <input
            type="range"
            className="peer absolute inset-0 w-full !h-6 opacity-0 cursor-pointer disabled:cursor-not-allowed"
            min={0}
            max={total > 0 ? total : 1}
            step={0.01}
            value={Math.min(Math.max(shown, 0), total > 0 ? total : 1)}
            disabled={!song || total <= 0}
            onChange={(e) => {
              const v = Number(e.target.value)
              setDrag(v)
              onSeek(v)
            }}
            onKeyDown={(e) => {
              // 方向键: 原生 range 一格才 0.01s, 按了跟没按一样 —— 自己接管, 一次 5 秒
              if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                e.preventDefault()
                const v = Math.min(total, shown + 5)
                setDrag(v)
                onSeek(v)
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                e.preventDefault()
                const v = Math.max(0, shown - 5)
                setDrag(v)
                onSeek(v)
              }
            }}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
            onKeyUp={() => setDrag(null)}
            onBlur={() => setDrag(null)}
            aria-label="播放进度"
            title="点击/拖动跳转, 方向键微调"
          />
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-2.5 bg-raised rounded-full border border-border overflow-hidden peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60">
            {/* Loop range 背景 */}
            {loopRange && total > 0 && (
              <div
                className="absolute inset-y-0 bg-accent/15"
                style={{
                  left: `${(loopRange[0] / total) * 100}%`,
                  width: `${((loopRange[1] - loopRange[0]) / total) * 100}%`,
                }}
              />
            )}
            {/* 已播放 */}
            <div
              className="absolute inset-y-0 left-0 bg-accent/70 rounded-full transition-[width] duration-75"
              style={{ width: `${pct}%` }}
            />
            {/* 当前点 */}
            <div
              className="absolute top-1/2 size-3.5 -mt-1.75 -ml-1.75 rounded-full bg-accent border-2 border-bg shadow-md transition-[left] duration-75"
              style={{ left: `${pct}%` }}
            />
          </div>
        </div>
        <span className="text-xs text-muted tabular-nums w-12">{formatTime(total)}</span>
      </div>
    </div>
  )
}

function formatTime(s: number): string {
  if (!s || !isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}
