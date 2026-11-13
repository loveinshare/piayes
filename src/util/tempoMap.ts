// Tempo map (spec P2-3 / P2-15)
//
// 项目里到处写死 `bpms[0].bpm` —— 曲子中段有 ritardando / 渐快 / 渐慢时:
//   - 小节线错位 (computeMeasures 用固定 BPM 算小节时长)
//   - 节拍器跑偏 (Player 用 Math.floor(currentTime / secPerBeat) 判拍)
//   - 乐谱的音符时值算错 (StaffView 用固定 secPerQuarter 换算)
//
// 本模块把 `Bpm[]` 变成"分段速度表", 提供:
//   - bpmAt(t)          —— t 时刻的速度
//   - secPerQuarterAt(t)—— t 时刻一个四分音符多少秒
//   - beatIndexAt(t)    —— t 时刻落在第几拍 (含小数)
//   - timeOfBeat(n)     —— 第 n 拍的时刻
//   - beatTimes(until)  —— until 之前的全部拍点
//
// 拍的定义: **分母音符** (denominator note) —— 与项目原有口径一致
// (secPerBeat = 60/bpm * 4/den). 4/4 下一拍 = 四分音符; 6/8 下一拍 = 八分音符.
//
// 拍网格是**连续**的: 变速只改变"一拍多长", 不打断网格 —— 变速点落在哪一拍,
// 就从那一拍开始变长/变短. 这跟真实乐谱 (以及 sightread 的做法) 一致.

import type { Bpm, SongMeasure } from '../types'

export interface TempoSegment {
  /** 该段速度生效的起始时间 (秒) */
  time: number
  bpm: number
  /** 一拍多长 (秒) —— 分母音符 */
  secPerBeat: number
  /** 一拍多长 (秒) —— 四分音符 */
  secPerQuarter: number
  /** 段起点处的累计拍数 (连续, 不因变速重置) */
  beatStart: number
}

const DEFAULT_BPM = 120

export class TempoMap {
  readonly segments: TempoSegment[]

  constructor(bpms: Bpm[], denominator = 4) {
    const den = denominator > 0 ? denominator : 4
    const raw = (bpms ?? [])
      .filter((b) => b && Number.isFinite(b.time) && Number.isFinite(b.bpm) && b.bpm > 0)
      .slice()
      .sort((a, b) => a.time - b.time)
    if (raw.length === 0) raw.push({ time: 0, bpm: DEFAULT_BPM })

    // 同一时刻的多个 tempo 事件 —— 保留最后一个 (后写的生效)
    const points: { time: number; bpm: number }[] = []
    for (const b of raw) {
      const last = points[points.length - 1]
      if (last && Math.abs(last.time - b.time) < 1e-9) last.bpm = b.bpm
      else points.push({ time: b.time, bpm: b.bpm })
    }
    // 第一个 tempo 不在 0 时, 0..first 用第一个 bpm (曲首不能没有速度)
    if (points[0].time > 0) points.unshift({ time: 0, bpm: points[0].bpm })

    this.segments = []
    let beats = 0
    for (let i = 0; i < points.length; i++) {
      const secPerBeat = (60 / points[i].bpm) * (4 / den)
      const next = points[i + 1]
      const span = next ? Math.max(0, next.time - points[i].time) : Infinity
      this.segments.push({
        time: points[i].time,
        bpm: points[i].bpm,
        secPerBeat,
        secPerQuarter: 60 / points[i].bpm,
        beatStart: beats,
      })
      if (Number.isFinite(span)) beats += span / secPerBeat
    }
  }

  /** t 时刻落在哪个速度段 (二分) */
  private segmentIndexAt(t: number): number {
    const segs = this.segments
    let lo = 0
    let hi = segs.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segs[mid].time <= t) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  /** t 时刻的速度 (bpm) */
  bpmAt(t: number): number {
    return this.segments[this.segmentIndexAt(t)].bpm
  }

  /** t 时刻一拍的长度 (秒, 分母音符) */
  secPerBeatAt(t: number): number {
    return this.segments[this.segmentIndexAt(t)].secPerBeat
  }

  /** t 时刻一个四分音符的长度 (秒) */
  secPerQuarterAt(t: number): number {
    return this.segments[this.segmentIndexAt(t)].secPerQuarter
  }

  /**
   * t 时刻的累计拍数 (含小数) —— 拍网格跨变速**连续**, 不重置.
   * t < 0 返回负数 (曲首之前).
   */
  beatIndexAt(t: number): number {
    const seg = this.segments[this.segmentIndexAt(t)]
    return seg.beatStart + (t - seg.time) / seg.secPerBeat
  }

  /** 第 n 拍的时刻 (秒) */
  timeOfBeat(n: number): number {
    if (n <= 0) {
      // 曲首之前: 用第一段的速度往回推
      const seg = this.segments[0]
      return seg.time + n * seg.secPerBeat
    }
    // 找到累计拍数覆盖 n 的那一段
    let lo = 0
    let hi = this.segments.length - 1
    let ans = this.segments.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.segments[mid].beatStart <= n) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const seg = this.segments[ans]
    return seg.time + (n - seg.beatStart) * seg.secPerBeat
  }

  /**
   * until (含) 之前的全部拍点 —— computeMeasures / 画节拍点用.
   * 结果从 0 开始, 步长为"分母音符".
   */
  beatTimes(until: number): number[] {
    const out: number[] = []
    if (until < 0) return out
    // 拍网格是连续的 —— 直接按拍号取, 别按段生成 (变速点会把网格"错开",
    // 按段生成会漏拍/重拍).
    const maxBeat = Math.floor(this.beatIndexAt(until))
    for (let n = 0; n <= maxBeat; n++) {
      const t = this.timeOfBeat(n)
      if (t > until) break
      out.push(t)
    }
    return out
  }
}

/**
 * 便捷函数: 从 Bpm[] 建 tempo map (默认 4/4 拍号).
 */
export function tempoMapOf(
  bpms: Bpm[],
  timeSig?: { numerator: number; denominator: number },
): TempoMap {
  return new TempoMap(bpms, timeSig?.denominator ?? 4)
}

/**
 * 按 tempo map 算小节边界 (spec P2-3).
 *
 * 旧实现用**第一个** BPM 算整首的小节时长 —— 曲子中段变速后, 小节线会整体偏移,
 * 乐谱背景网格 / 导航到小节 / 节拍器全都不对.
 *
 * 新实现: 先按 tempo map 生成连续的拍网格, 再按拍号每 `numerator` 拍切一小节.
 * 这样小节线天然跟随变速, 而且跟节拍器的强拍 (beatIndex % numerator === 0) 对齐.
 */
export function computeMeasures(
  totalDuration: number,
  timeSig: { numerator: number; denominator: number },
  bpms: Bpm[],
): SongMeasure[] {
  if (!bpms || bpms.length === 0) return []
  if (!(totalDuration > 0)) return []
  const map = new TempoMap(bpms, timeSig.denominator)
  const beats = map.beatTimes(totalDuration)
  const perMeasure = Math.max(1, timeSig.numerator)
  const measures: SongMeasure[] = []
  for (let i = 0; i < beats.length; i += perMeasure) {
    const start = beats[i]
    if (start >= totalDuration) break
    const nextStart = beats[i + perMeasure]
    // 最后一小节可能不满 —— 按当时的速度补齐 (整小节宽度, 跟旧实现一致)
    const end =
      nextStart !== undefined ? nextStart : start + perMeasure * map.secPerBeatAt(start)
    measures.push({ number: i / perMeasure + 1, time: start, duration: end - start })
  }
  return measures
}

/**
 * 按 (可能多个) 拍号切小节。
 *
 * 整首一个拍号的曲子走 computeMeasures() 就够了; 但中途会变拍的曲子 (如「梦中的婚礼」
 * 4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8 …) 必须按 **tick** 对齐小节线 —— 拍号变化点
 * 落在哪个 tick 是文件里写死的, 换成秒再算会累积误差, 小节线就跟音乐错开了。
 *
 * 所以这里在 tick 空间里切小节, 再逐个换算成秒。
 */
export function computeMeasuresFromSignatures(
  ppq: number,
  signatures: { ticks: number; numerator: number; denominator: number }[],
  ticksToSeconds: (ticks: number) => number,
  endTicks: number,
): SongMeasure[] {
  const measures: SongMeasure[] = []
  let number = 1
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i]
    const segEnd = i + 1 < signatures.length ? signatures[i + 1].ticks : endTicks
    // 一小节 = numerator 个 (1/denominator) 拍 = numerator * ppq * 4 / denominator ticks
    const barTicks = (sig.numerator * ppq * 4) / sig.denominator
    // ★ 2026-11-13: barTicks 必须是**正的有限数** —— 否则下面那个 while
    //   原地打转 (barStart 永远不前进) → 无限往 measures 里塞 → 内存爆掉 →
    //   渲染进程被浏览器杀掉 (用户报的「切歌把浏览器带崩」).
    //   触发条件: 畸形 MIDI (拍号分子 = 0 / 分母 = 0 / ppq = 0).
    //   乐库 23 首曲子都正常, 但用户自己上传的谱子不一定.
    if (!(barTicks > 0) || !Number.isFinite(barTicks)) continue
    let barStart = sig.ticks
    while (barStart < segEnd) {
      const barEnd = Math.min(barStart + barTicks, segEnd)
      const start = ticksToSeconds(barStart)
      const end = ticksToSeconds(barEnd)
      measures.push({
        number: number++,
        time: start,
        duration: Math.max(0, end - start),
        numerator: sig.numerator,
        denominator: sig.denominator,
      })
      barStart = barEnd
    }
  }
  return measures
}

/** 拍点 (秒) —— 变拍曲子的拍网格用 */
export interface BeatPoint {
  /** 拍点时刻 (秒) */
  time: number
  /** 所属小节序号 (0 起) */
  measureIndex: number
  /** 小节内第几拍 (0 起) */
  beatInMeasure: number
  /** 是否强拍 (小节第一拍) */
  isDownbeat: boolean
}

/**
 * 按**每小节自己的拍号**生成拍点 —— 变拍曲子的正确拍网格。
 *
 * 整首一个拍号的曲子走 TempoMap 的连续拍网格就够了 (老路径, 行为完全不变);
 * 多拍号的曲子 (如「梦中的婚礼」4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8 …) 必须按
 * 小节自己的拍号算 —— 6/8 的一拍是八分音符、9/8 的一拍是附点四分, 用全曲固定的
 * 四分音符网格的话, 拍点就跟小节线对不上了 (节拍器会打在拍子中间).
 *
 * 拍的定义沿用项目原有口径: 一拍 = 分母音符 = (4 / denominator) 个四分音符.
 */
export function measureBeatPoints(
  measures: { time: number; duration: number; numerator?: number; denominator?: number }[],
  defaultTimeSig: { numerator: number; denominator: number },
  secPerQuarterAt: (t: number) => number,
): BeatPoint[] {
  const points: BeatPoint[] = []
  for (let mi = 0; mi < measures.length; mi++) {
    const m = measures[mi]
    const numBeats = Math.max(1, m.numerator ?? defaultTimeSig.numerator)
    const denominator = m.denominator ?? defaultTimeSig.denominator
    const beatQuarters = 4 / denominator
    const secPerQuarter = secPerQuarterAt(m.time)
    const measureEnd = m.time + m.duration
    for (let b = 0; b < numBeats; b++) {
      const t = m.time + b * beatQuarters * secPerQuarter
      // 最后一小节可能不满 (曲尾) —— 别把拍点排到小节线外面
      if (b > 0 && t > measureEnd + 1e-6) break
      points.push({ time: t, measureIndex: mi, beatInMeasure: b, isDownbeat: b === 0 })
    }
  }
  return points
}

/**
 * 这首歌是不是**变拍**的 (不同小节用了不同拍号)。
 *
 * 只有变拍曲子的拍网格需要按小节切; 整首一个拍号的曲子一律走老路径,
 * 避免影响其它 20+ 首曲库文件。
 */
export function hasVariableTimeSignature(
  measures: { numerator?: number; denominator?: number; time?: number; duration?: number }[],
  defaultTimeSig: { numerator: number; denominator: number },
): boolean {
  for (const m of measures) {
    const numerator = m.numerator ?? defaultTimeSig.numerator
    const denominator = m.denominator ?? defaultTimeSig.denominator
    if (numerator !== defaultTimeSig.numerator || denominator !== defaultTimeSig.denominator) {
      return true
    }
  }
  return false
}
