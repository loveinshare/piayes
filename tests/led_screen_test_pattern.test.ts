// 点阵屏自检图案 (2026-11-16 用户要求: 四块屏挨个查坏点).
//
// 钉住三件事:
//   1. 颜色按 红 -> 绿 -> 蓝 -> 白 轮, 每个停 4 秒
//   2. 纯色帧的每个字节都是那个颜色 (整片同色, 有一个点不一样就是坏了)
//   3. 帧宽 = 链上有几块屏就有几块屏那么宽 (4 块 = 512px)

import { describe, it, expect } from 'vitest'
import {
  TEST_PATTERN_COLORS,
  TEST_PATTERN_PERIOD_MS,
  testPatternIndex,
  solidFrame,
} from '../src/led/screen/testPattern'
import { SCREEN_W, SCREEN_H } from '../src/led/screen/screenConfig'

describe('点阵屏自检图案', () => {
  it('颜色顺序: 红 -> 绿 -> 蓝 -> 白', () => {
    expect(TEST_PATTERN_COLORS).toEqual([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
    ])
  })

  it('每个颜色停 4 秒, 然后轮下一个', () => {
    expect(TEST_PATTERN_PERIOD_MS).toBe(4000)
    // 0ms ~ 3999ms 都是红色
    expect(testPatternIndex(0)).toBe(0)
    expect(testPatternIndex(3999)).toBe(0)
    // 4 秒 -> 绿色
    expect(testPatternIndex(4000)).toBe(1)
    expect(testPatternIndex(7999)).toBe(1)
    // 8 秒 -> 蓝色, 12 秒 -> 白色
    expect(testPatternIndex(8000)).toBe(2)
    expect(testPatternIndex(12000)).toBe(3)
    // 16 秒 -> 回到红色
    expect(testPatternIndex(16000)).toBe(0)
  })

  it('非法输入不炸 (负数 / NaN / Infinity -> 第一个颜色)', () => {
    expect(testPatternIndex(-5)).toBe(0)
    expect(testPatternIndex(NaN)).toBe(0)
    expect(testPatternIndex(Infinity)).toBe(0)
  })

  it('纯色帧: 每个字节都是那个颜色', () => {
    const frame = solidFrame(SCREEN_W, SCREEN_H, [255, 0, 0])
    expect(frame.length).toBe(SCREEN_W * SCREEN_H * 3)
    for (let i = 0; i < frame.length; i += 3) {
      expect(frame[i]).toBe(255)
      expect(frame[i + 1]).toBe(0)
      expect(frame[i + 2]).toBe(0)
    }
  })

  it('四块屏 1x4 串一条链 -> 帧宽 512px', () => {
    const frame = solidFrame(SCREEN_W * 4, SCREEN_H, [0, 255, 0])
    expect(frame.length).toBe(512 * 64 * 3)
    // 整条链同一个颜色 —— 每隔 128px 的地方也该是绿的 (也就是每块屏都一样)
    for (const screen of [0, 1, 2, 3]) {
      const x = screen * SCREEN_W + 64
      const off = (32 * 512 + x) * 3
      expect(frame[off]).toBe(0)
      expect(frame[off + 1]).toBe(255)
      expect(frame[off + 2]).toBe(0)
    }
  })
})
