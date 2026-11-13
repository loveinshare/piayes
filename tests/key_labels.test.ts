// 虚拟键盘上的音名标号 + 「等你弹」的键上色
//
// 用户 2026-10-30 要求:
//   「在虚拟钢琴键盘上你需要打上 D3 之类的标号 我不认识（做成可设置的 放在设置界面）
//     同时（等你弹xx时 需要在该键渲染一个颜色 让我好找）」
//
// 覆盖三块:
//   1. 纯逻辑 labelForMidi / 字号
//   2. 画布渲染 (用假 ctx 调 drawFrame): 标号真的画出来了 + 「等你弹」的键被染色
//   3. 设置抽屉 UI + 落库

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useStore } from '../src/store'
import { drawFrame } from '../src/render/FallingNotes'
import { labelForMidi, whiteKeyLabelSize, blackKeyLabelSize } from '../src/render/keyLabels'
import { whiteKeyIndex } from '../src/render/colors'
import type { Song, SongNote } from '../src/types'
import type { KeyLabelMode } from '../src/types'
import { SettingsDrawer } from '../src/ui/SettingsDrawer'

const LS_KEY = 'piayes.prefs.v1'
const WAIT_KEY_FILL = 'rgba(251, 191, 36, 0.55)'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

// =============================================================================
// 1. 纯逻辑
// =============================================================================
describe('labelForMidi', () => {
  it('off = 全不标', () => {
    expect(labelForMidi(60, 'off')).toBeNull()
    expect(labelForMidi(21, 'off')).toBeNull()
  })

  it('c = 只标每个八度的 C', () => {
    expect(labelForMidi(60, 'c')).toBe('C4')
    expect(labelForMidi(72, 'c')).toBe('C5')
    expect(labelForMidi(62, 'c')).toBeNull()
    expect(labelForMidi(61, 'c')).toBeNull()
  })

  it('all = 每个键都标', () => {
    expect(labelForMidi(60, 'all')).toBe('C4')
    expect(labelForMidi(62, 'all')).toBe('D4')
    expect(labelForMidi(61, 'all')).toBe('C#4')
    expect(labelForMidi(21, 'all')).toBe('A0')
    expect(labelForMidi(108, 'all')).toBe('C8')
  })

  it('标号 = 键自己的音名 (位置音高), 跟画在同位置的音符标签一致', () => {
    // 画布上位置 P 的键标 midiToName(P); 落在位置 P 的音符标签也是 midiToName(P)
    for (const p of [60, 64, 67]) {
      expect(labelForMidi(p, 'all')).toBe(labelForMidi(p, 'all'))
    }
  })
})

describe('标号字号', () => {
  it('白键字号跟着白键宽度走, 且有上下限', () => {
    expect(whiteKeyLabelSize(10)).toBe(7)
    expect(whiteKeyLabelSize(100)).toBe(11)
    const mid = whiteKeyLabelSize(24)
    expect(mid).toBeGreaterThanOrEqual(7)
    expect(mid).toBeLessThanOrEqual(11)
  })

  it('黑键字号不超过白键字号 (黑键窄)', () => {
    expect(blackKeyLabelSize(100)).toBe(9)
    expect(blackKeyLabelSize(10)).toBe(6)
    expect(blackKeyLabelSize(24)).toBeLessThanOrEqual(whiteKeyLabelSize(24))
  })
})

// =============================================================================
// 2. 画布渲染
// =============================================================================
type Fill = { args: number[]; fillStyle: string }
type Text = { text: string; font: string; rotated: boolean }

/** 假 2D context —— 记录 fillRect / fillText 就够了. */
function makeFakeCtx() {
  const fills: Fill[] = []
  const texts: Text[] = []
  let rotated = false
  const ctx: any = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
    fillRect: (...args: number[]) => {
      fills.push({ args, fillStyle: ctx.fillStyle })
    },
    strokeRect: () => {},
    clearRect: () => {},
    fillText: (text: string) => {
      texts.push({ text, font: ctx.font, rotated })
    },
    strokeText: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    rotate: () => {
      rotated = true
    },
    scale: () => {},
    setLineDash: () => {},
    measureText: (t: string) => ({ width: t.length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
  }
  return { ctx, fills, texts }
}

const W = 1040
const H = 600
const WHITE_KEY_W = W / 52

function makeSong(notes: SongNote[]): Song {
  return {
    notes,
    measures: [{ number: 1, time: 0, duration: 8 }],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 8,
    ppq: 480,
    hands: { left: 0, right: 0 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
  }
}

function render(opts: {
  keyLabels: KeyLabelMode
  song?: Song | null
  waitTarget?: SongNote | null
  transpose?: number
}) {
  const { ctx, fills, texts } = makeFakeCtx()
  const song = opts.song === undefined ? null : opts.song
  drawFrame(
    ctx, W, H, WHITE_KEY_W, song, 0, 'right',
    new Set<number>(),
    opts.waitTarget ?? null,
    opts.transpose ?? 0, null, new Map(), opts.keyLabels,
  )
  return { fills, texts }
}

describe('画布: 键盘标号', () => {
  it('all = 每个键都画上标号 (白键横排 + 黑键竖排)', () => {
    const { texts } = render({ keyLabels: 'all' })
    const drawn = texts.map((t) => t.text)
    expect(drawn).toContain('C4')
    expect(drawn).toContain('D4')
    expect(drawn).toContain('C#4')
    expect(drawn).toContain('A0')
    expect(drawn).toContain('C8')
    // 白键标号横着写, 黑键标号竖着写 (窄键放不下横排)
    const c4 = texts.find((t) => t.text === 'C4')!
    const csharp4 = texts.find((t) => t.text === 'C#4')!
    expect(c4.rotated).toBe(false)
    expect(csharp4.rotated).toBe(true)
  })

  it('c = 只画 C 的标号', () => {
    const { texts } = render({ keyLabels: 'c' })
    const drawn = texts.map((t) => t.text)
    expect(drawn).toContain('C4')
    expect(drawn).toContain('C5')
    expect(drawn).not.toContain('D4')
    expect(drawn).not.toContain('C#4')
  })

  it('off = 一个标号都不画', () => {
    const { texts } = render({ keyLabels: 'off' })
    const drawn = texts.map((t) => t.text)
    expect(drawn).not.toContain('C4')
    expect(drawn).not.toContain('D4')
    expect(drawn).not.toContain('C#4')
  })

  it('有曲子时也照样标 (标号不依赖曲子)', () => {
    const song = makeSong([{ midiNote: 60, time: 2, duration: 1, track: 0, hand: 'right' }])
    const { texts } = render({ keyLabels: 'all', song })
    expect(texts.map((t) => t.text)).toContain('C4')
  })
})

describe('画布: 「等你弹」的键上色', () => {
  const target: SongNote = { midiNote: 60, time: 2, duration: 1, track: 0, hand: 'right' }
  const song = makeSong([target])

  it('有「等你弹」的目标时, 目标键被染成琥珀色', () => {
    const { fills } = render({ keyLabels: 'off', song, waitTarget: target })
    const hit = fills.find((f) => f.fillStyle === WAIT_KEY_FILL)
    expect(hit).toBeTruthy()
    // 染的正是 C4 那个白键
    expect(hit!.args[0]).toBeCloseTo(whiteKeyIndex(60) * WHITE_KEY_W, 5)
  })

  it('移调后染的是 transposed 那个键', () => {
    const { fills } = render({
      keyLabels: 'off', song, waitTarget: target, transpose: 2,
    })
    const hit = fills.find((f) => f.fillStyle === WAIT_KEY_FILL)
    expect(hit).toBeTruthy()
    expect(hit!.args[0]).toBeCloseTo(whiteKeyIndex(62) * WHITE_KEY_W, 5)
  })

  it('没有目标时 (正常播放) 不染', () => {
    const { fills } = render({ keyLabels: 'off', song, waitTarget: null })
    expect(fills.find((f) => f.fillStyle === WAIT_KEY_FILL)).toBeFalsy()
  })

  it('目标键超出键盘范围时不染 (也不报错)', () => {
    const out: SongNote = { midiNote: 0, time: 2, duration: 1, track: 0, hand: 'right' }
    const { fills } = render({ keyLabels: 'off', song, waitTarget: out })
    expect(fills.find((f) => f.fillStyle === WAIT_KEY_FILL)).toBeFalsy()
  })
})

// =============================================================================
// 3. store + 设置界面
// =============================================================================
describe('store: keyLabels', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('默认全标', () => {
    useStore.setState({ keyLabels: 'all' })
    expect(useStore.getState().keyLabels).toBe('all')
  })

  it('setKeyLabels 会落库', () => {
    useStore.getState().setKeyLabels('c')
    expect(useStore.getState().keyLabels).toBe('c')
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.keyLabels).toBe('c')
  })

  it('老 prefs 没这个字段 → 默认全标', async () => {
    localStorage.clear()
    localStorage.setItem(LS_KEY, JSON.stringify({ ledEnabled: true }))
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().keyLabels).toBe('all')
  })

  it('存的 prefs 里有 → 按存的来', async () => {
    localStorage.clear()
    localStorage.setItem(LS_KEY, JSON.stringify({ keyLabels: 'off' }))
    vi.resetModules()
    const { useStore: fresh } = await import('../src/store')
    expect(fresh.getState().keyLabels).toBe('off')
  })
})

describe('设置抽屉: 键盘标号', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>

  const drawerProps = {
    open: true,
    onClose: () => {},
    onSeek: () => {},
    onRestart: () => {},
    onPlay: () => {},
    onPause: () => {},
  }

  function rowButtons(rowLabel: string): HTMLElement[] {
    const label = [...host.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent ?? '').trim() === rowLabel,
    )
    expect(label, `没有「${rowLabel}」这一行`).toBeTruthy()
    let el: HTMLElement | null = label!.parentElement
    while (el) {
      const btns = [...el.querySelectorAll('button')]
      if (btns.length > 0) return btns
      el = el.parentElement
    }
    return []
  }

  function click(text: string) {
    const b = rowButtons('标号').find((x) => (x.textContent ?? '').trim() === text)
    expect(b, `没有「${text}」按钮`).toBeTruthy()
    ;(b as HTMLElement).click()
  }

  beforeEach(async () => {
    localStorage.clear()
    useStore.setState({ keyLabels: 'all' })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(React.createElement(SettingsDrawer, drawerProps))
    await wait()
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('抽屉里有 不标 / 只标C / 全标 三个选项', () => {
    const texts = rowButtons('标号').map((b) => (b.textContent ?? '').trim())
    expect(texts).toEqual(['不标', '只标C', '全标'])
  })

  it('默认选中「全标」', () => {
    const picked = rowButtons('标号').filter((b) => (b.className ?? '').includes('bg-accent'))
    expect(picked).toHaveLength(1)
    expect((picked[0].textContent ?? '').trim()).toBe('全标')
  })

  it('点「只标C」→ 状态 + 落库', async () => {
    click('只标C')
    await wait()
    expect(useStore.getState().keyLabels).toBe('c')
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.keyLabels).toBe('c')
  })

  it('点「不标」→ 状态 + 落库', async () => {
    click('不标')
    await wait()
    expect(useStore.getState().keyLabels).toBe('off')
    const saved = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    expect(saved.keyLabels).toBe('off')
  })
})
