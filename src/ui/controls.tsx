// 共享控件 —— 设置类界面的"设计系统".
//
// 背景: 之前每个组件都自己写 Tailwind class, 于是出现了
//   - 同一份设置在两个页面用两种布局 (LED 浮窗 vs 设置抽屉)
//   - 同一个抽屉里 Row 的两种写法 (有的滑块和数值上下分离)
//   - 分段控件有的填满容器、有的右侧留一大块空白
// 这些组件就是把那堆重复收敛掉的地方.
//
// 规格 (见 docs/ui-review-2026-11-01.md §8):
//   控件统一高度 h-7 (28px) / Row 标签列 w-[88px] /
//   Section 标题 13px semibold / 正文 13px muted / 辅助说明 12px subtle + 左侧 2px 竖线
//
// ★ 2026-11-01 (二轮):
//   - 删掉 <ArrowSwitch> (左右箭头切换) —— 它只显示"当前值", 另一个选项完全看不见,
//     用户不知道还能选什么. 换成 <OptionPicker>: 所有选项**同时摆在台面上**,
//     点一下就切, 当前项高亮.
//   - 所有图标换成 <Icon*> 线性 SVG (src/ui/icons.tsx), 不用 emoji.

import type { CSSProperties, ReactNode } from 'react'

/** 条件类名拼接 (没有装 clsx, 自己写一个够用). */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export interface ControlOption<T> {
  value: T
  label: ReactNode
  /** 鼠标悬停提示 */
  title?: string
  disabled?: boolean
  /** 选项图标 (现代 SVG 图标). */
  icon?: ReactNode
  /** 副标题 —— 一句话说清这个选项是干嘛的. */
  description?: ReactNode
}

/* ------------------------------------------------------------------ *
 * SegmentedControl —— 分段控件 (多选一, 选项少且都是短词)
 * ------------------------------------------------------------------ */

/**
 * 按钮等分填满容器 —— 不再像以前那样右侧空一大块.
 *
 * 容器用 inline-flex (而不是 flex): 宽度按内容收缩, 不会被父行挤窄导致
 * 「钢琴播放」被截成「钢琴排」. 要占满一行就传 className="w-full".
 */
export function SegmentedControl<T extends string | number | boolean>({
  value,
  options,
  onChange,
  disabled,
  fill = true,
  className,
}: {
  value: T
  options: readonly ControlOption<T>[]
  onChange: (v: T) => void
  disabled?: boolean
  /**
   * true  = 几个按钮等分填满容器 (设置抽屉里用, 一整行更整齐)
   * false = 按钮按内容宽度排开, 容器贴内容收缩 (练习条里用 —— 标签长, 不等分
   *         会被挤到「钢琴播放」被截成「钢琴排」)
   */
  fill?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      className={cx(
        'inline-flex h-7 max-w-full rounded-lg overflow-hidden border border-border bg-bg shadow-inner shadow-black/20',
        disabled && 'opacity-40 pointer-events-none',
        className,
      )}
    >
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          disabled={o.disabled}
          title={o.title}
          aria-pressed={value === o.value}
          className={cx(
            // min-w-max: 按钮不会被挤到比文字还窄 (否则「钢琴播放」会被截成「钢琴排」);
            // 容器够宽时 flex-1 又会让几个按钮等分填满.
            fill ? 'flex-1 min-w-0' : 'flex-none',
            'px-2 text-xs transition flex items-center justify-center gap-1.5 whitespace-nowrap',
            i > 0 && 'border-l border-border',
            value === o.value
              ? 'bg-accent/20 text-accent font-semibold shadow-[inset_0_0_0_1px_rgba(96,165,250,0.28)]'
              : 'text-muted hover:text-text hover:bg-raised',
            o.disabled && 'opacity-40 cursor-not-allowed',
          )}
        >
          {o.icon && (
            <span aria-hidden className="shrink-0 grid place-items-center">
              {o.icon}
            </span>
          )}
          <span className="block truncate max-w-full">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * OptionPicker —— 选项卡片 (所有选项同时可见)
 * ------------------------------------------------------------------ */

/**
 * 跟 <SegmentedControl> 的区别: **所有选项同时摆出来**.
 *
 * 之前「灯带后端 / 灯带模式」用的是左右箭头切换, 屏幕上永远只有当前值,
 * 另一个选项看不见 —— 用户根本不知道还能选什么 (2026-11-01 用户反馈).
 * 这里改成卡片: 每张卡 = 图标 + 名称 + 一句说明, 当前项高亮, 点一下就切.
 *
 * variant:
 *   'tile' —— 竖排卡片 (图标在上), 适合 2~3 个选项, 一眼扫过去最清楚
 *   'row'  —— 横排条目 (图标在左), 适合选项带长说明
 */
export function OptionPicker<T extends string | number | boolean>({
  value,
  options,
  onChange,
  disabled,
  variant = 'tile',
  cols,
  className,
}: {
  value: T
  options: readonly ControlOption<T>[]
  onChange: (v: T) => void
  disabled?: boolean
  variant?: 'tile' | 'row'
  /**
   * 卡片网格的列数 —— 不给就按默认 (tile 模式两个选项 → 2 列, 三个以上 → 1 列).
   * 三个 / 四个选项时想要 2 列就显式传 2.
   */
  cols?: 1 | 2 | 3
  className?: string
}) {
  const tile = variant === 'tile'
  const gridCols =
    cols != null
      ? `grid-cols-${cols}`
      : tile
        ? options.length === 2
          ? 'grid-cols-2'
          : 'grid-cols-1'
        : 'grid-cols-1'
  return (
    <div
      role="radiogroup"
      className={cx(
        'grid gap-1.5',
        gridCols,
        disabled && 'opacity-40 pointer-events-none',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'group relative flex rounded-lg border text-left transition-all duration-150',
              tile ? 'flex-col items-center gap-1 px-2 py-2 text-center' : 'items-center gap-2 px-2.5 py-2',
              active
                ? 'border-accent/70 bg-accent/10 shadow-[0_0_0_1px_rgba(96,165,250,0.18)]'
                : 'border-border bg-bg hover:border-borderStrong hover:bg-raised',
              o.disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            {o.icon && (
              <span
                aria-hidden
                className={cx(
                  'shrink-0 grid place-items-center rounded-md transition-colors',
                  tile ? 'size-8' : 'size-7',
                  active
                    ? 'bg-accent/15 text-accent'
                    : 'bg-raised text-muted group-hover:text-text',
                )}
              >
                {o.icon}
              </span>
            )}
            <span className={cx('min-w-0', tile ? 'w-full' : 'flex-1')}>
              <span
                className={cx(
                  'block truncate text-xs',
                  active ? 'font-semibold text-text' : 'font-medium text-muted group-hover:text-text',
                )}
              >
                {o.label}
              </span>
              {o.description && (
                <span
                  className={cx(
                    'mt-0.5 block text-[11px] leading-tight',
                    tile ? 'line-clamp-2' : 'truncate',
                    active ? 'text-accent/80' : 'text-subtle',
                  )}
                >
                  {o.description}
                </span>
              )}
            </span>
            {active && (
              <span
                aria-hidden
                className={cx(
                  'absolute rounded-full bg-accent',
                  tile ? 'top-1.5 right-1.5 size-1.5' : 'right-2.5 top-1/2 -translate-y-1/2 size-2',
                )}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Row —— 设置行 (标签列固定 + 内容区)
 * ------------------------------------------------------------------ */

/**
 * 标签列固定 88px, 内容区 flex 撑满 —— 滑块和它的数值并排, 不会上下分离.
 * hint 渲染在下一行, 12px subtle + 左侧 2px 竖线, 与内容区左对齐.
 *
 * wide=true 时标签换到上一行 —— 内容本身比较宽的控件 (比如选项卡片) 用它,
 * 否则 88px 标签列会把卡片挤成一条缝.
 *
 * narrow=true 时标签列收到 72px —— 窄栏 (比如抽屉里 LED 那栏的小分栏) 用,
 * 88px 标签会把滑块挤得只剩一根线.
 */
export function Row({
  label,
  hint,
  children,
  wide,
  narrow,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  /** 标签单独一行, 内容占满整行. */
  wide?: boolean
  /** 标签列收窄 (88px → 72px). */
  narrow?: boolean
  className?: string
}) {
  if (wide) {
    return (
      <div className={cx('flex flex-col gap-1.5 w-full', className)}>
        <span className="text-xs font-medium text-text">{label}</span>
        {children}
        {hint && <Hint indent={false}>{hint}</Hint>}
      </div>
    )
  }
  return (
    <div className={cx('flex flex-col gap-1.5 w-full', className)}>
      <div className="flex items-center gap-3 w-full">
        <span
          className={cx('text-xs text-muted shrink-0', narrow ? 'w-[72px]' : 'w-[88px]')}
        >
          {label}
        </span>
        <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
      </div>
      {hint && <Hint narrow={narrow}>{hint}</Hint>}
    </div>
  )
}

/**
 * 辅助说明 —— 12px subtle + 左侧 2px 竖线.
 *
 * indent=true 时缩进 100px, 与 Row 的内容列左对齐 (标签列 88px + 间距);
 * wide 布局 (标签独占一行) 用 indent=false, 说明跟内容一样贴左.
 */
export function Hint({
  children,
  className,
  indent = true,
  narrow = false,
}: {
  children: ReactNode
  className?: string
  indent?: boolean
  /** 跟 <Row narrow> 配套 —— 缩进量按窄标签列算. */
  narrow?: boolean
}) {
  return (
    <p
      className={cx(
        'text-xs text-subtle leading-relaxed border-l-2 border-border/70 pl-2',
        indent && (narrow ? 'ml-[84px]' : 'ml-[100px]'),
        className,
      )}
    >
      {children}
    </p>
  )
}

/* ------------------------------------------------------------------ *
 * Switch —— 深色开关 (替掉原生 checkbox)
 * ------------------------------------------------------------------ */

const SWITCH_SIZE = {
  sm: { track: 'h-4 w-7', knob: 'size-3', off: 1, on: 14 },
  md: { track: 'h-5 w-9', knob: 'size-3.5', off: 2, on: 20 },
} as const

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  labelClassName,
  title,
  size = 'md',
  className,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: ReactNode
  labelClassName?: string
  title?: string
  size?: keyof typeof SWITCH_SIZE
  className?: string
}) {
  const s = SWITCH_SIZE[size]
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cx(
        'flex h-7 items-center gap-2 select-none text-left',
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        className,
      )}
    >
      <span
        className={cx(
          'relative inline-flex items-center shrink-0 rounded-full border transition-colors',
          s.track,
          checked ? 'bg-accent border-accent' : 'bg-raised border-borderStrong',
        )}
      >
        <span
          className={cx(
            'absolute top-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-all',
            s.knob,
          )}
          style={{ left: checked ? s.on : s.off }}
        />
      </span>
      {label !== undefined && (
        <span className={cx('text-xs text-muted', labelClassName)}>{label}</span>
      )}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * Section —— 设置分组
 * ------------------------------------------------------------------ */

/**
 * 分组标题 + 右侧动作槽位 (开关型设置统一"标题 + 右侧开关").
 * 相邻分组之间自动加一条分隔线 (first: 除外).
 */
export function Section({
  title,
  icon,
  action,
  children,
  className,
}: {
  title: ReactNode
  /** 分组图标 (现代 SVG 图标). */
  icon?: ReactNode
  action?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section
      className={cx(
        'flex flex-col gap-2.5 border-t border-border/50 pt-4 first:border-t-0 first:pt-0',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 min-h-[26px]">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-text leading-tight">
          {icon && (
            <span aria-hidden className="text-muted grid place-items-center">
              {icon}
            </span>
          )}
          {title}
        </h3>
        {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Slider —— 带"已填充段"的滑块
 * ------------------------------------------------------------------ */

/** 轨道左半段用 accent 色填充, 用户一眼能看出当前值在量程的哪个位置. */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  disabled,
  className,
  title,
  ariaLabel,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  disabled?: boolean
  className?: string
  title?: string
  ariaLabel?: string
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ '--fill': `${pct}%` } as CSSProperties}
      className={cx(
        'accent-accent cursor-pointer disabled:cursor-not-allowed',
        className,
      )}
    />
  )
}

/* ------------------------------------------------------------------ *
 * SecondaryBtn —— 次要按钮 (描边, 不抢主按钮的戏)
 * ------------------------------------------------------------------ */

/** 2026-11-06 从 SettingsDrawer 挪到这里 —— LED 面板 (浮窗/抽屉) 也要用. */
export function SecondaryBtn({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 h-7 px-2 rounded-lg text-xs border border-border bg-bg text-text hover:border-muted hover:bg-raised disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  )
}
