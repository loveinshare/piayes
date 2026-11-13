// 点阵屏的渲染结果 (2026-11-11)
//
// 渲染器每帧往画布上画再抠像素 —— jsdom 没画布, 所以这里装一个只支持
// fillRect / strokeRect / getImageData 的替身 (tests/helpers/canvasShim.ts).
//
// 顺带把渲染结果写成 PNG 和原始 RGB ——
//   artifacts/led-screen-preview.png   看得见的预览 (整条虚拟画布 + 3 号屏切片)
//   artifacts/led-screen-screen3.rgb   3 号屏那一帧的原始字节 (拿去推给树莓派)

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { installCanvasShim, writePng } from './helpers/canvasShim'
import { ScreenRenderer } from '../src/led/screen/ScreenRenderer'
import {
  CANVAS_W,
  SCREEN_H,
  SCREEN_W,
  MIDDLE_C_X,
  MIDDLE_C_SCREEN,
  DEFAULT_SCREEN_COLORS,
} from '../src/led/screen/screenConfig'

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

describe('点阵屏渲染', () => {
  beforeAll(() => {
    installCanvasShim()
    fs.mkdirSync(ART, { recursive: true })
  })

  it('一帧 = 选中的屏数 × 128 × 64 × 3 字节', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    expect(r.extract([3]).length).toBe(SCREEN_W * SCREEN_H * 3)
    expect(r.extract([1, 3]).length).toBe(2 * SCREEN_W * SCREEN_H * 3)
    expect(r.extract([1, 2, 3, 4]).length).toBe(4 * SCREEN_W * SCREEN_H * 3)
  })

  it('中央 C 的白线在虚拟画布上, 落在第 2 块屏', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const px = (x: number, y: number) => {
      const d = r.snapshot().data
      const i = (y * CANVAS_W + x) * 4
      return [d[i], d[i + 1], d[i + 2]]
    }
    const mx = Math.round(MIDDLE_C_X)
    // 白线在音符区里 (命中线上方 16px) —— 白线是白的
    expect(px(mx, 40)).toEqual([255, 255, 255])
    // 旁边一格是背景 (深色)
    expect(px(mx + 6, 40)[0]).toBeLessThan(60)
    // 白线所在的那块屏 = 第 2 块 (x 128..255)
    expect(MIDDLE_C_SCREEN).toBe(2)
    expect(mx).toBeGreaterThan(128)
    expect(mx).toBeLessThan(256)
  })

  it('底部键盘: 白键是亮的, 黑键按中央 C 分两半染色', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const d = r.snapshot().data
    const at = (x: number, y: number) => {
      const i = (y * CANVAS_W + x) * 4
      return [d[i], d[i + 1], d[i + 2]]
    }
    // 白键 (中央 C 的键, x=227.8..237.2) 在键盘区里是亮的
    expect(at(232, SCREEN_H - 4)[0]).toBeGreaterThan(200)
    // 黑键现在有颜色了 (以前是纯黑 = 在黑底上等于没画):
    //   C#4 (midi 61, 中央 C 右边) 骑在 x=234..239 -> 粉色
    expect(at(237, SCREEN_H - 12)).toEqual([255, 192, 203])
    //   A#3 (midi 58, 中央 C 左边) 骑在 x=215..220 -> 品红
    expect(at(217, SCREEN_H - 12)).toEqual([255, 0, 255])
  })

  it('琴键区可以关掉 —— 音符区变成整屏 64 行', () => {
    const r = new ScreenRenderer({ keyboardH: 0 })
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const at = (x: number, y: number) => {
      const d = r.snapshot().data
      return d[(y * CANVAS_W + x) * 4]
    }
    // 底部是音符区 (深底), 不是键面
    expect(at(232, SCREEN_H - 4)).toBeLessThan(60)
    // 中央 C 的白线跟着往下移 (下沿落在屏幕底)
    const d = r.snapshot().data
    const i = ((SCREEN_H - 8) * CANVAS_W + Math.round(MIDDLE_C_X)) * 4
    expect([d[i], d[i + 1], d[i + 2]]).toEqual([255, 255, 255])
  })

  it('琴键区高度可变 —— 键面上沿跟着往上/下走', () => {
    const r = new ScreenRenderer({ keyboardH: 8 })
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const at = (x: number, y: number) => {
      const d = r.snapshot().data
      return d[(y * CANVAS_W + x) * 4]
    }
    // 键面从 56 行开始 (64 - 8), 上面一行还是音符区
    expect(at(232, SCREEN_H - 4)).toBeGreaterThan(200)
    expect(at(232, SCREEN_H - 10)).toBeLessThan(60)
  })

  it('音符大小比例 —— 只改长度 (往上长), 不改宽度', () => {
    // ★ 2026-11-13 用户要求: 「音符大小只修改长度比例, 不能改胖瘦」——
    //   比例只乘高度, 宽度还是键宽.
    const oneNote = {
      notes: [{ midiNote: 64, time: 1.0, duration: 1.0, track: 1, hand: 'right' }],
      hands: { left: 0, right: 1 },
    } as never
    const box = (scale: number) => {
      const r = new ScreenRenderer({ noteScale: scale })
      r.render({
        song: oneNote,
        t: 1.0,
        practiceHand: 'both',
        pressed: new Set(),
        transpose: 0,
        noteStates: new Map(),
      })
      const d = r.snapshot().data
      // 只数音符区 (键盘区上方) 里的红像素 —— 右手音是纯红 #ff0000.
      let x0 = Infinity
      let x1 = -Infinity
      let y0 = Infinity
      let y1 = -Infinity
      for (let y = 0; y < SCREEN_H - 16; y++) {
        for (let x = 0; x < CANVAS_W; x++) {
          const i = (y * CANVAS_W + x) * 4
          if (d[i] > 150 && d[i + 1] < 120 && d[i + 2] < 120) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      return { w: x1 - x0 + 1, h: y1 - y0 + 1 }
    }
    const a = box(1)
    const b = box(1.8)
    expect(a.h).toBeGreaterThan(0)
    // 放大 = 变长 (更高)
    expect(b.h).toBeGreaterThan(a.h)
    // 但**不变胖** —— 宽度必须一模一样
    expect(b.w).toBe(a.w)
  })

  it('音符落到线下以后也不会盖住白键', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      // 1.5s 那个音已经过了命中线 —— 以前会盖在白键上, 让白键一闪一闪
      t: 1.7,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const d = r.snapshot().data
    const at = (x: number, y: number) => d[(y * CANVAS_W + x) * 4]
    // 中央 C 那个白键 (x=232) 在键盘区里还是白的, 没被音符盖住
    expect(at(232, SCREEN_H - 12)).toBeGreaterThan(200)
  })

  it('画面翻转 = 整条链左右镜像 (屏序换过来, 每块屏内部的两块模组也换过来)', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const at = (f: Uint8Array, x: number, y: number, nScreens = 1) => {
      const i = (y * SCREEN_W * nScreens + x) * 3
      return [f[i], f[i + 1], f[i + 2]]
    }
    const y = 40 // 中央 C 白线的高度 (hitY-16 .. hitY-1)
    // 一块屏: 中央 C 白线在画布 x=228 -> 2 号屏 (画布 x 128..255) -> 屏内 x=100.
    const one = r.extract([2])
    expect(at(one, 100, y)).toEqual([255, 255, 255])
    expect(at(one, 36, y)).not.toEqual([255, 255, 255])

    // 翻转: 屏内两块模组也换位 -> 屏内 x=100 落到 x=36
    // (模组是「换位」不是「镜像」—— 模组本身没被翻, 只是左右两块换了).
    const oneFlipped = r.extract([2], true)
    expect(at(oneFlipped, 36, y)).toEqual([255, 255, 255])
    expect(at(oneFlipped, 100, y)).not.toEqual([255, 255, 255])

    // 两块屏 (2,3): 屏序也反过来 —— 输出的第一块 = 源里的 3 号屏.
    // 中央 C 在 2 号屏右半块 (画布 x 192..255) -> 翻完落到输出的第二块,
    // 帧内 x = 128 + (228 - 192) = 164.
    const two = r.extract([2, 3], true)
    expect(at(two, SCREEN_W + 36, y, 2)).toEqual([255, 255, 255])
    expect(at(two, SCREEN_W + 100, y, 2)).not.toEqual([255, 255, 255])
  })

  it('翻转时整条链的模组序列整个倒过来', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set(),
      transpose: 0,
      noteStates: new Map(),
    })
    const at = (f: Uint8Array, x: number, y: number) => {
      const i = (y * SCREEN_W * 4 + x) * 3
      return [f[i], f[i + 1], f[i + 2]]
    }
    const y = 40
    // 四块屏. 中央 C 白线在画布 x=228 -> 2 号屏 (画布 x 128..255) -> 屏内 x=100.
    const norm = r.extract([1, 2, 3, 4])
    const flipped = r.extract([1, 2, 3, 4], true)
    expect(at(norm, SCREEN_W + 100, y)).toEqual([255, 255, 255])
    // 翻完: 画布上第 2 块屏的右半块 (x 192..255) 挪到输出的第 3 块屏的**左边**
    // (帧内 x 256..319) —— 所以画布 x=228 -> 帧内 x = 256 + (228-192) = 292.
    expect(at(flipped, 2 * SCREEN_W + 36, y)).toEqual([255, 255, 255])
    // 帧头那块模组 = 画布最右边那块 (插头那端) —— 整条链倒过来了.
    expect(at(flipped, 0, y)).toEqual(at(norm, 3 * SCREEN_W + 64, y))
  })

  it('画面只有调色板里的颜色 —— 没有抗锯齿的灰边', () => {
    // ★ 2026-11-13: 颜色**不再**压成「0 或 100」两档 ——
    //   以前以为混色会闪, 实测闪的根源是刷新率 (94.7Hz -> 已修到 209Hz).
    //   粉色 #ffc0cb 这种混色必须能准确显示出来.
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set([64]),
      transpose: 0,
      noteStates: new Map([[4, 'hit']]),
    })
    const frame = r.extract([2, 3])
    const allowed = new Set(
      [
        '#000000', // 背景
        '#ffffff', // 白键 / 落点白线
        '#ffff00', // 按住的白键
        '#00ffff', // 按住的黑键
        DEFAULT_SCREEN_COLORS.left,
        DEFAULT_SCREEN_COLORS.right,
        DEFAULT_SCREEN_COLORS.hit,
        DEFAULT_SCREEN_COLORS.blackLeft,
        DEFAULT_SCREEN_COLORS.blackRight,
      ].map((c) => c.toLowerCase()),
    )
    const hex = (r0: number, g0: number, b0: number) =>
      '#' + [r0, g0, b0].map((c) => c.toString(16).padStart(2, '0')).join('')
    for (let i = 0; i < frame.length; i += 3) {
      const c = hex(frame[i], frame[i + 1], frame[i + 2])
      expect(allowed.has(c)).toBe(true)
    }
  })

  it('音符下落时**高度不抖** (不会一帧 21 行、下一帧 22 行)', () => {
    // 2026-11-13: 以前 yTop = round(y-h) 和 yBottom = round(y) 各自取整,
    // 两个 round 不同步 → 方块高度在 N / N+1 之间来回跳.
    // 下落 21.8px/s、30fps 下每帧走 0.73px, 也就是**几乎每帧都在抽 1 行** ——
    // 满屏音符一起抽, 看起来就是「整体闪烁」.
    const r = new ScreenRenderer()
    const oneNote = {
      notes: [{ midiNote: 60, time: 1.0, duration: 1.0, track: 1, hand: 'right' }],
      hands: { left: 0, right: 1 },
    } as never
    const col = Math.round(MIDDLE_C_X) + 5 // 音符条中间那一列
    const heights: number[] = []
    for (let k = 0; k < 12; k++) {
      r.render({
        song: oneNote,
        t: 0.3 + k / 30,
        practiceHand: 'both',
        pressed: new Set(),
        transpose: 0,
        noteStates: new Map(),
      })
      const d = r.snapshot().data
      let n = 0
      // 只数音符区 (键盘区上方)
      for (let y = 0; y < SCREEN_H - 16; y++) {
        if (d[(y * CANVAS_W + col) * 4] > 150) n++
      }
      heights.push(n)
    }
    expect(heights[0]).toBeGreaterThan(10)
    expect(new Set(heights).size).toBe(1)
  })

  it('把预览图和原始帧写到 artifacts/', () => {
    const r = new ScreenRenderer()
    r.render({
      song,
      t: 2.0,
      practiceHand: 'both',
      pressed: new Set([64]),
      transpose: 0,
      // 4 号音 (E4) 此刻正好落在键盘上沿 —— 标成命中, 预览里看得见
      noteStates: new Map([[4, 'hit']]),
    })
    const snap = r.snapshot()
    // 一块屏时翻转没有区别 (屏序反转 = 自己) —— 就按正常顺序出.
    const frame = r.extract([3])

    fs.writeFileSync(path.join(ART, 'led-screen-screen3.rgb'), Buffer.from(frame))

    // 预览图: 上半 = 整条虚拟画布 (×2), 下半 = 3 号屏切片 (×4)
    const W = CANVAS_W * 2
    const topH = SCREEN_H * 2
    const botH = SCREEN_H * 4
    const H = topH + 8 + botH
    const out = new Uint8Array(W * H * 3)
    const put = (x: number, y: number, r0: number, g0: number, b0: number) => {
      const i = (y * W + x) * 3
      out[i] = r0
      out[i + 1] = g0
      out[i + 2] = b0
    }
    for (let y = 0; y < topH; y++) {
      for (let x = 0; x < W; x++) {
        const i = (Math.floor(y / 2) * CANVAS_W + Math.floor(x / 2)) * 4
        put(x, y, snap.data[i], snap.data[i + 1], snap.data[i + 2])
      }
    }
    for (let y = 0; y < botH; y++) {
      for (let x = 0; x < SCREEN_W * 4; x++) {
        const i = (Math.floor(y / 4) * SCREEN_W + Math.floor(x / 4)) * 3
        put(x, topH + 8 + y, frame[i], frame[i + 1], frame[i + 2])
      }
    }
    writePng(path.join(ART, 'led-screen-preview.png'), W, H, out)
    expect(fs.existsSync(path.join(ART, 'led-screen-preview.png'))).toBe(true)
  })
})
