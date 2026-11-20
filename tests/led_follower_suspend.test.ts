// LedFollower 挂起 / 恢复 —— 「测试」跑马灯期间不许别的灯插进来.
//
// 用户报的「跑马灯跑的时候其他灯还乱删/乱闪」: 跑马灯是独占动画, 但 follower
// 还在按按键/预览往灯带写. 修法: 测试前 suspend() (只记状态, 不写灯带),
// 跑完 resume() 重画一次.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LedFollower } from '../src/led/LedFollower'

function makeLed() {
  const events: string[] = []
  let lit = new Set<number>()
  return {
    events,
    get lit() { return lit },
    noteOn: (m: number) => { events.push(`on:${m}`); lit.add(m) },
    noteOff: (m: number) => { events.push(`off:${m}`); lit.delete(m) },
    allOff: () => { events.push('allOff'); lit = new Set() },
    show: async () => {},
    setBrightness: () => {},
    setMode: () => {},
    setSplit: () => {},
    setHandMap: () => {},
    setColors: () => {},
    setCalibrate: () => {},
  }
}

function down(f: LedFollower, midi: number) {
  f.handleEvent({ type: 'down', midi, velocity: 1, t: 0, source: 'input' })
}
function up(f: LedFollower, midi: number) {
  f.handleEvent({ type: 'up', midi, t: 0, source: 'input' })
}

describe('LedFollower.suspend / resume', () => {
  let led: ReturnType<typeof makeLed>
  let follower: LedFollower

  beforeEach(() => {
    vi.useFakeTimers()
    led = makeLed()
    follower = new LedFollower({ led: led as any, isEnabled: () => true, followSource: 'both' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('挂起期间不往灯带写, 但状态照记; 恢复时重画', () => {
    down(follower, 60)
    expect(led.events).toEqual(['on:60'])

    follower.suspend()
    led.events.length = 0

    down(follower, 64)
    expect(led.events).toEqual([])

    follower.resume()
    // 60 一直按着 + 64 是挂起期间按下的 → 两个都要亮
    expect(led.events.sort()).toEqual(['on:60', 'on:64'])
  })

  it('挂起期间松手的音, 恢复时不该再亮', () => {
    down(follower, 60)
    follower.suspend()
    led.events.length = 0
    up(follower, 60)

    follower.resume()
    expect(led.events).toEqual([])
  })

  it('挂起时还没到期的“灭灯”不会被恢复动作重新点亮', () => {
    down(follower, 67)
    up(follower, 67)
    // 60ms grace 还没走完就挂起
    follower.suspend()
    led.events.length = 0

    follower.resume()
    // 67 已经松手了 → 不该再亮
    expect(led.events).toEqual([])
  })

  it('挂起期间的预览只记状态, 恢复时点亮', () => {
    follower.suspend()
    follower.setPreview([{ midi: 72 }])
    expect(led.events).toEqual([])

    follower.resume()
    expect(led.events).toEqual(['on:72'])
  })
})
