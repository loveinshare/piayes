// 播放倍速: 1× / 1.25× / 3/4× / 1/2× / 1/4× 五档下拉
// 练琴最常用的就这几档, 滑块太精细用不上, 还占地方.
//
// ★ 2026-11-06: 加了 1.25× (用户要求) —— 1× 太快、3/4× 太慢时用.

import { useStore } from '../store'

const SPEED_OPTIONS: { value: number; label: string }[] = [
  { value: 1.0,   label: '1×'     },
  { value: 1.25,  label: '1.25×'  },
  { value: 0.75,  label: '3/4×'   },
  { value: 0.5,   label: '1/2×'   },
  { value: 0.25,  label: '1/4×'   },
]

export function SpeedControl() {
  const speed = useStore((s) => s.speed)
  const setSpeed = useStore((s) => s.setSpeed)

  return (
    <label className="flex items-center gap-1.5 h-7 select-none" title="播放速度">
      <span className="text-xs text-muted" aria-hidden>
        ▶
      </span>
      <select
        value={SPEED_OPTIONS.some((o) => o.value === speed) ? speed : 1.0}
        onChange={(e) => setSpeed(Number(e.target.value))}
        className="pl-2 pr-1 h-7 text-xs rounded border border-border bg-bg text-text focus:outline-none focus:border-accent cursor-pointer w-[72px]"
      >
        {SPEED_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}
