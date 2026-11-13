// 抢先模式的灯带差分 (spec §R23)
//
// 抢先模式的主灯带不是「按时间扫事件流」(那是 LedScanCursor), 而是
// 「按状态驱动」: 上层每帧算出该亮哪几个音, 跟上一帧比, 只发改动的.
//
// 提示是**按手**的 (左手一份 / 右手一份) —— 两只手各弹各的.
// 灯位按 **(midi, 手)** 记 —— 同键双手各占一个灯位.
//
// 这里测差分函数的纯逻辑 —— 不用起浏览器, 不用连灯带.

import { describe, it, expect } from 'vitest'
import { diffLeadHints, type LeadHint } from '../src/led/leadStrip'
import type { SongNote } from '../src/types'

function n(time: number, midi: number, hand?: 'left' | 'right'): SongNote {
  return { time, duration: 0.5, midiNote: midi, track: 0, hand, velocity: 0.8 }
}

/** 一份提示 —— 每只手一份 */
function hint(
  hands: { hand: 'left' | 'right'; time: number; notes: SongNote[] }[],
): LeadHint {
  return { hands }
}

describe('抢先模式灯带差分 (diffLeadHints)', () => {
  it('第一帧 (prev=null) → 整组都点亮', () => {
    const { on, off } = diffLeadHints(
      null,
      hint([{ hand: 'right', time: 2.0, notes: [n(2.0, 60), n(2.0, 64)] }]),
    )
    expect(on.map((x) => x.midi)).toEqual([60, 64])
    expect(off).toEqual([])
  })

  it('换组 → 旧的全灭, 新的全亮', () => {
    const prev = hint([{ hand: 'right', time: 1.0, notes: [n(1.0, 60)] }])
    const next = hint([{ hand: 'right', time: 2.0, notes: [n(2.0, 62)] }])
    const { on, off } = diffLeadHints(prev, next)
    expect(on.map((x) => x.midi)).toEqual([62])
    expect(off.map((x) => x.midi)).toEqual([60])
  })

  it('提示没了 (next=null) → 全部灭掉', () => {
    const { on, off } = diffLeadHints(
      hint([{ hand: 'right', time: 1.0, notes: [n(1.0, 60)] }]),
      null,
    )
    expect(on).toEqual([])
    expect(off.map((x) => x.midi)).toEqual([60])
  })

  it('同一个 midi 在两组里都有 → 不灭不点 (灯位一直亮着)', () => {
    const prev = hint([{ hand: 'right', time: 1.0, notes: [n(1.0, 60, 'right')] }])
    const next = hint([{ hand: 'right', time: 2.0, notes: [n(2.0, 60, 'right')] }])
    const { on, off } = diffLeadHints(prev, next)
    expect(on).toEqual([])
    expect(off).toEqual([])
  })

  it('同一个 midi 换了手 → 灭旧的 + 点新的 (两个灯位, 灯色跟手走)', () => {
    const prev = hint([{ hand: 'left', time: 1.0, notes: [n(1.0, 60, 'left')] }])
    const next = hint([{ hand: 'right', time: 2.0, notes: [n(2.0, 60, 'right')] }])
    const { on, off } = diffLeadHints(prev, next)
    expect(on.map((x) => x.hand)).toEqual(['right'])
    expect(off.map((x) => x.hand)).toEqual(['left'])
  })

  it('同键双手同时待弹 → 两个灯位, 都亮 (各占各的)', () => {
    const h = hint([
      { hand: 'left', time: 1.0, notes: [n(1.0, 60, 'left')] },
      { hand: 'right', time: 1.0, notes: [n(1.0, 60, 'right')] },
    ])
    const { on, off } = diffLeadHints(null, h)
    expect(on.map((x) => `${x.hand}${x.midi}`)).toEqual(['left60', 'right60'])
    expect(off).toEqual([])
  })

  it('一只手推进了 → 另一只手的灯不动', () => {
    const prev = hint([
      { hand: 'left', time: 1.0, notes: [n(1.0, 48, 'left')] },
      { hand: 'right', time: 1.0, notes: [n(1.0, 60, 'right')] },
    ])
    const next = hint([
      { hand: 'left', time: 1.0, notes: [n(1.0, 48, 'left')] },
      { hand: 'right', time: 2.0, notes: [n(2.0, 62, 'right')] },
    ])
    const { on, off } = diffLeadHints(prev, next)
    expect(on.map((x) => x.midi)).toEqual([62])
    expect(off.map((x) => x.midi)).toEqual([60])
  })

  it('和弦 (同一时刻两个音) → 一起亮, 一起灭', () => {
    const prev = hint([
      { hand: 'right', time: 1.0, notes: [n(1.0, 60, 'right'), n(1.0, 64, 'right')] },
    ])
    const next = hint([{ hand: 'right', time: 2.0, notes: [n(2.0, 67, 'right')] }])
    const { on, off } = diffLeadHints(prev, next)
    expect(on.map((x) => x.midi)).toEqual([67])
    expect(off.map((x) => x.midi)).toEqual([60, 64])
  })

  it('两边都是 null → 什么都不做', () => {
    const { on, off } = diffLeadHints(null, null)
    expect(on).toEqual([])
    expect(off).toEqual([])
  })
})
