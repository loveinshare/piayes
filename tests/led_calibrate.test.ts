// 校准模式 = **调色预览**.
//
// 点亮 4 个位置, 各显示一种颜色:
//   左手白键 / 左手黑键 (切分点左边) + 右手白键 / 右手黑键 (右边)
// 主灯带用「当前行」配色, 上灯带 (双色带) 用「预告行」配色, 亮度跟系统亮度走.
//
// 旧行为: 中央 C + 上下各两个键, **全是白的** —— 看不出配色对不对.

import { describe, it, expect } from 'vitest'
import { LedController } from '../src/led/LedController'
import { SCHEME_C } from '../src/led/schemes'
import type { LedTransport } from '../src/led/LedTransport'

// ---------------------------------------------------------------------------
// 假传输层
// ---------------------------------------------------------------------------

function fakeTransport() {
  const pixels = new Map<number, [number, number, number]>()
  const transport: LedTransport = {
    name: 'fake',
    connected: true,
    setManyShows: true,
    async connect() {},
    disconnect() {},
    async send(op, args) {
      if (op === 'set_many') {
        for (const px of args.pixels ?? []) {
          pixels.set(px.i, [px.r, px.g, px.b])
        }
      }
      if (op === 'off') pixels.clear()
    },
  }
  return { transport, pixels }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// 切分点 = 60 (中央 C) 时的 4 个校准位置:
//   左手白 53 (F3)  → LED 64,65      左手黑 51 (D#3) → LED 60,61
//   右手白 67 (G4)  → LED 92,93      右手黑 68 (G#4) → LED 94,95
const LEFT_WHITE = 64
const LEFT_BLACK = 60
const RIGHT_WHITE = 92
const RIGHT_BLACK = 94

const MAIN_INDICES = [60, 61, 64, 65, 92, 93, 94, 95]
// 上灯带 (chain 176..351, 物理位置跟主带对齐): 256,257 / 258,259 / 286,287 / 290,291
const UPPER_INDICES = [256, 257, 258, 259, 286, 287, 290, 291]

describe('校准模式 (调色预览)', () => {
  it('点亮 4 个位置: 左手白/黑 在左, 右手白/黑 在右', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setCalibrate(true)
    await tick()
    expect([...pixels.keys()].sort((a, b) => a - b)).toEqual(MAIN_INDICES)
  })

  it('每个位置显示各自的颜色 (不是全白)', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setColors(SCHEME_C.current)
    led.setCalibrate(true)
    await tick()
    expect(pixels.get(LEFT_WHITE)).toEqual([...SCHEME_C.current.leftWhite])
    expect(pixels.get(LEFT_BLACK)).toEqual([...SCHEME_C.current.leftBlack])
    expect(pixels.get(RIGHT_WHITE)).toEqual([...SCHEME_C.current.rightWhite])
    expect(pixels.get(RIGHT_BLACK)).toEqual([...SCHEME_C.current.rightBlack])
    // 左手是蓝系, 右手是红系 —— 两边一眼能分
    expect(pixels.get(LEFT_WHITE)![2]).toBeGreaterThan(pixels.get(LEFT_WHITE)![0])
    expect(pixels.get(RIGHT_WHITE)![0]).toBeGreaterThan(pixels.get(RIGHT_WHITE)![2])
  })

  it('亮度跟着系统亮度走', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, brightness: 0.5 })
    led.setColors(SCHEME_C.current)
    led.setCalibrate(true)
    await tick()
    expect(pixels.get(LEFT_WHITE)).toEqual([
      Math.round(SCHEME_C.current.leftWhite[0] * 0.5),
      Math.round(SCHEME_C.current.leftWhite[1] * 0.5),
      Math.round(SCHEME_C.current.leftWhite[2] * 0.5),
    ])
  })

  it('改亮度 → 校准灯跟着重画', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setColors(SCHEME_C.current)
    led.setCalibrate(true)
    await tick()
    expect(pixels.get(RIGHT_WHITE)).toEqual([...SCHEME_C.current.rightWhite])
    led.setBrightness(0.5)
    await tick()
    expect(pixels.get(RIGHT_WHITE)).toEqual([
      Math.round(SCHEME_C.current.rightWhite[0] * 0.5),
      Math.round(SCHEME_C.current.rightWhite[1] * 0.5),
      Math.round(SCHEME_C.current.rightWhite[2] * 0.5),
    ])
  })

  it('改自定义颜色 → 校准灯跟着重画 (调色预览的核心)', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setCalibrate(true)
    await tick()
    const before = pixels.get(RIGHT_WHITE)!
    led.setColors({ rightWhite: [1, 2, 3] })
    await tick()
    expect(pixels.get(RIGHT_WHITE)).toEqual([1, 2, 3])
    expect(before).not.toEqual([1, 2, 3])
  })

  it('切分点变了 → 校准位置跟着换边', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setCalibrate(true)
    await tick()
    expect([...pixels.keys()].sort((a, b) => a - b)).toEqual(MAIN_INDICES)
    // 切分点挪到 48 → 左手只剩更靠左的键
    led.setSplit(48)
    await tick()
    const after = [...pixels.keys()].sort((a, b) => a - b)
    expect(after).not.toEqual(MAIN_INDICES)
    expect(after.every((i) => i !== undefined)).toBe(true)
  })

  it('关掉 → 全部熄灭, 不留残灯', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setCalibrate(true)
    await tick()
    expect(pixels.size).toBeGreaterThan(0)
    led.setCalibrate(false)
    await tick()
    expect([...pixels.values()].every((p) => p[0] === 0 && p[1] === 0 && p[2] === 0)).toBe(true)
  })

  it('关掉之后改亮度/改颜色 → 不会把校准灯点亮回来', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setCalibrate(true)
    await tick()
    led.setCalibrate(false)
    await tick()
    led.setBrightness(0.2)
    led.setColors({ rightWhite: [9, 9, 9] })
    await tick()
    expect([...pixels.values()].every((p) => p[0] === 0 && p[1] === 0 && p[2] === 0)).toBe(true)
  })

  it('双色带 → 上灯带亮「预告行」配色', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    led.setColors(SCHEME_C.current)
    led.setUpcomingColors(SCHEME_C.upcoming)
    led.setCalibrate(true)
    await tick()
    await tick()
    const upper = [...pixels.keys()].filter((i) => i >= 176).sort((a, b) => a - b)
    expect(upper).toEqual(UPPER_INDICES)
    // 上灯带的右手白键 (LED 258) 用预告行的色
    expect(pixels.get(258)).toEqual([...SCHEME_C.upcoming.rightWhite])
    // 上灯带的右手黑键 (LED 256) 用预告行的玫红, 不是当前行的深红
    expect(pixels.get(256)).toEqual([...SCHEME_C.upcoming.rightBlack])
    expect(pixels.get(256)).not.toEqual([...SCHEME_C.current.rightBlack])
  })

  it('双色带 → 关掉校准, 上灯带的校准灯也跟着灭', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true })
    led.setCalibrate(true)
    await tick()
    await tick()
    led.setCalibrate(false)
    await tick()
    await tick()
    expect([...pixels.values()].every((p) => p[0] === 0 && p[1] === 0 && p[2] === 0)).toBe(true)
  })
})
