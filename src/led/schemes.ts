// LED 配色方案 —— 两套预设 (C 耐看 / D 快速) + 亮度阶梯计算.
//
// ── 为什么有「预告行」的第二套颜色 ───────────────────────────────────────
// 灯带分两层:
//   - 主灯带 (第一条)  = **当前**该弹的音 → 用「当前行」的高饱和纯色
//   - 上灯带 (第二条)  = 左右手**接下来**的音 → 用「预告行」的降饱和色
//
// 红/橙同属暖色连续段, 快速演奏时几乎糊在一起; 蓝/亮蓝虽然同色相, 但冷色对
// 明度差敏感, 所以更容易分.
//
// 方案 C (默认) 的 8 个色是**用户自己在灯带上调出来的** (2026-11-02):
//   主灯带: 左手 正蓝 #1E1EFF / 品蓝 #4169E1, 右手 纯红 #FF0000 / 深红 #C8102E
//   上灯带: 左手 亮蓝 #006AFF / 纯绿 #11FF00, 右手 纯红 #FF0000 / 玫红 #FF0033
// 两排的层次不再靠「降饱和」, 而是靠**亮度** (上灯带 = 主灯带 × 比例 × 阶梯).
// 方案 D 保留高分离度 (浅品红 / 冰青), 给快板和复杂灯光环境用.
//
// 预告行整体做「轻微色彩漂移 + 降饱和」: 第一排纯、第二排柔, 两排不会混.
//
// ── 亮度阶梯 ─────────────────────────────────────────────────────────────
// 预告行里第 1 个音最亮、第 N 个最暗, 用户只设**最高**和**最低**两个百分比,
// 中间几个按**等比数列**插值 (N=3 时中间那个 = √(最高×最低)).
//
// 亮度变化只动 HSV 的 V —— 不动 HSL 的 L, 否则色相会漂.

/** 一行 (当前音 / 预告音) 的 4 色 —— 左手/右手 × 白键/黑键. */
export interface LedPalette {
  leftWhite: [number, number, number]
  leftBlack: [number, number, number]
  rightWhite: [number, number, number]
  rightBlack: [number, number, number]
}

/** 一个配色方案 = 当前行 + 预告行 + 呼吸幅度. */
export interface LedScheme {
  id: LedSchemeId
  label: string
  description: string
  title: string
  current: LedPalette
  upcoming: LedPalette
  /** 当前音「呼吸」幅度 (0..1) —— 亮度按 ±amp 正弦起伏. */
  pulse: number
  /** 快速曲子 (>= 阈值 BPM) 用这个方案. */
  fast: boolean
}

export type LedSchemeId = 'c' | 'd' | 'auto' | 'custom'

/** #RRGGBB → [r,g,b] */
export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v =
    h.length === 3
      ? h.split('').map((c) => parseInt(c + c, 16))
      : [
          parseInt(h.substring(0, 2), 16),
          parseInt(h.substring(2, 4), 16),
          parseInt(h.substring(4, 6), 16),
        ]
  return [v[0] || 0, v[1] || 0, v[2] || 0]
}

/**
 * 方案 C —— 默认 (耐看).
 *
 * 8 个色由用户实机调色后定稿 —— 见文件头的说明.
 */
export const SCHEME_C: LedScheme = {
  id: 'c',
  label: '方案 C',
  description: '耐看 · 蓝左手红右手',
  title: '方案 C (默认) —— 左手蓝系 / 右手红色系, 两排各 4 个色, 慢速/练习最舒服',
  current: {
    leftWhite: hexRgb('#1E1EFF'),
    leftBlack: hexRgb('#4169E1'),
    rightWhite: hexRgb('#FF0000'),
    rightBlack: hexRgb('#C8102E'),
  },
  upcoming: {
    leftWhite: hexRgb('#006AFF'),
    leftBlack: hexRgb('#11FF00'),
    rightWhite: hexRgb('#FF0000'),
    rightBlack: hexRgb('#FF0033'),
  },
  pulse: 0.06,
  fast: false,
}

/**
 * 方案 D —— 快速曲目.
 *
 * 右手黑键更偏品红 (#FF8AD8), 色相偏移更大, 分离度更高; 亮度梯度也更陡.
 * 代价是视觉上更「粉紫」一点.
 */
export const SCHEME_D: LedScheme = {
  id: 'd',
  label: '方案 D',
  description: '快速 · 高辨识',
  title: '方案 D (快速) —— 右手黑键更偏品红, 分离度最高, 适合快板/复杂灯光环境',
  current: {
    leftWhite: hexRgb('#1F5FFF'),
    leftBlack: hexRgb('#73E6FF'),
    rightWhite: hexRgb('#D81E3F'),
    rightBlack: hexRgb('#FF8AD8'),
  },
  upcoming: {
    leftWhite: hexRgb('#3F78C8'),
    leftBlack: hexRgb('#9FD8F0'),
    rightWhite: hexRgb('#B93A63'),
    rightBlack: hexRgb('#F29AD0'),
  },
  pulse: 0.08,
  fast: true,
}

/** 默认「预告行」配色 (方案 C 的预告行). */
export const DEFAULT_UPCOMING_COLORS: LedPalette = SCHEME_C.upcoming

/** 方案选择器里的可选项 (自定义是手动调色后的状态, 不在预设里). */
export const LED_SCHEME_PRESETS: LedScheme[] = [SCHEME_C, SCHEME_D]

/**
 * 预设配色版本 —— 改了内置方案的颜色就 +1.
 *
 * 老用户 localStorage 里存的是**旧版**方案色, 直接读会看到老配色.
 * store 启动时拿这个号比对: 用了预设方案 (c/d) 的话自动升级到新配色;
 * 自己手动调过的 ('custom') 一律不动.
 */
export const SCHEME_COLOR_VERSION = 3

export function getScheme(id: LedSchemeId): LedScheme | null {
  if (id === 'c') return SCHEME_C
  if (id === 'd') return SCHEME_D
  return null
}

/** 自动模式: BPM 超过这个值算「快速」→ 用方案 D. */
export const FAST_BPM_THRESHOLD = 120

/**
 * 自动选方案: 快 → D, 慢 → C.
 *
 * @param bpm 曲子的速度 (取 tempo map 的平均值)
 */
export function autoScheme(bpm: number): LedScheme {
  return bpm >= FAST_BPM_THRESHOLD ? SCHEME_D : SCHEME_C
}

/** 预告行的亮度阶梯默认值 —— 第 1 个音 88%, 最后 N 个音 46%. */
export const DEFAULT_UPPER_LEVEL_MAX = 0.88
export const DEFAULT_UPPER_LEVEL_MIN = 0.46

/**
 * 预告行的亮度阶梯 (等比数列).
 *
 * @param max  最亮 (第 1 个音) 的相对亮度 0..1
 * @param min  最暗 (第 N 个音) 的相对亮度 0..1
 * @param count 上灯带显示几个音
 *
 * count=1 → [max] (只有一个音, 它就是最靠近的那个 → 取最亮)
 * count=3 → [max, √(max×min), min]  ← 中间那个是等比中项
 * count=5 → [max, max·r^¼, max·r^½, max·r^¾, min], r = min/max
 */
export function ledLevelLadder(max: number, min: number, count: number): number[] {
  const n = Math.max(0, Math.floor(count))
  if (n === 0) return []
  const hi = clamp01(max)
  // 最低不能比最高亮 —— 顺序反了就交换
  const lo = clamp01(Math.min(min, hi))
  if (n === 1) return [hi]
  if (hi <= 0) return new Array(n).fill(0)
  const ratio = lo / hi
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(hi * Math.pow(ratio, i / (n - 1)))
  }
  return out
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}
