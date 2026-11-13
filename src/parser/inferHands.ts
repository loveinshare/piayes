// 推断左右手 track / 声部
// 优先级:
// 1) MusicXML: 显式 hand (parser 已填)
// 2) notes 已有 hand 字段 (e.g. mxl 解析后)
// 3) MIDI 多 track: 按 track 平均音高分配
// 4) MIDI 单 track: **声部聚类** — 按 onset time 聚类 (50ms),
//    每个 cluster 内找 top voice (音高最高且相邻 gap ≤ 5 半音的 1-N 个音) = RH,
//    其余 = LH.
//
// 关键规则 (v4, 2026-11-02 修 Chopin Op.64 No.2 开头左右手反了):
//  - 旋律下限 F **按曲子自适应**, 不再用固定的 MELODY_FLOOR=70 (Bb4).
//    老阈值把"旋律音区偏低"的曲子整段误判成 LH —— 这首 C# 小调圆舞曲的旋律在
//    F#4(66)..E6(88), 开头那个 G#4(68) 的弱起因此被判成左手.
//    F = 各 cluster 顶部音高的 25% 分位数 (四分之一的 cluster 顶部音在它之下,
//    那部分就是伴奏音区). 三首单 track 乐库曲实测:
//      Op.64 No.2 → 66 (旋律底 D4=62, 伴奏顶 E4=64)
//      Canon in D → 71 (旋律 D5=74 起, 伴奏和弦到 A4=69)
//      River Flows → 69 (旋律底 F#4=69, 伴奏顶 E4=64)
//  - top voice **不再要求持续性** —— 老版本要求顶部音持续 ≥ 0.4s, 把旋律里
//    短促的弱起/装饰音整段判成左手 (这首曲子的 G#4 弱起就是其中一个).
//  - 旋律的**双音** (右手同时按两个键) 靠"同时落"认出来: 跟最高音**时长几乎
//    一样** (差 ≤ 5%) 的音 = 右手一起按下去的. 伴奏和弦音不会跟旋律音同时落
//    (旋律在跑动时和弦还在响), 所以这样能把 Op.64 No.2 开头的 G4+D#5 认成右手.
//  - 开篇如果前 OPENING_LH_MEASURES 小节内没有**持续**的高音, 整段标 LH.
//    Chopin's Op.9 No.2 前 8 小节就只有 LH arpeggio (每个 cluster 只有一个
//    短促的 arpeggio 音, 没有持续音).
//
// 关键: 老版本用单一音高阈值 (C4=60) 一刀切, 把 LH 顶层音 (e.g. Chopin 夜曲
// 里 Eb4=63 / G4=67 是 LH 和弦音, 不是旋律) 误判为右手. 新算法按声部聚类 +
// 持续时间判定, 旋律和伴奏的 boundary 更准.

import type { SongNote, Hand, Bpm } from '../types'
import { TempoMap } from '../util/tempoMap'

export interface InferResult {
  hands: { left: number; right: number }
  /** 老字段, 单 track 时不再用, 保留为向后兼容. 新算法 = undefined */
  pitchSplit?: number
  /** 手别是怎么定出来的 (spec P2-6) */
  method: HandInferMethod
  /** 置信度 (spec P2-6) —— UI 据此提示用户"手别是猜的" */
  confidence: HandInferConfidence
}

/** 手别判定方式 */
export type HandInferMethod =
  | 'explicit'      // MusicXML 显式标了 hand
  | 'per-note'      // notes 上已经有 hand 字段
  | 'two-tracks'    // 2 个 track, 按平均音高分
  | 'multi-tracks'  // ≥3 个 track, 按音符数分
  | 'voice-clusters'// 单 track, 声部聚类 (启发式)
  | 'pitch-split'   // 用户手动指定: 按音高切分

/** 置信度: low = 启发式猜的, 用户可能需要手动纠正 */
export type HandInferConfidence = 'high' | 'medium' | 'low'

export interface InferOptions {
  /**
   * 'auto'   —— 默认启发式
   * 'pitch'  —— 用户手动指定"按音高切分" (spec P2-6 的手动纠正入口)
   */
  mode?: 'auto' | 'pitch'
  /** 'pitch' 模式下的切分点 (midi < split → left) */
  pitchSplit?: number
}

const CLUSTER_TOLERANCE_S = 0.05 // 50ms — 同时发声的音归为同一 cluster
const MELODY_FLOOR = 70 // Bb4 — 旋律下限的兜底值 (cluster 太少时用)
const TOP_VOICE_GAP = 5 // 半音 — 从 max 往下走, 相邻 gap ≤ 5 算同一声部 (旋律 chord / octave doubling)
/**
 * 「同时落」的容差 —— 跟最高音时长差 ≤ 5% 的音 = 右手一起按下去的双音.
 *
 * 为什么光看音高不行: 圆舞曲开头的 G4(67)+D#5(75) 差了 8 个半音, 跟伴奏和弦
 * (如 E4=64 配 D#5) 的音高间隔差不多, 光看音高分不出"旋律双音"和"伴奏和弦".
 * 但两者**结束的时间**不一样: 旋律双音是同时按下同时松开 (时长一样), 伴奏和弦
 * 会在旋律跑动时继续响着 (时长比旋律长).
 */
const DOUBLE_NOTE_DUR_TOL = 0.05
const SUSTAIN_MIN_S = 0.4 // 持续 ≥ 0.4s 的音才算"持续音" (只用于开篇 LH 判定)
const OPENING_LH_MEASURES = 4 // 曲首前 N 小节如果都没持续高音, 整段标 LH
/**
 * 多 track 时, 平均音高差 ≤ 这么多个半音的声部算"同一音区", 再按音符数分主旋律.
 *
 * BWV 1041: 小提琴独奏 avg 73.4 / 弦乐第一 avg 73.5 —— 差 0.1, 靠音符数 (1104 vs 574) 分开.
 * 安魂曲: 人声 avg 70 / 钢琴上声部 avg 62 —— 差 8, 差得够远, 直接按音高分.
 */
const MELODY_TRACK_AVG_TOL = 2
/**
 * 旋律下限 F 取 cluster 顶部音高的分位数.
 *
 * 25% 的含义: 四分之一的 cluster 顶部音落在 F 以下 —— 那部分就是伴奏音区
 * (LH 和弦 / 贝斯), F 以上是旋律音区. 低于 25% 会切进伴奏区, 高于 25%
 * 会把旋律的低音区也切掉.
 */
const MELODY_FLOOR_PERCENTILE = 0.25
/** cluster 少于这个数, 旋律下限的分位数就没意义 (用兜底值) */
const MIN_CLUSTERS = 8

export function inferHands(
  notes: SongNote[],
  explicitHands: Map<number, Hand> | null,
  bpms: Bpm[] = [],
  timeSig: { numerator: number; denominator: number } = { numerator: 4, denominator: 4 },
  opts: InferOptions = {},
): InferResult {
  if (notes.length === 0) {
    return { hands: { left: 0, right: 0 }, method: 'explicit', confidence: 'high' }
  }

  // 0) 用户手动指定"按音高切分" (spec P2-6) —— 覆盖所有启发式.
  // 声部聚类猜错了的时候, 这是最直接的纠正入口.
  if (opts.mode === 'pitch') {
    const split = opts.pitchSplit ?? 60
    for (const n of notes) {
      n.hand = n.midiNote < split ? 'left' : 'right'
    }
    return {
      hands: { left: notes[0].track, right: notes[0].track },
      pitchSplit: split,
      method: 'pitch-split',
      confidence: 'medium',
    }
  }

  // 1) MusicXML 显式 hand
  if (explicitHands && explicitHands.size > 0) {
    const left = [...explicitHands.entries()].find(([, h]) => h === 'left')?.[0]
    const right = [...explicitHands.entries()].find(([, h]) => h === 'right')?.[0]
    if (left !== undefined && right !== undefined) {
      for (const n of notes) {
        const h = explicitHands.get(n.track)
        if (h) n.hand = h
      }
      return { hands: { left, right }, method: 'explicit', confidence: 'high' }
    }
  }

  // 2) notes 已经有 hand 字段 (parser 已填)
  const withHand = notes.filter((n) => n.hand)
  if (withHand.length > 0) {
    const left = withHand.find((n) => n.hand === 'left')?.track ?? withHand[0].track
    const right =
      withHand.find((n) => n.hand === 'right')?.track ??
      (withHand[0].track === left ? left + 1 : withHand[0].track)
    return { hands: { left, right }, method: 'per-note', confidence: 'high' }
  }

  // 3) MIDI 多 track: 按 track 分配 — 2 track 用平均音高直接比, ≥3 track 用「主旋律那个 = RH, 其余 = LH」.
  // 之前 ≥3 时用 C4=60 阈值二分 (4 RH + 2 LH), 听感上 RH 太厚 (4 个声部挤高音区).
  // 2 track 路径保持不变 (e.g. Chopin dual-track 仍 1 RH + 1 LH).
  const trackIds = [...new Set(notes.map((n) => n.track))]
  if (trackIds.length === 0) {
    return { hands: { left: 0, right: 0 }, method: 'explicit', confidence: 'high' }
  }
  if (trackIds.length === 2) {
    const avg = (id: number) => {
      const ns = notes.filter((n) => n.track === id)
      return ns.reduce((s, n) => s + n.midiNote, 0) / ns.length
    }
    const a0 = avg(trackIds[0])
    const a1 = avg(trackIds[1])
    const left = a0 < a1 ? trackIds[0] : trackIds[1]
    const right = a0 < a1 ? trackIds[1] : trackIds[0]
    for (const n of notes) n.hand = n.track === left ? 'left' : 'right'
    return { hands: { left, right }, method: 'two-tracks', confidence: 'high' }
  }
  if (trackIds.length >= 3) {
    // 「主旋律 track = RH」 — 两个信号一起用:
    //
    // 1. **平均音高最高**的声部 = 旋律 (旋律总在最高音区).
    // 2. 平均音高几乎一样 (差 ≤ MELODY_TRACK_AVG_TOL) 时, 再按**音符数**分.
    //
    // 为什么不能只看音符数: 莫扎特安魂曲钢琴版有 3 个声部 ——
    //   人声 (175 音, 平均音高 70, 最高, 就是旋律) / 钢琴上声部 (378 音, avg 62) / 贝斯 (116 音)
    // "音符最多"选中的是**钢琴的内声部**, 反而把旋律判成了左手 (学琴时该用右手弹的
    // 旋律变成了左手, 右手弹的却是伴奏).
    //
    // 为什么不能只看平均音高: BWV 1041 的小提琴独奏 (avg 73.4, 1104 音) 和
    // 弦乐第一 (avg 73.5, 574 音) 平均音高几乎一样, 只看 avg 会挑中弦乐.
    const avgOf = (id: number) => {
      const ns = notes.filter((n) => n.track === id)
      return ns.reduce((s, n) => s + n.midiNote, 0) / ns.length
    }
    const countOf = (id: number) => notes.filter((n) => n.track === id).length
    const maxAvg = Math.max(...trackIds.map(avgOf))
    const candidates = trackIds.filter((id) => avgOf(id) >= maxAvg - MELODY_TRACK_AVG_TOL)
    const rightId = candidates.sort((a, b) => countOf(b) - countOf(a))[0]
    const leftIds = trackIds.filter((id) => id !== rightId)
    const leftTracks = new Set(leftIds)
    for (const n of notes) {
      if (n.track === rightId) n.hand = 'right'
      else if (leftTracks.has(n.track)) n.hand = 'left'
    }
    return {
      hands: { left: leftIds[0] ?? trackIds[0], right: rightId },
      method: 'multi-tracks',
      confidence: 'medium',
    }
  }

  // 4) MIDI 单 track: 声部聚类 (v3: 持续时间判定 + 开篇 LH 默认)
  inferByVoiceClusters(notes, bpms, timeSig)
  // 单 track 声部聚类 = 启发式猜测 —— 置信度最低, UI 该提示用户 (spec P2-6)
  return {
    hands: { left: trackIds[0], right: trackIds[0] },
    method: 'voice-clusters',
    confidence: 'low',
  }
}

/** 计算曲首 OPENING_LH_MEASURES 小节在时间轴上的边界 */
function openingEndTime(
  bpms: Bpm[],
  timeSig: { numerator: number; denominator: number },
): number {
  // 按 tempo map 算 (spec P2-3) —— 变速曲子的开篇边界不该用第一个 BPM
  const map = new TempoMap(bpms, timeSig.denominator)
  return map.timeOfBeat(timeSig.numerator * OPENING_LH_MEASURES)
}

/**
 * 旋律下限 F —— 按曲子自适应 (v4).
 *
 * F = 各 cluster 顶部音高的 MELODY_FLOOR_PERCENTILE 分位数: 四分之一的 cluster
 * 顶部音落在 F 以下 —— 那部分就是伴奏音区 (LH 和弦 / 贝斯), F 以上是旋律音区.
 *
 * 为什么不能写死 (老版本 MELODY_FLOOR = 70 = Bb4):
 *   旋律音区偏低的曲子会被整段误判成 LH. Chopin Op.64 No.2 (C# 小调圆舞曲) 的
 *   旋律在 F#4(66)..E6(88), 开头那个 G#4(68) 的弱起正好落在 70 以下 → 判成左手.
 *   实测 (跟"已经分好手的两 track 版本"逐音对齐比对):
 *     老规则 (F=70 + 持续性过滤) 一致率 70.2%
 *     新规则 (F 自适应, 去掉持续性过滤)   一致率 ~90%
 *
 * 代价: RH 和 LH 的音区有重叠时 (这首曲子的 RH 最低到 62, LH 和弦最高到 64),
 * 分不开那 ~10% —— 音高启发式到此为止, 剩下的要靠用户手动纠正 (spec P2-6).
 *
 * cluster 太少 (< MIN_CLUSTERS) 时分位数没意义 → 用兜底值 MELODY_FLOOR.
 */
function melodyFloor(clusters: SongNote[][]): number {
  if (clusters.length < MIN_CLUSTERS) return MELODY_FLOOR
  const tops = clusters.map((c) => c.reduce((m, n) => Math.max(m, n.midiNote), -Infinity))
  tops.sort((a, b) => a - b)
  return tops[Math.floor(tops.length * MELODY_FLOOR_PERCENTILE)]
}

/**
 * 单 track MIDI: 按 onset time 把 note 聚类 (50ms 窗), 每 cluster 内:
 * - max < F (旋律下限) → 全 LH (没旋律, 比如 LH 单走 arpeggio 时)
 * - 否则先看有没有跟最高音**同时落**的音 (= 旋律双音, 右手一起按的), 有就都是旋律;
 *   没有双音才从 max 往下走 gap 链 (gap ≤ TOP_VOICE_GAP 的连续音算同一声部:
 *   旋律 doublings / 旋律和弦), 但**音高不能低于 F**.
 * - 若曲首前 OPENING_LH_MEASURES 小节没有任何**持续**的 top voice 音, 整段标 LH
 *   (匹配 Chopin Op.9 No.2 之类的曲子前几小节只有 LH arpeggio).
 *
 * 直接 mutate notes 设 n.hand.
 */
function inferByVoiceClusters(
  notes: SongNote[],
  bpms: Bpm[],
  timeSig: { numerator: number; denominator: number },
): void {
  const sorted = [...notes].sort((a, b) => a.time - b.time)
  if (sorted.length === 0) return

  // 聚类: notes 按 onset time 升序, 相邻 onset < CLUSTER_TOLERANCE_S 算同 cluster
  const clusters: SongNote[][] = []
  let cur: SongNote[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time - cur[0].time < CLUSTER_TOLERANCE_S) {
      cur.push(sorted[i])
    } else {
      clusters.push(cur)
      cur = [sorted[i]]
    }
  }
  clusters.push(cur)

  // 旋律下限 F = 各 cluster 顶部音高的分位数 (自适应, 见文件头).
  const floor = melodyFloor(clusters)

  // Step 1: 第一遍先按 cluster 内音高粗标.
  // Step 2: 若开篇 N 小节没有持续高音符, 把开篇所有的 RH 全改回 LH.
  const openingEnd = openingEndTime(bpms, timeSig)
  let openingHasSustainedHigh = false

  for (const cluster of clusters) {
    const maxMidi = cluster.reduce((m, n) => Math.max(m, n.midiNote), -Infinity)
    if (maxMidi < floor) {
      // 没旋律, 整 cluster 算伴奏
      for (const n of cluster) n.hand = 'left'
      continue
    }
    // 按音高降序, 从 max 往下走.
    //  - 先找跟 max **同时落**的音 (= 旋律双音, 右手一起按的), 有就都是旋律;
    //  - 没有双音才走 gap 链: 相邻 gap ≤ TOP_VOICE_GAP 的连续音算同一声部
    //    (旋律 chord / octave doubling), 但音高低于 F (伴奏区) 的不进来.
    const byDesc = [...cluster].sort((a, b) => b.midiNote - a.midiNote)
    const topPitches = new Set<number>()
    const top = byDesc[0]
    const partners = byDesc.filter(
      (n) =>
        n.midiNote < top.midiNote &&
        n.midiNote >= floor &&
        Math.abs(n.duration - top.duration) <= DOUBLE_NOTE_DUR_TOL * Math.max(n.duration, top.duration),
    )
    if (partners.length > 0) {
      topPitches.add(top.midiNote)
      for (const p of partners) topPitches.add(p.midiNote)
    } else {
      let prevMidi = top.midiNote
      topPitches.add(top.midiNote)
      for (const n of byDesc.slice(1)) {
        if (n.midiNote < floor) break
        if (prevMidi - n.midiNote > TOP_VOICE_GAP) break
        topPitches.add(n.midiNote)
        prevMidi = n.midiNote
      }
    }
    for (const n of cluster) {
      n.hand = topPitches.has(n.midiNote) ? 'right' : 'left'
    }
    // 记录: 开篇有没有**持续**的 top voice 音? (只有持续音才算"有旋律在唱")
    if (
      cluster[0].time < openingEnd &&
      topPitches.size > 0 &&
      cluster.some((n) => topPitches.has(n.midiNote) && n.duration >= SUSTAIN_MIN_S)
    ) {
      openingHasSustainedHigh = true
    }
  }

  // Step 2: 开篇 N 小节没持续高音符 → 整段改 LH
  if (!openingHasSustainedHigh) {
    for (const n of notes) {
      if (n.time < openingEnd) n.hand = 'left'
    }
  }
}
