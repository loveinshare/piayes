// Wait 模式开关 — 横向紧凑, 常驻主区顶部
//
// 冻结是二值的 (required 是否空), 所以不再有 waitMs 滑块.
// toggle 直接对应 store.wait: practice 模式勾上 = 冻结; 不勾 = 不冻结.
// playback 模式 toggle 强制 disabled (跟弹无意义).

import { useStore, effectiveWait } from '../store'
import { Switch } from './controls'
import { IconAlert } from './icons'

export function WaitToggle() {
  const hand = useStore((s) => s.hand)
  const wait = useStore((s) => s.wait)
  const setWaitUserOverride = useStore((s) => s.setWaitUserOverride)
  const isPractice = hand !== 'playback'
  const on = effectiveWait(hand, wait)

  // practice 模式 + 关掉 → 红点提示「关了就不冻结」, 让用户立刻看到
  const offInPractice = isPractice && !on

  return (
    <Switch
      size="sm"
      checked={on}
      onChange={setWaitUserOverride}
      disabled={!isPractice}
      labelClassName="text-[13px]"
      title={
        !isPractice
          ? '钢琴播放模式不冻结'
          : on
            ? '已开: 文件在你弹对前停下\n\n快捷键: ← → 跳到上/下一个音 / Shift+← → 只跳右手 / ↑ ↓ 跳小节 / Backspace 强制跳过卡住的音'
            : '关掉了: 时间一直前进, 不会冻结等你弹\n\n勾上才能「等你弹对再走」'
      }
      label={
        <span
          className={
            offInPractice
              ? 'text-miss font-semibold'
              : on
                ? 'text-text font-semibold'
                : 'text-muted'
          }
        >
          Wait
          {offInPractice && (
            <span className="ml-1 inline-flex text-xs" title="关掉了 — 时间不会冻结等你弹">
              <IconAlert size={12} />
            </span>
          )}
        </span>
      }
    />
  )
}
