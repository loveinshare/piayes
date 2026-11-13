// 双色带模式 —— 上灯带显示左右手各自的「下一个音」.
//
// 钉住三件事:
//   1. **补偿换算**: 第二条带是反着接的 (接缝在最右), 但两条带的**物理位置
//      必须对齐** —— A0 在两条带上都对应最左边, C8 都对应最右边 (接缝).
//   2. **亮度**: 上灯带 = 主灯带亮度 × 比例 (默认 70%).
//   3. **增量下发**: 提示没变就不发包; allOff / 重连之后能自愈点亮.

import { describe, it, expect } from 'vitest'
import { LedController, DEFAULT_LED_COLORS } from '../src/led/LedController'
import { stripRange, upperRange, NextNoteIndex, LEDS_PER_STRIP, UPPER_LEVEL_FALLOFF } from '../src/led/dualStrip'
import type { LedTransport } from '../src/led/LedTransport'
import type { Song, SongNote } from '../src/types'

// ---------------------------------------------------------------------------
// 假传输层: 只记录发出去的命令
// ---------------------------------------------------------------------------

interface Sent {
  op: string
  args: Record<string, any>
}

function fakeTransport(setManyShows = false) {
  const sent: Sent[] = []
  const pixels = new Map<number, [number, number, number]>()
  const transport: LedTransport = {
    name: 'fake',
    connected: true,
    setManyShows,
    async connect() {},
    disconnect() {},
    async send(op, args) {
      sent.push({ op, args })
      if (op === 'set_many') {
        for (const px of args.pixels ?? []) {
          pixels.set(px.i, [px.r, px.g, px.b])
        }
      }
      if (op === 'off') pixels.clear()
    },
  }
  return { transport, sent, pixels }
}

/** 所有 set_many 里的像素 (按下标排序). */
function setManyPixels(sent: Sent[]): Array<{ i: number; r: number; g: number; b: number }> {
  const out: Array<{ i: number; r: number; g: number; b: number }> = []
  for (const s of sent) {
    if (s.op !== 'set_many') continue
    for (const px of s.args.pixels ?? []) out.push(px)
  }
  return out
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------------------
// 1. 索引映射 (补偿换算)
// ---------------------------------------------------------------------------

describe('双色带 · 索引映射', () => {
  it('主灯带: 88 键 × 2 LED, A0 在最左, C8 在最右 (区间左闭右开)', () => {
    expect(stripRange(21)).toEqual([0, 2]) // A0
    expect(stripRange(108)).toEqual([174, 176]) // C8
    expect(stripRange(60)).toEqual([78, 80]) // 中央 C
    expect(stripRange(20)).toBeNull()
    expect(stripRange(109)).toBeNull()
  })

  it('上灯带: 第二条带反着接 —— 但补偿后物理位置跟主带对齐', () => {
    // A0 = 物理最左 → 上带也是最左 (chain 350,351)
    expect(upperRange(21)).toEqual([350, 352])
    // C8 = 物理最右 (接缝) → 上带也是最右 (chain 176,177)
    expect(upperRange(108)).toEqual([176, 178])
    // 中央 C
    expect(upperRange(60)).toEqual([272, 274])
  })

  it('上灯带的区间全在 176..351 段里, 且跟主带一一对应 (88 个键全覆盖)', () => {
    const seen = new Set<number>()
    for (let note = 21; note <= 108; note++) {
      const up = upperRange(note)!
      const main = stripRange(note)!
      expect(up[0]).toBeGreaterThanOrEqual(LEDS_PER_STRIP)
      expect(up[1]).toBeLessThanOrEqual(LEDS_PER_STRIP * 2)
      // 物理位置对齐: 主带的第 x 颗 ↔ 上带的第 (351-x) 颗
      for (let x = main[0]; x < main[1]; x++) {
        const u = LEDS_PER_STRIP * 2 - 1 - x
        expect(u).toBeGreaterThanOrEqual(up[0])
        expect(u).toBeLessThan(up[1])
        seen.add(u)
      }
    }
    expect(seen.size).toBe(352 - LEDS_PER_STRIP)
  })
})

// ---------------------------------------------------------------------------
// 2. NextNoteIndex —— 下一个音
// ---------------------------------------------------------------------------

function songOf(notes: SongNote[], hands = { left: 0, right: 1 }): Song {
  return {
    notes, measures: [], bpms: [{ time: 0, bpm: 120 }], duration: 60, ppq: 480,
    hands, timeSignature: { numerator: 4, denominator: 4 }, source: 'midi',
  }
}

function note(midiNote: number, time: number, track = 0, hand?: 'left' | 'right'): SongNote {
  return { midiNote, time, duration: 0.5, track, hand }
}

describe('双色带 · NextNoteIndex', () => {
  it('左右手各取自己的下一个音', () => {
    const song = songOf([
      note(60, 1, 0, 'left'),
      note(72, 2, 1, 'right'),
      note(62, 3, 0, 'left'),
      note(74, 4, 1, 'right'),
    ])
    const idx = new NextNoteIndex(song, 60)

    expect(idx.at(0).left[0]?.midiNote).toBe(60)
    expect(idx.at(0).right[0]?.midiNote).toBe(72)
    expect(idx.at(1).left[0]?.midiNote).toBe(62) // 左手 1 秒那个已经过去了
    expect(idx.at(3).right[0]?.midiNote).toBe(74)
  })

  it('正在响的音不算「下一个」 (严格晚于当前时刻)', () => {
    const song = songOf([note(60, 10, 0, 'left'), note(62, 12, 0, 'left')])
    const idx = new NextNoteIndex(song, 60)
    expect(idx.at(10).left[0]?.midiNote).toBe(62)
    expect(idx.at(9.99).left[0]?.midiNote).toBe(60)
  })

  it('来回 seek 不会错 (无状态游标)', () => {
    const song = songOf([note(60, 2, 0, 'left'), note(62, 10, 0, 'left')])
    const idx = new NextNoteIndex(song, 60)
    expect(idx.at(10).left).toEqual([]) // 没有下一个了
    // 回到 2 秒 → 下一个是 10 秒那个
    expect(idx.at(2).left[0]?.midiNote).toBe(62)
    // seek 回 1 秒 → 又应该看到 2 秒那个
    expect(idx.at(1).left[0]?.midiNote).toBe(60)
  })

  it('单轨谱 (分不出左右手) 按 pitchSplit 兜底', () => {
    // hands.left === hands.right → resolveHand 返回 undefined
    const song = songOf(
      [note(48, 1, 0), note(72, 2, 0)],
      { left: 0, right: 0 },
    )
    const idx = new NextNoteIndex(song, 60)
    expect(idx.at(0).left[0]?.midiNote).toBe(48) // 48 < 60 → 左手
    expect(idx.at(0).right[0]?.midiNote).toBe(72) // 72 >= 60 → 右手
  })

  it('空谱返回空数组', () => {
    const idx = new NextNoteIndex(songOf([]), 60)
    expect(idx.at(0)).toEqual({ left: [], right: [] })
  })

  it('每只手各取 N 个 (用户 2026-10-31: 每只手各 N 个)', () => {
    const song = songOf([
      note(60, 1, 0, 'left'),
      note(62, 2, 0, 'left'),
      note(64, 3, 0, 'left'),
      note(72, 1.5, 1, 'right'),
      note(74, 2.5, 1, 'right'),
    ])
    const idx = new NextNoteIndex(song, 60)

    const three = idx.at(0, 3)
    expect(three.left.map((n) => n.midiNote)).toEqual([60, 62, 64])
    expect(three.right.map((n) => n.midiNote)).toEqual([72, 74])

    // 取 fewer 个 → 只给前几个
    expect(idx.at(0, 1).left.map((n) => n.midiNote)).toEqual([60])
    // 取比现有的多 → 有几个给几个
    expect(idx.at(0, 9).left.map((n) => n.midiNote)).toEqual([60, 62, 64])
  })
})

// ---------------------------------------------------------------------------
// 3. LedController —— 上灯带
// ---------------------------------------------------------------------------

describe('双色带 · LedController 上灯带', () => {
  it('提示落在 176..351 段, 颜色 = baseColor × 亮度 × 比例', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({
      transport, count: 352, dualStrip: true, brightness: 1, upperBrightnessRatio: 0.7,
    })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()

    const px = setManyPixels(sent)
    expect(px.map((p) => p.i)).toEqual([272, 273]) // 中央 C 在上带的位置
    // 左手白键 = 蓝 (0,0,200) × 0.7 → (0,0,140)
    expect(px[0]).toEqual({ i: 272, r: 0, g: 0, b: 140 })
    expect(px[1]).toEqual({ i: 273, r: 0, g: 0, b: 140 })
  })

  it('主灯带亮度也参与相乘 (上灯带 = 主灯 × 比例)', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({
      transport, count: 352, dualStrip: true, brightness: 0.5, upperBrightnessRatio: 0.7,
    })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    // 蓝 200 × 0.5 × 0.7 = 70
    expect(setManyPixels(sent)[0].b).toBe(70)
  })

  it('右手提示用右手色 (红)', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true, brightness: 1 })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'right' }])
    await tick()
    // 右手白键 = 红 (200,0,0) × 0.7 (默认比例)
    expect(setManyPixels(sent)[0]).toEqual({ i: 272, r: 140, g: 0, b: 0 })
  })

  it('提示没变 → 不再发包 (增量下发)', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }, { midi: 72, hand: 'right' }])
    await tick()
    const after = sent.length
    led.setUpperHints([{ midi: 60, hand: 'left' }, { midi: 72, hand: 'right' }])
    led.setUpperHints([{ midi: 60, hand: 'left' }, { midi: 72, hand: 'right' }])
    await tick()
    expect(sent.length).toBe(after)
  })

  it('提示变了 → 只发差量 (旧的灭, 新的亮)', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    sent.length = 0

    led.setUpperHints([{ midi: 72, hand: 'right' }])
    await tick()
    const px = setManyPixels(sent)
    const oldIdx = upperRange(60)!
    const newIdx = upperRange(72)!
    // 旧的那两颗灭掉
    const oldPx = px.filter((p) => p.i >= oldIdx[0] && p.i < oldIdx[1])
    expect(oldPx.length).toBe(2)
    expect(oldPx.every((p) => p.r === 0 && p.g === 0 && p.b === 0)).toBe(true)
    // 新的那两颗亮起
    expect(px.filter((p) => p.i >= newIdx[0] && p.i < newIdx[1]).length).toBe(2)
  })

  it('改比例 → 上灯带重画', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({
      transport, count: 352, dualStrip: true, brightness: 1, upperBrightnessRatio: 0.7,
    })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    sent.length = 0

    led.setUpperBrightnessRatio(1)
    await tick()
    const px = setManyPixels(sent)
    expect(px.length).toBe(2)
    expect(px[0].b).toBe(200) // 蓝 200 × 1.0
  })

  it('clearUpperHints → 上灯带全灭', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)

    led.clearUpperHints()
    await tick()
    expect([...pixels.values()].every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)).toBe(true)
  })

  it('allOff 之后: 上灯带会自愈回来 (allOff 只是物理清零)', async () => {
    // allOff() = 「物理清零」, 语义跟主灯带一样 (恢复播放 / 换歌都走它),
    // 所以上层再下发同样的提示 → 上灯带重新点亮.
    // 「清完就熄着」的是曲终 (clearUpperHints) 和跑马灯 —— 见下面两个用例.
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)

    await led.allOff()
    expect(pixels.size).toBe(0)

    // 上层再下发同样的提示 → 自愈点亮
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)
  })

  it('clearUpperHints → 上灯带全灭 (上层不再下发提示时)', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)

    // 灭灯是「写 0」不是「删键」—— 断言颜色全灭 (跟已有用例一个写法)
    const allDark = () => [...pixels.values()].every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)

    led.clearUpperHints()
    await tick()
    expect(allDark()).toBe(true)
    // 上层不再下发 → 保持熄灭 (没有残留)
    led.setUpperHints([])
    await tick()
    expect(allDark()).toBe(true)
  })

  it('clearUpperHints 之后: 上层重新下发提示 → 重新点亮 (新的显式请求)', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)

    led.clearUpperHints()
    await tick()
    // 上层又给了提示 → 点回来
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)
    expect(pixels.get(272)).toEqual([0, 0, 140])
  })

  it('切歌: 旧提示清掉 → 新提示点亮 (上层重新下发)', async () => {
    // App 切歌的顺序: clearUpperHints() (旧歌的提示没了) → allOff() (物理清零)
    // → setUpperHints(新歌的提示). 清完不能「熄着」—— 新歌的提示要点亮.
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)

    led.clearUpperHints()
    await led.allOff()
    await tick()

    led.setUpperHints([{ midi: 72, hand: 'right' }])
    await tick()
    expect(pixels.size).toBe(2)
    expect(pixels.get(upperRange(72)![0])).toEqual([140, 0, 0])
  })

  it('跑马灯测试之后: 上灯带不残留', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)

    await led.testPattern()
    expect(pixels.size).toBe(0)

    // 跑完后上层继续每 50ms 下发同样的提示 → 上灯带不该自己回来
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(0)

    // 提示内容真的变了 (下一个音推进了) → 重新点亮
    led.setUpperHints([{ midi: 64, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)
    expect(pixels.get(264)).toEqual([0, 0, 140])
  })

  it('重连之后上灯带会重新点亮 (设备端是空的)', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    await led.allOff()

    await led.connect()
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(pixels.size).toBe(2)
    expect(pixels.get(272)).toEqual([0, 0, 140])
  })

  it('单灯带模式: 上灯带提示不写任何像素', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({ transport, count: 176 })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left' }])
    await tick()
    expect(setManyPixels(sent)).toEqual([])
  })

  it('主灯带不受影响 (noteOn 还是 78/79)', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.noteOn(60, 'left')
    await tick()
    const px = setManyPixels(sent)
    expect(px.map((p) => p.i)).toEqual([78, 79])
    expect(px[0].b).toBe(200) // 主灯带不打折
  })

  it('默认配色跟老实现一致 (左手蓝 / 右手红)', () => {
    expect(DEFAULT_LED_COLORS.leftWhite).toEqual([0, 0, 200])
    expect(DEFAULT_LED_COLORS.rightWhite).toEqual([200, 0, 0])
  })

  // ── 亮度递减 (用户 2026-10-31: 每往后一个 ×0.65) ──────────────────

  it('提示带 level → 颜色按 level 变暗', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({
      transport, count: 352, dualStrip: true, brightness: 1, upperBrightnessRatio: 1,
    })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([
      { midi: 60, hand: 'left', level: 1 },
      { midi: 62, hand: 'left', level: UPPER_LEVEL_FALLOFF },
    ])
    await tick()

    const px = setManyPixels(sent)
    // 第 1 个 = 满亮 (蓝 200), 第 2 个 = 200 × 0.65 = 130
    expect(px.find((p) => p.i === upperRange(60)![0])).toEqual({ i: 272, r: 0, g: 0, b: 200 })
    expect(px.find((p) => p.i === upperRange(62)![0])).toEqual({ i: 268, r: 0, g: 0, b: 130 })
  })

  it('同一个音高出现多次 → 只留最亮的那个', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({
      transport, count: 352, dualStrip: true, brightness: 1, upperBrightnessRatio: 1,
    })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    // 接下来的两个音都是 C4: 第一个亮, 第二个暗 → 同一个键, 留亮的
    led.setUpperHints([
      { midi: 60, hand: 'left', level: 1 },
      { midi: 60, hand: 'left', level: UPPER_LEVEL_FALLOFF },
    ])
    await tick()

    const px = setManyPixels(sent)
    expect(px.find((p) => p.i === upperRange(60)![0])).toEqual({ i: 272, r: 0, g: 0, b: 200 })
  })

  it('level 变了 → 算「内容变了」→ 重画 (远处的音挪到前面时亮度要更新)', async () => {
    const { transport, sent } = fakeTransport()
    const led = new LedController({
      transport, count: 352, dualStrip: true, brightness: 1, upperBrightnessRatio: 1,
    })
    // 预告行配色显式设成跟主灯带一样 (这几个用例测的是亮度/比例, 不是配色)
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([{ midi: 60, hand: 'left', level: 1 }])
    await tick()
    sent.length = 0

    // 同一个音, 但从「第 1 个」挪到「第 2 个」→ 亮度变了 → 必须重画
    led.setUpperHints([{ midi: 60, hand: 'left', level: UPPER_LEVEL_FALLOFF }])
    await tick()
    const px = setManyPixels(sent)
    expect(px.length).toBe(2)
    expect(px[0].b).toBe(130)
  })
})
