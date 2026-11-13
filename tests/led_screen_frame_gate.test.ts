// 点阵屏推帧闸门 (src/led/screen/frameGate.ts) 的单元测试 (2026-11-13)
//
// 钉住三条:
//   1. 发送缓冲积压超过 N 帧 -> 丢当前帧 (不许排队);
//   2. 画面跟上一帧逐字节一样 -> 跳过, 但保活间隔到了要补发;
//   3. 背压优先于内容 —— 缓冲满的时候连「补发帧」也不发.

import { describe, it, expect } from 'vitest'
import {
  MAX_BUFFERED_FRAMES,
  KEEPALIVE_MS,
  bufferedTooMuch,
  framesEqual,
  shouldSendFrame,
} from '../src/led/screen/frameGate'

const FRAME = 128 * 64 * 3 // 24576 字节 = 一块屏

function frame(fill: number): Uint8Array {
  return new Uint8Array(FRAME).fill(fill)
}

describe('推帧闸门', () => {
  it('缓冲里一帧都没有 -> 不拦', () => {
    expect(bufferedTooMuch(0, FRAME)).toBe(false)
    expect(bufferedTooMuch(FRAME - 1, FRAME)).toBe(false)
  })

  it('正好积压 1 帧还不算超 (边界是 >, 不是 >=)', () => {
    expect(bufferedTooMuch(FRAME, FRAME)).toBe(false)
    expect(bufferedTooMuch(FRAME + 1, FRAME)).toBe(true)
  })

  it('默认只容忍 1 帧的积压', () => {
    expect(MAX_BUFFERED_FRAMES).toBe(1)
    expect(bufferedTooMuch(FRAME * 2, FRAME, 2)).toBe(false)
    expect(bufferedTooMuch(FRAME * 2 + 1, FRAME, 2)).toBe(true)
  })

  it('帧长还不知道 (0) 的时候不拦 —— 宁发勿丢', () => {
    expect(bufferedTooMuch(999999, 0)).toBe(false)
    expect(bufferedTooMuch(999999, Number.NaN)).toBe(false)
  })

  it('逐字节比较: 一样才相等', () => {
    const a = frame(1)
    expect(framesEqual(a, a)).toBe(true)
    expect(framesEqual(a, frame(1))).toBe(true)
    expect(framesEqual(a, frame(2))).toBe(false)
    expect(framesEqual(a, new Uint8Array(FRAME))).toBe(false)
    expect(framesEqual(a, null)).toBe(false)
    expect(framesEqual(null, null)).toBe(true)
    // 长度不同
    expect(framesEqual(a, new Uint8Array(FRAME - 3))).toBe(false)
  })

  it('第一帧一定发 (还没有「上一帧」可比)', () => {
    expect(shouldSendFrame(null, 0, 1000, frame(1), 0)).toBe(true)
  })

  it('画面没变 -> 跳过 (省带宽, 也少让树莓派忙)', () => {
    const f = frame(1)
    expect(shouldSendFrame(f, 1000, 1000 + 33, f, 0)).toBe(false)
    expect(shouldSendFrame(f, 1000, 1000 + KEEPALIVE_MS - 1, f, 0)).toBe(false)
  })

  it('画面没变但保活时间到了 -> 补发一帧', () => {
    const f = frame(1)
    expect(shouldSendFrame(f, 1000, 1000 + KEEPALIVE_MS, f, 0)).toBe(true)
  })

  it('画面变了 -> 立刻发, 不等保活', () => {
    expect(shouldSendFrame(frame(1), 1000, 1001, frame(2), 0)).toBe(true)
  })

  it('缓冲积压 -> 丢帧 (即使画面变了)', () => {
    expect(shouldSendFrame(frame(1), 1000, 1001, frame(2), FRAME * 2)).toBe(false)
  })

  it('背压优先于保活 —— 缓冲满时连补发帧也不发', () => {
    const f = frame(1)
    expect(shouldSendFrame(f, 1000, 1000 + KEEPALIVE_MS * 10, f, FRAME * 2)).toBe(false)
  })

  it('缓冲排空之后立刻恢复发送', () => {
    const f = frame(1)
    expect(shouldSendFrame(f, 1000, 2000, f, 0)).toBe(true)
  })
})
