// LED follower: subscribes to a callback that yields NoteEvents, batches them
// per requestAnimationFrame, and dispatches to LedController.
//
// rAF batching keeps WebSocket traffic bounded even when many keys are
// pressed per second. Off events get a small grace period to avoid flicker
// from fast retriggers (MIDI note_on(velocity=0) and real note_off racing).

import type { Hand, NoteEvent, NoteSource } from '../types'
import type { LedController, LedMode, LedColors, HandHint } from './LedController'

export type FollowSource = 'both' | 'input' | 'playback'

/** 命中反馈脉冲的持续时长 (ms) */
const HIT_PULSE_MS = 150

/**
 * 同一 (midi, source) 下按着的 note 状态.
 *
 * `count` 是必需的: 同一个音高可以在**同一只手**里先后/重叠出现
 * (e.g. 巴赫 BWV 846 前奏曲左手 C4 反复出现, 前一个音还没结束下一个就开始).
 * 旧实现只记"按着/没按着" —— 前一个音的 NoteOff 会把后一个音的灯灭掉,
 * 表现就是「灯闪一下就灭」.
 *
 * `hands` 记的是**每只手各按着几个** —— 两只手可以同时按同一个键
 * (巴赫 BWV 1041 伴奏齐奏: 左手弦乐和右手小提琴同度同刻).
 * 只记一个手色的话, 重画 (改亮度 / 切模式 / 开关某只手的灯) 时会用
 * **最后那个手色**去点灯 —— 那只手要是被关掉了, 另一只手的灯就丢了.
 */
interface PressedSource {
  /** 每只手按着几个 note (键 = 手色, undefined = 手别未知) */
  hands: Map<Hand | undefined, number>
  /** 还按着的 note 数 */
  count: number
}

/**
 * 多个源里所有还在按着的手 (去重).
 *
 * 有明确手色的优先 —— 手色全都不明时才回退到 undefined (让控制器自己按
 * 谱子/模式推手).
 */
function pickHands(bySource: Map<NoteSource, PressedSource>): (Hand | undefined)[] {
  const defined = new Set<Hand>()
  let hasUnknown = false
  for (const s of bySource.values()) {
    for (const h of s.hands.keys()) {
      if (h === undefined) hasUnknown = true
      else defined.add(h)
    }
  }
  if (defined.size > 0) return [...defined]
  return hasUnknown ? [undefined] : []
}

export interface LedFollowerOpts {
  led: LedController
  /** Returns true when LED should follow (UI gate). */
  isEnabled: () => boolean
  /** How long after note_off to actually send off, in ms. */
  offGraceMs?: number
  /** 跟随源: 'input' / 'playback' / 'both'. 默认 both. */
  followSource?: FollowSource
}

export class LedFollower {
  private opts: LedFollowerOpts
  /**
   * midi → (源 → 按住状态). 真在响的.
   *
   * 多源追踪 (spec P1-9): 同一个 midi 可以同时被 input 和 playback 点亮 ——
   * 旧实现只记 midi, 任一源的 up 都会把灯熄掉, 另一源还需要的灯就消失了.
   *
   * 同源多重 (2026-10-22): 同一个 midi 在**同一源**下可以先后出现多个 note
   * (巴赫 BWV 846 左手 C4 每小节重复) —— 必须记**计数**, 否则前一个 note 的
   * NoteOff 会把后一个 note 的灯灭掉.
   */
  private pressed = new Map<number, Map<NoteSource, PressedSource>>()
  /** 'hit' 脉冲的定时器 —— midi → timer */
  private hitTimers = new Map<number, number>()
  private pendingOff = new Map<number, number>() // note -> timer
  private rafId: number | null = null
  private dirty = false
  /** 暂停时显示的「下一组」音 (用户定位键位用). 跟 pressed 互不冲突. */
  private previewed = new Map<number, 'left' | 'right' | undefined>()
  private followSource: FollowSource
  /**
   * 挂起中 —— 「测试」跑马灯期间用.
   *
   * 跑马灯是 LED 的独占动画: 如果这时按键 / 预览 / 播放还在往灯带写, 就会
   * 在跑马过程中突然冒出别的灯 (用户报的「跑的时候其他灯还乱删/乱闪」).
   * 挂起期间仍然记录 pressed/previewed (状态不能丢), 只是不往灯带写;
   * resume() 时 repaint() 一次把该亮的补回来.
   */
  private suspended = false

  constructor(opts: LedFollowerOpts) {
    this.opts = { offGraceMs: 60, ...opts }
    this.followSource = opts.followSource ?? 'both'
  }

  /** Pass this to InputBus as a handler. */
  handleEvent = (e: NoteEvent) => {
    if (!this.opts.isEnabled()) return
    const src: NoteSource = e.source ?? 'input'
    // 跟随源过滤: 让用户能选「只看输入」「只看播放」「都看」
    // 'hit' 是命中反馈脉冲 —— 不受过滤, 用户最想看到的就是它
    // 'lead' 是抢先模式的提示灯 —— 也不受过滤 (它是「该弹哪个」的状态投影,
    //   不是声音; 「只看输入」的用户照样要看它)
    if (src !== 'hit' && src !== 'lead' && this.followSource !== 'both') {
      if (this.followSource === 'input' && src !== 'input') return
      if (this.followSource === 'playback' && src !== 'playback') return
    }
    if (src === 'hit') {
      this.handleHit(e)
      return
    }
    if (e.type === 'down') {
      // 取消 pending off (可能是快速 retrigger)
      const t = this.pendingOff.get(e.midi)
      if (t !== undefined) {
        clearTimeout(t)
        this.pendingOff.delete(e.midi)
      }
      let bySource = this.pressed.get(e.midi)
      if (!bySource) {
        bySource = new Map()
        this.pressed.set(e.midi, bySource)
      }
      const prev = bySource.get(src)
      const hands = prev?.hands ?? new Map<Hand | undefined, number>()
      hands.set(e.hand, (hands.get(e.hand) ?? 0) + 1)
      bySource.set(src, { hands, count: (prev?.count ?? 0) + 1 })
      // 真在响的音 > 预览, 覆盖预览位置
      this.previewed.delete(e.midi)
      // 挂起中 (测试跑马灯) 只记状态, 不写灯带 —— resume 时统一重画.
      if (!this.suspended) {
        this.opts.led.noteOn(e.midi, e.hand)
        this.dirty = true
        this.scheduleShow()
      }
    } else if (e.type === 'up') {
      const bySource = this.pressed.get(e.midi)
      if (bySource) {
        const cur = bySource.get(src)
        if (cur) {
          // 这只手少按一个 (手色 → 计数)
          const n = cur.hands.get(e.hand) ?? 0
          if (n <= 1) cur.hands.delete(e.hand)
          else cur.hands.set(e.hand, n - 1)
          if (cur.count > 1) {
            // 同一个音高在**同一源**下还有别的 note 在响 —— 别灭, 计数减一
            cur.count--
            if (!this.suspended) {
              // ★ 2026-11-10: 同键两手 (BWV 1041 伴奏齐奏) —— 这只手松了,
              //   但**另一只手**还按着同一个键 → 只灭这只手, 灯别整个灭掉.
              //   这只手还有别的源按着 → 重新点一下 (幂等, 灯不变).
              if (this.handsHolding(e.midi).has(e.hand)) {
                this.opts.led.noteOn(e.midi, e.hand)
              } else {
                this.opts.led.noteOff(e.midi, e.hand)
              }
              this.dirty = true
              this.scheduleShow()
            }
            return
          }
          bySource.delete(src)
        }
        if (bySource.size > 0) {
          // 还有别的源按着 —— 别灭, 用剩下的源的手色重发一次 (spec P1-9)
          if (!this.suspended) {
            for (const h of pickHands(bySource)) this.opts.led.noteOn(e.midi, h)
            this.dirty = true
            this.scheduleShow()
          }
          return
        }
      }
      if (this.suspended) {
        // 挂起中松手: 没有灯要灭 (跑马灯已经清屏), 记账即可, 别留 timer.
        this.pressed.delete(e.midi)
        return
      }
      const existing = this.pendingOff.get(e.midi)
      if (existing !== undefined) clearTimeout(existing)
      const doOff = () => {
        this.pendingOff.delete(e.midi)
        this.pressed.delete(e.midi)
        // 如果是预览位置, 灯别灭 (用户还要看键位)
        // 命中脉冲正在亮时也别灭 —— 脉冲比 grace 长, 灭了脉冲就没了 (2026-10-22)
        if (!this.previewed.has(e.midi) && !this.hitTimers.has(e.midi)) {
          this.opts.led.noteOff(e.midi, e.hand)
        }
        this.dirty = true
        this.scheduleShow()
      }
      // ★ 2026-10-31: grace 只留给**输入源**.
      //
      // grace 的用途是压真实键盘的 note_on(velocity=0) / note_off 竞态闪烁.
      // 播放源 (pre-scanner) 的灭灯是**精确**的 —— 下一组已经在同一帧点亮了,
      // 再等 60ms grace 会让「两组灯」同时亮着 (用户: 不能同时亮好几个音).
      const graceMs = src === 'input' ? (this.opts.offGraceMs ?? 0) : 0
      if (graceMs <= 0) {
        doOff()
        return
      }
      const timer = window.setTimeout(doOff, graceMs)
      this.pendingOff.set(e.midi, timer)
    }
  }

  /**
   * 命中反馈脉冲 (spec P1-9): 亮 HIT_PULSE_MS 后自己灭.
   *
   * 不参与 pressed 集合 —— 用户自己按着 (input 源) 时不灭灯,
   * 否则会把“他手按着的键”弄烂。
   *
   * 同理: **播放源还在响**时也不能灭灯 (2026-10-22).
   * 旧实现只查 `bySource.has('input')` —— 跟弹时左手长音还在放 (playback 源),
   * 用户弹对 → 命中脉冲 150ms 后把灯灭了, 但音还在响 → 表现为"灯闪一下就灭".
   */
  private handleHit(e: NoteEvent) {
    if (this.suspended) return
    if (e.type !== 'down') return
    const prev = this.hitTimers.get(e.midi)
    if (prev !== undefined) clearTimeout(prev)
    this.opts.led.noteOn(e.midi, e.hand)
    const timer = window.setTimeout(() => {
      this.hitTimers.delete(e.midi)
      const bySource = this.pressed.get(e.midi)
      // 还有别的源按着 (input 或 playback) / 这个音还是预览目标 → 灯不能灭
      const stillHeld =
        (bySource !== undefined && bySource.size > 0) ||
        this.previewed.has(e.midi)
      if (!stillHeld) this.opts.led.noteOff(e.midi, e.hand)
      this.dirty = true
      this.scheduleShow()
    }, HIT_PULSE_MS)
    this.hitTimers.set(e.midi, timer)
    this.dirty = true
    this.scheduleShow()
  }

  /**
   * 这个 midi 现在还有哪些手按着 (所有源合起来).
   *
   * 用来判断「松了这只手之后, 灯还要不要留着」——
   * 同键两手 (巴赫 BWV 1041 伴奏齐奏) 时, 一只手松了另一只手还按着 →
   * 灯不能灭.
   */
  private handsHolding(midi: number): Set<Hand | undefined> {
    const out = new Set<Hand | undefined>()
    const bySource = this.pressed.get(midi)
    if (!bySource) return out
    for (const cur of bySource.values()) {
      for (const h of cur.hands.keys()) out.add(h)
    }
    return out
  }

  /** Call on disable / unmount to clear strip + timers. */
  shutdown() {
    this.suspended = true
    for (const t of this.pendingOff.values()) clearTimeout(t)
    for (const t of this.hitTimers.values()) clearTimeout(t)
    this.pendingOff.clear()
    this.hitTimers.clear()
    this.pressed.clear()
    this.previewed.clear()
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.rafId = null
  }

  /**
   * 挂起 / 恢复 (测试跑马灯期间用).
   *
   * 挂起时照常记录 pressed / previewed, 但不往灯带写; 等跑马灯跑完再 repaint
   * 一次. 这样跑马过程中不会突然冒出按键灯 / 预览灯 (「其他灯乱闪」).
   */
  suspend() {
    if (this.suspended) return
    this.suspended = true
    // 把已经到期的“灭灯”记账掉 —— 否则 resume 会把这些音又点亮.
    for (const [midi, t] of this.pendingOff) {
      clearTimeout(t)
      this.pressed.delete(midi)
    }
    this.pendingOff.clear()
    for (const t of this.hitTimers.values()) clearTimeout(t)
    this.hitTimers.clear()
  }

  /** 恢复跟随: 把挂起期间该亮的键重新点上. */
  resume() {
    if (!this.suspended) return
    this.suspended = false
    this.repaint()
  }

  /** 立即按内部状态重画一次 (重连后 / 测试结束后用). */
  refresh() {
    if (this.suspended) return
    this.repaint()
  }

  /**
   * 暂停时显示「下一组」音. 多个 midi 一起传 (e.g. 同一时刻的 chord).
   * 不会影响 pressed (真在响的); 真在响的优先级更高, 会覆盖预览同位置.
   * 接受 [{midi, hand}] 列表, 跟 LedController.noteOn 的 hand 参数对齐 — 同 midi 在两只手时按各自手色.
   */
  setPreview(notes: Array<{ midi: number; hand?: 'left' | 'right' }>) {
    const newPreviewed = new Map<number, 'left' | 'right' | undefined>()
    for (const { midi, hand } of notes) newPreviewed.set(midi, hand)
    const old = this.previewed
    this.previewed = newPreviewed
    // 挂起中: 只记状态, 不写灯带 (resume 时统一 repaint).
    if (this.suspended) return
    // 旧预览里不在新集合也不在 pressed 的: 灭
    for (const [n] of old) {
      if (this.pressed.has(n)) continue
      if (newPreviewed.has(n)) continue
      this.opts.led.noteOff(n)
    }
    // 新预览: 不在 pressed 的点亮
    for (const [midi, hand] of newPreviewed) {
      if (this.pressed.has(midi)) continue
      this.opts.led.noteOn(midi, hand)
    }
    this.dirty = true
    this.scheduleShow()
  }

  clearPreview() {
    const old = this.previewed
    this.previewed = new Map()
    if (this.suspended) return
    for (const [n] of old) {
      if (this.pressed.has(n)) continue
      this.opts.led.noteOff(n)
    }
    this.dirty = true
    this.scheduleShow()
  }

  /** Re-apply brightness (e.g. after slider change). */
  setBrightness(b: number) {
    this.opts.led.setBrightness(b)
    // 重画当前按住的 (亮度改变立刻可见)
    this.repaint()
  }

  /** 跟弹模式切换: 立刻重画当前按住的键. */
  setMode(mode: LedMode) {
    this.opts.led.setMode(mode)
    this.repaint()
  }

  /** song.pitchSplit 变了 (加载新歌): 立刻重画. */
  setSplit(midiNote: number) {
    this.opts.led.setSplit(midiNote)
    this.repaint()
  }

  /** 谱子的手查表变了 (加载新歌): 立刻重画. */
  setHandMap(map: Map<number, HandHint> | null) {
    this.opts.led.setHandMap(map)
    this.repaint()
  }

  /**
   * 手别开关 (首页的两个勾选框): 左手 / 右手的灯分别开关.
   *
   * 关掉一只手 → 控制器把它当前亮着的灯**静默**全灭, 之后这只手的音不点灯.
   * 开回来 → 这里负责把**还按着的**键重新点上 (控制器只知道现在亮着什么,
   * 不知道谁按着).
   */
  setHandEnabled(hand: 'left' | 'right', enabled: boolean) {
    this.opts.led.setHandEnabled(hand, enabled)
    this.repaint()
  }

  /** 4 色调色板变了: 立刻重画. */
  setColors(patch: Partial<LedColors>) {
    this.opts.led.setColors(patch)
    this.repaint()
  }

  /** 校准开关: 中央 C 常亮白. */
  setCalibrate(enabled: boolean) {
    this.opts.led.setCalibrate(enabled)
  }

  /** 跟随源切换: 'both' / 'input' / 'playback'. 切了之后清掉不匹配的灯. */
  setFollowSource(src: FollowSource) {
    if (this.followSource === src) return
    const prev = this.followSource
    this.followSource = src
    // 从 input 单源 ↔ playback 单源: 清掉不匹配的当前灯
    if (prev !== 'both' && src !== 'both') {
      for (const t of this.pendingOff.values()) clearTimeout(t)
      for (const t of this.hitTimers.values()) clearTimeout(t)
      this.pendingOff.clear()
      this.hitTimers.clear()
      for (const [n] of this.pressed) this.opts.led.noteOff(n)
      this.pressed.clear()
      this.opts.led.allOff()
      this.dirty = true
      this.scheduleShow()
    }
  }

  /** 立即全清 (供跳转/重启时调用). */
  clearAll() {
    for (const t of this.pendingOff.values()) clearTimeout(t)
    for (const t of this.hitTimers.values()) clearTimeout(t)
    this.pendingOff.clear()
    this.hitTimers.clear()
    this.pressed.clear()
    this.previewed.clear()
    this.opts.led.allOff()
    this.dirty = true
    this.scheduleShow()
  }

  private repaint() {
    if (this.suspended) return
    for (const [note, bySource] of this.pressed) {
      // 两只手按着同一个键 → 两边都要点 (关掉的那只被控制器挡掉, 不影响另一只)
      for (const h of pickHands(bySource)) this.opts.led.noteOn(note, h)
    }
    for (const [note, hand] of this.previewed) {
      if (this.pressed.has(note)) continue
      this.opts.led.noteOn(note, hand)
    }
    this.dirty = true
    this.scheduleShow()
  }

  private scheduleShow() {
    // 挂起中不该有任何灯带写入 (show 也算) —— 测试跑马灯要独占灯带.
    if (this.suspended) return
    if (this.rafId !== null) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      if (this.dirty) {
        this.dirty = false
        this.opts.led.show().catch(() => {})
      }
    })
  }
}
