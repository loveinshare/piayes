// Scoring 单元测试 (spec P1-4 / P1-5)
//
//  - P1-4: 准确率必须把 errors 计入分母 —— hits / (hits + misses + errors)
//          (同 sightread: refs/sightread/src/features/player/player.ts:42-46)
//  - P1-5: 判定窗口按 bpm 缩放, 不再是写死的绝对毫秒
//
// 窗口口径对齐 sightread (GOOD_RANGE=300 / PERFECT_RANGE=50,
// refs/sightread/src/features/player/player.ts:15-16), 但额外做了 tempo 缩放.

import { describe, it, expect } from 'vitest'
import { accuracyPercent, scoreSnapshot, timingWindows } from '../src/engine/Scoring'

describe('P1-4: 准确率口径', () => {
  it('error 计入分母 —— 打错音不能白嫖准确率', () => {
    // 10 命中 / 2 漏 / 3 错 → 10/15 = 66.67% → 67
    expect(accuracyPercent(10, 2, 3)).toBe(67)
    // 旧实现只看 hits/(hits+misses) → 10/12 = 83%, 虚高 16 个点
    expect(accuracyPercent(10, 2, 3)).not.toBe(83)
  })

  it('全 0 → 100 (空成绩不算差)', () => {
    expect(accuracyPercent(0, 0, 0)).toBe(100)
  })

  it('全是错音 → 0', () => {
    expect(accuracyPercent(0, 0, 5)).toBe(0)
  })

  it('scoreSnapshot 把 accuracy 算好塞进快照', () => {
    const s = scoreSnapshot({
      hits: 8, misses: 1, errors: 1, perfects: 3, goods: 4, streak: 5, maxStreak: 9,
    })
    expect(s.accuracy).toBe(80) // 8/10
    expect(s.streak).toBe(5)
    expect(s.maxStreak).toBe(9)
  })
})

describe('P1-5: 判定窗口按速度缩放', () => {
  it('120bpm → hit 250ms / perfect 50ms / good 125ms', () => {
    const w = timingWindows(120)
    expect(w.hit).toBe(250)
    expect(w.perfect).toBe(50) // 同 sightread 的 PERFECT_RANGE
    expect(w.good).toBe(125)
  })

  it('慢板窗口更宽, 快板更窄 (不是固定绝对值)', () => {
    const slow = timingWindows(60).hit
    const mid = timingWindows(120).hit
    const fast = timingWindows(150).hit
    expect(slow).toBe(300)
    expect(mid).toBe(250)
    expect(fast).toBe(200)
    expect(slow).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(fast)
  })

  it('用户容差上限立刻封顶 —— 改小后窗口跟着变小', () => {
    expect(timingWindows(120, 100).hit).toBe(100)
    // 上限比 tempo 窗口大时, 以 tempo 窗口为准
    expect(timingWindows(120, 500).hit).toBe(250)
  })

  it('窗口永远不小于 150ms (手速不够也不至于全判晚)', () => {
    expect(timingWindows(240).hit).toBe(150)
    expect(timingWindows(600).hit).toBe(150)
  })

  it('bpm 非法时退化到 20bpm 下限, 不返回 NaN', () => {
    const w = timingWindows(0)
    expect(Number.isFinite(w.hit)).toBe(true)
    expect(w.hit).toBeGreaterThan(0)
  })

  it('perfect / good 永远小于 hit', () => {
    for (const bpm of [40, 60, 90, 120, 150, 200, 300]) {
      const w = timingWindows(bpm)
      expect(w.perfect).toBeLessThan(w.good)
      expect(w.good).toBeLessThanOrEqual(w.hit)
    }
  })
})
