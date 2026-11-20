// 下落速度跟着画布高度走 (2026-11-10)
//
// 以前 PPS 是死的 (280px/s), 于是「命中线上方能看到多远」完全由窗口高度决定:
//   画布 600 高 → (600-110)/280 ≈ 1.75s 的预读
//   画布 900 高 → 2.8s 的预读
// 同一首曲子在矮窗口上明显更难 (来不及读谱).
//
// 现在: 矮画布上把下落速度调慢, 保证命中线上方**至少**留 MIN_HORIZON 秒.

import { describe, it, expect } from 'vitest'
import { ppsFor } from '../src/render/FallingNotes'

const KEYBOARD_HEIGHT = 110
const MIN_HORIZON = 2.2
const BASE_PPS = 280

describe('ppsFor — 下落速度跟画布高度', () => {
  it('画布够高 → 用基准速度 (老样子, 一根汗毛都不动)', () => {
    expect(ppsFor(900)).toBe(BASE_PPS)
    expect(ppsFor(2000)).toBe(BASE_PPS)
  })

  it('画布矮 → 慢一点, 但预读时间不少于 2.2 秒', () => {
    for (const H of [300, 400, 500, 600, 700]) {
      const pps = ppsFor(H)
      const horizon = (H - KEYBOARD_HEIGHT) / pps
      expect(pps).toBeLessThanOrEqual(BASE_PPS)
      expect(horizon).toBeGreaterThanOrEqual(MIN_HORIZON - 1e-9)
    }
  })

  it('画布极矮 → 也不炸 (速度为正且有限)', () => {
    const pps = ppsFor(0)
    expect(pps).toBeGreaterThan(0)
    expect(Number.isFinite(pps)).toBe(true)
  })
})
