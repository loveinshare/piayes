// 模块级 LED 事件广播: Player (播放事件) 和 MidiInput/KeyboardInput (输入事件) 都通过这里发.
// 用模块级而不是 inline 闭包, 是为了 HMR 后 bus 引用还是新的 — inline 闭包会捕获旧 bus.
//
// ★ 播放层的 LED 由 pre-scanner (LedScanCursor) **独占** (2026-10-30).
//   以前只有「LED 提前量 != 0」时才交给 pre-scanner, 提前量为 0 时是 Player 直发 ——
//   两套逻辑 (亮灯时机 / 灭灯时机 / 亮度) 各写各的, 切一下开关行为就变.
//
//   现在统一: playback 源的事件**一律被抑制**, 灯带上的每一个音都由 pre-scanner
//   按「画面上的音条」来点 (提前量窗口渐亮 → 落键 100% → 弹过减半 → 音条消失就灭).
//   好处: 灯的语义只有一套, 跟提前量设成几没关系.
//
//   输入源 (用户按键) 和命中脉冲 (hit) 不受影响 —— 它们本来就该立刻亮.

import type { InputBus } from '../input/InputBus'
import type { NoteEvent, NoteSource } from '../types'

let _bus: InputBus | null = null
/**
 * StatusBar 触发的「灯条连接测试」回调. App 创建 LedController 时注册,
 * 让 StatusBar 不必直接拿到 ledRef 也能跑测试. 防止 prop-drilling.
 */
let _testPatternFn: (() => void | Promise<void>) | null = null

export function setLedBus(bus: InputBus | null) {
  _bus = bus
}

export function getLedBus(): InputBus | null {
  return _bus
}

/** App 在创建 LedController 时调一次, 退出时传 null. */
export function registerTestPattern(fn: (() => void | Promise<void>) | null) {
  _testPatternFn = fn
}

/** StatusBar 点击「测试」时调. 没注册就静默 no-op (LED 关着时不该报错). */
export function runLedTest(): Promise<void> {
  if (!_testPatternFn) return Promise.resolve()
  try {
    return Promise.resolve(_testPatternFn()).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

// playback 源的 LED 一律抑制 —— 播放层归 pre-scanner 独占 (见文件头注释).
// ★ 2026-11-01: 原来是个永远 return true 的函数 isPlaybackSuppressed(),
//   条件逻辑早就下沉到调用方了 —— 内联成常量, 别再留个假判断函数.
const PLAYBACK_SUPPRESSED = true

export function emitLedNoteOn(
  midi: number,
  source: NoteSource = 'playback',
  hand?: 'left' | 'right',
) {
  if (!_bus) return
  if (source === 'playback' && PLAYBACK_SUPPRESSED) return
  const e: NoteEvent = {
    type: 'down',
    midi,
    velocity: 1,
    t: performance.now(),
    source,
    hand,
  }
  _bus.emit(e)
}

export function emitLedNoteOff(
  midi: number,
  source: NoteSource = 'playback',
  hand?: 'left' | 'right',
) {
  if (!_bus) return
  if (source === 'playback' && PLAYBACK_SUPPRESSED) return
  const e: NoteEvent = {
    type: 'up',
    midi,
    t: performance.now(),
    source,
    hand,
  }
  _bus.emit(e)
}

/**
 * pre-scanner 用: 绕过 offset 抑制, 直接发 playback LED 事件.
 * 之所以需要这个, 是因为 emitLedNoteOn 在 offset != 0 时会被吃掉.
 */
export function emitLedPlaybackRaw(midi: number, on: boolean, hand?: 'left' | 'right') {
  if (!_bus) return
  const e: NoteEvent = on
    ? { type: 'down', midi, velocity: 1, t: performance.now(), source: 'playback', hand }
    : { type: 'up', midi, t: performance.now(), source: 'playback', hand }
  _bus.emit(e)
}

/**
 * 命中反馈脉冲 (spec P1-9).
 *
 * 与 playback 分开的独立通道:
 *  - 不受 LED 提前量 (offset) 抑制 —— 命中反馈必须永远看得见;
 *  - LedFollower 会在脉冲窗口到期后自动灭灯 (不影响其他源按住的灯).
 */
export function emitLedHit(midi: number, hand?: 'left' | 'right') {
  emitLedNoteOn(midi, 'hit', hand)
}

/**
 * 抢先模式的**提示灯** (spec §R23).
 *
 * 独立的源 —— 不受「跟随乐谱」开关和「只看输入/只看播放」过滤的影响:
 * 抢先的灯是「现在该弹哪一组」的状态投影, 跟声音的来源无关.
 */
export function emitLedLead(midi: number, on: boolean, hand?: 'left' | 'right') {
  if (!_bus) return
  const e: NoteEvent = on
    ? { type: 'down', midi, velocity: 1, t: performance.now(), source: 'lead', hand }
    : { type: 'up', midi, t: performance.now(), source: 'lead', hand }
  _bus.emit(e)
}
