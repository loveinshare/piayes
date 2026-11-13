// 修 #7 根因回归: Player.onNoteOn/Off 通过 bus.emit 把 source='playback' 事件
// 灌回 Player.handleInput, 被当成 user press → userPress 命中自己刚入 required 的 note,
// 立即删 + playedDelta++, wait 模式永远冻不住.
//
// 这个测试模拟: play() 后没有真用户按键, 但 bus.emit 发了 source='playback' 的 down 事件.
// 修后: handleInput 在 e.source === 'playback' 时 return, 不会调 userPress.
// 期望: requiredSize > 0 (note 入 required 没被自己 delete), playedDelta 为空.

import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from '../src/store'
import { Player } from '../src/engine/Player'
import { InputBus } from '../src/input/InputBus'

const fakeSong = {
  notes: [
    { time: 0.0, duration: 1.0, midiNote: 70, track: 0, hand: 'right' as const, velocity: 0.8 },
  ],
  measures: [{ number: 1, time: 0, duration: 4 }],
  bpms: [{ time: 0, bpm: 120 }],
  duration: 4,
  ppq: 480,
  hands: { left: 0, right: 0 } as { left: number; right: number },
  timeSignature: { numerator: 4, denominator: 4 },
  source: 'midi' as const,
}

function makeInput() {
  return {
    isEnabled: () => false,
    setVolume: () => {},
    sendNoteOn: () => {},
    sendNoteOff: () => {},
    panic: () => {},
    silence: () => {},
    transpose: 0,
  } as any
}
function makeSynth() {
  return {
    setMasterVolume: () => {}, resume: () => {},
    playNote: () => {}, stopNote: () => {}, stopAll: () => {},
  } as any
}
function makeMetro() { return { tick: () => {} } as any }
function makeCd() { return { start: (cb: any) => cb(), cancel: () => {} } as any }

describe('修 #7 根因: source=playback 事件不能回灌 handleInput', () => {
  beforeEach(() => {
    useStore.setState({
      hand: 'right', wait: true,
      hits: 0, misses: 0, errors: 0, perfects: 0, goods: 0, speed: 1,
    })
  })

  it('bus.emit(down, source=playback) 不会让 userPress 误命中 + playedDelta 不该增', () => {
    const bus = new InputBus()
    const player = new Player(fakeSong as any, makeSynth(), makeInput(), makeMetro(), makeCd())
    bus.setHandler((e) => player.handleInput(e))

    // 先入 required (ct 推进到 0.01)
    const p = player as any
    p.setSongTime(0.01)
    p.stepLoop()
    expect(p.playAlong.requiredSize()).toBe(1)  // note 0 入 required

    // 模拟 LED 播放事件回灌 (source=playback, 同 midi 70)
    bus.emit({ type: 'down', midi: 70, source: 'playback', velocity: 1, t: 0.01 })

    // 修后: handleInput 在 source=playback 时 return, 不调 userPress, required 不该被删
    expect(p.playAlong.requiredSize()).toBe(1)
    expect(p.playAlong.stats.playedDelta.length).toBe(0)
  })

  it('真实用户按键 (source=input) 仍然能 late-hit 解冻', () => {
    const bus = new InputBus()
    const player = new Player(fakeSong as any, makeSynth(), makeInput(), makeMetro(), makeCd())
    bus.setHandler((e) => player.handleInput(e))

    const p = player as any
    p.setSongTime(0.01)
    p.stepLoop()
    expect(p.playAlong.requiredSize()).toBe(1)

    // 用户按键 — 没 source, bus.use 会自动标 'input' (模拟走 input 路径)
    // 直接调 handleInput, source='input'
    player.handleInput({ type: 'down', midi: 70, source: 'input', velocity: 80, t: 0.01 })
    expect(p.playAlong.requiredSize()).toBe(0)  // 命中, delete
    expect(p.playAlong.stats.playedDelta.length).toBe(1)
  })

  it('修 #7 第二处根因: dtMs 用 song time, 与真实时间无关', () => {
    // 之前用 performance.now() 设 press.ts, handleInput 用 performance.now() 算 dtMs.
    // 真实场景: 用户卡 1s 想键位才按 — press.ts 跟 nowMs 差 1s > tolerance → 不命中 → 死锁.
    // 修后: fileNoteOn/userPress 都用 currentTime*1000, dtMs 是歌曲时间差, 与真实时间无关.
    const bus = new InputBus()
    const player = new Player(fakeSong as any, makeSynth(), makeInput(), makeMetro(), makeCd())
    bus.setHandler((e) => player.handleInput(e))
    const p = player as any
    // 文件 ct 0.01 时入 required (press.ts = note 的精确时间 = 0ms song)
    p.setSongTime(0.01)
    p.stepLoop()
    expect(p.playAlong.requiredSize()).toBe(1)
    // 用户 ct=0.13 时弹 → song delta = 104ms < 250ms (120bpm hit 窗口) → 命中
    // 事件的 t (墙钟) 故意落后 1s —— 不该影响判定
    p.setSongTime(0.13)
    player.handleInput({ type: 'down', midi: 70, source: 'input', velocity: 80, t: 0.01 })
    expect(p.playAlong.requiredSize()).toBe(0)
    // dt = 130 - 0 = 130 (song time), 跟墙钟无关
    expect(p.playAlong.stats.playedDelta[0]).toBeGreaterThan(90)
    expect(p.playAlong.stats.playedDelta[0]).toBeLessThan(140)
  })
})
