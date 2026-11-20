// scripts/lib/smf.mjs
//
// 纯 Node 的 SMF (Standard MIDI File) 读写 —— 不依赖任何三方库.
//
// 为什么不用 @tonejs/midi 写文件: 它会按 (program, channel) 把轨重新拆开重编,
// 字节全变. 曲库文件要求「某条轨**原样不动**」(比如独奏小提琴那条),
// 就必须自己控制字节 —— 所以这里自己实现 SMF 的读写.
//
// 跟 scripts/merge_bwv1041_tracks.mjs 里的实现是同一套, 抽出来共用.

/** 读变长整数 (VLQ) */
export function readVarLen(buf, pos) {
  let value = 0
  let byte
  do {
    byte = buf[pos++]
    value = (value << 7) | (byte & 0x7f)
  } while (byte & 0x80)
  return { value, pos }
}

/** 写变长整数 (VLQ) */
export function writeVarLen(value) {
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
export function parseTrack(buf, start, end) {
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
        bytes: Buffer.concat([
          Buffer.from([status]),
          Buffer.from(writeVarLen(len.value)),
          Buffer.from(data),
        ]),
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
export function encodeTrack(events) {
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
export function chunk(content) {
  const head = Buffer.alloc(8)
  head.write('MTrk', 0, 'ascii')
  head.writeUInt32BE(content.length, 4)
  return Buffer.concat([head, content])
}

/** 拆出文件里的所有 MTrk chunk (顺带解出每条的事件) */
export function splitChunks(raw) {
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

/** 构造 SMF 头 (format 1) */
export function smfHeader(trackCount, division) {
  const head = Buffer.alloc(14)
  head.write('MThd', 0, 'ascii')
  head.writeUInt32BE(6, 4)
  head.writeUInt16BE(1, 8) // format 1
  head.writeUInt16BE(trackCount, 10)
  head.writeUInt16BE(division, 12)
  return head
}

/**
 * 拍号 meta 事件 (0x58).
 * 数据固定 4 字节: 分子, 分母的 2 次幂 (dd), 每 metronome click 的 MIDI clock, 每四分音符的 32 分音符数.
 * 长度字节必须写 4, 否则解析器读到的字节会错位 (@tonejs/midi 直接抛 "Unrecognised MIDI event type").
 */
export function timeSignatureEvent(numerator, denominator) {
  const dd = Math.round(Math.log2(denominator))
  return Buffer.from([0xff, 0x58, 0x04, numerator, dd, 0x18, 0x08])
}

/** 调号 meta 事件 (0x59): 1 字节升降号数 (正=升), 1 字节大/小调 (0=大 1=小) */
export function keySignatureEvent(fifths, minor = 1) {
  return Buffer.from([0xff, 0x59, 0x02, fifths & 0xff, minor ? 0x01 : 0x00])
}

/** 速度 meta 事件 (0x51): 每四分音符的微秒数 */
export function tempoEvent(bpm) {
  const us = Math.round(60000000 / bpm)
  return Buffer.from([
    0xff, 0x51, 0x03,
    (us >> 16) & 0xff,
    (us >> 8) & 0xff,
    us & 0xff,
  ])
}

/** 轨道名 meta 事件 (0x03) */
export function trackNameEvent(name) {
  const buf = Buffer.from(name, 'utf8')
  return Buffer.concat([
    Buffer.from([0xff, 0x03]),
    Buffer.from(writeVarLen(buf.length)),
    buf,
  ])
}

/** 结束事件 (0x2f) */
export function endOfTrackEvent() {
  return Buffer.from([0xff, 0x2f, 0x00])
}
