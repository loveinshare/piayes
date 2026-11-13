// LED 点阵屏的几何换算 (2026-11-11)
//
// 这些数字是**物理对齐**的基础 —— 屏幕贴到琴上时, 屏幕上的像素位置
// 必须跟真实琴键一一对应. 错了就是「灯亮在别的键上」.
//
// 关键结论: 中央 C 在**第 2 块屏** (用户自己猜的也是第 2 块).

import { describe, it, expect } from 'vitest'
import {
  SCREEN_W,
  SCREEN_H,
  CANVAS_W,
  MAX_SCREENS,
  WHITE_KEY_W,
  WHITE_KEY_COUNT,
  MARGIN_X,
  MIDDLE_C_X,
  MIDDLE_C_SCREEN,
  MIDDLE_C_KEY_INDEX,
  NOTE_AREA_H,
  HIT_LINE_Y,
  KEYBOARD_H,
  SCREEN_PPS,
  MIN_HORIZON,
  screenOfX,
  screenX0,
} from '../src/led/screen/screenConfig'
import { whiteKeyIndex, totalWhiteKeys, MIDI_MIN, MIDI_MAX } from '../src/render/colors'

describe('点阵屏画布', () => {
  it('一块屏 = 128x64 (320x160mm @2.5mm 点距), 四块 = 512x64', () => {
    expect(SCREEN_W).toBe(128)
    expect(SCREEN_H).toBe(64)
    expect(MAX_SCREENS).toBe(4)
    expect(CANVAS_W).toBe(512)
  })

  it('52 个白键, 白键 9.4px (真实 23.5mm ÷ 2.5mm), 左右各余 11.6px', () => {
    expect(totalWhiteKeys(MIDI_MIN, MIDI_MAX)).toBe(52)
    expect(WHITE_KEY_COUNT).toBe(52)
    expect(WHITE_KEY_W).toBeCloseTo(9.4, 6)
    expect(MARGIN_X).toBeCloseTo(11.6, 3)
    // 键盘正好居中
    expect(MARGIN_X * 2 + WHITE_KEY_COUNT * WHITE_KEY_W).toBeCloseTo(CANVAS_W, 6)
  })

  it('中央 C = 第 23 个白键, x ≈ 227.8, 落在第 2 块屏', () => {
    expect(MIDDLE_C_KEY_INDEX).toBe(whiteKeyIndex(60))
    expect(MIDDLE_C_KEY_INDEX).toBe(23)
    expect(MIDDLE_C_X).toBeCloseTo(227.8, 3)
    expect(MIDDLE_C_SCREEN).toBe(2)
    expect(screenOfX(MIDDLE_C_X)).toBe(2)
  })

  it('每块屏的左边缘', () => {
    expect(screenX0(1)).toBe(0)
    expect(screenX0(2)).toBe(128)
    expect(screenX0(3)).toBe(256)
    expect(screenX0(4)).toBe(384)
    expect(screenOfX(0)).toBe(1)
    expect(screenOfX(511)).toBe(4)
  })
})

describe('点阵屏的纵向布局', () => {
  it('键盘 16 行 + 音符区 48 行 = 64 行', () => {
    expect(KEYBOARD_H).toBe(16)
    expect(NOTE_AREA_H).toBe(48)
    expect(NOTE_AREA_H + KEYBOARD_H).toBe(SCREEN_H)
  })

  it('命中线就在键盘上沿', () => {
    expect(HIT_LINE_Y).toBe(NOTE_AREA_H)
  })

  it('预读时间不少于 2.2 秒 (跟网页的 MIN_HORIZON 一致)', () => {
    const horizon = NOTE_AREA_H / SCREEN_PPS
    expect(horizon).toBeGreaterThanOrEqual(MIN_HORIZON - 1e-9)
    expect(SCREEN_PPS).toBeCloseTo(NOTE_AREA_H / MIN_HORIZON, 6)
  })
})
