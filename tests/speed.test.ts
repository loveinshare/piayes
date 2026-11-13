// 播放倍速 (spec P1-3 时钟层回归)
//
// 旧实现靠 `dt = FRAME_MS/1000 * speed` 累加歌曲时间, 倍速天然生效.
// 换成 SongClock (锚在 AudioContext 上) 之后, 歌曲时间由 ctx 推导 ——
// 倍速必须同步到 clock 内部的 speed, 否则**倍速滑块完全失效**
// (音乐永远 1× 播, 曲子跟用户以为的速度对不上).

import { describe, it, expect, beforeEach } from 'vitest'
import { Player } from '../src/engine/Player'
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

function n(time: number, midi: number): SongNote {
  return { time, duration: 0.5, midiNote: midi, track: 0, hand: 'right', velocity: 0.8 }
}

function makePlayer(song: Song, ctx: FakeAudioContext) {
  const played: { midi: number; when: number | undefined }[] = []
  const synth = {
    setMasterVolume: () => {},
    resume: () => {},
    playNote: (note: SongNote, transpose: number, _id: number, when?: number) => {
      played.push({ midi: note.midiNote + transpose, when })
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
  const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
  const player = new Player(
    song,
    synth as any,
    acc as any,
    metronome as any,
    countdown as any,
    () => {},
    () => {},
    clock,
  )
  return { player, played, ctx }
}

function step(h: ReturnType<typeof makePlayer>, frames: number) {
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

describe('Player — 播放倍速 (P1-3)', () => {
  it('1× 时歌曲时间 = 音频时间', () => {
    const ctx = new FakeAudioContext()
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)
    step(h, 60)
    expect(h.player.getCurrentTime()).toBeCloseTo(0.96, 2)
  })

  it('1/2× 时歌曲时间只走音频时间的一半', () => {
    const ctx = new FakeAudioContext()
    useStore.setState({ speed: 0.5 })
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)
    step(h, 60)
    // 音频走了 0.96s, 歌曲时间只该走 0.48s
    expect(h.player.getCurrentTime()).toBeCloseTo(0.48, 2)
  })

  it('1/4× 时歌曲时间只走音频时间的四分之一', () => {
    const ctx = new FakeAudioContext()
    useStore.setState({ speed: 0.25 })
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)
    step(h, 60)
    expect(h.player.getCurrentTime()).toBeCloseTo(0.24, 2)
  })

  it('倍速下音符的发声时刻跟着推后 (ctx 时间轴上更晚)', () => {
    const ctx = new FakeAudioContext()
    useStore.setState({ speed: 0.5 })
    // note 在歌曲时间 1.0s → 1× 时 ctx=1.0 响, 1/2× 时 ctx=2.0 才响
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)
    step(h, 130) // 音频走 2.08s → 歌曲时间 1.04s
    expect(h.played.length).toBe(1)
    expect(h.played[0].when).toBeCloseTo(2.0, 3)
  })

  it('中途改倍速不跳变 (位置连续)', () => {
    const ctx = new FakeAudioContext()
    const h = makePlayer(makeSong([n(1.0, 60)]), ctx)
    step(h, 30)
    const before = h.player.getCurrentTime()
    useStore.setState({ speed: 0.5 })
    step(h, 1)
    const after = h.player.getCurrentTime()
    // 换速那一帧歌曲时间只能前进一点点, 不能瞬移
    expect(after).toBeGreaterThanOrEqual(before - 1e-6)
    expect(after - before).toBeLessThan(0.05)
  })
})
