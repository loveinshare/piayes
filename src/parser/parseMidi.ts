// MIDI -> Song 归一化
// 复用 @tonejs/midi (sightread 在用), 内部表示是 SongNote[] 数组

import { Midi } from '@tonejs/midi'
import type { Song, SongNote, Bpm } from '../types'
import { inferHands } from './inferHands'
import { computeMeasuresFromSignatures } from '../util/tempoMap'

export function parseMidi(data: Uint8Array): Song {
  const midi = new Midi(data)
  const ppq = midi.header.ppq
  const bpms: Bpm[] = midi.header.tempos
    .filter((t) => t.time !== undefined)
    .map((t) => ({
      time: t.time as number, // @tonejs/midi 直接给 seconds
      bpm: t.bpm,
    }))

  // 去重: 一些 MIDI 文件有 100% 重复的 track (同一份 note 数据写两遍).
  // 按 (time, midiNote, duration) 签名, 整轨完全相同的视为冗余, 删后面那个.
  // 这只对 inferHands 优化 — 7 个 track 变 6 个, pitch 统计更准.
  const trackSigs: string[] = midi.tracks.map((t) =>
    t.notes
      .map((n) => `${n.time.toFixed(6)},${n.midi},${n.duration.toFixed(6)}`)
      .join('|'),
  )
  const trackIdxMap = new Map<number, number>() // 旧 idx -> 新 idx (跳过重复)
  // 签名 -> 首个出现该签名的 track 的新 idx.
// 以前是双层循环比字符串 (O(n²)), 长曲子 (几十个 track) 白白浪费 —— 一次遍历即可.
  const sigToNewIdx = new Map<string, number>()
  let newIdx = 0
  for (let i = 0; i < midi.tracks.length; i++) {
    if (trackSigs[i].length === 0) continue // 空 track 直接跳过
   const sig = trackSigs[i]
   const existing = sigToNewIdx.get(sig)
   if (existing !== undefined) {
     // 重复 — 这个 track 的 note 走已有那个的新 idx
     trackIdxMap.set(i, existing)
   } else {
     const idx = newIdx++
     sigToNewIdx.set(sig, idx)
     trackIdxMap.set(i, idx)
   }
  }

  const notes: SongNote[] = []
  let maxEndTick = 0
  midi.tracks.forEach((track, trackIdx) => {
    const newTrack = trackIdxMap.get(trackIdx)
    if (newTrack === undefined) return // 空 track

    // 同一 track 里**同 tick 同音高**的 note-on 是数据损坏 —— 同一个键在同一瞬间
    // 被敲了两次 (听感上就是一个键响一次, 但屏幕上会画两个音条、跟弹判定会要求按两下).
    // 乐库里三个文件有: 幻想即兴曲 6 个 / 爱之梦 22 个 / 卡农 26 个.
    // 幻想即兴曲和爱之梦的那份还是"零长度"的 (note-on 后面紧跟着 note-off).
    // 只留**时长最长**的那个 —— 键的余音按最长的那次算.
    const best = new Map<string, { n: (typeof track.notes)[number]; dur: number }>()
    for (const n of track.notes) {
      const k = `${n.ticks}:${n.midi}`
      const prev = best.get(k)
      if (!prev || n.durationTicks > prev.dur) best.set(k, { n, dur: n.durationTicks })
    }

    for (const { n } of best.values()) {
      notes.push({
        midiNote: n.midi,
        time: n.time,
        duration: n.duration,
        track: newTrack,
        hand: undefined, // 后面 inferHands / pitchSplit 填
        // @tonejs/midi 文档明确 n.velocity 已经是 0..1 归一化值 (Note.d.ts: "The normalized velocity (0-1)").
        // 之前误写成 /127 → 0.6 变 0.0047 → sendNoteOn 算出 vel=0 → 电钢 Note On vel=0 等同 Note Off → 钢琴不响.
        velocity: n.velocity,
      })
      maxEndTick = Math.max(maxEndTick, n.ticks + n.durationTicks)
    }
  })
  notes.sort((a, b) => a.time - b.time)

  // 拍号变化 (整首一个拍号时只有一项)。中途变拍的曲子必须按每一处拍号切小节,
  // 否则小节线会跟音乐错开 —— 比如「梦中的婚礼」原曲是 4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8 …
  //
  // 拍号事件写在 tick 0 之外的, **不**补一个 4/4 开头 —— 补了反而错:
  // 莫扎特安魂曲钢琴版的拍号事件写在 tick 5760, 而音乐也正是从 5760 开始
  // (前面 3 秒是空的). 文件声明的 12/8 才是这首的拍号: 三个声部的音全都落在
  // 附点四分音符的格子上 (5760 / 7200 / 8640 …), 一小节 = 4 个附点四分 = 5760 tick.
  // 补个 4/4 开头会让曲库显示的拍号变成 4/4 (实际是 12/8), 前面还多两小节空谱.
  const signatures = midi.header.timeSignatures.map((e) => ({
    ticks: e.ticks,
    numerator: e.timeSignature[0],
    denominator: e.timeSignature[1],
  }))

  // 拍号 (默认拍号 = 第一个"正经"拍号)
  const ts = defaultTimeSignature(signatures)
  const timeSignature = ts
    ? { numerator: ts.numerator, denominator: ts.denominator }
    : { numerator: 4, denominator: 4 }

  // 小节线 —— 一律在 **tick 空间**里切 (spec P2-3).
  //
  // 以前整首一个拍号的曲子走 computeMeasures (按 tempo map 推拍网格), 变拍的走 tick 空间.
  // tempo map 的拍网格只是**近似**: 变速点落在两拍中间时, 网格会整体错开, 越到后面偏得越多.
  // 莫扎特安魂曲 (1442 个 rubato 变速事件) 实测小节线最多偏 **5.7 秒** —— 谱面上小节线
  // 跟音乐对不上. tick 空间是文件里写死的小节长度, 永远准.
  //
  // 文件一个拍号事件都没有时, 补一个默认拍号 (4/4) 当作整首的拍号.
  const barSignatures =
    signatures.length > 0
      ? signatures
      : [{ ticks: 0, numerator: timeSignature.numerator, denominator: timeSignature.denominator }]
  const measures = computeMeasuresFromSignatures(
    midi.header.ppq,
    barSignatures,
    (ticks) => midi.header.ticksToSeconds(ticks),
    maxEndTick,
  )

  // 推断左右手 (mutates notes, 设 n.hand)
  const { hands, pitchSplit, method, confidence } = inferHands(notes, null, bpms, timeSignature)

  return {
    notes,
    measures,
    bpms,
    duration: midi.duration,
    ppq,
    hands,
    pitchSplit,
    handInfer: { method, confidence },
    timeSignature,
    timeSignatures: dedupeAdjacentSignatures(signatures).map((s) => ({
      time: midi.header.ticksToSeconds(s.ticks),
      numerator: s.numerator,
      denominator: s.denominator,
    })),
    source: 'midi',
    keyFifths: keySignatureToFifths(midi.header.keySignatures[0]?.key),
    title:
      cleanMetaText(midi.header.name) ||
      cleanMetaText(extractMetaText(midi.header.meta, ['title', 'T', 'trackName'])) ||
      undefined,
    composer: cleanMetaText(extractMetaText(midi.header.meta, ['composer', 'C', 'artist'])),
  }
}

/**
 * 相邻两处拍号**一样**时只留一处 (给 UI 显示用).
 *
 * 有些文件把同一个拍号写了好几遍 (幻想即兴曲 4/4 → 4/4, 军队波兰舞曲 3/4 写了 5 遍),
 * 显示成 "3/4 → 3/4 → 3/4 → 3/4" 很怪.
 *
 * 只影响**显示** —— 切小节用的 signatures 保持原样 (每一段的起止 tick 都要留着).
 */
function dedupeAdjacentSignatures<T extends { numerator: number; denominator: number }>(
  signatures: T[],
): T[] {
  const out: T[] = []
  for (const s of signatures) {
    const last = out[out.length - 1]
    if (!last || last.numerator !== s.numerator || last.denominator !== s.denominator) {
      out.push(s)
    }
  }
  return out
}

/**
 * 默认拍号 = 第一个"正经"的拍号 (跳过 1/4 这种弱起小节).
 *
 * 弱起: 很多曲库文件第一个拍号事件是 1/4 (只够一个弱起四分音符), 正文才是
 * 真正的拍号 —— 土耳其进行曲正文是 2/4, 爱之梦是 6/4.
 */
function defaultTimeSignature(
  signatures: { numerator: number; denominator: number }[],
): { numerator: number; denominator: number } | undefined {
  if (!signatures || signatures.length === 0) return undefined
  const proper = signatures.find((s) => s.numerator >= 2)
  return proper ?? signatures[0]
}

/** Tone.js 用字母调名 ('C', 'G', 'F#', 'Bb'...), 转 -7..+7 的 fifths */
function keySignatureToFifths(key: string | undefined): number | undefined {
  if (!key) return undefined
  const map: Record<string, number> = {
    Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1,
    C: 0,
    G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  }
  return map[key]
}

/**
*  Scan MIDI MetaEvent array for the first matching text-type event. @tonejs/midi
*  exposes meta events with type 'text'|'copyright'|'trackName'|'lyric'|... and a
*  `text` string. Returns trimmed text or undefined.
*/
function extractMetaText(meta: any, types: string[]): string | undefined {
  if (!Array.isArray(meta)) return undefined
  for (const m of meta) {
    if (types.includes(m?.type) && typeof m?.text === 'string') {
      const s = m.text.trim()
      if (s) return s
    }
  }
  return undefined
}

/** 中文/日文假名 —— 用来判断 meta 文本是不是"乱码" */
const CJK_RE = /[一-鿿぀-ヿ]/

/**
 * MIDI meta 文本清洗.
 *
 * 两件事:
 *  1. **去控制字符** —— 有些文件的 name 是 "Piano\u0000" (尾部补零),
 *     直接显示会带一个不可见字符.
 *  2. **修乱码** —— 文件里存的是 UTF-8 / GBK 字节, 但 MIDI 规范只定义了 ASCII,
 *     @tonejs/midi 只能按 latin-1 解 → 中文变成 "åå±éåº¦ä¸Žç»æ" 这种.
 *     表现: 一串 U+0080..U+00FF 的字符, 里面没有真正的中文.
 *     修法: 把这些字符还原成字节, 再按 UTF-8 / GBK 重新解.
 *
 * 乐库里的曲子曲名以 manifest.json 为准 (见 library.ts), 但**用户自己上传的**
 * 谱子只能靠这个 —— 上传时曲名就是从 MIDI 内部取的.
 */
export function cleanMetaText(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!s) return undefined
  return repairMojibake(s)
}

/**
 * 把 "latin-1 解码的中文乱码" 还原成正常文字.
 *
 * 只在**确定是乱码**时才动手:
 *  - 原文里已经有中日文 → 正常, 不动
 *  - U+0080..U+00FF 的字符少于 2 个 → 不是 GBK/UTF-8 被误解码的特征, 不动
 *  - 重新解码出来带 U+FFFD (替换字符) → 解码不合法, 不动
 */
function repairMojibake(s: string): string {
  if (CJK_RE.test(s)) return s
  const codes = [...s].map((c) => c.codePointAt(0)!)
  const suspect = codes.filter((c) => c >= 0x80 && c <= 0xff).length
  if (suspect < 2 || codes.some((c) => c > 0xff)) return s
  const bytes = Uint8Array.from(codes)
  // UTF-8 优先 (fatal: 遇到非法字节直接抛), 再试 GBK.
  // 两种编码都在 fatal 模式下解 —— 解不出干净的结果就放弃, 宁可保留原样.
  for (const enc of ['utf-8', 'gbk']) {
    try {
      const decoded = new TextDecoder(enc, { fatal: true }).decode(bytes)
      if (CJK_RE.test(decoded)) return decoded
    } catch {
      // 这个编码解不了 → 试下一个
    }
  }
  return s
}
