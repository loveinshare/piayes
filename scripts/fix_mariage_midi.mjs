#!/usr/bin/env node
// scripts/fix_mariage_midi.mjs
//
// 从原始下载件 downloads/梦中的婚礼.mid 重建曲库文件 public/library/pop/mariage-d-amour.mid。
//
// 背景 (2026-11-01): 之前那次 "修复" (R18) 只重写了容器 (曲名/拍号/标注), 音符数据一个字节没动,
// 于是把两处真实缺陷留在了曲库里:
//   1. 原始件 track 0 里那 31 个拍号变化 **不是乱码** —— 逐个验算过, 每一个都正好落在小节线上,
//      而且后半段把前半段的拍号顺序整个重复了一遍 (真正的二段式)。那次修复把它们拍平成单个 4/4,
//      于是小节线全错位 (44 小节 -> 55 小节)。
//   2. 有 4 个音符是损坏的: 2 个 onset 偏离 16 分网格 (+23 tick, 而且在文件里是倒序写的),
//      2 个 D7(98) —— 全曲唯一超过 C7 的音, 只出现这 2 次, 都夹在坏簇里。
//
// 这里重建: 恢复真拍号 + 修掉那 4 个音 + 统一速度 + 补齐 track 0 的 End-Of-Track。
// 其余音符数据 (tick / pitch / duration / velocity) 逐个保持不变, 脚本末尾会自检。
//
// 用法: node scripts/fix_mariage_midi.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(ROOT, 'downloads/梦中的婚礼.mid')
const OUT = resolve(ROOT, 'public/library/pop/mariage-d-amour.mid')

const TITLE = "Mariage d'amour"
const CREDIT = 'Paul de Senneville & Olivier Toussaint'
const TEMPO_US = 833333 // 72 BPM (原文件 track 0 的值)
const KEY_FIFTHS = -2 // bB 大调 / g 小调

// ---------------------------------------------------------------- SMF 读入

function readVarLen(buf, pos) {
  let value = 0
  let byte
  do {
    byte = buf[pos++]
    value = (value << 7) | (byte & 0x7f)
  } while (byte & 0x80)
  return { value, pos }
}

/** 把一个 MTrk 解成 {tick, ...} 事件序列 (保留 running status 展开后的真实状态字节) */
function readTrack(buf, start, end) {
  const events = []
  let pos = start
  let tick = 0
  let running = null
  while (pos < end) {
    const dt = readVarLen(buf, pos)
    tick += dt.value
    pos = dt.pos
    let status = buf[pos]
    if (status & 0x80) {
      running = status
      pos++
    } else {
      if (running === null) throw new Error(`track @${pos}: 没有 running status`)
      status = running
    }
    if (status < 0xf0) {
      const kind = status & 0xf0
      const len = kind === 0xc0 || kind === 0xd0 ? 1 : 2
      const data = buf.subarray(pos, pos + len)
      pos += len
      events.push({ tick, status, data: Buffer.from(data) })
      continue
    }
    if (status === 0xff) {
      const type = buf[pos++]
      const l = readVarLen(buf, pos)
      const data = Buffer.from(buf.subarray(l.pos, l.pos + l.value))
      pos = l.pos + l.value
      events.push({ tick, meta: type, data })
      continue
    }
    if (status === 0xf0 || status === 0xf7) {
      const l = readVarLen(buf, pos)
      pos = l.pos + l.value
      events.push({ tick, sysex: true })
      continue
    }
    throw new Error(`track @${pos}: 不支持的 status 0x${status.toString(16)}`)
  }
  return events
}

function readSmf(buf) {
  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('不是 MIDI 文件')
  const ppq = buf.readUInt16BE(12)
  const ntrks = buf.readUInt16BE(10)
  const tracks = []
  let pos = 14
  for (let i = 0; i < ntrks; i++) {
    if (buf.toString('latin1', pos, pos + 4) !== 'MTrk') throw new Error('缺 MTrk')
    const len = buf.readUInt32BE(pos + 4)
    tracks.push(readTrack(buf, pos + 8, pos + 8 + len))
    pos += 8 + len
  }
  return { ppq, tracks }
}

// ------------------------------------------------------- 音符提取 / 配对

/** 音符事件配对: (channel,pitch) 各一条 FIFO 队列, note-off 先进先出 */
function extractNotes(events) {
  const pending = new Map()
  const notes = []
  for (const ev of events) {
    if (ev.meta !== undefined || ev.sysex) continue
    const kind = ev.status & 0xf0
    const channel = ev.status & 0x0f
    const pitch = ev.data[0]
    const velocity = ev.data[1] ?? 0
    if (kind === 0x90 && velocity > 0) {
      const key = channel * 128 + pitch
      if (!pending.has(key)) pending.set(key, [])
      pending.get(key).push({ tick: ev.tick, velocity })
      continue
    }
    if (kind === 0x80 || (kind === 0x90 && velocity === 0)) {
      const key = channel * 128 + pitch
      const queue = pending.get(key)
      if (!queue || queue.length === 0) continue
      const start = queue.shift()
      notes.push({
        channel,
        pitch,
        velocity: start.velocity,
        tick: start.tick,
        duration: ev.tick - start.tick,
      })
    }
  }
  // 同一音高同时按响两次 -> FIFO 配对会错位, 这种文件不能这样重建
  for (const [, queue] of pending) {
    if (queue.length > 0) throw new Error('有 note-on 没有配对的 note-off')
  }
  return notes
}

// ---------------------------------------------------------------- SMF 写出

function writeVarLen(value) {
  const bytes = []
  let v = value >>> 0
  bytes.unshift(v & 0x7f)
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return Buffer.from(bytes)
}

function metaEvent(type, data) {
  return Buffer.concat([
    Buffer.from([0xff, type]),
    writeVarLen(data.length),
    Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'),
  ])
}

function buildTrack(events) {
  // events: [{tick, bytes}] -> 按 tick 排序后写 delta time
  const sorted = [...events].sort((a, b) => a.tick - b.tick)
  const parts = []
  let last = 0
  for (const ev of sorted) {
    parts.push(writeVarLen(ev.tick - last), ev.bytes)
    last = ev.tick
  }
  return Buffer.concat(parts)
}

function chunk(id, data) {
  const head = Buffer.from(id, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  return Buffer.concat([head, len, data])
}

// ---------------------------------------------------------------- 主流程

if (!existsSync(SRC)) {
  console.error(`找不到源文件: ${SRC}`)
  process.exit(1)
}

const raw = readFileSync(SRC)
const smf = readSmf(raw)
const [metaEvents, rhEvents, lhEvents] = smf.tracks

// --- 1. 收集原始拍号 (track 0) ---
const signatures = []
let tempoUs = null
for (const ev of metaEvents) {
  if (ev.meta === 0x58) {
    signatures.push({
      tick: ev.tick,
      numerator: ev.data[0],
      denominator: 2 ** ev.data[1],
    })
  } else if (ev.meta === 0x51) {
    tempoUs = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2]
  }
}
signatures.sort((a, b) => a.tick - b.tick)
if (tempoUs === null) throw new Error('源文件没有 tempo 事件')

// --- 2. 收集音符 ---
const rh = extractNotes(rhEvents)
const lh = extractNotes(lhEvents)

// 音乐结束点 (最后一个音符的结束)
const lastTick = Math.max(
  ...rh.map((n) => n.tick + n.duration),
  ...lh.map((n) => n.tick + n.duration),
)

console.log(`源文件: ${rh.length} 个 RH 音 / ${lh.length} 个 LH 音 / ${signatures.length} 个拍号 / ${lastTick} ticks`)

// --- 3. 修音符 ---
const GRID = 120 // 16 分音符 = 480/4
const repairs = []

const fixedRh = []
for (const n of rh) {
  // (a) onset 偏离 16 分网格 —— 文件损坏, 在 MIDI 事件流里还是倒序的
  if (n.tick % GRID !== 0) {
    repairs.push(`删 RH off-grid 音: pitch=${n.pitch} tick=${n.tick} (+${n.tick % GRID} tick)`)
    continue
  }
  // (b) D7(98): 全曲唯一超过 C7 的音, 只出现这 2 次, 都夹在坏簇里 -> 降八度回 D6
  if (n.pitch === 98) {
    repairs.push(`RH D7(98)@${n.tick} -> D6(86)`)
    fixedRh.push({ ...n, pitch: 86 })
    continue
  }
  fixedRh.push(n)
}

// 修完后再自检: 不应该再有 off-grid onset / 超高音
for (const n of [...fixedRh, ...lh]) {
  if (n.tick % GRID !== 0) throw new Error(`修完还有 off-grid 音: tick=${n.tick}`)
  if (n.pitch > 96) throw new Error(`修完还有超 C7 的音: pitch=${n.pitch}`)
}

// --- 4. 写 track 0 (meta) ---
const metaOut = []
metaOut.push({ tick: 0, bytes: metaEvent(0x03, TITLE) })
metaOut.push({ tick: 0, bytes: metaEvent(0x01, CREDIT) })
metaOut.push({
  tick: 0,
  bytes: metaEvent(0x51, Buffer.from([(TEMPO_US >> 16) & 0xff, (TEMPO_US >> 8) & 0xff, TEMPO_US & 0xff])),
})
metaOut.push({
  tick: 0,
  bytes: metaEvent(0x59, Buffer.from([KEY_FIFTHS & 0xff, 0])),
})
for (const sig of signatures) {
  const denomPow = Math.log2(sig.denominator)
  if (!Number.isInteger(denomPow)) throw new Error(`拍号分母不是 2 的幂: ${sig.denominator}`)
  // MIDI clocks per metronome click: 4/4 拍 = 24, 8 分拍 = 12
  const clocks = Math.max(1, Math.round((24 * 4) / sig.denominator))
  metaOut.push({
    tick: sig.tick,
    bytes: metaEvent(0x58, Buffer.from([sig.numerator, denomPow, clocks, 8])),
  })
}
// End-Of-Track 要盖住最后一个音符 (原文件里 track 0 的 EOT 早了 2159 tick)
metaOut.push({ tick: lastTick, bytes: metaEvent(0x2f, Buffer.alloc(0)) })

// --- 5. 写两个音符轨 ---
function buildNoteTrack(notes, name) {
  const events = []
  events.push({ tick: 0, bytes: metaEvent(0x03, name) })
  events.push({
    tick: 0,
    bytes: metaEvent(0x59, Buffer.from([KEY_FIFTHS & 0xff, 0])),
  })
  for (const n of notes) {
    const on = Buffer.from([0x90 | n.channel, n.pitch, n.velocity])
    const off = Buffer.from([0x80 | n.channel, n.pitch, 0])
    events.push({ tick: n.tick, bytes: on })
    events.push({ tick: n.tick + n.duration, bytes: off })
  }
  events.push({ tick: lastTick, bytes: metaEvent(0x2f, Buffer.alloc(0)) })
  // 同一 tick 上先 note-off 后 note-on, 避免同音高被前一个 note-off 提前关掉
  events.sort((a, b) => a.tick - b.tick || rank(a.bytes) - rank(b.bytes))
  return events
}
function rank(buf) {
  const s = buf[0]
  if (s === 0x80) return 0
  if (s === 0x90) return 1
  return 2
}

const rhTrack = buildNoteTrack(fixedRh, 'Piano')
const lhTrack = buildNoteTrack(lh, 'Track 2')

const header = Buffer.alloc(14)
header.write('MThd', 0, 'latin1')
header.writeUInt32BE(6, 4)
header.writeUInt16BE(1, 8) // format 1
header.writeUInt16BE(3, 10) // 3 tracks
header.writeUInt16BE(smf.ppq, 12)

const out = Buffer.concat([
  header,
  chunk('MTrk', buildTrack(metaOut)),
  chunk('MTrk', buildTrack(rhTrack)),
  chunk('MTrk', buildTrack(lhTrack)),
])

writeFileSync(OUT, out)

console.log('\n修复记录:')
for (const r of repairs) console.log('  - ' + r)
console.log(`\n写出: ${OUT} (${out.length} bytes)`)
console.log(`  RH ${rh.length} -> ${fixedRh.length} 音 / LH ${lh.length} 音 / 拍号 ${signatures.length} 个 / EOT@${lastTick}`)
