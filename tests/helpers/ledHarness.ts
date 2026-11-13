// LED 灯条对照 harness —— 把「谱子」和「灯」放在同一个时间轴上对比
//
// 用途 (用户要求: "找一个方法对照谱子和灯光"):
//   1. 真值 (truth): 从谱子直接算出每个 midi 在什么时刻该亮 / 该灭
//      —— 开灯 = note.time, 灭灯 = min(下一组开始, note.time + 音条寿命)
//   2. 实际 (actual): 把**物理灯**上收到的 noteOn/noteOff 事件回放成亮着的集合
//   3. 逐帧 diff → 漏亮 / 残留
//
// ★ 2026-10-31 用户要求: 第一排只亮**当前这一组**音 —— 提前量已跟灯带解耦,
//   灯不再提前亮 (App 那边固定传 offsetMs = 0), 也不再渐亮.
//   「组」= 同一时刻的所有 note (两只手同时按 = 一组, 一起亮).
//   提前量现在**什么都不影响** (「提前按」独立模式已删, 2026-11-05) ——
//   harness 里仍然把它写进 store, 但它不再影响灯的时间轴, 也不影响判定.
//
// 为什么必须看「物理灯」而不是 follower 的输入事件:
//   follower 有 60ms 的 offGrace (防抖), 物理灭灯比逻辑事件晚 —— 看逻辑事件会漏掉闪烁.
//
// 为什么必须用 player.getCurrentTime() 当时间轴:
//   强制等待会**冻结**播放, 墙钟跟歌曲时间会脱节.

import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parseMidi } from '../../src/parser/parseMidi'
import { Player } from '../../src/engine/Player'
import { LedFollower } from '../../src/led/LedFollower'
import { LedScanCursor, groupEndTimes } from '../../src/led/scanCursor'
import { useStore, isActiveHand } from '../../src/store'
import { timingWindows } from '../../src/engine/Scoring'
import type { Song, SongNote } from '../../src/types'
import { NOTE_BAR_LIFETIME_S } from '../../src/types'

export const BWV846_PATH = resolve('public/library/bach/prelude-bwv846.mid')
export const hasBWV846 = existsSync(BWV846_PATH)

/**
 * follower 的灭灯防抖 grace (ms) —— 只对**输入源**生效 (真实键盘的竞态).
 *
 * ★ 2026-10-31: 播放源 (pre-scanner) 的灭灯是立即的 —— 下一组已经在同一帧
 *   点亮了, 再等 grace 会让两组灯同时亮着 (用户: 不能同时亮好几个音).
 */
export const OFF_GRACE_MS = 60

/** 播放器的帧长 (ms) —— 灭灯 grace 定时器最多晚一帧起跑 */
export const FRAME_MS = 16

export function loadSong(path = BWV846_PATH): Song {
  return parseMidi(new Uint8Array(readFileSync(path)))
}

export function makeStubs() {
  return {
    synth: {
      setMasterVolume: () => {}, resume: () => {}, playNote: () => {},
      stopNote: () => {}, stopAll: () => {}, getCtx: () => null,
    } as any,
    acc: {
      transpose: 0, isEnabled: () => false, setVolume: () => {},
      sendNoteOn: () => {}, sendNoteOff: () => {}, panic: () => {}, silence: () => {},
    } as any,
    metronome: { tick: () => {} } as any,
    countdown: { start: (cb: () => void) => cb(), cancel: () => {} } as any,
  }
}

export interface LedEvent {
  /** 歌曲时间 (秒) */
  t: number
  op: 'on' | 'off'
  midi: number
  hand?: 'left' | 'right'
}

export interface HarnessOpts {
  hand?: 'playback' | 'both' | 'right' | 'left'
  wait?: boolean
  /** LED 提前量 (单位 100ms) */
  offsetUnits?: number
  /** 跑多少秒 (歌曲时间) */
  seconds?: number
  /**
   * 用户按哪些键:
   *   'all'  = 每个 note 都按 (在 note.time)
   *   'none' = 完全不按 (漏弹流)
   *   Set    = 只按这些 midi (其余漏弹)
   */
  press?: 'all' | 'none' | Set<number>
  /** 切歌时刻 (歌曲时间, 秒) —— 测「刷新曲目强制清灯」 */
  switchSongAt?: number
  /** 切歌时是否同时重置 follower (现状 = false) */
  clearFollowerOnSwitch?: boolean
  /**
   * 在这个歌曲时刻 (秒) 停播 (模拟暂停 / 曲终) —— 之后走 App.tsx 的
   * "停播清灯" 路径 (pre-scanner 的 flush + follower 的 clearAll).
   */
  stopAt?: number
  song?: Song
}

export interface HarnessResult {
  /** 物理灯事件流 (按时间) */
  events: LedEvent[]
  /** 每帧 diff: 漏亮 / 残留 */
  diffs: string[]
  /** note 级别的对照结果 (见 checkNotes) */
  noteChecks: NoteCheck[]
  /** 结束时还亮着的 midi */
  lit: Set<number>
  player: Player
  follower: LedFollower
  song: Song
  notes: SongNote[]
}

/**
 * note 级别的对照结果.
 *
 * 逐帧 diff 对 16ms 的量化误差太敏感 (灯的 ON/OFF 都落在帧边界上,
 * 真值是精确的 note 时刻) —— 逐帧比必然有几十毫秒的毛刺.
 * note 级别才是"灯跟谱子对不对得上"的真正判据:
 *
 *   onAtStart   该 note 开灯时刻 (note.time - 提前量) 灯是否已亮
 *   onDuring    note 发声期间 (note.time) 灯是否亮着  —— 亮着才跟得上
 *   offAfter    note 结束后灯是否在容差窗口内灭了     —— 没灭 = 残留
 *   lateOff     灭灯比 note 结束晚了多少 (ms), 负 = 提前灭了
 */
export interface NoteCheck {
  idx: number
  midi: number
  hand?: string
  /** 开灯时刻 (歌曲时间) */
  expectOn: number
  /** 灭灯时刻 (歌曲时间) */
  expectOff: number
  /** note 发声时灯是否亮着 */
  onDuring: boolean
  /** 灯覆盖了 note 发声窗口的比例 (0~1) */
  coverRatio: number
  /** 灭灯时刻 (实测, undefined = 一直没灭) */
  actualOff?: number
  /** 灭灯相对 expectOff 的偏差 (ms), undefined = 没灭 */
  offDeltaMs?: number
  /** note 结束后灯还亮着 (残留) */
  residue: boolean
}

/** 灭灯的容差窗口 (ms): follower 的 60ms grace + 最多一帧的量化误差 */
export const OFF_TOLERANCE_MS = OFF_GRACE_MS + FRAME_MS + 8

/**
 * 漏弹 note 的灯能合法亮多久 (ms).
 *
 * `LedScanCursor` 对还在 `required` 里的 note **不灭灯** —— 灯留着当
 * "这个键你还没按" 的提示. note 结束 (noteOff) 之后, note 还要在 `required`
 * 里待一个判定窗口 (hitWindow, 120bpm 下 250ms), 过期才升级成 miss +
 * 从 required 里删掉 → 此时补一个灭灯.
 *
 * 所以 note 结束到灯真正灭掉之间, 有一个**合法**的滞留期:
 *
 *     灭灯最晚 = note 结束 + hitWindow + OFF_TOLERANCE
 *
 * 判定残留时必须算上这一段, 否则每个"用户没按的 note"都会被误报成残留.
 */
export function missGraceMs(song: Song): number {
  const bpm = song.bpms?.[0]?.bpm ?? 120
  return timingWindows(bpm, 300).hit
}

/**
 * note 级别的对照: 每个 note 该亮的时候亮没亮, 该灭的时候灭没灭.
 *
 * 判据用**区间**而不是采样点 —— 采样点会被 16ms 的帧量化打毛刺:
 *   - onDuring: 灯的亮灭区间有没有盖住 note 的**发声窗口** [n.time, 这一组结束].
 *   - residue: 对应的那段灯, 在「接力链」结束后的容差窗口内有没有灭.
 *
 * ★ 2026-10-31 的灯语义: 第一排只亮**当前这一组**音.
 *   开灯 = note.time; 灭灯 = min(下一组开始, note.time + 音条寿命 0.5s).
 *   「组」= 同一时刻的所有 note —— 跟 LedScanCursor 用的是同一套口径
 *   (groupEndTimes), 免得两处各算一遍算出两套答案.
 *   同一个键的下一个 note 紧跟着这一组开始 → 灯**接力** (不会灭),
 *   所以残留判定要按「接力链」的末端算, 不是单个 note 的灭灯时刻.
 *
 * @param events 物理灯事件流
 * @param notes  谱子的 note (按时间排序)
 * @param song   谱子 (取 hands)
 * @param _offsetMs LED 提前量 (ms) —— ★ 已跟灯带解耦, 不再参与计算 (留着是为了不改调用方签名)
 * @param practiceHand 当前练习手
 * @param until  只检查这个时间之前的 note (没播到的 note 不算)
 */
export function checkNotes(
  events: LedEvent[],
  notes: SongNote[],
  song: Song,
  _offsetMs: number,
  practiceHand: any,
  until = Infinity,
  _pressedIdx?: ReadonlySet<number>,
): NoteCheck[] {
  // 每个 midi 的亮灭区间
  const spans = lightTimeline(events)
  const out: NoteCheck[] = []

  // 每个 note 所在「组」的结束时刻 (秒) —— 下一组开始的时刻.
  const groupEndMs = groupEndTimes(notes)
  const expectOffOf = (i: number) =>
    Math.min(groupEndMs[i] / 1000, notes[i].time + NOTE_BAR_LIFETIME_S)

  // 每个 midi 的下一个 note (灯可以合法地一直亮到下一个同音 note 接上)
  const nextOf = new Map<number, number>()
  {
    const seen = new Map<number, number>() // midi → 下一个 note 的下标
    for (let i = notes.length - 1; i >= 0; i--) {
      const m = notes[i].midiNote
      nextOf.set(i, seen.get(m) ?? -1)
      seen.set(m, i)
    }
  }

  // 「接力链」的末端: 这个 note 的灯实际会亮到什么时候.
  // 下一个同音 note 的开灯时刻 <= 本 note 的灭灯时刻 → 灯不灭, 接到下一棒.
  const chainEnd = new Map<number, number>()
  for (let i = notes.length - 1; i >= 0; i--) {
    const offI = expectOffOf(i)
    let end = offI
    const j = nextOf.get(i) ?? -1
    if (j >= 0 && isActiveHand(notes[j].hand, notes[j].track, song.hands, practiceHand)) {
      const onJ = notes[j].time
      if (onJ <= offI) end = chainEnd.get(j) ?? offI
    }
    chainEnd.set(i, end)
  }

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (!isActiveHand(n.hand, n.track, song.hands, practiceHand)) continue
    if (n.time > until) continue
    const expectOn = n.time
    const expectOff = expectOffOf(i)
    const endOfChain = chainEnd.get(i) ?? expectOff

    // 到「接力链末端 + 容差」还没到 → 现在还判不了 (灯亮着可能是对的)
    const deadline = endOfChain + OFF_TOLERANCE_MS / 1000
    if (deadline > until) continue

    const list = spans.get(n.midiNote) ?? []
    // 相邻的灯段合并 (接力时物理灯没有真的灭过)
    const merged = mergeSpans(list)

    // 灯该亮到什么时候: 这一组结束 (下一组开始) 或 音条消失, 取先到的.
    const soundingEnd = n.time + n.duration
    const barEnd = Math.min(soundingEnd, expectOff)

    // 落键那一刻灯必须亮着, 且一直亮到 barEnd.
    //
    // EPS = 一帧的量化误差 —— 事件都落在帧边界上, 物理上只能在下一帧才点得着.
    const EPS = FRAME_MS / 1000
    let seg: [number, number] | undefined
    for (const sp of merged) {
      if (sp[0] <= n.time + EPS && sp[1] >= n.time - EPS) { seg = sp; break }
    }
    const actualOff = seg && seg[1] !== Infinity ? seg[1] : undefined
    const onDuring = seg !== undefined && seg[1] >= barEnd - EPS
    const coverRatio = seg
      ? Math.max(0, Math.min(seg[1], barEnd) - Math.max(seg[0], n.time)) /
        Math.max(1e-6, barEnd - n.time)
      : 0

    out.push({
      idx: i,
      midi: n.midiNote,
      hand: n.hand,
      expectOn,
      expectOff,
      // 灯盖住了「落键 → 这一组结束」这一段 = 跟得上
      onDuring,
      coverRatio,
      actualOff,
      offDeltaMs: actualOff !== undefined ? (actualOff - endOfChain) * 1000 : undefined,
      // 到 deadline 还没灭 = 残留
      residue: actualOff === undefined || actualOff > deadline,
    })
  }
  return out
}

/** 把相邻/重叠的亮灯区间合并成一段 (接力时物理灯没有真的灭过). */
function mergeSpans(list: Array<[number, number]>): Array<[number, number]> {
  if (list.length === 0) return []
  const sorted = [...list].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]]
  for (const sp of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (sp[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], sp[1])
    else out.push([sp[0], sp[1]])
  }
  return out
}

/** 跑一段, 返回物理灯事件流 + 逐帧 diff */
export function runLedHarness(opts: HarnessOpts = {}): HarnessResult {
  const {
    hand = 'both', wait = true, offsetUnits = 0,
    seconds = 6, press = 'all', switchSongAt, clearFollowerOnSwitch = false,
    stopAt,
  } = opts

  const song = opts.song ?? loadSong()
  const notes = song.notes as SongNote[]

  useStore.setState({
    hand, wait, speed: 1, currentTime: 0, isPlaying: false,
    hits: 0, misses: 0, errors: 0, perfects: 0, goods: 0, streak: 0, maxStreak: 0,
    ledOffsetUnits: offsetUnits,
    ledEnabled: true, ledFollowPlayback: true, ledFollowInput: false,
  })

  const events: LedEvent[] = []
  let now = 0
  const led = {
    noteOn: (m: number, h?: any) => events.push({ t: now, op: 'on', midi: m, hand: h }),
    noteOff: (m: number, h?: any) => events.push({ t: now, op: 'off', midi: m, hand: h }),
    allOff: () => events.push({ t: now, op: 'off', midi: -1 }),
    show: async () => {},
    setBrightness: () => {}, setMode: () => {}, setSplit: () => {},
    setHandMap: () => {}, setColors: () => {}, setCalibrate: () => {},
  }
  const follower = new LedFollower({
    led: led as any, isEnabled: () => true, followSource: 'playback', offGraceMs: 60,
  })

  const s = makeStubs()
  const player = new Player(
    song, s.synth, s.acc, s.metronome, s.countdown,
    (n: any, hit: boolean) => {
      if (hit) follower.handleEvent({ type: 'down', midi: n.midiNote, velocity: 1, t: 0, source: 'hit', hand: n.hand })
      // 播放源 (playback) 的灯**一律**不发 —— 真实代码里 emit.ts 无条件抑制了
      // Player 的 playback 直发 (播放层归 pre-scanner 独占).
    },
    () => {
      // 同上: playback 的 noteOff 也不发.
    },
  )

  player.play()

  // 播放层的灯**一律**由 pre-scanner 接管 (2026-10-30: Player 的 playback 直发
  // 被 emit.ts 无条件抑制) —— 提前量是不是 0 都一样.
  const cursor = new LedScanCursor(notes)
  // ★ 2026-10-31: 提前量已跟灯带解耦 —— App 那边固定传 0 (灯不再提前亮).
  //   offsetUnits 现在只写进 store —— 什么都不影响 (「提前按」模式已删).
  const offsetMs = 0
  /** 每个 note 所在「组」的结束时刻 (ms) —— 下一组开始的时刻. */
  const groupEndMs = groupEndTimes(notes)

  const frames = Math.round(seconds * 1000 / 16)
  const diffs: string[] = []
  const lit = new Set<number>()
  let applied = 0
  let switched = false
  let stopped = false
  /** 用户**真的按了**的 note 下标 (按下的那一刻记) */
  const pressedIdx = new Set<number>()
  /** press 时刻到了的 note (不管按没按 —— 每个 note 只触发一次) */
  const pressDue = new Set<number>()
  /** 命中脉冲的到期时刻 (歌曲时间) */
  const pulseUntil = new Map<number, number>()

  for (let f = 0; f < frames; f++) {
    // Player 自己的 16ms 定时器驱动 stepLoop —— 不要手动再调 (会走两遍)
    vi.advanceTimersByTime(16)
    const songNow = player.getCurrentTime()
    now = songNow

    if (cursor) {
      cursor.advance(
        songNow * 1000, offsetMs,
        (idx, on) => {
          const n = notes[idx]
          follower.handleEvent({
            type: on ? 'down' : 'up', midi: n.midiNote, velocity: 1, t: 0,
            source: 'playback', hand: n.hand,
          })
        },
      )
    }

    // 用户按键: 模拟"看到灯亮就按".
    //
    // ★ 2026-10-31: 灯不再提前亮 (提前量已跟灯带解耦) → 灯亮 = note.time,
    //   用户按的时刻就是 note.time.
    const pressShift = 0
    for (let i = 0; i < notes.length; i++) {
      if (pressDue.has(i)) continue
      const n = notes[i]
      const pressTime = Math.max(0, n.time - pressShift)
      if (pressTime > songNow || pressTime <= songNow - 0.016) continue
      pressDue.add(i)
      if (press !== 'all' && (press === 'none' || !press.has(n.midiNote))) continue
      if (!isActiveHand(n.hand, n.track, song.hands, useStore.getState().hand)) continue
      const before = useStore.getState().hits
      player.handleInput({ type: 'down', midi: n.midiNote, source: 'input', velocity: 80, t: 0 })
      if (useStore.getState().hits > before) {
        pressedIdx.add(i)
        pulseUntil.set(n.midiNote, songNow + 0.15)
      }
      player.handleInput({ type: 'up', midi: n.midiNote, source: 'input', t: 0 })
    }

    if (switchSongAt !== undefined && !switched && songNow >= switchSongAt) {
      switched = true
      // App.tsx 的 song effect: 清像素, 但**没有**重置 follower 状态
      led.allOff()
      if (clearFollowerOnSwitch) follower.clearAll()
      cursor?.reset()
    }

    // 停播 (暂停 / 曲终): App.tsx 的 pre-scanner cleanup 会 flush 游标点的灯,
    // follower 也 clearAll —— 提前量 != 0 时 Player 的 noteOff 被 emit.ts 抑制,
    // 灯只有 pre-scanner 能灭.
    if (stopAt !== undefined && !stopped && songNow >= stopAt) {
      stopped = true
      player.pause()
      cursor?.flush((idx, on) => {
        const n = notes[idx]
        follower.handleEvent({
          type: on ? 'down' : 'up', midi: n.midiNote, velocity: 1, t: 0,
          source: 'playback', hand: n.hand,
        })
      })
      follower.clearAll()
    }

    // ── 应用物理灯事件 → lit ──
    while (applied < events.length) {
      const e = events[applied++]
      if (e.midi === -1) { lit.clear(); continue }
      if (e.op === 'on') lit.add(e.midi)
      else lit.delete(e.midi)
    }

    // ── 真值 ──
    // 灯 = 当前这一组音 (2026-10-31 语义):
    //   开灯 = note.time; 灭灯 = min(下一组开始, note.time + 音条寿命 0.5s)
    //
    // 灭灯时刻再加一帧 —— 播放源的灭灯是立即的 (没有 grace), 但事件是在
    // **某一帧**才吐出来的 → 物理灭灯最多晚一帧 (16ms).
    const truth = new Set<number>()
    const practiceHand = useStore.getState().hand
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]
      if (!isActiveHand(n.hand, n.track, song.hands, practiceHand)) continue
      const on = n.time
      const off =
        Math.min(groupEndMs[i] / 1000, n.time + NOTE_BAR_LIFETIME_S) + FRAME_MS / 1000
      if (songNow >= on && songNow < off) truth.add(n.midiNote)
    }
    for (const [m, until] of pulseUntil) if (songNow < until) truth.add(m)

    for (const m of truth) if (!lit.has(m)) diffs.push(`t=${songNow.toFixed(3)} 漏亮 midi=${m}`)
    for (const m of lit) if (!truth.has(m)) diffs.push(`t=${songNow.toFixed(3)} 残留 midi=${m}`)
  }

  const finalT = player.getCurrentTime()
  return {
    events, diffs, lit, player, follower, song, notes,
    // 只检查已经播到过的 note (之后的 note 灯还没亮, 不算漏)
    // pressedIdx 告诉对照器哪些 note 用户真的按了 —— 没按的 note 灯可以合法滞留
    noteChecks: checkNotes(
      events, notes, song, offsetMs, useStore.getState().hand, finalT,
      pressedIdx,
    ),
  }
}

/**
 * 把灯事件流压成「每盏灯的亮灭区间」, 便于跟谱子逐条对照.
 */
export function lightTimeline(events: LedEvent[]): Map<number, Array<[number, number]>> {
  const tl = new Map<number, Array<[number, number]>>()
  const open = new Map<number, number>()
  for (const e of events) {
    if (e.midi === -1) { for (const [m, t] of open) { push(tl, m, t, e.t); open.delete(m) } continue }
    if (e.op === 'on') {
      // 同一个 midi 连续 ON (没有中间的 OFF) → 前一段在此结束
      const t = open.get(e.midi)
      if (t !== undefined) push(tl, e.midi, t, e.t)
      open.set(e.midi, e.t)
    } else {
      const t = open.get(e.midi)
      if (t !== undefined) { push(tl, e.midi, t, e.t); open.delete(e.midi) }
    }
  }
  // 还在亮的 → 区间到 Infinity
  for (const [m, t] of open) push(tl, m, t, Infinity)
  for (const arr of tl.values()) arr.sort((a, b) => a[0] - b[0])
  return tl
}

function push(tl: Map<number, Array<[number, number]>>, m: number, a: number, b: number) {
  const arr = tl.get(m) ?? []
  arr.push([a, b])
  tl.set(m, arr)
}

/** 谱子侧的真值区间 (同 runLedHarness 的口径: 开灯 = note.time, 灭灯 = 下一组开始) */
export function scoreTimeline(
  notes: SongNote[], song: Song, _offsetMs: number, practiceHand: any,
): Map<number, Array<[number, number]>> {
  const tl = new Map<number, Array<[number, number]>>()
  const groupEndMs = groupEndTimes(notes)
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (!isActiveHand(n.hand, n.track, song.hands, practiceHand)) continue
    const on = n.time
    const off = Math.min(groupEndMs[i] / 1000, n.time + NOTE_BAR_LIFETIME_S)
    const arr = tl.get(n.midiNote) ?? []
    arr.push([on, off])
    tl.set(n.midiNote, arr)
  }
  for (const arr of tl.values()) arr.sort((a, b) => a[0] - b[0])
  return tl
}

/** 打印谱-灯对照表 */
export function printComparison(
  notes: SongNote[], song: Song, events: LedEvent[], offsetMs: number,
  practiceHand: any, limit = 16,
) {
  const lt = lightTimeline(events)
  const st = scoreTimeline(notes, song, offsetMs, practiceHand)
  const midis = [...new Set([...lt.keys(), ...st.keys()])].sort((a, b) => a - b)
  console.log('\n=== 谱子 vs 灯 (midi | 谱子亮灭窗口 | 灯亮灭窗口) ===')
  for (const m of midis.slice(0, limit)) {
    const f = (arr?: Array<[number, number]>) =>
      arr ? arr.slice(0, 4).map(([a, b]) => `${a.toFixed(2)}~${b === Infinity ? '∞' : b.toFixed(2)}`).join(' ') : '-'
    console.log(`  midi=${m}\n    谱: ${f(st.get(m))}\n    灯: ${f(lt.get(m))}`)
  }
}

// vitest 的 vi 在本模块里用到 (runLedHarness 内部) —— 延迟 import 避免循环
import { vi } from 'vitest'
