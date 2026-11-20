// 倒计时覆盖层: 显示 3 / 2 / 1 / GO 然后淡出
// 从 store.countdown 读

import { useStore } from '../store'

export function CountdownOverlay() {
  const countdown = useStore((s) => s.countdown)
  if (countdown === null) return null

  const labels: Record<number, string> = { 3: '3', 2: '2', 1: '1', 0: 'GO!' }
  const tone = countdown === 0 ? 'text-hit scale-110' : 'text-accent'

  return (
    <div className="absolute inset-0 grid place-items-center z-30 pointer-events-none">
      <div
        key={countdown}
        className={`text-[180px] font-extrabold tabular-nums ${tone} drop-shadow-[0_4px_30px_rgba(96,165,250,0.4)] anim-countdown`}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {labels[countdown] ?? ''}
      </div>
    </div>
  )
}

