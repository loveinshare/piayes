#!/usr/bin/env node
// scripts/fix_library_timesig.mjs
//
// 修曲库文件里的拍号 (只改拍号 meta 事件, 音符数据一个字节都不动).
//
// 背景 (2026-11-02): 曲库体检发现两处拍号写错的文件:
//   - public/library/chopin/waltz-op64-no2.mid 写的是 4/4, 但 Chopin Op.64 No.2
//     是**圆舞曲 = 3/4**. 文件内部也能自证:
//       · 低音声部的音符每隔 ~576 tick (ppq=192 → 3 个四分音符) 落一次 = 一小节
//       · 同一首曲子的另一个文件 (godowsky-waltz-csharp-minor.mid) 拍号就是 3/4
//   - public/library/chopin/fantaisie-impromptu.mid 开头写的是 2/2, 但文件自己的
//     **再现段** (180 秒处, 同一段 Presto 音乐) 写的是 4/4 —— 同一段音乐两个拍号,
//     显然是文件头写错了. 原曲 Op.66 的 Presto 也是普通拍 (4/4).
// 拍号错了, 乐谱的小节线、节拍器的重音全跟着错.
//
// 修法: 就地改 FF 58 04 时间签名 meta 事件里的分子/分母两个字节 ——
// 长度不变, 所以 MTrk 长度和整个文件结构都不用动.
//
// 用法: node scripts/fix_library_timesig.mjs

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 要修的文件.
 *
 * `only` = 只改第几个拍号事件 (不写 = 全改). 一个文件里有多处拍号事件时,
 * 只想改其中一处时用它 —— 比如幻想即兴曲只有开头那个 2/2 是错的 (再现段是
 * 同一段音乐, 文件自己写的是 4/4).
 */
const TARGETS = [
  { file: 'chopin/waltz-op64-no2.mid', num: 3, den: 4 },
  { file: 'chopin/fantaisie-impromptu.mid', num: 4, den: 4, only: [0] },
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
 * 扫一遍 SMF, 找出所有时间签名 meta 事件 (0xFF 0x58 0x04 nn dd cc bb)
 * 在文件里的**字节位置** (nn/dd 所在处).
 */
function findTimeSignatureEvents(buf) {
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
        if (type === 0x58 && dataLen >= 2) {
          found.push({ pos: dataPos, numerator: buf[dataPos], denomPow: buf[dataPos + 1] })
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

for (const { file: rel, num, den, only } of TARGETS) {
  const file = resolve(ROOT, 'public/library', rel)
  const buf = readFileSync(file)
  const events = findTimeSignatureEvents(buf)
  if (events.length === 0) throw new Error(`${rel}: 没找到拍号事件`)
  const denomPow = Math.round(Math.log2(den))
  if (!Number.isInteger(denomPow)) throw new Error(`分母不是 2 的幂: ${den}`)

  events.forEach((ev, i) => {
    if (only && !only.includes(i)) return
    const old = `${ev.numerator}/${2 ** ev.denomPow}`
    buf[ev.pos] = num
    buf[ev.pos + 1] = denomPow
    console.log(`${rel}[${i}]: 拍号 ${old} → ${num}/${den}  (@byte ${ev.pos})`)
  })
  writeFileSync(file, buf)
  console.log(`  写出 ${file} (${buf.length} bytes)`)
}
