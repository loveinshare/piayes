// 键盘导航 (← / → / ↑ / ↓) 纯函数测试
//
// 用例覆盖:
//  1. → 在右手 note 之间逐个跳
//  2. ← 反向跳, 跳过左手 note (按右手计)
//  3. 已是最前/最后 → 返回 null
//  4. ↑ / ↓ 在小节之间跳
//  5. 边界: 空 song / 空 measures / 未标 hand (视为右手)

import { describe, it, expect } from 'vitest'
import {
  findAdjacentRightNoteTime,
  findAdjacentMeasureTime,
  findAdjacentNoteTime,
  findAdjacentActiveNoteTime,
  notesAt,
} from '../src/util/navigation'
import type { Song, SongNote } from '../src/types'

function makeSong(notes: SongNote[]): Song {
  return {
    notes,
    measures: [
      { number: 1, time: 0, duration: 4 },
      { number: 2, time: 4, duration: 4 },
      { number: 3, time: 8, duration: 4 },
    ],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 12,
    ppq: 480,
    hands: { left: 0, right: 0 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
  }
}
const n = (time: number, hand: 'left' | 'right' | undefined = 'right') =>
  ({ time, duration: 0.5, midiNote: 60, track: 0, velocity: 0.8, hand }) as SongNote

// =============================================================================
describe('findAdjacentRightNoteTime', () => {
  it('→ 在右手 note 之间逐个跳', () => {
    const song = makeSong([n(1.0), n(2.0), n(3.0)])
    expect(findAdjacentRightNoteTime(song, 0, 1)).toBe(1.0)
    expect(findAdjacentRightNoteTime(song, 1.5, 1)).toBe(2.0)
    expect(findAdjacentRightNoteTime(song, 2.5, 1)).toBe(3.0)
  })

  it('← 反向跳', () => {
    const song = makeSong([n(1.0), n(2.0), n(3.0)])
    expect(findAdjacentRightNoteTime(song, 2.5, -1)).toBe(2.0)
    expect(findAdjacentRightNoteTime(song, 1.5, -1)).toBe(1.0)
  })

  it('跳过左手 note (按右手计)', () => {
    const song = makeSong([n(1.0, 'right'), n(1.5, 'left'), n(2.0, 'right'), n(2.5, 'left'), n(3.0, 'right')])
    expect(findAdjacentRightNoteTime(song, 1.6, 1)).toBe(2.0)
    expect(findAdjacentRightNoteTime(song, 1.6, -1)).toBe(1.0)
    // 1.0 < 1.6 之后第一个右手 = 2.0, 不是 1.5
    expect(findAdjacentRightNoteTime(song, 0, 1)).toBe(1.0)
  })

  it('未标 hand 视为右手 (单 track pitch-split 模式)', () => {
    const song = makeSong([n(1.0, undefined), n(2.0, undefined)])
    expect(findAdjacentRightNoteTime(song, 0, 1)).toBe(1.0)
  })

  it('已是最前/最后 → null', () => {
    const song = makeSong([n(1.0), n(2.0)])
    expect(findAdjacentRightNoteTime(song, 3.0, 1)).toBe(null)
    expect(findAdjacentRightNoteTime(song, 0.5, -1)).toBe(null)
  })

  it('空 notes → null', () => {
    const song = makeSong([])
    expect(findAdjacentRightNoteTime(song, 1.0, 1)).toBe(null)
  })
})

// =============================================================================
describe('findAdjacentNoteTime (任意 note, 含左手)', () => {
  it('→ 在所有 note 之间逐个跳 (含左手)', () => {
    const song = makeSong([n(1.0, 'right'), n(1.5, 'left'), n(2.0, 'right')])
    expect(findAdjacentNoteTime(song, 0, 1)).toBe(1.0)
    expect(findAdjacentNoteTime(song, 1.0, 1)).toBe(1.5) // 下一个是左手
    expect(findAdjacentNoteTime(song, 1.5, 1)).toBe(2.0)
  })

  it('← 反向跳, 含左手', () => {
    const song = makeSong([n(1.0, 'right'), n(1.5, 'left'), n(2.0, 'right')])
    expect(findAdjacentNoteTime(song, 2.0, -1)).toBe(1.5)
    expect(findAdjacentNoteTime(song, 1.5, -1)).toBe(1.0)
  })

  it('已是最前/最后 → null', () => {
    const song = makeSong([n(1.0), n(2.0)])
    expect(findAdjacentNoteTime(song, 2.5, 1)).toBe(null)
    expect(findAdjacentNoteTime(song, 0.5, -1)).toBe(null)
  })

  it('空 notes → null', () => {
    const song = makeSong([])
    expect(findAdjacentNoteTime(song, 1.0, 1)).toBe(null)
  })
})

// =============================================================================
describe('findAdjacentMeasureTime', () => {
  it('↓ 跳到下一小节', () => {
    const song = makeSong([])
    expect(findAdjacentMeasureTime(song, 0, 1)).toBe(4)
    expect(findAdjacentMeasureTime(song, 4.5, 1)).toBe(8)
  })

  it('↑ 反向跳', () => {
    const song = makeSong([])
    expect(findAdjacentMeasureTime(song, 8.5, -1)).toBe(8)
    expect(findAdjacentMeasureTime(song, 5, -1)).toBe(4)
  })

  it('越界 → null', () => {
    const song = makeSong([])
    expect(findAdjacentMeasureTime(song, 100, 1)).toBe(null)
    expect(findAdjacentMeasureTime(song, 0, -1)).toBe(null)
  })

  it('空 measures → null', () => {
    const song = { ...makeSong([]), measures: [] }
    expect(findAdjacentMeasureTime(song, 1, 1)).toBe(null)
  })
})

// =============================================================================
describe('notesAt (跳转后预览用)', () => {
  it('返回 t 附近 window 秒内的所有 note, 按 time 排序', () => {
    const song = makeSong([n(1.0), n(1.05), n(1.2), n(2.0), n(0.5)])
    const out = notesAt(song, 1.0, 0.1)
    expect(out.map((n) => n.time)).toEqual([1.0, 1.05]) // 1.2 / 2.0 / 0.5 在 window 外
  })

  it('空 song → 空数组', () => {
    expect(notesAt(makeSong([]), 1.0, 0.5)).toEqual([])
  })

  it('window=0 → 只有 time 严格相等的', () => {
    const song = makeSong([n(1.0), n(1.001), n(1.1)])
    const out = notesAt(song, 1.0, 0)
    expect(out.map((n) => n.time)).toEqual([1.0])
  })
})

// =============================================================================
// findAdjacentActiveNoteTime (←/→ 默认走的那个)
//
// 回归: 之前直接用 isActiveHand 过滤, 而 isActiveHand 对 'playback' 返回 false
// → playback 模式下 ←/→ 完全失灵 (只有 Shift+←/→ 还能用).
// 另一个回归: 单轨曲 (hands.left === hands.right) 且 note 没标 hand 时,
// 旧逻辑一律判成 'left' → right 模式下所有 note 都不 active → ←/→ 也失灵.
// =============================================================================
describe('findAdjacentActiveNoteTime', () => {
  it('playback 模式: 所有 note 都能跳到 (←/→ 不失灵)', () => {
    const song = makeSong([n(1.0, 'right'), n(2.0, 'right'), n(3.0, 'right')])
    expect(findAdjacentActiveNoteTime(song, 0, 1, 'playback')).toBe(1.0)
    expect(findAdjacentActiveNoteTime(song, 2.0, 1, 'playback')).toBe(3.0)
    expect(findAdjacentActiveNoteTime(song, 2.0, -1, 'playback')).toBe(1.0)
  })

  it('right 模式: 跳过 left 的 note', () => {
    const song = makeSong([n(1.0, 'right'), n(1.5, 'left'), n(2.0, 'right')])
    expect(findAdjacentActiveNoteTime(song, 0, 1, 'right')).toBe(1.0)
    expect(findAdjacentActiveNoteTime(song, 1.0, 1, 'right')).toBe(2.0)
    expect(findAdjacentActiveNoteTime(song, 2.0, -1, 'right')).toBe(1.0)
  })

  it('both 模式: 全部都能跳到', () => {
    const song = makeSong([n(1.0, 'right'), n(1.5, 'left'), n(2.0, 'right')])
    expect(findAdjacentActiveNoteTime(song, 0, 1, 'both')).toBe(1.0)
    expect(findAdjacentActiveNoteTime(song, 1.0, 1, 'both')).toBe(1.5)
  })

  it('单轨曲 + note 没标 hand: right 模式下也能跳到 (不再一律判成 left)', () => {
    const song = makeSong([n(1.0, undefined), n(2.0, undefined)])
    expect(findAdjacentActiveNoteTime(song, 0, 1, 'right')).toBe(1.0)
    expect(findAdjacentActiveNoteTime(song, 1.0, 1, 'right')).toBe(2.0)
    expect(findAdjacentActiveNoteTime(song, 2.0, -1, 'right')).toBe(1.0)
  })

  it('已是边界 → null', () => {
    const song = makeSong([n(1.0, 'right')])
    expect(findAdjacentActiveNoteTime(song, 0, -1, 'right')).toBe(null)
    expect(findAdjacentActiveNoteTime(song, 2.0, 1, 'right')).toBe(null)
  })

  it('空 notes → null', () => {
    expect(findAdjacentActiveNoteTime(makeSong([]), 0, 1, 'right')).toBe(null)
  })
})
