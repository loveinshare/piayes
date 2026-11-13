// Player 引擎 e2e 测试
//
// 验证 PlayAlong (neothesia 端口) 的核心场景:
//  1. 重复 midi (C4 在 t=1.0 和 t=1.5) 各自分别计分, 不互相覆盖
//  2. Wait 模式 + 用户漏弹 → 冻结 currentTime (required 非空), 直到弹对 (清空 required)
//  3. 用户提前 50ms 弹 (recent press) + 文件 NoteOn 到达 → 算 hit (early)
//  4. Wait 模式 + 用户漏弹很久后补弹 → 算 hit (late)
//  5. 用户弹错音 → 不算 hit, 不影响其他 (wrong counter +1)
//  6. 和弦 (3 个同时) → required 一次清 3 个才解冻
//  7. 漏弹后补弹 → misses 撤销
//  8. 同 midi 多 hand 同时存在, 一次按全部命中 (Bach BWV 1041 chord)

import { describe, it, expect, beforeEach } from 'vitest'
import { Player } from '../src/engine/Player'
import { useStore } from '../src/store'
import type { Song, SongNote } from '../src/types'

function makeSong(notes: SongNote[]): Song {
  return {
    notes,
    measures: [
      { number: 1, time: 0, duration: 4 },
      { number: 2, time: 4, duration: 4 },
    ],
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

const C4 = 60, E4 = 64, G4 = 67, D4 = 62

function makeStubs() {
  const synth = {
    setMasterVolume: () => {},
    resume: () => {},
    playNote: () => {},
    stopNote: () => {},
    stopAll: () => {},
  }
  const acc = {
    transpose: 0,
    isEnabled: () => false, // 让 route 永远走 silent/synth 兜底
    setVolume: () => {},
    sendNoteOn: () => {},
    sendNoteOff: () => {},
    panic: () => {},
    silence: () => {},
  }
  const metronome = { tick: (_accent: boolean) => {} }
  // countdown.start 立即调回调 (测试时跳过倒计时)
  const countdown = { start: (_cb: () => void) => _cb(), cancel: () => {} }
  return { synth, acc, metronome, countdown }
}

function makePlayer(song: Song) {
  const { synth, acc, metronome, countdown } = makeStubs()
  const player = new Player(song, synth as any, acc as any, metronome as any, countdown as any)
  useStore.getState().resetScore()
  useStore.getState().setSong(song)
  useStore.setState({
    hand: 'both',
    wait: true,
    waitMs: 400,
    transpose: 0,
    speed: 1,
    currentTime: 0,
    isPlaying: false,
  })
  return { player }
}

function step(player: Player, frames: number) {
  const p = player as any
  for (let i = 0; i < frames; i++) p.stepLoop()
}

function press(player: Player, midi: number) {
  player.handleInput({ type: 'down', midi, velocity: 0.8, t: 0, source: 'input' })
}

// =============================================================================
// 1. 重复 midi 独立计分 — noteIndex 键保证
// =============================================================================
describe('1. 重复 midi 独立计分', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('两个不同 midi 各自分别计分, 不互相覆盖 (noteIndex 键)', () => {
    // 用 C4 + E4: 不同 midi, 每个独立命中
    const song = makeSong([n(1.0, C4), n(1.5, E4)])
    const { player } = makePlayer(song)
    step(player, 65) // 1.04s, C4 schedule 进 required, 冻

    press(player, C4) // 弹第 1 个, 命中
    let states = (player as any).getNoteStates()
    expect(states.get(0)).toBe('hit')
    expect(states.get(1)).not.toBe('hit')

    step(player, 35) // 1.04 + 0.56 = 1.60, E4 schedule 进 required, 冻
    press(player, E4) // 弹第 2 个, 命中
    states = (player as any).getNoteStates()
    expect(states.get(0)).toBe('hit')
    expect(states.get(1)).toBe('hit')
    expect(useStore.getState().hits).toBe(2)
  })

  it('同 midi 重复 (C4@1.0 + C4@1.5) — 第 2 次必须按才算 hit (不依赖 recent)', () => {
    // 同 midi 0.5s 间隔下, recent 仍在 perf.now 500ms 内, 但 'late' 命中不写 recent
    // → 第 2 个 C4 schedule 后, 仍需用户再按一次
    const song = makeSong([n(1.0, C4), n(1.5, C4)])
    const { player } = makePlayer(song)
    step(player, 65) // 1.04s, C4#1 schedule, 冻
    press(player, C4) // hit#1
    expect((player as any).getNoteStates().get(0)).toBe('hit')
    step(player, 35) // 推进, C4#2 schedule, 冻
    expect((player as any).getNoteStates().get(1)).toBe('late') // 仍 required
    press(player, C4) // hit#2
    expect((player as any).getNoteStates().get(1)).toBe('hit')
    expect(useStore.getState().hits).toBe(2)
  })
})

// =============================================================================
// 2. Wait 模式 + 冻结
// =============================================================================
describe('2. Wait 模式 + 冻结', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('漏弹 → 冻结 (required 非空); 弹对 → 解冻', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    step(player, 130) // 2.08s, C4 仍 required, 时间必须冻
    expect(player.isFrozen()).toBe(true)
    const frozenTime = player.getCurrentTime()
    // 再走一帧, currentTime 不能涨
    step(player, 10)
    expect(player.getCurrentTime()).toBe(frozenTime)
    expect(player.isFrozen()).toBe(true)

    press(player, C4) // 命中, 清空 required
    step(player, 1)
    expect(player.isFrozen()).toBe(false)
    expect(player.getCurrentTime()).toBeGreaterThan(frozenTime)
  })
})

// =============================================================================
// 3. Anticipation (用户提前弹, recent press)
// =============================================================================
describe('3. Anticipation (用户提前弹)', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('用户提前 ~50ms 按 C4, 文件 NoteOn 到达 → 算 hit (early)', () => {
    const song = makeSong([n(2.0, C4)])
    const { player } = makePlayer(song)
    // 推进到 ~1.95s (~ 122 帧)
    step(player, 122)
    expect(player.getCurrentTime()).toBeGreaterThan(1.9)
    expect(player.getCurrentTime()).toBeLessThan(2.0)

    press(player, C4) // 入 recent
    step(player, 5) // 跑到 2.03s, NoteOn 触发, 命中 recent
    expect(player.getNoteStates().get(0)).toBe('hit')
    expect(player.isFrozen()).toBe(false)
  })
})

// =============================================================================
// 4. Late rescue (用户漏弹很久后补弹)
// =============================================================================
describe('4. Late rescue (晚期补弹, Wait 模式)', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('冻结后用户在 0.7s 时补弹 → required 清空, 解冻', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    step(player, 130) // 2.08s, C4 仍 required, 冻
    expect(player.isFrozen()).toBe(true)

    press(player, C4)
    expect(player.getNoteStates().get(0)).toBe('hit')
    step(player, 1)
    expect(player.isFrozen()).toBe(false)
  })
})

// =============================================================================
// 5. 弹错音 — recent 语义 (单次错音 → recent; 重复 → wrong)
// =============================================================================
describe('5. 弹错音', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('单次弹 D4 (错音) → 入 recent, 不算 wrong, C4 仍 required (冻结)', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    step(player, 65) // 1.04s, C4 进 required, 冻
    useStore.setState({ errors: 0 })
    press(player, D4) // 错音 → recent[D4] (可能 early-hit 后续 D4)
    expect(useStore.getState().errors).toBe(0) // 单次不计错
    expect(player.getNoteStates().get(0)).not.toBe('hit') // C4 未消
    expect(player.isFrozen()).toBe(true) // required 仍非空, 仍冻
  })

  it('同错音 2 次 (recent 内) → errors +1', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    step(player, 65)
    useStore.setState({ errors: 0 })
    press(player, D4) // 第一次 → recent
    press(player, D4) // 第二次 (同 midi, recent 内) → wrong +1
    expect(useStore.getState().errors).toBe(1)
  })

  // 修 #7: wait 模式 + 弹错音 → errors 仍 +1 (这是真实错音记录), 但不弹 wrong toast
  // (用户在等弹对, toast 是干扰; wait 模式本身的 freeze + 提示已经够了)
  it('修 #7: wait 模式下错音 → errors +1, 但不弹 wrong toast (lastWrongMidi 仍 null)', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    useStore.setState({ wait: true })  // wait 模式 (默认就是 true)
    step(player, 65)  // C4 进 required, 冻
    expect(player.isFrozen()).toBe(true)
    useStore.setState({ errors: 0, lastWrongMidi: null })
    press(player, D4)  // 第一次错 → recent, 不算错
    press(player, D4)  // 第二次错 → wrong +1
    expect(useStore.getState().errors).toBe(1)
    // 关键: wait 模式下不应弹 toast
    expect(useStore.getState().lastWrongMidi).toBe(null)
  })

  // 修 #7: wait=false 模式下 (体验练) 错音 → 该弹 toast 告诉用户
  it('修 #7: wait=false 模式下错音 → errors +1, 弹 wrong toast (lastWrongMidi 有值)', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    useStore.setState({ wait: false })  // 体验练, 不冻结
    step(player, 65)  // 时间继续走 (wait=false), C4 进 required
    useStore.setState({ errors: 0, lastWrongMidi: null })
    press(player, D4)  // 第一次 → recent
    press(player, D4)  // 第二次 → wrong +1 + toast
    expect(useStore.getState().errors).toBe(1)
    // 体验练模式: toast 该弹
    expect(useStore.getState().lastWrongMidi).toBe(D4)
  })
})

// =============================================================================
// 6. 和弦必须全部命中
// =============================================================================
describe('6. 和弦: 全部命中才解冻', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('C4+E4+G4 同时, 只弹 C4 → 仍冻结; 弹完 3 个 → 解冻', () => {
    const song = makeSong([n(1.0, C4), n(1.0, E4), n(1.0, G4)])
    const { player } = makePlayer(song)
    step(player, 65) // schedule 3 个进 required
    expect(player.isFrozen()).toBe(true)

    press(player, C4)
    expect(player.getNoteStates().get(0)).toBe('hit')
    expect(player.isFrozen()).toBe(true)

    press(player, E4)
    expect(player.isFrozen()).toBe(true)

    press(player, G4)
    step(player, 1)
    expect(player.isFrozen()).toBe(false) // 解冻
  })
})

// =============================================================================
// 7. file NoteOff 时仍未弹 → miss 计数
// =============================================================================
describe('7. miss 计数 (文件 NoteOff 时仍未弹)', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('wait 关闭 → 时间推进过 note end → misses +1', () => {
    // 关闭 wait 才能让 currentTime 推进过 note end (否则 wait 会冻在 required)
    // 单 note, duration=0.2 → fileNoteOff 在 currentTime > 1.2s 触发
    const note: SongNote = { ...n(1.0, C4), duration: 0.2 }
    const song = makeSong([note])
    const { player } = makePlayer(song)
    useStore.setState({ wait: false })
    step(player, 200) // 3.2s, 远超 1.2 (noteOff 触发 miss)
    // misses 计数器 +1 (UI 上面 'miss' 染色是 FallingNotes dt<-0.5 已经过滤掉, 不靠 getNoteStates 标)
    expect(useStore.getState().misses).toBe(1)
  })

  it('wait 开启时 → 时间冻在 required, 不会 miss', () => {
    const note: SongNote = { ...n(1.0, C4), duration: 0.2 }
    const song = makeSong([note])
    const { player } = makePlayer(song)
    // wait=true (默认), step 任意远 → 时间冻在 1.04
    step(player, 200)
    expect(player.isFrozen()).toBe(true)
    expect(player.getNoteStates().get(0)).toBe('late') // 仍 required, 不是 miss
    expect(useStore.getState().misses).toBe(0)
  })
})

// =============================================================================
// 8. 同 midi 多 hand 同时, 一次按全部命中 (Bach BWV 1041)
// =============================================================================
describe('8. 同 midi 多 hand 同时存在, 一次按全部命中', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('hand=both: chord 内多 hand 同 midi, 按一次命中所有 active hand 该 midi', () => {
    const song: Song = {
      ...makeSong([
        { ...n(1.0, C4), hand: 'right' },
        { ...n(1.0, C4), hand: 'left' },
        { ...n(1.0, E4), hand: 'left' },
        { ...n(1.0, G4), hand: 'left' },
      ]),
      hands: { left: 1, right: 0 },
    }
    const { player } = makePlayer(song)
    step(player, 66) // 全部 4 个 schedule 进 required (active-hand)
    expect(player.getNoteStates().get(0)).toBe('late')
    expect(player.getNoteStates().get(1)).toBe('late')
    expect(player.getNoteStates().get(2)).toBe('late')
    expect(player.getNoteStates().get(3)).toBe('late')

    press(player, C4) // 一次按, 期望命中 i=0 (right) + i=1 (left) 同 midi
    expect(player.getNoteStates().get(0)).toBe('hit')
    expect(player.getNoteStates().get(1)).toBe('hit')
    expect(useStore.getState().hits).toBe(2)
    // E4, G4 仍未 hit
    expect(player.getNoteStates().get(2)).not.toBe('hit')
    expect(player.getNoteStates().get(3)).not.toBe('hit')

    press(player, E4)
    expect(player.getNoteStates().get(2)).toBe('hit')
    expect(player.isFrozen()).toBe(true) // G4 仍 pending

    press(player, G4)
    step(player, 1)
    expect(player.getNoteStates().get(3)).toBe('hit')
    expect(player.isFrozen()).toBe(false) // 全 hit, 解冻
    expect(useStore.getState().hits).toBe(4)
  })
})

// =============================================================================
// 9. effectiveWait 与 Wait toggle UX (修过 #1+#2 后的回归)
// =============================================================================
describe('9. effectiveWait 与 follow-along 实战场景', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('both + wait=true → 漏弹即冻', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'both', wait: true })
    step(player, 130) // 2.08s
    expect(player.isFrozen()).toBe(true)
  })

  it('both + wait=false → 不冻 (用户主动关掉 wait)', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'both', wait: false })
    step(player, 130)
    expect(player.isFrozen()).toBe(false)
  })

  it('playback 模式 wait=true → 不冻 (永远)', () => {
    const song = makeSong([n(1.0, C4)])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'playback', wait: true })
    step(player, 130)
    expect(player.isFrozen()).toBe(false)
  })

  // 用户报告的实战场景: 切到 hand=right + wait=true, 应该冻在第一个右手音上
  it('hand=right + wait=true + 双声部 song: 第一个右手音到了就该冻', () => {
    const song: Song = {
      ...makeSong([
        { ...n(1.0, 60), track: 0, hand: 'left' },
        { ...n(1.0, 64), track: 1, hand: 'right' },
      ]),
      hands: { left: 0, right: 1 },
    }
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'right', wait: true })
    step(player, 66)
    expect(player.isFrozen()).toBe(true)
    expect((player as any).playAlong.requiredSize()).toBe(1)
    press(player, 64)
    step(player, 1)
    expect(player.isFrozen()).toBe(false)
  })

  // 用户操作的真实流程: 先 playback 听一遍 → 中途切到 right+wait
  it('playback 听了一段后切到 right+wait: 后续该冻的还是会冻', () => {
    const song: Song = {
      ...makeSong([
        { ...n(0.5, 64), track: 1, hand: 'right' },
        { ...n(3.0, 67), track: 1, hand: 'right' },
        { ...n(3.0, 60), track: 0, hand: 'left' },
      ]),
      hands: { left: 0, right: 1 },
    }
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'playback', wait: true })
    step(player, 70)
    expect(player.isFrozen()).toBe(false)
    useStore.setState({ hand: 'right', wait: true })
    step(player, 120)
    expect(player.isFrozen()).toBe(true)
    expect((player as any).playAlong.requiredSize()).toBe(1)
  })

  // 修 #1: stepLoop 跳过 currentTime < 0.5s 的冻结 — 给用户半秒预览
  it('修 #1: 第一个 note 在 t=0 也至少给 0.5s 预览才冻', () => {
    // 长音 (duration=2.0) — 确保 0.5s 时还在响, 是合理的 wait target
    const longNote: SongNote = { ...n(0.0, C4), duration: 2.0 }
    const song = makeSong([longNote])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'both', wait: true })
    // 推进 0.3s (~19 帧): currentTime=0.304, 还没过预览窗 → 不该冻
    step(player, 19)
    expect(player.isFrozen()).toBe(false)
    // 推进到 currentTime > 0.5 → 进入 freeze
    step(player, 20)
    expect(player.isFrozen()).toBe(true)
  })
})

// =============================================================================
// 10. 循环回卷 (spec P0-1 / P0-2)
//    - P0-1: 回卷不能把 isPlaying 打成 false (旧实现 pause() 后没人设回 true)
//    - P0-2: 回卷不能把已命中的音重新 required (hits 会重复累加)
// =============================================================================
describe('10. 循环回卷', () => {
  beforeEach(() => {
    useStore.getState().resetScore()
    useStore.getState().clearLoopRange()
  })

  it('P0-1: 回卷后 isPlaying 仍为 true (旧实现 pause() 后没人设回 true)', () => {
    const song = makeSong([n(0, C4), n(1.5, E4)])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'playback', wait: false })
    useStore.getState().setLoopRange([0, 1])
    useStore.getState().setIsPlaying(true)

    // 推进 80 帧 ≈ 1.28s → 越过 loop 尾 (1.0s) 触发回卷
    step(player, 80)
    expect(player.getCurrentTime()).toBeLessThan(1) // 已回卷
    // 旧实现: pause() → setIsPlaying(false), 之后没人设回 true
    expect(useStore.getState().isPlaying).toBe(true)
  })

  it('P0-2: 回卷后 hits 不重复累加, 已命中的音保持 hit', () => {
    const song = makeSong([n(0, C4), n(1.5, E4)])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'both', wait: false })
    useStore.getState().setLoopRange([0, 1])

    // 第一遍: C4 弹中
    step(player, 2)
    expect((player as any).playAlong.requiredSize()).toBe(1)
    press(player, C4)
    expect(useStore.getState().hits).toBe(1)
    expect(player.getNoteStates().get(0)).toBe('hit')

    // 推进越过 loop 尾 → 回卷
    step(player, 80)
    expect(player.getCurrentTime()).toBeLessThan(1)
    expect(useStore.getState().hits).toBe(1)
    expect(player.getNoteStates().get(0)).toBe('hit')

    // 第二遍: C4 再次被调度, 但用户已弹过 → 不该再 required, hits 不再涨
    step(player, 2)
    expect((player as any).playAlong.requiredSize()).toBe(0)
    expect(useStore.getState().hits).toBe(1)
  })

  it('P0-2: 回卷保留本轮统计 (miss 不被清零)', () => {
    const song = makeSong([n(0, C4), n(1.5, E4)])
    const { player } = makePlayer(song)
    // tolerance 100ms: 让 miss 在回卷前就判定完 (默认 500ms 会拖到回卷之后)
    useStore.setState({ hand: 'both', wait: false, toleranceMs: 100 })
    useStore.getState().setLoopRange([0, 1])

    // 第一遍: C4 不弹 → grace 过期后记 miss
    step(player, 40)
    expect(useStore.getState().misses).toBe(1)

    // 越过 loop 尾 → 回卷 (resetPass 只清 required/recent, 保留 stats)
    step(player, 50)
    expect(player.getCurrentTime()).toBeLessThan(1)
    expect(useStore.getState().misses).toBe(1)
    expect((player as any).playAlong.stats.miss).toBe(1)
  })

  it('对照: 普通 seek() (无 preserveScore) 仍清空命中集合', () => {
    const song = makeSong([n(0, C4)])
    const { player } = makePlayer(song)
    useStore.setState({ hand: 'both', wait: false })

    step(player, 2)
    press(player, C4)
    expect(player.getNoteStates().get(0)).toBe('hit')

    player.seek(0)
    expect(player.getNoteStates().get(0)).toBeUndefined()
  })
})

// =============================================================================
// 11. P1-13: 同一 midi 的左右手在 synth 上必须是两个独立声部
// =============================================================================
describe('11. Synthesizer 声部隔离 (P1-13)', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('左右手同名音 → playNote 收到两个不同的 voiceId', () => {
    const song: Song = {
      ...makeSong([
        { ...n(1.0, C4), hand: 'right' },
        { ...n(1.0, C4), hand: 'left' },
      ]),
      hands: { left: 1, right: 0 },
    }
    const played: { midi: number; id: number }[] = []
    const synth = {
      setMasterVolume: () => {},
      resume: () => {},
      playNote: (note: SongNote, transpose: number, id: number) => {
        played.push({ midi: note.midiNote + transpose, id })
      },
      stopNote: () => {},
      stopAll: () => {},
    }
    const { metronome, countdown } = makeStubs()
    const player = new Player(
      song,
      synth as any,
      makeStubs().acc as any,
      metronome as any,
      countdown as any,
    )
    useStore.setState({ hand: 'playback', wait: false })

    step(player, 66) // 两个同名音都被调度
    expect(played.length).toBe(2)
    expect(played[0].midi).toBe(played[1].midi) // 同一音高
    expect(played[0].id).not.toBe(played[1].id) // 但必须是不同声部
  })
})

// =============================================================================
// 12. P1-6: seek 要补跨界持续音
// =============================================================================
describe('12. seek 补跨界持续音 (P1-6)', () => {
  beforeEach(() => useStore.getState().resetScore())

  function makeRecordedPlayer(song: Song) {
    const played: { midi: number; id: number }[] = []
    const synth = {
      setMasterVolume: () => {},
      resume: () => {},
      playNote: (note: SongNote, transpose: number, id: number) => {
        played.push({ midi: note.midiNote + transpose, id })
      },
      stopNote: () => {},
      stopAll: () => {},
    }
    const { acc, metronome, countdown } = makeStubs()
    const player = new Player(
      song,
      synth as any,
      acc as any,
      metronome as any,
      countdown as any,
    )
    return { player, played }
  }

  it('seek 到长音中间 → 该音进入 playingNotes 并补发 NoteOn', () => {
    const longNote: SongNote = { ...n(0, C4), duration: 4.0 }
    const song = makeSong([longNote])
    const { player, played } = makeRecordedPlayer(song)
    useStore.setState({ hand: 'playback', wait: false })

    player.seek(2.0)
    // 跨界音在跳转点还在响
    expect(player.getPlayingNotes().size).toBe(1)
    expect(player.getPlayingNotes().has(longNote)).toBe(true)
    // 暂停态不该立刻发声 (否则又是"UI 暂停、电钢在响")
    expect(played.length).toBe(0)

    // 开始播放 → 补发 NoteOn
    step(player, 1)
    expect(played.length).toBe(1)
    expect(played[0].midi).toBe(C4)
  })

  it('跨界音按 note.time + duration 正常收尾', () => {
    const longNote: SongNote = { ...n(0, C4), duration: 4.0 }
    const song = makeSong([longNote])
    const { player } = makeRecordedPlayer(song)
    useStore.setState({ hand: 'playback', wait: false })

    player.seek(2.0)
    step(player, 1)
    expect(player.getPlayingNotes().size).toBe(1)

    // 推进到 4.0s 之后 → 收尾
    step(player, 130) // 2.016 + 130 * 0.016 = 4.096
    expect(player.getPlayingNotes().size).toBe(0)
  })

  it('seek 到没有跨界音的位置 → 不多发 NoteOn', () => {
    const song = makeSong([n(0, C4), n(6, E4)])
    const { player, played } = makeRecordedPlayer(song)
    useStore.setState({ hand: 'playback', wait: false })

    player.seek(3.0) // C4 已结束, E4 还没开始
    step(player, 1)
    expect(player.getPlayingNotes().size).toBe(0)
    expect(played.length).toBe(0)
  })
})
