#!/usr/bin/env node
// scripts/fix_library_keysig.mjs
//
// 修曲库文件里的调号 (只改调号 meta 事件, 音符数据一个字节都不动).
//
// 背景 (2026-11-02): 曲库逐文件体检发现两个文件的调号跟曲子对不上 ——
// 乐谱上的调号 (StaffView 按 keyFifths 画) 和音符里的升降号打架, 本来该在
// 调号里的音 (e.g. C# 小调的 F#/C#/G#/D#) 每个都得临时标升降号.
//
//   - public/library/chopin/waltz-op64-no2.mid 写的是 C (0 个升降号),
//     但这首是 **C# 小调**圆舞曲:
//       · 低音声部的音符落在 Ab-C#-E 的和弦上 (文件自己的音符能自证)
//       · 结尾和弦 = C#+Ab+E = C# 小调三和弦
//       · 同一首曲子的另一个文件 (godowsky-…) 调号就是 E (= C# 小调, 4 个升号)
//     C# 小调的调号 = 4 个升号 (E 大调), 也就是 sf=04.
//   - public/library/pop/flower-dance.mid 写的是 B (5 个升号 = B 大调),
//     但这首是 **C# 小调**:
//       · 开头左手是 E-B-E 的琶音 (= C# 小调的属和弦 V)
//       · 结尾 = C#5 (持续到曲末) + 左手 B4 (= C# 小调的主音 + 导音)
//     C# 小调的调号 = 4 个升号, sf=04.
//
// 修法: 就地改 FF 59 02 sf mi 调号 meta 事件里的两个字节 ——
// 长度不变, 所以 MTrk 长度和整个文件结构都不用动.
//
// mi = 0 大调 / 1 小调 (SMF 规范). 这里改成 1 (小调), 因为这两个文件都是小调曲.
//
// 用法: node scripts/fix_library_keysig.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 要修的文件.
 *
 * `sf` = 调号的升降号数 (正 = 升号, 负 = 降号), `mi` = 0 大调 / 1 小调.
 */
const TARGETS = [
  { file: 'chopin/waltz-op64-no2.mid', sf: 4, mi: 1 },
  { file: 'pop/flower-dance.mid', sf: 4, mi: 1 },
]

/** 升降号数 → 调名 (@tonejs/midi 的 keySignatureKeys 顺序) */
const KEY_NAMES = [
  'C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯',
]

// ---------------------------------------------------------------- SMF 读取

function readVarLen(buf, pos) {
  let value = 0
  let byte
  do {
    byte = buf[pos++]
    value = (value << 7) | (byte & 0x7f)
  } while (byte & 0x80)
  return { value, pos }
}

/**
 * 扫一遍 SMF, 找出所有调号 meta 事件 (0xFF 0x59 0x02 sf mi)
 * 在文件里的**字节位置** (sf/mi 所在处).
 */
function findKeySignatureEvents(buf) {
  const found = []
  let pos = 14 // MThd
  const ntrks = buf.readUInt16BE(10)
  for (let i = 0; i < ntrks; i++) {
    if (buf.toString('latin1', pos, pos + 4) !== 'MTrk') throw new Error('缺 MTrk')
    const len = buf.readUInt32BE(pos + 4)
    const end = pos + 8 + len
    let p = pos + 8
    let running = null
    while (p < end) {
      const dt = readVarLen(buf, p)
      p = dt.pos
      let status = buf[p]
      if (status & 0x80) {
        running = status
        p++
      } else {
        status = running
      }
      if (status === 0xff) {
        const type = buf[p++]
        const l = readVarLen(buf, p)
        const dataPos = l.pos
        const dataLen = l.value
        if (type === 0x59 && dataLen >= 2) {
          found.push({ pos: dataPos, sf: buf.readInt8(dataPos), mi: buf[dataPos + 1] })
        }
        p = dataPos + dataLen
        continue
      }
      if (status < 0xf0) {
        const kind = status & 0xf0
        p += kind === 0xc0 || kind === 0xd0 ? 1 : 2
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        const l = readVarLen(buf, p)
        p = l.pos + l.value
        continue
      }
      throw new Error(`track @${p}: 不支持的 status 0x${status.toString(16)}`)
    }
    pos = end
  }
  return found
}

// ---------------------------------------------------------------- 主流程

for (const { file: rel, sf, mi } of TARGETS) {
  const file = resolve(ROOT, 'public/library', rel)
  const buf = readFileSync(file)
  const events = findKeySignatureEvents(buf)
  if (events.length === 0) throw new Error(`${rel}: 没找到调号事件`)

  events.forEach((ev, i) => {
    const old = `${KEY_NAMES[ev.sf + 7]} (${ev.sf >= 0 ? '+' : ''}${ev.sf}, ${ev.mi ? 'minor' : 'major'})`
    buf.writeInt8(sf, ev.pos)
    buf[ev.pos + 1] = mi
    console.log(`${rel}[${i}]: 调号 ${old} → ${KEY_NAMES[sf + 7]} (${sf}, ${mi ? 'minor' : 'major'})  (@byte ${ev.pos})`)
  })
  writeFileSync(file, buf)
  console.log(`  写出 ${file} (${buf.length} bytes)`)
}
