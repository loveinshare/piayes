// 巴赫平均律 BWV 846 前奏曲 —— 双手跟弹时左手灯「闪一下就灭」回归测试
//
// 用户报的现象 (2026-10-22): 双手跟弹, 左手灯亮一下就灭了.
//
// 两个根因 (都在 LedFollower):
//  1. 命中脉冲到期无条件灭灯 —— 旧实现只查 `bySource.has('input')`,
//     跟弹时左手长音还在放 (playback 源), 用户弹对 → 脉冲 150ms 后把灯灭了,
//     但音还在响. 表现: 灯闪一下就灭.
//  2. 同源同 midi 记成布尔而非计数 —— BWV 846 左手 C4 每小节重复
//     (LH#0 t=0 end=2.0266, LH#2 t=2.0266 end=4.0467), 前一个音的 NoteOff
//     把后一个音的灯灭掉. 表现: 灯闪一下就灭.
//
// 这两个 bug 在别的曲子上不明显, 因为左手长音少 / 同音不重复 —— BWV 846
// 恰好两个条件都占全了, 所以它是天然的复现用例.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parseMidi } from '../src/parser/parseMidi'
import { Player } from '../src/engine/Player'
import { LedFollower } from '../src/led/LedFollower'
import { useStore } from '../src/store'

// 乐库文件 (已入库), 路径相对仓库根
const MIDI_PATH = resolve('public/library/bach/prelude-bwv846.mid')
const hasMidi = existsSync(MIDI_PATH)

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

function makeStubs() {
  return {
    synth: {
      setMasterVolume: () => {}, resume: () => {}, playNote: () => {},
      stopNote: () => {}, stopAll: () => {}, getCtx: () => null,
    } as any,
    acc: {
      transpose: 0, isEnabled: () => false, setVolume: () => {},
      sendNoteOn: () => {}, sendNoteOff: () => {}, panic: () => {}, silence: () => {},
    } as any,
    metronome: { tick: () => {} } as any,
    countdown: { start: (cb: () => void) => cb(), cancel: () => {} } as any,
  }
}

/** 复刻 App.tsx 的接线: Player 的播放事件 → LedFollower (source='playback'/'hit') */
function makeStack(song: any) {
  const led = makeLed()
  const follower = new LedFollower({
    led: led as any,
    isEnabled: () => true,
    followSource: 'playback',
  })
  const s = makeStubs()
  const player = new Player(
    song, s.synth, s.acc, s.metronome, s.countdown,
    (n: any, hit: boolean) => {
      follower.handleEvent({
        type: 'down', midi: n.midiNote, velocity: 1, t: 0,
        source: hit ? 'hit' : 'playback', hand: n.hand,
      })
    },
    (n: any) => {
      follower.handleEvent({
        type: 'up', midi: n.midiNote, t: 0, source: 'playback', hand: n.hand,
      })
    },
  )
  return { led, follower, player }
}

describe('BWV 846: 左手长音的灯不能被误灭', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore.setState({
      hand: 'both', wait: false, speed: 1, currentTime: 0, isPlaying: false,
      hits: 0, misses: 0, errors: 0, perfects: 0, goods: 0, ledOffsetUnits: 0,
    })
  })
  afterEach(() => vi.useRealTimers())

  it.skipIf(!hasMidi)('用户弹对左手 C4 后, 灯在 150ms 后仍然亮着 (音还在响)', () => {
    const song = parseMidi(new Uint8Array(readFileSync(MIDI_PATH)))
    const { led, player } = makeStack(song)
    player.play()
    ;(player as any).stepLoop() // 帧 1: 记账 midi=60 (左手, 长音 2.03s) → 灯亮

    // 用户弹对左手 C4
    player.handleInput({ type: 'down', midi: 60, source: 'input', velocity: 80, t: 0 })
    player.handleInput({ type: 'up', midi: 60, source: 'input', t: 0 })

    led.noteOff.mockClear()
    vi.advanceTimersByTime(200) // 命中脉冲 (150ms) 到期

    // 左手长音 (d=2.03s) 还在响 → 灯不能灭
    expect(led.noteOff).not.toHaveBeenCalled()
    expect(useStore.getState().hits).toBe(1)
  })

  it.skipIf(!hasMidi)('同一个左手 C4 接力 (前一个音结束) 时, 灯不灭', () => {
    const song = parseMidi(new Uint8Array(readFileSync(MIDI_PATH)))
    const { led, player } = makeStack(song)
    player.play()

    // 推到 t≈2.1s: LH#0 (t=0, end=2.0266) 已结束, LH#2 (t=2.0266, end=4.0467) 刚开始.
    // 每一帧都推 16ms, 让 pendingOff 的 grace 定时器按真实节奏到期.
    for (let i = 0; i < 135; i++) {
      ;(player as any).stepLoop()
      vi.advanceTimersByTime(16)
    }

    const ct = player.getCurrentTime()
    expect(ct).toBeGreaterThan(2.0266)

    // 此刻还在响的左手音里必须还有 midi=60 —— 灯该亮着
    const sounding = [...(player as any).playingNotes.values()]
      .filter((n: any) => n.hand === 'left' && n.time + n.duration > ct)
      .map((n: any) => n.midiNote)
    expect(sounding).toContain(60)

    // 灯不能是灭的 —— 最后一个 noteOff 之后不能再有 noteOff(60)
    const offs = led.noteOff.mock.calls.filter((c: any[]) => c[0] === 60)
    // 只允许 1 次 (LH#0 结束时的那个), 不能再多
    expect(offs.length).toBeLessThanOrEqual(1)
  })
})
