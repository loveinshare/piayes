// 四块屏 1x4 横排串一条链 (2026-11-16 用户手上的接线 —— 线不够长, 只能 1x4).
//
// 钉住 1x4 这个摆法的三件事:
//   1. 一帧 = 512 x 64 (4 块屏 x 128px), 树莓派那边 chain = 2x4 = 8 个模组.
//   2. 画面按屏号从左往右排 —— 1 号屏在帧的最左边, 4 号屏在最右边.
//   3. 自检的纯色帧整条链同一个颜色 —— 哪块屏不亮 = 没接上,
//      哪个像素不亮 = 那个点坏了.
//
// 顺带把渲染结果写成 PNG:
//   artifacts/led-1x4-preview.png     曲子画面 (512x64, 放大 2 倍)
//   artifacts/led-1x4-selfcheck.png   四个纯色帧竖着摞 (红/绿/蓝/白)

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { installCanvasShim, writePng } from './helpers/canvasShim'
import { ScreenRenderer } from '../src/led/screen/ScreenRenderer'
import {
  SCREEN_H,
  SCREEN_W,
  MIDDLE_C_X,
  MIDDLE_C_SCREEN,
} from '../src/led/screen/screenConfig'
import {
  TEST_PATTERN_COLORS,
  solidFrame,
  testPatternIndex,
} from '../src/led/screen/testPattern'

const ART = path.resolve(__dirname, '..', 'artifacts')

/** 一小段假乐谱 —— 左手蓝伴奏 + 右手红旋律, 跨中央 C. */
const song = {
  notes: [
    { midiNote: 48, time: 0.0, duration: 0.5, track: 0, hand: 'left' },
    { midiNote: 52, time: 0.5, duration: 0.5, track: 0, hand: 'left' },
    { midiNote: 55, time: 1.0, duration: 0.5, track: 0, hand: 'left' },
    { midiNote: 60, time: 1.5, duration: 0.5, track: 1, hand: 'right' },
    { midiNote: 64, time: 2.0, duration: 0.5, track: 1, hand: 'right' },
    { midiNote: 67, time: 2.5, duration: 0.5, track: 1, hand: 'right' },
    { midiNote: 72, time: 3.0, duration: 1.0, track: 1, hand: 'right' },
  ],
  hands: { left: 0, right: 1 },
} as never

describe('点阵屏 1x4 横排 (一条菊花链)', () => {
  beforeAll(() => {
    installCanvasShim()
    fs.mkdirSync(ART, { recursive: true })
  })

  it('一帧 = 4 块屏 = 512 x 64', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    // 一个口 (parallel=1) -> 整条链 8 个 64px 模组 = 512px
    const frame = r.extract([1, 2, 3, 4], false, 1)
    expect(frame.length).toBe(512 * 64 * 3)
  })

  it('画面按屏号从左往右排 (1 号屏在帧最左边)', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const frame = r.extract([1, 2, 3, 4], false, 1)
    const at = (x: number, y: number) => {
      const i = (y * 512 + x) * 3
      return [frame[i], frame[i + 1], frame[i + 2]]
    }
    const y = 40
    // 中央 C 的白线在画布 x = MIDDLE_C_X -> 落在第 MIDDLE_C_SCREEN 块屏里
    const mx = Math.round(MIDDLE_C_X)
    expect(at(mx, y)).toEqual([255, 255, 255])
    // 白线**只**在中央 C 那一块屏里 —— 别的屏同一个「屏内位置」不该有白线
    const local = mx - (MIDDLE_C_SCREEN - 1) * SCREEN_W
    for (const s of [1, 2, 3, 4]) {
      if (s === MIDDLE_C_SCREEN) continue
      expect(at((s - 1) * SCREEN_W + local, y)).not.toEqual([255, 255, 255])
    }
  })

  it('上下翻转 = 整帧上下镜像 (行 0 和行 63 换位)', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const normal = r.extract([1, 2, 3, 4], false, 1)
    const flipped = r.extract([1, 2, 3, 4], false, 1, true)
    expect(flipped.length).toBe(normal.length)
    const at = (f: Uint8Array, x: number, y: number) => {
      const i = (y * 512 + x) * 3
      return [f[i], f[i + 1], f[i + 2]]
    }
    for (const [x, y] of [[0, 0], [200, 10], [400, 63], [511, 32]]) {
      expect(at(flipped, x, y)).toEqual(at(normal, x, 63 - y))
    }
  })

  it('分屏分色: 每 128px 一块屏一个固定颜色 (1 红 / 2 绿 / 3 蓝 / 4 白)', () => {
    const r = new ScreenRenderer()
    const frame = r.extractPerScreen([1, 2, 3, 4], false, 1)
    expect(frame.length).toBe(512 * 64 * 3)
    const at = (x: number, y: number) => {
      const i = (y * 512 + x) * 3
      return [frame[i], frame[i + 1], frame[i + 2]]
    }
    const expected = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ]
    expected.forEach((rgb, s) => {
      // 每块屏的四角都得是这个颜色
      for (const [x, y] of [
        [s * 128, 0],
        [s * 128 + 127, 0],
        [s * 128, 63],
        [s * 128 + 127, 63],
        [s * 128 + 64, 32],
      ]) {
        expect(at(x, y)).toEqual(rgb)
      }
    })
  })

  it('自检纯色帧: 整条链 512px 全是同一个颜色', () => {    for (const rgb of TEST_PATTERN_COLORS) {
      const frame = solidFrame(SCREEN_W * 4, SCREEN_H, rgb)
      expect(frame.length).toBe(512 * 64 * 3)
      // 每块屏的中心都得是这个颜色
      for (const s of [0, 1, 2, 3]) {
        const x = s * SCREEN_W + 64
        const i = (32 * 512 + x) * 3
        expect([frame[i], frame[i + 1], frame[i + 2]]).toEqual([...rgb])
      }
      // 四角也得是 —— 边角坏了最容易漏
      expect([frame[0], frame[1], frame[2]]).toEqual([...rgb])
      const last = (512 * 64 - 1) * 3
      expect([frame[last], frame[last + 1], frame[last + 2]]).toEqual([...rgb])
    }
  })

  it('自检颜色按 4 秒轮: 红 -> 绿 -> 蓝 -> 白', () => {
    const order = [0, 4000, 8000, 12000, 16000].map((t) => TEST_PATTERN_COLORS[testPatternIndex(t)])
    expect(order).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
      [255, 0, 0],
    ])
  })

  it('把 1x4 预览和自检图写到 artifacts/', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set([64]),
      transpose: 0,
      noteStates: new Map([[4, 'hit']]),
    })
    const frame = r.extract([1, 2, 3, 4], false, 1)

    // --- 曲子预览: 512x64 放大 2 倍 (1024x128), 每块屏之间画一条缝 ---
    const SCALE = 2
    const GAP = 4
    const pw = 512 * SCALE + GAP * 3
    const ph = 64 * SCALE
    const prev = new Uint8Array(pw * ph * 3)
    for (let s = 0; s < 4; s++) {
      const x0 = s * (128 * SCALE + GAP)
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < 128 * SCALE; x++) {
          const si = (Math.floor(y / SCALE) * 512 + s * 128 + Math.floor(x / SCALE)) * 3
          const di = (y * pw + x0 + x) * 3
          prev[di] = frame[si]
          prev[di + 1] = frame[si + 1]
          prev[di + 2] = frame[si + 2]
        }
      }
    }
    writePng(path.join(ART, 'led-1x4-preview.png'), pw, ph, prev)

    // --- 自检图: 四个纯色帧竖着摞 (512 x 256) ---
    const sw = 512
    const sh = 64 * 4
    const self = new Uint8Array(sw * sh * 3)
    TEST_PATTERN_COLORS.forEach((rgb, idx) => {
      const f = solidFrame(sw, SCREEN_H, rgb)
      for (let y = 0; y < SCREEN_H; y++) {
        for (let x = 0; x < sw; x++) {
          const si = (y * sw + x) * 3
          const di = ((idx * SCREEN_H + y) * sw + x) * 3
          self[di] = f[si]
          self[di + 1] = f[si + 1]
          self[di + 2] = f[si + 2]
        }
      }
    })
    writePng(path.join(ART, 'led-1x4-selfcheck.png'), sw, sh, self)

    expect(fs.existsSync(path.join(ART, 'led-1x4-preview.png'))).toBe(true)
    expect(fs.existsSync(path.join(ART, 'led-1x4-selfcheck.png'))).toBe(true)
  })
})
