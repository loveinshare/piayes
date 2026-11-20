// 播放按钮: 曲子放完以后再按一下 = 从头开始 (2026-11-20 用户要求)
//
// 背景: 播放器放到最后一个音的末尾就停了. 以前这时候按播放键什么也不会发生 ——
// 播放头停在末尾, 按一下还是末尾. 用户要求「放完以后按播放键能重新开始」.
//
// 这里测的是**按钮这一层**: 放完之后按播放 → 走「从头开始」(onRestart),
// 而不是「继续播」(onPlay).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { Transport } from '../src/ui/Transport'
import type { Song } from '../src/types'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

const SONG: Song = {
  notes: [{ time: 0, duration: 1, midiNote: 60, track: 0, hand: 'right', velocity: 0.8 }],
  measures: [{ number: 1, time: 0, duration: 4 }],
  bpms: [{ time: 0, bpm: 120 }],
  duration: 4,
  ppq: 480,
  hands: { left: 0, right: 0 },
  timeSignature: { numerator: 4, denominator: 4 },
  source: 'midi',
}

describe('播放按钮 · 曲终后从头开始', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  let calls: string[]

  function playButton(): HTMLButtonElement {
    const btn = host.querySelector('button[aria-label="播放"], button[aria-label="从头播放"]')
    expect(btn, '没找到播放按钮').toBeTruthy()
    return btn as HTMLButtonElement
  }

  beforeEach(async () => {
    calls = []
    useStore.setState({ song: SONG, isPlaying: false, songEnded: false })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      React.createElement(Transport, {
        onPlay: () => calls.push('play'),
        onPause: () => calls.push('pause'),
        onRestart: () => calls.push('restart'),
        onSeek: () => calls.push('seek'),
        duration: 100,
        currentTime: 0,
      }),
    )
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
  })

  it('没放完时按播放 → 正常播放', async () => {
    playButton().click()
    await wait()
    expect(calls).toEqual(['play'])
  })

  it('放完以后按播放 → 从头开始', async () => {
    useStore.setState({ songEnded: true })
    await wait()

    const btn = playButton()
    expect(btn.getAttribute('aria-label'), '按钮没提示「从头播放」').toBe('从头播放')
    expect(btn.getAttribute('title')).toContain('从头播放')

    btn.click()
    await wait()
    expect(calls).toEqual(['restart'])
    expect(calls).not.toContain('play')
  })

  it('播放中按按钮 → 暂停 (不受曲终标记影响)', async () => {
    useStore.setState({ songEnded: true, isPlaying: true })
    await wait()

    const btn = host.querySelector('button[aria-label="暂停"]')
    expect(btn, '没找到暂停按钮').toBeTruthy()
    ;(btn as HTMLButtonElement).click()
    await wait()
    expect(calls).toEqual(['pause'])
  })
})
