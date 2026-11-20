// scripts/lib/bwv1041.mjs
//
// 读 BWV 1041 第一乐章的**原始 6 声部 MIDI**, 把每个声部的音符抽出来.
//
// 为什么不能用曲库里的 bwv1041-allegro-moderato.mid:
// 那份文件的 "Strings" 轨把 Violin1/2 + Viola + Cello + Violone 全并成了一坨
// (2634 个音), 声部之间的和声关系全丢了 —— 没法做真正的缩编.
// 原始文件 tests/fixtures/midi/... 是 6 条独立轨, 是唯一能做缩编的素材.
//
// 这份 6 声部 MIDI 的 Solo Violin 轨跟曲库里那份的 Solo Violin 轨**逐音相同**
// (1104 个音, tick/音高/时值全对得上), 所以右手可以直接沿用曲库那份的字节,
// 保证「右手不动」.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitChunks } from './smf.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(__dirname, '..', '..')

/** 原始 6 声部文件 (仓库里的 fixture) */
export const SOURCE_MIDI = resolve(
  ROOT,
  'tests/fixtures/midi/Bach Concertos Bwv 1041 Violin Concerto N 1 1 Mov.mid',
)
/** 曲库里已发布的版本 (右手要跟它逐字节一致) */
export const LIBRARY_MIDI = resolve(ROOT, 'public/library/bach/bwv1041-allegro-moderato.mid')

/** 轨名 → 该轨的 MTrk chunk 内容 */
export function readChunks(file = SOURCE_MIDI) {
  const raw = readFileSync(file)
  const division = raw.readUInt16BE(12)
  const chunks = splitChunks(raw)
  const named = new Map()
  chunks.forEach((c, i) => {
    let name = ''
    for (const ev of c.events) {
      if (ev.bytes[0] === 0xff && ev.bytes[1] === 0x03) {
        name = ev.bytes.subarray(3).toString('utf8').trim()
        break
      }
    }
    named.set(name || `#${i}`, c)
  })
  return { raw, division, chunks, named }
}

/**
 * 把一条 MTrk 里的音符抽出来.
 * MIDI 的 note-off 有两种写法: 0x80 带力度, 0x90 带力度 0 —— 两种都当 note-off.
 */
export function notesOf(chunk) {
  const out = []
  const open = new Map() // key -> 还没配对的 note-on 队列 (FIFO)
  for (const ev of chunk.events) {
    const b = ev.bytes
    const st = b[0]
    if (st < 0x80 || st >= 0xf0) continue
    const type = st & 0xf0
    const key = (st & 0x0f) + ':' + b[1]
    if (type === 0x90 && b[2] > 0) {
      if (!open.has(key)) open.set(key, [])
      open.get(key).push({ tick: ev.tick, vel: b[2] })
    } else if (type === 0x80 || (type === 0x90 && b[2] === 0)) {
      const q = open.get(key)
      if (!q || q.length === 0) continue
      const on = q.shift()
      out.push({ s: on.tick, e: ev.tick, pitch: b[1], vel: on.vel })
    }
  }
  out.sort((a, b) => a.s - b.s || a.pitch - b.pitch)
  return out
}

/**
 * 读出 6 个声部.
 * 源文件里有 7 条带音符的轨, 其中 "Harpsichord" 跟 "Cello" 逐音相同 (键盘低音跟大提琴同奏),
 * 不用它 —— 免得低音重音加倍.
 */
export function readParts(file = SOURCE_MIDI) {
  const { raw, division, named } = readChunks(file)
  const get = (name) => {
    const c = named.get(name)
    if (!c) throw new Error(`源 MIDI 里没有轨 "${name}"`)
    return { chunk: c, notes: notesOf(c) }
  }
  return {
    raw,
    division,
    solo: get('Solo Violin'),
    violin1: get('Violin 1'),
    violin2: get('Violin 2'),
    viola: get('Viola'),
    cello: get('Cello'),
    violone: get('Violone'),
  }
}

/** 一拍多少 tick */
export const ticksPerBeat = (division) => division
