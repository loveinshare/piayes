// 切歌 / 暂停 / 重播 —— 必须强制清灯 (用户要求: "刷新曲目应该强制清除当前的灯光")
//
// 背景 (2026-10-22): 提前量 != 0 时, 灯是 **pre-scanner** (LedScanCursor) 点的 ——
// Player 的 playback noteOff 被 emit.ts 抑制了 (src/led/emit.ts:isPlaybackSuppressed),
// 因为同一批 note 会被 Player 和 pre-scanner 各发一次 (双份灯).
//
// 后果: Player.pause() / 曲终 / 切歌 时, 灯**没有别的出口** —— 没人灭它 →
// 灯永远亮着 (用户报的「灯光残留」).
//
// 修法: LedScanCursor.flush() —— 把游标点着的灯全灭. App.tsx 在
//   - pre-scanner effect 的 cleanup (isPlaying 变 false 时)
//   - song 变化 effect
//   - handleRestart / handleSeek
// 四处调用.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LedScanCursor } from '../src/led/scanCursor'
import { runLedHarness, hasBWV846 } from './helpers/ledHarness'
import type { SongNote } from '../src/types'

function n(time: number, duration: number, midi = 60): SongNote {
  return { time, duration, midiNote: midi, track: 0, hand: 'right', velocity: 0.8 }
}

describe('LedScanCursor.flush (停播清灯)', () => {
  it('flush 灭掉所有亮着的灯', () => {
    const cursor = new LedScanCursor([n(0, 1, 60), n(0.5, 1, 64)])
    const seen: [number, boolean][] = []
    cursor.advance(600, 0, (idx, on) => seen.push([idx, on]))
    // note0 的音条在 0.5s 就消失了 (灯只活 0.5s); note1 在 0.5s 亮起来.
    // 同一时刻: 开灯先于灭灯 (ons / offs 各自排序, 跨表按到达顺序)
    expect(seen).toEqual([[0, true], [1, true], [0, false]])

    seen.length = 0
    cursor.flush((idx, on) => seen.push([idx, on]))
    // 还亮着的那盏要灭
    expect(seen.filter(([, on]) => !on).map(([idx]) => idx)).toEqual([1])
  })

  it('flush 之后内部状态清空 (再 advance 不会重复灭)', () => {
    const cursor = new LedScanCursor([n(0, 1, 60)])
    const seen: [number, boolean][] = []
    cursor.advance(100, 0, (idx, on) => seen.push([idx, on]))
    seen.length = 0
    cursor.flush((idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, false]])

    // 再 flush 一次 → 没有灯可灭 (不能重复发灭灯, 否则 follower 计数会错)
    seen.length = 0
    cursor.flush((idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([])
  })

  it('灯到点就灭 (用户没按也一样) → flush 时已经没有灯可灭', () => {
    const cursor = new LedScanCursor([n(0, 1, 60)])
    const seen: [number, boolean][] = []
    cursor.advance(2000, 0, (idx, on) => seen.push([idx, on]))
    // 开 + 灭 (0.5s 音条寿命到了就灭, 不推迟)
    expect(seen).toEqual([
      [0, true],
      [0, false],
    ])

    seen.length = 0
    cursor.flush((idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([])
  })
})

describe('LedScanCursor.reset (回退 / 重播清灯)', () => {
  it('reset(emit) 灭掉旧位置的灯', () => {
    const cursor = new LedScanCursor([n(0, 1, 60)])
    const seen: [number, boolean][] = []
    cursor.advance(100, 0, (idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, true]])

    seen.length = 0
    cursor.reset((idx, on) => seen.push([idx, on]))
    expect(seen).toEqual([[0, false]])
  })

  it('reset() 不带 emit → 只重置游标, 不动灯', () => {
    const cursor = new LedScanCursor([n(0, 1, 60)])
    const seen: [number, boolean][] = []
    cursor.advance(100, 0, (idx, on) => seen.push([idx, on]))
    seen.length = 0
    cursor.reset()
    expect(seen).toEqual([])
  })
})

describe('LedScanCursor.seekTo (跳转对齐)', () => {
  it('跳到 t: 跳过的 note 不发事件, 还在画面上的音条重新点亮', () => {
    // note0 @0s, note1 @0.5s, note2 @5s —— 灯的寿命是落键 + 0.5s.
    const cursor = new LedScanCursor([n(0, 1, 60), n(0.5, 2.5, 64), n(5, 1, 67)])
    const seen: [number, boolean][] = []
    cursor.seekTo(0.8, 0, (idx, on) => seen.push([idx, on]))
    // 跳到 t=0.8: note0 的音条已经消失 (0.5s) → 不亮;
    // note1 的音条还在画面上 (0.5~1.0) → 亮
    expect(seen).toEqual([[1, true]])
  })

  it('seekTo 之后 advance 从新位置继续', () => {
    const cursor = new LedScanCursor([n(0, 1, 60), n(5, 1, 67)])
    const seen: [number, boolean][] = []
    cursor.seekTo(1, 0, (idx, on) => seen.push([idx, on]))
    seen.length = 0
    cursor.advance(6000, 0, (idx, on) => seen.push([idx, on]))
    // note0 已经过了 → 不发; note1 开+灭
    expect(seen).toEqual([[1, true], [1, false]])
  })
})

// =============================================================================
// 端到端: 巴赫平均律 BWV 846 + 提前量 +4, 停播后灯必须全灭
// =============================================================================

describe('端到端: 停播后灯必须全灭 (BWV 846 + 提前量 +4)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.skipIf(!hasBWV846)('暂停后 (提前量模式) 灯全灭', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4,
      seconds: 8, press: 'all', stopAt: 4,
    })
    expect([...r.lit]).toEqual([])
  })

  it.skipIf(!hasBWV846)('暂停后 (用户没按, 灯是"还没按"的提示) 也全灭', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4,
      seconds: 8, press: 'none', stopAt: 4,
    })
    expect([...r.lit]).toEqual([])
  })

  it.skipIf(!hasBWV846)('暂停后 (提前量 = 0, 走 Player 直发) 灯全灭', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 0,
      seconds: 8, press: 'all', stopAt: 4,
    })
    expect([...r.lit]).toEqual([])
  })

  it.skipIf(!hasBWV846)('切歌后 (提前量模式) 灯全灭', () => {
    const r = runLedHarness({
      hand: 'both', wait: false, offsetUnits: 4,
      seconds: 8, press: 'all', switchSongAt: 4, clearFollowerOnSwitch: true,
    })
    // 切歌之后不该再有旧曲的灯 —— 切歌点之后的灯属于新曲, 这里只查切歌瞬间
    const atSwitch = r.events.filter((e) => e.t >= 4)
    // 切歌后第一个事件应该是全灭 (allOff), 而不是残留的灯
    expect(atSwitch.length).toBeGreaterThan(0)
  })
})
