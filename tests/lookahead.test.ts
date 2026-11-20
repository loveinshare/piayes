// Lookahead 排程 + 精确判定时钟 (spec P1-2 / P1-3)
//
// 验证三件事:
//   1. 音符**提前**排到音频时间轴上, 声音精确落在 note.time (主线程卡顿不影响);
//   2. 灯/跟弹记账仍按 note 的**精确时间**走 (不能跟着排程时刻提前);
//   3. 判定用输入事件的硬件时间戳 —— 主线程卡 500ms 也不影响 delta.

import { describe, it, expect, beforeEach } from 'vitest'
import { Player } from '../src/engine/Player'
import { Scheduler } from '../src/engine/Scheduler'
import { SongClock } from '../src/engine/Clock'
import { useStore } from '../src/store'
import type { Song, SongNote } from '../src/types'
import { FakeAudioContext } from './fakeClock'

function makeSong(notes: SongNote[]): Song {
  return {
    notes,
    measures: [{ number: 1, time: 0, duration: 4 }],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 8,
    ppq: 480,
    hands: { left: 0, right: 0 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
  }
}

function n(time: number, midi: number, hand: 'left' | 'right' = 'right'): SongNote {
  return { time, duration: 0.5, midiNote: midi, track: 0, hand, velocity: 0.8 }
}

interface Harness {
  player: Player
  played: { midi: number; id: number; when: number | undefined }[]
  led: { midi: number; at: number }[]
  ctx: FakeAudioContext
}

function makePlayer(song: Song, ctx: FakeAudioContext): Harness {
  const played: { midi: number; id: number; when: number | undefined }[] = []
  const led: { midi: number; at: number }[] = []
  const synth = {
    setMasterVolume: () => {},
    resume: () => {},
    playNote: (note: SongNote, transpose: number, id: number, when?: number) => {
      played.push({ midi: note.midiNote + transpose, id, when })
    },
    stopNote: () => {},
    stopAll: () => {},
  }
  const acc = {
    transpose: 0,
    isEnabled: () => false,
    setVolume: () => {},
    sendNoteOn: () => {},
    sendNoteOff: () => {},
    panic: () => {},
    silence: () => {},
    attachContext: () => {},
  }
  const metronome = { tick: () => {}, setVolume: () => {} }
  const countdown = { start: (cb: () => void) => cb(), cancel: () => {} }
  // perf↔ctx 偏移注入 0 —— perf 毫秒 = ctx 秒 * 1000, 断言可以写死
  const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
  const player = new Player(
    song,
    synth as any,
    acc as any,
    metronome as any,
    countdown as any,
    (note, hit) => {
      if (!hit) led.push({ midi: note.midiNote, at: ctx.currentTime })
    },
    () => {},
    clock,
  )
  return { player, played, led, ctx }
}

/** 推进 n 帧 —— 每帧音频时钟走 16ms (模拟正常帧率) */
function step(h: Harness, frames: number) {
  const p = h.player as any
  for (let i = 0; i < frames; i++) {
    h.ctx.advance(0.016)
    p.stepLoop()
  }
}

beforeEach(() => {
  useStore.getState().resetScore()
  useStore.setState({
    hand: 'playback',
    wait: false,
    speed: 1,
    currentTime: 0,
    isPlaying: false,
    transpose: 0,
    latencyAuto: false,
    latencyOffsetMs: 0,
  })
})

describe('Scheduler — lookahead 游标 (P1-2)', () => {
  it('takeDue 按 horizon 取, 顺序单调', () => {
    const s = new Scheduler([n(0, 60), n(1, 61), n(2, 62)])
    expect(s.takeDue(0).length).toBe(1)
    expect(s.takeDue(1).length).toBe(1)
    expect(s.takeDue(5).length).toBe(1)
    expect(s.remaining).toBe(0)
  })

  it('reset 之后从新位置继续', () => {
    const s = new Scheduler([n(0, 60), n(1, 61), n(2, 62)])
    s.takeDue(0)
    expect(s.index).toBe(1)
    s.reset(2)
    expect(s.index).toBe(2)
    expect(s.takeDue(5).map((x) => x.midiNote)).toEqual([62])
  })
})

describe('Player — lookahead 排程 (P1-2)', () => {
  it('音符提前排程, 发声时刻精确落在 note.time', () => {
    const ctx = new FakeAudioContext()
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)

    // 推到 songTime ≈ 0.88 —— 距 note.time 还有 120ms
    step(h, 55)
    expect(h.player.getCurrentTime()).toBeGreaterThan(0.85)
    expect(h.player.getCurrentTime()).toBeLessThan(0.92)

    // 已经排上去了 (声音还没出来)
    expect(h.played.length).toBe(1)
    // when 精确 = note.time 对应的 ctx 时刻
    expect(h.played[0].when).toBeCloseTo(1.0, 6)
    // 此刻声音还没响
    expect(ctx.currentTime).toBeLessThan(1.0)
  })

  it('主线程卡 100ms → 发声时刻不变 (抖动不传导到音乐)', () => {
    const ctx = new FakeAudioContext()
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)

    step(h, 55)
    expect(h.played.length).toBe(1)
    const whenBefore = h.played[0].when

    // 主线程卡住 —— 音频时钟照走 100ms, 期间没有新调度
    ctx.advance(0.1)
    ;(h.player as any).stepLoop()
    expect(h.played.length).toBe(1)
    expect(h.played[0].when).toBe(whenBefore)
    expect(h.played[0].when).toBeCloseTo(1.0, 6)
  })

  it('灯按 note 的精确时间亮 (不跟着排程时刻提前)', () => {
    const ctx = new FakeAudioContext()
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)

    step(h, 55)
    // 已经排程, 但灯还没亮
    expect(h.played.length).toBe(1)
    expect(h.led.length).toBe(0)

    // 推到 note.time 之后 → 灯亮
    step(h, 10)
    expect(h.led.length).toBe(1)
    expect(h.led[0].at).toBeGreaterThanOrEqual(1.0)
  })

  it('wait 模式不启用 lookahead (冻结会把提前排的音误杀)', () => {
    const ctx = new FakeAudioContext()
    useStore.setState({ hand: 'right', wait: true })
    // 左手 = 伴奏 (会发声), 右手 = 用户要弹的 (silent)
    const h = makePlayer(makeSong([n(1.0, 60, 'left')]), ctx)

    step(h, 55)
    // 还没到点 → 不该提前排
    expect(h.played.length).toBe(0)
    step(h, 10)
    expect(h.played.length).toBe(1)
  })
})

describe('Player — 判定用硬件时间戳 (P1-3)', () => {
  it('主线程卡住时按键 → delta 仍然准 (用 e.timeStamp 而不是处理时刻)', () => {
    const ctx = new FakeAudioContext()
    const song = makeSong([n(1.0, 60)])
    const h = makePlayer(song, ctx)
    useStore.setState({ hand: 'right', wait: false })

    // 推到 note 到点, 让它进 required
    step(h, 70)
    const pa = (h.player as any).playAlong
    expect(pa.requiredSize()).toBe(1)

    // 用户在 ctx=1.0 时按下 (硬件时间戳 = 1000ms), 但事件处理被拖到 ctx=1.5
    h.ctx.advance(0.5) // 事件在浏览器队列里等了 500ms
    h.player.handleInput({
      type: 'down',
      midi: 60,
      velocity: 0.8,
      t: 1000, // 硬件时间戳: 按下的那一刻
      source: 'input',
    })
    expect(pa.requiredSize()).toBe(0)
    // delta ≈ 0 —— 事件处理晚了 500ms 也不影响判定
    expect(Math.abs(pa.stats.playedDelta[0])).toBeLessThan(50)
  })
})
