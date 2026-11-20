// 跟弹容差 (ms): 「按早/按晚多少还算命中」的判定窗口.
// 两种口径 (见 store.toleranceCustom):
//   没填过 → 按乐曲速度自动缩放 (spec P1-5, 120bpm → 250ms)
//   填过   → 填的那个数就是窗口本身 (100-2000ms)
// ★ 2026-11-06: 上限 500 → 2000 (用户要求「容差最高可以到 2000ms」);
//   口径也改了 —— 以前这个数只是「上限」, 超过 300 就没意义了 (曲速缩放夹着),
//   用户明确要求它得能真的放宽, 所以「填过」就直接生效.
// 位置: 主区顶部, 跟 WaitToggle / HandSelector 同级 (不藏到抽屉里 — 用户调 wait 时大概率也想调容差).

import { useStore } from '../store'

export function ToleranceInput() {
  const toleranceMs = useStore((s) => s.toleranceMs)
  const toleranceCustom = useStore((s) => s.toleranceCustom)
  const setToleranceMsPersistent = useStore((s) => s.setToleranceMsPersistent)

  return (
    <label
      className="flex items-center gap-1.5 h-7 select-none"
      title={
        toleranceCustom
          ? `判定窗口: 填了多少毫秒就算命中 (现在 ${toleranceMs}ms). 越小越严, 越大越宽松. 范围 100-2000ms.`
          : '判定窗口: 没填过 = 按乐曲速度自动缩放 (120bpm 下约 250ms). 填一个数就按那个数算 (100-2000ms).'
      }
    >
      <span className="text-[13px] text-muted">容差</span>
      <input
        type="number"
        min={100}
        max={2000}
        step={50}
        value={toleranceMs}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) setToleranceMsPersistent(n)
        }}
        className="w-16 h-7 px-2 text-[13px] rounded border border-border bg-bg text-text tabular-nums focus:outline-none focus:border-accent"
      />
      <span className="text-xs text-muted">ms</span>
    </label>
  )
}
