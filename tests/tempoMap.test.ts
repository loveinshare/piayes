// Tempo map 测试 (spec P2-3 / P2-15 / P1-18)
//
// 覆盖三件事:
//  1. 拍网格跨变速**连续** —— 变速只改"一拍多长", 不重置拍号
//  2. computeMeasures 的小节边界跟着 tempo 走 (旧实现死用 bpms[0].bpm)
//  3. StaffView 的 durInQuarter 量纲正确 (音符时长秒 -> 四分音符)

import { describe, it, expect } from 'vitest'
import { TempoMap, computeMeasures, computeMeasuresFromSignatures } from '../src/util/tempoMap'
import type { Bpm } from '../src/types'

describe('TempoMap', () => {
  it('恒定速度: 拍网格均匀, beatIndexAt / timeOfBeat 互为逆运算', () => {
    const bpms: Bpm[] = [{ time: 0, bpm: 120 }]
    const map = new TempoMap(bpms, 4)
    expect(map.bpmAt(0)).toBe(120)
    expect(map.bpmAt(100)).toBe(120)
    // 4/4 下一拍 = 四分音符 = 0.5s
    expect(map.secPerBeatAt(0)).toBeCloseTo(0.5, 6)
    expect(map.beatIndexAt(0)).toBe(0)
    expect(map.beatIndexAt(2)).toBeCloseTo(4, 6)
    expect(map.timeOfBeat(4)).toBeCloseTo(2, 6)
    expect(map.timeOfBeat(0)).toBeCloseTo(0, 6)
  })

  it('变速: bpmAt 在变速点切换, 拍网格连续不重置', () => {
    // 0~4s 是 120bpm (一拍 0.5s → 8 拍), 4s 起变 60bpm (一拍 1s)
    const bpms: Bpm[] = [
      { time: 0, bpm: 120 },
      { time: 4, bpm: 60 },
    ]
    const map = new TempoMap(bpms, 4)
    expect(map.bpmAt(3.9)).toBe(120)
    expect(map.bpmAt(4.1)).toBe(60)
    // 变速点落在第 8 拍上 —— 拍号**连续**, 不归零
    expect(map.beatIndexAt(4)).toBeCloseTo(8, 6)
    expect(map.timeOfBeat(8)).toBeCloseTo(4, 6)
    // 变速后一拍 1s → 第 9 拍在 5s
    expect(map.timeOfBeat(9)).toBeCloseTo(5, 6)
    expect(map.beatIndexAt(5)).toBeCloseTo(9, 6)
  })

  it('beatTimes 按拍号给出连续拍点 (不漏拍/不重拍)', () => {
    const bpms: Bpm[] = [
      { time: 0, bpm: 120 },
      { time: 4, bpm: 60 },
    ]
    const map = new TempoMap(bpms, 4)
    const times = map.beatTimes(6)
    expect(times[0]).toBeCloseTo(0, 6)
    expect(times[1]).toBeCloseTo(0.5, 6)
    expect(times[8]).toBeCloseTo(4, 6)
    expect(times[9]).toBeCloseTo(5, 6)
    // 单调递增, 且相邻间隔 > 0
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1])
    }
  })

  it('空/非法 bpms 退化成 120bpm', () => {
    const map = new TempoMap([], 4)
    expect(map.bpmAt(0)).toBe(120)
    expect(map.secPerBeatAt(0)).toBeCloseTo(0.5, 6)
    const bad = new TempoMap([{ time: 0, bpm: 0 }], 4)
    expect(bad.bpmAt(0)).toBe(120)
  })

  it('同一时刻多个 tempo 取最后一个', () => {
    const map = new TempoMap(
      [
        { time: 0, bpm: 120 },
        { time: 2, bpm: 90 },
        { time: 2, bpm: 60 },
      ],
      4,
    )
    expect(map.bpmAt(3)).toBe(60)
    expect(map.segments.length).toBe(2)
  })
})

describe('computeMeasures', () => {
  it('恒定速度: 小节线等距', () => {
    const ms = computeMeasures(8, { numerator: 4, denominator: 4 }, [{ time: 0, bpm: 120 }])
    expect(ms.length).toBe(4)
    expect(ms[0].time).toBeCloseTo(0, 6)
    expect(ms[0].duration).toBeCloseTo(2, 6)
    expect(ms[1].time).toBeCloseTo(2, 6)
    expect(ms[3].time).toBeCloseTo(6, 6)
  })

  it('变速: 小节边界跟随 tempo (旧实现死用 bpms[0].bpm → 全错)', () => {
    // 0~4s 120bpm → 每小节 2s; 4s 起 60bpm → 每小节 4s
    const ms = computeMeasures(
      12,
      { numerator: 4, denominator: 4 },
      [
        { time: 0, bpm: 120 },
        { time: 4, bpm: 60 },
      ],
    )
    expect(ms[0].duration).toBeCloseTo(2, 6)
    expect(ms[1].duration).toBeCloseTo(2, 6)
    // 第 3 小节起进入 60bpm 段 → 4s 一小节
    expect(ms[2].time).toBeCloseTo(4, 6)
    expect(ms[2].duration).toBeCloseTo(4, 6)
    expect(ms[3].time).toBeCloseTo(8, 6)
  })

  it('6/8 拍: 一拍 = 八分音符, 每小节 6 拍', () => {
    const ms = computeMeasures(3, { numerator: 6, denominator: 8 }, [{ time: 0, bpm: 120 }])
    // 120bpm 下一拍(八分) = 0.25s → 小节 = 1.5s
    expect(ms[0].duration).toBeCloseTo(1.5, 6)
    expect(ms[1].time).toBeCloseTo(1.5, 6)
  })
})

describe('StaffView 时值量纲 (spec P1-18)', () => {
  it('durInQuarter = 音符秒数 / 该时刻一个四分音符的秒数', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { parseMidi } = await import('../src/parser/parseMidi')
    const { __test__ } = await import('../src/render/StaffView')
    const { TempoMap } = await import('../src/util/tempoMap')

    const buf = readFileSync(resolve(__dirname, 'fixtures/fantaisie-impromptu-op66.mid'))
    const song = parseMidi(new Uint8Array(buf))
    const tempoMap = new TempoMap(song.bpms, song.timeSignature.denominator)
    const beats = __test__.buildMeasureBeats(song)

    let checked = 0
    for (const m of beats) {
      for (const hand of ['right', 'left'] as const) {
        for (const b of m[hand].beats) {
          const note = song.notes[b.noteIndex[0]]
          if (!note) continue
          const expected = note.duration / tempoMap.secPerQuarterAt(note.time)
          expect(b.durInQuarter).toBeCloseTo(expected, 6)
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(10)
  })

  it('小节被音符填满时不再补长休止 (量纲正确 → 长度自洽)', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { parseMidi } = await import('../src/parser/parseMidi')
    const { __test__ } = await import('../src/render/StaffView')
    const { TempoMap } = await import('../src/util/tempoMap')

    const buf = readFileSync(resolve(__dirname, 'fixtures/fantaisie-impromptu-op66.mid'))
    const song = parseMidi(new Uint8Array(buf))
    const tempoMap = new TempoMap(song.bpms, song.timeSignature.denominator)
    const secAt = (t: number) => tempoMap.secPerQuarterAt(t)
    const beats = __test__.buildMeasureBeats(song)
    const filled = __test__.fillWithRests(
      beats[0].left.beats,
      song.measures[0].time,
      song.measures[0].duration,
      secAt,
    )
    // 每个 beat 的时值之和 == 该小节的四分音符数 (4/4 → 4)
    const total = filled.reduce((s, b) => s + b.durInQuarter, 0)
    expect(total).toBeCloseTo(4, 3)
  })
})

describe('computeMeasuresFromSignatures —— 畸形拍号不能把小节切爆', () => {
  it('拍号分子 = 0 → 跳过该段, 不无限往 measures 里塞', () => {
    const measures = computeMeasuresFromSignatures(
      480,
      [{ ticks: 0, numerator: 0, denominator: 4 }],
      (t) => t / 480,
      480 * 64,
    )
    expect(measures).toEqual([])
  })

  it('拍号分母 = 0 → 跳过该段 (不能算出 Infinity)', () => {
    const measures = computeMeasuresFromSignatures(
      480,
      [{ ticks: 0, numerator: 4, denominator: 0 }],
      (t) => t / 480,
      480 * 64,
    )
    expect(measures).toEqual([])
  })

  it('正常拍号照常切小节 (守卫别误伤)', () => {
    const measures = computeMeasuresFromSignatures(
      480,
      [{ ticks: 0, numerator: 4, denominator: 4 }],
      (t) => t / 480,
      480 * 8,
    )
    expect(measures.length).toBe(2)
    expect(measures[0].duration).toBeCloseTo(4, 6)
  })
})
