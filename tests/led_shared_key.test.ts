// 两只手弹**同一个键**时灯不能互相抢 (巴赫 BWV 1041 小提琴协奏曲).
//
// 伴奏弦乐跟小提琴**同度齐奏**: 同一时刻、同一个 midi, 右手一个 note,
// 左手一个 note —— 但物理上只有**一个像素**.
//
// 旧实现: 游标按 midi 记账 → 左手那个 note 开灯时把右手的灯位抢过去,
// 先发右手的灭灯 → 右手的灯"闪一下就灭" (只开右手灯时最明显: 左手被关掉,
// 没人接管那盏灯 → 直接黑掉).
//
// 现在: 游标按 (midi, 手) 记账 → 两只手是两个灯位, 互不抢占.

import { describe, it, expect } from 'vitest'
import { LedController } from '../src/led/LedController'
import { LedFollower } from '../src/led/LedFollower'
import { LedScanCursor } from '../src/led/scanCursor'
import { stripRange } from '../src/led/dualStrip'
import type { LedTransport } from '../src/led/LedTransport'
import type { SongNote } from '../src/types'

function fakeTransport() {
  const pixels = new Map<number, [number, number, number]>()
  const transport: LedTransport = {
    name: 'fake',
    connected: true,
    setManyShows: false,
    async connect() {},
    disconnect() {},
    async send(op, args) {
      if (op === 'set_many') {
        for (const px of args.pixels ?? []) pixels.set(px.i, [px.r, px.g, px.b])
      }
      if (op === 'off') pixels.clear()
    },
  }
  return { transport, pixels }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 主灯带上这个键亮不亮 (有非黑像素就算亮). */
function litAt(pixels: Map<number, [number, number, number]>, note: number): boolean {
  const rng = stripRange(note)!
  for (let i = rng[0]; i < rng[1]; i++) {
    const c = pixels.get(i)
    if (c && (c[0] || c[1] || c[2])) return true
  }
  return false
}

function note(midiNote: number, time: number, hand: 'left' | 'right', track: number): SongNote {
  return { midiNote, time, duration: 0.3, track, hand }
}

/**
 * 齐奏: 右手 (小提琴) 和左手 (弦乐) 同一时刻弹同一个键.
 * 音符数组按 parseMidi 的排序来 —— 同刻时**轨道 0 在前**.
 */
function unisonSong(): SongNote[] {
  return [
    note(76, 0.5, 'right', 0), // 小提琴
    note(69, 0.5, 'left', 1), // 弦乐
    note(72, 0.5, 'left', 1),
    note(76, 0.5, 'left', 1), // 弦乐跟小提琴同度
    note(79, 1.0, 'right', 0), // 下一组
  ]
}

/** 游标 → follower → 控制器 (跟 App 里 pre-scanner 的接法一样). */
function wire(notes: SongNote[]) {
  const { transport, pixels } = fakeTransport()
  const led = new LedController({ transport, count: 176, brightness: 1 })
  const follower = new LedFollower({ led, isEnabled: () => true, offGraceMs: 0 })
  const cursor = new LedScanCursor(notes)
  const advanceTo = (tSec: number) => {
    cursor.advance(tSec * 1000, 0, (idx, on) => {
      const n = notes[idx]
      follower.handleEvent({
        type: on ? 'down' : 'up',
        midi: n.midiNote,
        velocity: 100,
        t: 0,
        source: 'playback',
        hand: n.hand,
      })
    })
  }
  return { led, follower, pixels, advanceTo }
}

describe('两只手同键齐奏 (BWV 1041 协奏) · 灯位按 (midi, 手) 记账', () => {
  it('只开右手灯: 右手的灯整组亮着, 不会被左手同刻的 note 灭掉', async () => {
    const { led, follower, pixels, advanceTo } = wire(unisonSong())
    led.setHandEnabled('left', false)
    await tick()

    advanceTo(0.5)
    await tick()
    // 右手的 76 亮着 (左手那个同刻的 76 被关掉了, 但不能把右手的带走)
    expect(litAt(pixels, 76)).toBe(true)

    // 换组 (t=1.0) → 上一组全灭
    advanceTo(1.0)
    await tick()
    expect(litAt(pixels, 76)).toBe(false)
    expect(litAt(pixels, 79)).toBe(true)
    void follower
  })

  it('两只手都开: 同键齐奏时灯亮着 (不会被"灭灯事件"提前灭掉)', async () => {
    const { pixels, advanceTo } = wire(unisonSong())

    advanceTo(0.5)
    await tick()
    expect(litAt(pixels, 76)).toBe(true)

    advanceTo(1.0)
    await tick()
    expect(litAt(pixels, 76)).toBe(false)
  })

  it('关掉左手后再点亮 (重画) → 右手的灯还在', async () => {
    const { led, follower, pixels, advanceTo } = wire(unisonSong())
    advanceTo(0.5)
    await tick()
    expect(litAt(pixels, 76)).toBe(true)

    // 重画 (改亮度 / 开关某只手的灯 都会触发) —— 用左手的手色重画不能把右手的灯吃掉
    led.setHandEnabled('left', false)
    follower.setHandEnabled('left', false)
    await tick()
    expect(litAt(pixels, 76)).toBe(true)
  })
})

// =============================================================================
// 2026-11-10: 同键两手 —— 一只手松了 / 被关掉, 不能误伤另一只手
// =============================================================================
describe('同键两手: 手的粒度 (2026-11-10)', () => {
  /** 直接走 follower → 控制器 (不经过 pre-scanner). */
  function wire2() {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 176, brightness: 1 })
    const follower = new LedFollower({ led, isEnabled: () => true, offGraceMs: 0 })
    const down = (midi: number, hand: 'left' | 'right') =>
      follower.handleEvent({ type: 'down', midi, velocity: 100, t: 0, source: 'playback', hand })
    const up = (midi: number, hand: 'left' | 'right') =>
      follower.handleEvent({ type: 'up', midi, t: 0, source: 'playback', hand })
    return { led, follower, pixels, down, up }
  }

  it('左手松手 → 右手还按着 → 灯别整个灭掉', async () => {
    const { pixels, down, up } = wire2()
    down(76, 'right')
    down(76, 'left')
    await tick()
    expect(litAt(pixels, 76)).toBe(true)

    up(76, 'left') // 左手松了, 右手还按着
    await tick()
    expect(litAt(pixels, 76)).toBe(true)

    up(76, 'right') // 两只手都松了 → 灯灭
    await tick()
    expect(litAt(pixels, 76)).toBe(false)
  })

  it('关掉左手 → 右手的灯不受影响; 开回来能恢复', async () => {
    const { follower, pixels, down } = wire2()
    down(76, 'right')
    down(76, 'left')
    await tick()
    expect(litAt(pixels, 76)).toBe(true)

    follower.setHandEnabled('left', false)
    await tick()
    expect(litAt(pixels, 76)).toBe(true) // 右手的灯还在

    follower.setHandEnabled('left', true)
    await tick()
    expect(litAt(pixels, 76)).toBe(true) // 开回来 → 重画 → 两只手的灯都在
  })
})
