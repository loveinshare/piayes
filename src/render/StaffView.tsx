// StaffView — VexFlow 5 渲染五线谱 (双大谱表 / 钢琴)
//
// 设计要点:
//   1. 每只手 = 1 个 VexFlow Voice. 钢琴标准记谱就是单声部每手, stem 方向由 VexFlow
//      根据音高自动判定 (高音谱号上音 → stem 向下, 低音谱号下音 → stem 向上).
//   2. 用真休止符 (`StaveNote` duration `'qr'`/`'hr'`/...) 填充空拍, 不再 GhostNote.
//   3. Cross-measure tie 用 **midi 整数** 匹配, 跨 enharmonic (F#4 ↔ Gb4) 也对.
//   4. Beam 组在节拍边界断开: `8 + 16` 跨到下一拍就不再合并.
//   5. 强制 snap 到 VexFlow 时值网格 (whole/half/quarter/eighth/16th, 可加点).
//      这样 `Voice` 的总 ticks 永远等于 numBeats * beatValue * RESOLUTION, 不报 BadTicks.
//
// 数据模型:
//   measureBeats[mIdx] = { right: HandBeats; left: HandBeats }
//   HandBeats = { beats: BeatEvent[]; pendingTies: { midi: number }[] }

import { useEffect, useRef } from 'react'
import {
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  Voice,
  Formatter,
  Barline,
  Beam,
  Accidental,
  StaveTie,
} from 'vexflow'
import { useStore } from '../store'
import { COLORS } from './colors'
import type { Song, SongNote, Hand } from '../types'
import { TempoMap } from '../util/tempoMap'

// 布局参数
const PADDING = 32
const MIN_MEASURE_WIDTH = 140
const MAX_MEASURE_WIDTH = 220
const CHORD_EPS = 0.02 // onset grouping epsilon (seconds)
const SYSTEM_HEIGHT = 90 // 每个 system 的垂直高度 (treble 40 + gap 10 + bass 40)
const SYSTEM_GAP = 8 // system 之间的间距

// VexFlow 支持的时值 (quarter 为单位), 含 dot. 排好序, 后面 snap 用二分.
// 含 64th (0.0625) — 之前的代码 clamp 到 32nd, 快节奏片段会失真.
const DURATION_VALUES_Q: Array<[number, string]> = [
  [4, 'w'],
  [3, 'hd'],
  [2, 'h'],
  [1.5, 'qd'],
  [1, 'q'],
  [0.75, '8d'],
  [0.5, '8'],
  [0.375, '16d'],
  [0.25, '16'],
  [0.1875, '32d'],
  [0.125, '32'],
  [0.09375, '64d'],
  [0.0625, '64'],
]

/**
 * 音符持续 (quarter 为单位) → VexFlow 时值 code.
 *
 * 规则 (比 plan B 简化):
 *   - 选 ≤ 实际值 的最大 VexFlow 时值 — 永远不会 overshoot
 *   - 但若 remainder 够长 (≥ 0.5 下一档) , 升级到下一档 (e.g. 1.6q 变 'h' = 2q 而不是 'q' = 1q)
 *   - 例外: 半拍/全拍 升级留给 fillWithRests 用 'qr'/'hr' 补 rest, 不要覆盖更小节拍
 *   - 永不返回超过实际值的 code (避免 BadTicks)
 */
function durationToVex(durInQuarter: number): string {
  if (durInQuarter <= 0) return '64' // 防御: 0 时长用最小, 不会 overshoot
  // DURATION_VALUES_Q 是降序 (w → 64). 找 ≤ 实际值 的最大时值: 跳过所有 > x 的, 第一个 ≤ x 的就是要的
  let snapped: [number, string] = DURATION_VALUES_Q[DURATION_VALUES_Q.length - 1]
  for (const v of DURATION_VALUES_Q) {
    if (v[0] <= durInQuarter + 1e-6) {
      snapped = v
      break
    }
  }
  // 升级判定: 剩余空间 (actual - snapped) 是否 ≥ snapped 的一半?
  // 不要升级到全/半拍 (会跨越 1/2 拍边界) — 由 fillWithRests 的 rest 补
  const [v, str] = snapped
  if (str === 'w' || str === 'h') return str
  if (durInQuarter - v >= v * 0.5 + 1e-6) {
    // 找下一个更大的时值 (数组降序, 索引更小)
    const idx = DURATION_VALUES_Q.indexOf(snapped)
    if (idx > 0) return DURATION_VALUES_Q[idx - 1][1]
  }
  return str
}

/** 音符持续 → VexFlow 休止符 code (附 'r'). */
function restToVex(durInQuarter: number): string {
  return durationToVex(durInQuarter) + 'r'
}

function ticksForDuration(d: string): number {
  if (d === 'w' || d === 'wd') return 4
  if (d === 'h' || d === 'hd') return 2
  if (d === 'q' || d === 'qd' || d === 'qr' || d === 'qrd') return 1
  if (d === '8' || d === '8d' || d === '8r' || d === '8rd') return 0.5
  if (d === '16' || d === '16d' || d === '16r' || d === '16rd') return 0.25
  if (d === '32' || d === '32d' || d === '32r' || d === '32rd') return 0.125
  if (d === '64' || d === '64d' || d === '64r' || d === '64rd') return 0.0625
  return 1
}

function midiToVexKey(midi: number): string {
  const names = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
  const pc = ((midi % 12) + 12) % 12
  const oct = Math.floor(midi / 12) - 1
  return names[pc] + '/' + oct
}

/**
 * Greedy bin-pack measures into systems.
 * Input: 每个 measure 的估算宽度 + 每个 system 的可用宽度 (容器宽 - padding).
 * Output: system boundaries — system i 包含 [startIdx, endIdx] (含).
 * 例: binPackIntoSystems([100, 200, 150, 100], 400) → [[0, 1], [2, 3]]  (前 2 个塞第一行, 后 2 个塞第二行)
 * greedy: 一个 measure 超过 availableWidth 时, 单独占一行 (不切 measure).
 */
export function binPackIntoSystems(
  measureWidths: number[],
  availableWidth: number,
): Array<{ startIdx: number; endIdx: number }> {
  if (measureWidths.length === 0) return []
  const systems: Array<{ startIdx: number; endIdx: number }> = []
  let start = 0
  let acc = 0
  for (let i = 0; i < measureWidths.length; i++) {
    const w = measureWidths[i]
    if (i > start && acc + w > availableWidth) {
      // 当前 measure 放不下, 结束当前 system
      systems.push({ startIdx: start, endIdx: i - 1 })
      start = i
      acc = w
    } else {
      acc += w
    }
  }
  if (start <= measureWidths.length - 1) {
    systems.push({ startIdx: start, endIdx: measureWidths.length - 1 })
  }
  return systems
}

function fifthsToKeyName(fifths: number): string {
  const names = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
  return names[fifths + 7] ?? 'C'
}

function noteHandOf(n: SongNote, song: Song): Hand {
  if (n.hand) return n.hand
  if (song.pitchSplit !== undefined) {
    return n.midiNote < song.pitchSplit ? 'left' : 'right'
  }
  if (n.track === song.hands.left) return 'left'
  return 'right'
}

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------
interface BeatEvent {
  keys: string[]
  midis: number[]
  time: number
  durInQuarter: number
  isRest: boolean
  /** chord 里每个音对应 song.notes 数组下标, 用来查 player.getNoteStates() (noteIndex-keyed) 做上色. */
  noteIndex: number[]
}

interface HandBeats {
  beats: BeatEvent[]
  /** 待向后一小节连 tie 的源 — 记录 midi, 下一小节找匹配 */
  pendingTies: { midi: number }[]
}

type MeasureBeats = {
  right: HandBeats
  left: HandBeats
}

// ---------------------------------------------------------------------------
// 把 song.notes 摊平成 (measureIdx, handIdx) 的 BeatEvent[], 按 onset (CHORD_EPS) 合并
// ---------------------------------------------------------------------------
function buildMeasureBeats(song: Song): MeasureBeats[] {
  // tempo map (spec P2-3 / P1-18): 时值换算要按**该音所在时刻**的速度,
  // 不能用整首第一个 BPM —— 变速的曲子会整体错.
  const tempoMap = new TempoMap(song.bpms, song.timeSignature.denominator)

  const out: MeasureBeats[] = song.measures.map(() => ({
    right: { beats: [], pendingTies: [] },
    left: { beats: [], pendingTies: [] },
  }))

  // 1) 把每个 note 落到 (mIdx, hand), 同时记下 song.notes 数组下标
  const assigned: { num: number; hand: Hand; note: SongNote; noteIndex: number }[] = []
  for (let i = 0; i < song.notes.length; i++) {
    const n = song.notes[i]
    let mIdx = 0
    for (let mi = 0; mi < song.measures.length; mi++) {
      if (n.time >= song.measures[mi].time - 0.001) mIdx = mi
      else break
    }
    const hand = noteHandOf(n, song)
    assigned.push({ num: mIdx, hand, note: n, noteIndex: i })
  }

  // 2) 同一 (measureIdx, hand) 内按 onset 时间分组
  type Group = { mIdx: number; hand: Hand; notes: SongNote[]; noteIndices: number[] }
  const groups: Group[] = []
  const sorted = [...assigned].sort(
    (a, b) =>
      a.num - b.num ||
      (a.hand === b.hand ? 0 : a.hand === 'right' ? -1 : 1) ||
      a.note.time - b.note.time,
  )
  for (const a of sorted) {
    const last = groups[groups.length - 1]
    if (
      last &&
      last.mIdx === a.num &&
      last.hand === a.hand &&
      Math.abs(last.notes[0].time - a.note.time) < CHORD_EPS
    ) {
      last.notes.push(a.note)
      last.noteIndices.push(a.noteIndex)
    } else {
      groups.push({ mIdx: a.num, hand: a.hand, notes: [a.note], noteIndices: [a.noteIndex] })
    }
  }

  // 3) 每个 group 推入对应手 (single voice, 持续 = max note duration)
  for (const g of groups) {
    const handBeats = out[g.mIdx][g.hand]
    const notes = [...g.notes].sort((a, b) => b.midiNote - a.midiNote)
    // noteIndices 按 midi 降序重排, 跟 midis 平行
    const sortedIdx: number[] = notes.map((n) => g.noteIndices[g.notes.indexOf(n)])
    handBeats.beats.push({
      keys: notes.map((n) => midiToVexKey(n.midiNote)),
      midis: notes.map((n) => n.midiNote),
      time: g.notes[0].time,
      // durInQuarter 的单位是"四分音符" —— 音符时长是**秒**, 必须除以
      // 该时刻一个四分音符的秒数. (旧实现乘 quarterPerWhole, 量纲错了 ——
      //  120bpm 的四分音符被算成 0.5 个四分音符, 乐谱里全是短音+长休止. spec P1-18)
      durInQuarter: Math.max(
        ...notes.map((n) => n.duration / tempoMap.secPerQuarterAt(n.time)),
      ),
      isRest: false,
      noteIndex: sortedIdx,
    })
  }

  // 4) 找出 cross-measure ties (note.time + duration > measureEnd)
  for (let mi = 0; mi < out.length; mi++) {
    const mEnd = song.measures[mi].time + song.measures[mi].duration
    for (const hand of ['right', 'left'] as const) {
      const hb = out[mi][hand]
      for (const b of hb.beats) {
        if (b.isRest) continue
          const endSec = b.time + b.durInQuarter * tempoMap.secPerQuarterAt(b.time)
        if (endSec > mEnd + 0.001) {
          for (const midi of b.midis) {
            hb.pendingTies.push({ midi })
          }
        }
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// 在两小节之间插入休止符. 关键: 若 beat 跨过 measure 边界, 裁剪 durInQuarter
// 令本小节刚好填满. snap 到 VexFlow 时值后, 总和 = measureDur.
// ---------------------------------------------------------------------------
function fillWithRests(
  beats: BeatEvent[],
  measureTime: number,
  measureDur: number,
  secPerQuarterAt: (t: number) => number,
): BeatEvent[] {
  const measureEnd = measureTime + measureDur
  const measureDurInQuarter = measureDur / secPerQuarterAt(measureTime)
  if (beats.length === 0) {
    return [{
      keys: ['b/4'],
      midis: [],
      time: measureTime,
      durInQuarter: measureDurInQuarter,
      isRest: true,
      noteIndex: [],
    }]
  }
  const out: BeatEvent[] = []
  let cursorSec = measureTime
  const EPS = 0.005
  for (const b of beats) {
    const gap = b.time - cursorSec
    if (gap > EPS) {
      out.push({
        keys: ['b/4'],
        midis: [],
        time: cursorSec,
        durInQuarter: gap / secPerQuarterAt(cursorSec),
        isRest: true,
        noteIndex: [],
      })
    }
    // 若 beat 跨过 measure 边界, 裁剪 durInQuarter 令本小节刚好填满
    // 剩余部分由下一小节对应音的 tie 接上 (pendingTies 已记录)
    const rawEndSec = b.time + b.durInQuarter * secPerQuarterAt(b.time)
    const clippedDurInQuarter =
      rawEndSec > measureEnd + EPS
        ? (measureEnd - b.time) / secPerQuarterAt(b.time)
        : b.durInQuarter
    const clipped: BeatEvent =
      clippedDurInQuarter < b.durInQuarter - 0.001
        ? { ...b, durInQuarter: Math.max(clippedDurInQuarter, 0.05) }
        : b
    out.push(clipped)
    cursorSec = b.time + clipped.durInQuarter * secPerQuarterAt(b.time)
  }
  const tail = measureEnd - cursorSec
  if (tail > EPS) {
    out.push({
      keys: ['b/4'],
      midis: [],
      time: cursorSec,
      durInQuarter: tail / secPerQuarterAt(cursorSec),
      isRest: true,
      noteIndex: [],
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 把 BeatEvent[] 转成 StaveNote[] + Beam[], snap 到 VexFlow 时值.
// 这里 durInQuarter 已是连续的 (fillWithRests 后), 但 snap 后可能总和 < 期望.
// 用 snappedTotal 校验; 不够时 **在尾部追加 rest** 补足 (rest 不会与原 note 冲突).
// ---------------------------------------------------------------------------
function buildStaveNotes(
  beats: BeatEvent[],
  hand: Hand,
  secPerQuarterAt: (t: number) => number,
  expectedQuarters: number,
  timeSig: { numerator: number; denominator: number } = { numerator: 4, denominator: 4 },
): { notes: StaveNote[]; beams: Beam[] } {
  const handColor = hand === 'right' ? COLORS.hand.right : COLORS.hand.left
  const clef = hand === 'right' ? 'treble' : 'bass'
  const EPS_Q = 0.02

  // 第一遍: snap 每个 beat 的 durInQuarter 到最近 VexFlow 时值 (round down)
  type Snapped = { dur: string; quarter: number; isRest: boolean; beat: BeatEvent }
  const snapped: Snapped[] = beats.map((b) => {
    if (b.isRest) {
      const dur = restToVex(b.durInQuarter)
      return { dur, quarter: ticksForDuration(dur), isRest: true, beat: b }
    }
    const dur = durationToVex(b.durInQuarter)
    return { dur, quarter: ticksForDuration(dur), isRest: false, beat: b }
  })

  // 第二遍: 校验总和. 不够时, 优先延长最后一个 rest, 不足则在尾部追加 rest.
  let total = snapped.reduce((s, x) => s + x.quarter, 0)
  if (total < expectedQuarters - EPS_Q) {
    // 先尝试延长最后一个 rest
    const last = snapped[snapped.length - 1]
    let need = expectedQuarters - total
    if (last && last.isRest) {
      const extendedDur =
        need >= 4 ? 'wr' :
        need >= 2 ? 'hr' :
        need >= 1 ? 'qr' :
        need >= 0.5 ? '8r' : '16r'
      last.dur = extendedDur
      last.quarter = ticksForDuration(extendedDur)
      need = expectedQuarters - snapped.reduce((s, x) => s + x.quarter, 0)
    }
    // 若还不够, 追加 rest 直至填满
    while (need > EPS_Q) {
      const tailDur =
        need >= 4 ? 'wr' :
        need >= 2 ? 'hr' :
        need >= 1 ? 'qr' :
        need >= 0.5 ? '8r' : '16r'
      snapped.push({
        dur: tailDur,
        quarter: ticksForDuration(tailDur),
        isRest: true,
        beat: {
          keys: ['b/4'],
          midis: [],
          time: 0,
          durInQuarter: ticksForDuration(tailDur),
          isRest: true,
          noteIndex: [],
        },
      })
      need -= ticksForDuration(tailDur)
    }
  }

  // 构造 StaveNote
  const notes: StaveNote[] = []
  for (const s of snapped) {
    const sn = s.isRest
      ? new StaveNote({ keys: ['b/4'], duration: s.dur, clef })
      : new StaveNote({ keys: s.beat.keys, duration: s.dur, clef })
    sn.setStyle({ fillStyle: handColor, strokeStyle: handColor })
    notes.push(sn)
  }

  // Beam 组: 8/16/32/64 拍连续; 遇 rest / 非 beamable / 跨节拍边界就断.
  // 关键: ≤ 8th 的 rest 不 break (跨拍 8th 节奏常见); 更长的 rest 强制 break.
  // beat 边界: 1 拍 = 1 quarter (4/4, 3/4) 或 1 dotted-quarter (6/8). 严格按 (4/denom) quarter.
  const beams: Beam[] = []
  const canBeam = (idx: number): boolean => {
    const s = snapped[idx]
    if (s.isRest) {
      const t = ticksForDuration(s.dur)
      return t <= 0.5
    }
    return /^(8|16|32|64)(d)?$/.test(s.dur)
  }
  const contiguousWith = (a: BeatEvent, b: BeatEvent): boolean => {
    return Math.abs(a.time + a.durInQuarter * secPerQuarterAt(a.time) - b.time) < 0.01
  }
  // beat 长度 (秒): 1 beat = (4 / denominator) quarters
  const anchorSec = snapped.length > 0 ? snapped[0].beat.time : 0
  const beatSec = secPerQuarterAt(anchorSec) * (4 / timeSig.denominator)
  let i = 0
  while (i < notes.length) {
    if (!canBeam(i)) {
      i++
      continue
    }
    let j = i
    while (
      j < notes.length &&
      canBeam(j) &&
      (j === i || contiguousWith(snapped[j - 1].beat, snapped[j].beat))
    ) {
      // 跨节拍边界就停
      if (j > i) {
        const prevEndSec =
          snapped[j - 1].beat.time +
          snapped[j - 1].beat.durInQuarter * secPerQuarterAt(snapped[j - 1].beat.time)
        const curStartSec = snapped[j].beat.time
        // 用 snapped[0] 的 time 当 anchor (该小节起拍), beat index = floor((cur - anchor) / beatSec)
        const prevBeatIdx = Math.floor((prevEndSec - anchorSec) / beatSec + 1e-6)
        const curBeatIdx = Math.floor((curStartSec - anchorSec) / beatSec + 1e-6)
        if (prevBeatIdx !== curBeatIdx) break
      }
      j++
    }
    if (j - i >= 2) {
      beams.push(new Beam(notes.slice(i, j)))
    }
    i = j
  }

  return { notes, beams }
}

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------
interface Props {
  height?: number
  playerRef?: React.MutableRefObject<{
    getPressedNotes?: () => Set<number>
    getPlayingNotes?: () => Set<SongNote>
    isFrozen?: () => boolean
    getWaitTarget?: () => SongNote | null
    /** 键 = noteIndex (song.notes 数组下标), 值 = 当前评分状态. */
    getNoteStates?: () => Map<number, 'hit' | 'miss' | 'late'>
  } | null>
}

export function StaffView({ height = 128, playerRef }: Props) {
  const song = useStore((s) => s.song)
  const loopRange = useStore((s) => s.loopRange)
  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const svgHostRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef<HTMLDivElement>(null)
  const loopBandRef = useRef<HTMLDivElement>(null)
  const measureWidthsRef = useRef<number[]>([])
  const totalWidthRef = useRef(0)
  // per-note 上色: 在 renderStaff 后填, RAF 循环里按 playerRef.getNoteStates 查表, 改 setStyle
  // noteIndex 是 song.notes 数组下标, 跟 player 的 hitNoteIndices / getNoteStates 用同一键.
  const stavesRef = useRef<Array<{ note: StaveNote; hand: Hand; noteIndex: number[] }>>([])

  useEffect(() => {
    if (!song || !svgHostRef.current || !innerRef.current) return
    const host = svgHostRef.current
    const innerEl = innerRef.current
    // 清空容器 —— 里面放的是 VexFlow 自己生成的 SVG, 不是用户输入,
    // 所以这里用 innerHTML 是安全的 (没有 XSS 面).
    // 后端现在也统一带 CSP (见 scripts/server/http-headers.mjs), 兜住万一.
    host.innerHTML = ''
    stavesRef.current = [] // song 变了, 旧 note refs 失效
    const songData: Song = song

    const keyName = fifthsToKeyName(songData.keyFifths ?? 0)

    const hasRight = songData.notes.some((n) => noteHandOf(n, songData) === 'right')
    const hasLeft = songData.notes.some((n) => noteHandOf(n, songData) === 'left')
    if (!hasRight && !hasLeft) return

    // 整个 useEffect 包一层 try/catch — VexFlow 内部任何异常都不应该把整页拖黑
    try {
      renderStaff()
    } catch (e) {
      console.warn('[staff] render failed:', (e as Error).message)
    }

    function renderStaff() {
    const measureBeats = buildMeasureBeats(songData)
    const nMeasures = songData.measures.length
    if (nMeasures === 0) return

    // tempo map (spec P2-3 / P1-18) —— 时值换算按**每个音所在时刻**的速度
    const tempoMap = new TempoMap(songData.bpms, songData.timeSignature.denominator)
    const secPerQuarterAt = (t: number) => tempoMap.secPerQuarterAt(t)

    const widths = new Array(nMeasures).fill(MAX_MEASURE_WIDTH)
    for (let i = 0; i < nMeasures; i++) {
      const m = measureBeats[i]
      const beats = m.right.beats.length + m.left.beats.length
      const desired = MIN_MEASURE_WIDTH + beats * 14
      widths[i] = Math.max(MIN_MEASURE_WIDTH, Math.min(MAX_MEASURE_WIDTH, desired))
    }
    measureWidthsRef.current = widths
    // 用容器实际宽度 (multi-line) 替代单行 total width
    const containerWidth = containerRef.current?.clientWidth || 1200
    const availableWidth = Math.max(MIN_MEASURE_WIDTH, containerWidth - PADDING * 2)
    // 限制系统数: 1 system for height<=128, 2 for <=180, 3 for 220+
    const maxSystems = height >= 220 ? 3 : height >= 180 ? 2 : 1
    let systems = binPackIntoSystems(widths, availableWidth)
    if (systems.length > maxSystems) {
      // 超出: 把多余 system 合并到最后一个 (overflow 会水平滚, 不破坏当前可见)
      const last = systems[maxSystems - 1]
      systems = systems.slice(0, maxSystems)
      systems[maxSystems - 1] = { startIdx: last.startIdx, endIdx: nMeasures - 1 }
    }
    // total width = 最宽 system 的总宽
    const widestSystem = systems.reduce(
      (max, s) => Math.max(max, widths.slice(s.startIdx, s.endIdx + 1).reduce((a, b) => a + b, 0)),
      0,
    )
    totalWidthRef.current = PADDING * 2 + widestSystem
    innerEl.style.width = `${totalWidthRef.current}px`

    const render = (hostEl: HTMLDivElement) => {
      // 同上: 只放 VexFlow 生成的 SVG.
      hostEl.innerHTML = ''
      const totalW = totalWidthRef.current
      const renderer = new Renderer(hostEl, Renderer.Backends.SVG)
      renderer.resize(totalW, height)
      const ctx = renderer.getContext()
      ctx.setFont('Arial', 10, '')

      type TieReq = { hand: Hand; from: StaveNote; midi: number }
      const allStaveNotes: { hand: Hand; beat: BeatEvent; note: StaveNote }[] = []
      const pendingTieRequests: TieReq[] = []

      // 垂直居中: 计算总 system 高度, 在可用 height 里居中
      const totalSystemsHeight = systems.length * SYSTEM_HEIGHT + (systems.length - 1) * SYSTEM_GAP
      const yOffset = Math.max(0, Math.floor((height - totalSystemsHeight) / 2))

      systems.forEach((system, sysIdx) => {
        // 累加 system 内 measure 之前的宽度
        const sysY = yOffset + sysIdx * (SYSTEM_HEIGHT + SYSTEM_GAP)
        const tY = sysY
        const bY = sysY + 70 // treble 40px + 30px gap = bass 起 70
        const isLastSystem = sysIdx === systems.length - 1

        let accX = PADDING // system 内 measure 累加 x
        for (let mi = system.startIdx; mi <= system.endIdx; mi++) {
          const w = widths[mi]
          const isFirstInSong = mi === 0
          const isLastInSong = mi === nMeasures - 1
          const isFirstInSystem = mi === system.startIdx
          // 变拍曲子: 每个小节可能有不同拍号, 只在拍号真的变了的小节上标 signature
          const mTs = measureTimeSigOf(songData, mi)
          const prevTs = mi > 0 ? measureTimeSigOf(songData, mi - 1) : null
          const showTs =
            mi === 0 ||
            !prevTs ||
            prevTs.numerator !== mTs.numerator ||
            prevTs.denominator !== mTs.denominator

          // Treble stave
          if (hasRight) {
            const tStave = new Stave(accX, tY, w)
            tStave.setContext(ctx)
            if (isFirstInSong) {
              tStave.addClef('treble').addKeySignature(keyName).addTimeSignature(`${mTs.numerator}/${mTs.denominator}`)
            } else if (isFirstInSystem) {
              tStave.addClef('treble') // 后续 system 也给 clef (小节间无 signature)
              if (showTs) tStave.addTimeSignature(`${mTs.numerator}/${mTs.denominator}`)
            } else {
              tStave.setBegBarType(Barline.type.SINGLE)
              if (showTs) tStave.addTimeSignature(`${mTs.numerator}/${mTs.denominator}`)
            }
            tStave.setEndBarType(isLastInSong ? Barline.type.END : Barline.type.SINGLE)
            tStave.draw()
            renderHand(tStave, ctx, mi, 'right', measureBeats[mi].right, songData, secPerQuarterAt, allStaveNotes, pendingTieRequests)
          }

          // Bass stave
          if (hasLeft) {
            const bStave = new Stave(accX, bY, w)
            bStave.setContext(ctx)
            if (isFirstInSong) {
              bStave.addClef('bass').addKeySignature(keyName).addTimeSignature(`${mTs.numerator}/${mTs.denominator}`)
            } else if (isFirstInSystem) {
              bStave.addClef('bass')
              if (showTs) bStave.addTimeSignature(`${mTs.numerator}/${mTs.denominator}`)
            } else {
              bStave.setBegBarType(Barline.type.SINGLE)
              if (showTs) bStave.addTimeSignature(`${mTs.numerator}/${mTs.denominator}`)
            }
            bStave.setEndBarType(isLastInSong ? Barline.type.END : Barline.type.SINGLE)
            bStave.draw()
            renderHand(bStave, ctx, mi, 'left', measureBeats[mi].left, songData, secPerQuarterAt, allStaveNotes, pendingTieRequests)
          }

          // Grand-staff connectors
          if (hasRight && hasLeft) {
            const tStave = new Stave(accX, tY, w)
            const bStave = new Stave(accX, bY, w)
            if (isFirstInSong) {
              const c1 = new StaveConnector(tStave, bStave).setContext(ctx)
              c1.setType(StaveConnector.type.BRACE).draw()
            }
            if (isFirstInSystem) {
              const c2 = new StaveConnector(tStave, bStave).setContext(ctx)
              c2.setType(StaveConnector.type.SINGLE_LEFT).draw()
            }
            if (isLastInSong) {
              const c3 = new StaveConnector(tStave, bStave).setContext(ctx)
              c3.setType(StaveConnector.type.BOLD_DOUBLE_RIGHT).draw()
            } else if (isLastSystem && mi === system.endIdx) {
              // 最后一个 system 的最后一小节也加 SINGLE_RIGHT (避免视觉断开)
              const c4 = new StaveConnector(tStave, bStave).setContext(ctx)
              c4.setType(StaveConnector.type.SINGLE_RIGHT).draw()
            }
          }

          accX += w
        }
      })

      // Cross-measure ties: 按 midi 整数匹配下一小节首拍. 关键: 找 midi 在 chord 内的
      // 索引, 让 firstIndexes / lastIndexes 指向正确的 notehead (e.g. 和弦中间那个音).
      // 按 (hand, midi) 去重, 避免同一对 source-target 重复画 tie.
      const tiedKeys = new Set<string>()
      for (const req of pendingTieRequests) {
        const dedupKey = `${req.hand}|${req.midi}`
        if (tiedKeys.has(dedupKey)) continue
        for (let mi = 0; mi < nMeasures; mi++) {
          const beats = measureBeats[mi][req.hand].beats
          const target = beats.find((b) => !b.isRest && b.midis.includes(req.midi))
          if (!target) continue
          const targetNote = allStaveNotes.find(
            (n) => n.hand === req.hand && n.beat.time === target.time &&
                   n.beat.midis.join(',') === target.midis.join(','),
          )
          if (!targetNote) continue
          // 找 midi 在 chord 内的索引 (renderHand 用 [b.midi...desc] 顺序排, 这里也匹配)
          const targetIdx = targetNote.beat.midis.indexOf(req.midi)
          // 源 chord 的索引: 找 req.from 对应的 BeatEvent, 取其 midis 内的 idx
          const sourceBeat = allStaveNotes.find((n) => n.note === req.from)?.beat
          if (!sourceBeat) continue
          const sourceIdx = sourceBeat.midis.indexOf(req.midi)
          if (sourceIdx < 0 || targetIdx < 0) continue
          const tie = new StaveTie({
            firstNote: req.from,
            lastNote: targetNote.note,
            firstIndexes: [sourceIdx],
            lastIndexes: [targetIdx],
          })
          tie.setContext(ctx)
          tie.draw()
          tiedKeys.add(dedupKey)
          break
        }
      }

      // 暴露给后续 RAF 循环做 per-note 上色. 把 StaveNote 与 song.notes 下标关联, 后续
      // 直接 setStyle({ fillStyle, strokeStyle }) 改 note 颜色, 不重排.
      const staves = allStaveNotes.map((n) => ({
        note: n.note,
        hand: n.hand,
        noteIndex: n.beat.noteIndex,
      }))
      stavesRef.current = staves
    }

    render(host)
    } // end renderStaff
  }, [song, height])

  // RAF scroll + cursor
  useEffect(() => {
    let raf = 0
    const loop = () => {
      const t = useStore.getState().currentTime
      const s = useStore.getState().song
      if (s && s.measures.length > 0 && containerRef.current) {
        const widths = measureWidthsRef.current
        let x = PADDING
        let inMeasure = -1
        for (let i = 0; i < s.measures.length; i++) {
          const mStart = s.measures[i].time
          const mEnd = mStart + s.measures[i].duration
          if (t >= mStart && t < mEnd) {
            const pps = widths[i] / s.measures[i].duration
            x += (t - mStart) * pps
            inMeasure = i
            break
          } else if (i === s.measures.length - 1 && t >= mEnd) {
            x += widths[i]
            inMeasure = i
            break
          }
          x += widths[i]
        }
        if (cursorRef.current) {
          cursorRef.current.style.left = `${x}px`
        }
        if (inMeasure >= 0) {
          const scrollTarget = Math.max(0, x - containerRef.current.clientWidth * 0.25)
          if (Math.abs(containerRef.current.scrollLeft - scrollTarget) > 0.5) {
            containerRef.current.scrollLeft = scrollTarget
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // RAF per-note 上色 (hit/good/miss). 节流到 ~15fps, 改 setStyle 不重排 VexFlow.
  useEffect(() => {
    let raf = 0
    let lastTick = 0
    const THROTTLE_MS = 66
    const loop = (now: number) => {
      if (now - lastTick >= THROTTLE_MS) {
        lastTick = now
        const api = playerRef?.current
        const states = api?.getNoteStates?.()
        if (states && stavesRef.current.length > 0) {
          const rightColor = COLORS.hand.right
          const leftColor = COLORS.hand.left
          for (const s of stavesRef.current) {
            // chord 内任一音的状态决定整 chord 颜色 (整组一起 hit/miss/late)
            const state = s.noteIndex.map((i) => states.get(i)).find(Boolean)
            let color: string
            if (state === 'hit') color = COLORS.hit
            else if (state === 'miss') color = COLORS.miss
            else if (state === 'late') color = COLORS.good
            else color = s.hand === 'right' ? rightColor : leftColor
            s.note.setStyle({ fillStyle: color, strokeStyle: color })
          }
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playerRef])

  // loop range 紫色背景带: 在 inner 里画一个 div, 宽度/left 跟着 measureWidths 算
  useEffect(() => {
    const band = loopBandRef.current
    const inner = innerRef.current
    if (!band || !inner) return
    if (!song || !loopRange) {
      band.style.display = 'none'
      return
    }
    const widths = measureWidthsRef.current
    if (widths.length === 0) return
    // 把秒数转成 x 坐标 (按 measureWidths 推)
    const xOfT = (t: number) => {
      let x = PADDING
      for (let i = 0; i < song.measures.length; i++) {
        const m = song.measures[i]
        const mStart = m.time
        const mEnd = mStart + m.duration
        if (t < mStart) return x
        if (t < mEnd) {
          const pps = widths[i] / m.duration
          return x + (t - mStart) * pps
        }
        x += widths[i]
      }
      return x
    }
    const x1 = xOfT(loopRange[0])
    const x2 = xOfT(loopRange[1])
    band.style.display = 'block'
    band.style.left = `${x1}px`
    band.style.width = `${Math.max(2, x2 - x1)}px`
  }, [loopRange, song])

  if (!song) {
    return (
      <div className="border-b border-border bg-bg/30 flex items-center justify-center text-xs text-muted" style={{ height }}>
        加载曲目后显示五线谱
      </div>
    )
  }

  return (
    <div className="relative bg-bg/30 border-b border-border" style={{ height }}>
      <div ref={containerRef} className="absolute inset-0 overflow-x-auto overflow-y-hidden" style={{ scrollbarWidth: 'thin' }}>
        <div ref={innerRef} className="h-full relative" style={{ minWidth: '100%' }}>
          <div
            ref={loopBandRef}
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ display: 'none', background: COLORS.loopRange, borderLeft: `1px solid ${COLORS.loopRangeLine}`, borderRight: `1px solid ${COLORS.loopRangeLine}` }}
          />
          <div ref={svgHostRef} className="absolute inset-0" />
        </div>
      </div>
      <div ref={cursorRef} className="absolute top-0 bottom-0 w-px pointer-events-none z-10" style={{ left: PADDING, background: COLORS.hitLine, boxShadow: `0 0 6px ${COLORS.hitLine}80` }} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 把单手 beats 转成 voice + tickable, format, beam
// ---------------------------------------------------------------------------
/**
 * 取第 idx 小节的拍号。整首一个拍号的曲子里 measure 上没有这两项, 回退到 song.timeSignature。
 * (变拍曲子: 每小节拍号可能不同, 见 SongMeasure.numerator)
 */
function measureTimeSigOf(
  song: Song,
  idx: number,
): { numerator: number; denominator: number } {
  const m = song.measures[idx]
  return {
    numerator: m?.numerator ?? song.timeSignature.numerator,
    denominator: m?.denominator ?? song.timeSignature.denominator,
  }
}

function renderHand(
  stave: Stave,
  ctx: any,
  measureIdx: number,
  hand: Hand,
  beats: HandBeats,
  song: Song,
  secPerQuarterAt: (t: number) => number,
  allStaveNotes: { hand: Hand; beat: BeatEvent; note: StaveNote }[],
  pendingTieRequests: { hand: Hand; from: StaveNote; midi: number }[],
) {
  const ts = measureTimeSigOf(song, measureIdx)
  const numBeats = ts.numerator
  const beatValue = ts.denominator
  const measureTime = song.measures[measureIdx].time
  const measureDur = song.measures[measureIdx].duration
  const expectedQuarters = (numBeats * 4) / beatValue

  const filled = fillWithRests(beats.beats, measureTime, measureDur, secPerQuarterAt)
  const built = buildStaveNotes(filled, hand, secPerQuarterAt, expectedQuarters, ts)

  if (built.notes.length === 0) return

  const voice = new Voice({ numBeats, beatValue }).setMode(Voice.Mode.SOFT)
  built.notes.forEach((n) => voice.addTickable(n))

  // 顺序很关键: 先 applyAccidentals 把临时升降号挂到 note, 再 formatToStave 计算位置.
  // 若先 format 再 apply, VexFlow 抛 "Can't call GetModifierStartXY on an unformatted note"
  // (Accidental 试图读 note.x/note.y, 而 note 还没 format).
  try {
    Accidental.applyAccidentals([voice], fifthsToKeyName(song.keyFifths ?? 0))
    new Formatter().joinVoices([voice]).formatToStave([voice], stave)
    voice.draw(ctx, stave)
    built.beams.forEach((bm) => bm.setContext(ctx).draw())
  } catch (e) {
    console.warn(`[staff] measure ${measureIdx} ${hand} render failed:`, (e as Error).message)
  }

  // 收集 StaveNote 给 cross-measure tie 查找
  filled.forEach((b, i) => {
    if (b.isRest) return
    allStaveNotes.push({ hand, beat: b, note: built.notes[i] })
  })

  // 待连 tie 的源 (下一小节去找 target)
  for (const t of beats.pendingTies) {
    const idx = filled.findIndex((b) => !b.isRest && b.midis.includes(t.midi))
    if (idx < 0) continue
    pendingTieRequests.push({ hand, from: built.notes[idx], midi: t.midi })
  }
}

// 导出给测试用
export const __test__ = { buildMeasureBeats, fillWithRests, durationToVex, restToVex, ticksForDuration, binPackIntoSystems }
