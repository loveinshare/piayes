// 播放速率回归测试 (2026-11-06)
//
// 用户报: 「最近大更新之后 谱子普遍变慢了」.
//
// 根因: 没有**音频时钟**时 (AudioContext 被挂起 —— 浏览器自动播放策略没拿到
// 用户手势), SongClock 退化成**逻辑时钟**; 而逻辑时钟以前是按"假定定时器
// 每 16ms 跑一次"推进的 —— 歌曲时间 = 16ms × 定时器实际唤醒次数.
//
// 后果:
//   - 浏览器把**后台标签页**的定时器压到 1s 一次 (Edge 实测 ~0.5 次/秒)
//     → 整首曲子慢 30~125 倍 (实测用户自己的标签页: 歌曲时间每 ~2s 才走 16ms);
//   - 主线程一卡 (每帧要画瀑布 + 推灯带) → 系统性地偏慢.
//
// 修复: 逻辑时钟按**真实经过的时间** (performance.now 差值) 推进 ——
// 定时器只是"唤醒", 曲子速度不再取决于定时器被压成什么样.
//
// 修完之后这几个断言锁住新语义 (旧实现下第 1、2 条会挂).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Player } from '../src/engine/Player'
import { useStore } from '../src/store'
import type { Song, SongNote } from '../src/types'
import { withFakePerf } from './fakeClock'

function makeSong(notes: SongNote[]): Song {
  return {
    notes,
    measures: [{ number: 1, time: 0, duration: 8 }],
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

/** 没有 AudioContext 的播放器 (synth.getCtx 返回 null → 逻辑时钟) */
function makePlayer(song: Song) {
  const synth = {
    setMasterVolume: () => {},
    resume: () => {},
    playNote: () => {},
    stopNote: () => {},
    stopAll: () => {},
    getCtx: () => null,
  }
  const acc = {
    transpose: 0,
    isEnabled: () => false,
    setVolume: () => {},
    sendNoteOn: () => {},
    sendNoteOff: () => {},
    panic: () => {},
    silence: () => {},
  }
  const metronome = { tick: () => {}, setVolume: () => {} }
  const countdown = { start: (cb: () => void) => cb(), cancel: () => {} }
  const player = new Player(
    song,
    synth as any,
    acc as any,
    metronome as any,
    countdown as any,
  )
  return player
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
  })
})

describe('播放速率 — 逻辑时钟按真实时间推进 (2026-11-06)', () => {
  it('stepLoop(dt) 按传入的 dt 推进 (旧实现恒按 16ms 走)', () => {
    const player = makePlayer(makeSong([n(1.0, 60), n(5.0, 62)]))
    const p = player as any

    p.stepLoop(1.0)
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)

    p.stepLoop(0.5)
    expect(player.getCurrentTime()).toBeCloseTo(1.5, 6)
  })

  it('倍速仍然生效 (dt × speed)', () => {
    const player = makePlayer(makeSong([n(1.0, 60), n(5.0, 62)]))
    useStore.setState({ speed: 0.5 })
    ;(player as any).stepLoop(1.0)
    expect(player.getCurrentTime()).toBeCloseTo(0.5, 6)
  })
})

describe('播放速率 — 定时器路径 (后台标签页被压慢)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('定时器被压到 1s 醒一次 → 曲子仍然是 1 秒走 1 秒', () => {
    const player = makePlayer(makeSong([n(1.0, 60), n(5.0, 62)]))

    // perf 时间从 0 开始; 定时器"睡"了 1 秒才醒 (浏览器压后台标签页就是这样)
    withFakePerf(0, (setPerf) => {
      player.play()
      setPerf(1000)
      vi.advanceTimersByTime(16) // 定时器醒一次

      // 关键: 歌曲时间走了**真实经过的 1 秒**, 不是 16ms
      expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)
    })
    player.pause()
  })

  it('正常帧率下 1 秒假时间 → 歌曲时间约 1 秒', () => {
    const player = makePlayer(makeSong([n(1.0, 60), n(5.0, 62)]))

    // 不接管 performance.now —— 让它跟假时钟一起走 (正常帧率)
    player.play()
    vi.advanceTimersByTime(1000) // 62 次 16ms 的定时器
    const t = player.getCurrentTime()
    // 允许一点点误差 (62 帧 × 16ms = 992ms)
    expect(t).toBeGreaterThan(0.95)
    expect(t).toBeLessThan(1.05)
    player.pause()
  })
})
