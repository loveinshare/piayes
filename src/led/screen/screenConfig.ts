// LED 点阵屏的几何常量 —— 虚拟画布跟真实琴键的换算.
//
// 硬件
// ----
// 一块「屏」= 320x160mm, 2.5mm 点距 -> 128x64 像素 (两块 64x64 模组菊花链).
// 四块 1x4 横排 (串联信号) -> 虚拟画布 512x64 = 1280x160mm.
//
// 换算
// ----
// 88 键钢琴的白键宽 23.5mm -> 23.5 / 2.5 = 9.4 像素;
// 52 个白键 = 488.8px, 画布 512px -> 左右各余 11.6px.
// (用户实测: 「四块屏幕的长度刚好和 88 键长度差不多, 左右略有空余」.)
//
// ★ 2026-11-14 用户明确: 「不是铺满整条画布, 是按照真实长度, 左右空的就冗余着」
//   —— 白键宽保持真实的 9.4px, 左右那 11.6px 就是冗余, 不用填.
//   四块屏比 88 键宽, 多出来的地方空着就是了 (画面里是黑的).
//   这一版改的只有「屏与屏之间的白线」: 屏是紧挨着装的, 白线会变成一条亮缝.
//
// 中央 C (MIDI 60) 是第 23 个白键 (0-based) -> x = 11.6 + 23 * 9.4 = 227.8
// -> 落在**第 2 块屏** (x 128..255). 用户猜的「第二块屏」是对的.

import { whiteKeyIndex } from '../../render/colors'

/** 一块屏的像素宽 (320mm / 2.5mm) */
export const SCREEN_W = 128
/** 一块屏的像素高 (160mm / 2.5mm) */
export const SCREEN_H = 64
/** 一共几块屏 (1x4 横排) */
export const MAX_SCREENS = 4
/** 虚拟画布宽 —— 四块屏横向拼起来的总宽 */
export const CANVAS_W = SCREEN_W * MAX_SCREENS

/**
 * 用了几个 HUB75 口 (Adafruit Triple Bonnet 的 Port1 / Port2 / Port3).
 *
 * 一个口 = 一条**独立的菊花链** (自己的 RGB 数据线, 但行地址 A~E 是共用的).
 * 画面按**竖条**切给各口: 口 1 拿画布左边一段, 口 2 拿右边一段...
 * (库那边就是 --led-parallel=N.)
 *
 * ★ 2026-11-14: 四块屏 2x2 摆法 —— Port1 接**上面一行**的两块屏,
 *   Port2 接**下面一行**的两块屏.
 *   行地址是共用的 -> 两个口**不可能**各显示上下不同的行, 所以 2x2 不是
 *   「一张 256x128 的画面」, 而是「一条 512x64 的长画面折成两行」:
 *   上面一行 = 画布 x 0..255, 下面一行 = 画布 x 256..511.
 *   按「左上 -> 右上 -> 左下 -> 右下」读, 正好就是整条琴键从低到高.
 */
export const MAX_PORTS = 3

/** 88 键里的白键个数 (A0..C8) */
export const WHITE_KEY_COUNT = 52
/**
 * 一个白键多少像素 (真实 23.5mm ÷ 2.5mm).
 *
 * ★ 2026-11-14: 保持真实的 9.4px —— 四块屏比 88 键宽, 左右多出来的地方
 *   就当冗余空着 (用户: 「按照真实长度, 左右空的就冗余着」), 不铺满画布.
 */
export const WHITE_KEY_W = 9.4
/** 键盘左右各留的空余 (px) —— 四块屏比 88 键宽出来的那点, 空着就是冗余 */
export const MARGIN_X = (CANVAS_W - WHITE_KEY_COUNT * WHITE_KEY_W) / 2

/** 中央 C 是第几个白键 (0-based) */
export const MIDDLE_C_KEY_INDEX = whiteKeyIndex(60)
/** 中央 C 白键的左边缘 (虚拟画布坐标) */
export const MIDDLE_C_X = MARGIN_X + MIDDLE_C_KEY_INDEX * WHITE_KEY_W
/** 中央 C 在第几块屏 (1..4) */
export const MIDDLE_C_SCREEN = Math.floor(MIDDLE_C_X / SCREEN_W) + 1

/** 底部琴键盘面占多少行 (默认值; 设置里可以改成 0=关闭 .. KEYBOARD_H_MAX) */
export const KEYBOARD_H = 16
/** 琴键区高度上限 (行) —— 再高音符区就没地方落了 */
export const KEYBOARD_H_MAX = 24
/** 音符区高度 (屏幕 64 行 - 键盘 16 行) */
export const NOTE_AREA_H = SCREEN_H - KEYBOARD_H
/** 命中线的 y —— 也就是键盘的上沿 */
export const HIT_LINE_Y = NOTE_AREA_H
/**
 * 命中线上方至少留多少秒的**预读** —— 跟网页的 MIN_HORIZON 一致.
 * 面板只有 48 行音符区, 按同样的比例缩: 48px / 2.2s = 21.8 px/s.
 */
export const MIN_HORIZON = 2.2
/** 下落速度 (px/s) */
export const SCREEN_PPS = NOTE_AREA_H / MIN_HORIZON
/** 音符方块大小比例的取值范围 (1 = 当前大小) */
export const NOTE_SCALE_MIN = 0.5
export const NOTE_SCALE_MAX = 2

/** 屏号的中文名 —— UI 用 */
export const SCREEN_LABELS = ['1 号屏', '2 号屏', '3 号屏', '4 号屏']

/**
 * 点阵屏配色 (2026-11-13 用户定的).
 *
 * - 左手音符 = 蓝, 右手音符 = 红, 弹对了 = 绿;
 * - 黑键: 中央 C 左边 = 品红, 右边 = 粉色 (黑键原本是纯黑, 在黑底上等于没画,
 *   上了颜色才看得出左右两半).
 *
 * 每个颜色用户都能在设置里自己改 (LedScreenSettings 的「配色」一行).
 */
export interface LedScreenColors {
  /** 左手音符 */
  left: string
  /** 右手音符 */
  right: string
  /** 弹对的音符 */
  hit: string
  /** 中央 C 左边的黑键 */
  blackLeft: string
  /** 中央 C 右边的黑键 */
  blackRight: string
}

export const DEFAULT_SCREEN_COLORS: LedScreenColors = {
  left: '#0000ff', // 蓝
  right: '#ff0000', // 红
  hit: '#00ff00', // 绿
  blackLeft: '#ff00ff', // 品红
  blackRight: '#ffc0cb', // 粉
}

/** 中央 C 的 MIDI 号 —— 左右两半的分界 (左手在它下面, 右手在它上面). */
export const MIDDLE_C_MIDI = 60

/**
 * 自检「分屏分色」用的颜色 —— 屏 1 红 / 屏 2 绿 / 屏 3 蓝 / 屏 4 白.
 *
 * 每块屏一个固定颜色, 面板上一眼就知道哪块物理屏对应几号屏.
 */
export const PER_SCREEN_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
]

/**
 * 点阵屏的自检模式.
 *
 * - off      : 正常画面
 * - solid    : 整条链一个颜色, 每 4 秒轮换 (红 -> 绿 -> 蓝 -> 白) —— 查坏点
 * - perScreen: 每块屏一个固定颜色 (1 红 / 2 绿 / 3 蓝 / 4 白) —— 查接线顺序
 */
export type ScreenTestMode = 'off' | 'solid' | 'perScreen'

/** 只认 #rgb / #rrggbb —— 别的当没存, 用默认值. */
function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)
}

/**
 * 把存下来的配色跟默认值合并 —— 缺的补默认, 非法色丢掉.
 *
 * 存的是用户自己挑的颜色, 坏了 (比如老版本存过别的格式) 不能让整块屏黑掉.
 */
export function sanitizeScreenColors(v: unknown): LedScreenColors {
  const src = (v ?? {}) as Partial<Record<keyof LedScreenColors, unknown>>
  const out = { ...DEFAULT_SCREEN_COLORS }
  for (const key of Object.keys(DEFAULT_SCREEN_COLORS) as (keyof LedScreenColors)[]) {
    if (isHexColor(src[key])) out[key] = src[key] as string
  }
  return out
}

/** 第 n 块屏 (1-based) 在虚拟画布上的左边缘 */
export function screenX0(screen: number): number {
  return (screen - 1) * SCREEN_W
}

/** 虚拟画布上的 x 落在第几块屏 (1..4) */
export function screenOfX(x: number): number {
  return Math.floor(x / SCREEN_W) + 1
}

/**
 * 每个口分到几块屏.
 *
 * 库只有**一个** --led-chain (所有口一样长), 所以每个口的屏数必须一样多 ——
 * 屏数必须能被口数整除. UI 只给出能整除的口数, 这里再兜一层底.
 */
export function screensPerPort(screenCount: number, ports: number): number {
  if (ports <= 0) return screenCount
  return Math.max(1, Math.floor(screenCount / ports))
}
