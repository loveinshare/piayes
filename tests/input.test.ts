// 输入层回归测试 (spec P1-7 / P1-8)
//
//  - P1-7 MidiInput: 保留 e.timeStamp / running status / CC64 踏板 / All Notes Off / activeNotes
//  - P1-8 KeyboardInput: blur 释放 + onUp 幂等

import { describe, it, expect } from 'vitest'
import { MidiInput } from '../src/input/MidiInput'
import { KeyboardInput } from '../src/input/KeyboardInput'
import type { NoteEvent } from '../src/types'

// =============================================================================
// P1-8 KeyboardInput
// =============================================================================
describe('P1-8: KeyboardInput', () => {
  function setup() {
    const kb = new KeyboardInput()
    const events: NoteEvent[] = []
    kb.onEvent = (e) => events.push(e)
    kb.start()
    return { kb, events }
  }

  function key(type: 'keydown' | 'keyup', code: string) {
    window.dispatchEvent(new KeyboardEvent(type, { code }))
  }

  it('keydown → down 事件 (KeyZ = C4 = 60)', () => {
    const { events } = setup()
    key('keydown', 'KeyZ')
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('down')
    expect(events[0].midi).toBe(60)
    expect(events[0].source).toBe('input')
  })

  it('keyup → up 事件', () => {
    const { events } = setup()
    key('keydown', 'KeyZ')
    key('keyup', 'KeyZ')
    expect(events.length).toBe(2)
    expect(events[1].type).toBe('up')
    expect(events[1].midi).toBe(60)
  })

  it('onUp 幂等: 没按过的键不发 up (旧实现会发)', () => {
    const { events } = setup()
    key('keyup', 'KeyZ')
    expect(events.length).toBe(0)
  })

  it('重复 keyup 只发一个 up', () => {
    const { events } = setup()
    key('keydown', 'KeyZ')
    key('keyup', 'KeyZ')
    key('keyup', 'KeyZ')
    expect(events.filter((e) => e.type === 'up').length).toBe(1)
  })

  it('blur → 释放所有按住的键 (切窗不能卡键)', () => {
    const { events } = setup()
    key('keydown', 'KeyZ') // 60
    key('keydown', 'KeyS') // 62
    key('keydown', 'KeyX') // 64
    expect(events.length).toBe(3)

    window.dispatchEvent(new Event('blur'))
    const ups = events.filter((e) => e.type === 'up')
    expect(ups.length).toBe(3)
    expect(ups.map((e) => e.midi).sort((a, b) => a - b)).toEqual([60, 62, 64])
  })

  it('blur 之后再 keyup 不会重复发 up', () => {
    const { events } = setup()
    key('keydown', 'KeyZ')
    window.dispatchEvent(new Event('blur'))
    key('keyup', 'KeyZ')
    expect(events.filter((e) => e.type === 'up').length).toBe(1)
  })
})

// =============================================================================
// P1-7 MidiInput
// =============================================================================
describe('P1-7: MidiInput', () => {
  function setup() {
    const mi = new MidiInput()
    const events: NoteEvent[] = []
    mi.onEvent = (e) => events.push(e)
    return { mi, events }
  }

  /** 构造假的 MIDIMessageEvent */
  function msg(bytes: number[], timeStamp = 1234.5) {
    return { data: new Uint8Array(bytes), timeStamp } as unknown as MIDIMessageEvent
  }

  it('NoteOn / NoteOff 正常解析', () => {
    const { mi, events } = setup()
    ;(mi as any).onMessage(msg([0x90, 60, 100]))
    ;(mi as any).onMessage(msg([0x80, 60, 0]))
    expect(events.length).toBe(2)
    expect(events[0]).toMatchObject({ type: 'down', midi: 60, velocity: 100 })
    expect(events[1]).toMatchObject({ type: 'up', midi: 60 })
  })

  it('保留 e.timeStamp —— 不用 performance.now() 覆盖硬件时间戳', () => {
    const { mi, events } = setup()
    ;(mi as any).onMessage(msg([0x90, 60, 100], 999.25))
    expect(events[0].t).toBe(999.25)
  })

  it('timeStamp 非法 (为 0) 时回退到 performance.now()', () => {
    const { mi, events } = setup()
    const before = performance.now()
    ;(mi as any).onMessage(msg([0x90, 60, 100], 0))
    expect(events[0].t).toBeGreaterThanOrEqual(before)
  })

  it('running status: 1 字节消息复用上一条状态字节 (旧实现整个丢掉)', () => {
    const { mi, events } = setup()
    ;(mi as any).onMessage(msg([0x90, 60, 100])) // 状态字节 0x90
    ;(mi as any).onMessage(msg([61, 100])) // running status → NoteOn 61
    expect(events.length).toBe(2)
    expect(events[1]).toMatchObject({ type: 'down', midi: 61, velocity: 100 })
    ;(mi as any).onMessage(msg([61, 0])) // running status + vel 0 → NoteOff
    expect(events[2]).toMatchObject({ type: 'up', midi: 61 })
  })

  it('没有前置状态字节时, running status 不能猜 —— 丢掉', () => {
    const { mi, events } = setup()
    ;(mi as any).onMessage(msg([60, 100]))
    expect(events.length).toBe(0)
  })

  it('CC64 踏板: 值 >= 64 视为按下', () => {
    const { mi } = setup()
    expect(mi.isSustainOn()).toBe(false)
    ;(mi as any).onMessage(msg([0xb0, 64, 127]))
    expect(mi.isSustainOn()).toBe(true)
    ;(mi as any).onMessage(msg([0xb0, 64, 0]))
    expect(mi.isSustainOn()).toBe(false)
  })

  it('CC120 / CC123 (All Sound/Notes Off) → 释放所有按住的键', () => {
    const { mi, events } = setup()
    ;(mi as any).onMessage(msg([0x90, 60, 100]))
    ;(mi as any).onMessage(msg([0x90, 64, 100]))
    expect(mi.activeNotes().sort()).toEqual([60, 64])

    ;(mi as any).onMessage(msg([0xb0, 123, 0]))
    const ups = events.filter((e) => e.type === 'up').map((e) => e.midi).sort()
    expect(ups).toEqual([60, 64])
    expect(mi.activeNotes()).toEqual([])
  })

  it('stop() 释放按住的键 —— 不能让灯卡在按住状态', () => {
    const { mi, events } = setup()
    ;(mi as any).onMessage(msg([0x90, 60, 100]))
    mi.stop()
    expect(events.filter((e) => e.type === 'up').length).toBe(1)
    expect(mi.activeNotes()).toEqual([])
  })
})
