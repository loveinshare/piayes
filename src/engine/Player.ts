// Player 主循环
// 参考:
//  - sightread 主循环结构
//  - piano-booster 路由
//  - neothesia PlayAlong (本目录 PlayAlong.ts)
//
// 每帧 (16ms):
// 1. update PlayAlong (expire recent presses)
// 2. 冻结判定 → 若 effectiveWait && required 非空, 不推进, return
// 3. 推进 currentTime (考虑 speed + loop wrap)
// 4. 调度本帧应发声的 note (按路由: MIDI Out / 浏览器合成 / silent)
//    - 每个 active-hand NoteOn 都调 playAlong.fileNoteOn (early-hit 自动处理)
// 5. 收尾已结束的 note — 同步调 playAlong.fileNoteOff (miss 检测)
// 6. 节拍器 / 歌曲结束 / emitTick
//
// 路由:
//  - playback: 全 → MIDI Out (无电钢时 fallback synth)
//  - both:     全 silent (用户自己弹)
//  - left:     右手 → MIDI Out, 左手 → silent
//  - right:    左手 → MIDI Out, 右手 → silent
//
// MIDI Out 路由快照: play() 时拍下 acc.isEnabled(), 整段播放期不再重问 (防双声抖动).
// 设备真掉 → onDisconnect → App 暂停 + 弹重连弹窗.

import type { Song, SongNote, NoteEvent } from '../types'
import { NOTE_BAR_LIFETIME_S } from '../types'
import {
  useStore,
  type PracticeHand,
  isActiveHand,
  goesToMidiOut,
  effectiveWait,
  effectiveLead,
} from '../store'
import { resolveHand } from '../hand'
import { Synthesizer } from './Synthesizer'
import { Accompaniment } from './Accompaniment'
import { PlayAlong } from './PlayAlong'
import { Metronome } from './Metronome'
import { Countdown, type CountdownStep } from './Countdown'
import { SongClock } from './Clock'
import { Scheduler } from './Scheduler'
import { TempoMap, measureBeatPoints, hasVariableTimeSignature, type BeatPoint } from '../util/tempoMap'
import type { LeadHint, LeadHandHint } from '../led/leadStrip'

const FRAME_MS = 16

/**
 * lookahead 排程窗口 (秒) —— spec P1-2.
 * 定时器只负责"唤醒", 音符提前排到 AudioContext 的时间轴上, 声音才不受主线程抖动影响.
 */
const LOOKAHEAD_S = 0.12

/**
 * 冻结点最大回退量 (秒) —— spec P2-10.
 *
 * 冻结时理想是把歌曲时间回退到"卡住用户的那个 note 的精确时间", 让画面/声音
 * 回到跟曲谱对齐的位置. 但回退太多会很难受 (e.g. 曲子开头的 0.5s 预览窗,
 * 从 0.6s 倒回 0s —— 画面和声音"倒跳", 体感像卡死).
 * 超过这个阈值就不回退, 改成把 note 的判定基准对齐到冻结点 (PlayAlong.rebaseRequired).
 *
 * ★ 例外: 预览窗**里**的 note 允许大幅回退 (见 freezeAt) —— 预览窗把冻结
 *   推迟了半秒, 不回退的话灯组已经翻到下一个音, 曲首第一个音就永远对不上.
 */
const MAX_REWIND_S = 0.1

/**
 * wait 模式开头的"预览窗" (秒) —— 这段时间里**不冻结**, 让用户先看清谱子.
 *
 * 冻结判定里写死了 `currentTime > 0.5`, 但那个 0.5 是硬编码的, 跟
 * "第一个 note 的时间"没有绑定. 副作用: 开头的短音 (noteOff 早于 0.5s)
 * 会在预览窗里被 fileNoteOff + grace 过期 → 升级成 miss → 第一个音
 * "不会被追踪和要求跟弹". 这里把预览窗做成常量, 判定和记账都用它.
 */
const PREVIEW_WINDOW_S = 0.5

/**
 * 节拍器排程窗口 (秒) —— spec P2-15.
 * 拍点提前排到 AudioContext 时间轴上, 主线程抖动不会让节拍器跑偏.
 */
const METRONOME_LOOKAHEAD_S = 0.12

/**
 * 抢先模式的「同一组」容差 (秒) —— 同一时刻的 note 算一组 (和弦一起亮).
 *
 * 谱面里同一时刻的 note 时间是**完全相等**的 (同一个 tick 换算出来的),
 * 这里留一点余量, 免得浮点误差把一组劈成两组.
 */
const LEAD_EPS_S = 1e-6

/**
 * 抢先模式 (单手路径): 玩家拿到一个音之后, 有多久之内按下去都算命中 (ms).
 *
 * ★ 2026-11-08 这个窗口**删掉了** —— 抢先模式不再用「超时」推进游标:
 *   灯一直亮到弹对为止 (用户 2026-11-08: 「必定是正确按下后才会灭掉」).
 *   匹配也**不再看时间** —— 只认「当前待弹的那一组」(见 leadPress).
 */

function routeFor(
  noteH: SongNote['hand'],
  track: number,
  songHands: { left: number; right: number },
  practiceHand: PracticeHand,
  routeAccSnapshot: boolean,
): 'midiOut' | 'synth' | 'silent' {
  if (practiceHand === 'both') return 'silent'
  const toMidiOut = goesToMidiOut(noteH, track, songHands, practiceHand)
  if (toMidiOut) {
    if (routeAccSnapshot) return 'midiOut'
    return 'synth'
  }
  return 'silent'
}

export class Player {
  private timer: number | null = null
  private currentTime = 0
  private currentNoteIndex = 0
  private frozen = false

  /**
   * 开头的预览窗 (PREVIEW_WINDOW_S) 是否已经**用掉**.
   *
   * 第一次冻结会把歌曲时间**回退**到要弹的 note 的精确时间 (曲首的 note 常常
   * 在 t=0) —— 回退之后 currentTime 又 < 0.5s. 预览窗要是还在, 歌曲就会再往前走
   * 0.5s 才冻, 变成"一个 note 一个 note 地等". 用掉之后冻结才是即时的.
   */
  private previewDone = false

  /** noteIndex → 仍在响的 note (用于 noteOff 同步 fileNoteOff) */
  private playingNotes = new Map<number, SongNote>()
  /** 用户已正确弹过的 noteIndex */
  private hitNoteIndices = new Set<number>()
  /**
   * 抢先模式: **每只手一个游标** (下一只该弹的 note 下标, -1 = 还没定位/收工).
   *
   * 抢先模式 = Wait + 「弹对了才推进」 (docs/spec-2026-10-20-code-audit.md §R23):
   *  - 每只手各有一个「现在该弹的音」;
   *  - 弹对 → **那只手**的游标往前挪一个, 另一只手不动;
   *  - 没弹对 → 灯一直亮着 (不超时自动跳, 不报错).
   *
   * 为什么每只手一个游标: 两只手是两条独立的线 —— 右手弹快了不该把左手的
   * 提示也换掉 (用户 2026-11-08: 「右手的ui下落音符可以提前按照正确的顺序点亮」).
   */
  private leadCursor: Record<'left' | 'right', number> = { left: -1, right: -1 }
  /**
   * 抢先模式: 每只手当前待弹的那一组音 (note 下标).
   *
   * 组 = 同一时刻的所有 note (和弦) —— 整组弹全了才推进.
   */
  private leadGroup: Record<'left' | 'right', number[]> = { left: [], right: [] }
  /** 抢先模式: 每只手待弹组的谱面时间 (秒) */
  private leadGroupTime: Record<'left' | 'right', number> = { left: 0, right: 0 }
  /** 抢先模式: 每只手是不是已经弹完了 (没有待弹音了) */
  private leadDone: Record<'left' | 'right', boolean> = { left: false, right: false }
  /** 抢先模式: 灯带提示 (每只手一份) */
  private leadHint: LeadHint | null = null
  /** 抢先模式上一帧是否生效 —— 用来发现「刚开 / 刚关」的迁移. */
  private leadActive = false
  /** 抢先模式上次看到的手别 —— 手别变了游标要重新定位. */
  private leadHandSnapshot: PracticeHand = 'right'
  /**
   * 抢先模式里被**手动跳过**的 note (Backspace).
   *
   * 跳过时既不进 hitNoteIndices (不算命中) 也不记漏弹 —— 但必须记在这里,
   * 否则游标重新定位时 (切手别 / 开关模式) 这些音会「复活」, 又要求你弹一遍.
   */
  private leadSkipped = new Set<number>()
  /**
   * 抢先模式: 游标**定位**的基准时间 (秒).
   *
   * 定位只发生一次 (模式刚开 / 刚跳转) —— 从这个时间往后找该手第一个
   * 该弹的音. 用它而不是「当前播放头」: 曲首第一个音常常在 t=0,
   * 用当前播放头会把它跳过去.
   */
  private leadBaseTime = 0
  /** 命中集合版本号 —— getNoteStates() 缓存用 (spec P1-15) */
  private hitVersion = 0
  /** getNoteStates() 的缓存 + 版本 (spec P1-15) */
  private noteStatesCache = new Map<number, 'hit' | 'miss' | 'late'>()
  private noteStatesVersion = -1
  /**
   * 跳转后待补发 NoteOn 的跨界持续音 (spec P1-6).
   *
   * seek 之后 player 可能处于暂停态 (暂停时按方向键跳位置), 这时立刻发声会变成
   * "UI 显示暂停、电钢在响" (同 P0-1). 所以先记账, 等真的开始播放时再发.
   */
  private pendingAnnounce: number[] = []
  /** 用户按下的 midi (键盘可视化用) */
  private pressedNotes = new Set<number>()

  private lastTickStoreTime = 0

  private countdown: Countdown
  private countdownStep: CountdownStep | null = null

  /** 路由快照: play() 时拍, 不再每帧重问 acc.isEnabled() */
  /**
   * In-flight previewNotes() setTimeout id, used by cancelPreviewNotes() so
   * pause()/seek() can immediately release the preview instead of leaving
   * the synth stuck on a stray note.
   */
  private _previewTimer: number | null = null
  /**
   * 预览里还没释放的 MIDI Out note.
   * MIDI Out 侧没有 stopAll 兜底 (synth 有), 必须自己记账 ——
   * 否则只 clearTimeout 的话电钢上那个键会一直压住 (spec P0-3).
   */
  private _previewMidiOutNotes: SongNote[] = []
  /** 预览里还没释放的 synth voice (midi 已含 transpose, id 是预览专用负数) */
  private _previewSynthVoices: { midi: number; id: number }[] = []
  /** 预览 voice 的 id 分配器 —— 负数, 保证不跟 song note 下标撞 */
  private _previewVoiceSeq = 0
  /** 预览临时改写的 acc.transpose 原值 —— 取消预览时必须还原 (spec P0-3) */
  private _previewPrevTrans: number | undefined = undefined

    private routeAccSnapshot = false

  /** 跟弹状态机 */
  private playAlong = new PlayAlong()

  /**
   * 歌曲时钟 (spec P1-3) —— 锚在 AudioContext 上, 不再自己累加.
 * 没有 AudioContext 时 (测试 / ctx 被挂起) 自动退化成逻辑时钟.
   */
  private clock: SongClock

  /**
   * 上一帧的墙钟时间 (ms) —— 算"这一帧真的过了多久"用.
   *
   * ★ 2026-11-06: 逻辑时钟退路 (ctx 没跑起来时) 必须按**真实经过的时间**推进,
   *   不能按"假定定时器每 16ms 跑一次"推进 —— 浏览器会把**后台标签页**的定时器
   *   压到 1s 一次 (Edge 实测 0.5 次/秒), 按 16ms 累加的话整首曲子会慢 30~125 倍.
   */
  private lastFrameMs: number | null = null

  /**
   * 上一帧的实测间隔 (秒) —— lookahead 要跟着它放大 (后台标签页里定时器 1s 一次).
   */
  private frameIntervalS = FRAME_MS / 1000

  /** lookahead 排程器 (spec P1-2) */
  private scheduler: Scheduler

  /** tempo map (spec P2-3) —— 变速时小节线 / 节拍器 / 判定窗口跟着走 */
  private tempoMap: TempoMap

  /**
   * 节拍器排程游标 —— 下一个待排的拍号 (spec P2-15).
   * 用游标而不是"每帧算 floor(currentTime / secPerBeat)": 前者能把拍点
   * **提前**排到音频时间轴上, 后者只能"到了才响", 主线程一卡就晚半拍.
   */
  private metronomeBeatCursor = 0

  /**
   * 变拍曲子的拍网格 —— 按每小节自己的拍号切的 (null = 整首一个拍号, 走老的连续拍网格).
   *
   * 「梦中的婚礼」是 4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8 的变拍, 用全曲固定的
   * 四分音符网格的话, 6/8 小节里的拍点会跟小节线错开 (节拍器打在拍子中间).
   */
  private beatPoints: BeatPoint[] | null = null

  /**
   * 跟弹记账游标 —— 严格按 note 的**精确时间**推进 (spec P1-3).
   *
   * 音频可以提前排程 (lookahead), 但记账必须等到 note 真正到点:
   *  - 判定窗口要跟 note.time 对齐, 不能跟"排程时刻"对齐;
   *  - 模式切换 (playback → practice) 时, 提前排程过的 note 也要按**新**模式记账 ——
   *    否则切到跟弹模式后那个音永远不会被 required, wait 模式就冻不住.
   */
  private bookkeepingIndex = 0

  /** noteIndex → 排程时算出来的路由 (midiOut / synth / silent).
   *  记下来是因为 note-off 必须发回**当初发声的那个出口** —— 中途切模式的话
   *  重新算 route 会把 MIDI Out 的音交给 synth 去关, 设备上就卡键了. */
  private noteRoutes = new Map<number, 'midiOut' | 'synth' | 'silent'>()

  constructor(
    private song: Song,
    private synth: Synthesizer,
    private acc: Accompaniment,
    private metronome: Metronome,
    countdown: Countdown,
    private onNoteOn: (n: SongNote, hit: boolean) => void = () => {},
    private onNoteOff: (n: SongNote) => void = () => {},
    clock?: SongClock,
  ) {
    this.countdown = countdown
    // 没有 AudioContext 时 (单测里 synth 是 stub) 走逻辑时钟, 行为跟改造前一致
    this.clock = clock ?? new SongClock({ ctx: synth.getCtx?.() ?? null })
    // 时钟的倍速跟 store 对齐 (spec P1-3) —— 否则第一帧会按 1× 走,
    // 之后才被 stepLoop 的 setSpeed 纠正, 曲头会差半个帧.
    this.clock.setSpeed(useStore.getState().speed)
    this.scheduler = new Scheduler(song.notes)
    this.tempoMap = new TempoMap(song.bpms, song.timeSignature.denominator)
    if (hasVariableTimeSignature(song.measures, song.timeSignature)) {
      this.beatPoints = measureBeatPoints(
        song.measures,
        song.timeSignature,
        (t) => this.tempoMap.secPerQuarterAt(t),
      )
    }
    // MIDI Out 需要 ctx 才能把"过去的排程时刻"夹到现在 (spec P1-2)
    this.acc.attachContext?.(this.clock.context)
  }

  getCurrentTime() {
    return this.currentTime
  }

  /**
   * 直接把歌曲时间设到 t (不动跟弹状态机 / 统计 / 排程游标).
   *
   * 正常流程走 seek(); 这个只给"把状态机摆到某个时刻"的场景用 (测试、
   * 以及将来可能的"从某处继续"这类交互). 歌曲时间现在归 clock 管, 所以这里
   * 必须连锚点一起重设, 否则下一帧就被 clock 拉回去了.
   */
  setSongTime(t: number) {
    this.currentTime = t
    this.clock.anchor(t)
  }

  /**
   * lookahead 排程窗口 (秒).
   *
   * wait 模式例外 —— 冻结时会把正在响的伴奏全部掐掉 ("让电钢安静下来"),
   * 提前排程的音会被误杀, 所以 wait 模式退回"到达即发声".
   *
   * 抢先模式的单手路径例外 —— 那里**不冻结** (伴奏保持 1× 原速),
   * 伴奏按 16ms 帧量化发声会有可听的抖动 → 照常开 lookahead.
   *
   * ★ 2026-11-06: 窗口要**跟着定时器的实际间隔**放大. 浏览器把后台标签页的
   *   定时器压到 1s 一次时, 120ms 的窗口只够排 1/8 的音 → 中间全是空档,
   *   听着像"卡住了". 窗口 ≥ 一个定时器周期, 音频才是连续的.
   */
  private lookaheadFor(practiceHand: PracticeHand, waitMode: boolean, cursorDriven: boolean): number {
    if (cursorDriven) return this.adaptiveLookahead(LOOKAHEAD_S)
    if (practiceHand !== 'playback' && waitMode) return 0
    return this.adaptiveLookahead(LOOKAHEAD_S)
  }

  /** lookahead 至少要覆盖一个定时器周期 —— 否则后台标签页里音频会断断续续 */
  private adaptiveLookahead(base: number): number {
    return Math.max(base, this.frameIntervalS * 1.5 + 0.05)
  }

  /** 曲谱在 t 时刻的速度 (bpm) —— 判定窗口按它缩放 (spec P1-5) */
  private bpmAt(t: number): number {
    return this.tempoMap.bpmAt(t)
  }

  /**
   * 短暂预览一段 note (用于 ←/→/↑/↓ 跳转后让用户「听到」位置).
   * 跟正式播放走同一套 routeFor — 单手模式下 active-hand note 不发声 (用户要弹),
   * 非 active-hand 走 MIDI Out (伴奏). 修 #19: 之前 preview 无差别全发, 让 right 模式
   * 下跳到左手伴奏时电钢也响, 跟「单手模式的那一手不发」的设计冲突.
   * 不影响 playAlong 评分; 时长 250ms 然后 stop.
   */
  previewNotes(notes: SongNote[], durationMs = 250) {
    if (notes.length === 0) return
    this.cancelPreviewNotes()
    const transpose = useStore.getState().transpose
    const practiceHand = useStore.getState().hand
    const useMidiOut = useStore.getState().midiOutputId !== null
    const routeAcc = this.routeAccSnapshot
    // 按 route 拆分: midiOut 走 acc, silent 直接跳过, synth 走浏览器
    const midiOutNotes: SongNote[] = []
    const synthNotes: SongNote[] = []
    for (const n of notes) {
      const r = routeFor(n.hand, n.track, this.song.hands, practiceHand, routeAcc)
      if (r === 'midiOut') midiOutNotes.push(n)
      else if (r === 'synth') synthNotes.push(n)
      // silent: active-hand note, 不该让电钢发声 — 跳过
    }
    let prevTrans: number | undefined
    if (midiOutNotes.length > 0 && useMidiOut) {
      prevTrans = this.acc.transpose
      this.acc.transpose = transpose
      for (const n of midiOutNotes) this.acc.sendNoteOn(n)
    }
    if (synthNotes.length > 0) {
      this.synth.resume()
      for (const n of synthNotes) {
        const id = -++this._previewVoiceSeq
        this.synth.playNote(n, transpose, id)
        this._previewSynthVoices.push({ midi: n.midiNote + transpose, id })
      }
    }
    // 记账 —— 取消预览时要能把这批 note 完整释放 (spec P0-3)
    this._previewMidiOutNotes = useMidiOut ? midiOutNotes : []
    this._previewPrevTrans = prevTrans
    this._previewTimer = window.setTimeout(() => {
      this._previewTimer = null
      this.releasePreviewNotes()
    }, durationMs)
  }

  /**
   * 释放预览期间发出去的音 + 还原 acc.transpose.
   * 幂等 —— 重复调用安全 (预览超时和 stopSounds() 都会走这里).
   */
  private releasePreviewNotes() {
    // NoteOff 必须在还原 transpose **之前** 发 —— sendNoteOff 用的是 acc.transpose
    for (const n of this._previewMidiOutNotes) this.acc.sendNoteOff(n)
    if (this._previewPrevTrans !== undefined) this.acc.transpose = this._previewPrevTrans
    for (const v of this._previewSynthVoices) this.synth.stopNote(v.midi, v.id)
    this._previewMidiOutNotes = []
    this._previewSynthVoices = []
    this._previewPrevTrans = undefined
  }

  /**
   * 取消进行中的预览: 清定时器 + **立即补发 NoteOff / 停 synth / 还原 transpose**.
   *
   * 旧实现只 clearTimeout —— MIDI Out 侧没人兜底, 电钢上那个键会一直压住,
   * 直到下一次 panic 或切换设备 (spec P0-3). 注释曾声称会 release, 实现里却没有,
   * 现已对齐.
   */
  cancelPreviewNotes() {
    if (this._previewTimer !== null) {
      window.clearTimeout(this._previewTimer)
      this._previewTimer = null
    }
    this.releasePreviewNotes()
  }


  getPressedNotes() {
    return this.pressedNotes
  }

  getPlayingNotes() {
    return new Set(this.playingNotes.values())
  }

  isFrozen() {
    return this.frozen
  }

  /**
   * Wait 模式下, 当前冻在哪个 note 上 (UI 高亮用).
   * 返回 required 中第一个 (按 song.notes 顺序) active-hand note.
   */
  getWaitTarget(): SongNote | null {
    // 抢先模式: **不冻结**, 但「现在该弹哪个」还是要给 UI ——
    // 琴键上的琥珀色高亮是谱面不跟玩家走之后唯一的提示.
    // 取待弹组里**最早**的那个 (两只手各弹各的, 高亮只能给一个).
    if (this.leadEnabled()) {
      let best: SongNote | null = null
      for (const hand of this.leadPracticeHands()) {
        const group = this.leadGroup[hand]
        if (group.length === 0) continue
        const n = this.song.notes[group[0]]
        if (!best || n.time < best.time) best = n
      }
      return best
    }
    if (!this.frozen) return null
    const practiceHand = useStore.getState().hand
    const required = new Set(this.playAlong.requiredIndices())
    // 正向扫 —— 取 required 里**最早**的那个 active-hand note.
    //
    // 以前是往回扫 (取最近一个): 预览窗里会攒下好几个 required note
    // (曲首第一个 note + 第二个 note), 往回扫就把提示报成了第二个音 ——
    // 用户看到「提示要弹 c4」还是对的, 但灯已经翻到 e4, 两边对不上.
    // 用户要先弹的是**最早**那个, 提示 / 灯 / 判定必须指同一个 note.
    for (let i = 0; i < this.bookkeepingIndex; i++) {
      if (!required.has(i)) continue
      const n = this.song.notes[i]
      if (!isActiveHand(n.hand, n.track, this.song.hands, practiceHand)) continue
      return n
    }
    return null
  }

  /** 给 UI 上色. key = noteIndex */
  /**
   * 当前 PlayAlong 里 required 的 noteIndex 快照. LED pre-scanner 用来判断「还没按下的键」,
   * 对这类 note 不触发 LED off (等用户按了再正常走).
   */
  getRequiredIndices(): ReadonlySet<number> {
    return this.playAlong.requiredIndices()
  }

  /**
   * Per-note scoring state. Snapshot of (hit note indices) U (currently-required indices).
   *
   * 缓存 + 版本号 (spec P1-15): 命中集合 / required 集合变了才重建.
   * (之前的缓存尝试挂在"required 在 stepLoop 里变、不过 markHit"上 —— 现在改成
   *  版本号: required 侧用 PlayAlong.requiredVersion, 命中侧用 hitVersion,
   *  两者相加做 key, 任何一侧变了都会重建.)
   */
  getNoteStates(): Map<number, 'hit' | 'miss' | 'late'> {
    const version = this.hitVersion + this.playAlong.requiredVersion
    if (version !== this.noteStatesVersion) {
      const out = new Map<number, 'hit' | 'miss' | 'late'>()
      for (const idx of this.hitNoteIndices) out.set(idx, 'hit')
      for (const idx of this.playAlong.requiredIndices()) out.set(idx, 'late')
      this.noteStatesCache = out
      this.noteStatesVersion = version
    }
    return this.noteStatesCache
  }

  isCountingDown() {
    return this.countdownStep !== null
  }

  syncVolume() {
    const v = useStore.getState().volume
    this.synth.setMasterVolume(v * 0.8)
    this.acc.setVolume(v)
    // 节拍器音量跟随主音量 (spec P1-16) —— 以前 setVolume 定义了但全项目无调用点,
    // 把音量拉到 0 节拍器照样全速全响.
    this.metronome.setVolume(v * 0.5)
  }
  syncTranspose() {
    this.acc.transpose = useStore.getState().transpose
  }

  play(wantCountdown?: boolean) {
    if (this.timer !== null) return
    this.synth.resume()
    this.routeAccSnapshot = this.acc.isEnabled()
    const doStart = () => {
      if (this.timer !== null) return
      // 起播前重新锚定时钟 —— 暂停期间 ctx 一直在走, 不重锚会补一大段 (spec P1-3)
      this.clock.anchor(this.currentTime)
      // 倍速跟着 store 走 (spec P1-3) —— 暂停期间用户可能改过倍速
      this.clock.setSpeed(useStore.getState().speed)
      // 帧间隔从"现在开始"算 —— 暂停期间的时间不算.
      this.lastFrameMs = performance.now()
      this.timer = window.setInterval(() => this.stepLoop(this.frameDeltaSeconds()), FRAME_MS)
      // 暂停时跳转过来的跨界持续音, 到真的开始播才发声 (spec P1-6)
      this.announceNotes()
      useStore.getState().setIsPlaying(true)
    }
    const useCd = wantCountdown ?? useStore.getState().useCountdown
    if (useCd) {
      this.countdown.start(() => doStart())
    } else {
      doStart()
    }
  }

  /**
   * 停止一切发声, 但**不动播放状态机** (定时器 / isPlaying).
   *
   * pause() = stopSounds() + 停定时器 + setIsPlaying(false)
   * seek({ keepPlaying: true }) = stopSounds() + 重置游标
   *
   * 循环回卷必须走后者: 旧实现在回卷时先 pause() 再重启定时器, 但 pause() 会
   * setIsPlaying(false) 且没人把它设回 true —— UI 显示「暂停」而音乐仍在响.
   * (见 docs/spec-2026-10-20-code-audit.md P0-1)
   */
  private stopSounds() {
    this.frozen = false
    this.countdown.cancel()
    this.countdownStep = null
    // 先取消预览 —— 它会还原 acc.transpose, 后面发 playing note 的 NoteOff
    // 才能用回「发 NoteOn 时」的同一个 transpose (spec P0-3)
    this.cancelPreviewNotes()
    const st = useStore.getState()
    const practiceHand = st.hand
    // transpose 统一取 store 的值 —— acc.transpose 是 MIDI 侧状态, 两者可能漂移,
    // 用它算 synth 音高会停错音 → 卡音 (spec P1-17)
    const transpose = st.transpose
    for (const [idx, n] of [...this.playingNotes]) {
      // 用**排程时**的路由 —— 中途切过模式的话, 重新算会把 MIDI Out 的音
      // 交给 synth 去关, 设备上就卡键了 (spec P1-2).
      // 与 stepLoop 收尾逻辑保持一致.
      const route = this.noteRoutes.get(idx) ?? routeFor(n.hand, n.track, this.song.hands, practiceHand, this.routeAccSnapshot)
      if (route === 'midiOut') this.acc.sendNoteOff(n)
      else if (route === 'synth') this.synth.stopNote(n.midiNote + transpose, idx)
      // 灯还没亮的 note 不用灭 —— lookahead 提前排程但还没到点的 note 压根没亮过
      if (idx < this.bookkeepingIndex) this.onNoteOff(n) // 通知 LED 跟随等次要订阅者: 灯要灭
    }
    this.synth.stopAll()
    this.playingNotes.clear()
    this.noteRoutes.clear()
    this.pendingAnnounce = []
    st.setFrozenWaiting(false)
  }

  pause() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.stopSounds()
    // MIDI Out 侧也要真的安静下来 —— 语义对齐 stopSounds() 里的 synth.stopAll().
    // 踩着延音踏板时, 逐个 NoteOff 不足以让电钢停 (踏板会继续维持), 所以补一发
    // CC#120 (All Sound Off). 放在 pause() 而不是 stopSounds() 里, 是因为循环
    // 回卷也走 stopSounds() —— 每圈都掐一次会把用户自己按住的音也切掉 (spec P0-4).
    this.acc.silence()
    useStore.getState().setIsPlaying(false)
  }

  restart(wantCountdown?: boolean) {
    this.seek(0)
    this.play(wantCountdown)
  }

  /**
   * 跳到 t.
   * @param opts.keepPlaying   循环回卷用: 不停定时器、不改 isPlaying
   * @param opts.preserveScore 循环回卷用: 保留已命中集合与统计, 避免第二遍重复计分
   */
  seek(t: number, opts: { keepPlaying?: boolean; preserveScore?: boolean } = {}) {
    if (opts.keepPlaying) this.stopSounds()
    else this.pause()
    this.currentTime = Math.max(0, Math.min(t, this.song.duration))
    // 重新锚定歌曲时钟 —— 跳转后 song↔ctx 的映射要跟着重算 (spec P1-3)
    this.clock.anchor(this.currentTime)
    // 判定窗口按当前速度缩放 (spec P1-5)
    this.playAlong.setTempo(this.bpmAt(this.currentTime))
    this.currentNoteIndex = this.song.notes.findIndex(
      (n) => n.time >= this.currentTime,
    )
    if (this.currentNoteIndex === -1) this.currentNoteIndex = this.song.notes.length
    // 排程游标跟着重置 —— 否则会漏掉跳转点之前该发的音
    this.scheduler.reset(this.currentNoteIndex)
    // 记账游标同步重置 (spec P1-3) —— 跟弹状态从跳转点重新开始
    this.bookkeepingIndex = this.currentNoteIndex
    this.noteRoutes.clear()
    if (opts.preserveScore) {
      // 只清「本轮」的跟弹状态 (required / recent / inProgress), 保留 stats.
      // hitNoteIndices 也保留 —— 第二遍就不会把第一遍弹过的音重新要求一遍,
      // hits 因此不会重复累加 (spec P0-2).
      this.playAlong.resetPass()
    } else {
      this.playAlong.clear()
      this.hitNoteIndices.clear()
      this.hitVersion++
    }
    this.pressedNotes.clear()
    this.frozen = false
    // 抢先模式: 位置变了 → 两只手的游标都要重新定位
    this.resetLeadState()
    // 跳过记录也清掉 (跳转 = 新的一轮)
    this.leadSkipped.clear()
    // 跳转 = 新的一轮 → 开头的预览窗重新生效
    this.previewDone = false
    // 节拍器游标跟着跳转 (spec P2-15) —— 否则跳转后会补响一大串旧拍
    this.resetMetronomeCursor()
    // 补跨界持续音 (spec P1-6, 同 sightread player.ts:764-766):
    // note.time < t < note.time + duration 的音在跳转点**还在响**, 不补的话
    // 用户听到的是"断了一截" —— 灯也不亮、乐也不响.
    // 结束时间用 note.time + duration (绝对曲谱时间), stepLoop 的收尾逻辑照常工作.
    const crossing: number[] = []
    for (let i = 0; i < this.song.notes.length; i++) {
      const note = this.song.notes[i]
      if (note.time >= this.currentTime) break // notes 按时间有序
      if (this.currentTime < note.time + note.duration) crossing.push(i)
    }
    for (const idx of crossing) this.playingNotes.set(idx, this.song.notes[idx])
    this.pendingAnnounce = crossing
    // 还在播 (循环回卷) → 立刻补发 NoteOn; 暂停态 → 等 play() 再发
    if (this.timer !== null) this.announceNotes()
    // 立刻把新位置推到 store, 暂停时 UI (FallingNotes) 也要立刻跟着挪
    useStore.getState().setCurrentTime(this.currentTime)
  }

  /**
   * 补发跨界持续音的 NoteOn (P1-6) —— 逻辑与 stepLoop 里的调度一致:
   * 按路由发声 + 跟弹记账 + 通知 LED.
   */
  private announceNotes() {
    if (this.pendingAnnounce.length === 0) return
    const idxs = this.pendingAnnounce
    this.pendingAnnounce = []
    const s = useStore.getState()
    const practiceHand = s.hand
    const isPractice = practiceHand !== 'playback'
    const transpose = s.transpose
    const routeAcc = this.routeAccSnapshot
    for (const idx of idxs) {
      const note = this.song.notes[idx]
      if (!note) continue
      const route = routeFor(note.hand, note.track, this.song.hands, practiceHand, routeAcc)
      // 精确的发声时刻 —— 跨界音此刻就要响, 所以 when 落在过去, 由 synth/acc 夹到现在
      const when = this.clock.toCtxTime(note.time) ?? undefined
      if (route === 'midiOut') this.acc.sendNoteOn(note, when)
      else if (route === 'synth') this.synth.playNote(note, transpose, idx, when)
      this.noteRoutes.set(idx, route)
      if (isPractice && !this.leadEnabled()) {
        // 抢先模式: required 由**游标**管 (游标指到哪个音才要求哪个) ——
        // 这里再登记一遍会跟游标打架 → 那个音有两个判定基准 → 永远判不中.
        const active = isActiveHand(note.hand, note.track, this.song.hands, practiceHand)
        if (active && !this.hitNoteIndices.has(idx)) {
          // 判定基准用 note 的**精确时间**, 不用帧时间 ——
          // 帧时间是 16ms 量化过的, seek 之后按帧时间算会把跨界音判偏.
          // (主路径 stepLoop 走的是 note.time * 1000, 这里要一致)
          const res = this.playAlong.fileNoteOn(
            idx,
            note.midiNote,
            note.time * 1000,
          )
          if (res === 'early-matched') this.markHit(idx, -this.playAlong.perfectWindow())
        }
      }
      this.onNoteOn(note, false) // 灯要亮
    }
  }

  /**
   * 输入处理.
   * - 始终更新 pressedNotes (键盘可视化用)
   * - playback 模式: 不参与评分
   * - practice 模式 (wait 是否启用都可):
   *   1. userPress 按 midi 查 required, 命中 → 'late' / 'wrong' / 'recent-only'
   *   2. 'late' → markHit 每个命中; 'wrong' → addError
   *
   * 简化: 不再预筛 candidates — PlayAlong.userPress 内部按 midi 直接查 (neothesia 同款).
   * 这样 wait 模式在 active-hand 边界 bug 时也能直接解冻, 不依赖 Player 侧.
   */
  handleInput(e: NoteEvent) {
    // ★ 修 #7 根因: Player.onNoteOn/Off → emitLedNoteOn/Off → bus.emit → handler 又回到这里.
    // 播放事件 (source='playback') 不该被 Player 当成用户输入 — 否则 userPress 会
    // 命中自己刚入 required 的 note, 立即删 + playedDelta++, wait 模式永远冻不住.
    if (e.source === 'playback') return
    // 'lead' 是抢先模式的**提示灯**事件 (App 发) —— 不是用户输入.
    // 不挡的话: 提示灯一亮 → handleInput 把它当成玩家按了 → 白送一个命中.
    if (e.source === 'lead') return
    if (e.type === 'down') {
      this.pressedNotes.add(e.midi)
    } else {
      this.pressedNotes.delete(e.midi)
      return
    }
    const s = useStore.getState()
    const practiceHand = s.hand
    if (practiceHand === 'playback') return

    // ★ 抢先模式: 走**自己的**匹配路径, 不碰 PlayAlong.userPress.
    //
    // userPress 会去查 PlayAlong.recent —— 那是「按早了先记着, 等文件 NoteOn
    // 来结算」的机制. 抢先模式不需要它, 而且它正是用户报的 bug 的根源:
    //   - recent 里有上一轮弹过的键 → 这一次按别的键会被判成 'wrong' → 弹错误提示;
    //   - recent 里的旧键还会被「检索」回来, 误命中这一轮的音.
    // 抢先模式只认「当前待弹的那一组」—— 不看时间 (不受容差影响), 不报错.
    if (this.leadEnabled()) {
      this.leadPress(e.midi)
      return
    }

    // 用输入事件的**硬件时间戳**换算回歌曲时间 (spec P1-3).
    // 旧实现用"事件被处理的那一刻"(currentTime): 事件在浏览器队列里等了多久,
    // 判定误差就有多大 —— 主线程忙的时候能差 10~50ms, 用户明明弹准了却被判早/晚.
    // 硬件时间戳不受这个影响; 没有音频时钟时 pressSongTime 退化成 currentTime.
    const songMs = this.clock.pressSongTime(e.t) * 1000
    const result = this.playAlong.userPress(e.midi, songMs)
    if (result.kind === 'late') {
      // 只 mark hit active-hand 的; 非 active hand 让 required 留着 (因为 userPress 内部没过滤 active)
      for (const idx of result.matched) {
        const n = this.song.notes[idx]
        if (!isActiveHand(n.hand, n.track, this.song.hands, practiceHand)) {
          // 非 active hand 误删了? 放回 required (其实因为 userPress 已删, 重新加)
          this.playAlong.requireNote(idx, n.midiNote, songMs)
          continue
        }
        this.markHit(idx, result.dtMs)
      }
    } else if (result.kind === 'wrong') {
      s.addError()
      // wait 模式下: 用户反复试错是正常探索, 不该弹 wrong toast 干扰 (toast 是为了 playback / wait=false 时
      // 告诉用户"你按错了", 但 wait 模式本身就 frozen 在等你弹对, 弹错视觉/听觉已经很明显了).
      const waitMode = effectiveWait(practiceHand, s.wait)
      if (!waitMode) s.setLastWrong(e.midi)
    }
    // 'recent-only': 等文件 NoteOn 来 (early-hit 由 PlayAlong.fileNoteOn 命中)
  }

  private markHit(idx: number, dtMs: number) {
    const note = this.song.notes[idx]
    this.hitNoteIndices.add(idx)
    this.hitVersion++
    // 抢先模式: 一律算命中 (不分早/晚) —— 抢先的前提就是「提前按」,
    // 玩家跟谱面时间轴的偏差是**设计如此**, 不是失误 (用户 2026-11-08:
    // 「允许我提前按按键但是不进行报错」). 所以 dt 记 0 → 算 perfect.
    const absMs = this.leadEnabled() ? 0 : Math.abs(dtMs)
    const s = useStore.getState()
    // 3 档: 阈值按当前 bpm 缩放 (spec P1-5) —— 慢板相对误差更大, 窗口也更大
    if (absMs < this.playAlong.perfectWindow()) s.addPerfect()
    else if (absMs < this.playAlong.goodWindow()) s.addGood()
    // else: 晚补 / 偏差 > 100ms, 不算 perfect/good, 只算 hit (late 状态, UI 染 late 色)
    s.addHit()
    s.bumpStreak()
    this.onNoteOn(note, true)
  }

  /**
   * 两次 tick 之间真实经过的时间 (秒).
   *
   * 为什么要真实时间 (2026-11-06): 浏览器会把**后台标签页 / 被遮挡的窗口**的
   * 定时器压到 1s 一次 (Edge 实测 0.5 次/秒). 定时器只是"唤醒", 歌曲时间必须
   * 按真实经过的时间推进 —— 否则在后台标签页里整首曲子会慢 30~125 倍
   * (16ms/次 × 0.5 次/秒). ctx 跑起来时不受影响 (主时钟是音频时钟).
   */
  private frameDeltaSeconds(): number {
    const now = performance.now()
    // lastFrameMs 用 null 表示"还没有上一帧" —— 不能拿 0 当哨兵:
    // 页面刚打开时 performance.now() 本来就可能是 0, 那样第一帧会退回
    // 名义帧长 (16ms), 后面每一帧的间隔也跟着算错.
    const dt =
      this.lastFrameMs !== null ? (now - this.lastFrameMs) / 1000 : FRAME_MS / 1000
    this.lastFrameMs = now
    this.frameIntervalS = dt
    return dt
  }

  /**
   * 单步推进.
   *
   * @param dtOverride 这一帧**真实**经过的时间 (秒).
   *   - 生产路径: 定时器回调把 `frameDeltaSeconds()` 传进来 —— 定时器被浏览器
   *     压慢时 (后台标签页 1s 一次), 歌曲时间仍按真实时间推进, 不会慢几十倍.
   *   - 测试路径: 不传 → 按名义帧长 (16ms) 推进, 便于确定性地步进.
   */
  stepLoop(dtOverride?: number) {
    // 兜底: 若有 seek 后待补发的跨界音, 在这里补上
    this.announceNotes()
    this.synth.resume()
    // 判定窗口按当前速度缩放 (spec P1-5) —— 变速/变拍号的曲子要跟着变
    this.playAlong.setTempo(this.bpmAt(this.currentTime))
    const s = useStore.getState()
    const speed = s.speed
    // 倍速必须同步进歌曲时钟 (spec P1-3).
    // 旧实现靠 `dt = FRAME_MS/1000 * speed` 累加歌曲时间, 倍速天然生效;
    // 换成锚在 AudioContext 上的 SongClock 之后, 歌曲时间由 ctx 推导 ——
    // clock 内部的 speed 不跟着改的话, **倍速滑块会完全失效** (永远 1× 播).
    // setSpeed() 内部会按当前歌曲位置重新锚定, 换速那一帧不会跳变.
    this.clock.setSpeed(speed)
    // 输出延迟补偿 (spec P1-3) —— -1 表示用自动检测值
    this.clock.setLatencyCompensation(s.latencyAuto ? -1 : s.latencyOffsetMs)
    // 检测到的输出延迟同步给 UI (设置面板里显示) —— 值不变时 store 内部会跳过
    s.setOutputLatencyMs(this.clock.outputLatencyMs())
    const practiceHand = s.hand
    const isPractice = practiceHand !== 'playback'
    const waitMode = effectiveWait(practiceHand, s.wait)
    // 抢先模式 = Wait + 「弹对了才推进」 (依赖 Wait —— Wait 关掉就失效)
    const leadMode = effectiveLead(practiceHand, s.wait, s.leadNext)
    // 抢先模式的状态迁移 (刚开 / 刚关 / 手别变了)
    this.syncLeadModeState(leadMode)
    const transpose = s.transpose
    const loopRange = s.loopRange
    const routeAcc = this.routeAccSnapshot

    // ── 时间推进 (spec P1-3) ──────────────────────────────────
    // 歌曲时间不再自己累加 —— 直接锚在 AudioContext 时钟上, 主线程卡顿不会传导到音乐.
    // 上一帧是冻结的 → 先重新锚定, 否则 ctx 时时钟会把冻结期间的时间一次性补回来.
    if (this.frozen) this.clock.anchor(this.currentTime)
    // dt = 这一帧**真实**经过的时间 (逻辑时钟退路靠它; 音频时钟模式忽略它).
    const dtWall = dtOverride ?? FRAME_MS / 1000
    const dt = dtWall * speed
    const prevTime = this.currentTime

    // 抢先模式倍率恒为 1 (2026-11-10: 恢复冻结 → 冻住了就没法加速;
    // 2026-11-08 的「UI 跟着玩家速度走」那一路整个作废).
    this.clock.setRate(1)

    this.currentTime = this.clock.advance(dt)

    // 每帧 expire recent + 把 grace 过期的 required 升级为真正 miss (修短音 bug)
    const prevMiss = this.playAlong.stats.miss
    this.playAlong.update(this.currentTime * 1000)
    const newMisses = this.playAlong.stats.miss - prevMiss
    if (newMisses > 0) {
      for (let i = 0; i < newMisses; i++) {
        s.addMiss()
        s.resetStreak()
      }
    }

    // ── 判定基准 + wait 冻结 ────────────────────────────────────
    // ★ 2026-10-30: 判定基准**永远**是 note.time (音符落键那一刻).
    //
    // 以前 Player 会把记账时刻和判定基准一起提前到「灯亮的那一刻」
    // (note.time - 提前量), 结果音符还悬在半空中就判命中了 ——
    // 用户报的「跟弹有 bug, 悬在半空中的也触发了」.
    //
    // 现在提前量只做两件事:
    //   1. 灯提前亮起并渐亮 (纯视觉提示) —— 见 src/led/scanCursor.ts;
    //   2. 在这段窗口里用户**提前按**也算数 (按下被记住, 落键时结算).
    //
    // ★ 2026-11-05: 「提前按」这个独立模式已经被删掉 (跟「抢先」二选一,
    //   用户选了抢先) → recent 的过期窗口回到命中窗口本身.
    this.playAlong.setEarlyWindowMs(0)
    // 记账时刻 = note.time —— 音符落键那一刻才进 required (才触发冻结).
    // (抢先模式的跳转在下面 —— 跳完要重算, 见 syncLead 之后那行)
    let bookHorizon = this.currentTime

    // 冻结判定: effectiveWait && required 非空 → 不推进, 但 emitTick 让 UI 同步
    // 前 0.5s 强制不冻 — 给用户半秒预览再开始卡 (e.g. Chopin 开篇 t=0 持续音
    // 立即冻会让用户啥也没听到就被卡住, 体感"wait 完全没工作")
    //
    // previewDone: 预览窗被**第一次**冻结用掉之后就不再等了 ——
    // 冻结会把时间回退到 note 的精确时间 (可能 < 0.5s), 预览窗要是还在,
    // 歌曲就会又往前走 0.5s 才冻, 一个 note 一个 note 地磨.
    //
    // ★ 抢先模式**跳过**预览窗: 抢先要「一个音一个音」精确推进, 预览窗会让
    //   开头 0.5s 的好几个 note 一起进 required → 用户得一口气弹完才动.
    //
    // ★ 抢先模式**也冻结** (2026-11-10 修订): 冻结点 = 游标指到的待弹组.
    //   2026-11-08 那一版整个关掉了冻结 (播放头一直走) —— 结果是瀑布跟提示
    //   永远对不上, 而且 Wait 变成空壳. 用户要的是「停下来对」.
    //   抢先不往 PlayAlong.required 里登记 → 冻结点只能自己算 (leadFreezeTarget).
    if (isPractice && waitMode) {
      const canFreeze =
        this.previewDone || this.currentTime > PREVIEW_WINDOW_S || this.frozen
      if (leadMode) {
        const target = this.leadFreezeTarget()
        // 播放头到点了 (或已经在冻结中) → 冻在待弹组的**精确**谱面时间上
        if (target !== null && canFreeze && this.currentTime >= target - LEAD_EPS_S) {
          this.freezeAt(practiceHand, transpose, routeAcc, prevTime, target)
          // 冻结把 currentTime 挪到了待弹组的精确时间上 → 伴奏那组的提示
          // 要按新位置重算 (否则伴奏灯停在冻结前的那一组).
          this.syncLead()
          this.emitTick()
          return
        }
        // 待弹组往前挪了 (弹对了) → 解冻, 让播放头走到下一个待弹组
        this.frozen = false
      } else if (canFreeze && !this.playAlong.areRequiredPressed()) {
        this.freezeAt(practiceHand, transpose, routeAcc, prevTime)
        this.emitTick()
        return
      } else {
        this.frozen = false
      }
    } else {
      this.frozen = false
    }

    // ── 抢先模式: 弹对了才推进 ───────────────────────────────────
    // 两只手各弹各的 —— 弹对了哪只手, 哪只手的游标才往前挪.
    // 播放头**不跳** (双手模式靠「跟着玩家速度走」推进, 见上面的倍率).
    if (isPractice) this.syncLead()
    // 记账基准 = 当前的播放头位置
    bookHorizon = this.currentTime

    // Loop wrap — 纯时间跳转, 不经过 pause(): pause() 会 setIsPlaying(false),
    // 而回卷后定时器仍在跑 → UI 显示暂停、音乐还在响 (spec P0-1).
    if (loopRange && this.currentTime >= loopRange[1] && prevTime < loopRange[1]) {
      this.seek(loopRange[0], { keepPlaying: true, preserveScore: true })
      return
    }

    // ── 跟弹记账 (严格按 note 的精确时间) ─────────────────────────
    // 音频在下面按 lookahead 提前排程, 但记账必须等到 note 真正到点:
    //  - 判定窗口要跟 note.time 对齐, 不能跟"排程时刻"对齐 (spec P1-3);
    //  - note 落键那一刻才进 required → 冻结也发生在落键那一刻.
    //
    // ★ 2026-10-30: 提前量**不再**移动判定基准 (以前会 rebase 到灯亮时刻).
    //   提前按的用户 → 按键被 recent 记住 → 落键时 fileNoteOn 匹配上 →
    //   按「落键那一刻」结算 (delta = 0).
    while (
      this.bookkeepingIndex < this.song.notes.length &&
      this.song.notes[this.bookkeepingIndex].time <= bookHorizon
    ) {
      const idx = this.bookkeepingIndex
      const note = this.song.notes[idx]
      // 通知 LED 跟随等订阅者: 灯要亮 (hit=false, 这只是播放事件, 不是用户命中)
      this.onNoteOn(note, false)
      // PlayAlong 记账 — active-hand 才入 required
      if (isPractice && !this.leadEnabled()) {
        // 抢先模式: required 由**游标**管 (游标指到哪个音才要求哪个) ——
        // 这里再登记一遍会跟游标打架 → 那个音有两个判定基准 → 永远判不中.
        const active = isActiveHand(note.hand, note.track, this.song.hands, practiceHand)
        if (active && !this.hitNoteIndices.has(idx)) {
          // 用 note 的**精确**时间记账 —— 帧时间是 16ms 量化过的 (spec P1-3)
          // 判定基准 = note.time (落键那一刻), 窗口用默认的命中窗口.
          const res = this.playAlong.fileNoteOn(idx, note.midiNote, note.time * 1000)
          if (res === 'early-matched') {
            // 用户在提前量窗口里**提前按**了 —— 结算在落键那一刻 (delta = 0).
            this.markHit(idx, 0)
          }
        }
      }
      this.bookkeepingIndex++
    }

    // ── 音频排程 (lookahead, spec P1-2) ──────────────────────────
    // 把 [游标, 当前时间 + lookahead) 的 note 排进音频时间轴, 声音落在 note.time 上,
    // 主线程再怎么抖也影响不到它.
    const lookahead = this.lookaheadFor(practiceHand, waitMode, leadMode)
    const startIdx = this.scheduler.index
    const due = this.scheduler.takeDue(this.currentTime + lookahead)
    for (let i = 0; i < due.length; i++) {
      const idx = startIdx + i
      const note = due[i]
      const route = routeFor(note.hand, note.track, this.song.hands, practiceHand, routeAcc)
      // 精确的发声时刻 (ctx 时间轴) —— lookahead 的核心
      const when = this.clock.toCtxTime(note.time) ?? undefined
      if (route === 'midiOut') {
        this.acc.sendNoteOn(note, when)
      } else if (route === 'synth') {
        // voiceId = song note 下标 —— 同一 midi 的不同声部各自独立 (spec P1-13)
        this.synth.playNote(note, transpose, idx, when)
      }
      this.noteRoutes.set(idx, route)
      this.playingNotes.set(idx, note)
    }
    this.currentNoteIndex = this.scheduler.index

    // 收尾已结束的 note — 同步 fileNoteOff 触发 miss 检测
    const finishedIdxs: number[] = []
    for (const [idx, n] of this.playingNotes) {
      if (n.time + n.duration <= this.currentTime) finishedIdxs.push(idx)
    }
    for (const idx of finishedIdxs) {
      const n = this.playingNotes.get(idx)
      if (!n) continue
      // 用**排程时**的路由 —— 中途切过模式的话, 重新算会把 MIDI Out 的音
      // 交给 synth 去关, 设备上就卡键了 (spec P1-2)
      const route = this.noteRoutes.get(idx) ?? routeFor(n.hand, n.track, this.song.hands, practiceHand, routeAcc)
      if (route === 'midiOut') {
        this.acc.sendNoteOff(n)
      } else {
        this.synth.stopNote(n.midiNote + transpose, idx)
      }
      this.playingNotes.delete(idx)
      this.noteRoutes.delete(idx)
      if (isPractice) {
        // 开头预览窗 (PREVIEW_WINDOW_S) 里结束的 note **不算 miss** ——
        // 那段时间冻结判定被预览窗挡着 (还没开始要求跟弹),
        // 如果照常算 miss, 用户还没来得及按就被记成"漏弹",
        // 表现出来就是"播放的第一个音不会被追踪和要求跟弹".
        //
        // 条件:
        //  - wait 模式 (wait 关了没有冻结, 漏弹就该照常记 miss)
        //  - 这个 note 的 grace 到期时刻落在预览窗内 —— 也就是"用户还没
        //    来得及按, 它就被判成漏了". 冻结窗外的 note 不受影响
        //    (时间被冻住, 根本走不到 grace 到期).
        const offMs = this.currentTime * 1000
        const graceExpiresAt = offMs + this.playAlong.hitWindow()
        const inPreview =
          waitMode && graceExpiresAt <= PREVIEW_WINDOW_S * 1000
        const r = this.playAlong.fileNoteOff(idx, offMs, inPreview)
        if (r.missed && !this.hitNoteIndices.has(idx)) {
          s.addMiss()
          s.resetStreak()
        }
      }
      this.onNoteOff(n)
    }

    // 节拍器 (spec P2-3 / P2-15)
    this.scheduleMetronome(s.metronome)

    // 歌曲结束
    //
    // ★ 抢先模式 (单手): 伴奏放完了**不等于**曲子结束了 —— 玩家可能还有
    //   几个音没弹 (游标还指着它). 这时候不能停, 得等玩家弹完 (游标收工).
    if (
      this.currentNoteIndex >= this.song.notes.length &&
      this.playingNotes.size === 0 &&
      !(leadMode && this.leadHasPending())
    ) {
      this.pause()
      return
    }

    this.emitTick()
  }

  // ─────────────────────────────────────────────────────────────
  // 抢先模式 (spec §R23)
  //
  // 抢先 = Wait + 「弹对了才推进」. 用户 2026-11-08 重新定义, 2026-11-10 修订:
  //
  //  - **提前按不报错**: 弹的不是当前待弹的音 → 不算错音, 什么都不做.
  //    (以前会落进 PlayAlong.recent → 判成 'wrong' → 弹错误提示;
  //     更糟的是上一轮弹过的键会被 recent「检索」回来, 干扰这一轮的判定.)
  //  - **判定不受容差影响**: 抢先模式的命中只看「是不是当前待弹的那一组」,
  //    完全不看时间 —— 提前多久按都算命中.
  //  - **灯一直亮到弹对**: 不超时自动跳过, 不自动记漏弹.
  //    没弹对 → 那只手的灯一直亮着, 提示不变.
  //  - **每只手一个游标**: 右手弹对了只推进右手, 左手不动.
  //
  // ★ 2026-11-10 修订 (用户: 「切换到抢先, 完全不会停下来对的音」):
  //   2026-11-08 那一版把 Wait 的**冻结整个关掉了** —— 播放头一直走, 曲子
  //   按原速流过去, 灯带提示的是「现在该弹的那一组」. 结果是: 瀑布跟提示
  //   永远对不上 (提示音可能早就落过去了), 而且 Wait 变成空壳 (它唯一的
  //   作用「钉住播放头等你弹」没了).
  //   用户要的是 **跟普通 Wait 一样的冻结**: 播放头停在「现在该弹的那一组」
  //   上, 弹对了才往前走.
  //
  //   所以现在抢先 = **冻结 + 提前按不报错 + 灯常亮**:
  //   - 冻结点 = 游标指到的待弹组 (不是 PlayAlong.required —— 抢先不填它);
  //   - 倍率恒为 1 (2026-11-08 的「UI 跟着玩家速度加速」作废 —— 冻住了就没法加速);
  //   - 双手 / 单手的行为一致了 (之前两条路分叉就是因为一个冻一个不冻).
  // ─────────────────────────────────────────────────────────────

  /** 抢先模式是否生效 —— 抢先依赖 Wait (Wait 关掉 → 抢先失效). */
  private leadEnabled(): boolean {
    const s = useStore.getState()
    return effectiveLead(s.hand, s.wait, s.leadNext)
  }

  /**
   * 抢先模式的**状态迁移** (每帧查一次).
   *
   * 三种迁移要处理:
   *  1. **刚打开抢先** → 清掉普通 Wait 冻结时留在 PlayAlong.required 里的音.
   *     抢先的判定完全绕开 PlayAlong, 那批残留 required 到了时间点会被判成
   *     「漏弹」(幽灵 miss); 而且关掉抢先后, 冻结会被一个陈旧的 required
   *     卡住 —— 播放头被拉回老位置.
   *  2. **刚关掉抢先** → 游标清干净, 回到普通 Wait.
   *  3. **手别变了** → 游标重新定位. 游标是按某只手找的, 换手不重定位的话,
   *     新那只手会从「模式刚开时的位置」开始找 → 拿到一个**已经过去**的音,
   *     玩家怎么按都对不上.
   */
  private syncLeadModeState(leadMode: boolean) {
    const s = useStore.getState()
    if (leadMode !== this.leadActive) {
      this.leadActive = leadMode
      this.leadHandSnapshot = s.hand
      if (leadMode) this.playAlong.resetPass()
      this.resetLeadState()
      if (leadMode) this.syncLead() // 立刻定位 → 这一帧就能算出冻结点
      return
    }
    if (leadMode && s.hand !== this.leadHandSnapshot) {
      this.leadHandSnapshot = s.hand
      this.resetLeadState()
      this.syncLead()
    }
  }

  /**
   * 抢先模式下**玩家要弹**的手 (双手 = 两只, 单手 = 一只).
   *
   * 单手模式下另一只手是**伴奏** —— 玩家不用弹它.
   */
  private leadPracticeHands(): ('left' | 'right')[] {
    const s = useStore.getState()
    if (s.hand === 'left') return ['left']
    if (s.hand === 'right') return ['right']
    return ['left', 'right']
  }

  /** 抢先模式下**伴奏**的手 (只有单手模式才有伴奏). */
  private leadAccHands(): ('left' | 'right')[] {
    const s = useStore.getState()
    if (s.hand === 'left') return ['right']
    if (s.hand === 'right') return ['left']
    return []
  }

  /**
   * 这个 note 算哪只手的待弹音.
   *
   * 手别未知 (单轨谱没标) 时:
   *  - 单手模式 → 算玩家那只手 (跟 isActiveHand 一致: 未知 = 玩家要弹);
   *  - 双手模式 → 按音高切 (跟灯带配色 / NextNoteIndex 一致).
   */
  private isLeadNoteFor(hand: 'left' | 'right', note: SongNote): boolean {
    const s = useStore.getState()
    const h = resolveHand(note.hand, note.track, this.song.hands)
    if (h !== undefined) return h === hand
    if (s.hand !== 'both') return hand === s.hand
    return hand === (note.midiNote < (this.song.pitchSplit ?? 60) ? 'left' : 'right')
  }

  /** 从「当前播放位置」往后找这只手第一个该弹的音. */
  private firstLeadNoteIdx(hand: 'left' | 'right', fromTime: number): number {
    for (let i = 0; i < this.song.notes.length; i++) {
      const n = this.song.notes[i]
      if (n.time < fromTime - LEAD_EPS_S) continue
      if (!this.isLeadNoteFor(hand, n)) continue
      if (this.hitNoteIndices.has(i)) continue
      if (this.leadSkipped.has(i)) continue
      return i
    }
    return -1
  }

  /** 这只手的下一个待弹音 (跳过同一组 —— 组要整组弹全才推进). */
  private nextLeadNoteIdx(hand: 'left' | 'right', fromIdx: number): number {
    const from = this.song.notes[fromIdx]
    if (!from) return -1
    for (let i = fromIdx + 1; i < this.song.notes.length; i++) {
      const n = this.song.notes[i]
      if (n.time <= from.time + LEAD_EPS_S) continue
      if (!this.isLeadNoteFor(hand, n)) continue
      if (this.hitNoteIndices.has(i)) continue
      if (this.leadSkipped.has(i)) continue
      return i
    }
    return -1
  }

  /**
   * 这只手在时刻 t「正在亮」的那一组 (伴奏手用).
   *
   * 跟主灯带的组语义一致: 亮到音条从画面上消失 (NOTE_BAR_LIFETIME_S),
   * 下一组开始就换组.
   */
  private currentAccGroup(hand: 'left' | 'right', t: number): SongNote[] {
    const notes = this.song.notes
    let idx = -1
    for (let i = 0; i < notes.length; i++) {
      if (notes[i].time > t + LEAD_EPS_S) break
      if (resolveHand(notes[i].hand, notes[i].track, this.song.hands) !== hand) continue
      idx = i
    }
    if (idx < 0) return []
    const gt = notes[idx].time
    if (t - gt >= NOTE_BAR_LIFETIME_S) return []
    const out: SongNote[] = []
    for (let i = idx; i >= 0; i--) {
      if (Math.abs(notes[i].time - gt) > LEAD_EPS_S) break
      if (resolveHand(notes[i].hand, notes[i].track, this.song.hands) === hand) out.push(notes[i])
    }
    out.reverse()
    for (let i = idx + 1; i < notes.length; i++) {
      if (Math.abs(notes[i].time - gt) > LEAD_EPS_S) break
      if (resolveHand(notes[i].hand, notes[i].track, this.song.hands) === hand) out.push(notes[i])
    }
    return out
  }

  /** 设置某只手的待弹组 (同一时刻的所有 note = 一组). */
  private setLeadGroup(hand: 'left' | 'right', idx: number) {
    const t = this.song.notes[idx]?.time
    if (t === undefined) return
    const group: number[] = []
    for (let i = 0; i < this.song.notes.length; i++) {
      const n = this.song.notes[i]
      if (Math.abs(n.time - t) > LEAD_EPS_S) continue
      if (!this.isLeadNoteFor(hand, n)) continue
      if (this.hitNoteIndices.has(i)) continue
      if (this.leadSkipped.has(i)) continue
      group.push(i)
    }
    this.leadGroup[hand] = group
    this.leadGroupTime[hand] = t
  }

  /**
   * 抢先模式: 每帧同步一次 —— 定位游标 / 弹对了就推进.
   *
   * **不会**超时自动推进 (用户 2026-11-08: 「必定是正确按下后才会灭掉」).
   */
  private syncLead() {
    if (!this.leadEnabled()) {
      this.resetLeadState()
      return
    }
    for (const hand of this.leadPracticeHands()) {
      if (this.leadDone[hand]) continue
      if (this.leadCursor[hand] < 0) {
        // 还没定位 → 从「模式刚开 / 刚跳转」的位置找这只手第一个该弹的音
        const idx = this.firstLeadNoteIdx(hand, this.leadBaseTime)
        if (idx < 0) {
          this.leadDone[hand] = true
          continue
        }
        this.leadCursor[hand] = idx
        this.setLeadGroup(hand, idx)
        continue
      }
      // 这一组还没弹全 (和弦要一起弹) → 停在这, 灯一直亮着
      const group = this.leadGroup[hand]
      if (group.length === 0) continue
      if (!group.every((i) => this.hitNoteIndices.has(i))) continue
      // 弹全了 → 推进到这只手下一个该弹的音
      const next = this.nextLeadNoteIdx(hand, this.leadCursor[hand])
      if (next < 0) {
        this.leadDone[hand] = true
        this.leadCursor[hand] = -1
        this.leadGroup[hand] = []
        continue
      }
      this.leadCursor[hand] = next
      this.setLeadGroup(hand, next)
    }
    this.refreshLeadHint()
  }

  /** 抢先模式: 还有待弹的音吗 (有 → 曲子不能停, 得等玩家弹完). */
  private leadHasPending(): boolean {
    for (const hand of this.leadPracticeHands()) {
      if (this.leadGroup[hand].length > 0) return true
    }
    return false
  }

  /**
   * 抢先模式的**冻结点** (谱面秒) —— 最早那个「待弹组」的时间.
   *
   * 抢先模式不往 PlayAlong.required 里登记 (判定完全绕开它), 所以冻结点
   * 只能自己算: 每只手各有一个待弹组, 取最早的那个.
   *
   * 没有待弹的组 (全弹完了 / 这只手没音了) → null (不冻结).
   */
  private leadFreezeTarget(): number | null {
    let best: number | null = null
    for (const hand of this.leadPracticeHands()) {
      const group = this.leadGroup[hand]
      if (group.length === 0) continue
      // 组里可能还有没弹的音 —— 只要还有一个没弹, 这组就是待弹的
      const pending = group.some((i) => !this.hitNoteIndices.has(i))
      if (!pending) continue
      const t = this.leadGroupTime[hand]
      if (best === null || t < best) best = t
    }
    return best
  }

  /** 把抢先模式的状态清干净 (模式关掉 / 跳转). */
  private resetLeadState() {
    this.leadCursor = { left: -1, right: -1 }
    this.leadGroup = { left: [], right: [] }
    this.leadGroupTime = { left: 0, right: 0 }
    this.leadDone = { left: false, right: false }
    this.leadHint = null
    // 游标定位的基准 = 此刻的位置 (跳转后要从新位置开始找)
    this.leadBaseTime = this.currentTime
  }

  /** 重算灯带提示 (每只手一份). */
  private refreshLeadHint() {
    const hands: LeadHandHint[] = []
    for (const hand of this.leadPracticeHands()) {
      const group = this.leadGroup[hand]
      if (group.length === 0) continue
      // 组里已经弹对的音 → 灯灭掉 (和弦弹了一个, 那个音的灯就该灭)
      const pending = group.filter((i) => !this.hitNoteIndices.has(i))
      if (pending.length === 0) continue
      hands.push({
        hand,
        time: this.leadGroupTime[hand],
        notes: pending.map((i) => this.song.notes[i]),
      })
    }
    // 伴奏手: 正常显示它当前正在响的那一组 (用户 2026-11-08: 「正常显示即可」)
    for (const hand of this.leadAccHands()) {
      const notes = this.currentAccGroup(hand, this.currentTime)
      if (notes.length === 0) continue
      hands.push({ hand, time: notes[0].time, notes })
    }
    this.leadHint = hands.length > 0 ? { hands } : null
  }

  /**
   * 抢先模式下的按键处理.
   *
   * ★ 关键 (用户 2026-11-08):
   *   - **只认「当前待弹的那一组」** —— 不看时间 → 判定**不受容差**影响;
   *   - **不查 PlayAlong.recent** → 上一轮弹过的键不会被「检索」回来,
   *     干扰这一轮的判定 (recent 是「按早了先记着」的机制, 抢先模式不需要);
   *   - 弹的不是待弹的音 → **不报错** (抢先模式本来就是让玩家自由试).
   */
  private leadPress(midi: number) {
    // 找「待弹组里含这个键」的最早一组 (已经弹过的音不算 —— 同一个键
    // 上一轮弹过, 这一轮再按不重复计分, 也不该把灯推进)
    let bestTime = Infinity
    for (const hand of this.leadPracticeHands()) {
      const group = this.leadGroup[hand]
      if (group.length === 0) continue
      const hit = group.some(
        (i) => !this.hitNoteIndices.has(i) && this.song.notes[i].midiNote === midi,
      )
      if (!hit) continue
      const t = this.leadGroupTime[hand]
      if (t < bestTime) bestTime = t
    }
    if (!Number.isFinite(bestTime)) return // 不是该弹的 → 不报错

    // 同一时刻 (跨手) 的同一个键一起算命中
    for (const hand of this.leadPracticeHands()) {
      if (Math.abs(this.leadGroupTime[hand] - bestTime) > LEAD_EPS_S) continue
      for (const i of this.leadGroup[hand]) {
        if (this.song.notes[i].midiNote !== midi) continue
        if (this.hitNoteIndices.has(i)) continue
        this.markHit(i, 0)
      }
    }
    // 弹对了 → 那只手的游标往前挪 (和弦要弹全才挪)
    // → 冻结点也跟着往前挪 → 播放头解冻, 走到下一个待弹组再冻上
    this.syncLead()
  }

  /**
   * 抢先模式的灯带提示 —— 每只手一份 (各弹各的).
   *
   * 抢先模式没开 / 没有待弹音 → null (灯带灭).
   */
  getLeadHint(): LeadHint | null {
    if (!this.leadEnabled()) return null
    return this.leadHint
  }

  /**
   * 强行跳过抢先模式当前指着的那个音 (Backspace / Delete).
   *
   * 抢先模式**不会**超时自动推进 → 弹不到的音 (电钢没接上 / 那个键坏了)
   * 只能靠这个手动跳过. 跳过的是「最早那个待弹组」——
   * 一只手卡住不影响另一只手.
   *
   *  - 不算漏弹 —— 是用户主动跳过, 不是没弹到.
   *  - 伴奏 / 播放头 / 谱面显示全都不动 (跟游标推进一样).
   *  - 没开抢先 / 没有待弹的音 → 返回 false, 调用方走原来的逻辑.
   */
  skipLeadNote(): boolean {
    if (!this.leadEnabled()) return false
    let hand: 'left' | 'right' | null = null
    let bestTime = Infinity
    for (const h of this.leadPracticeHands()) {
      if (this.leadGroup[h].length === 0) continue
      const t = this.leadGroupTime[h]
      if (t < bestTime) {
        bestTime = t
        hand = h
      }
    }
    if (hand === null) return false
    // 记下被跳过的音 —— 否则游标重新定位时 (切手别 / 开关模式) 它们会「复活」,
    // 又要求你弹一遍.
    for (const i of this.leadGroup[hand]) this.leadSkipped.add(i)
    const next = this.nextLeadNoteIdx(hand, this.leadCursor[hand])
    if (next < 0) {
      this.leadDone[hand] = true
      this.leadCursor[hand] = -1
      this.leadGroup[hand] = []
    } else {
      this.leadCursor[hand] = next
      this.setLeadGroup(hand, next)
    }
    this.refreshLeadHint()
    return true
  }

  /**
   * 冻住歌曲时间.
   *
   * 冻结点优先回到**卡住用户的那个 note 的精确时间** (spec P2-10):
   * 用帧时间的话会差一帧 (16ms), 累加漂移久了还会差更多.
   * 但回退太多 (超过 MAX_REWIND_S) 体感很差 —— 那种情况下停住不动,
   * 改把 note 的判定基准 rebase 到冻结点 (用户按下时 delta 才是 0,
   * 否则差半秒 → 永远判不中 → 死锁在 wait 模式).
   *
   * 例外: **预览窗里的 note** (note.time <= PREVIEW_WINDOW_S) 允许大幅回退 ——
   * 预览窗把冻结推迟了半秒, 不回退的话灯组已经翻到下一个音,
   * 曲首第一个音就永远对不上 (用户报的「灯亮 e4 / 提示要弹 c4」).
   */
  private freezeAt(
    practiceHand: PracticeHand,
    transpose: number,
    routeAcc: boolean,
    prevTime: number,
    /** 抢先模式: 直接指定冻结点 (游标指到的待弹组的精确时间). */
    forceTarget?: number,
  ) {
    // ★ 进入冻结时: 立即把已经发出去的 note 全部 stop — 让电钢"安静下来",
    // 用户能立刻听到 wait 模式在工作 (而不是被左手伴奏持续响混淆).
    // 不调 fileNoteOff — PlayAlong 状态机里这些 note 还在 required,
    // 弹对后 userPress 还能 late-match + markHit.
    //
    // ★ 抢先模式**不**掐断 (spec §R23): 抢先是「一个音一个音」推进的,
    // 每推进一次就掐一遍的话, 伴奏基本听不见 (只剩每帧被掐掉的一瞬).
    // 不掐的话伴奏会一直响到播放头跳过它为止 —— 相当于踩着延音踏板.
    if (!this.frozen) {
      this.frozen = true
      if (!this.leadEnabled()) {
        for (const [idx, n] of [...this.playingNotes]) {
          const r = routeFor(n.hand, n.track, this.song.hands, practiceHand, routeAcc)
          if (r === 'midiOut') this.acc.sendNoteOff(n)
          else if (r === 'synth') this.synth.stopNote(n.midiNote + transpose, idx)
          // silent 不用停
        }
      }
    }
    // 第一次冻结 = 预览窗用掉 (之后冻结才是即时的)
    this.previewDone = true
    let freezeAt = prevTime
    if (forceTarget !== undefined) {
      // 抢先模式: 冻结点已经算好了 (游标指到的待弹组) —— 直接落在它的精确时间上.
      // (播放头最多比它晚一帧 (16ms), 落回精确时间 → 灯组 / 谱面 / 提示三者对齐)
      freezeAt = forceTarget
    } else {
      const freezeTs = this.playAlong.requiredEarliestTs()
      if (freezeTs !== null) {
        const noteTime = freezeTs / 1000
        const rewind = prevTime - noteTime
        // 曲子开头的预览窗 (PREVIEW_WINDOW_S) 会把「曲首第一个 note」推到它的
        // 灯组之外 —— 灯是按"下一组开始就换灯"滚的, 预览窗走完时灯已经翻到
        // 第二个音, 而第一个 note 还留在 required 里 → 用户看到的是
        // 「灯亮 E4 / 提示要弹 C4」, 第一个音就这么被跳过去了.
        //
        // 预览窗里的 note 允许**大幅回退**: 冻结点回到 note 的精确时间,
        // 灯组 / 谱面 / 提示三者才对得上 (跟 P2-10「冻结后 ct 停在 note 精确时间」一致).
        const inPreview = noteTime <= PREVIEW_WINDOW_S
        if (rewind <= MAX_REWIND_S || inPreview) {
          // 不取 min(noteTime, currentTime): 回退之后 currentTime 可能**早于**
          // 要弹的 note (预览窗里已经攒了好几个 note) —— 那时要往前跳到那个 note,
          // 否则灯组停在前一个音上, 提示和灯对不上.
          freezeAt = noteTime
        } else {
          this.playAlong.rebaseRequired(prevTime * 1000)
        }
      }
    }
    this.clock.anchor(freezeAt)
    this.currentTime = freezeAt
  }

  private emitTick() {
    const now = performance.now()
    if (now - this.lastTickStoreTime > 100) {
      this.lastTickStoreTime = now
      const s = useStore.getState()
      s.setCurrentTime(this.currentTime)
      s.setFrozenWaiting(this.frozen)
    }
  }

  /**
   * 节拍器排程 (spec P2-3 / P2-15).
   *
   * 拍点来自 tempo map (变速时自动跟随), 声音排在 AudioContext 时间轴的**精确**拍点上 ——
   * 主线程卡顿不会让节拍器晚半拍 (旧实现是"这帧到了才响", 抖动直接传导).
   *
   * 冻结时不往前排 —— 冻着的时候不该继续打拍子 (用户正在弹那个卡住的音).
   */
  private scheduleMetronome(enabled: boolean) {
    // 变拍曲子: 拍点按每小节自己的拍号切 (「梦中的婚礼」)
    if (this.beatPoints) {
      this.scheduleMetronomeVariable(enabled)
      return
    }
    const beatsPerMeasure = Math.max(1, this.song.timeSignature.numerator)
    const horizon = this.currentTime + (this.frozen ? 0 : METRONOME_LOOKAHEAD_S)
    const horizonBeat = Math.floor(this.tempoMap.beatIndexAt(horizon))
    // 卡顿 / 长时间挂起后可能落后很多拍 —— 别空转几千次, 直接跳过
    if (horizonBeat - this.metronomeBeatCursor > 64) {
      this.metronomeBeatCursor = horizonBeat - 64
    }
    while (this.metronomeBeatCursor <= horizonBeat) {
      const beatNo = this.metronomeBeatCursor
      const beatTime = this.tempoMap.timeOfBeat(beatNo)
      this.metronomeBeatCursor++
      // 已经过去的拍 (seek 之后) 不补响
      if (beatTime < this.currentTime - 0.02) continue
      if (!enabled) continue
      const isDown = ((beatNo % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure === 0
      const when = this.clock.toCtxTime(beatTime) ?? undefined
      this.metronome.tick(isDown, when)
    }
  }

  /**
   * 变拍曲子的节拍器排程。
   *
   * 拍点来自按小节拍号切的网格 (measureBeatPoints), 强拍 = 小节第一拍 ——
   * 6/8 / 9/8 / 12/8 这些复拍子的小节, 拍点和小节线才不会错开。
   */
  private scheduleMetronomeVariable(enabled: boolean) {
    const points = this.beatPoints
    if (!points) return
    const horizon = this.currentTime + (this.frozen ? 0 : METRONOME_LOOKAHEAD_S)
    // 游标指向第一个还没过去的拍 (seek 之后别补响一大串旧拍)
    let i = this.metronomeBeatCursor
    while (i < points.length && points[i].time < this.currentTime - 0.02) i++
    this.metronomeBeatCursor = i
    for (; i < points.length; i++) {
      const p = points[i]
      if (p.time > horizon) break
      this.metronomeBeatCursor = i + 1
      if (!enabled) continue
      const when = this.clock.toCtxTime(p.time) ?? undefined
      this.metronome.tick(p.isDownbeat, when)
    }
  }

  /** 节拍器游标重置到当前时刻 (seek / 换歌时调) */
  private resetMetronomeCursor() {
    if (this.beatPoints) {
      const points = this.beatPoints
      let i = 0
      while (i < points.length && points[i].time < this.currentTime - 0.02) i++
      this.metronomeBeatCursor = i
      return
    }
    this.metronomeBeatCursor = Math.floor(this.tempoMap.beatIndexAt(this.currentTime))
  }
}
