// 4 模式选择: 播放 / 双手 / 右手 / 左手
// 放在主区上方 (跟 Wait 模式相邻), 始终可见 — 不藏到设置抽屉里
//
// ★ 2026-11-06 (用户要求):
//   - 去掉前面的「手别」两个字 —— 四个按钮自己就说明了, 前面再挂个标签是废话.
//   - 「钢琴播放」→「播放」 —— 四格里就它带「钢琴」, 挤.

import type { ReactNode } from 'react'
import { useStore, type PracticeHand } from '../store'
import { SegmentedControl } from './controls'
import { IconAlert, IconArrowLeft, IconArrowRight, IconBothHands, IconInfo, IconPiano } from './icons'

const OPTIONS: {
  value: PracticeHand
  label: string
  short: string
  icon: ReactNode
  description: string
}[] = [
  {
    value: 'playback',
    label: '播放',
    short: '播放',
    icon: <IconPiano size={14} />,
    description: '电钢自动弹整首 (MIDI Out)',
  },
  {
    value: 'both',
    label: '双手',
    short: '双手',
    icon: <IconBothHands size={14} />,
    description: '双手都自己弹',
  },
  {
    value: 'right',
    label: '右手',
    short: '右手',
    icon: <IconArrowRight size={14} />,
    description: '右手自己弹, 左手 → 电钢',
  },
  {
    value: 'left',
    label: '左手',
    short: '左手',
    icon: <IconArrowLeft size={14} />,
    description: '左手自己弹, 右手 → 电钢',
  },
]

export function HandSelector() {
  const hand = useStore((s) => s.hand)
  const song = useStore((s) => s.song)
  // note.hand 是就地重算的 (song 引用不变) —— 靠这个版本号触发重渲染
  useStore((s) => s.handInferVersion)
  const setHand = useStore((s) => s.setHand)
  const setWaitUserOverride = useStore((s) => s.setWaitUserOverride)
  const midiOutputId = useStore((s) => s.midiOutputId)

  // 手别是猜的? (spec P2-6) —— 单 track 曲子的声部聚类只是启发式,
  // 猜错时用户该知道, 并且能改 (设置 → 按音高切分).
  const infer = song?.handInfer
  const inferred = infer?.confidence === 'low' || infer?.confidence === 'medium'

  // 切到 right/left 模式时, 如果 wait=false, 自动开 wait.
  // 原因: "跟弹" 的本意就是 "等你弹对再走". 不冻结就不叫跟弹, 用户大概率会困惑.
  // 用户主动关 wait = "体验练" = 切到 both 模式时他可能更想要这个行为.
  // 简单起见: 切到 practice 任一模式 (both/right/left) 时, 如果 wait=false, 自动开.
  const onPick = (v: PracticeHand) => {
    setHand(v)
    if (v !== 'playback') {
      const cur = useStore.getState().wait
      if (!cur) setWaitUserOverride(true)
    }
  }

  return (
    <div className="flex items-center gap-2 h-7 shrink-0">
      <SegmentedControl
        value={hand}
        options={OPTIONS.map((o) => ({
          value: o.value,
          title: o.value === 'playback' && !midiOutputId ? `${o.description} — 需先连接电钢` : o.description,
          label: (
            <span className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden className="grid place-items-center">
                {o.icon}
              </span>
              <span className="hidden sm:inline">{o.label}</span>
              <span className="sm:hidden">{o.short}</span>
            </span>
          ),
        }))}
        onChange={onPick}
        fill={false}
        className="shrink-0"
      />
      {hand === 'playback' && !midiOutputId && (
        <span
          className="text-xs text-miss whitespace-nowrap flex items-center gap-1"
          title="提示: 先连接电钢才能演奏"
        >
          <IconAlert size={12} />
          需连接电钢
        </span>
      )}
      {/* 「手别为推断」只是提示 (设置里也能看) —— 窄屏 (lg 以下) 藏起来,
          留着会把练习条撑到换行 */}
      {inferred && (
        <span
          className="text-xs text-muted whitespace-nowrap hidden lg:flex items-center gap-1"
          title={
            infer?.confidence === 'low'
              ? '这首曲子的左右手是按声部聚类猜出来的, 可能不准. 需要纠正的话: 设置 → 手别判定 → 按音高切分'
              : '这首曲子的左右手是推断的. 需要纠正的话: 设置 → 手别判定 → 按音高切分'
          }
        >
          <IconInfo size={12} />
          手别为推断
        </span>
      )}
    </div>
  )
}
