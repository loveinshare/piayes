// LED pre-scanner 游标测试 (spec P1-15)
//
// 覆盖:
//  - 事件排序: 灭灯时刻不随下标单调, 必须先排好序
//  - offset 平移: 提前量只平移开灯; 负提前量 (延后) 整段平移
//  - 灯的寿命 = 音条在画面上的寿命 (note.time + NOTE_BAR_LIFETIME_S),
//    **不**跟音符的发声时值走, 也不跟用户按没按有关
//  - 亮度: 提前量窗口里渐亮 → 落键 100% → 弹过减半
//  - reset: seek 回退后能重走一遍

import { describe, it, expect } from 'vitest'
import { LedScanCursor, PLAYED_LEVEL, RAMP_START_LEVEL, quantizeLevel } from '../src/led/scanCursor'
import { NOTE_BAR_LIFETIME_S } from '../src/types'
import type { SongNote } from '../src/types'

function n(time: number, duration: number, midi = 60): SongNote {
  return { time, duration, midiNote: midi, track: 0, hand: 'right', velocity: 0.8 }
}

describe('LedScanCursor', () => {
  it('开灯/灭灯事件按时刻排序, 灭灯时刻不随下标单调', () => {
    // note0 长音 (0~10s), note1 短音 (1~2s).
    // 灯的寿命跟**音条**走 (0.5s), 不跟发声时值走 → note0 在 0.5s 就灭.
    const cursor = new LedScanCursor([n(0, 10), n(1, 1)])
    const seen: [number, boolean][] = []
    cursor.advance(20000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      // 0.5s: 音条从画面上消失 → 灭
      [0, false],
      [1, true],
      // 1.5s: note1 的音条消失 → 灭
      [1, false],
    ])
  })

  it('灭灯时刻 = 落键 + 音条寿命 (不跟发声时值走)', () => {
    // 一个 10 秒的长音: 灯只亮 0.5 秒 (音条在画面上就那么久).
    const cursor = new LedScanCursor([n(0, 10)])
    const seen: [number, boolean][] = []
    cursor.advance(400, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, true]])
    cursor.advance(600, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [0, false],
    ])
  })

  it('用户没按 → 也照常灭灯 (不再有「推迟灭灯」)', () => {
    const cursor = new LedScanCursor([n(0, 1)])
    const seen: [number, boolean][] = []
    cursor.advance(2000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [0, false],
    ])
  })

  it('同一时刻: 先按下标', () => {
    const cursor = new LedScanCursor([n(0, 1), n(0, 1, 64)])
    const seen: [number, boolean][] = []
    cursor.advance(1000, 0, (idx, on) => seen.push([idx, on]))
    // 同一时刻开灯 → 按下标顺序; 灭灯同理.
    expect(seen).toEqual([
      [0, true],
      [1, true],
      [0, false],
      [1, false],
    ])
  })

  it('提前量只提前开灯, 灭灯跟着音条走 (2026-10-30 修正)', () => {
    const cursor = new LedScanCursor([n(1, 1), n(10, 1)])
    const seen: [number, boolean][] = []
    // offset=+500ms → 提前 500ms 亮.
    // note0 (1s): 开灯提前到 500ms, 灭灯在 1.5s (落键 + 音条寿命), **不**跟着提前量走.
    cursor.advance(1000, 500, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, true]])
    // t=1600ms: 灭灯到了
    cursor.advance(1600, 500, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [0, false],
    ])
  })

  it('提前量为负 (延后) → 整段平移, 灯的时长不变', () => {
    const cursor = new LedScanCursor([n(1, 1)])
    const seen: [number, boolean][] = []
    // offset=-500ms → 灯晚 500ms 亮 (1.5s), 也晚 500ms 灭 (2.0s), 时长不变
    cursor.advance(1400, -500, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([])
    cursor.advance(1600, -500, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, true]])
    cursor.advance(2600, -500, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [0, false],
    ])
  })

  it('reset 后能重走一遍 (seek 回退)', () => {
    const cursor = new LedScanCursor([n(0, 1)])
    const seen: [number, boolean][] = []
    cursor.advance(2000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen.length).toBe(2)
    expect(cursor.remaining).toBe(0)

    cursor.reset()
    expect(cursor.remaining).toBe(2)
    const again: [number, boolean][] = []
    cursor.advance(2000, 0, (idx, on) => again.push([idx, on]))
    expect(again).toEqual(seen)
  })

  it('advance 只吐到 nowMs 为止的事件 (游标单调)', () => {
    const cursor = new LedScanCursor([n(0, 1), n(5, 1)])
    const seen: [number, boolean][] = []
    cursor.advance(100, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, true]])
    expect(cursor.remaining).toBe(3)

    cursor.advance(6000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [0, false],
      [1, true],
      [1, false],
    ])
    expect(cursor.remaining).toBe(0)
  })

  // ── 「只亮当前这一组」 (用户 2026-10-31) ────────────────────────────

  it('连着落的音 → 上一组在下一组开始时就灭 (任何时刻只有一组亮着)', () => {
    // 三个音分别在 0 / 0.1 / 0.2 秒 (十六分音符那种密度).
    // 以前: 灯按音条寿命 (0.5s) 亮 → 三个同时亮 (用户报的「同时亮好几个音」).
    // 现在: 下一组开始就换 → 任何时刻最多一组.
    const cursor = new LedScanCursor([n(0, 1, 60), n(0.1, 1, 62), n(0.2, 1, 64)])
    const seen: [number, boolean][] = []
    cursor.advance(1000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [1, true], // 0.1s: 新组先亮 (同一帧里旧组接着灭 → 画面上只看到新组)
      [0, false],
      [2, true], // 0.2s
      [1, false],
      [2, false], // 0.7s: 音条消失 → 灭 (后面没有下一组了)
    ])
  })

  it('同一时刻的多个音 → 一起亮, 一起灭 (两只手同时按)', () => {
    const cursor = new LedScanCursor([n(0, 1, 60), n(0, 1, 64)])
    const seen: [number, boolean][] = []
    cursor.advance(1000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [1, true],
      [0, false],
      [1, false],
    ])
  })

  it('同一时刻的音 + 下一个时刻的音 → 旧组一起灭, 新组一起亮', () => {
    const cursor = new LedScanCursor([n(0, 1, 60), n(0, 1, 64), n(0.2, 1, 67)])
    const seen: [number, boolean][] = []
    cursor.advance(1000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [1, true],
      [2, true], // 0.2s: 新组
      [0, false], // 旧组一起灭
      [1, false],
      [2, false], // 0.7s: 音条消失
    ])
  })

  it('长休止: 音条消失就灭 (0.5s), 不留到下一个音', () => {
    const cursor = new LedScanCursor([n(0, 1, 60), n(3, 1, 62)])
    const seen: [number, boolean][] = []
    cursor.advance(1000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([
      [0, true],
      [0, false], // 0.5s: 音条从画面上消失
    ])
    cursor.advance(4000, 0, (idx, on) => seen.push([idx, on]))
    expect(seen.slice(2)).toEqual([
      [1, true],
      [1, false],
    ])
  })
})

describe('LedScanCursor.levelOf (亮度)', () => {
  const notes = [n(2, 1)]

  it('提前量窗口里从刚亮渐亮到 100%', () => {
    const cursor = new LedScanCursor(notes)
    const never = () => false
    // 提前量 1000ms → 窗口是 [1s, 2s]
    // 刚亮 (t=1s): RAMP_START_LEVEL
    expect(cursor.levelOf(0, 1000, 1000, never)).toBeCloseTo(RAMP_START_LEVEL)
    // 窗口中点
    expect(cursor.levelOf(0, 1500, 1000, never)).toBeCloseTo(
      RAMP_START_LEVEL + (1 - RAMP_START_LEVEL) * 0.5,
    )
    // 落键 (t=2s): 100%
    expect(cursor.levelOf(0, 2000, 1000, never)).toBeCloseTo(1)
  })

  it('落键后: 没弹 = 100%, 弹过了 = 减半', () => {
    const cursor = new LedScanCursor(notes)
    expect(cursor.levelOf(0, 2500, 0, () => false)).toBeCloseTo(1)
    expect(cursor.levelOf(0, 2500, 0, () => true)).toBeCloseTo(PLAYED_LEVEL)
  })

  it('提前量为 0 → 不走渐亮 (直接 100% / 减半)', () => {
    const cursor = new LedScanCursor(notes)
    expect(cursor.levelOf(0, 2500, 0, () => false)).toBeCloseTo(1)
  })

  it('quantizeLevel 把亮度量化到固定档数', () => {
    expect(quantizeLevel(0)).toBe(0)
    expect(quantizeLevel(1)).toBe(1)
    expect(quantizeLevel(0.3)).toBeCloseTo(0.25) // round(2.4)/8 = 2/8
    expect(quantizeLevel(1.5)).toBe(1)
    expect(quantizeLevel(-1)).toBe(0)
  })
})

describe('NOTE_BAR_LIFETIME_S', () => {
  it('渲染和灯带共用同一个寿命常量', () => {
    expect(NOTE_BAR_LIFETIME_S).toBe(0.5)
  })
})
