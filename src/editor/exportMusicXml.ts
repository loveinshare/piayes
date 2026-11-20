// MusicXML 导出 —— 把改过的音符写成 .musicxml / .mxl.
//
// 布局规则 (MusicXML 的「顺序模型」):
//   - 左右手各一个 <part>, part 内按时间**顺序**排音符
//   - 音符之间的空隙用 <forward> 填 —— 这样起音时刻能对上
//   - 音符的 <duration> = 它自己的时值
//   - 跨小节的音符先按小节线**切开** (带 <tie>), 小节总长才对得上
//
// .mxl = ZIP (mimetype 必须是第一个且不压缩, OPC 规范) + META-INF/container.xml
//        + score.musicxml —— 跟 parseMxl 的读取顺序完全对上.
//
// ⚠️ 往返的一个坑 (2026-11-02 实测):
//   本项目自己的 parseXml **不读** <duration>, 而是用「同 part 下一个音的时间 −
//   自己的时间」估时值 (见 parseXml.ts:187). 所以导出的 .mxl 再用本项目的解析器
//   读回来, **时值会偏** (音高和起始时间是对的).
//   - 想要**无损**: 用「应用到当前曲目」(就地改 song.notes) 或「导出 .mid」
//     (MIDI 的时值是精确的, 往返无损 —— 见 tests/score_editor.test.ts).
//   - 导出的 .mxl 是给 MuseScore / Finale 这类外部软件用的, 那边读 <duration>,
//     时值完全正确.

import { zipSync, strToU8 } from 'fflate'
import type { Song, SongNote, Bpm } from '../types'
import { secondsToTicks } from './exportMidi'

const DIVISIONS = 480 // 每四分音符的 tick 数

const STEP_NAMES = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B']

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** midi -> {step, alter, octave} —— 只用升号拼法 (D# 而不是 Eb), 音高一样 */
function pitchOf(midi: number) {
  const pc = ((midi % 12) + 12) % 12
  return {
    step: STEP_NAMES[pc],
    alter: pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10 ? 1 : 0,
    octave: Math.floor(midi / 12) - 1,
  }
}

/** 时值 (tick) -> { type, dots } —— 取最接近的符头 */
function noteType(durTicks: number): { type: string; dots: number } {
  const beats = durTicks / DIVISIONS
  const table: { beats: number; type: string; dots: number }[] = [
    { beats: 8, type: 'breve', dots: 0 },
    { beats: 4, type: 'whole', dots: 0 },
    { beats: 3, type: 'half', dots: 1 },
    { beats: 2, type: 'half', dots: 0 },
    { beats: 1.5, type: 'quarter', dots: 1 },
    { beats: 1, type: 'quarter', dots: 0 },
    { beats: 0.75, type: 'eighth', dots: 1 },
    { beats: 0.5, type: 'eighth', dots: 0 },
    { beats: 0.25, type: '16th', dots: 0 },
    { beats: 0.125, type: '32nd', dots: 0 },
    { beats: 0.0625, type: '64th', dots: 0 },
  ]
  let best = table[6]
  let bestDiff = Infinity
  for (const row of table) {
    const d = Math.abs(beats - row.beats)
    if (d < bestDiff) { bestDiff = d; best = row }
  }
  return { type: best.type, dots: best.dots }
}

/** 曲子的 tempo 段 */
function tempoSegments(song: Song): Bpm[] {
  if (song.bpms && song.bpms.length > 0) {
    const sorted = [...song.bpms].sort((a, b) => a.time - b.time)
    if (sorted[0].time > 1e-9) sorted.unshift({ time: 0, bpm: sorted[0].bpm })
    return sorted
  }
  return [{ time: 0, bpm: 120 }]
}

interface Segment {
  note: SongNote
  startTick: number
  durTicks: number
  /** 跨小节切出来的后半段 —— 需要 <tie type="start"> */
  tieStart: boolean
  /** 跨小节切出来的前半段 —— 需要 <tie type="stop"> */
  tieStop: boolean
}

interface MeasureBox {
  number: number
  startTick: number
  endTick: number
}

function measureBoxes(song: Song, segs: Bpm[]): MeasureBox[] {
  const list = song.measures.length
    ? song.measures
    : [{ number: 1, time: 0, duration: Math.max(1, song.duration) }]
  const boxes: MeasureBox[] = list.map((m) => ({
    number: m.number,
    startTick: secondsToTicks(segs, m.time, DIVISIONS),
    endTick: secondsToTicks(segs, m.time + Math.max(0.01, m.duration), DIVISIONS),
  }))
  // 小节首尾对齐 (前一节的结束 = 后一节的开始) —— 小节线才不会漂
  for (let i = 0; i < boxes.length - 1; i++) {
    boxes[i].endTick = Math.max(boxes[i].startTick + 1, boxes[i + 1].startTick)
  }
  const last = boxes[boxes.length - 1]
  if (last.endTick <= last.startTick) last.endTick = last.startTick + DIVISIONS * 4
  return boxes
}

/** 把音符按小节线切开 (跨小节的音符变成带 tie 的两段) */
function splitByMeasure(
  notes: SongNote[],
  boxes: MeasureBox[],
  segs: Bpm[],
): Segment[] {
  const out: Segment[] = []
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.midiNote - b.midiNote)
  for (const n of sorted) {
    const startTick = secondsToTicks(segs, n.time, DIVISIONS)
    const endTick = secondsToTicks(segs, n.time + Math.max(0.02, n.duration), DIVISIONS)
    let cursor = startTick
    let first = true
    let guard = 0
    while (cursor < endTick && guard++ < 64) {
      const mi = boxIndexAt(boxes, cursor)
      const box = boxes[mi]
      const segEnd = Math.min(endTick, box.endTick)
      if (segEnd <= cursor) break
      out.push({
        note: n,
        startTick: cursor,
        durTicks: segEnd - cursor,
        tieStart: !first,
        tieStop: segEnd < endTick,
      })
      cursor = segEnd
      first = false
    }
  }
  return out
}

function boxIndexAt(boxes: MeasureBox[], tick: number): number {
  for (let i = boxes.length - 1; i >= 0; i--) {
    if (tick >= boxes[i].startTick) return i
  }
  return 0
}

/**
 * 生成 MusicXML 文本.
 */
export function buildMusicXml(song: Song, notes: SongNote[]): string {
  const segs = tempoSegments(song)
  const boxes = measureBoxes(song, segs)
  const right = notes.filter((n) => n.hand !== 'left')
  const left = notes.filter((n) => n.hand === 'left')

  const parts: { id: string; name: string; clef: string; list: SongNote[] }[] = [
    { id: 'P1', name: 'Right hand', clef: 'G', list: right },
    { id: 'P2', name: 'Left hand', clef: 'F', list: left },
  ]

  const partXml = parts
    .map((part) => {
      const segments = splitByMeasure(part.list, boxes, segs)
      const byMeasure = new Map<number, Segment[]>()
      for (const s of segments) {
        const mi = boxIndexAt(boxes, s.startTick)
        if (!byMeasure.has(mi)) byMeasure.set(mi, [])
        byMeasure.get(mi)!.push(s)
      }

      const body: string[] = []
      for (let mi = 0; mi < boxes.length; mi++) {
        const box = boxes[mi]
        body.push(`    <measure number="${box.number}">`)
        if (mi === 0) {
          body.push(
            '      <attributes>' +
              `<divisions>${DIVISIONS}</divisions>` +
              `<key><fifths>${song.keyFifths ?? 0}</fifths></key>` +
              `<time><beats>${song.timeSignature.numerator}</beats>` +
              `<beat-type>${song.timeSignature.denominator}</beat-type></time>` +
              `<clef><sign>${part.clef}</sign><line>${part.clef === 'G' ? 2 : 4}</line></clef>` +
              '</attributes>',
          )
          body.push(
            `      <direction placement="above"><sound tempo="${segs[0].bpm.toFixed(3)}"/></direction>`,
          )
        }

        // 小节内按 tick 推进; 和弦 (同起点) 用 <chord/>
        let cursor = box.startTick
        let prevStart = -1
        for (const s of byMeasure.get(mi) ?? []) {
          if (s.startTick > cursor) {
            body.push(`      <forward duration="${s.startTick - cursor}"/>`)
            cursor = s.startTick
          }
          const isChord = prevStart === s.startTick
          body.push(noteXml(s, isChord))
          if (!isChord) {
            cursor += s.durTicks
            prevStart = s.startTick
          }
        }
        // ★ 小节末尾补一个 <forward> 把小节填满.
        //   不补的话: 1) 小节内容长度 ≠ 小节线长度 (MuseScore 会显示小节不完整)
        //   2) 解析器按**绝对** tick 累加, 空出来的那一截会让后面所有小节整体前移.
        if (cursor < box.endTick) {
          body.push(`      <forward duration="${box.endTick - cursor}"/>`)
        }
        body.push('    </measure>')
      }
      return `  <part id="${part.id}">\n${body.join('\n')}\n  </part>`
    })
    .join('\n')

  const title = esc(song.title ?? 'Untitled')
  const composer = esc(song.composer ?? '')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>${title}</work-title></work>
  <identification><creator type="composer">${composer}</creator><encoding><software>Piayes</software></encoding></identification>
  <part-list>
    <score-part id="P1"><part-name>Right hand</part-name></score-part>
    <score-part id="P2"><part-name>Left hand</part-name></score-part>
  </part-list>
${partXml}
</score-partwise>
`
}

function noteXml(s: Segment, isChord: boolean): string {
  const { step, alter, octave } = pitchOf(s.note.midiNote)
  const alterXml = alter === 0 ? '' : `<alter>${alter}</alter>`
  const chordXml = isChord ? '<chord/>' : ''
  const { type, dots } = noteType(s.durTicks)
  const dotsXml = '<dot/>'.repeat(dots)
  const tieXml = s.tieStart ? '<tie type="start"/>' : s.tieStop ? '<tie type="stop"/>' : ''
  const tiedXml = s.tieStart
    ? '<tied type="start"/>'
    : s.tieStop
      ? '<tied type="stop"/>'
      : ''
  const notations = tiedXml ? `<notations>${tiedXml}</notations>` : ''
  return (
    `      <note>${chordXml}` +
    `<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch>` +
    `<duration>${s.durTicks}</duration>` +
    '<voice>1</voice>' +
    `<type>${type}</type>${dotsXml}${tieXml}${notations}` +
    '</note>'
  )
}

/**
 * 生成 .mxl (压缩 MusicXML) 字节.
 *
 * ZIP 里 `mimetype` 必须是第一个条目且**不压缩** (OPC 规范),
 * 否则 MuseScore / Finale 之类会认不出来.
 */
export function buildMxl(song: Song, notes: SongNote[]): Uint8Array {
  const scoreXml = buildMusicXml(song, notes)
  const container =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container>\n  <rootfiles>\n    <rootfile full-path="score.musicxml"/>\n  </rootfiles>\n</container>\n'

  return zipSync({
    mimetype: [strToU8('application/vnd.recordare.musicxml'), { level: 0 }],
    'META-INF/container.xml': [strToU8(container), { level: 6 }],
    'score.musicxml': [strToU8(scoreXml), { level: 6 }],
  })
}
