// MIDI Out 侧的回归测试
//
// 覆盖 spec P0-3 / P0-4:
//  - P0-3: 预览音 (previewNotes) 在 pause()/seek() 时必须补发配对 NoteOff,
//          否则电钢上那个键会一直压住 (MIDI Out 侧没有 stopAll 兜底)
//  - P0-4: panic() 必须发 CC#120 (All Sound Off) + CC#64=0 (Sustain Off)
//          + 每个还在响的音的显式 NoteOff, 并且 send 失败时不能无限递归

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Player } from '../src/engine/Player'
import { Accompaniment } from '../src/engine/Accompaniment'
import { useStore } from '../src/store'
import type { Song, SongNote } from '../src/types'

const C4 = 60

function makeSong(notes: SongNote[]): Song {
  return {
    notes,
    measures: [{ number: 1, time: 0, duration: 4 }],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 8,
    ppq: 480,
    hands: { left: 0, right: 1 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
  }
}

function n(time: number, midi: number, hand: 'left' | 'right', track = 0): SongNote {
  return { time, duration: 0.5, midiNote: midi, track, hand, velocity: 0.8 }
}

/** 记录所有 MIDI 消息的假 output */
function makeOutput() {
  const sent: number[][] = []
  const output = {
    id: 'out-1',
    name: 'Fake Out',
    state: 'connected',
    send: (bytes: number[]) => {
      sent.push([...bytes])
    },
  } as unknown as MIDIOutput
  return { sent, output }
}

/** 注入假 output 的 Accompaniment (绕过 connect() 的权限流程) */
function makeAcc() {
  const { sent, output } = makeOutput()
  const acc = new Accompaniment()
  ;(acc as any).output = output
  ;(acc as any).enabled = true
  return { acc, sent }
}

const synthStub = {
  setMasterVolume: () => {},
  resume: () => {},
  playNote: () => {},
  stopNote: () => {},
  stopAll: () => {},
}
const metronomeStub = { tick: () => {} }
const countdownStub = { start: (cb: () => void) => cb(), cancel: () => {} }

const isNoteOn = (b: number[]) => (b[0] & 0xf0) === 0x90
const isNoteOff = (b: number[]) => (b[0] & 0xf0) === 0x80
const isCC = (b: number[], cc: number) => (b[0] & 0xf0) === 0xb0 && b[1] === cc

function makePlayer(song: Song, acc: Accompaniment) {
  const player = new Player(
    song,
    synthStub as any,
    acc,
    metronomeStub as any,
    countdownStub as any,
  )
  // routeAccSnapshot 只有在 play() 时才会置 true; 测试里直接打开, 走 MIDI Out 分支
  ;(player as any).routeAccSnapshot = true
  return player
}

// =============================================================================
// P0-3 预览音必须成对释放
// =============================================================================
describe('P0-3: previewNotes 取消时必须补发 NoteOff', () => {
  beforeEach(() => {
    useStore.setState({ hand: 'right', transpose: 0, midiOutputId: 'out-1', isPlaying: false })
  })

  it('预览后立刻 pause → 收到配对 NoteOff', () => {
    const song = makeSong([n(0, C4, 'left', 0)])
    const { acc, sent } = makeAcc()
    const player = makePlayer(song, acc)

    player.previewNotes([song.notes[0]])
    const ons = sent.filter(isNoteOn)
    expect(ons.length).toBe(1)
    expect(ons[0][1]).toBe(C4)

    // 旧实现: cancelPreviewNotes() 只 clearTimeout → 一个 NoteOff 都没有
    player.pause()
    const offs = sent.filter(isNoteOff)
    expect(offs.length).toBe(1)
    expect(offs[0][1]).toBe(C4)
  })

  it('取消预览时还原 acc.transpose, 且 NoteOff 与 NoteOn 同音高', () => {
    const song = makeSong([n(0, C4, 'left', 0)])
    const { acc, sent } = makeAcc()
    acc.transpose = 3 // acc 侧实际移调
    useStore.setState({ transpose: 0 }) // store 侧是 0 —— 预览期间临时改写
    const player = makePlayer(song, acc)

    player.previewNotes([song.notes[0]])
    expect(acc.transpose).toBe(0) // 预览期间用 store 的移调
    const ons = sent.filter(isNoteOn)
    expect(ons[0][1]).toBe(C4) // NoteOn 用的是 store transpose

    player.pause()
    const offs = sent.filter(isNoteOff)
    expect(offs.length).toBe(1)
    expect(offs[0][1]).toBe(C4) // NoteOff 必须跟 NoteOn 同音高 (先发 NoteOff 再还原 transpose)
    expect(acc.transpose).toBe(3) // 还原成 acc 原来的移调
  })

  it('预览超时 (250ms) 自己释放, 不需要外部干预', () => {
    vi.useFakeTimers()
    try {
      const song = makeSong([n(0, C4, 'left', 0)])
      const { acc, sent } = makeAcc()
      const player = makePlayer(song, acc)

      player.previewNotes([song.notes[0]])
      expect(sent.filter(isNoteOff).length).toBe(0)
      vi.advanceTimersByTime(260)
      const offs = sent.filter(isNoteOff)
      expect(offs.length).toBe(1)
      expect(offs[0][1]).toBe(C4)
    } finally {
      vi.useRealTimers()
    }
  })
})

// =============================================================================
// P0-4 panic 必须彻底
// =============================================================================
describe('P0-4: Accompaniment.panic 必须彻底静音', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('发 CC#120 (All Sound Off) + CC#64=0 (Sustain Off) + 显式 NoteOff', () => {
    const { acc, sent } = makeAcc()
    acc.sendNoteOn(n(0, C4, 'right'))
    expect(sent.filter(isNoteOn).length).toBe(1)

    sent.length = 0
    acc.panic()

    // 旧实现只发 CC#123 —— 踏板踩着时音会一直响
    expect(sent.filter((b) => isCC(b, 120)).length).toBe(16)
    expect(sent.filter((b) => isCC(b, 64)).length).toBe(16)
    expect(sent).toContainEqual([0x80, C4, 0]) // 显式关掉还在响的音
  })

  it('已经正常释放的音不会再出现在 panic 的显式 NoteOff 里', () => {
    const { acc, sent } = makeAcc()
    acc.sendNoteOn(n(0, C4, 'right'))
    acc.sendNoteOff(n(0, C4, 'right'))

    sent.length = 0
    acc.panic()
    expect(sent.filter(isNoteOff).length).toBe(0)
  })

  it('send 失败时不会无限递归 (trySend → panic → trySend)', () => {
    let calls = 0
    const acc = new Accompaniment()
    ;(acc as any).output = {
      id: 'dead',
      state: 'connected',
      send: () => {
        calls++
        throw new Error('device gone')
      },
    }
    ;(acc as any).enabled = true
    let disconnects = 0
    acc.onDisconnect = () => {
      disconnects++
    }

    acc.panic()
    expect(calls).toBeLessThan(20) // 没有无限递归
    expect(disconnects).toBeGreaterThanOrEqual(1)
  })

  it('use(null) 关掉伴奏时也会 panic 旧设备', () => {
    const { sent, output } = makeOutput()
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['out-1', output]]) }

    acc.use('out-1')
    expect(acc.isEnabled()).toBe(true)

    sent.length = 0
    acc.use(null)
    expect(sent.filter((b) => isCC(b, 120)).length).toBe(16)
    expect(acc.isEnabled()).toBe(false)
  })
})

// =============================================================================
// P0-4 续: 暂停时电钢必须真的安静 (CC#120), 但循环回卷不能掐
// =============================================================================
describe('P0-4: 暂停时 MIDI Out 要安静下来', () => {
  beforeEach(() => {
    useStore.setState({
      hand: 'right',
      transpose: 0,
      midiOutputId: 'out-1',
      isPlaying: false,
      loopRange: null,
    })
  })

  it('pause 时发 CC#120 (All Sound Off) —— 踩着延音踏板也能立刻安静', () => {
    const song = makeSong([n(0, C4, 'left', 0)])
    const { acc, sent } = makeAcc()
    const player = makePlayer(song, acc)

    acc.sendNoteOn(song.notes[0]) // app 发过一个音
    sent.length = 0
    player.pause()

    expect(sent.filter((b) => isCC(b, 120)).length).toBe(16)
  })

  it('app 没往电钢发过音 (both 模式) → pause 不该动用户的电钢', () => {
    const song = makeSong([n(0, C4, 'left', 0)])
    const { acc, sent } = makeAcc()
    const player = makePlayer(song, acc)
    useStore.setState({ hand: 'both' }) // both 模式 route 走 silent, app 不发音

    sent.length = 0
    player.pause()

    expect(sent.filter((b) => isCC(b, 120)).length).toBe(0)
  })

  it('循环回卷不触发 CC#120 —— 否则每圈都会切掉用户自己按住的音', () => {
    const song = makeSong([n(0, C4, 'left', 0), n(1.5, C4, 'left', 0)])
    const { acc, sent } = makeAcc()
    const player = makePlayer(song, acc)
    useStore.getState().setLoopRange([0, 1])

    // 跑够帧数越过 loop 尾 (1.0s) → 触发回卷
    for (let i = 0; i < 80; i++) (player as any).stepLoop()
    expect(player.getCurrentTime()).toBeLessThan(1)

    expect(sent.filter((b) => isCC(b, 120)).length).toBe(0)
  })
})

// =============================================================================
// P1-12: 连接状态拆分 (用户选择的设备 vs 运行时实际可用)
// =============================================================================
describe('P1-12: MIDI Out 连接状态', () => {
  it('use(id) 选到设备 → connected=true 并通知 UI', () => {
    const { output } = makeOutput()
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['out-1', output]]) }
    const seen: boolean[] = []
    acc.onConnectionChange = (c) => seen.push(c)

    acc.use('out-1')
    expect(acc.isConnected()).toBe(true)
    expect(acc.isEnabled()).toBe(true)
    expect(seen).toEqual([true])
  })

  it('use(null) 关掉伴奏 → connected=false', () => {
    const { output } = makeOutput()
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['out-1', output]]) }
    acc.use('out-1')
    const seen: boolean[] = []
    acc.onConnectionChange = (c) => seen.push(c)

    acc.use(null)
    expect(acc.isConnected()).toBe(false)
    expect(seen).toEqual([false])
  })

  it('选了一个不存在的设备 → connected=false (不是绿色)', () => {
    const { output } = makeOutput()
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['out-1', output]]) }
    acc.use('不存在的id')
    expect(acc.isConnected()).toBe(false)
  })

  it('send 抛错 (设备被拔) → connected=false + onDisconnect 只触发一次', () => {
    const dead = {
      id: 'dead',
      state: 'connected',
      send: () => { throw new Error('device gone') },
    } as unknown as MIDIOutput
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['dead', dead]]) }
    acc.use('dead')
    expect(acc.isConnected()).toBe(true)

    let disconnected = 0
    acc.onDisconnect = () => { disconnected++ }
    const seen: boolean[] = []
    acc.onConnectionChange = (c) => seen.push(c)

    acc.sendNoteOn(n(0, C4, 'right'))
    expect(acc.isConnected()).toBe(false)
    // 只报一次 —— 否则 App 会弹两次重连弹窗
    expect(disconnected).toBe(1)
    expect(seen).toEqual([false])
  })

  it('output.state 变成 disconnected → refresh() 后 connected=false', () => {
    const { output } = makeOutput()
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['out-1', output]]) }
    acc.use('out-1')
    expect(acc.isConnected()).toBe(true)

    ;(output as any).state = 'disconnected'
    ;(acc as any).refresh()
    expect(acc.isConnected()).toBe(false)
  })

  it('断连后仍保留用户选的 id —— 便于自动重连, UI 另行显示断开', () => {
    const { output } = makeOutput()
    const acc = new Accompaniment()
    ;(acc as any).access = { outputs: new Map([['out-1', output]]) }
    acc.use('out-1')
    ;(output as any).state = 'disconnected'
    ;(acc as any).refresh()
    // 用户的选择还在 (App 用它提示重连), 但运行时状态是断开的
    expect((acc as any).outputId).toBe('out-1')
    expect(acc.isConnected()).toBe(false)
  })
})
