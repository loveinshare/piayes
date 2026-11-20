// Smoke test: 验证 Chopin MIDI 的 hand 推断结果
// 现在 nocturne-eb-major-aigei.mid 是双 track MIDI (track 0=RH avg 78, track 1=LH avg 58),
// inferHands 走"按 track 平均音高分配"分支, 直接对.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMidi } from '../src/parser/parseMidi'
import { inferHands } from '../src/parser/inferHands'
import type { SongNote } from '../src/types'

function n(time: number, midi: number, track = 0): SongNote {
  return { time, duration: 1, midiNote: midi, track, hand: undefined, velocity: 0.8 }
}

describe('inferHands (Chopin)', () => {
  it('双 track: track 0=RH, track 1=LH, 几乎无错配', async () => {
    const buf = readFileSync(
      resolve(__dirname, '../public/library/chopin/nocturne-eb-major-aigei.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))
    const total = song.notes.length
    const leftCount = song.notes.filter((n) => n.hand === 'left').length
    const rightCount = song.notes.filter((n) => n.hand === 'right').length

    // 双 track: 占比基本按曲子结构, 大约 40% RH / 60% LH, 不是单 track 时代那个 < 25%
    expect(rightCount).toBeGreaterThan(total * 0.35)
    expect(leftCount).toBeGreaterThan(total * 0.5)
    // 极小边界 case (midi 55 / 74) 允许 ≤ 2 个错配
    const highLeft = song.notes.filter((n) => n.hand === 'left' && n.midiNote > 72)
    const lowRight = song.notes.filter((n) => n.hand === 'right' && n.midiNote < 60)
    expect(highLeft.length).toBeLessThan(5)
    expect(lowRight.length).toBeLessThan(5)
  })

  it('开篇前 6s 有 RH 旋律音', async () => {
    const buf = readFileSync(
      resolve(__dirname, '../public/library/chopin/nocturne-eb-major-aigei.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))
    const opening = song.notes.filter((n) => n.time < 6)
    expect(opening.some((n) => n.hand === 'right')).toBe(true)
  })
})


// 手别置信度 + 手动纠正 (spec P2-6)
describe('inferHands 置信度与手动纠正', () => {
  it('单 track 声部聚类 = 启发式 → confidence 为 low', () => {
    const notes = [n(0, 72), n(1, 74), n(2, 40), n(3, 42)]
    const res = inferHands(notes, null, [{ time: 0, bpm: 120 }], { numerator: 4, denominator: 4 })
    expect(res.method).toBe('voice-clusters')
    expect(res.confidence).toBe('low')
  })

  it('显式 hand → confidence 为 high', () => {
    const notes = [n(0, 72), n(1, 40)]
    notes[0].hand = 'right'
    notes[1].hand = 'left'
    const res = inferHands(notes, null, [{ time: 0, bpm: 120 }], { numerator: 4, denominator: 4 })
    expect(res.method).toBe('per-note')
    expect(res.confidence).toBe('high')
  })

  it('双 track → confidence 为 high', () => {
    const notes = [n(0, 72, 0), n(1, 74, 1), n(2, 40, 0), n(3, 42, 1)]
    const res = inferHands(notes, null, [{ time: 0, bpm: 120 }], { numerator: 4, denominator: 4 })
    expect(res.method).toBe('two-tracks')
    expect(res.confidence).toBe('high')
  })

  it('mode=pitch: 按音高切分, 覆盖启发式结果', () => {
    const notes = [n(0, 72), n(1, 40), n(2, 55)]
    const res = inferHands(notes, null, [{ time: 0, bpm: 120 }], { numerator: 4, denominator: 4 }, {
      mode: 'pitch',
      pitchSplit: 60,
    })
    expect(res.method).toBe('pitch-split')
    expect(res.confidence).toBe('medium')
    expect(res.pitchSplit).toBe(60)
    expect(notes[0].hand).toBe('right') // 72 >= 60
    expect(notes[1].hand).toBe('left') // 40 < 60
    expect(notes[2].hand).toBe('left') // 55 < 60
  })

  it('parseMidi 把置信度带进 Song.handInfer', () => {
    const buf = readFileSync(
      resolve(__dirname, '../public/library/chopin/nocturne-eb-major-aigei.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))
    expect(song.handInfer).toBeDefined()
    expect(song.handInfer?.method).toBe('two-tracks')
    expect(song.handInfer?.confidence).toBe('high')
  })
})
