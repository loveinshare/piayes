// 渲染层时间源 (spec P1-1 / P1-14)
//
// store 的 currentTime 被 Player.emitTick 限流到 10Hz —— 拿它渲染会让
// 下落音符每 100ms 跳 PPS(280) * 0.1 = 28px (肉眼可见的台阶感),
// LED 预扫描的亮灭时刻同样被量化.
//
// 修法: 渲染层直接读播放器的连续时间 (player.getCurrentTime()).

import { describe, it, expect } from 'vitest'
import { renderTime } from '../src/render/timeSource'

describe('renderTime: 渲染层时间源', () => {
  it('有 player 时用它的连续时间, 不理 store 的 10Hz 量化值', () => {
    const player = { getCurrentTime: () => 12.3456 }
    expect(renderTime(player, 12.3)).toBe(12.3456)
  })

  it('没有 player → 退回 store 值', () => {
    expect(renderTime(null, 3.5)).toBe(3.5)
    expect(renderTime(undefined, 3.5)).toBe(3.5)
  })

  it('player 没有 getCurrentTime (老接口) → 退回 store 值', () => {
    expect(renderTime({}, 3.5)).toBe(3.5)
  })

  it('player 返回 NaN / Infinity → 退回 store 值, 不把 NaN 传进渲染', () => {
    expect(renderTime({ getCurrentTime: () => NaN }, 7.25)).toBe(7.25)
    expect(renderTime({ getCurrentTime: () => Infinity }, 7.25)).toBe(7.25)
  })

  it('10Hz 量化 vs 连续时间: 同一瞬间两者相差可达 100ms', () => {
    // store 的值在两次 emitTick 之间是不动的, 玩家时间一直在走
    let t = 5
    const player = { getCurrentTime: () => t }
    const storeSnapshot = 5
    t = 5.099 // 100ms 后
    expect(renderTime(player, storeSnapshot)).toBeCloseTo(5.099)
    expect(renderTime(player, storeSnapshot) - storeSnapshot).toBeCloseTo(0.099)
  })
})
