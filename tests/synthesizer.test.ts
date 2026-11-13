// Synthesizer 回归测试
//
// 覆盖 spec P1-13: voice 以 (midi, voiceId) 记账 —— 同一个 midi 的两个声部
// (左右手同名音, 如 BWV1041) 必须能并存, 互不掐断.
//
// jsdom 没有 WebAudio, 这里塞一个最小的假 AudioContext.

import { describe, it, expect, beforeAll } from 'vitest'
import type { SongNote } from '../src/types'

class FakeParam {
  value = 0
  setValueAtTime(v: number) {
    this.value = v
    return this
  }
  linearRampToValueAtTime(v: number) {
    this.value = v
    return this
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v
    return this
  }
  cancelScheduledValues() {
    return this
  }
}

class FakeNode {
  connect() {
    return this
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam()
}
class FakeFilter extends FakeNode {
  frequency = new FakeParam()
  Q = { value: 1 }
  type = 'lowpass'
}
class FakeOsc extends FakeNode {
  frequency = new FakeParam()
  type = 'sine'
  start() {}
  stop() {}
}

class FakeAudioContext {
  currentTime = 0
  destination = {}
  state = 'running'
  createGain() {
    return new FakeGain()
  }
  createBiquadFilter() {
    return new FakeFilter()
  }
  createOscillator() {
    return new FakeOsc()
  }
  resume() {}
}

beforeAll(() => {
  ;(window as any).AudioContext = FakeAudioContext
})

const note = (midi: number, duration = 1): SongNote => ({
  midiNote: midi,
  time: 0,
  duration,
  track: 0,
  velocity: 0.8,
})

/** 延迟 import —— 必须在 AudioContext 装好之后再 new */
async function makeSynth() {
  const { Synthesizer } = await import('../src/engine/Synthesizer')
  return new Synthesizer()
}

describe('P1-13: Synthesizer voice 以 (midi, voiceId) 记账', () => {
  it('同一 midi 的两个声部可以并存, 互不掐断', async () => {
    const synth = await makeSynth()
    synth.playNote(note(60), 0, 0)
    synth.playNote(note(60), 0, 1)

    const active = (synth as any).active
    expect(active.get(60).length).toBe(2)

    // 停其中一个, 另一个继续响
    synth.stopNote(60, 0)
    expect(active.get(60).length).toBe(1)

    synth.stopNote(60, 1)
    expect(active.has(60)).toBe(false)
  })

  it('同一 (midi, voiceId) re-trigger → 旧的先停, 不叠音', async () => {
    const synth = await makeSynth()
    synth.playNote(note(60), 0, 7)
    synth.playNote(note(60), 0, 7)
    expect((synth as any).active.get(60).length).toBe(1)
  })

  it('stopNote(midi) 不带 voiceId → 该音高上所有声部全停', async () => {
    const synth = await makeSynth()
    synth.playNote(note(60), 0, 0)
    synth.playNote(note(60), 0, 1)
    synth.playNote(note(64), 0, 2)

    synth.stopNote(60)
    expect((synth as any).active.has(60)).toBe(false)
    expect((synth as any).active.get(64).length).toBe(1)
  })

  it('stopAll() 全停', async () => {
    const synth = await makeSynth()
    synth.playNote(note(60), 0, 0)
    synth.playNote(note(64), 0, 1)
    synth.stopAll()
    expect((synth as any).active.size).toBe(0)
  })

  it('不同 midi 互不影响', async () => {
    const synth = await makeSynth()
    synth.playNote(note(60), 0, 0)
    synth.playNote(note(64), 0, 1)
    synth.stopNote(60, 0)
    expect((synth as any).active.has(60)).toBe(false)
    expect((synth as any).active.has(64)).toBe(true)
  })
})
