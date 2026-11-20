import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Midi } from '@tonejs/midi'
import { unzipSync } from 'fflate'
import {
  hitTestRoll,
  locateNote,
  makeRollView,
  noteRect,
  pitchToY,
  timeToX,
  xToTime,
  yToPitch,
  whiteKeySpan,
} from '../src/editor/roll'
import { isBlackKey } from '../src/render/colors'
import { buildMidi, latin1Safe } from '../src/editor/exportMidi'
import { buildMusicXml, buildMxl } from '../src/editor/exportMusicXml'
import { parseMxl } from '../src/parser/parseMxl'
import { ScoreEditor } from '../src/ui/ScoreEditor'
import type { Song, SongNote } from '../src/types'

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms))

function makeSong(over: Partial<Song> = {}): Song {
  return {
    notes: [],
    measures: [
      { number: 1, time: 0, duration: 2 },
      { number: 2, time: 2, duration: 2 },
      { number: 3, time: 4, duration: 2 },
    ],
    bpms: [{ time: 0, bpm: 120 }],
    duration: 6,
    ppq: 480,
    hands: { left: 1, right: 0 },
    timeSignature: { numerator: 4, denominator: 4 },
    source: 'midi',
    title: '测试曲',
    composer: '某人',
    ...over,
  }
}

const NOTES: SongNote[] = [
  { midiNote: 60, time: 0, duration: 0.5, track: 0, hand: 'right', velocity: 0.8 },
  { midiNote: 62, time: 0.5, duration: 0.25, track: 0, hand: 'right', velocity: 0.8 },
  { midiNote: 64, time: 0.75, duration: 1.5, track: 0, hand: 'right', velocity: 0.9 },
  { midiNote: 48, time: 0, duration: 2, track: 1, hand: 'left', velocity: 0.7 },
  { midiNote: 43, time: 2.5, duration: 0.75, track: 1, hand: 'left', velocity: 0.7 },
]

/** 不跨小节的音符 —— 用来验证 MXL 往返是**无损**的 */
const SIMPLE_NOTES: SongNote[] = [
  { midiNote: 60, time: 0, duration: 0.5, track: 0, hand: 'right', velocity: 0.8 },
  { midiNote: 62, time: 0.5, duration: 0.25, track: 0, hand: 'right', velocity: 0.8 },
  { midiNote: 48, time: 0, duration: 1.5, track: 1, hand: 'left', velocity: 0.7 },
  { midiNote: 43, time: 2.5, duration: 0.75, track: 1, hand: 'left', velocity: 0.7 },
]

/* ================================================================== *
 * 1. 几何换算 + 命中测试
 * ================================================================== */

describe('editor/roll · 钢琴卷帘几何', () => {
  const view = makeRollView({ zoom: 100, viewStart: 0, scrollTop: 24, topPitch: 80 })

  it('时间 ↔ 屏幕 x 互逆', () => {
    for (const t of [0, 0.5, 1, 3.75, 12]) {
      expect(xToTime(view, timeToX(view, t))).toBeCloseTo(t, 6)
    }
  })

  it('音高 ↔ 屏幕 y 互逆 (整行才对得上)', () => {
    for (const p of [40, 60, 79]) {
      const y = pitchToY(view, p) + 1
      expect(yToPitch(view, y)).toBe(p)
    }
  })

  it('音符矩形: 宽度 = 时值 × 缩放, 高度 = 一行', () => {
    const r = noteRect(view, NOTES[0])
    expect(r.w).toBeCloseTo(0.5 * 100, 6)
    expect(r.h).toBe(view.rowH)
  })

  it('命中测试能找回那个音', () => {
    const n = NOTES[1] // midi 62, t=0.5, dur=0.25
    const r = noteRect(view, n)
    const hit = hitTestRoll(NOTES, view, r.x + r.w / 2, r.y + 1)
    expect(hit).not.toBeNull()
    expect(hit!.index).toBe(1)
    expect(hit!.mode).toBe('move')
  })

  it('贴着右边缘 = 拖右边缘改时值 (resize)', () => {
    const n = NOTES[1]
    const r = noteRect(view, n)
    const hit = hitTestRoll(NOTES, view, r.x + r.w - 1, r.y + 1)
    expect(hit!.mode).toBe('resize')
    expect(hit!.index).toBe(1)
  })

  it('琴键条 / 标尺不命中音符', () => {
    const r = noteRect(view, NOTES[0])
    expect(hitTestRoll(NOTES, view, 10, r.y + 1)).toBeNull()
    expect(hitTestRoll(NOTES, view, r.x + 1, 3)).toBeNull()
  })

  it('空白处不命中', () => {
    expect(hitTestRoll(NOTES, view, view.keysW + 2, pitchToY(view, 70))).toBeNull()
  })
})

describe('editor/roll · 小节 / 拍定位', () => {
  const song = makeSong({ notes: NOTES })

  it('第一个音 = 第 1 小节第 1 拍', () => {
    expect(locateNote(song, NOTES[0])).toEqual({ measure: 1, beat: 1 })
  })

  it('2 秒处 = 第 2 小节第 1 拍 (120bpm, 一拍 0.5s)', () => {
    const n = { ...NOTES[0], time: 2 }
    expect(locateNote(song, n)).toEqual({ measure: 2, beat: 1 })
  })

  it('0.75 秒处 = 第 1 小节第 2 拍', () => {
    const n = { ...NOTES[0], time: 0.75 }
    expect(locateNote(song, n)).toEqual({ measure: 1, beat: 2 })
  })
})
/* ================================================================== *
 * 2. 导出往返
 * ================================================================== */

describe('导出 · MIDI 往返', () => {
  it('音高 / 起始 / 时值 原样回来', () => {
    const song = makeSong({ notes: NOTES })
    const bytes = buildMidi(song, NOTES)
    const back = new Midi(bytes)
    const all = back.tracks.flatMap((t) => t.notes)
    expect(all.length).toBe(NOTES.length)
    for (const n of NOTES) {
      const hit = all.find((m) => m.midi === n.midiNote)
      expect(hit, `midi ${n.midiNote} 没导出去`).toBeTruthy()
      expect(hit!.time).toBeCloseTo(n.time, 3)
      expect(hit!.duration).toBeCloseTo(n.duration, 3)
    }
  })

  it('中文标题不会变成乱码 (MIDI meta 是 Latin-1)', () => {
    expect(latin1Safe('测试曲')).toBe('???')
    const song = makeSong({ notes: NOTES, title: '测试曲' })
    const back = new Midi(buildMidi(song, NOTES))
    // 只剩 ASCII, 不会像以前那样变成 "KÕò"
    expect(/^[\x20-\x7e]*$/.test(back.header.name)).toBe(true)
  })

  it('变速曲子的 tempo 段也能对上', () => {
    const song = makeSong({
      notes: NOTES,
      bpms: [
        { time: 0, bpm: 120 },
        { time: 2, bpm: 60 },
      ],
    })
    const back = new Midi(buildMidi(song, NOTES))
    const all = back.tracks.flatMap((t) => t.notes)
    const n = NOTES[3] // t=0, dur=2 → 结束在 2s (速度刚好变)
    const hit = all.find((m) => m.midi === n.midiNote)
    expect(hit!.time).toBeCloseTo(0, 3)
    expect(hit!.duration).toBeCloseTo(2, 2)
  })
})

describe('导出 · MusicXML / MXL 往返', () => {
  it('MusicXML 结构对: 2 个 part (左右手), 每个 note 都有 duration', () => {
    const song = makeSong({ notes: SIMPLE_NOTES })
    const xml = buildMusicXml(song, SIMPLE_NOTES)
    expect(xml.startsWith('<?xml')).toBe(true)
    expect((xml.match(/<part id=/g) ?? []).length).toBe(2)
    expect((xml.match(/<note>/g) ?? []).length).toBe(SIMPLE_NOTES.length)
    expect((xml.match(/<duration>/g) ?? []).length).toBe(SIMPLE_NOTES.length)
  })

  it('MXL 是合法 zip, 结构对 (mimetype 在最前)', () => {
    const song = makeSong({ notes: SIMPLE_NOTES })
    const bytes = buildMxl(song, SIMPLE_NOTES)
    const files = unzipSync(bytes)
    expect(Object.keys(files)).toContain('META-INF/container.xml')
    expect(Object.keys(files)).toContain('score.musicxml')
    // mimetype 必须是第一个条目 (OPC 规范)
    expect(bytes[0] === 0x50 && bytes[1] === 0x4b).toBe(true)
  })

  it('导出的 MXL 能被自己的解析器读回来: 音高 / 起始时间 全对', () => {
    // ⚠️ 时值会偏 —— 本项目的 parseXml 用「下一个音的时间差」估时值, 不读 <duration>.
    //   (见 exportMusicXml.ts 顶部的说明) 无损的路径是「应用到当前曲目」和「导出 .mid」.
    const song = makeSong({ notes: SIMPLE_NOTES })
    const back = parseMxl(buildMxl(song, SIMPLE_NOTES))
    expect(back.notes.length).toBe(SIMPLE_NOTES.length)
    for (const n of SIMPLE_NOTES) {
      const hit = back.notes.find((m) => m.midiNote === n.midiNote)
      expect(hit, `midi ${n.midiNote} 丢了`).toBeTruthy()
      expect(hit!.time).toBeCloseTo(n.time, 2)
    }
  })

  it('写进文件的 <duration> 是精确的 (外部软件读这个)', () => {
    const song = makeSong({ notes: SIMPLE_NOTES })
    const xml = buildMusicXml(song, SIMPLE_NOTES)
    const durs = [...xml.matchAll(/<duration>(\d+)<\/duration>/g)].map((m) => Number(m[1]))
    // divisions=480 → 一个四分音符 = 480 ticks; 120bpm 下四分音符 = 0.5s
    // 所以 0.5s = 480 ticks, 0.25s = 240 ticks …
    const expected = SIMPLE_NOTES.map((n) => Math.round(n.duration * 960))
    for (const e of expected) {
      expect(durs).toContain(e)
    }
  })

  it('跨小节的音按小节线切开 + 打 tie, 两段时值加起来还是原来那么长', () => {
    // NOTES[2]: t=0.75, dur=1.5 → 跨过 2.0 的小节线
    const crossing = [NOTES[2]]
    const song = makeSong({ notes: crossing })
    const xml = buildMusicXml(song, crossing)
    // 切成两段
    expect((xml.match(/<note>/g) ?? []).length).toBe(2)
    expect(xml).toContain('<tie type="start"/>')
    expect(xml).toContain('<tie type="stop"/>')
    const durs = [...xml.matchAll(/<duration>(\d+)<\/duration>/g)].map((m) => Number(m[1]))
    expect(durs.reduce((a, b) => a + b, 0)).toBe(Math.round(1.5 * 960))
  })
})

/* ================================================================== *
 * 3. 编辑器组件交互
 * ================================================================== */

function fakeSynth() {
  const played: { midi: number; when?: number }[] = []
  return {
    played,
    getCtx: () => ({ currentTime: 0, state: 'running' }),
    resume: () => {},
    stopAll: () => {},
    playNote: (n: { midiNote: number }, _t?: number, _v?: number, when?: number) => {
      played.push({ midi: n.midiNote, when })
    },
  }
}

describe('ScoreEditor · 组件交互', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  const applied: SongNote[][] = []
  const synth = fakeSynth()

  beforeEach(() => {
    applied.length = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
  })

  async function render(props: Partial<React.ComponentProps<typeof ScoreEditor>> = {}) {
    const song = makeSong({ notes: NOTES })
    root.render(
      React.createElement(ScoreEditor, {
        open: true,
        song,
        synth: synth as never,
        onClose: () => {},
        onApply: (ns: SongNote[]) => applied.push(ns),
        ...props,
      }),
    )
    await wait(60)
  }

  function press(key: string, opts: KeyboardEventInit = {}) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }))
  }

  /**
   * 等某个条件成立.
   *
   * 不用固定 sleep —— 整套测试并行跑的时候, 机器一忙 React 的调度就可能被推后,
   * 固定 60ms 会偶发地不够 (之前就踩过一次: 面板还没渲染出来就断言了).
   */
  async function waitFor(pred: () => boolean, timeout = 3000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (pred()) return true
      await wait(20)
    }
    return pred()
  }

  function text() {
    return host.textContent ?? ''
  }

  it('打开时显示标题和工具栏', async () => {
    await render()
    expect(text()).toContain('谱子编辑器')
    expect(text()).toContain('应用到当前曲目')
  })

  it('focusIndex 定位到那个音, 面板显示它的唯一编码', async () => {
    await render({ focusIndex: 2 })
    expect(await waitFor(() => text().includes('唯一编码'))).toBe(true)
    // 音名 = E4 (midi 64)
    expect(await waitFor(() => text().includes('E4'))).toBe(true)
  })

  it('↑ 键把选中音符升高一个半音', async () => {
    await render({ focusIndex: 2 })
    expect(await waitFor(() => text().includes('E4'))).toBe(true)
    press('ArrowUp')
    expect(await waitFor(() => text().includes('F4'))).toBe(true)
  })

  it('↓ 键把选中音符降低一个半音', async () => {
    await render({ focusIndex: 2 })
    expect(await waitFor(() => text().includes('E4'))).toBe(true)
    press('ArrowDown')
    expect(await waitFor(() => text().includes('D#4'))).toBe(true)
  })

  it('Delete 删掉选中的音, Ctrl+Z 能撤销', async () => {
    await render({ focusIndex: 2 })
    expect(await waitFor(() => text().includes('E4'))).toBe(true)
    press('Delete')
    // 删掉一个 → 计数变成 4
    expect(await waitFor(() => text().includes('4'))).toBe(true)
    press('z', { ctrlKey: true })
    // 撤销 → 回到 5
    expect(await waitFor(() => text().includes('5'))).toBe(true)
  })

  it('「应用到当前曲目」把改好的音符交出去 (按时间排序)', async () => {
    await render({ focusIndex: 2 })
    expect(await waitFor(() => text().includes('E4'))).toBe(true)
    press('ArrowUp')
    expect(await waitFor(() => text().includes('F4'))).toBe(true)
    const btn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('应用到当前曲目'),
    )
    expect(btn).toBeTruthy()
    ;(btn as HTMLButtonElement).click()
    await wait()
    expect(applied.length).toBe(1)
    const out = applied[0]
    expect(out.length).toBe(NOTES.length)
    // 时间升序
    for (let i = 1; i < out.length; i++) {
      expect(out[i].time).toBeGreaterThanOrEqual(out[i - 1].time)
    }
    // 改过的那个音升了半音: 64 → 65
    expect(out.some((n) => n.midiNote === 65)).toBe(true)
  })

  it('关闭时不渲染任何东西', async () => {
    await render({ open: false })
    expect(host.innerHTML).toBe('')
  })
})

describe('ScoreEditor · 点音符 = 选中 + 响一声', () => {
  let host: HTMLElement
  let root: ReturnType<typeof createRoot>
  const synth = fakeSynth()
  const sent: { on: number[]; off: number[] } = { on: [], off: [] }
  let rectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    synth.played.length = 0
    sent.on.length = 0
    sent.off.length = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    // jsdom 里 canvas 没有布局 (高 0) → 纵向滚动会把音符顶到可视区外.
    // 假装有个 800x600 的画布, 点击坐标才好算.
    rectSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  })

  afterEach(async () => {
    root.unmount()
    document.body.innerHTML = ''
    rectSpy.mockRestore()
  })

  const midiOut = {
    isEnabled: () => true,
    sendNoteOn: (n: SongNote) => { sent.on.push(n.midiNote) },
    sendNoteOff: (n: SongNote) => { sent.off.push(n.midiNote) },
  }

  async function renderEditor(props: Partial<React.ComponentProps<typeof ScoreEditor>> = {}) {
    root.render(
      React.createElement(ScoreEditor, {
        open: true,
        song: makeSong({ notes: NOTES }),
        synth: synth as never,
        midiOut,
        onClose: () => {},
        onApply: () => {},
        ...props,
      }),
    )
    await wait(120)
  }

  /** 第一个音符 (midi 60, time 0) 的屏幕坐标 —— 见 editor/roll.ts 的换算 */
  function firstNotePoint() {
    const zoom = 110
    const keysW = 54
    const rulerH = 22
    const rowH = 12
    const topPitch = Math.min(108, Math.max(...NOTES.map((n) => n.midiNote)) + 3)
    const x = keysW + 5 // 音符左边缘往右一点, 别贴着右边缘 (那是改时值)
    const y = rulerH + (topPitch - 60) * rowH + rowH / 2
    return { x, y, zoom }
  }

  it('点音符 → 选中它, 并往 MIDI 输出 (电钢) 发一声', async () => {
    await renderEditor()
    const { x, y } = firstNotePoint()
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    )
    await wait(60)

    // 电钢响了一声 (note-on), 音高就是点的那个音
    expect(sent.on).toEqual([60])
    // 走了 MIDI 输出就不该再走浏览器合成器 (别两处一起响)
    expect(synth.played).toEqual([])
    // 选中态: 右侧面板出现这个音的信息
    expect(host.textContent).toContain('唯一编码')

    // 音结束后要发 note-off, 否则电钢上的键一直压着
    await wait(900)
    expect(sent.off).toEqual([60])
  })

  it('没连 MIDI 输出 → 走浏览器合成器发声', async () => {
    await renderEditor({ midiOut: undefined })
    const { x, y } = firstNotePoint()
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    )
    await wait(60)
    expect(sent.on).toEqual([])
    expect(synth.played.map((p) => p.midi)).toEqual([60])
  })

  it('点音符 → 灯带只亮这一个音, 并且要 show (树莓派 set_many 不 show 就刷不出来)', async () => {
    const lit: number[] = []
    const off: number[] = []
    let shows = 0
    const ledRef = {
      current: {
        noteOn: (n: number) => { lit.push(n) },
        noteOff: (n: number) => { off.push(n) },
        show: () => { shows++ },
      },
    }
    await renderEditor({ ledRef })
    const { x, y } = firstNotePoint()
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    )
    await wait(60)
    expect(lit).toEqual([60])
    expect(shows).toBeGreaterThan(0)

    // 定位灯: 亮着不灭 (用户要靠它在琴上找键位)
    await wait(900)
    expect(off).toEqual([])
  })

  it('点另一个音 → 上一个音灭, 新的亮 (同一时刻只亮一个)', async () => {
    const lit: number[] = []
    const off: number[] = []
    const ledRef = {
      current: {
        noteOn: (n: number) => { lit.push(n) },
        noteOff: (n: number) => { off.push(n) },
      },
    }
    await renderEditor({ ledRef })
    const canvas = host.querySelector('canvas')!
    const p1 = firstNotePoint()
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: p1.x, clientY: p1.y, bubbles: true }),
    )
    await wait(60)
    // 第二个音 (midi 62, time 0.5) 的位置
    const x2 = 54 + 0.5 * 110 + 5
    const y2 = 22 + (67 - 62) * 12 + 6
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x2, clientY: y2, bubbles: true }),
    )
    await wait(60)
    expect(lit).toEqual([60, 62])
    expect(off).toEqual([60])
  })

  it('编辑器关掉 → 定位灯灭', async () => {
    const off: number[] = []
    const ledRef = {
      current: {
        noteOn: () => {},
        noteOff: (n: number) => { off.push(n) },
      },
    }
    await renderEditor({ ledRef })
    const { x, y } = firstNotePoint()
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    )
    await wait(60)
    expect(off).toEqual([])

    await renderEditor({ ledRef, open: false })
    await wait(60)
    expect(off).toEqual([60])
  })

  it('上下键挪音高 → 响一声 (新音高) + 灯带跟到新键', async () => {
    const lit: number[] = []
    const ledRef = {
      current: {
        noteOn: (n: number) => { lit.push(n) },
        noteOff: () => {},
      },
    }
    await renderEditor({ ledRef })
    const { x, y } = firstNotePoint()
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    )
    await wait(60)
    expect(lit).toEqual([60])
    expect(sent.on).toEqual([60])

    // ↑ = 音高 +1
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await wait(60)
    expect(sent.on).toEqual([60, 61])
    expect(lit).toEqual([60, 61])
  })

  it('左右键挪时间 → 也响一声 (音高不变, 灯带停在同一个键)', async () => {
    const lit: number[] = []
    const ledRef = {
      current: {
        noteOn: (n: number) => { lit.push(n) },
        noteOff: () => {},
      },
    }
    await renderEditor({ ledRef })
    const { x, y } = firstNotePoint()
    const canvas = host.querySelector('canvas')!
    canvas.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y, bubbles: true }),
    )
    await wait(60)
    expect(sent.on).toEqual([60])

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await wait(60)
    expect(sent.on).toEqual([60, 60])
    expect(lit).toEqual([60, 60])
  })
})
describe('whiteKeySpan — 左侧琴键条的白键跨行', () => {
  it('C 跨 2 行 (盖住 C# 那半格), E 只跨 1 行', () => {
    expect(whiteKeySpan(60)).toEqual({ topPitch: 61, rows: 2 })
    expect(whiteKeySpan(64)).toEqual({ topPitch: 64, rows: 1 })
  })

  it('F / G / A 各跨 2 行, B 跨 1 行', () => {
    expect(whiteKeySpan(65).rows).toBe(2) // F
    expect(whiteKeySpan(67).rows).toBe(2) // G
    expect(whiteKeySpan(69).rows).toBe(2) // A
    expect(whiteKeySpan(71).rows).toBe(1) // B
  })

  it('每个黑键都被某个白键盖住 (之前黑键全被白键刷掉, 琴键条一片白)', () => {
    for (let midi = 21; midi <= 108; midi++) {
      if (!isBlackKey(midi)) continue
      const owner = [midi - 1, midi - 2].find((p) => midi <= whiteKeySpan(p).topPitch)
      expect(owner, `黑键 ${midi} 没有被任何白键盖住`).toBeDefined()
    }
  })

  it('最高音 B (127) 不越界', () => {
    expect(whiteKeySpan(127)).toEqual({ topPitch: 127, rows: 1 })
  })
})
