// 左手 / 右手的灯分别开关 (首页的两个勾选框).
//
// 钉住五件事:
//   1. 关掉一只手 → 那只手当前亮着的灯**立刻全灭** (静默: 不弹提示, 不报错)
//   2. 关掉之后 → 这只手的音不再点灯
//   3. 点回来 → 还按着的键重新亮起来 (follower 负责: 它知道谁按着)
//   4. 两只手都关 → 整条灯带全黑
//   5. 上灯带 (预告行) 也跟着走 —— 关掉的手不显示「下一个音」

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { LedController, DEFAULT_LED_COLORS } from '../src/led/LedController'
import { LedFollower } from '../src/led/LedFollower'
import { stripRange, upperRange } from '../src/led/dualStrip'
import { useStore } from '../src/store'
import { LedHandToggles } from '../src/ui/LedHandToggles'
import type { LedTransport } from '../src/led/LedTransport'
import type { NoteEvent } from '../src/types'

interface Sent {
  op: string
  args: Record<string, any>
}

function fakeTransport(setManyShows = false) {
  const sent: Sent[] = []
  const pixels = new Map<number, [number, number, number]>()
  const transport: LedTransport = {
    name: 'fake',
    connected: true,
    setManyShows,
    async connect() {},
    disconnect() {},
    async send(op, args) {
      sent.push({ op, args })
      if (op === 'set_many') {
        for (const px of args.pixels ?? []) pixels.set(px.i, [px.r, px.g, px.b])
      }
      if (op === 'off') pixels.clear()
    },
  }
  return { transport, sent, pixels }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/** 主灯带上这个键亮不亮 (有非黑像素就算亮). */
function litAt(pixels: Map<number, [number, number, number]>, note: number): boolean {
  const rng = stripRange(note)!
  for (let i = rng[0]; i < rng[1]; i++) {
    const c = pixels.get(i)
    if (c && (c[0] || c[1] || c[2])) return true
  }
  return false
}

/** 上灯带上这个键亮不亮. */
function litAtUpper(pixels: Map<number, [number, number, number]>, note: number): boolean {
  const rng = upperRange(note)!
  for (let i = rng[0]; i < rng[1]; i++) {
    const c = pixels.get(i)
    if (c && (c[0] || c[1] || c[2])) return true
  }
  return false
}

function down(midi: number, hand?: 'left' | 'right'): NoteEvent {
  return { type: 'down', midi, velocity: 100, t: 0, source: 'playback', hand }
}

describe('手别灯开关 · LedController', () => {
  it('关掉左手 → 左手当前亮着的灯立刻全灭, 右手的不动', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 176, brightness: 1 })
    led.noteOn(55, 'left')
    led.noteOn(64, 'right')
    await tick()
    expect(litAt(pixels, 55)).toBe(true)
    expect(litAt(pixels, 64)).toBe(true)

    led.setHandEnabled('left', false)
    await tick()
    expect(litAt(pixels, 55)).toBe(false)
    expect(litAt(pixels, 64)).toBe(true)
  })

  it('关掉之后 → 这只手的音不再点灯', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 176, brightness: 1 })
    led.setHandEnabled('left', false)
    await tick()

    led.noteOn(52, 'left')
    await tick()
    expect(litAt(pixels, 52)).toBe(false)
  })

  it('两只手都关 → 整条灯带全黑, 之后点任何音都不亮', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 176, brightness: 1 })
    led.noteOn(55, 'left')
    led.noteOn(64, 'right')
    await tick()

    led.setHandEnabled('left', false)
    led.setHandEnabled('right', false)
    await tick()
    expect([...pixels.values()].every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)).toBe(true)

    led.noteOn(52, 'left')
    led.noteOn(67, 'right')
    await tick()
    expect([...pixels.values()].every((c) => c[0] === 0 && c[1] === 0 && c[2] === 0)).toBe(true)
  })

  it('关掉之后再改亮度 / 呼吸 → 不会被重新点亮', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 176, brightness: 1 })
    led.noteOn(55, 'left')
    await tick()

    led.setHandEnabled('left', false)
    await tick()
    // 呼吸会重画所有「亮着的键」—— 关掉的手不该在里面
    led.setPulse(0.5)
    led.tickPulse(50)
    led.setBrightness(0.8)
    await tick()
    expect(litAt(pixels, 55)).toBe(false)
  })

  it('上灯带 (预告行): 关掉的手不显示「下一个音」', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 352, dualStrip: true, brightness: 1 })
    led.setUpcomingColors(DEFAULT_LED_COLORS)
    led.setUpperHints([
      { midi: 55, hand: 'left' },
      { midi: 64, hand: 'right' },
    ])
    await tick()
    expect(litAtUpper(pixels, 55)).toBe(true)
    expect(litAtUpper(pixels, 64)).toBe(true)

    led.setHandEnabled('left', false)
    await tick()
    expect(litAtUpper(pixels, 55)).toBe(false)
    expect(litAtUpper(pixels, 64)).toBe(true)
  })
})

describe('手别灯开关 · LedFollower', () => {
  it('关掉 → 当前亮着的灯全灭; 点回来 → 还按着的键重新亮起来', async () => {
    const { transport, pixels } = fakeTransport()
    const led = new LedController({ transport, count: 176, brightness: 1 })
    const follower = new LedFollower({ led, isEnabled: () => true, offGraceMs: 0 })

    follower.handleEvent(down(55, 'left'))
    await tick()
    expect(litAt(pixels, 55)).toBe(true)

    follower.setHandEnabled('left', false)
    await tick()
    expect(litAt(pixels, 55)).toBe(false)

    follower.setHandEnabled('left', true)
    await tick()
    expect(litAt(pixels, 55)).toBe(true)
  })
})

describe('手别灯开关 · 首页两个勾选框', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    useStore.getState().setLedHandLeft(true)
    useStore.getState().setLedHandRight(true)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(LedHandToggles))
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    await tick()
  })

  function switches(): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('button[role="switch"]')]
  }

  it('两个勾选框 (左手 / 右手), 默认都选中', async () => {
    await tick()
    const s = switches()
    expect(s.length).toBe(2)
    expect(s[0].textContent).toContain('左手')
    expect(s[1].textContent).toContain('右手')
    expect(s[0].getAttribute('aria-checked')).toBe('true')
    expect(s[1].getAttribute('aria-checked')).toBe('true')
  })

  it('点掉左手 → 只关左手, 右手不受影响', async () => {
    await tick()
    switches()[0].click()
    await tick()
    expect(useStore.getState().ledHandLeft).toBe(false)
    expect(useStore.getState().ledHandRight).toBe(true)
    expect(switches()[0].getAttribute('aria-checked')).toBe('false')
    expect(switches()[1].getAttribute('aria-checked')).toBe('true')
  })

  it('两只手都点掉 → 两个都关', async () => {
    await tick()
    switches()[0].click()
    await tick()
    switches()[1].click()
    await tick()
    expect(useStore.getState().ledHandLeft).toBe(false)
    expect(useStore.getState().ledHandRight).toBe(false)
  })
})
