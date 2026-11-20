#!/usr/bin/env node
// scripts/merge_bwv1041_tracks.mjs
//
// 把曲库文件 public/library/bach/bwv1041-allegro-moderato.mid 的 6 条音符轨
// 合成 2 条: 独奏小提琴 (原样不动) + 弦乐伴奏 (5 条轨合成 1 条).
//
// ── 为什么 (用户 2026-11-04 的要求) ─────────────────────────────────────
//   「这首单独处理一下 —— 小提琴我想用右手练着玩, 其他的算左声部」.
//
// app 判左右手有两条路径 (src/parser/inferHands.ts):
//   - ≥3 轨 → "主旋律那个 = 右手", 靠**平均音高 + 音符数**去猜, 置信度 medium
//     (界面上挂一个「手别为推断」的提示)
//   - =2 轨 → 直接按平均音高分, 置信度 high
// 这首原来是 6 轨, 走的是**猜**的那条路 —— 结果碰巧是对的 (小提琴 1104 音
// avg 73.4, 弦乐第一 574 音 avg 73.5, 靠音符数挑中了独奏), 但那是猜的.
//
// 合成成 2 轨后, 手别变成**确定**的: 小提琴 avg 73.4 (高) = 右手, 伴奏 avg ~56 = 左手.
// 而且这是**纯乐谱改动** —— app 的判定逻辑一行没动.
//
// ── 为什么必须合成到**一个通道 + 一个音色** ────────────────────────────
// @tonejs/midi 读文件时会按 (program, channel) 把每条 MTrk **再拆开**
// (dist/Midi.js 的 splitTracks): 一个 MTrk 里如果同时有 5 个通道, 读出来
// 还是 5 条轨, app 那边等于没合并过.
// 所以伴奏的 5 件乐器要合成 1 条轨, 就得**统一通道 (ch1) 和音色 (program 40)**.
//
// ── 同一个键被多个乐器同时按住怎么办 (区间并集) ───────────────────────
// 原来的 5 条轨各走各的通道, 同一时刻同一个音高可以被两件乐器同时按住
// (比如 Violin 1 和 Viola 都按 A4). 合成到一个通道后, 同样的音高就该像
// 钢琴那样**只按一次键** —— 音符区间取**并集** (谁按着就一直响到最后一个松开).
// 不是简单去重: 两个区间前后相接 (A4 在 100-200 和 200-400) 并成一个 100-400.
//
//   伴奏原音符 2798 → 并集后 2223 (少掉的 575 个是"两件乐器同时按同一个键")
//
// ── 音符数据本身不改 ──────────────────────────────────────────────────
// 每个音的 tick / 音高 / 时值都跟原文件对得上 (只有同一音高的重叠按住被并成一段).
// 小提琴那条轨 **一个字节都不改**.
//
// 用法: node scripts/merge_bwv1041_tracks.mjs
// (幂等: 已经合成过 (2 条音符轨) 就直接退出)

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import midiPkg from '@tonejs/midi'
const { Midi } = midiPkg

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = resolve(ROOT, 'public/library/bach/bwv1041-allegro-moderato.mid')

/** 合成后伴奏轨的名字 */
const MERGED_NAME = 'Strings (Violin 1+2, Viola, Cello, Violone)'
/** 伴奏轨用的通道 (小提琴占 ch0) */
const ACC_CHANNEL = 1
/** 伴奏轨用的音色 (统一成小提琴 —— 原来的 Violin/Viola/Cello/Violone 四种音色
 *  app 根本用不上: 它发 MIDI Out 时统一走一个通道, 不发 program change) */
const ACC_PROGRAM = 40

// ───────────────────────────────────────────────────────── SMF 读写

/** 读变长整数 (VLQ) */
function readVarLen(buf, pos) {
  let value = 0
  let byte
  do {
    byte = buf[pos++]
    value = (value << 7) | (byte & 0x7f)
  } while (byte & 0x80)
  return { value, pos }
}

/** 写变长整数 (VLQ) */
function writeVarLen(value) {
  const out = [value & 0x7f]
  value >>= 7
  while (value > 0) {
    out.unshift((value & 0x7f) | 0x80)
    value >>= 7
  }
  return out
}

/**
 * 把一条 MTrk 解成事件列表.
 * 每个事件 = { tick (绝对), bytes (完整事件字节, 含状态字节) }.
 * running status 展开成显式状态字节.
 */
function parseTrack(buf, start, end) {
  const events = []
  let pos = start
  let tick = 0
  let lastStatus = null
  while (pos < end) {
    const dl = readVarLen(buf, pos)
    pos = dl.pos
    tick += dl.value
    let status = buf[pos]
    if (status < 0x80) {
      if (lastStatus === null) throw new Error('MTrk 里出现了没有前导状态字节的 running status')
      status = lastStatus
    } else {
      pos++
    }
    lastStatus = status
    if (status === 0xff) {
      const metaType = buf[pos]
      pos++
      const len = readVarLen(buf, pos)
      pos = len.pos
      const data = buf.subarray(pos, pos + len.value)
      pos += len.value
      events.push({
        tick,
        bytes: Buffer.concat([
          Buffer.from([0xff, metaType]),
          Buffer.from(writeVarLen(len.value)),
          Buffer.from(data),
        ]),
      })
    } else if (status === 0xf0 || status === 0xf7) {
      const len = readVarLen(buf, pos)
      pos = len.pos
      const data = buf.subarray(pos, pos + len.value)
      pos += len.value
      events.push({
        tick,
        bytes: Buffer.concat([Buffer.from([status]), Buffer.from(writeVarLen(len.value)), Buffer.from(data)]),
      })
    } else {
      const type = status & 0xf0
      const dataLen = type === 0xc0 || type === 0xd0 ? 1 : 2
      const data = buf.subarray(pos, pos + dataLen)
      pos += dataLen
      events.push({ tick, bytes: Buffer.concat([Buffer.from([status]), Buffer.from(data)]) })
    }
  }
  return events
}

/**
 * 把事件列表编码成一条 MTrk 的内容 (不含 "MTrk" + 长度头).
 * 同状态字节连续出现时用 running status 压缩.
 */
function encodeTrack(events) {
  const out = []
  let prevTick = 0
  let lastStatus = null
  for (const ev of events) {
    const delta = ev.tick - prevTick
    if (delta < 0) throw new Error(`事件 tick 倒退: ${ev.tick} < ${prevTick}`)
    prevTick = ev.tick
    out.push(...writeVarLen(delta))
    const status = ev.bytes[0]
    const isChannel = status < 0xf0
    if (isChannel && status === lastStatus) {
      out.push(...ev.bytes.subarray(1))
    } else {
      out.push(...ev.bytes)
      if (isChannel) lastStatus = status
    }
  }
  return Buffer.from(out)
}

/** 一条 MTrk chunk = 'MTrk' + 4 字节长度 + 内容 */
function chunk(content) {
  const head = Buffer.alloc(8)
  head.write('MTrk', 0, 'ascii')
  head.writeUInt32BE(content.length, 4)
  return Buffer.concat([head, content])
}

/** 拆出文件里的所有 MTrk chunk */
function splitChunks(raw) {
  const chunks = []
  let pos = 14
  while (pos < raw.length) {
    const id = raw.toString('ascii', pos, pos + 4)
    const len = raw.readUInt32BE(pos + 4)
    if (id !== 'MTrk') throw new Error(`意外的 chunk: ${id}`)
    chunks.push({
      content: Buffer.from(raw.subarray(pos + 8, pos + 8 + len)),
      events: parseTrack(raw, pos + 8, pos + 8 + len),
    })
    pos += 8 + len
  }
  return chunks
}

// ───────────────────────────────────────────────────────── 音符区间并集

/**
 * 每个音高的区间并集.
 * 同一时刻被多个乐器按住的同一个键, 在钢琴上只算**按住一次**,
 * 声音持续到最后一个松开为止 —— 所以取并集, 不是简单去重.
 *
 * 只合并**真正重叠**的区间 (iv.s < last.e); 首尾相接的 (iv.s === last.e)
 * 保持独立 —— 那是同一个人重新敲了一下键, 该分开.
 */
function unionIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.s - b.s)
  const out = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv.s < last.e) {
      if (iv.e > last.e) last.e = iv.e
      last.v = Math.max(last.v, iv.v)
    } else {
      out.push({ ...iv })
    }
  }
  return out
}

// ───────────────────────────────────────────────────────── 主流程

const raw = readFileSync(FILE)

const header = raw.subarray(0, 14)
if (header.toString('ascii', 0, 4) !== 'MThd') throw new Error('不是 MIDI 文件')
if (header.readUInt16BE(8) !== 1) throw new Error(`不是 SMF format 1: ${header.readUInt16BE(8)}`)
const division = header.readUInt16BE(12)

const midi = new Midi(new Uint8Array(raw))
const noteTracks = midi.tracks.filter((t) => t.notes.length > 0)
if (noteTracks.length === 0) throw new Error('文件里没有音符轨')
if (noteTracks.length <= 2) {
  console.log(`已经是 ${noteTracks.length} 条音符轨, 不用处理`)
  process.exit(0)
}
console.log(
  `音符轨: ${noteTracks.map((t) => `${t.name || '(无名)'}(${t.notes.length} 音, ch${t.channel})`).join(', ')}`,
)

// 第 1 条音符轨 = 独奏小提琴 (原样保留), 其余全部并成伴奏轨
const violin = noteTracks[0]
const orchestra = noteTracks.slice(1)

// ── 伴奏: 每个音高的区间并集
const byPitch = new Map()
for (const t of orchestra) {
  for (const n of t.notes) {
    const v = Math.max(1, Math.round(n.velocity * 127))
    if (!byPitch.has(n.midi)) byPitch.set(n.midi, [])
    byPitch.get(n.midi).push({ s: n.ticks, e: n.ticks + n.durationTicks, v })
  }
}
const mergedNotes = []
let rawAccCount = 0
for (const [pitch, ivs] of byPitch) {
  rawAccCount += ivs.length
  for (const u of unionIntervals(ivs)) mergedNotes.push({ pitch, ...u })
}
mergedNotes.sort((a, b) => a.s - b.s || a.pitch - b.pitch)
console.log(
  `伴奏: ${rawAccCount} 音 → 并集后 ${mergedNotes.length} 音 (同一键被多件乐器同时按住的部分合并)`,
)

// ── 组装伴奏轨的事件
const mergedEvents = [
  // 音色 + 通道统一 —— @tonejs/midi 按 (program, channel) 拆轨, 不统一就白合并了
  { tick: 0, bytes: Buffer.from([0xc0 | ACC_CHANNEL, ACC_PROGRAM]) },
  {
    tick: 0,
    bytes: Buffer.concat([
      Buffer.from([0xff, 0x03]),
      Buffer.from(writeVarLen(Buffer.byteLength(MERGED_NAME))),
      Buffer.from(MERGED_NAME, 'utf8'),
    ]),
  },
]
for (const n of mergedNotes) {
  mergedEvents.push({ tick: n.s, bytes: Buffer.from([0x90 | ACC_CHANNEL, n.pitch, n.v]) })
  mergedEvents.push({ tick: n.e, bytes: Buffer.from([0x80 | ACC_CHANNEL, n.pitch, 64]) })
}
mergedEvents.sort((a, b) => a.tick - b.tick)
// 同一 tick 上先 note-off 后 note-on (新音开始前旧的先松开), 避免同音高首尾相接时被配对错
mergedEvents.sort((a, b) => {
  if (a.tick !== b.tick) return a.tick - b.tick
  const ao = (a.bytes[0] & 0xf0) === 0x80 ? 0 : 1
  const bo = (b.bytes[0] & 0xf0) === 0x80 ? 0 : 1
  return ao - bo
})
const lastTick = mergedEvents.length ? mergedEvents[mergedEvents.length - 1].tick : 0
mergedEvents.push({ tick: lastTick, bytes: Buffer.from([0xff, 0x2f, 0x00]) })

const mergedTrack = encodeTrack(mergedEvents)

// ── 组装新文件: 全局 meta 轨 / 小提琴轨 (原字节) / 伴奏轨 / 剩下的纯文字块
const chunks = splitChunks(raw)
const violinChunkIdx = chunks.findIndex(
  (c) => c.events.some((e) => (e.bytes[0] & 0xf0) === 0x90 && e.bytes[0] === 0x90),
)
if (violinChunkIdx < 0) throw new Error('找不到小提琴轨')

const outChunks = []
let inserted = false
for (let i = 0; i < chunks.length; i++) {
  const c = chunks[i]
  const hasNotes = c.events.some((e) => (e.bytes[0] & 0xf0) === 0x90)
  if (i === violinChunkIdx) {
    outChunks.push(chunk(c.content)) // 小提琴轨: 原字节保留
    outChunks.push(chunk(mergedTrack)) // 伴奏轨: 紧跟其后
    inserted = true
  } else if (hasNotes) {
    // 其余伴奏轨: 被合并掉了, 跳过
  } else {
    outChunks.push(chunk(c.content)) // 全局 meta / 纯文字块: 原样保留
  }
}
if (!inserted) throw new Error('没找到小提琴轨的位置')

const newHeader = Buffer.alloc(14)
newHeader.write('MThd', 0, 'ascii')
newHeader.writeUInt32BE(6, 4)
newHeader.writeUInt16BE(1, 8) // format 1
newHeader.writeUInt16BE(outChunks.length, 10)
newHeader.writeUInt16BE(division, 12)

writeFileSync(FILE, Buffer.concat([newHeader, ...outChunks]))

// ── 自检: 读回来必须正好 2 条音符轨, 音符内容对得上
const after = new Midi(new Uint8Array(readFileSync(FILE)))
const afterNotes = after.tracks.filter((t) => t.notes.length > 0)
if (afterNotes.length !== 2) {
  throw new Error(`合成后应该有 2 条音符轨, 实际 ${afterNotes.length} 条`)
}

const violinAfter = afterNotes[0].notes
if (violinAfter.length !== violin.notes.length) {
  throw new Error(`小提琴音符数变了: ${violin.notes.length} → ${violinAfter.length}`)
}
for (let i = 0; i < violin.notes.length; i++) {
  const a = violin.notes[i]
  const b = violinAfter[i]
  if (a.ticks !== b.ticks || a.midi !== b.midi || a.durationTicks !== b.durationTicks) {
    throw new Error(`小提琴第 ${i} 个音符变了: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
  }
}

const accAfter = afterNotes[1].notes
if (accAfter.length !== mergedNotes.length) {
  throw new Error(`伴奏音符数对不上: 预期 ${mergedNotes.length}, 实际 ${accAfter.length}`)
}
const accKey = accAfter.map((n) => `${n.ticks}:${n.midi}:${n.durationTicks}`).sort()
const mergedKey = mergedNotes.map((n) => `${n.s}:${n.pitch}:${n.e - n.s}`).sort()
for (let i = 0; i < accKey.length; i++) {
  if (accKey[i] !== mergedKey[i]) throw new Error(`伴奏第 ${i} 个音符对不上: ${accKey[i]} vs ${mergedKey[i]}`)
}

// 时长 / 结尾不能变
if (Math.abs(after.duration - midi.duration) > 0.001) {
  throw new Error(`总时长变了: ${midi.duration.toFixed(3)}s → ${after.duration.toFixed(3)}s`)
}

const avg = (ns) => ns.reduce((s, n) => s + n.midi, 0) / ns.length
console.log(`合成完成: ${noteTracks.length} 条音符轨 → 2 条`)
console.log(`  track0 (小提琴)  ${violinAfter.length} 音, avg ${avg(violinAfter).toFixed(1)} → 右手`)
console.log(`  track1 (伴奏)    ${accAfter.length} 音, avg ${avg(accAfter).toFixed(1)} → 左手`)
console.log(`总时长 ${after.duration.toFixed(1)}s (不变)`)
console.log(`文件大小 ${raw.length} → ${readFileSync(FILE).length} 字节`)
