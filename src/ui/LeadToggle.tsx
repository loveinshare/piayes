// 抢先模式开关 — 紧跟在 Wait 开关后面
//
// 抢先 = Wait + 「弹对了才推进」:
//  - 播放头**冻**在现在该弹的那一组音上 (跟 Wait 一样);
//  - 弹对了才解冻, 按 1× 走到下一个待弹组再冻上;
//  - 提前按不报错, 灯一直亮到弹对为止.
//
// 抢先依赖 Wait: Wait 关掉就没有「播放头钉在要弹的音上」可言 → 开关变灰.
// (勾选状态本身保留 —— 再打开 Wait 就自动恢复抢先.)

import { useStore, effectiveLead } from '../store'
import { Switch } from './controls'

export function LeadToggle() {
  const hand = useStore((s) => s.hand)
  const wait = useStore((s) => s.wait)
  const leadNext = useStore((s) => s.leadNext)
  const setLeadUserOverride = useStore((s) => s.setLeadUserOverride)
  const isPractice = hand !== 'playback'
  const on = effectiveLead(hand, wait, leadNext)
  // Wait 关着 → 抢先没法生效 (没有冻结就没有「钉在要弹的音上」)
  const disabled = !isPractice || !wait

  return (
    <Switch
      size="sm"
      checked={on}
      onChange={setLeadUserOverride}
      disabled={disabled}
      labelClassName="text-[13px]"
      title={
        !isPractice
          ? '钢琴播放模式没有跟弹'
          : !wait
            ? '要先打开 Wait —— 抢先靠 Wait 的冻结把播放头钉在你要弹的音上'
            : on
              ? '已开: 播放头冻在现在该弹的那一组音上\n\n弹对了才解冻往前走; 提前按不报错, 灯一直亮到弹对'
              : '关掉了: 灯带显示现在该弹的音, 弹对后要等时钟走到下一个音'
      }
      label={
        <span className={on ? 'text-text font-semibold' : 'text-muted'}>抢先</span>
      }
    />
  )
}
