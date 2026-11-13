// LedFollower 回归测试 (spec P1-9 + 2026-10-22 左手灯闪一下就灭)
//
//  - 多源追踪: 同一个 midi 被 input / playback 同时点亮时, 任一源的 up 都不应把灯熄掉
//  - 'hit' 脉冲: 独立通道, 亮 150ms 后自动灭; 不受 followSource 过滤影响
//  - 同源多重 (2026-10-22): 同一个 midi 在同一源下先后出现两个 note 时,
//    前一个的 NoteOff 不能把后一个的灯灭掉
//  - 命中脉冲 (2026-10-22): playback 源还在响时, 脉冲到期不能灭灯

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LedFollower } from '../src/led/LedFollower'
import type { NoteEvent } from '../src/types'

function makeLed() {
  return {
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    allOff: vi.fn(),
    show: vi.fn(async () => {}),
    setBrightness: vi.fn(),
    setMode: vi.fn(),
    setSplit: vi.fn(),
    setHandMap: vi.fn(),
    setColors: vi.fn(),
    setCalibrate: vi.fn(),
  }
}

function down(midi: number, source: NoteEvent['source'], hand?: 'left' | 'right'): NoteEvent {
  return { type: 'down', midi, velocity: 100, t: 0, source, hand }
}
function up(midi: number, source: NoteEvent['source'], hand?: 'left' | 'right'): NoteEvent {
  return { type: 'up', midi, t: 0, source, hand }
}

describe('P1-9: LedFollower 多源追踪', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('input 和 playback 同时按住同一 midi → input 松手不能把灯熄掉', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    follower.handleEvent(down(60, 'playback', 'right'))
    follower.handleEvent(down(60, 'input'))
    led.noteOff.mockClear()

    follower.handleEvent(up(60, 'input'))
    vi.advanceTimersByTime(50)
    expect(led.noteOff).not.toHaveBeenCalled() // playback 还按着 —— 灯不能灭
  })

  it('playback 松手也不能熄掉用户自己按着的灯', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    follower.handleEvent(down(60, 'playback', 'right'))
    follower.handleEvent(down(60, 'input'))
    led.noteOff.mockClear()

    follower.handleEvent(up(60, 'playback'))
    vi.advanceTimersByTime(50)
    expect(led.noteOff).not.toHaveBeenCalled()
  })

  it('所有源都松手了 → 灯才熄', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    follower.handleEvent(down(60, 'playback'))
    follower.handleEvent(down(60, 'input'))
    follower.handleEvent(up(60, 'input'))
    follower.handleEvent(up(60, 'playback'))
    vi.advanceTimersByTime(50)
    expect(led.noteOff).toHaveBeenCalledWith(60, undefined)
  })
})

describe('P1-9: 命中反馈脉冲', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hit 事件 → 亮灯, 150ms 后自动灭', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true })

    follower.handleEvent(down(60, 'hit', 'right'))
    expect(led.noteOn).toHaveBeenCalledWith(60, 'right')
    expect(led.noteOff).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)
    expect(led.noteOff).toHaveBeenCalledWith(60, 'right')
  })

  it('用户自己按着的键 → hit 脉冲不能把灯熄掉', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true })

    follower.handleEvent(down(60, 'input'))
    led.noteOff.mockClear()
    follower.handleEvent(down(60, 'hit'))
    vi.advanceTimersByTime(200)
    expect(led.noteOff).not.toHaveBeenCalled()
  })

  it('hit 不受 followSource 过滤影响 (用户选「只看播放」也要看到命中反馈)', () => {
    const led = makeLed()
    const follower = new LedFollower({
      led: led as any,
      isEnabled: () => true,
      followSource: 'playback',
    })
    follower.handleEvent(down(60, 'hit'))
    expect(led.noteOn).toHaveBeenCalledWith(60, undefined)
  })

  it('关掉 LED 时一个事件都不发', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => false })
    follower.handleEvent(down(60, 'hit'))
    expect(led.noteOn).not.toHaveBeenCalled()
  })

  it('clearAll 会抹掉脉冲定时器', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true })
    follower.handleEvent(down(60, 'hit'))
    follower.clearAll()
    led.noteOff.mockClear()
    vi.advanceTimersByTime(300)
    expect(led.noteOff).not.toHaveBeenCalled() // 定时器已被取消 —— 不会在清灯后又熄一下
  })
})

// =============================================================================
// 2026-10-22: 双手跟弹时左手灯「闪一下就灭」(巴赫平均律 BWV 846)
// =============================================================================
describe('2026-10-22: 同源多重 (同一 midi 先后出现)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('同 midi 第二个 note 开始后, 第一个 note 结束不能灭灯', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    // 巴赫 BWV 846 左手 C4: LH#0 t=0 end=2.0266, LH#2 t=2.0266 end=4.0467
    follower.handleEvent(down(60, 'playback', 'left')) // LH#0
    follower.handleEvent(down(60, 'playback', 'left')) // LH#2 (同音, 接力)
    follower.handleEvent(up(60, 'playback', 'left')) // LH#0 结束
    led.noteOff.mockClear()

    vi.advanceTimersByTime(200)
    // LH#2 还在响 → 灯不能灭
    expect(led.noteOff).not.toHaveBeenCalled()
  })

  it('最后一个 note 结束后, 灯正常灭', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    follower.handleEvent(down(60, 'playback', 'left'))
    follower.handleEvent(down(60, 'playback', 'left'))
    follower.handleEvent(up(60, 'playback', 'left'))
    // 第一个 note 结束 → 还有一个 note 在响 → 灯不能灭
    expect(led.noteOff).not.toHaveBeenCalled()

    follower.handleEvent(up(60, 'playback', 'left'))
    // ★ 2026-10-31: 播放源的灭灯是**立即**的 (不等 grace) ——
    //   下一组已经在同一帧点亮了, 再等 grace 会让两组灯同时亮着.
    expect(led.noteOff).toHaveBeenCalledWith(60, 'left')
  })

  it('播放源不等 grace, 输入源还是等 grace (真实键盘的竞态)', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 60 })

    // 播放源: 松手就灭
    follower.handleEvent(down(60, 'playback', 'left'))
    follower.handleEvent(up(60, 'playback', 'left'))
    expect(led.noteOff).toHaveBeenCalledWith(60, 'left')

    // 输入源: 等 grace (60ms) 才灭
    led.noteOff.mockClear()
    follower.handleEvent(down(62, 'input'))
    follower.handleEvent(up(62, 'input'))
    expect(led.noteOff).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60)
    expect(led.noteOff).toHaveBeenCalledWith(62, undefined)
  })

  it('input 源同 midi 重复按下也按计数 (不是幂等开关)', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    follower.handleEvent(down(60, 'input'))
    follower.handleEvent(down(60, 'input'))
    follower.handleEvent(up(60, 'input'))
    led.noteOff.mockClear()

    vi.advanceTimersByTime(200)
    expect(led.noteOff).not.toHaveBeenCalled()
  })
})

describe('2026-10-22: 命中脉冲不能灭掉还在响的灯', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('playback 源还在响时, 命中脉冲到期不能灭灯', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true })

    // 左手长音 (playback) 正在响
    follower.handleEvent(down(60, 'playback', 'left'))
    // 用户弹对 → 命中脉冲
    follower.handleEvent(down(60, 'hit', 'left'))
    led.noteOff.mockClear()

    vi.advanceTimersByTime(200)
    // 长音还在响 → 灯不能灭 (旧实现只查 input 源, 会在这里把灯灭掉)
    expect(led.noteOff).not.toHaveBeenCalled()
  })

  it('没有别的源按着时, 命中脉冲到期正常灭灯', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true })

    follower.handleEvent(down(60, 'hit', 'left'))
    led.noteOff.mockClear()
    vi.advanceTimersByTime(200)
    expect(led.noteOff).toHaveBeenCalledWith(60, 'left')
  })

  it('pending off 到期时, 命中脉冲还在亮 → 不灭灯', () => {
    const led = makeLed()
    const follower = new LedFollower({ led: led as any, isEnabled: () => true, offGraceMs: 0 })

    // 命中脉冲先来 (150ms), 之后 playback 音结束
    follower.handleEvent(down(60, 'hit', 'left'))
    follower.handleEvent(down(60, 'playback', 'left'))
    follower.handleEvent(up(60, 'playback', 'left'))
    led.noteOff.mockClear()

    // grace 到期 (0ms) 时脉冲还在 (150ms) → 不能灭
    vi.advanceTimersByTime(10)
    expect(led.noteOff).not.toHaveBeenCalled()
  })
})
