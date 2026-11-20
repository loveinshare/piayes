// LED pre-scanner 的事件游标 (spec P1-15)
//
// 旧实现每帧从 i=0 全扫 song.notes, 而且每帧 new 两个 Set —— 长曲 (3000+ 音)
// 下 CPU 占用明显, 掉帧时反过来加剧 P1-2 的调度抖动.
//
// 这里改成"事件流 + 单调游标":
//   - 每个 note 产生两个事件: 开灯 (note.time - 提前量) 和灭灯 (note.time + 音条寿命);
//   - 事件按 (时刻, note 下标) 排序 —— 灭灯时刻**不随下标单调** (长音后面跟短音时
//     后面那个先灭), 所以不能简单地用一个下标游标, 必须先排好序.
//
// ── 灯的语义 (2026-10-30 重订, 2026-10-31 再订) ──────────────────────
//
// ★ 2026-10-31 用户要求 (「第一排只显示当前弹的或在跟弹模式下需要弹的那个」):
//
//   开灯 = note.time
//   灭灯 = **下一组音开始的时刻** (跟音条寿命 0.5s 取先到者)
//
// 「组」= **同一时刻的所有 note**. 同一时刻有两个音 (两只手同时按) 就是一组,
// 一起亮 —— 用户原话: 「有些谱子同一时间可能要按两个音, 所以只跟谱子当前
// 时间有几个音来看, 不是按和弦」.
//
// 为什么改: 以前灭灯只跟音条寿命走 (note.time + 0.5s) → 0.5 秒内落下的
// **好几个音**同时亮着 (用户报的「同时亮好几个音不对」). 现在一组亮着,
// 下一组开始就换 (灭旧的 + 点新的) —— 任何时刻最多只有**一组**灯亮着.
//
// ★ 跟弹模式 (wait) 不用额外处理: 跟弹卡住时歌曲时间**冻在**要弹的那个音
//   的精确时刻上 (Player.freezeAt), 下一组永远不会开始 → 灯一直亮着 ✓
//   「卡壳时明确知道当前该是什么」这个需求就满足了.
//
// ── 旧的语义 (2026-10-30, 已被上面取代) ─────────────────────────────
// 用户对灯带的定义: **灯 = 画面上那条正在落下来的音条**, 加一条提前量.
//
//   开灯 = note.time - 提前量        (提前量 > 0 时才提前; 负数 = 整段延后)
//   灭灯 = note.time + NOTE_BAR_LIFETIME_S
//   亮度 = 提前量窗口内从「刚亮」渐亮到 100%; 落键后未弹 = 100%, 弹过了 = 50%
//
// ★ 提前量已跟灯带**解耦** (2026-10-31 用户要求): 灯不再提前亮, 也不再渐亮 ——
//   App 那边固定传 0. 下面的渐亮代码留着 (以后要用再打开).
//   提前量现在**什么都不影响** —— 「提前按」这个独立模式已删 (2026-11-05).
//
// ★ 灭灯时刻改成「音条从画面上消失的那一刻」(note.time + 0.5s), 不再跟音符的
//   发声时值走. 以前灭灯跟发声时值走, 而且**用户没弹就推迟灭灯** —— 这两条
//   合起来就是用户报的「已经弹过的残留」: 一个没弹的音条会把灯一直留着.
//
// ★ 推迟灭灯整个删掉. 灯的寿命现在只由「音条在画面上活多久」决定 —— 用户
//   没弹那个键, 灯照样到点就灭. 想要「还没弹」的提示, 由画面上的音条 + 键盘
//   上的目标键颜色来承担, 不该由灯带承担 (灯带是「现在的音」, 不是「欠的账」).
//
// ── 提前量的语义 (2026-10-22 修正, 2026-10-30 再确认) ─────────────────
// 提前量**只平移开灯事件**; 提前量为负 (延后, 补偿链路延迟) 时**整段平移** ——
// 灯晚亮晚灭, 时长不变.
//
// 提前量**不再影响跟弹判定** —— 判定基准永远是 note.time (音符落键那一刻).
// 以前 Player 会把判定基准拉到「灯亮的那一刻」, 结果音符还悬在半空中就判命中了.
//
// ── 同一音高的多个 note (2026-10-22 修正) ─────────────────────────────
// 灯条是**每个键一个像素**, 但谱子里同一个 midi 可以出现很多次 (巴赫 BWV 846
// 右手全是十六分音符, C5/E5/G5 反复出现). 事件是"每个 note 一对开/灭",
// 但物理上只有一个像素 —— 于是:
//   - note A 开灯 → note B (同 midi) 开灯 → note A 灭灯 → **B 的灯被误灭**
//   - note A 的灭灯被"推迟" (用户没按) → note B 开灯 → 稍后 A 的补灭 → **B 被误灭**
// 两种都会让灯跟谱子对不上 (视觉上"乱闪").
//
// 修法: 游标按 **(midi, 手)** 记账 —— 每个 (midi, 手) 记"当前是哪个 note 占着灯".
//   - 新 note 开灯时, 若同 (midi, 手) 的旧 note 还占着灯 → 先发旧 note 的灭灯, 再发新的开灯
//     (follower 那边是按 (midi, source) 计数的, OFF→ON 同一帧内不会闪);
//   - 灭灯事件到达时, 若同 (midi, 手) 的灯已经被更新的 note 占了 → **直接忽略**
//     (旧 note 的灯位早就让出去了, 再灭一次就是误灭).
//
// ★ 为什么手也要算进键里 (2026-11-05):
//   灯条是**每个键一个像素**, 但两只手可以弹**同一个键** —— 巴赫 BWV 1041
//   (小提琴协奏曲) 的伴奏弦乐跟小提琴**同度齐奏**: 同一时刻同一个 midi,
//   右手 (小提琴) 和左手 (弦乐) 各一个 note.
//   以前只按 midi 记账 → 左手那个 note 开灯时把右手的灯位"抢"过去, 先发右手的
//   灭灯 —— 右手的灯闪一下就灭 (只开右手灯时最明显: 左手被关掉了, 抢到的
//   灭灯没人接管 → 灯直接黑掉).
//   按 (midi, 手) 记账 → 两只手是**两个灯位**, 互不抢占.
//
// 游标只增不减 —— seek 回退时调 reset() 重新走一遍.

import type { Hand, SongNote } from '../types'
import { NOTE_BAR_LIFETIME_S } from '../types'

export interface LedScanEvent {
  /** 目标时刻 (ms, 歌曲时间轴, 未含 offset) */
  t: number
  /** note 下标 */
  idx: number
  /** 该 note 的 midi —— 灯条按 midi 记账 */
  midi: number
  /** true = 开灯, false = 灭灯 */
  on: boolean
  /**
   * 该 note 的灭灯时刻 (ms, 歌曲时间轴).
   *
   * seekTo() 需要它来判断"这个 note 现在还在不在画面上" (灯该不该亮着).
   */
  endT?: number
}

/** 提前量窗口里, 灯刚亮时的亮度系数 (0..1) —— 不是 0: 完全不亮等于没有提示. */
export const RAMP_START_LEVEL = 0.15
/** 用户弹过这个音之后, 灯的亮度系数 (0..1) —— 「已经弹过了」. */
export const PLAYED_LEVEL = 0.5
/** 亮度量化档数 —— 渐亮过程按档发, 别每帧都改一次像素 (省 LED 流量). */
export const LEVEL_STEPS = 8

/** 把亮度系数量化到固定档数 (0..1). */
export function quantizeLevel(v: number): number {
  const q = Math.round(v * LEVEL_STEPS) / LEVEL_STEPS
  return q < 0 ? 0 : q > 1 ? 1 : q
}

/**
 * 灯位的键 —— **(midi, 手)**.
 *
 * 两只手弹同一个键时它们是**两个灯位** (见文件头的说明): 一个像素,
 * 但左右手各占一个位, 互不抢占.
 */
function slotKey(midi: number, hand: Hand | undefined): string {
  return `${midi}:${hand ?? ''}`
}

/**
 * 「歌曲时间倒退了」的判定容差 (秒).
 *
 * 正常推进时时间只增. 倒退只有一种来源: **跟弹模式冻结** —— 歌曲时间回退到
 * 「要弹的 note 的精确时间」, 幅度 = 一帧 (16ms). 曲首的 note 在 t=0 时
 * 回退幅度接近半个预览窗 (0.5s).
 */
export const LED_REWIND_EPS_S = 0.05

/**
 * 歌曲时间是不是**倒退了** (倒退幅度超过容差).
 *
 * 倒退时灯的游标必须跟着回退 (reset + 重走一遍), 否则灯停在回退前的那一组上 ——
 * 曲首第一个音就是这样丢掉的: 冻结把时间退回 t=0, 灯却还亮着第二个音,
 * 提示却说「要弹 c4」.
 *
 * @param nowS  当前歌曲时间 (秒)
 * @param lastS 上一次的时间 (秒) —— < 0 表示"还没有上一次" (刚开机 / 刚重置)
 */
export function isRewind(nowS: number, lastS: number): boolean {
  return lastS >= 0 && nowS < lastS - LED_REWIND_EPS_S
}

/**
 * 每个 note 所在「组」的结束时刻 (ms) —— 也就是**下一组开始的时刻**.
 *
 * 「组」= 同一时刻的所有 note (两只手同时按 = 一组, 一起亮).
 * 最后一组没有下一组 → Infinity (那组的灯由音条寿命管).
 *
 * 不假设谱面已排序: 先把所有不同的 time 收集出来排序.
 */
export function groupEndTimes(notes: SongNote[]): number[] {
  const times = Array.from(new Set(notes.map((n) => n.time))).sort((a, b) => a - b)
  const next = new Map<number, number>()
  for (let i = 0; i < times.length; i++) {
    next.set(times[i], i + 1 < times.length ? times[i + 1] : Infinity)
  }
  return notes.map((n) => next.get(n.time)! * 1000)
}

export class LedScanCursor {
  /** 开灯事件, 按 note.time 排序 (平移量恒定 → 顺序不变) */
  private ons: LedScanEvent[] = []
  /** 灭灯事件, 按灭灯时刻排序 */
  private offs: LedScanEvent[] = []
  private onPtr = 0
  private offPtr = 0
  /** (midi, 手) → 当前占着灯的 note 下标 */
  private litBy = new Map<string, number>()
  /**
   * 已经"退位"的 note 下标 —— 它们的灯位交给了更新的 note, 自己的灭灯事件
   * 到达时必须**忽略**.
   *
   * 为什么需要: 同一个 (midi, 手) 的 note A 退位给 note B 后, A 的灭灯事件才到达.
   * 此时 litBy 里已经没有 A (B 灭灯时把灯位删了) → 只看 litBy 判断不出来 →
   * 会多发一个灭灯 (follower 那边是按 (midi,source) 计数的, 多减一次计数就
   * 把下一个 note 的灯提前灭了 → "灯闪一下就灭").
   */
  private superseded = new Set<number>()
  /** note 下标 → 落键时刻 (ms) —— 算亮度渐变用 */
  private noteT: number[] = []
  /** note 下标 → midi (forEachLit 要报 midi) */
  private noteMidi: number[] = []
  /** note 下标 → 哪只手 (灯位键的一部分) */
  private noteHand: (Hand | undefined)[] = []

  constructor(notes: SongNote[]) {
    this.build(notes)
  }

  private build(notes: SongNote[]) {
    const ons: LedScanEvent[] = []
    const offs: LedScanEvent[] = []
    this.noteT = new Array(notes.length)
    this.noteMidi = new Array(notes.length)
    this.noteHand = new Array(notes.length)
    // 每组音的结束时刻 (下一组开始的时刻) —— 见文件头的语义说明.
    const groupEnd = groupEndTimes(notes)
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      const t = n.time * 1000
      // 灭灯 = 下一组开始 (换灯) 或 音条从画面上消失 (长休止) —— 取先到的.
      const endT = Math.min(groupEnd[i], t + NOTE_BAR_LIFETIME_S * 1000)
      this.noteT[i] = t
      this.noteMidi[i] = n.midiNote
      this.noteHand[i] = n.hand
      ons.push({ t, idx: i, midi: n.midiNote, on: true, endT })
      offs.push({ t: endT, idx: i, midi: n.midiNote, on: false })
    }
    // 同一时刻: 先按下标小的 (同 note 的开/灭不会同刻)
    const cmp = (a: LedScanEvent, b: LedScanEvent) =>
      a.t !== b.t ? a.t - b.t : a.idx - b.idx
    ons.sort(cmp)
    offs.sort(cmp)
    this.ons = ons
    this.offs = offs
  }

  /**
   * 回到起点 (seek 回退时用).
   *
   * @param emit 传了就顺便把当前亮着的灯灭掉 (重播/回退时必须灭 ——
   *              否则旧位置的灯会一直亮着, 而新的事件流又要点一次 → 闪).
   *              不传 = 只重置游标, 不动灯 (测试里用).
   */
  reset(emit?: (idx: number, on: boolean) => void) {
    if (emit) this.flush(emit)
    this.onPtr = 0
    this.offPtr = 0
    this.litBy.clear()
    this.superseded.clear()
  }

  /**
   * 跳到歌曲时间 t (秒) —— 游标重新对齐, 但**不重放**中间的事件.
   *
   * 跟 reset() 的区别: reset 回到 0, seekTo 回到任意位置.
   * 跳过去的那段区间里的 note 不再发开/灭事件 (它们的灯本来就没亮过).
   *
   * 跳转时还在画面上的 note (刚落的音条) 灯**要亮着** —— 音条还在, 灯就该亮.
   * 所以这里要把跨越 t 的 note 重新点一遍.
   *
   * @param t       目标歌曲时间 (秒)
   * @param offsetMs LED 提前量 (ms) —— 开灯时刻要减去它.
   *   ★ 2026-10-31 起固定传 0 (提前量已跟灯带解耦).
   * @param emit    发灯事件
   */
  seekTo(t: number, offsetMs: number, emit: (idx: number, on: boolean) => void) {
    const tMs = t * 1000
    // 重置游标到 "所有时刻 <= tMs 的事件都已处理"
    this.onPtr = 0
    this.offPtr = 0
    while (this.onPtr < this.ons.length && this.ons[this.onPtr].t <= tMs) this.onPtr++
    while (this.offPtr < this.offs.length && this.offs[this.offPtr].t <= tMs) this.offPtr++
    this.litBy.clear()
    this.superseded.clear()
    // 还在画面上的 note → 灯亮着
    for (const e of this.ons) {
      if (e.t > tMs) break
      if (e.endT === undefined || e.endT <= tMs) continue
      this.litBy.set(slotKey(e.midi, this.noteHand[e.idx]), e.idx)
      emit(e.idx, true)
    }
    void offsetMs
  }

  /** 还没处理的事件数 (调试) */
  get remaining(): number {
    return (
      Math.max(0, this.ons.length - this.onPtr) +
      Math.max(0, this.offs.length - this.offPtr)
    )
  }

  /**
   * 立刻灭掉游标点亮的**所有**灯, 并清空内部状态.
   *
   * 什么时候用: 播放**停下来**的时候 (暂停 / 曲终 / 切歌).
   *
   * 为什么需要: 播放层的 LED 由 pre-scanner 独占 (Player 的 playback 事件被
   * emit.ts 抑制了), 所以灯只有 pre-scanner 能灭.
   */
  flush(emit: (idx: number, on: boolean) => void) {
    for (const [, idx] of this.litBy) {
      emit(idx, false)
    }
    this.litBy.clear()
    this.superseded.clear()
  }

  /**
   * 推进到 nowMs, 吐出到期的开/灭事件.
   *
   * @param nowMs   当前歌曲时间 (ms)
   * @param offsetMs LED 提前量 (正 = 提前, 负 = 延后).
   *   ★ 2026-10-31 起**固定传 0** —— 提前量已跟灯带解耦 (用户要求):
   *   灯不再提前亮, 也不再渐亮. 参数留着是为了以后想打开时不用改签名.
   * @param emit    (idx, on) => 真正发 LED 事件
   */
  advance(
    nowMs: number,
    offsetMs: number,
    emit: (idx: number, on: boolean) => void,
  ) {
    // 提前量为正 → 只提前开灯, 灭灯跟着音条走.
    // 提前量为负 (延后) → 整段平移, 保持灯的时长不变.
    const offShift = Math.min(offsetMs, 0)
    for (;;) {
      const onT =
        this.onPtr < this.ons.length ? this.ons[this.onPtr].t - offsetMs : Infinity
      const offT =
        this.offPtr < this.offs.length ? this.offs[this.offPtr].t - offShift : Infinity
      // 同刻: 开灯先
      const takeOn = onT <= offT
      const fireT = takeOn ? onT : offT
      if (fireT === Infinity || fireT > nowMs) break
      if (takeOn) {
        const e = this.ons[this.onPtr++]
        this.lightUp(e, emit)
        continue
      }
      const e = this.offs[this.offPtr++]
      this.lightDown(e, emit)
    }
  }

  /** 开灯: 同 (midi, 手) 的旧 note 若还占着灯, 先让它退位 */
  private lightUp(e: LedScanEvent, emit: (idx: number, on: boolean) => void) {
    const key = slotKey(e.midi, this.noteHand[e.idx])
    const prevIdx = this.litBy.get(key)
    if (prevIdx !== undefined && prevIdx !== e.idx) {
      // 旧 note 让位 —— 顺带把它的灯位标记为退位
      this.litBy.delete(key)
      this.superseded.add(prevIdx)
      emit(prevIdx, false)
    }
    this.litBy.set(key, e.idx)
    emit(e.idx, true)
  }

  /**
   * 灭灯: 若同 (midi, 手) 的灯已被更新的 note 占了 → 忽略.
   *
   * ★ 不再「推迟灭灯」—— 灯的寿命只由音条决定, 用户没按也到点就灭.
   */
  private lightDown(e: LedScanEvent, emit: (idx: number, on: boolean) => void) {
    // 这个 note 的灯位早就交给更新的 note 了 → 这次灭灯是"旧账", 不能再灭一次
    if (this.superseded.has(e.idx)) return
    const key = slotKey(e.midi, this.noteHand[e.idx])
    const owner = this.litBy.get(key)
    if (owner !== undefined && owner !== e.idx) return
    this.litBy.delete(key)
    emit(e.idx, false)
  }

  /**
   * 当前亮着的音 —— (midi, note 下标).
   *
   * 上层用它算每个音当前的亮度 (渐亮 / 弹过减半).
   *
   * 两只手弹同一个键时这个 midi 会出现两次 (两个灯位) —— 上层按 midi 设亮度,
   * 重复设同一个值无所谓.
   */
  forEachLit(fn: (midi: number, idx: number) => void) {
    for (const [, idx] of this.litBy) fn(this.noteMidi[idx], idx)
  }

  /**
   * 某个亮着的音当前的亮度系数 (0..1).
   *
   * - 还在提前量窗口里 (音符还没落键): 从 RAMP_START_LEVEL 线性渐亮到 1;
   * - 已落键: 用户还没弹 → 1 (正常亮度); 弹过了 → PLAYED_LEVEL (半亮).
   *
   * @param nowMs     当前歌曲时间 (ms)
   * @param offsetMs  LED 提前量 (ms)
   * @param isPlayed  (idx) => 用户是否已经弹过这个音
   */
  levelOf(
    idx: number,
    nowMs: number,
    offsetMs: number,
    isPlayed: (idx: number) => boolean,
  ): number {
    const t = this.noteT[idx]
    if (t === undefined) return 1
    if (offsetMs > 0 && nowMs < t) {
      // 提前量窗口里: 进度 0 (刚亮) → 1 (落键)
      const p = (nowMs - (t - offsetMs)) / offsetMs
      const clamped = p < 0 ? 0 : p > 1 ? 1 : p
      return RAMP_START_LEVEL + (1 - RAMP_START_LEVEL) * clamped
    }
    return isPlayed(idx) ? PLAYED_LEVEL : 1
  }
}
