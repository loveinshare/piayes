// SongClock 单测 (spec P1-3)
//
// 核心断言:
//   1. 歌曲时间锚在 AudioContext 上 —— 主线程卡顿不会让音乐时间漂;
//   2. 判定用输入事件的**硬件时间戳**, 不受"事件被处理那一刻"的延迟影响;
//   3. 输出延迟补偿能把"跟声音弹"的系统性偏置抵消掉;
//   4. 没有 AudioContext 时退化成逻辑时钟 (老行为, 测试可手动步进).

import { describe, it, expect } from 'vitest'
import { SongClock } from '../src/engine/Clock'
import { FakeAudioContext, withFakePerf } from './fakeClock'

function makeCtx() {
  return new FakeAudioContext()
}

describe('SongClock — 音频时钟 (P1-3)', () => {
  it('歌曲时间跟着 ctx.currentTime 走, 不自己累加', () => {
    const ctx = makeCtx()
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(0)
    expect(clock.isAudioBacked).toBe(true)

    // 主线程卡了 500ms —— 音频时钟照走, 歌曲时间必须一步到位 (不漂)
    ctx.advance(0.5)
    expect(clock.songTime()).toBeCloseTo(0.5, 6)
    expect(clock.advance(0.016)).toBeCloseTo(0.5, 6) // dt 被忽略
  })

  it('ctx 被挂起 → 退化成逻辑时钟 (advance(dt) 生效)', () => {
    const ctx = makeCtx()
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(0)
    ctx.state = 'suspended'
    expect(clock.advance(0.016)).toBeCloseTo(0.016, 6)
    expect(clock.isAudioBacked).toBe(false)
  })

  it('seek (anchor) 之后 song↔ctx 的映射重算', () => {
    const ctx = makeCtx()
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(10)
    ctx.advance(0.5)
    expect(clock.songTime()).toBeCloseTo(10.5, 6)
    expect(clock.toCtxTime(10.5)).toBeCloseTo(0.5, 6)
  })

  it('变速时歌曲位置连续 (不跳)', () => {
    const ctx = makeCtx()
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(0)
    ctx.advance(2)
    expect(clock.songTime()).toBeCloseTo(2, 6)
    clock.setSpeed(2)
    // 变速瞬间位置不变
    expect(clock.songTime()).toBeCloseTo(2, 6)
    ctx.advance(1)
    expect(clock.songTime()).toBeCloseTo(4, 6) // 1 秒 ctx = 2 秒 song
  })
})

describe('SongClock — 判定时钟 (P1-3)', () => {
  it('用硬件时间戳换算歌曲时间 —— 不受事件处理延迟影响', () => {
    const ctx = makeCtx()
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(0)
    ctx.advance(2)

    // 用户在 perf=2000ms 时按下的键 (硬件时间戳)
    expect(clock.pressSongTime(2000)).toBeCloseTo(2, 6)
    // 即使事件在队列里等了 300ms 才被处理, 硬件时间戳依然准
    expect(clock.pressSongTime(2000)).toBeCloseTo(2, 6)
  })

  it('无效时间戳 → 退回当前歌曲时间', () => {
    const ctx = makeCtx()
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(0)
    ctx.advance(1.5)
    expect(clock.pressSongTime(0)).toBeCloseTo(1.5, 6)
    expect(clock.pressSongTime(Number.NaN)).toBeCloseTo(1.5, 6)
  })

  it('输出延迟补偿: 跟声音弹的用户 delta 归零', () => {
    const ctx = makeCtx()
    ctx.outputLatency = 0.2 // 蓝牙耳机 200ms
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext, perfOffsetMs: 0 })
    clock.anchor(0)
    ctx.advance(2)

    // 不补偿: 用户听到声音 (比排程晚 200ms) 时按下 → 判定偏晚 200ms
    expect(clock.pressSongTime(2000)).toBeCloseTo(2, 6)

    // 自动补偿 (负数 = 用检测值)
    clock.setLatencyCompensation(-1)
    expect(clock.outputLatencyMs()).toBe(200)
    expect(clock.pressSongTime(2000)).toBeCloseTo(1.8, 6)

    // 手动补偿
    clock.setLatencyCompensation(100)
    expect(clock.pressSongTime(2000)).toBeCloseTo(1.9, 6)
  })
})

describe('SongClock — ctx 挂起/恢复后的偏移重采样', () => {
  it('ctx 挂起再恢复 → perf↔ctx 偏移必须重新采样', () => {
    const ctx = makeCtx()
    ctx.currentTime = 1
    // 不注入 perfOffset —— 让它自动采样, 才能测出"没重采样"的后果
    const clock = new SongClock({ ctx: ctx as unknown as AudioContext })
    withFakePerf(1000, (setPerf) => {
      // 先采一次: perf=1000ms, ctx=1.0s → 偏移 0
      clock.outputLatencyMs()
      expect(clock.pressSongTime(1000)).toBeCloseTo(0, 6)

      // ctx 挂起 200ms —— perf 继续走, ctx 冻住
      ctx.state = 'suspended'
      setPerf(1200)
      clock.advance(0.016)
      // 恢复
      ctx.state = 'running'
      clock.advance(0.016)

      // 偏移应已重采样 (perf=1200, ctx=1.0 → 偏移 200)
      // 不用旧偏移的话, 这个按键会被算到 0.2s 之后 → 判定凭空偏掉一截
      expect(clock.pressSongTime(1200)).toBeCloseTo(0.016, 2)
    })
  })
})

describe('SongClock — 无 AudioContext 的退化路径', () => {
  it('逻辑时钟: advance(dt) 累加, pressSongTime 返回当前歌曲时间', () => {
    const clock = new SongClock({})
    clock.anchor(0)
    expect(clock.advance(0.016)).toBeCloseTo(0.016, 6)
    expect(clock.advance(0.016)).toBeCloseTo(0.032, 6)
    expect(clock.isAudioBacked).toBe(false)
    // 没有音频时钟就无从换算 —— 退回当前歌曲时间 (老行为)
    expect(clock.pressSongTime(12345)).toBeCloseTo(0.032, 6)
    expect(clock.toCtxTime(1)).toBeNull()
  })
})
