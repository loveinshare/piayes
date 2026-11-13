// MusicXML -> Song 归一化
// 用浏览器内置 DOMParser + createTreeWalker, 不引第三方 XML 库
// 参考 sightread/src/features/parsers/parse-xml.ts 的简化版
//
// 关键技巧:
// - <clef> 节点决定当前 hand (G = 右手, F = 左手)
// - <note><chord/> 表示和弦, 复用上一个 note 的 time
// - <backup> 倒退 currTime (左右手并行写谱)
// - 解析完整体 sort (因为 backup/forward 会让时间非单调)
//
// 修复: tempo 跟踪 + part ID UUID 回退 + octave-shift
//   - 每个 <sound tempo> 记录为 tempo change, notes 用所在段的 tempo 计算秒数
//   - part id 是 UUID (Music21 默认生成) 时回退到 array index
//   - <octave-shift> 影响后续 note 的 octave (肖邦 8va 记号)

import type { Song, SongNote, Bpm, Hand } from '../types'
import { inferHands } from './inferHands'
import { computeMeasures } from '../util/tempoMap'

const STEP_TO_PC: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
}

/**
 * <forward> / <backup> 的时长.
 *
 * 标准 MusicXML 用**属性**写 (`<forward duration="480"/>`), 但也有文件写成
 * 子元素 (`<forward><duration>480</duration></forward>`) —— 乐库里那批 .mxl
 * 就是后者. 两种都认, 属性优先.
 *
 * ★ 2026-11-02: 之前只认子元素, 于是标准写法 (属性) 的 forward 会被当成 0 ——
   音符之间的空隙整个丢掉, 后面所有音的时间轴集体前移.
 */
function forwardDuration(node: Element): number {
  const attr = node.getAttribute('duration')
  if (attr !== null && attr !== '') {
    const n = Number(attr)
    if (Number.isFinite(n)) return n
  }
  const n = Number(node.querySelector('duration')?.textContent ?? '0')
  return Number.isFinite(n) ? n : 0
}

function stepToMidi(step: string, octave: number, alter: number): number {
  return 12 * (octave + 1) + (STEP_TO_PC[step] ?? 0) + (alter || 0)
}

/** 累加 ticks 模式下, 把 wallTicks 通过 tempo 段切成秒 */
function ticksToSeconds(
  absTicks: number,
  divisions: number,
  tempoChanges: { ticks: number; tempo: number }[],
): number {
  let seconds = 0
  for (let i = 0; i < tempoChanges.length; i++) {
    const seg = tempoChanges[i]
    const segStart = seg.ticks
    const segEnd = i + 1 < tempoChanges.length ? tempoChanges[i + 1].ticks : absTicks
    const tickInSeg = Math.min(segEnd, absTicks) - segStart
    if (tickInSeg <= 0) continue
    seconds += (tickInSeg / divisions) * 60 / seg.tempo
  }
  return seconds
}

export function parseXml(text: string): Song {
  const xml = new DOMParser().parseFromString(text, 'application/xml')
  const parserError = xml.querySelector('parsererror')
  if (parserError) {
    throw new Error(`MusicXML parse error: ${parserError.textContent}`)
  }

  const walker = xml.createTreeWalker(
    xml.documentElement,
    NodeFilter.SHOW_ELEMENT,
  )

  let divisions = Number(
    xml.querySelector('divisions')?.textContent ?? '1',
  ) || 1
  // tempo changes 用 ticks (divisions) 作时间轴, 这样 backup/forward 也能跟上
  const tempoChanges: { ticks: number; tempo: number }[] = [{ ticks: 0, tempo: 120 }]
  let currTicks = 0
  let currHand: Hand = 'right'
  let currOctaveShift = 0  // 8va / 8vb 累计, 单位半音
  const notes: SongNote[] = []

  // 推断: part -> hand (用 array 顺序, 因为 id 可能是 UUID)
  const allParts = xml.querySelectorAll('part')
  const partToHand = new Map<number, Hand>()
  allParts.forEach((part, idx) => {
    const firstClef = part.querySelector('clef > sign')?.textContent?.trim()
    if (firstClef === 'F') partToHand.set(idx, 'left')
    else if (firstClef === 'G') partToHand.set(idx, 'right')
    else partToHand.set(idx, idx === 0 ? 'right' : 'left')
  })

  // part index 计数器 (因为 part.id 可能是 UUID, 不用 attribute)
  // 每个 <part> 有独立的时间线 (backup/forward 只影响本 part)
  // 所以用 partTicks 跟踪每个 part 自己的 currTicks
  let partIdx = -1
  const partTicks = new Map<number, number>()

  let node = walker.currentNode as Element | null
  while (node) {
    const tag = node.tagName

    if (tag === 'part') {
      // 进入新 part 前, 先把上一个 part 的 currTicks 存回去 (partIdx 此时还是旧值)
      if (partIdx >= 0) {
        partTicks.set(partIdx, currTicks)
      }
      partIdx++
      currHand = partToHand.get(partIdx) ?? 'right'
      // 进入新 part: 初始化 / 恢复该 part 的 ticks 游标
      currTicks = partTicks.get(partIdx) ?? 0
    }

    if (tag === 'sound' && node.hasAttribute('tempo')) {
      const t = Number(node.getAttribute('tempo'))
      if (t > 0) {
        // 同一 ticks 不要重复 push (rubato 可能在同一拍重复)
        const last = tempoChanges.at(-1)
        if (!last || last.ticks !== currTicks) {
          tempoChanges.push({ ticks: currTicks, tempo: t })
        } else {
          last.tempo = t
        }
      }
    }

    if (tag === 'clef') {
      const sign = node.querySelector('sign')?.textContent?.trim()
      if (sign === 'F') currHand = 'left'
      else if (sign === 'G') currHand = 'right'
    }

    if (tag === 'octave-shift') {
      const type = node.getAttribute('type')
      const num = Number(node.getAttribute('number') ?? '8')
      if (type === 'up') currOctaveShift += num
      else if (type === 'down') currOctaveShift -= num
      else if (type === 'stop') currOctaveShift = 0
    }

    if (tag === 'note') {
      const isRest = node.querySelector('rest') !== null
      const isChord = node.querySelector('chord') !== null

      if (isRest) {
        const dur = Number(
          node.querySelector('duration')?.textContent ?? '0',
        )
        currTicks += dur
      } else {
        const step = node.querySelector('step')?.textContent?.trim() ?? 'C'
        const octave =
          Number(node.querySelector('octave')?.textContent ?? '4')
        const alter = Number(
          node.querySelector('alter')?.textContent ?? '0',
        )
        const dur = Number(
          node.querySelector('duration')?.textContent ?? '0',
        )
        const midi = stepToMidi(step, octave, alter) + currOctaveShift
        const noteTime = isChord
          ? (notes.at(-1)?.time ?? ticksToSeconds(currTicks, divisions, tempoChanges))
          : ticksToSeconds(currTicks, divisions, tempoChanges)

        notes.push({
          midiNote: midi,
          time: noteTime,
          duration: 0,  // 后面 duration 再算 (因为同 note duration 也跟所在段 tempo 走)
          track: partIdx,
          hand: currHand,
          velocity: 0.8,
        })

        if (!isChord) currTicks += dur
      }
    }

    if (tag === 'backup') {
      const dur = forwardDuration(node)
      currTicks -= dur
    }

    if (tag === 'forward') {
      const dur = forwardDuration(node)
      currTicks += dur
    }

    // 离开 part 时保存 ticks
    // walker 没有"end of part"事件, 切到下一个 part 时由上面的 if (tag === 'part') 分支统一 save

    node = walker.nextNode() as Element | null
  }
  // 最后再把最后一个 part 的 ticks 写回 (上面没机会 save)
  if (partIdx >= 0) {
    partTicks.set(partIdx, currTicks)
  }

  // 算每个 note 的 duration: 用下一个同 part 的 note 的 time 减去自己的 time
  // (粗略但够用 — MusicXML 不直接给 wall-clock duration, 给的是 score divisions)
  for (let i = 0; i < notes.length; i++) {
    const cur = notes[i]
    let next = null
    for (let j = i + 1; j < notes.length; j++) {
      if (notes[j].track === cur.track && notes[j].time > cur.time) {
        next = notes[j]
        break
      }
    }
    cur.duration = next ? next.time - cur.time : 0.5
  }

  // 整体排序 (backup/forward/chord 会让时间乱)
  notes.sort((a, b) => a.time - b.time || a.midiNote - b.midiNote)

  // 推断 hands 用于 UI / 通道分配 (这里 hand 已经被填了, 但保留入口统一)
  const { hands, method, confidence } = inferHands(notes, null)

  // tempo 事件用于 BPM 渲染
  const bpms: Bpm[] = tempoChanges.map((tc) => ({
    time: ticksToSeconds(tc.ticks, divisions, tempoChanges),
    bpm: tc.tempo,
  }))
  // 用最后一个 tick 作为总时长
  const lastAbsTicks = currTicks > 0 ? currTicks : (notes.at(-1)?.time ?? 0) * divisions
  const duration =
    notes.length > 0
      ? Math.max(
          notes[notes.length - 1].time + notes[notes.length - 1].duration,
          ticksToSeconds(lastAbsTicks, divisions, tempoChanges),
        )
      : 0

  // measures —— 按 tempo map 算小节边界 (spec P2-3)
  const timeSignature = {
    numerator: Number(xml.querySelector('time > beats')?.textContent ?? '4'),
    denominator: Number(xml.querySelector('time > beat-type')?.textContent ?? '4') || 4,
  }
  const measures = computeMeasures(duration, timeSignature, bpms)

  return {
    notes,
    measures,
    bpms,
    duration,
    ppq: 480,
    hands,
    handInfer: { method, confidence },
    timeSignature,
    source: 'xml',
    keyFifths: extractKeyFifths(xml),
    clef: extractClefFromParts(allParts, partToHand),
    title: extractTitle(xml),
    composer: extractComposer(xml),
  }
}

/** 读第一个 <key><fifths>. 缺省 undefined. */
function extractKeyFifths(xml: Document): number | undefined {
  const f = xml.querySelector('key > fifths')?.textContent?.trim()
  if (f === undefined || f === '') return undefined
  const n = Number(f)
  return Number.isFinite(n) ? n : undefined
}

/** 按 part 推断谱号: F → bass, G → treble */
function extractClefFromParts(
  parts: NodeListOf<Element>,
  partToHand: Map<number, Hand>,
): Song['clef'] {
  const findSign = (hand: Hand): 'treble' | 'bass' | undefined => {
    for (let i = 0; i < parts.length; i++) {
      if (partToHand.get(i) !== hand) continue
      const sign = parts[i].querySelector('clef > sign')?.textContent?.trim()
      if (sign === 'F') return 'bass'
      if (sign === 'G') return 'treble'
    }
    return undefined
  }
  const right = findSign('right')
  const left = findSign('left')
  if (!right && !left) return undefined
  return {
    right: right ?? 'treble',
    left: left ?? 'bass',
  }
}

/** Read <work><work-title> or <movement-title>. Used by TopBar display. */
function extractTitle(xml: Document): string | undefined {
  const t = xml.querySelector('work > work-title')?.textContent?.trim()
    || xml.querySelector('movement-title')?.textContent?.trim()
  return t || undefined
}

/** Read <identification><creator type="composer"> or creator[0]. */
function extractComposer(xml: Document): string | undefined {
  const creators = xml.querySelectorAll('identification > creator')
  for (const c of Array.from(creators)) {
    if (c.getAttribute('type') === 'composer') {
      const t = c.textContent?.trim()
      if (t) return t
    }
  }
  const fb = xml.querySelector('identification > creator')?.textContent?.trim()
  return fb || undefined
}
