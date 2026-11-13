// 跟弹模式「第一个音没追踪上」的回归 (2026-11-01 用户报)
//
// 现象 (prelude_c_dur_2h = Bach BWV 846):
//   曲子开头 0.5s 的**预览窗**里不冻结 —— 冻结判定被 `currentTime > 0.5`
//   挡着. 等预览窗走完才冻, 曲首第一个 note (C4, t=0) 的灯组
//   (亮 = note.time, 灭 = 下一组开始 = 0.254s) 早就滚过去了 →
//   「第一个音一闪而过」, 灯停在第二个音 (E4) 上, 提示却说「要弹 c4」.
//
// 三处要一起对上:
//   1. 冻结点 = 第一个 note 的**精确时间** (t=0), 不是预览窗末尾 (t≈0.5)
//   2. 提示 (getWaitTarget) 报的是**最早**那个 required note, 不是最后一个
//   3. LED 游标跟着回退 (isRewind → reset) → 第一个 note 的灯重新亮起来

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Player } from '../src/engine/Player'
import { useStore } from '../src/store'
import { parseMidi } from '../src/parser/parseMidi'
import { LedScanCursor, isRewind } from '../src/led/scanCursor'
import type { Song, SongNote } from '../src/types'

function makeStubs() {
  return {
    synth: {
      setMasterVolume: () => {},
      resume: () => {},
      playNote: () => {},
      stopNote: () => {},
      stopAll: () => {},
      getCtx: () => null,
    },
    acc: {
      transpose: 0,
      isEnabled: () => false,
      setVolume: () => {},
      sendNoteOn: () => {},
      sendNoteOff: () => {},
      panic: () => {},
      silence: () => {},
    },
    metronome: { tick: () => {}, setVolume: () => {} },
    countdown: { start: (cb: () => void) => cb(), cancel: () => {} },
  }
}

function makePlayer(song: Song) {
  const { synth, acc, metronome, countdown } = makeStubs()
  return new Player(song, synth as any, acc as any, metronome as any, countdown as any)
}

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

function n(time: number, midi: number, duration = 1.0, hand: 'left' | 'right' = 'right'): SongNote {
  return { time, duration, midiNote: midi, track: 0, hand, velocity: 0.8 }
}

/**
 * 按 App.tsx 的 pre-scanner 逻辑跑一遍 LED 游标.
 *
 * App 那边: 时间倒退 (isRewind) → cursor.reset() → 再 advance().
 * 这里照抄同样的顺序, 才能测出「灯到底亮着哪个音」.
 */
class LedRunner {
  private cursor: LedScanCursor
  private lastT = -1
  /** 当前亮着的 midi (灯是每键一个像素) */
  lit = new Set<number>()

  constructor(private song: Song) {
    this.cursor = new LedScanCursor(song.notes)
  }

  advance(t: number) {
    if (isRewind(t, this.lastT)) {
      this.cursor.reset((idx, on) => this.apply(idx, on))
    }
    this.lastT = t
    this.cursor.advance(t * 1000, 0, (idx, on) => this.apply(idx, on))
  }

  private apply(idx: number, on: boolean) {
    const midi = this.song.notes[idx].midiNote
    if (on) this.lit.add(midi)
    else this.lit.delete(midi)
  }
}

beforeEach(() => {
  useStore.setState({
    hand: 'both',
    wait: true,
    speed: 1,
    hits: 0,
    misses: 0,
    errors: 0,
    perfects: 0,
    goods: 0,
    currentTime: 0,
    isPlaying: false,
    ledOffsetUnits: 0,
    ledEnabled: true,
    ledFollowPlayback: true,
    toleranceMs: 300,
  })
})

describe('跟弹: 曲首第一个音必须被追踪上', () => {
  it('BWV 846: 冻结点 = 第一个 note 的精确时间 (t=0), 提示和灯都是 C4', () => {
    const bytes = readFileSync(resolve(__dirname, '../public/library/bach/prelude-bwv846.mid'))
    const song = parseMidi(new Uint8Array(bytes))
    const player = makePlayer(song)
    const led = new LedRunner(song)

    player.play()
    // 跑到曲子开头的第一个 note 被要求跟弹之后 (预览窗走完 → 冻结)
    for (let f = 0; f < 200 && !player.isFrozen(); f++) {
      ;(player as any).stepLoop()
      led.advance(player.getCurrentTime())
    }

    expect(player.isFrozen()).toBe(true)
    // 冻结点停在**第一个 note 的精确时间** (C4 @ t=0), 不是预览窗末尾
    expect(player.getCurrentTime()).toBeCloseTo(0, 3)
    // 第一个 note 仍然 required —— 用户现在按它仍然算命中
    expect((player as any).playAlong.requiredIndices().has(0)).toBe(true)
    // 提示报的是**最早**那个 required note (C4), 不是第二个 (E4)
    expect(player.getWaitTarget()?.midiNote).toBe(60)
    // 灯跟着回退 → 亮的是 C4 (60), 不是 E4 (64)
    expect([...led.lit]).toEqual([60])
    // 没弹过 → 不算漏弹
    expect(useStore.getState().misses).toBe(0)
  })

  it('BWV 846: 弹对 C4 之后冻结点跟着走到 E4, 灯也换到 E4', () => {
    const bytes = readFileSync(resolve(__dirname, '../public/library/bach/prelude-bwv846.mid'))
    const song = parseMidi(new Uint8Array(bytes))
    const player = makePlayer(song)
    const led = new LedRunner(song)

    player.play()
    for (let f = 0; f < 200 && !player.isFrozen(); f++) {
      ;(player as any).stepLoop()
      led.advance(player.getCurrentTime())
    }
    expect(player.getCurrentTime()).toBeCloseTo(0, 3)

    // 用户弹 C4 → 解冻 → 下一个要弹的是 E4 (t=0.2541)
    player.handleInput({ type: 'down', midi: 60, source: 'input', velocity: 80, t: 0 })
    for (let f = 0; f < 20; f++) {
      ;(player as any).stepLoop()
      led.advance(player.getCurrentTime())
    }
    expect(useStore.getState().hits).toBe(1)
    expect(player.getWaitTarget()?.midiNote).toBe(64)
    expect(player.getCurrentTime()).toBeCloseTo(0.2541, 2)
    expect([...led.lit]).toEqual([64])
  })

  it('合成的曲子 (t=0 和 t=0.25 两个音): 冻结点回到 t=0, 灯亮第一个音', () => {
    const song = makeSong([n(0, 60, 2.0, 'left'), n(0.25, 64, 2.0, 'left')])
    const player = makePlayer(song)
    const led = new LedRunner(song)

    player.play()
    for (let f = 0; f < 200 && !player.isFrozen(); f++) {
      ;(player as any).stepLoop()
      led.advance(player.getCurrentTime())
    }

    expect(player.isFrozen()).toBe(true)
    expect(player.getCurrentTime()).toBeCloseTo(0, 3)
    expect(player.getWaitTarget()?.midiNote).toBe(60)
    expect([...led.lit]).toEqual([60])
  })

  it('曲子开头没 note (第一个 note 在 t=2.0): 冻结点仍然是 note 的精确时间', () => {
    const song = makeSong([n(2.0, 70), n(4.0, 72)])
    const player = makePlayer(song)
    player.play()
    for (let f = 0; f < 300; f++) (player as any).stepLoop()
    expect(player.isFrozen()).toBe(true)
    expect(player.getCurrentTime()).toBeCloseTo(2.0, 2)
  })
})
