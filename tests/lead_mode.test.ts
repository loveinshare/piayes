// 抢先模式 (Lead mode) —— spec §R23
//
// 抢先 = Wait + 「弹对了才推进」. 用户 2026-11-08 重新定义, 三条铁律:
//
//  1. **提前按不报错** —— 弹的不是当前待弹的音 → 什么都不做 (不判错).
//  2. **灯一直亮到弹对为止** —— 不超时自动跳过, 不自动记漏弹.
//  3. **判定不受容差影响**, 也不查「上一轮弹过的键」 (PlayAlong.recent).
//
// ★ 2026-11-10 修订 (用户: 「切换到抢先, 完全不会停下来对的音」):
//   抢先**恢复 Wait 的冻结** —— 播放头冻在「现在该弹的那一组」的精确时间上,
//   弹对了才解冻, 然后按 1× 走到下一个待弹组再冻上.
//   (2026-11-08 那一版把冻结整个关掉了, 播放头一直走 → 瀑布跟提示永远对不上.)
//   倍率恒为 1 —— 冻住了就没法加速, 「UI 跟着玩家速度走」那一路作废.
//
// 测的是 Player 的行为 (提示的内容 + 游标的推进 + 冻结),
// 灯带的差分逻辑见 tests/lead_strip.test.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { Player } from '../src/engine/Player'
import { SongClock } from '../src/engine/Clock'
import { useStore, effectiveLead } from '../src/store'
import { FakeAudioContext } from './fakeClock'
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

const C4 = 60, D4 = 62, E4 = 64

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
    isEnabled: () => false,
    setVolume: () => {},
    sendNoteOn: () => {},
    sendNoteOff: () => {},
    panic: () => {},
    silence: () => {},
  }
  const metronome = { tick: (_accent: boolean) => {} }
  const countdown = { start: (_cb: () => void) => _cb(), cancel: () => {} }
  return { synth, acc, metronome, countdown }
}

/** 抢先模式: 双手练习 (播放头跟着玩家走) + Wait 开 + 抢先开 */
function makePlayer(song: Song, leadNext = true) {
  const { synth, acc, metronome, countdown } = makeStubs()
  const player = new Player(song, synth as any, acc as any, metronome as any, countdown as any)
  useStore.getState().resetScore()
  useStore.getState().setSong(song)
  useStore.setState({
    hand: 'both',
    wait: true,
    waitMs: 400,
    leadNext,
    transpose: 0,
    speed: 1,
    currentTime: 0,
    isPlaying: false,
  })
  return { player }
}

/** 抢先模式: 单手 (右手) 练习 —— 伴奏走 MIDI Out, 用假音频时钟观察它的节奏 */
function makeSingleHandPlayer(song: Song, leadNext = true) {
  const { synth, metronome, countdown } = makeStubs()
  const ctx = new FakeAudioContext()
  const clock = new SongClock({ ctx: ctx as unknown as AudioContext })
  /** 伴奏的发声记录 (note 的谱面时间 + 排程到的 ctx 时刻) */
  const accEvents: { time: number; when: number | undefined }[] = []
  const acc = {
    transpose: 0,
    isEnabled: () => true, // 伴奏走 MIDI Out (看得见)
    setVolume: () => {},
    sendNoteOn: (note: SongNote, when?: number) => {
      accEvents.push({ time: note.time, when })
    },
    sendNoteOff: () => {},
    panic: () => {},
    silence: () => {},
  }
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
  useStore.getState().resetScore()
  useStore.getState().setSong(song)
  useStore.setState({
    hand: 'right',
    wait: true,
    waitMs: 400,
    leadNext,
    transpose: 0,
    speed: 1,
    currentTime: 0,
    isPlaying: false,
  })
  // play() 会拍下路由快照 (acc.isEnabled() → 伴奏走 MIDI Out) 并把时钟锚到 0.
  // 定时器要掐掉 —— 测试自己推帧 (假音频时钟).
  player.play()
  clearInterval((player as any).timer)
  return { player, ctx, accEvents }
}

/** 逻辑时钟下走帧 (每帧 16ms) */
function step(player: Player, frames: number) {
  const p = player as any
  for (let i = 0; i < frames; i++) p.stepLoop()
}

/** 假音频时钟模式下走帧 (音频时钟是主时钟 → 每帧要手动推 16ms) */
function stepCtx(player: Player, ctx: FakeAudioContext, frames: number) {
  const p = player as any
  for (let i = 0; i < frames; i++) {
    ctx.advance(0.016)
    p.stepLoop()
  }
}

function press(player: Player, midi: number) {
  player.handleInput({ type: 'down', midi, velocity: 0.8, t: 0, source: 'input' })
}

/** 提示里某只手该弹的音高列表 */
function hintMidis(player: Player, hand: 'left' | 'right'): number[] {
  const hint = player.getLeadHint()
  if (!hint) return []
  const h = hint.hands.find((x) => x.hand === hand)
  return h ? h.notes.map((x) => x.midiNote) : []
}

/** 提示里有哪几只手 */
function hintHands(player: Player): string[] {
  const hint = player.getLeadHint()
  if (!hint) return []
  return hint.hands.map((x) => x.hand)
}

/** 提示里某只手那一组的谱面时间 */
function hintTime(player: Player, hand: 'left' | 'right'): number {
  const hint = player.getLeadHint()
  if (!hint) return NaN
  const h = hint.hands.find((x) => x.hand === hand)
  return h ? h.time : NaN
}

/** 当前的速度倍率 (抢先模式的加速) */
function rate(player: Player): number {
  return (player as any).clock.getRate() as number
}

// =============================================================================
// 1. 提示的形状: 每只手一份 (第一排同时有左手和右手的灯)
// =============================================================================
describe('1. 抢先模式: 提示按手拆开', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('双手 → 第一排同时有左手和右手的灯', () => {
    const song = makeSong([
      n(1.0, 48, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, 50, 'left'),
      n(2.0, D4, 'right'),
    ])
    const { player } = makePlayer(song)
    step(player, 1)
    expect(hintHands(player).sort()).toEqual(['left', 'right'])
    expect(hintMidis(player, 'left')).toEqual([48])
    expect(hintMidis(player, 'right')).toEqual([C4])
  })

  it('单手 → 玩家那只手 + 伴奏那只手各有一份提示', () => {
    const song = makeSong([
      n(0, 48, 'left'),
      n(1.0, 50, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, D4, 'right'),
    ])
    const { player, ctx } = makeSingleHandPlayer(song)
    stepCtx(player, ctx, 70) // t ≈ 1.12s
    expect(hintHands(player).sort()).toEqual(['left', 'right'])
    // 右手 = 玩家要弹的那一组; 左手 = 伴奏正在响的那一组 (正常显示)
    expect(hintMidis(player, 'right')).toEqual([C4])
    expect(hintMidis(player, 'left')).toEqual([50])
  })

  it('抢先关掉 → 没有提示 (灯带回到普通语义)', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song, false)
    step(player, 5)
    expect(player.getLeadHint()).toBeNull()
  })

  it('Wait 关掉 → 抢先失效 (没有提示)', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song, true)
    useStore.setState({ wait: false })
    step(player, 5)
    expect(player.getLeadHint()).toBeNull()
  })

  it('playback 模式 → 抢先失效', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song, true)
    useStore.setState({ hand: 'playback' })
    step(player, 5)
    expect(player.getLeadHint()).toBeNull()
  })
})

// =============================================================================
// 2. 弹对了才推进 (灯一直亮到弹对)
// =============================================================================
describe('2. 抢先模式: 弹对了才推进', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('右手弹对 → 只有右手的灯换到下一个音, 左手不动', () => {
    const song = makeSong([
      n(1.0, 48, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, 50, 'left'),
      n(2.0, D4, 'right'),
    ])
    const { player } = makePlayer(song)
    step(player, 1)
    expect(hintMidis(player, 'left')).toEqual([48])
    expect(hintMidis(player, 'right')).toEqual([C4])

    press(player, C4)
    step(player, 1)
    expect(hintMidis(player, 'left')).toEqual([48]) // 左手没动
    expect(hintMidis(player, 'right')).toEqual([D4]) // 右手换到下一个
  })

  it('左手弹对 → 只有左手的灯换到下一个音, 右手不动', () => {
    const song = makeSong([
      n(1.0, 48, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, 50, 'left'),
      n(2.0, D4, 'right'),
    ])
    const { player } = makePlayer(song)
    step(player, 1)

    press(player, 48)
    step(player, 1)
    expect(hintMidis(player, 'left')).toEqual([50])
    expect(hintMidis(player, 'right')).toEqual([C4])
  })

  it('弹错键 → 灯不动, 不报错, 不计分', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 1)

    press(player, 72) // 跟谱面无关的键
    step(player, 1)
    expect(hintMidis(player, 'right')).toEqual([C4]) // 提示没动
    expect(useStore.getState().errors).toBe(0) // 不报错
    expect(useStore.getState().hits).toBe(0) // 不计分
  })

  it('提前按 (音还没到点) → 算命中, 不报错', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 1) // t ≈ 0.016 —— 音在 t=1.0, 提前了快一秒

    press(player, C4)
    step(player, 1)
    expect(useStore.getState().errors).toBe(0)
    expect(useStore.getState().hits).toBe(1)
    expect(useStore.getState().perfects).toBe(1) // 抢先模式一律算 perfect
    expect(hintMidis(player, 'right')).toEqual([D4])
  })

  it('很久不弹 → 灯一直亮着, 不超时跳过, 不记漏弹', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 1)
    expect(hintMidis(player, 'right')).toEqual([C4])

    step(player, 300) // 5 秒过去, 什么都没弹
    expect(hintMidis(player, 'right')).toEqual([C4]) // 灯还亮着
    expect(useStore.getState().misses).toBe(0) // 不记漏弹
    expect(useStore.getState().errors).toBe(0)
  })

  it('和弦: 弹一半 → 那个音的灯灭了, 但组不推进; 弹全了 → 推进', () => {
    const song = makeSong([n(1.0, C4), n(1.0, E4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 1)
    expect(hintMidis(player, 'right')).toEqual([C4, E4])

    press(player, C4)
    step(player, 1)
    // E4 还欠着 → 组不推进; C4 弹对了 → 它的灯灭了
    expect(hintMidis(player, 'right')).toEqual([E4])

    press(player, E4)
    step(player, 1)
    expect(hintMidis(player, 'right')).toEqual([D4])
  })
})

// =============================================================================
// 3. 判定不受容差影响 (也不受「上一轮弹过的键」影响)
// =============================================================================
describe('3. 抢先模式: 判定不受容差影响', () => {
  beforeEach(() => useStore.getState().resetScore())

  it('容差调到最小 → 提前按也照样命中', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    useStore.setState({ toleranceMs: 5 })
    step(player, 1)

    press(player, C4)
    step(player, 1)
    expect(useStore.getState().hits).toBe(1)
    expect(hintMidis(player, 'right')).toEqual([D4])
  })

  it('容差调到最大 → 提前按「后面那个音」也不算命中', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    useStore.setState({ toleranceMs: 2000 })
    step(player, 1)

    press(player, D4) // 后面那个音 —— 现在不该弹它
    step(player, 1)
    expect(useStore.getState().hits).toBe(0)
    expect(useStore.getState().errors).toBe(0)
    expect(hintMidis(player, 'right')).toEqual([C4]) // 提示没动
  })

  it('上一轮弹过的键不会被「检索」回来干扰这一轮', () => {
    // C4 → D4 → C4: 同一个键出现两次
    const song = makeSong([n(1.0, C4), n(2.0, D4), n(3.0, C4)])
    const { player } = makePlayer(song)
    step(player, 1)

    press(player, C4) // 第一轮: C4
    step(player, 1)
    expect(hintMidis(player, 'right')).toEqual([D4])
    expect(useStore.getState().hits).toBe(1)

    // 再按一次 C4 (上一轮弹过的键) → 不该被检索回来当成命中
    press(player, C4)
    step(player, 1)
    expect(useStore.getState().hits).toBe(1) // 没多计一次分
    expect(useStore.getState().errors).toBe(0) // 也不报错
    expect(hintMidis(player, 'right')).toEqual([D4]) // 提示没动

    press(player, D4) // 这一轮该弹的是 D4
    step(player, 1)
    expect(useStore.getState().hits).toBe(2)
    expect(hintMidis(player, 'right')).toEqual([C4]) // 下一个是第三小节的 C4
  })

  it('同一个键在**下一组**里 → 上一轮的键不会被当成「已经弹过这一轮」', () => {
    // C4@1.0 → C4@2.0: 键一样, 但组不一样 —— 判定看的是组, 不是「这个键按过没有」
    const song = makeSong([n(1.0, C4), n(2.0, C4)])
    const { player } = makePlayer(song)
    step(player, 1)

    press(player, C4)
    step(player, 1)
    expect(useStore.getState().hits).toBe(1)
    expect(hintTime(player, 'right')).toBeCloseTo(2.0, 6)

    // 再按一次同一个键 → 这一次是「下一组」的 C4, 该命中
    press(player, C4)
    step(player, 1)
    expect(useStore.getState().hits).toBe(2)
    expect(useStore.getState().errors).toBe(0)
  })

  it('同一个键在同一组里 (谱面数据重复的音) → 两个 note 都算命中', () => {
    // 一次按键把这一组里同键的音都弹响了 → 两个 note 都算命中 (命中数跟谱面音符数对得上)
    const song = makeSong([n(1.0, C4), n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 1)
    press(player, C4)
    step(player, 1)
    expect(useStore.getState().hits).toBe(2)
    expect(useStore.getState().errors).toBe(0)
    expect(hintMidis(player, 'right')).toEqual([D4])
  })
})

// =============================================================================
// 4. 抢先模式: 恢复 Wait 的冻结 (2026-11-10)
// =============================================================================
describe('4. 抢先模式: 冻结在「现在该弹的那一组」上', () => {
  beforeEach(() => useStore.getState().resetScore())

  /** 右手 3 个音 (每 1 秒一个), 左手配一个 (保持两只手都有灯) */
  function accelSong(): Song {
    return makeSong([
      n(1.0, 48, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, 50, 'left'),
      n(2.0, D4, 'right'),
      n(3.0, 52, 'left'),
      n(3.0, E4, 'right'),
    ])
  }

  it('播放头冻在待弹组的**精确**谱面时间上', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 100) // 1.6 秒过去
    // 冻在 C4@1.0 上 —— 不是 1.008 (帧的量化), 是音的精确时间
    expect(player.isFrozen()).toBe(true)
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)
  })

  it('弹对 → 解冻, 按 1× 走到下一个待弹组再冻上', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 100)
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)

    press(player, C4)
    step(player, 1)
    // 解冻了 → 播放头开始往 2.0 走 (不跳, 按原速走)
    expect(player.isFrozen()).toBe(false)
    expect(player.getCurrentTime()).toBeGreaterThan(1.0)

    step(player, 100) // 1.6 秒 → 走到 2.0 又冻上
    expect(player.isFrozen()).toBe(true)
    expect(player.getCurrentTime()).toBeCloseTo(2.0, 6)
  })

  it('一直不弹 → 一直冻着 (不超时, 不记漏弹)', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song)
    step(player, 300) // 5 秒过去, 什么都没弹
    expect(player.isFrozen()).toBe(true)
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)
    expect(useStore.getState().misses).toBe(0)
    expect(hintMidis(player, 'right')).toEqual([C4]) // 灯一直亮着
  })

  it('倍率恒为 1 (冻住了没法加速 —— 玩家弹得再快也不加速)', () => {
    const { player } = makePlayer(accelSong())
    step(player, 1)
    expect(rate(player)).toBeCloseTo(1, 6)

    // 玩家用 2 倍速弹 (每 0.5 秒墙钟弹一个音, 谱面间隔 1 秒)
    step(player, 30) // t ≈ 0.48s
    press(player, C4)
    step(player, 30) // t ≈ 0.96s
    press(player, D4)
    step(player, 60)

    expect(rate(player)).toBeCloseTo(1, 6)
  })

  it('双手: 左手弹对 → 只有左手解冻, 右手那组还冻着', () => {
    const song = makeSong([
      n(1.0, 48, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, 50, 'left'),
      n(2.0, D4, 'right'),
    ])
    const { player } = makePlayer(song)
    step(player, 100)
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)

    press(player, 48) // 左手弹对
    step(player, 1)
    // 两组都在 t=1.0 → 右手还欠着 → 播放头继续冻在 1.0
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)
    expect(hintMidis(player, 'right')).toEqual([C4])
  })
})

// =============================================================================
// 5. 单手: 伴奏按谱面原速发声 (播放头冻住时伴奏也不往后排)
// =============================================================================
describe('5. 抢先模式 (单手): 伴奏保持原速', () => {
  beforeEach(() => useStore.getState().resetScore())

  /** 伴奏 (左手) + 玩家弹的 (右手) */
  function twoHandSong(): Song {
    return makeSong([
      n(0, 48, 'left'),
      n(1, 50, 'left'),
      n(2, 52, 'left'),
      n(3, 54, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, D4, 'right'),
      n(3.0, E4, 'right'),
    ])
  }

  it('伴奏按谱面原速发声 (ctx 间隔 = 谱面间隔)', () => {
    const { player, ctx, accEvents } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70) // t ≈ 1.12s

    // 伴奏的两个音之间隔了整整 1 秒 —— 没被压缩, 没被跳过
    expect(accEvents.length).toBeGreaterThanOrEqual(2)
    expect(accEvents[1].when! - accEvents[0].when!).toBeCloseTo(1.0, 3)
  })

  it('播放头冻在玩家那只手该弹的音上 (跟 Wait 一样)', () => {
    const { player, ctx } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70) // t ≈ 1.12s
    expect(player.isFrozen()).toBe(true)
    expect(player.getCurrentTime()).toBeCloseTo(1.0, 6)
  })

  it('单手模式倍率恒为 1 (伴奏不被加速)', () => {
    const { player, ctx } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70)
    press(player, C4)
    stepCtx(player, ctx, 60)
    expect(rate(player)).toBeCloseTo(1, 6)
  })

  it('弹对 → 提示换到下一个音, 播放头解冻往前走', () => {
    const { player, ctx } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70) // t ≈ 1.12s
    expect(hintMidis(player, 'right')).toEqual([C4])

    press(player, C4)
    stepCtx(player, ctx, 1)

    // 提示指到下一个该弹的音 (D4 @ t=2.0)
    expect(hintMidis(player, 'right')).toEqual([D4])
    // 播放头解冻了 (解冻那一帧还停在原地, 下一帧才开始走)
    expect(player.isFrozen()).toBe(false)
    stepCtx(player, ctx, 30)
    expect(player.getCurrentTime()).toBeGreaterThan(1.0)
  })

  it('弹错键 → 提示不动, 不报错', () => {
    const { player, ctx } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70)
    press(player, D4) // 错音 (现在该弹 C4)
    stepCtx(player, ctx, 1)
    expect(hintMidis(player, 'right')).toEqual([C4])
    expect(useStore.getState().errors).toBe(0)
  })

  it('很久不弹 → 灯一直亮着, 不记漏弹', () => {
    const { player, ctx } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70) // t ≈ 1.12s, 提示指着 C4 (t=1.0)
    stepCtx(player, ctx, 200) // 播放头冻着 → 时间不走
    expect(hintMidis(player, 'right')).toEqual([C4])
    expect(useStore.getState().misses).toBe(0)
  })

  it('伴奏跟着播放头走: 冻住时不再往后排, 弹对解冻后继续', () => {
    const { player, ctx, accEvents } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70) // 冻在 1.0
    // 播放头冻着 → 1.0 之后的伴奏音还没排 (lookahead 够不到)
    expect(accEvents.map((e) => e.time)).toEqual([0, 1])

    press(player, C4)
    stepCtx(player, ctx, 200) // 解冻 → 走到 2.0 又冻上
    expect(accEvents.map((e) => e.time)).toEqual([0, 1, 2])
    expect(player.getCurrentTime()).toBeCloseTo(2.0, 6)
  })

  it('Backspace: 跳过当前音 → 提示往前挪, 不算漏弹, 播放头解冻', () => {
    const { player, ctx } = makeSingleHandPlayer(twoHandSong())
    stepCtx(player, ctx, 70) // t ≈ 1.12s, 提示指着 C4
    expect(hintMidis(player, 'right')).toEqual([C4])

    expect(player.skipLeadNote()).toBe(true)
    stepCtx(player, ctx, 1)

    // 提示挪到 D4
    expect(hintMidis(player, 'right')).toEqual([D4])
    // 不算漏弹 (用户主动跳过)
    expect(useStore.getState().misses).toBe(0)
    // 跳过 → 那组不算欠着了 → 播放头解冻往下一个待弹组走
    expect(player.isFrozen()).toBe(false)
  })

  it('Backspace: 双手模式也接管 (跳过最早那个待弹组)', () => {
    const song = makeSong([
      n(1.0, 48, 'left'),
      n(1.0, C4, 'right'),
      n(2.0, D4, 'right'),
    ])
    const { player } = makePlayer(song)
    step(player, 1)
    expect(player.skipLeadNote()).toBe(true)
    step(player, 1)
    // 左手 (最早那个组) 被跳过, 右手不动
    expect(hintMidis(player, 'left')).toEqual([])
    expect(hintMidis(player, 'right')).toEqual([C4])
    expect(useStore.getState().misses).toBe(0)
  })

  it('Backspace: 抢先没开 → 返回 false (走原来的解冻逻辑)', () => {
    const song = makeSong([n(1.0, C4), n(2.0, D4)])
    const { player } = makePlayer(song, false)
    step(player, 5)
    expect(player.skipLeadNote()).toBe(false)
  })
})

// =============================================================================
// 6. effectiveLead 的门控
// =============================================================================
describe('6. effectiveLead', () => {
  it('practice + wait + lead → true', () => {
    expect(effectiveLead('right', true, true)).toBe(true)
    expect(effectiveLead('both', true, true)).toBe(true)
    expect(effectiveLead('left', true, true)).toBe(true)
  })

  it('Wait 关 / lead 关 / playback → false', () => {
    expect(effectiveLead('right', false, true)).toBe(false)
    expect(effectiveLead('right', true, false)).toBe(false)
    expect(effectiveLead('playback', true, true)).toBe(false)
  })

  it('开关状态存进 localStorage', () => {
    localStorage.clear()
    useStore.getState().setLeadUserOverride(true)
    const raw = localStorage.getItem('piayes.prefs.v1')
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!).leadNext).toBe(true)
    useStore.getState().setLeadUserOverride(false)
    expect(JSON.parse(localStorage.getItem('piayes.prefs.v1')!).leadNext).toBe(false)
  })
})
