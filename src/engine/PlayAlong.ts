// PlayAlong — 跟弹状态机
//
// 参考 neothesia: refs/neothesia/neothesia/src/scene/playing_scene/midi_player.rs 的 PlayAlong
// 端口到 TS, noteIndex 键 (不是 midi), 这样:
//  - 同一 midi 不同时刻 (C4@1.0s + C4@1.5s) 独立
//  - 同一 midi 同时多 hand (Bach BWV 1041 chord 内 6 手同 C4) 一次按键必须全命中
//
// 状态:
//   required  : 文件发了 NoteOn 但用户还没弹 (noteIndex 键) — required 非空 = 时间冻结
//   recent    : 用户在最近一个判定窗口内按下的 midi, 用于文件 NoteOn 到达时 early-hit 匹配
//   inProgress: 文件 NoteOn 已发但 noteOff 还没到 — 同 noteIndex 重复触发去重
//
// miss 语义: 我们与 neothesia 不同 — 文件 noteOff 时若 idx 仍在 required, 记 miss
// 这样 StatusBar 能显示「错过」, 用户能看到自己漏弹
//
// 冻结语义 (Player.stepLoop 用): areRequiredPressed() === true 才推进 currentTime
// 因此用户漏弹后, 时间自动停在文件最后发的 NoteOn 处, 等用户弹对才继续

import type { SongNote } from '../types'
import { useStore } from '../store'
import { timingWindows } from './Scoring'

/**
 * 判定窗口不再是写死的绝对毫秒 —— 改为按 bpm 缩放 (spec P1-5).
 * 旧的固定 500ms 与乐曲速度脱钩: 慢板宽到"随便弹都算准", 快板宽到"半拍都算".
 * 具体公式见 src/engine/Scoring.ts timingWindows().
 */

/** 默认 bpm —— 还没拿到歌曲速度时的兜底 */
const DEFAULT_BPM = 120

/** 用户在设置里选的容差 (ms) — 从 store 动态读, 让 UI 改后立刻生效 */
function toleranceCap(): number {
  return useStore.getState().toleranceMs
}

interface NotePress {
  /** file NoteOn 时刻 (song ms) — userPress 算 dtMs 的基准 */
  ts: number
  /** 该 note 的 midi — 让 userPress 能按 midi 直接查 required (neothesia 同款) */
  midi: number
  /**
   * 该 note 的最大容忍迟到 (ms) — 没给就用全局 hitWindow().
   *
   * LED 强制等待时需要单独放宽: note 的判定基准被重设到"灯亮的那一刻"
   * (note.time - 提前量), 用户听到声音再按就晚了整个提前量 (最多 900ms),
   * 远超默认的 250ms 判定窗口 → 永远判不中 → 死锁在 wait 模式.
   */
  windowMs?: number
  /**
   * 漏弹宽限 (ms) —— 「伴奏走过去多久算漏弹」. 没给就用 windowMs ?? hitWindow().
   *
   * ★ 为什么要跟 windowMs 分开 (2026-11-05, 抢先模式单手路径):
   *   windowMs 管「按了算不算命中」, graceMs 管「多久之后算漏弹」.
   *   抢先模式单手路径里, 判定基准是「游标推进的那一刻」, 用户的反应时间
   *   可能好几百毫秒 → windowMs 必须放宽 (不然永远判不中 → 卡死);
   *   但漏弹还是该按伴奏的进度算 → graceMs 保持窄的.
   *   合成一个字段的话, 放宽 windowMs 会连带把漏弹判据也放宽.
   */
  graceMs?: number
  /**
   * file NoteOff 时刻 (song ms). 设为 undefined 表示还没 fileNoteOff.
   * 跟弹上需要 grace window (toleranceMs) 才算 miss — 真实 MIDI 里极短音
   * (duration < 1 frame = 16ms) 经常在同帧 fileNoteOn + fileNoteOff, 立即 delete
   * required → userPress 找不到该 midi → 用户按键误算 wrong. 这里保留 inRequired
   * 到 graceMs 才真正算 miss.
   */
  offTs: number | undefined
  /**
   * 该 note 的 noteOff **不**计入 miss —— 用于 wait 模式开头的预览窗.
   *
   * 为什么需要: 冻结判定被 "前 0.5s 强制不冻" 保护着, 但 bookkeeping 循环
   * 照常跑 —— 第一个 note (t=0) 在 t=0 就进了 required, 而它的 noteOff 可能在
   * 0.3s 就到了 (短音). noteOff 之后 grace 到期 → update() 把它升级成 miss →
   * 第一个音"被判定为漏弹", 用户还没来得及按就被记成错过.
   * holdForever 让这种 note 一直留在 required 里, 直到用户真的按下.
   */
  holdForever?: boolean
}

/** recent map 用 — 按 midi 键, 不存 midi 自身 (避免冗余) */
interface RecentPress {
  ts: number
}

/** userPress 的返回值 — Player 据此驱动评分 */
export type PressResult =
  | { kind: 'late'; matched: number[]; dtMs: number }
  | { kind: 'wrong' }
  | { kind: 'recent-only'; midi: number }

export interface PlayAlongStats {
  /** 用户按键相对文件 NoteOn 的差 (ms, 正数=晚, 负数=早) */
  playedDelta: number[]
  /** 文件 noteOff 时仍未弹 (miss) */
  miss: number
  /** 用户按了但从未匹配 file note / 超过 recent window */
  wrong: number
  /** 文件 NoteOn 落在 recent 内 (early hit — 通常对用户有利, perfect) */
  early: number
}

export class PlayAlong {
  /** noteIndex → 文件 NoteOn 时间 */
  private required = new Map<number, NotePress>()
  /** midi → 用户按键时间 (用于 early-hit) */
  private recent = new Map<number, RecentPress>()
  /** noteIndex: 文件已 NoteOn 但 noteOff 未到 — 防止同 noteIndex 重复 schedule */
  private inProgress = new Set<number>()

  /**
   * required 的**下标集合** —— 增量维护 (spec P1-15).
   * 旧实现每次 requiredIndices() 都 new Set(this.required.keys()): LED pre-scanner
   * 每帧调一次 → 每帧一次分配 + 一次全量拷贝, 长曲下 GC 压力明显.
   */
  private requiredIdx = new Set<number>()

  /**
   * required 键集合的版本号 —— Player 用它给 getNoteStates() 做缓存 (spec P1-15).
   * 只在**键集合**变化时 +1 (fileNoteOff 只改 offTs, 不改键, 不必 +1).
   */
  private version = 0

  stats: PlayAlongStats = { playedDelta: [], miss: 0, wrong: 0, early: 0 }

  /** 当前乐曲速度 —— 判定窗口按它缩放 (spec P1-5) */
  private bpm = DEFAULT_BPM

  /**
   * 「提前按」的容差窗口 (ms).
   *
   * 2026-11-05: 「提前按」这个**独立模式**已经被删掉 (跟「抢先」二选一),
   * LED 提前量不再喂这个窗口 —— Player 每帧传 0. 保留这个字段是因为
   * recent (用户最近按过的 midi) 的过期时间还要跟它取 max: 用户在音符
   * 落键**之前**一点点按下时, 按键被记住, 落键时照样能匹配上 (early hit).
   *
   * 实现: recent 的过期时间取 max(命中窗口, 这个窗口).
   */
  private earlyWindowMs = 0

  /** Player 每帧同步「提前按」窗口过来 (ms) —— 现在恒为 0 */
  setEarlyWindowMs(ms: number) {
    this.earlyWindowMs = Math.max(0, ms)
  }

  /** Player 每帧同步当前 bpm 过来 */
  setTempo(bpm: number) {
    if (bpm > 0) this.bpm = bpm
  }

  /**
   * 命中窗口 (ms) —— 「按早/按晚多少还算命中」.
   *
   * ★ 2026-11-06: 两种口径 ——
   * - 用户**没填过**容差 → 按乐曲速度缩放 (spec P1-5): 120bpm → 250ms.
   * - 用户**填过**容差 → 填的那个数**就是**窗口本身.
   *
   * 为什么改: 以前容差只是「上限」, 而窗口永远被曲速缩放夹在 300ms 以内 ——
   * 用户调到 300 以上等于没调. 而用户明确要求「容差最高能到 2000ms」
   * (慢练 / 跟着耳钢琴时 500ms 太紧) —— 上限不生效, 这个设置就是假的.
   */
  hitWindow(): number {
    const s = useStore.getState()
    if (s.toleranceCustom) return s.toleranceMs
    return timingWindows(this.bpm, toleranceCap()).hit
  }

  /** perfect 阈值 (ms) */
  perfectWindow(): number {
    return timingWindows(this.bpm).perfect
  }

  /** good 阈值 (ms) */
  goodWindow(): number {
    return timingWindows(this.bpm).good
  }

  /** stepLoop 每帧调用: 1) expire 超 toleranceMs 的 recent press; 2) 把已 fileNoteOff 但还在 grace 窗口的 required 升级为真正 miss */
  update(songMs: number) {
    // recent 的过期窗口 = 命中窗口 ∪ 提前按窗口 (取大的那个)
    const t = Math.max(this.hitWindow(), this.earlyWindowMs)
    // recent press 超过容差 → 不再算 early-hit 候选, 但不立即算 wrong
    // (用户可能正在找键, 错按不应该立刻被记录)
    if (this.recent.size > 0) {
      this.recent = new Map(
        [...this.recent].filter(([, p]) => songMs - p.ts <= t),
      )
    }
    // required 里 fileNoteOff 已发生 + grace 过期 → 真正算 miss
    // (fileNoteOff 时只设 offTs 不 delete, 让 userPress 在 grace 内还能命中)
    if (this.required.size > 0) {
      const toMiss: number[] = []
      for (const [idx, press] of this.required) {
        if (press.offTs === undefined) continue
        if (press.holdForever) continue // 预览窗里的 note 不算 miss
        const win = press.graceMs ?? press.windowMs ?? this.hitWindow()
        if (songMs - press.offTs > win) {
          toMiss.push(idx)
        }
      }
      for (const idx of toMiss) {
        this.required.delete(idx)
        this.requiredIdx.delete(idx)
        this.version++
        this.stats.miss++
      }
    }
  }

  /**
   * 文件 NoteOn 触发时调用.
   * - 若该 noteIndex 已在 inProgress (文件中此 note 是按住延音), 忽略 (dedup)
   * - 若该 midi 用户最近按过 (recent 内), 算 early hit, 不入 required
   * - 否则加入 required (用户必须弹才能继续)
   */
  fileNoteOn(
    idx: number,
    midi: number,
    songMs: number,
    windowMs?: number,
    graceMs?: number,
  ): 'required' | 'early-matched' | 'duplicate' {
    if (this.inProgress.has(idx)) return 'duplicate'
    this.inProgress.add(idx)
    const recent = this.recent.get(midi)
    if (recent !== undefined) {
      // 文件撞上用户早期按键 (用户在 noteOn 之前先按了; neothesia 视为 played_early)
      const dtMs = songMs - recent.ts // positive (file came after user)
      this.recent.delete(midi)
      this.stats.playedDelta.push(-dtMs) // negative = 用户早
      this.stats.early++
      return 'early-matched'
    }
    this.required.set(idx, { ts: songMs, midi, offTs: undefined, windowMs, graceMs })
    this.requiredIdx.add(idx)
    this.version++
    return 'required'
  }

  /**
   * 把 note 从 required 里摘掉 (不再要求用户弹它).
   *
   * ★ 谁在用 (2026-11-05): 抢先模式的单手路径 —— required 是**游标驱动**的
   *   (游标走到哪, 哪一组 note 才进 required). 游标往前走 / 抢先模式被关掉 /
   *   跳转 (seek) 时, 上一组留下的条目必须清掉, 否则:
   *   - 抢先关掉后, wait 的冻结会卡在一个用户早就弹过的音上 (死等);
   *   - 游标前进后, 旧条目还占着 required → `areRequiredPressed()` 永远 false
   *     → 游标卡死.
   *
   * version++ 是必须的: getNoteStates() 的缓存 key 靠它失效.
   */
  releaseNote(idx: number) {
    if (!this.required.delete(idx)) return
    this.requiredIdx.delete(idx)
    this.version++
  }

  /**
   * 文件 NoteOff 触发时调用.
   * 返回 { missed: true } 表示该 note 已过 grace 还未被用户弹过, 算 miss.
   *
   * 修短音 bug: 极短音 (duration < 16ms = 1 frame) 经常同帧 fileNoteOn + fileNoteOff.
   * 旧逻辑立刻 delete required + stats.miss, userPress 在 grace 内找不到该 midi →
   * 误判 wrong. 新逻辑: fileNoteOff 只记 offTs, 让 userPress 还能命中; grace
   * 过期才在 update() 里真正 delete + miss.
   */
  fileNoteOff(idx: number, songMs: number, holdForever = false): { missed: boolean; dtMs: number } {
    this.inProgress.delete(idx)
    const press = this.required.get(idx)
    if (press === undefined) return { missed: false, dtMs: 0 }
    if (press.offTs !== undefined) return { missed: false, dtMs: songMs - press.offTs }
    press.offTs = songMs
    if (holdForever) press.holdForever = true
    // 不立即 delete / miss — 等 update() 过期
    return { missed: false, dtMs: songMs - press.ts }
  }

  /**
   * 游标驱动的登记 —— 抢先模式的**单手**路径用 (spec §R23 单手分支).
   *
   * 跟 fileNoteOn 的两处不同:
   *
   * 1) **不做 inProgress 去重** —— 游标驱动的场景里 inProgress 本来是空的
   *    (记账循环不再调 fileNoteOn), 但 note 可能**正在响** (玩家比伴奏慢,
   *    游标推到了还没结束的那个音). 那时 fileNoteOn 会返回 'duplicate'
   *    → 音永远进不了 required → 游标以为它弹过了 → 直接跳过这个音.
   *
   * 2) **holdForever** —— 漏不漏弹由 **Player** 判 (Player.expireLeadGroup):
   *    判据是「游标指到它之后多久还没弹」, 不是「伴奏什么时候走过它」.
   *    交给 PlayAlong.update() 判会跟这个判据打架 → 同一个音算两次漏弹.
   */
  cursorNoteOn(
    idx: number,
    midi: number,
    baselineMs: number,
    windowMs: number,
  ): 'required' | 'early-matched' {
    const recent = this.recent.get(midi)
    if (recent !== undefined) {
      // 玩家在游标指到它**之前**就按了 → 记成「提前弹」, 直接算命中.
      const dtMs = baselineMs - recent.ts
      this.recent.delete(midi)
      this.stats.playedDelta.push(-dtMs) // negative = 玩家早
      this.stats.early++
      return 'early-matched'
    }
    this.required.set(idx, {
      ts: baselineMs,
      midi,
      offTs: undefined,
      windowMs,
      holdForever: true,
    })
    this.requiredIdx.add(idx)
    this.version++
    return 'required'
  }

  /**
   * 把 note 重新加入 required (供 Player 在 userPress 误删非 active-hand 的情况下恢复).
   * 如果 idx 已在 required 里, 保留原始 ts.
   */
  requireNote(idx: number, midi: number, songMs: number, windowMs?: number) {
    if (this.required.has(idx)) return
    this.required.set(idx, { ts: songMs, midi, offTs: undefined, windowMs })
    this.requiredIdx.add(idx)
    this.version++
  }

  /**
   * 用户按键 (参考 neothesia: refs/neothesia/.../midi_player.rs user_press_key).
   * @param midi 用户按下的 midi
   * @param nowMs performance.now()
   *
   * 跟 neothesia 一样, 直接按 midi 查 required, 命中就删 (不需要 Player 预筛 candidates).
   * 这让 wait 模式在 Player 调用方 bug 时也能直接解冻 — 不再依赖 candidates 数组.
   */
  userPress(midi: number, songMs: number): PressResult {
    // 找出所有 required 中 midi 匹配的 (且在容差内 — 超 tolerance 不算 late hit, 留给 fileNoteOff 走 miss)
    const matched: number[] = []
    let dtMax = 0
    for (const [idx, press] of this.required) {
      if (press.midi !== midi) continue
      const dtMs = songMs - press.ts
      const win = press.windowMs ?? this.hitWindow()
      if (dtMs > win) continue // 超容差, 不算 hit
      if (dtMs > dtMax) dtMax = dtMs
      matched.push(idx)
    }
    if (matched.length > 0) {
      for (const idx of matched) {
        this.required.delete(idx)
        this.requiredIdx.delete(idx)
        this.version++
        this.stats.playedDelta.push(dtMax)
      }
      return { kind: 'late', matched, dtMs: dtMax }
    }
    // 没有 required 命中 (或超容差) — 看 recent 里是不是已有 (同 midi 重复按, 算 wrong)
    if (this.recent.has(midi)) {
      this.stats.wrong++
      return { kind: 'wrong' }
    }
    // 全新按键 → recent (toleranceMs 内若文件 NoteOn 来, 算 early hit)
    this.recent.set(midi, { ts: songMs })
    return { kind: 'recent-only', midi }
  }

  /** 是否所有 required 都已按下 — Player 据此冻结/推进 */
  areRequiredPressed(): boolean {
    return this.required.size === 0
  }

  /** 当前 required 大小 (UI 高亮计数) */
  requiredSize(): number {
    return this.required.size
  }

  /**
   * required 中所有 idx — UI 上色用.
   * 返回的是**增量维护的活集合** (spec P1-15) —— 调用方只能读, 别改.
   */
  requiredIndices(): ReadonlySet<number> {
    return this.requiredIdx
  }

  /** required 键集合版本号 (Player 缓存 getNoteStates 用) */
  get requiredVersion(): number {
    return this.version
  }

  /**
   * required 里最早的 note 时间 (ms) —— 冻结点用 (spec P2-10).
   *
   * 冻结判定原本用的是**帧时间**, 跟真正卡住用户的那个 note 差最多一帧 (16ms);
   * 更糟的是帧时间是累加出来的, 播久了会漂. 这里返回 note 的精确时间,
   * 让 Player 把歌曲时间回退到那个点上 (同 sightread player.ts:538-539).
   */
  requiredEarliestTs(): number | null {
    let min: number | null = null
    for (const press of this.required.values()) {
      if (min === null || press.ts < min) min = press.ts
    }
    return min
  }

  /**
   * 把"已经到点但用户还没弹"的 note 的判定基准改到 newTs (spec P2-10).
   *
   * 什么时候用: 冻结点**不能**大幅回退时 (e.g. 曲子开头的 0.5s 预览窗 ——
   * 冻结点从 0.6s 倒回 0s 会让画面和声音都"倒跳", 体感很差).
   * 这时改成把 note 的判定基准对齐到冻结点, 用户按下时 delta 才是 0.
   * 不对齐的话用户按下时 delta 会差半秒 → 永远判不中 → 卡死在 wait 模式.
   */
  rebaseRequired(newTs: number) {
    for (const press of this.required.values()) {
      if (press.ts <= newTs) press.ts = newTs
    }
  }

  /** 该 note 当前的判定窗口 (ms) — 供 UI 展示 / 调试 */
  windowOf(idx: number): number | undefined {
    return this.required.get(idx)?.windowMs
  }

  /** 重置 (seek / pause-clear) — 状态机回到干净 */
  clear() {
    this.resetPass()
    this.stats = { playedDelta: [], miss: 0, wrong: 0, early: 0 }
  }

  /**
   * 只重置「本轮」的跟弹状态, 保留统计 (playedDelta / miss / wrong / early).
   *
   * 循环回卷用: 第二遍不该把第一遍弹过的音重新 required 一遍 —— 否则
   * 同一批 note 会被要求两遍, hits 重复累加, 准确率的分子分母一起涨.
   * (见 docs/spec-2026-10-20-code-audit.md P0-2)
   */
  resetPass() {
    this.required.clear()
    this.requiredIdx.clear()
    this.version++
    this.recent.clear()
    this.inProgress.clear()
  }

  /** 调试用 */
  debug(): { required: number; recent: number; inProgress: number } {
    return {
      required: this.required.size,
      recent: this.recent.size,
      inProgress: this.inProgress.size,
    }
  }
}

export type { SongNote }
