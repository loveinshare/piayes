// 首页的两个勾选框: 左手 / 右手的灯分别开关.
//
// 关掉一只手 → 那只手**当前亮着的**灯立刻全灭 (静默: 不弹提示, 不报错),
// 之后这只手的音也不再点亮; 点回来 → 还按着的键重新亮起来.
//
// 放在练习控制条上 (常驻可见), 不藏进设置抽屉 —— 练琴时最常用的就是
// 「左手别亮, 我只看右手」这种临时切换.

import { useStore } from '../store'
import { Switch } from './controls'

export function LedHandToggles() {
  const left = useStore((s) => s.ledHandLeft)
  const right = useStore((s) => s.ledHandRight)
  const setLeft = useStore((s) => s.setLedHandLeft)
  const setRight = useStore((s) => s.setLedHandRight)
  const ledEnabled = useStore((s) => s.ledEnabled)

  // ★ 这两个开关**不是**灯带总开关 —— 总开关在顶栏灯泡图标里的
  //   「启用 LED 灯带」. 原来这里只写「LED」+ 两个蓝开关, 一眼看着像
  //   「灯带开着」, 其实灯带可能根本没开. 所以:
  //   1) 标签改成「手别灯」—— 说清管的是左右手怎么分;
  //   2) 旁边挂一个总开关状态徽章, 让人一眼看出灯带到底开没开.
  const masterHint = ledEnabled
    ? '灯带已开 —— 这两个开关分别控制左手 / 右手的灯.'
    : '灯带总开关是**关**的 (顶栏灯泡图标 → 「启用 LED 灯带」).\n这两个开关只管左右手怎么分, 总开关开了才生效.'

  return (
    <div className="flex items-center gap-3 h-7">
      <span className="text-[13px] text-muted shrink-0">手别灯</span>
      <span
        className={
          ledEnabled
            ? 'text-[11px] leading-none shrink-0 rounded px-1 py-0.5 text-good bg-good/15'
            : 'text-[11px] leading-none shrink-0 rounded px-1 py-0.5 text-muted bg-raised'
        }
        title={masterHint}
      >
        {ledEnabled ? '已开' : '未开'}
      </span>
      <Switch
        size="sm"
        checked={left}
        onChange={setLeft}
        labelClassName="text-[13px]"
        title={
          `${masterHint}\n\n` +
          (left
            ? '左手这半边的灯亮着\n点掉 → 左手当前亮着的灯立刻全灭, 之后左手不点灯'
            : '左手这半边的灯灭了\n点回来 → 左手还按着的键重新亮起来')
        }
        label="左手"
      />
      <Switch
        size="sm"
        checked={right}
        onChange={setRight}
        labelClassName="text-[13px]"
        title={
          `${masterHint}\n\n` +
          (right
            ? '右手这半边的灯亮着\n点掉 → 右手当前亮着的灯立刻全灭, 之后右手不点灯'
            : '右手这半边的灯灭了\n点回来 → 右手还按着的键重新亮起来')
        }
        label="右手"
      />
    </div>
  )
}
