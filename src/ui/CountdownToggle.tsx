// 倒计时开关: 勾上 = 播放时走 3-2-1-GO
// 倒计时进行中时直接显示当前数字, 跟 CountdownOverlay 同步 — 不用抬头看大字幕也能瞄到

import { useStore } from '../store'
import { Switch } from './controls'

const COUNTDOWN_LABEL: Record<number, string> = { 3: '3', 2: '2', 1: '1', 0: 'GO!' }

export function CountdownToggle() {
  const useCountdown = useStore((s) => s.useCountdown)
  const setUseCountdown = useStore((s) => s.setUseCountdown)
  const countdown = useStore((s) => s.countdown)
  const running = countdown !== null && COUNTDOWN_LABEL[countdown] !== undefined

  return (
    <Switch
      size="sm"
      checked={useCountdown}
      onChange={setUseCountdown}
      labelClassName="text-[13px]"
      title="播放时先走 3-2-1-GO 倒计时, 给你准备时间"
      label={
        <span
          className={
            running
              ? 'tabular-nums font-semibold text-accent'
              : 'text-muted'
          }
        >
          {running ? COUNTDOWN_LABEL[countdown!] : '倒计时'}
        </span>
      }
    />
  )
}
