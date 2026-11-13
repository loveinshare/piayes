// LED 配色方案 (C / D) + 预告行亮度等比阶梯 + 当前音呼吸.
//
// 钉住三件事:
//   1. 两套预设的 8 个色跟用户给的值**一模一样** (灯带配色是肉眼调的, 不能漂).
//   2. 预告行的亮度阶梯是**等比数列** —— 3 个音时中间那个 = √(最亮×最暗).
//   3. 上灯带用「预告行」配色, 主灯带用「当前行」配色 —— 两排不混.

import { describe, it, expect } from 'vitest'
import {
  SCHEME_C,
  SCHEME_D,
  FAST_BPM_THRESHOLD,
  autoScheme,
  hexRgb,
  ledLevelLadder,
} from '../src/led/schemes'
import { LedController } from '../src/led/LedController'
import type { LedTransport } from '../src/led/LedTransport'

// ---------------------------------------------------------------------------
// 假传输层
// ---------------------------------------------------------------------------

function fakeTransport(setManyShows = true) {
  const pixels = new Map<number, [number, number, number]>()
  const transport: LedTransport = {
    name: 'fake',
    connected: true,
    setManyShows,
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

// ---------------------------------------------------------------------------
// 颜色小工具 (HSV 的 H / S + 相对亮度)
// ---------------------------------------------------------------------------

function hueOf(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  if (max === r) return (60 * (((g - b) / d) % 6) + 360) % 360
  if (max === g) return 60 * ((b - r) / d + 2)
  return 60 * ((r - g) / d + 4)
}

function hueDist(a: [number, number, number], b: [number, number, number]): number {
  const d = Math.abs(hueOf(a) - hueOf(b)) % 360
  return d > 180 ? 360 - d : d
}

function satOf(rgb: [number, number, number]): number {
  const max = Math.max(...rgb)
  const min = Math.min(...rgb)
  return max === 0 ? 0 : (max - min) / max
}

function lumOf(rgb: [number, number, number]): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
}

// ---------------------------------------------------------------------------
// 1. 配色预设
// ---------------------------------------------------------------------------

describe('LED 配色方案', () => {
  it('方案 C 的 8 个色跟用户给的值一致 (用户在灯带上自己调出来的)', () => {
    expect(SCHEME_C.current).toEqual({
      leftWhite: hexRgb('#1E1EFF'),
      leftBlack: hexRgb('#4169E1'),
      rightWhite: hexRgb('#FF0000'),
      rightBlack: hexRgb('#C8102E'),
    })
    expect(SCHEME_C.upcoming).toEqual({
      leftWhite: hexRgb('#006AFF'),
      leftBlack: hexRgb('#11FF00'),
      rightWhite: hexRgb('#FF0000'),
      rightBlack: hexRgb('#FF0033'),
    })
    expect(SCHEME_C.pulse).toBe(0.06)
  })

  it('方案 D 的 8 个色跟用户给的值一致', () => {
    expect(SCHEME_D.current).toEqual({
      leftWhite: hexRgb('#1F5FFF'),
      leftBlack: hexRgb('#73E6FF'),
      rightWhite: hexRgb('#D81E3F'),
      rightBlack: hexRgb('#FF8AD8'),
    })
    expect(SCHEME_D.upcoming).toEqual({
      leftWhite: hexRgb('#3F78C8'),
      leftBlack: hexRgb('#9FD8F0'),
      rightWhite: hexRgb('#B93A63'),
      rightBlack: hexRgb('#F29AD0'),
    })
    expect(SCHEME_D.pulse).toBe(0.08)
  })

  it('方案 C 的右手是红色系 —— 白键纯红, 黑键深红/玫红, 都不是粉', () => {
    const w = hueOf(SCHEME_C.current.rightWhite) // #FF0000 → 0°
    const b = hueOf(SCHEME_C.current.rightBlack) // #C8102E → ~350°
    expect(w).toBeLessThan(15)
    expect(b).toBeGreaterThanOrEqual(340)
    expect(b).toBeLessThanOrEqual(360)
    // 粉 = 品红区间 (300~340) —— 不能再往粉里偏
    expect(w >= 300 && w < 340).toBe(false)
    expect(b >= 300 && b < 340).toBe(false)
    // 黑键跟白键不是一个色 (深红 vs 纯红) —— LED 看的是峰值通道
    expect(SCHEME_C.current.rightBlack).not.toEqual(SCHEME_C.current.rightWhite)
    expect(Math.max(...SCHEME_C.current.rightBlack)).toBeLessThan(
      Math.max(...SCHEME_C.current.rightWhite),
    )
    // 上灯带的右手: 纯红 + 玫红 (#FF0033, ~348°), 同样不是粉
    const uw = hueOf(SCHEME_C.upcoming.rightWhite)
    const ub = hueOf(SCHEME_C.upcoming.rightBlack)
    expect(uw).toBeLessThan(15)
    expect(ub).toBeGreaterThanOrEqual(340)
    expect(ub >= 300 && ub < 340).toBe(false)
  })

  it('方案 C 的左手: 主灯带是蓝系 (正蓝/品蓝), 上灯带是亮蓝/纯绿', () => {
    const lw = hueOf(SCHEME_C.current.leftWhite)
    const lb = hueOf(SCHEME_C.current.leftBlack)
    expect(lw).toBeGreaterThanOrEqual(230)
    expect(lw).toBeLessThanOrEqual(250)
    expect(lb).toBeGreaterThanOrEqual(215)
    expect(lb).toBeLessThanOrEqual(235)
    // 白键更「正」(饱和度更高), 黑键偏品蓝更柔
    expect(satOf(SCHEME_C.current.leftWhite)).toBeGreaterThan(satOf(SCHEME_C.current.leftBlack))
    // 上灯带: 左白 = 亮蓝 (#006AFF, ~215°), 左黑 = 纯绿 (#11FF00, ~116°)
    const uw = hueOf(SCHEME_C.upcoming.leftWhite)
    const ub = hueOf(SCHEME_C.upcoming.leftBlack)
    expect(uw).toBeGreaterThanOrEqual(200)
    expect(uw).toBeLessThanOrEqual(230)
    expect(ub).toBeGreaterThanOrEqual(90)
    expect(ub).toBeLessThanOrEqual(140)
  })

  it('方案 D 的右手黑键跟白键色相拉开 ≥ 15° (高分离度保留)', () => {
    // 旧配色是橙 (#FF1E00, 色相 ~11°) —— 跟红 (352°) 只差 19°, 快速下会糊.
    expect(hueDist(SCHEME_D.current.rightBlack, SCHEME_D.current.rightWhite)).toBeGreaterThanOrEqual(15)
  })

  it('左手黑键保持冷色 (跟左手白键同色系, 明度更高)', () => {
    expect(lumOf(SCHEME_C.current.leftBlack)).toBeGreaterThan(lumOf(SCHEME_C.current.leftWhite))
    expect(lumOf(SCHEME_D.current.leftBlack)).toBeGreaterThan(lumOf(SCHEME_D.current.leftWhite))
  })

  it('两排配色不同 —— 上灯带不是主灯带的复制', () => {
    for (const s of [SCHEME_C, SCHEME_D]) {
      const same = (Object.keys(s.current) as Array<keyof typeof s.current>).every(
        (k) =>
          s.current[k][0] === s.upcoming[k][0] &&
          s.current[k][1] === s.upcoming[k][1] &&
          s.current[k][2] === s.upcoming[k][2],
      )
      expect(same).toBe(false)
    }
  })

  it('方案 D 的预告行仍然降饱和 (C 是用户手调的, 层次靠亮度不靠饱和度)', () => {
    expect(satOf(SCHEME_D.upcoming.rightWhite)).toBeLessThan(satOf(SCHEME_D.current.rightWhite))
    expect(satOf(SCHEME_D.upcoming.leftWhite)).toBeLessThan(satOf(SCHEME_D.current.leftWhite))
  })
})

// ---------------------------------------------------------------------------
// 2. 自动选方案
// ---------------------------------------------------------------------------

describe('autoScheme', () => {
  it('快 → D, 慢 → C', () => {
    expect(autoScheme(FAST_BPM_THRESHOLD).id).toBe('d')
    expect(autoScheme(FAST_BPM_THRESHOLD + 40).id).toBe('d')
    expect(autoScheme(FAST_BPM_THRESHOLD - 1).id).toBe('c')
    expect(autoScheme(0).id).toBe('c')
  })
})

// ---------------------------------------------------------------------------
// 3. 预告行亮度阶梯 (等比数列)
// ---------------------------------------------------------------------------

describe('ledLevelLadder — 预告行亮度等比阶梯', () => {
  it('3 个音 → 中间那个是等比中项 √(最亮×最暗)', () => {
    const l = ledLevelLadder(0.88, 0.46, 3)
    expect(l[0]).toBeCloseTo(0.88)
    expect(l[2]).toBeCloseTo(0.46)
    expect(l[1]).toBeCloseTo(Math.sqrt(0.88 * 0.46))
  })

  it('1 个音 → 取最亮 (那就是在最近的音)', () => {
    expect(ledLevelLadder(0.88, 0.46, 1)).toEqual([0.88])
  })

  it('相邻两项的比值相同 —— 等比数列', () => {
    const l = ledLevelLadder(0.88, 0.46, 5)
    expect(l).toHaveLength(5)
    const ratios = l.slice(1).map((v, i) => v / l[i])
    for (const r of ratios) expect(r).toBeCloseTo(ratios[0], 6)
  })

  it('最低不能比最高亮 (反了就压下来)', () => {
    const l = ledLevelLadder(0.4, 0.9, 3)
    expect(l[0]).toBeCloseTo(0.4)
    expect(l[2]).toBeCloseTo(0.4)
    expect(l[1]).toBeCloseTo(0.4)
  })

  it('全部夹在 0..1', () => {
    expect(ledLevelLadder(2, -1, 4).every((v) => v >= 0 && v <= 1)).toBe(true)
  })

  it('0 个音 → 空数组', () => {
    expect(ledLevelLadder(0.88, 0.46, 0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. 控制器: 上灯带用预告行配色 / 当前音呼吸
// ---------------------------------------------------------------------------

describe('LedController · 预告行配色 + 呼吸', () => {
  it('上灯带用「预告行」配色, 主灯带用「当前行」配色', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, dualStrip: true })
    led.setColors(SCHEME_C.current)
    led.setUpcomingColors(SCHEME_C.upcoming)

    // 右手白键 C5 (MIDI 72) —— 主带 [102,104), 上带 [248,250)
    led.noteOn(72, 'right')
    led.setUpperHints([{ midi: 72, hand: 'right', level: 1 }])
    await tick()

    const main = pixels.get(102)
    const upper = pixels.get(248)
    expect(main).toBeDefined()
    expect(upper).toBeDefined()
    // 两排颜色不一样 (当前行是纯色, 预告行是降饱和的)
    expect(main).not.toEqual(upper)
    // 当前行 = 纯绯红
    expect(main![0]).toBeGreaterThan(main![1])
    expect(main![1]).toBeLessThan(80)
  })

  it('呼吸: 幅度不为 0 时亮度会随时间起伏, 但色相不变', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.setColors(SCHEME_C.current)
    led.setPulse(0.1)
    led.noteOn(72, 'right')
    await tick()
    const before = pixels.get(102)!

    // 走到相位峰值 (四分之一个周期 → sin = 1)
    led.tickPulse(350)
    await tick()
    const after = pixels.get(102)!

    expect(after[0]).not.toBe(before[0])
    // 明度变了 → 绿色/蓝色通道按同比例走 (色相不变, 只有取整误差)
    const ratioBefore = before[1] / before[0]
    const ratioAfter = after[1] / after[0]
    expect(ratioAfter).toBeCloseTo(ratioBefore, 2)
  })

  it('呼吸幅度 0 → tickPulse 不产生任何流量', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport })
    led.noteOn(72, 'right')
    await tick()
    const snapshot = new Map(pixels)
    led.tickPulse(50)
    await tick()
    expect([...pixels.entries()]).toEqual([...snapshot.entries()])
  })
})
