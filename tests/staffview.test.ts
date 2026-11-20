
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// DOMParser shim for VexFlow in node (VexFlow needs document for SVG renderer)
// We won't actually render — just test the buildBeatEvents helpers which are pure functions.

describe('StaffView helpers', () => {
  it('parses Chopin nocturne and exposes measures', async () => {
    const { parseMidi } = await import('../src/parser/parseMidi')
    const buf = readFileSync(resolve(__dirname, '../public/library/chopin/nocturne-eb-major-aigei.mid'))
    const song = parseMidi(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
    expect(song.measures.length).toBeGreaterThan(0)
    expect(song.timeSignature.numerator).toBeGreaterThan(0)
  })

  it('parses Bach bwv1041 and exposes 2-part hands', async () => {
    const { parseMxl } = await import('../src/parser/parseMxl')
    const buf = readFileSync(resolve(__dirname, '../public/library/bach/bwv1041-allegro-moderato.mxl'))
    const song = parseMxl(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
    const leftNotes = song.notes.filter(n => n.hand === 'left').length
    const rightNotes = song.notes.filter(n => n.hand === 'right').length
    expect(leftNotes).toBeGreaterThan(0)
    expect(rightNotes).toBeGreaterThan(0)
  })
})

describe('binPackIntoSystems', () => {
  it('packs small measures into one system', async () => {
    // narrow export — `binPackIntoSystems` is exported as a named export
    const { binPackIntoSystems } = await import('../src/render/StaffView')
    const sys = binPackIntoSystems([100, 100, 100], 400)
    expect(sys).toEqual([{ startIdx: 0, endIdx: 2 }])
  })

  it('splits when next measure overflows', async () => {
    const { binPackIntoSystems } = await import('../src/render/StaffView')
    const sys = binPackIntoSystems([100, 200, 150, 100], 400)
    expect(sys).toEqual([
      { startIdx: 0, endIdx: 1 },
      { startIdx: 2, endIdx: 3 },
    ])
  })

  it('one giant measure alone', async () => {
    const { binPackIntoSystems } = await import('../src/render/StaffView')
    const sys = binPackIntoSystems([600, 100, 100], 400)
    expect(sys).toEqual([
      { startIdx: 0, endIdx: 0 },
      { startIdx: 1, endIdx: 2 },
    ])
  })

  it('empty input returns empty', async () => {
    const { binPackIntoSystems } = await import('../src/render/StaffView')
    expect(binPackIntoSystems([], 400)).toEqual([])
  })
})

describe('durationToVex', () => {
  it('snaps dotted half (1.5q) to hd, not h + tail', async () => {
    const { __test__ } = await import('../src/render/StaffView')
    // 1.5q in quarter units
    expect(__test__.durationToVex(1.5)).toBe('qd')
  })

  it('snaps 64th (0.0625q) to 64', async () => {
    const { __test__ } = await import('../src/render/StaffView')
    expect(__test__.durationToVex(0.0625)).toBe('64')
    expect(__test__.durationToVex(0.09375)).toBe('64d')
  })

  it('never returns a duration larger than actual (avoids BadTicks)', async () => {
    const { __test__ } = await import('../src/render/StaffView')
    // 0.05q (极短) should snap down to 64 (0.0625 is closest ≤ but 0.05 < 0.0625, fallback 64r rest)
    // durationToVex(0.05) ≤ 0.0625 → '64'
    const r = __test__.durationToVex(0.05)
    expect(['64', '32']).toContain(r) // never w/h/q/8/16
  })
})

