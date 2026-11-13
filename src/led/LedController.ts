// LED strip controller —— 只管「哪个音亮成什么颜色」, 不管底下走哪条链路.
//
// 88 keys (A0..C8, MIDI 21..108) mapped to 176 LEDs, 2 LEDs per key (real
// piano width ~1.22m on a 144 LED/m strip). Same color rules as
// scripts/led_control.py so behavior matches.
//
// 链路 (WebSocket 树莓派 / 蓝牙 ESP32) 抽象在 LedTransport 里 —— 这个类
// 只认 "发一条 op" 这一件事, 上层 LedFollower 一行都不用改.

import type { LedTransport } from './LedTransport'
import { LEDS_PER_STRIP, stripRange, upperRange } from './dualStrip'
import { DEFAULT_UPCOMING_COLORS, type LedPalette } from './schemes'

export type LedMode = 'playback' | 'both' | 'right' | 'left'

/**
 * 谱面里某个 midi 对应哪只手.
 * 'both' = 两只手都出现这个音 —— 不猜, 交给 mode/split 兜底 (spec P2-2).
 */
export type HandHint = 'left' | 'right' | 'both'

/** 上灯带上的一颗提示灯 (某个音 + 哪只手 + 亮度系数). */
export interface LedHint {
  midi: number
  hand?: 'left' | 'right'
  /**
   * 亮度系数 (0..1) —— 上灯带「越往后越暗」用 (用户 2026-10-31 定的).
   *
   * 第 1 个接下来的音 = 1, 第 2 个 = 0.65, 第 3 个 = 0.42 …
   * 不传 = 1 (满亮).
   */
  level?: number
}

export interface LedControllerOpts {
  /** 底层传输层 (WsTransport / BleTransport / AutoTransport). */
  transport: LedTransport
  count?: number
  brightness?: number
  /**
   * 双色带模式: count = 352, 上灯带 (chain 176..351) 用来显示「下一个音」.
   * 树莓派和 ESP32 都支持 (两边的 init count 白名单都是 176 / 352).
   */
  dualStrip?: boolean
  /** 上灯带亮度 = 主灯带亮度 × 这个比例. 默认 0.7. */
  upperBrightnessRatio?: number
}

const LED_COUNT = LEDS_PER_STRIP
const BLACK_PCS = new Set([1, 3, 6, 8, 10])
// 默认按中央 C 划分左右手; 加载歌曲后用 song.pitchSplit 覆盖
const DEFAULT_SPLIT = 60
/** 上灯带亮度默认是主灯带的 70%. */
const DEFAULT_UPPER_RATIO = 0.7
/**
 * 当前音「呼吸」一个完整周期 (ms).
 *
 * 1.4s 上下 —— 太快会像报警灯, 太慢看不出在呼吸.
 */
const PULSE_PERIOD_MS = 1400

// 默认颜色 (按用户反馈: 左手黑键绿, 右手黑键橙, 白键蓝/红区分)
const COLOR_LEFT_WHITE: [number, number, number] = [0, 0, 200]      // 蓝
const COLOR_LEFT_BLACK: [number, number, number] = [0, 200, 50]     // 绿
const COLOR_RIGHT_WHITE: [number, number, number] = [200, 0, 0]    // 红
const COLOR_RIGHT_BLACK: [number, number, number] = [255, 30, 0]   // 橙 (绿通道压低, 避免 LED 上偏黄)

export const DEFAULT_LED_COLORS = {
  leftWhite: COLOR_LEFT_WHITE,
  leftBlack: COLOR_LEFT_BLACK,
  rightWhite: COLOR_RIGHT_WHITE,
  rightBlack: COLOR_RIGHT_BLACK,
}

export type LedColors = typeof DEFAULT_LED_COLORS

/** 预告行 (上灯带) 的 4 色 —— 跟当前行同一套结构, 但是降饱和 + 色彩漂移过的. */
export type LedUpcomingColors = LedPalette

/**
 * 校准模式点亮哪几个键.
 *
 * 用途是**调色**: 用户在自己的灯带上直接看到当前的 4 个颜色 ——
 *   左手白键 / 左手黑键 (切分点左边) + 右手白键 / 右手黑键 (切分点右边),
 * 每个位置用它**该有的**颜色 (主灯带用当前行配色, 上灯带用预告行配色).
 * 顺带也能看出灯带跟琴键的对应关系.
 *
 * 位置离切分点 (默认中央 C) 至少 7 个半音 —— 全挤在中间看不出左右.
 */
const CALIBRATE_MIN_DIST = 7

/** 校准模式点亮的 4 个位置 (MIDI 音高). */
interface CalibrateNotes {
  leftWhite: number
  leftBlack: number
  rightWhite: number
  rightBlack: number
}

/** 从切分点往两边找: 最近的那个离切分点至少 7 个半音的白键 / 黑键. */
function calibrateNotes(split: number): CalibrateNotes {
  const pick = (dir: 1 | -1, black: boolean): number => {
    for (let i = CALIBRATE_MIN_DIST; i < 40; i++) {
      const n = split + dir * i
      if (n < 21 || n > 108) break
      if (isBlackKey(n) === black) return n
    }
    return split
  }
  return {
    leftWhite: pick(-1, false),
    leftBlack: pick(-1, true),
    rightWhite: pick(1, false),
    rightBlack: pick(1, true),
  }
}

function noteToLedRange(note: number): [number, number] | null {
  // 88 键 × 2 LED 的映射 —— 跟 dualStrip.stripRange 是同一套 (那边还多一条上灯带).
  return stripRange(note)
}

/**
 * 两组「下一个音」提示是不是同一个内容.
 *
 * 用来判断「上灯带被清掉之后, 提示有没有真的变过」——
 * 没变过就不许自己亮回来 (用户报的「第二条灯带的清除做的不好有残留」).
 */
function sameHints(a: LedHint[], b: LedHint[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].midi !== b[i].midi || a[i].hand !== b[i].hand) return false
    // 亮度系数也要比 —— 上灯带「越往后越暗」: 同一个音往前挪一位, 亮度就变了,
    // 内容变了 → 该重画 (不然远处的音会一直保持旧的亮度).
    if ((a[i].level ?? 1) !== (b[i].level ?? 1)) return false
  }
  return true
}

function isBlackKey(note: number): boolean {
  return BLACK_PCS.has(note % 12)
}

/**
 * 这个音归哪只手管 —— 跟取色用的是**同一套优先级**.
 *
 * 为什么要抽成函数: 「左手/右手的灯开关」得判断「这个亮着的灯是谁的」,
 * 如果这里另写一套规则, 关灯时就会跟实际显示的颜色对不上 (关了左手,
 * 亮着的却是右手色的灯 → 灭错了).
 *
 * 优先级 (跟老版 baseColor 里写死的一样):
 *   0. 事件级 hand (来自 note.hand) — 同一个 midi 两只手出现时按各自手色
 *   1. 谱子里的 handMap (从 track 推的)
 *   2. 练习模式 (left/right 强制整手同色)
 *   3. pitchSplit (按 MIDI 区域)
 */
function resolveHand(
  note: number,
  split: number,
  mode: LedMode,
  handMap: Map<number, HandHint> | null,
  eventHand?: 'left' | 'right',
): 'left' | 'right' {
  if (eventHand === 'left' || eventHand === 'right') return eventHand
  const h = handMap?.get(note)
  if (h === 'left' || h === 'right') return h
  if (mode === 'left') return 'left'
  if (mode === 'right') return 'right'
  return note < split ? 'left' : 'right'
}

function baseColor(
  note: number,
  split: number,
  mode: LedMode,
  handMap: Map<number, HandHint> | null,
  colors: LedColors,
  eventHand?: 'left' | 'right',
): [number, number, number] {
  const black = isBlackKey(note)
  const hand = resolveHand(note, split, mode, handMap, eventHand)
  if (hand === 'left') return black ? colors.leftBlack : colors.leftWhite
  return black ? colors.rightBlack : colors.rightWhite
}

// ---------------------------------------------------------------------------
// 跑马灯时长
// ---------------------------------------------------------------------------

/** 「测试」按钮的目标时长: 0.5 秒扫完 (用户要求的). */
export const MARQUEE_TARGET_MS = 500
/**
 * 每颗灯推一遍的物理时间 (µs).
 * WS2811 800kHz: 24bit × 1.25µs = 30µs/颗. 树莓派 (PWM+DMA) 和 ESP32
 * (bit-bang) 都一样 —— 这是物理下限, 不是软件能绕过的.
 */
export const LED_FRAME_US = 30
/**
 * 物理帧长 —— 设备**永远**按这个数推一帧, 跟逻辑 count 无关.
 *
 * ★ 2026-11-11 修正: 以前这里按**逻辑**灯数 (176) 算帧时间 (5.28ms) ——
 *   错的. 两台设备推帧都按**物理**链长度发:
 *     - 树莓派: `led_remote.py --physical-count 352` (帧长永远按这个数)
 *     - ESP32: 固件 `LED_PHYSICAL_COUNT=352` (编译期固定)
 *   逻辑 count 只决定「允许写哪几颗」, 不影响帧长.
 *   算错的后果: 前端以为一帧 5.28ms → 步长取 2 → 88 帧, 实际一帧 10.56ms
 *   → 「0.5 秒」的测试按钮实际跑 **0.93 秒** (慢了一倍).
 */
export const LED_PHYSICAL_COUNT = 352

/**
 * 单帧"把整条灯带推一遍"的硬件地板 (ms) —— 352 颗 = 10.56ms.
 *
 * ⚠️ 按**物理**帧长算, 不是逻辑 count —— 见上面 LED_PHYSICAL_COUNT 的说明.
 */
export const MARQUEE_FRAME_MS = (LED_PHYSICAL_COUNT * LED_FRAME_US) / 1000

/** 推一遍 physicalCount 颗**物理**灯要多久 (ms). */
export function marqueeFrameMs(physicalCount: number = LED_PHYSICAL_COUNT): number {
  return (physicalCount * LED_FRAME_US) / 1000
}

/**
 * 设备侧跑马灯的回执上限 (ms).
 *
 * 固件是「动画跑完才回执」, 所以这个超时必须盖住整个动画:
 * 44 帧 × 10.56ms (352 颗物理灯) ≈ 0.46s, 再加 WS 往返延迟.
 * 传输层的默认窗口是 1.5s —— 太紧, 会把「动画还在跑」误判成「命令丢了」
 * (然后触发整条重刷, 画面反而乱了).
 */
export const MARQUEE_TIMEOUT_MS = 3000

/**
 * 跑 0.5s 需要每帧前进几颗灯.
 *
 * `count` = 要扫过的**逻辑**灯数, `frameMs` = 一帧的**物理**时间 (10.56ms).
 * 帧数上限 = targetMs / frameMs = 500 / 10.56 = 47 帧; 每帧前进 step 颗 →
 * 扫完 count 颗要 ceil(count/step) 帧, 刚好落在上限内.
 *
 *   176 颗 → step=4 → 44 帧 × 10.56ms = 464ms ✓
 *   352 颗 → step=8 → 44 帧 × 10.56ms = 464ms ✓
 */
export function marqueeStep(
  count: number,
  targetMs = MARQUEE_TARGET_MS,
  frameMs = marqueeFrameMs(),
): number {
  const maxFrames = Math.max(1, Math.floor(targetMs / frameMs))
  return Math.max(1, Math.ceil(count / maxFrames))
}

export class LedController {
  private transport: LedTransport
  private count: number
  private brightness = 1.0
  /** MIDI 切分点: < split → 左手, >= split → 右手. 默认 60 (中央 C), 由 App 在加载歌曲时覆盖. */
  private split = DEFAULT_SPLIT
  /** 跟弹模式: 'left'/'right' 强制整手同色, 'both'/'playback' 用 split/handMap. */
  private mode: LedMode = 'playback'
  /** 谱子里每个 MIDI 音对应的手 (从 note.hand / note.track 推断). 优先级最高, 覆盖 split. */
  private handMap: Map<number, HandHint> | null = null
  /** 4 色调色板 (用户可自定义). 默认蓝/绿/红/橙. */
  private colors: LedColors = DEFAULT_LED_COLORS
  /**
   * 上灯带 (预告行) 的 4 色调色板 —— 降饱和 + 轻微色彩漂移,
   * 跟主灯带 (当前行) 拉开层次, 两排不会混.
   *
   * 见 `led/schemes.ts` 的方案 C / D.
   */
  private upcomingColors: LedUpcomingColors = DEFAULT_UPCOMING_COLORS
  /**
   * 当前音「呼吸」幅度 (0..1) —— 0 = 不呼吸.
   *
   * 亮度按正弦起伏 (只动 V, 不动色相), 让「现在该弹哪个」在余光里也抓得住.
   */
  private pulseAmp = 0
  /** 呼吸相位 (0..1, 循环). */
  private pulsePhase = 0
  /** 校准背景灯 (中央 C 白色常亮), 优先级最高 — 每个 noteOn/noteOff 之后重发 */
  private calibrateBg: Array<{ i: number; r: number; g: number; b: number }> = []
  /**
   * 校准灯在**上灯带**上的位置 (双色带模式).
   *
   * 两条带要分别跟琴键对齐, 校准时上带也得亮同样的图案 ——
   * 这几个像素由 applyUpper() 一起画 (它有差量 + 状态跟踪).
   */
  private calibrateUpperBg: Array<{ i: number; r: number; g: number; b: number }> = []
  /** 校准模式开关 —— 亮度变了要按新亮度重画校准灯. */
  private calibrateEnabled = false
  /**
   * 影子像素表 (主机侧认为灯带现在是什么样).
   *
   * 为什么需要: BLE 是"写出去就希望它生效"的链路, 任何一条命令丢了, 物理灯带
   * 就多一颗"幽灵像素" (用户报的「莫名其妙常亮」「按一个键亮三颗」). 前端
   * 记住**期望值**之后, 遇到可疑情况 (回执超时 / 设备报错 / 重连 / 跑完测试)
   * 就能整条重刷一遍, 把物理状态拉回跟逻辑一致.
   */
  private shadow: Uint16Array
  /**
   * 双色带模式: 上灯带 (chain 176..351) 显示左右手各自的「下一个音」.
   * 关掉时 count 只有 176, 上灯带不存在.
   */
  private dual: boolean
  /** 上灯带亮度 = 主灯带亮度 × 这个比例. */
  private upperRatio: number
  /** 上灯带「想要」显示什么 (最新一次 setUpperHints 的内容). */
  private upperHints: LedHint[] = []
  /**
   * 上灯带是不是「已武装」(= 允许点亮).
   *
   * ★ 2026-10-30 用户报「第二条灯带的清除做的不好有残留」.
   *
   * 根因: 上灯带**没有状态机** —— applyUpper() 每 50ms 按 upperHints 重算,
   * 所以清灯刚把物理灯灭掉, 下一轮 setUpperHints 就把它点回来.
   * 主灯带有状态机 (follower 的 suspended/pressed/clearAll), 清完就是清完;
   * 上灯带没有 → 清不干净.
   *
   * 修法: 「熄着」期间提示内容**不变**就不许自己回来; 内容真的变了
   * (下一个音推进了 / 跳到了别处 / 换了歌) 才重新点亮.
   *
   * - clearUpperHints()  → 熄着 (上层说「没有了」)
   * - 跑马灯跑完         → 熄着 (动画独占, 跑完不该留提示)
   * - setUpperHints()    → 内容变了就重新武装
   * - connect()          → 重新武装 (重连后设备端是空的, 得重画)
   *
   * ★ allOff() **不**熄着 —— 它是「物理清零」, 语义上跟主灯带一样:
   *   恢复播放 / 切换跟随源 / 跳转 / 换歌 都会走 allOff(), 那些地方上灯带
   *   应该继续显示提示 (或换成新歌的提示), 不是「保持熄灭」.
   *   真正要「清完就熄着」的是曲终和跑马灯 —— 各自显式熄.
   */
  private upperArmed = true
  /**
   * 上灯带提示被**独占动画**让路 (跑马灯) —— 期间提示内容变了也不写.
   *
   * 跟 upperArmed 的区别: upperArmed 是「清过之后, 内容不变就不回来」
   * (软的, 内容一变就自动恢复); upperHold 是「硬让路」, 只有动画结束才松.
   * 跑马灯期间提示内容每拍都在变, 没有这层的话它会重新武装自己,
   * 把提示点进跑马灯的帧里 (乱闪), 跑完还会残留.
   */
  private upperHold = false
  /** 上灯带「已经写到设备上」的状态 (idx → RGB) —— 用来做增量下发. */
  private upperPixels: Map<number, [number, number, number]> = new Map()
  /** 上灯带下发的排队链 —— 保证同一时刻只有一次 apply 在飞 (见 scheduleUpper). */
  private upperChain: Promise<void> = Promise.resolve()
  /**
   * 每个 midi 的亮度系数 (0..1) —— 播放层用.
   *
   * 1 = 正常亮度 (用户设置的 ledBrightness); 0.5 = 「这个音你已经弹过了」;
   * 提前量窗口里是 0.15 → 1.0 的渐亮值.
   *
   * 为什么放在控制器里而不是上层: 颜色是控制器算的 (baseColor × brightness),
   * 亮度系数必须跟颜色在同一个地方乘, 否则输入源/命中脉冲一写就把渐亮覆盖了.
   */
  private intensity = new Map<number, number>()
  /**
   * 当前亮着的键 (midi → 手色) —— 亮度变了要**重写**该键的像素.
   *
   * 用 Map<number, {hands}> 而不是 Map<number, hand?> —— 因为「亮着但没有手色」
   * (undefined) 和「没亮」必须能区分开.
   *
   * ★ 2026-11-10: hands 是**集合** —— 同一个 midi 可能两只手同时按着
   *   (巴赫 BWV 1041 伴奏齐奏: 左手弦乐和右手小提琴同度同刻).
   *   以前只记一个手 → 后按的那只把手色覆盖掉, 先按的那只松手时灯就灭了
   *   (另一只手还按着), 而且关掉一只手会把同键的另一只手的灯一起灭掉,
   *   开回来也补不回来 (LedFollower 只知道「谁按着」, 不知道「同键两手」).
   */
  private lit = new Map<number, { hands: Set<'left' | 'right'> }>()
  /**
   * 左手 / 右手的灯分别开关 (首页的两个勾选框).
   *
   * 关掉一只手 → 那只手当前亮着的灯**立刻全灭** (静默), 之后这只手的音
   * 一律不点灯; 开回来 → 由 LedFollower 负责把还按着的键重新点上.
   */
  private handEnabled: { left: boolean; right: boolean } = { left: true, right: true }

  constructor(opts: LedControllerOpts) {
    this.transport = opts.transport
    this.dual = opts.dualStrip === true
    this.count = opts.count ?? (this.dual ? LED_COUNT * 2 : LED_COUNT)
    this.brightness = opts.brightness ?? 1.0
    this.upperRatio = opts.upperBrightnessRatio ?? DEFAULT_UPPER_RATIO
    this.shadow = new Uint16Array(this.count * 3)
  }

  /** 上灯带亮度比例 (0..1). */
  getUpperBrightnessRatio(): number {
    return this.upperRatio
  }

  /**
   * 设上灯带亮度比例 (相对主灯带). 改了要把上灯带重画一遍.
   */
  setUpperBrightnessRatio(ratio: number) {
    const v = Math.max(0, Math.min(1, ratio))
    if (v === this.upperRatio) return
    this.upperRatio = v
    this.repaintUpper()
  }

  /**
   * 设置上灯带的「接下来几个音」提示.
   *
   * 只写**变化了的**像素 —— 上层每 50ms 调一次, 全量重刷会把树莓派打爆.
   *
   * @param hints 每只手 N 个 (用户可设, 默认 3). 每个提示带一个亮度系数
   *   (越往后越暗). 同一个音高出现多次时只保留**亮**的那一个.
   */
  setUpperHints(hints: LedHint[]) {
    const next = this.dual ? hints : []
    // 提示内容变了 → 重新武装: 上灯带被清掉过的话, 这里点回来.
    // (内容没变就不重新武装 —— 「清了就熄着」, 见 upperArmed 的说明.)
    if (!sameHints(next, this.upperHints)) this.upperArmed = true
    this.upperHints = next
    this.scheduleUpper()
  }

  /** 上灯带全灭 (关掉双色带 / 换歌 / 断连时用). */
  clearUpperHints() {
    this.upperHints = []
    // 清掉了就别自己再亮 —— 否则「关掉双色带」后 50ms 又被点亮.
    this.upperArmed = false
    this.scheduleUpper()
  }

  /** 颜色/比例/切分/模式变了之后重画上灯带 (差量逻辑自己会发现颜色变了). */
  private repaintUpper() {
    this.scheduleUpper()
  }

  /**
   * 把上灯带的更新**排队** —— 同一时刻只允许一次下发在飞.
   *
   * 为什么: 上层每 50ms 调一次 setUpperHints, 而一次下发要走
   * set_many(灭) → set_many(亮) → show 三次往返 (BLE 上一次几十毫秒).
   * 不排队的话两次更新的差量会互相打架 —— 老的差量后落地, 设备上就会
   * 留一颗「谁也不要的灯」, 而且影子表以为它是对的, 再也不会补发.
   */
  private scheduleUpper() {
    this.upperChain = this.upperChain
      .then(() => this.applyUpper())
      .catch(() => {})
  }

  /**
   * 算出「上灯带应该亮什么」, 跟「已经亮了什么」比, 只发差量.
   *
   * 注意: **写成功了才更新 upperPixels** —— 连接还没建好时不能把
   * 「已下发」记成成功, 否则等连上了就再也不会补发.
   */
  private applyUpper(): Promise<void> {
    if (!this.dual) {
      this.upperPixels.clear()
      return Promise.resolve()
    }
    const want = new Map<number, [number, number, number]>()
    const br = this.brightness * this.upperRatio
    // 没武装 / 被独占动画让路 → 只灭不亮
    //   (上灯带被清掉过, 提示内容没变之前不许自己回来).
    const canLight = this.upperArmed && !this.upperHold
    // 同一个音高可能出现多次 (e.g. 接下来两个音都是 C4, 或两只手都是 C4)
    // → 只保留**亮**的那一个 (越靠前的越亮). 亮度一样时后者覆盖前者
    // (跟旧行为一致: 右手色覆盖左手色).
    const picked = new Map<number, LedHint>()
    for (const h of canLight ? this.upperHints : []) {
      // 这只手被关掉了 → 它的提示不显示 (跟主灯带保持一致).
      if (!this.hintAllowed(h.hand)) continue
      const prev = picked.get(h.midi)
      if (prev !== undefined && (prev.level ?? 1) > (h.level ?? 1)) continue
      picked.set(h.midi, h)
    }
    for (const h of picked.values()) {
      const rng = upperRange(h.midi)
      if (!rng) continue
      // 上灯带用「预告行」配色 (降饱和 + 色彩漂移) —— 跟主灯带的当前行拉开层次.
      const [r, g, b] = baseColor(
        h.midi,
        this.split,
        this.mode,
        this.handMap,
        this.upcomingColors,
        h.hand,
      )
      // 亮度 = 主灯带亮度 × 上灯带比例 × 这个提示自己的系数 (越往后越暗).
      const lv = Math.max(0, Math.min(1, h.level ?? 1))
      const c: [number, number, number] = [
        Math.round(r * br * lv),
        Math.round(g * br * lv),
        Math.round(b * br * lv),
      ]
      for (let i = rng[0]; i < rng[1]; i++) want.set(i, c)
    }
    // 校准模式优先于预告提示 —— 校准灯盖在上灯带对应位置上 (跑马灯动画期间让路).
    if (!this.upperHold) {
      for (const px of this.calibrateUpperBg) want.set(px.i, [px.r, px.g, px.b])
    }
    const off: Array<{ i: number; r: number; g: number; b: number }> = []
    const on: Array<{ i: number; r: number; g: number; b: number }> = []
    // 灭的 = 「之前亮着、现在不想要了」的 (颜色变了的不用先灭 —— 直接覆盖写).
    for (const [i] of this.upperPixels) {
      if (!want.has(i)) off.push({ i, r: 0, g: 0, b: 0 })
    }
    for (const [i, c] of want) {
      const o = this.upperPixels.get(i)
      if (!o || o[0] !== c[0] || o[1] !== c[1] || o[2] !== c[2]) on.push({ i, r: c[0], g: c[1], b: c[2] })
    }
    if (off.length === 0 && on.length === 0) return Promise.resolve()
    const p = off.length
      ? this.setMany(off).then(() => (on.length ? this.setMany(on) : undefined))
      : this.setMany(on)
    return p
      .then(() => {
        this.upperPixels = want
        // 树莓派 set_many 只写 buffer, 必须补一次 show 才刷出来.
        return this.show()
      })
      .then(() => undefined)
  }

  /** 加载歌曲后调用, 让 LED 颜色跟项目内的左右手划分一致. */
  setSplit(midiNote: number) {
    if (midiNote >= 21 && midiNote <= 108) {
      this.split = midiNote
    } else {
      this.split = DEFAULT_SPLIT
    }
    this.repaintUpper()
    // 校准灯的位置跟着切分点走 (左手在左 / 右手在右) → 切分点变了要重画.
    if (this.calibrateEnabled) this.repaintCalibrate()
  }

  getSplit(): number {
    return this.split
  }

  /** 跟弹模式: 'left'/'right' 强制整手同色, 'both'/'playback' 走 split/handMap. */
  setMode(mode: LedMode) {
    this.mode = mode
    this.repaintUpper()
  }

  getMode(): LedMode {
    return this.mode
  }

  /**
   * 谱子→手的查表 (midiNote → 'left' | 'right'). null 表示清空.
   * 优先级高于 split: 输入音先查这里, 查不到再按 split 分.
   */
  setHandMap(map: Map<number, HandHint> | null) {
    this.handMap = map
    this.repaintUpper()
  }

  /**
   * 开 / 关某只手的灯 (首页的两个勾选框).
   *
   * 关掉 → **静默**把那只手当前亮着的灯全灭: 不弹提示, 不报错, 只是灯没了.
   * 之后这只手的音一律不点灯 (noteOn 直接跳过).
   *
   * 开回来 → 这里只改状态; 「把还按着的键重新点上」由 LedFollower 负责
   * (它知道谁按着, 控制器只知道现在亮着什么).
   */
  setHandEnabled(hand: 'left' | 'right', enabled: boolean) {
    if (this.handEnabled[hand] === enabled) return
    this.handEnabled[hand] = enabled
    if (!enabled) {
      const off: Array<{ i: number; r: number; g: number; b: number }> = []
      for (const [note, entry] of [...this.lit]) {
        if (!entry.hands.has(hand)) continue
        entry.hands.delete(hand)
        // 同键的另一只手还按着 → 灯留着 (别把别人的灯一起灭掉).
        if (entry.hands.size > 0) continue
        const rng = noteToLedRange(note)
        if (!rng) continue
        // 从「亮着的键」里摘掉 —— 之后 repaint (呼吸 / 亮度变化) 不会再把它点亮.
        this.lit.delete(note)
        for (let i = rng[0]; i < rng[1]; i++) off.push({ i, r: 0, g: 0, b: 0 })
      }
      if (off.length > 0) {
        this.setMany(off).catch(() => {})
        this.show().catch(() => {})
        this.reapplyBackground()
      }
    }
    // 上灯带 (预告行) 也要跟着变: 这只手的「下一个音」提示不显示了.
    this.repaintUpper()
  }

  /** 这个音归哪只手 —— 跟取色同一套规则 (见 resolveHand). */
  private handOf(note: number, eventHand?: 'left' | 'right'): 'left' | 'right' {
    return resolveHand(note, this.split, this.mode, this.handMap, eventHand)
  }

  /**
   * 亮着的这个键按**哪只手**显示 (同键两手 → 取先记的那只).
   *
   * 物理上同一个 midi 只有一段灯位 → 只能显示一种颜色; 这里选一个代表.
   */
  private litHand(entry: { hands: Set<'left' | 'right'> }): 'left' | 'right' | undefined {
    for (const h of entry.hands) return h
    return undefined
  }

  /** 上灯带的提示属不属于「开着的那只手」. */
  private hintAllowed(hand?: 'left' | 'right'): boolean {
    if (hand === 'left') return this.handEnabled.left
    if (hand === 'right') return this.handEnabled.right
    // 不知道是哪只手 → 保守: 两只手都开着才显示.
    return this.handEnabled.left && this.handEnabled.right
  }

  /** 自定义 4 色调色板 (覆盖默认值). 不传的部分保持现状. */
  setColors(patch: Partial<LedColors>) {
    this.colors = { ...this.colors, ...patch }
    this.repaintUpper()
    // 校准模式就是调色预览 → 颜色变了立刻重画.
    if (this.calibrateEnabled) this.repaintCalibrate()
  }

  getColors(): LedColors {
    return this.colors
  }

  /** 自定义「预告行」配色 (上灯带用). 不传的部分保持现状. */
  setUpcomingColors(patch: Partial<LedUpcomingColors>) {
    this.upcomingColors = { ...this.upcomingColors, ...patch }
    this.repaintUpper()
    // 上灯带的校准灯用的是预告行配色 → 也跟着重画.
    if (this.calibrateEnabled) this.repaintCalibrate()
  }

  getUpcomingColors(): LedUpcomingColors {
    return this.upcomingColors
  }

  /**
   * 设当前音的呼吸幅度 (0..1). 0 = 关.
   *
   * 幅度变了 → 已经亮着的键要按新因子重画 (否则会停在旧的亮度上).
   */
  setPulse(amp: number) {
    const v = Number.isFinite(amp) ? Math.max(0, Math.min(1, amp)) : 0
    if (v === this.pulseAmp) return
    this.pulseAmp = v
    this.pulsePhase = 0
    this.repaintLit()
  }

  getPulse(): number {
    return this.pulseAmp
  }

  /**
   * 呼吸走一帧 —— 上层每 50ms 调一次.
   *
   * 亮度因子 = 1 + amp × sin(2π × phase) —— 只改 V, 色相不漂.
   * 没亮着任何键时直接返回 (不产生任何串口/BLE 流量).
   */
  tickPulse(dtMs: number) {
    if (this.pulseAmp <= 0 || this.lit.size === 0) return
    this.pulsePhase = (this.pulsePhase + dtMs / PULSE_PERIOD_MS) % 1
    this.repaintLit()
  }

  /** 当前呼吸因子. */
  private pulseFactor(): number {
    if (this.pulseAmp <= 0) return 1
    return 1 + this.pulseAmp * Math.sin(2 * Math.PI * this.pulsePhase)
  }

  /** 把当前亮着的键按当前亮度因子重画一遍 (呼吸用). */
  private repaintLit() {
    if (this.lit.size === 0) return
    const pixels: Array<{ i: number; r: number; g: number; b: number }> = []
    for (const [note, entry] of this.lit) {
      pixels.push(...this.keyPixels(note, this.litHand(entry)))
    }
    if (pixels.length === 0) return
    this.setMany(pixels).catch(() => {})
    this.show().catch(() => {})
  }

  /**
   * 校准模式: 点亮 4 个位置, 各显示一种颜色 —— **调色预览**.
   *
   * - 左手白键 / 左手黑键 在切分点左边, 右手白键 / 右手黑键 在右边
   * - 主灯带显示**当前行**配色, 上灯带 (双色带) 显示**预告行**配色
   * - 亮度跟着**系统亮度** (this.brightness) 走
   *
   * 换配色方案 / 改自定义颜色 → repaintCalibrate() 会跟着重画.
   * 关闭时把校准位置灯灭掉.
   */
  setCalibrate(enabled: boolean) {
    this.calibrateEnabled = enabled
    if (enabled) {
      this.repaintCalibrate()
    } else {
      const off = this.calibrateBg.map((px) => ({ i: px.i, r: 0, g: 0, b: 0 }))
      this.calibrateBg = []
      this.calibrateUpperBg = []
      this.setMany(off).catch(() => {})
      this.show().catch(() => {})
      // 上灯带: 校准像素从 want 里消失 → applyUpper 会把它们灭掉
      this.repaintUpper()
    }
  }

  /**
   * 按**当前配色**重画校准灯.
   *
   * 手别按切分点定 (不查谱子的 handMap) —— 校准是给人看配色用的,
   * 位置和颜色都得稳定, 不能因为曲子里有那个音就变色.
   *
   * 上灯带的校准灯**不乘**上灯带亮度比例 —— 调色时两条带亮度一致才好比色.
   */
  private repaintCalibrate() {
    const notes = calibrateNotes(this.split)
    const br = this.brightness
    const main: Array<{ i: number; r: number; g: number; b: number }> = []
    const upper: Array<{ i: number; r: number; g: number; b: number }> = []
    const markers: Array<[number, 'left' | 'right']> = [
      [notes.leftWhite, 'left'],
      [notes.leftBlack, 'left'],
      [notes.rightWhite, 'right'],
      [notes.rightBlack, 'right'],
    ]
    for (const [note, hand] of markers) {
      // 主灯带 = 当前行配色
      const [r, g, b] = baseColor(note, this.split, this.mode, null, this.colors, hand)
      const rng = noteToLedRange(note)
      if (rng) {
        for (let i = rng[0]; i < rng[1]; i++) {
          main.push({ i, r: Math.round(r * br), g: Math.round(g * br), b: Math.round(b * br) })
        }
      }
      // 上灯带 = 预告行配色 (双色带才有)
      const urng = this.dual ? upperRange(note) : null
      if (urng) {
        const [ur, ug, ub] = baseColor(note, this.split, this.mode, null, this.upcomingColors, hand)
        for (let i = urng[0]; i < urng[1]; i++) {
          upper.push({ i, r: Math.round(ur * br), g: Math.round(ug * br), b: Math.round(ub * br) })
        }
      }
    }
    this.calibrateBg = main
    this.calibrateUpperBg = upper
    // 用 set_many 而不是一条条 set —— ESP32 上每条 led.set 都会 show()
    // (整条灯带推一遍), 4 个键就是 4 遍; set_many 一次搞定.
    this.setMany(main).catch(() => {})
    this.show().catch(() => {})
    // 上灯带的校准像素走 applyUpper (差量 + 状态跟踪)
    this.repaintUpper()
  }

  isConnected(): boolean {
    return this.transport.connected
  }

  /** 当前连的是哪个后端 (UI 显示用). */
  getTransportName(): string {
    return this.transport.name
  }

  async connect(): Promise<void> {
    await this.transport.connect()
    // 传输层建连时会发 init + off, 物理灯带已经被清空 —— 影子表也跟着归零.
    this.shadow.fill(0)
    this.upperPixels.clear()
    // 重连 → 设备端是空的 → 上灯带重新武装 (提示内容没变也得重画一遍).
    this.upperArmed = true
    this.lit.clear()
    this.intensity.clear()
    this.setBrightness(this.brightness)
  }

  disconnect() {
    this.transport.disconnect()
  }

  setBrightness(b: number) {
    this.brightness = Math.max(0, Math.min(1, b))
    // 上灯带亮度 = 主灯带亮度 × 比例 → 主亮度变了上灯带也得重画.
    this.repaintUpper()
    // 校准灯的亮度跟着系统亮度走 → 亮度变了校准灯要重画.
    if (this.calibrateEnabled) this.repaintCalibrate()
  }

  getBrightness(): number {
    return this.brightness
  }

  /**
   * 点亮某个 MIDI 音.
   * @param hand 可选 — 事件级的手 (来自 note.hand). 优先级高于 handMap:
   *   同一个 midi 在两只手出现时 (e.g. C4 LH bass + C4 RH melody), 各自用对应手色.
   */
  noteOn(note: number, hand?: 'left' | 'right') {
    const rng = noteToLedRange(note)
    if (!rng) return
    const h = this.handOf(note, hand)
    // 这只手被用户关掉了 → 不点灯 (静默, 不报错).
    if (!this.handEnabled[h]) return
    let entry = this.lit.get(note)
    if (!entry) {
      entry = { hands: new Set() }
      this.lit.set(note, entry)
    }
    // 同键两手 → 两边都记着 (松手时只摘自己那只手).
    entry.hands.add(h)
    this.writeKey(note, h)
    // 不在这里 reapplyBackground — 校准是「默认底色」, 应该让点亮的音可见,
    // 音结束后由 noteOff 的 reapplyBackground 恢复
  }

  noteOff(note: number, hand?: 'left' | 'right') {
    const rng = noteToLedRange(note)
    if (!rng) return
    const entry = this.lit.get(note)
    // 没亮着 → 不用写灭灯.
    // (同一个 midi 两只手都出现时, 写灭灯会误伤另一只手还亮着的灯)
    if (!entry) return
    if (hand) {
      // 事件带手 → 只摘那只手 (同键的另一只手还按着 → 灯留着).
      entry.hands.delete(this.handOf(note, hand))
    } else {
      entry.hands.clear()
    }
    // 还有别的只手按着这个键 → 灯别灭.
    if (entry.hands.size > 0) return
    this.lit.delete(note)
    const pixels: Array<{ i: number; r: number; g: number; b: number }> = []
    for (let i = rng[0]; i < rng[1]; i++) {
      pixels.push({ i, r: 0, g: 0, b: 0 })
    }
    this.setMany(pixels).catch(() => {})
    this.reapplyBackground()
  }

  /**
   * 设置某个音的亮度系数 (0..1) —— 立即生效.
   *
   * 播放层用: 提前量窗口里渐亮 (0.15 → 1), 用户弹过之后减半 (0.5).
   * 键没亮着的时候只记下来, 等 noteOn 时用.
   */
  setIntensity(note: number, v: number) {
    const val = Math.max(0, Math.min(1, v))
    const old = this.intensity.get(note)
    if (old !== undefined && Math.abs(old - val) < 1e-3) return
    this.intensity.set(note, val)
    const entry = this.lit.get(note)
    if (!entry) return // 没亮着 —— 等 noteOn 时再算
    this.writeKey(note, this.litHand(entry))
    // 树莓派 set_many 只写 buffer, 必须补一次 show 才刷出来 (ESP32 自己会 show).
    this.show().catch(() => {})
  }

  /** 读某个音当前的亮度系数 (调试 / 测试用). */
  getIntensity(note: number): number {
    return this.intensity.get(note) ?? 1
  }

  /** 把某个键的像素按「手色 × 亮度 × 亮度系数」写出去. */
  private writeKey(note: number, hand?: 'left' | 'right') {
    const pixels = this.keyPixels(note, hand)
    if (pixels.length === 0) return
    this.setMany(pixels).catch(() => {})
  }

  /**
   * 某个键该显示的像素 (不发送).
   *
   * 抽出来是因为「呼吸」要按同一套公式把**所有**亮着的键重算一遍.
   */
  private keyPixels(
    note: number,
    hand?: 'left' | 'right',
  ): Array<{ i: number; r: number; g: number; b: number }> {
    const rng = noteToLedRange(note)
    if (!rng) return []
    const [r, g, b] = baseColor(note, this.split, this.mode, this.handMap, this.colors, hand)
    const br = this.brightness * (this.intensity.get(note) ?? 1) * this.pulseFactor()
    const r2 = Math.round(r * br)
    const g2 = Math.round(g * br)
    const b2 = Math.round(b * br)
    const pixels: Array<{ i: number; r: number; g: number; b: number }> = []
    for (let i = rng[0]; i < rng[1]; i++) {
      pixels.push({ i, r: r2, g: g2, b: b2 })
    }
    return pixels
  }

  private reapplyBackground() {
    if (this.calibrateBg.length === 0) return
    this.setMany(this.calibrateBg).catch(() => {})
  }

  /**
   * Batch set pixels. One command sends up to 80 pixels; over 80 auto-splits.
   * Drops silently if not connected. Replaces per-pixel rpc('set')
   * loops that were creating 20+ round-trips per chord (each key 2 LEDs x on+off).
   *
   * 不等响应 —— set 是「写一次就生效」的命令, 等回执只会拖慢节拍.
   */
  setMany(pixels: Array<{ i: number; r: number; g: number; b: number }>): Promise<any> {
    if (!this.transport.connected) {
      return Promise.reject(new Error('not connected'))
    }
    if (pixels.length === 0) return Promise.resolve()
    // 先记到影子表 —— 即使这条命令丢了, resync() 也能把正确颜色补回去.
    for (const px of pixels) {
      if (px.i < 0 || px.i >= this.count) continue
      this.shadow[px.i * 3] = px.r
      this.shadow[px.i * 3 + 1] = px.g
      this.shadow[px.i * 3 + 2] = px.b
    }
    const CHUNK = 80
    const promises: Promise<any>[] = []
    for (let k = 0; k < pixels.length; k += CHUNK) {
      const chunk = pixels.slice(k, k + CHUNK)
      promises.push(this.rpc('set_many', { pixels: chunk }))
    }
    return Promise.all(promises)
  }

  /**
   * 刷一次灯带.
   *
   * ★ 2026-11-04: 语义跟树莓派端 (led_remote.py) 对齐 —— **一帧只推一次**.
   *
   * 设备端 `set_many` 只写像素缓冲, 要另发 `show` 才推给灯带:
   *   - 树莓派 (WS): 一直是这个语义 (setManyShows = false).
   *   - ESP32 新固件: 也是这个语义 (init 回执里回报 set_many_shows:false).
   *   - ESP32 老固件: set_many 自己会 show (setManyShows = true) —— 这时
   *     再发 show 就是把整条灯带**推两遍** (画面撕裂 = 用户报的「异常闪」).
   *
   * 所以这里只在「设备不自己刷」的后端上发 show.
   */
  show() {
    if (this.transport.setManyShows !== false) return Promise.resolve()
    return this.rpc('show')
  }

  /**
   * 全灭.
   *
   * ★ 2026-10-24: 这里必须**先 drain 再发 off**, 不能直接发.
   *
   * 为什么: `send()` 对 set/set_many 是 fire-and-forget (不等回执), 所以
   * 「off 已经发出去了」≠「off 是设备执行的最后一条」. 后面排队的
   * set_many 可能在 off 之后才落地 → 灯又被点回来 —— 用户报的
   * 「跑完还有几个单灯亮着」「灯常亮着」就是这个.
   *
   * drain 之后在途命令归零, 这时发的 off 就是**真正最后一条**.
   */
  async allOff(clearState = true): Promise<void> {
    // 全灭是「兜底」操作 —— 失败也不能把调用方 (App 的 effect / follower's
    // 清理路径) 弄崩, 所以这里吞掉所有错误.
    try {
      await this.transport.drain?.()
    } catch {}
    await this.rpc('off').catch(() => {})
    // off 之后也 drain 一下 —— 确认设备真的执行了 (而不是还在队列里).
    try {
      await this.transport.drain?.()
    } catch {}
    this.shadow.fill(0)
    // 上灯带的「已下发」状态也得清 —— 影子表清了, 设备也灭了, 不清的话
    // 下次 diff 会以为它还亮着, 就再也不会补发.
    // (upperHints 不清: 上层下一轮 setUpperHints 会重新点亮 —— 自愈.)
    this.upperPixels.clear()
    // ★ allOff() **不**让上灯带熄着 (见 upperArmed 的说明):
    //   恢复播放 / 切换跟随源 / 跳转 / 换歌 都走这条路, 那些地方上灯带
    //   应该继续显示提示. 真正要「清完就熄着」的是曲终 (App 显式调
    //   clearUpperHints) 和跑马灯 (testPattern 跑完自己熄).
    // 主灯带: 亮着的键和亮度系数一起清 —— 全灭之后不该还留着「半亮」的系数,
    // 否则下一个 note 点亮时会带着上一个 note 的亮度.
    //
    // clearState=false 留给 resync(): 它是「把物理灯带拉回影子表」, 不是「清空」.
    if (clearState) {
      this.lit.clear()
      this.intensity.clear()
    }
  }

  /**
   * 把物理灯带拉回「影子表」的状态.
   *
   * 什么时候用: 重连之后 / 跑完测试 / 设备报错或回执超时 (命令可能丢了).
   * 做法: 先整条 off 清掉所有幽灵像素, 再把当前该亮的重新点上 —— 比
   * 逐颗重刷 176 颗省很多 BLE 流量.
   */
  async resync(): Promise<void> {
    if (!this.transport.connected) return
    // 先快照"该亮的" (allOff 会把影子表清零).
    const lit: Array<{ i: number; r: number; g: number; b: number }> = []
    for (let i = 0; i < this.count; i++) {
      const r = this.shadow[i * 3]
      const g = this.shadow[i * 3 + 1]
      const b = this.shadow[i * 3 + 2]
      if (r || g || b) lit.push({ i, r, g, b })
    }
    // clearState=false —— resync 是「重画」不是「清空」: 逻辑状态 (哪些键亮着、
    // 各自什么亮度) 必须留着, 否则重画完之后 setIntensity 就不知道该重写谁了.
    await this.allOff(false)
    if (lit.length === 0) return
    await this.setMany(lit).catch(() => {})
    if (this.transport.setManyShows === false) {
      await this.rpc('show').catch(() => {})
    }
    try {
      await this.transport.drain?.()
    } catch {}
  }

  /**
   * 连接测试: 6 盏一组成块从左扫到右, 目标 **0.5 秒**扫完.
   *
   * ── 为什么以前「非常慢」─────────────────────────────────────────
   * 旧实现一帧发一条 set_many (176 条), 每条都要过一遍 BLE GATT 往返.
   * 就算在途深度 6, 真机也要 1.7~3 秒 —— 用户记的「0.5s」根本到不了.
   *
   * ── 现在两条路 ──────────────────────────────────────────────────
   * 1. **设备侧 marquee**: ESP32 (`led.marquee`) 和树莓派 (`marquee`,
   *    2026-11-11 新增) 都是发一条命令, 设备本地按物理帧时间把动画跑完.
   *    44 帧 × ~10.5ms ≈ 0.47s, 与链路吞吐无关, 中间不会插进别的命令.
   * 2. **回退: 老服务/老固件 (回 unknown op)**: 前端逐帧发, 每帧前进
   *    step=4 颗 (marqueeStep) —— 同样 0.5s 左右, 但会受浏览器 rAF /
   *    网络抖动影响 (帧间隔不匀 = 看起来乱闪).
   *
   * 两种路径最后都会 allOff(), 保证不留残灯.
   */
  async testPattern(): Promise<void> {
    if (!this.transport.connected) return
    const TOTAL = this.count
    const WINDOW = 6
    const step = marqueeStep(TOTAL)

    // ★ 跑马灯是**独占动画** —— 上灯带的「下一个音」提示这时必须让路:
    //   否则 50ms 一次的 setUpperHints 会把提示点进跑马灯的帧里 (乱闪),
    //   跑完后刚灭掉又被下一轮点回来 = 用户报的「第二条灯带清除有残留」.
    this.upperHold = true
    try {
      // ── 1. 设备侧跑马灯 (ESP32 固件) ──
      if (this.transport.supportsDeviceMarquee) {
        try {
          await this.rpc('marquee', { window: WINDOW, step })
          await this.transport.drain?.()
          // 固件动画结束时已经清过屏; 再 allOff 一次保证不残留.
          await this.allOff()
          return
        } catch (e) {
          // 旧固件回 unknown op / 超时 → 回退到逐帧发, 别让测试按钮变成没反应.
          console.warn('[led] device marquee 不可用, 回退逐帧:', e)
        }
      }

      // ── 2. 前端逐帧 (树莓派 / 旧固件) ──
      /**
       * ESP32 的 led.set_many 内部会 show() —— 再单独 show 就是把灯带推两遍.
       * 树莓派 (led_remote.py) 的 set_many 只写 _buf, 必须另外 show 才刷出来.
       */
      const needsExplicitShow = this.transport.setManyShows === false
      /** 头部 (k=0, 最亮蓝) → 尾部 (k=WINDOW-1, 最暗紫): hue 240° → 280°, value 1 → 0.25 */
      const colorAt = (k: number): [number, number, number] => {
        const t = k / (WINDOW - 1) // 0=头, 1=尾
        const hue = (240 + t * 40) / 360
        const v = 1 - t * 0.75
        const i = Math.floor(hue * 6)
        const f = hue * 6 - i
        const p = v * (1 - 1)
        const q = v * (1 - f)
        const tt = v * (1 - (1 - f))
        let r = 0, g = 0, b = 0
        switch (i % 6) {
          case 0: r = v; g = tt; b = p; break
          case 1: r = q; g = v; b = p; break
          case 2: r = p; g = v; b = tt; break
          case 3: r = p; g = q; b = v; break
          case 4: r = tt; g = p; b = v; break
          case 5: r = v; g = p; b = q; break
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
      }

      // ★ 用 allOff() 而不是裸的 rpc('off'):
      //   allOff() 会把上灯带 disarm 掉 + 清掉 upperPixels 的记账,
      //   裸 rpc('off') 只清物理, 前端还以为提示亮着 → 差量算出来「没变化」
      //   → 提示再也回不来 (而且跑马灯期间会被点进帧里).
      await this.allOff()
      // 帧命令**不逐帧 await** —— 一次性排进传输层的写队列, 背压交给传输层.
      const frames: Array<Promise<any>> = []
      const pushFrame = (pos: number) => {
        const px: Array<{ i: number; r: number; g: number; b: number }> = []
        // 掉出窗口的 step 颗: pos-step-WINDOW+1 .. pos-WINDOW
        for (let i = pos - step - WINDOW + 1; i <= pos - WINDOW; i++) {
          if (i >= 0 && i < TOTAL) px.push({ i, r: 0, g: 0, b: 0 })
        }
        // 当前窗口的渐变色
        for (let k = 0; k < WINDOW; k++) {
          const i = pos - k
          if (i < 0 || i >= TOTAL) continue
          const [r, g, b] = colorAt(k)
          px.push({ i, r, g, b })
        }
        frames.push(this.setMany(px).catch(() => {}))
        if (needsExplicitShow) frames.push(this.rpc('show').catch(() => {}))
      }
      for (let pos = 0; pos < TOTAL; pos += step) pushFrame(pos)
      // step > 1 时最后一帧可能没扫到最右边那颗, 补一帧.
      if ((TOTAL - 1) % step !== 0) pushFrame(TOTAL - 1)

      // 等所有帧都写出去 —— 写完了才轮到最后的 off.
      await Promise.all(frames)
      // drain + off + drain: 确保 off 是设备真正执行的最后一条.
      await this.allOff()
    } finally {
      this.upperHold = false
      // 跑完 → 上灯带**保持熄灭**, 直到提示内容真的变了 (下一个音推进).
      // 不这样的话, 50ms 后的下一轮 setUpperHints 就把它点回来 = 用户报的残留.
      this.upperArmed = false
    }
  }

  /**
   * 发一条命令.
   *
   * `set` / `set_many` 不等响应 —— LED 是「写一次就生效」的命令,
   * 等回执只会拖慢节拍 (蓝牙尤其明显, 每条响应要占一个 ATT 往返).
   */
  private rpc(op: string, args: Record<string, any> = {}): Promise<any> {
    // marquee 必须等回执: 设备是**动画跑完才回**的, 收到回执 = 动画结束.
    const expectReply = op === 'show' || op === 'off' || op === 'init' || op === 'marquee'
    // 跑马灯的回执要等整个动画跑完 —— 44 帧 × 10.56ms (352 颗物理) ≈ 0.46s,
    // 加上 WS 回执延迟, 1.5s 的默认窗口太紧 → 给它单独放宽.
    const timeoutMs = op === 'marquee' ? MARQUEE_TIMEOUT_MS : undefined
    return this.transport.send(op, args, { expectReply, timeoutMs })
  }
}
