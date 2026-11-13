// 跨层共享类型
// 参考 sightread 的 Song 类型 + piano-booster 的 Part 概念简化

export type Hand = 'left' | 'right'

/**
 * 画面上的音条在「落键之后」还留多久 (秒) —— 渲染和灯带共用同一个值.
 *
 * 为什么共享: 用户的要求是「灯跟画面上的音条同生共死」—— 音条消失时灯必须灭.
 * 两边各写一个魔数的话, 改一边另一边就漂了 (灯会比音条多亮或少亮几帧).
 *
 * 渲染侧: 下落音符画到 dt < -NOTE_BAR_LIFETIME_S 就不画了.
 * 灯带侧: LedScanCursor 的灭灯事件定在 note.time + 这个值.
 */
export const NOTE_BAR_LIFETIME_S = 0.5

/**
 * 虚拟键盘上的音名标号模式 (用户 2026-10-30 要求: "D3 之类的标号, 我不认识").
 *  - 'off' 不标
 *  - 'c'   只标每个八度的 C (最省空间)
 *  - 'all' 全标 (默认)
 */
export type KeyLabelMode = 'off' | 'c' | 'all'

export interface SongNote {
  /** 0-127, C4 = 60 */
  midiNote: number
  /** 秒, 相对曲首 */
  time: number
  /** 秒 */
  duration: number
  /** 0-based track index */
  track: number
  /** 解析/推断时填入 */
  hand?: Hand
  /** 0-1, 默认 0.8 */
  velocity?: number
}

export interface SongMeasure {
  number: number
  /** 秒 */
  time: number
  /** 秒 */
  duration: number
  /**
   * 本小节的拍号。混合拍号的曲子 (中途变拍) 每个小节可能不一样;
   * undefined = 整首一个拍号, 用 Song.timeSignature。
   */
  numerator?: number
  denominator?: number
}

/**
 * 右键检视到的那个音符.
 *
 * `index` 是**唯一编码** —— 音符在 `song.notes` 数组里的下标.
 * 全程稳定 (改音高/时值不会变), 用户拿它可以直接说「第 42 号音符错了」,
 * 谱子编辑器也能按号定位.
 */
export interface NoteHit {
  index: number
  note: SongNote
  /** 第几小节 (1 起) */
  measure: number
  /** 这一小节里的第几拍 (1 起) */
  beat: number
}

export interface Bpm {
  /** 秒 */
  time: number
  bpm: number
}

export interface Song {
  notes: SongNote[]
  measures: SongMeasure[]
  bpms: Bpm[]
  /** 秒 */
  duration: number
  /** MIDI 的 ticks per quarter; XML 解析时为 480 */
  ppq: number
  /** 左手/右手 track index (单 track 文件用 0/0, 走 pitchSplit) */
  hands: { left: number; right: number }
  /**
   * 单 track MIDI 模式: < 该 midiNote 的标 left, >= 标 right.
   * 多 track 模式不用. undefined = 按 track 区分.
   */
  pitchSplit?: number
  /**
   * 左右手是怎么定出来的 + 有多可信 (spec P2-6).
   * confidence='low' = 声部聚类猜的, UI 会提示用户, 用户可手动改判定方式.
   */
  handInfer?: { method: string; confidence: 'high' | 'medium' | 'low' }
  timeSignature: { numerator: number; denominator: number }
  /**
   * 拍号变化列表 (按时间升序)。整首一个拍号时长度为 1;
   * 中途变拍的曲子 (如「梦中的婚礼」4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8 …) 会有多个。
   */
  timeSignatures?: { time: number; numerator: number; denominator: number }[]
  /** 来源标记 */
  source: 'midi' | 'xml'
  /**
   * 调号升降号数: -7..+7 (负=降, 正=升). undefined → 渲染时按 C major 处理.
   * 仅供五线谱显示用, 不影响 MIDI 路由 / 合成器.
   */
  keyFifths?: number
  /**
   * 谱号. undefined → 按 hand 推断: right=treble, left=bass.
   */
  /**
   * Metadata for display. Library loader injects library.title/composer;
   * parser tries to extract from MIDI meta or MusicXML <work><title>.
   * TopBar shows title. Falls back to file name / notes count.
   */
  title?: string
  composer?: string
  /**
   * Clef. undefined = default by hand: right=treble, left=bass.
   */
  clef?: { right: 'treble' | 'bass'; left: 'treble' | 'bass' }
}

/**
 * 事件来源.
 *
 * - 'input'   : 用户真的按了键 (电钢 / 电脑键盘)
 * - 'playback': 文件播放（应用自己发声）
 * - 'hit'     : 用户弹对了一个音 —— 反馈脉冲, 不属于任何一个“按住不按住”的渠道
 * - 'lead'    : 抢先模式的**提示**灯 (「现在该弹的音」) —— 状态投影, 不是声音
 *
 * 'hit' 为什么要单独拆出来 (spec P1-9):
 *  - 命中反馈不应该被 LED 提前量 (offset) 的抑制逻辑吞掉 —— 那会让命中反馈彻底消失;
 *  - 命中反馈应该自己消失 (亮一下就灭), 而不是等文件音自然结束.
 *
 * 'lead' 为什么要单独拆出来 (2026-11-10):
 *  - 抢先的灯**不是**「跟随乐谱」的一部分 —— 「跟随乐谱」关掉时它照样要亮;
 *  - 它也不该被「只看输入 / 只看播放」的过滤吞掉 —— 那是给**声音**的过滤;
 *  - 它不能被当成用户输入 (Player 会忽略这个源).
 */
export type NoteSource = 'input' | 'playback' | 'hit' | 'lead'

/** 输入层 -> 引擎层 的统一事件
 *  - hand: 可选, 播放事件 (来自文件 NoteOn) 带 note.hand; 输入事件不带 (按用户实际按的手)
 *         用于 LED 按「事件级」选色 — 同一个 midi 在两只手里出现时, 用对应事件的手.
 */
export type NoteEvent =
  | { type: 'down'; midi: number; velocity: number; t: number; source: NoteSource; hand?: 'left' | 'right' }
  | { type: 'up'; midi: number; t: number; source: NoteSource; hand?: 'left' | 'right' }

/** 输入源接口 */
export interface IInput {
  start(): void
  stop(): void
  onEvent: ((e: NoteEvent) => void) | null
}
