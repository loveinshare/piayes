// .mxl (compressed MusicXML) 解析测试

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMxl } from '../src/parser/parseMxl'
import { parseMidi } from '../src/parser/parseMidi'

describe('parseMxl', () => {
  it('Pachelbel Canon in D (.mid) 解析出 notes + duration', () => {
    const buf = readFileSync(
      resolve(__dirname, './fixtures/pachelbel-canon-in-d-poly.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
    expect(song.duration).toBeGreaterThan(0)
    expect(song.source).toBe('midi')
  })

  it('Chopin Nocturne Op9 No2 (.mxl) 解析出 notes + hands', () => {
    const buf = readFileSync(
      resolve(__dirname, './fixtures/nocturne-op9-no2.mxl'),
    )
    const song = parseMxl(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
    expect(song.duration).toBeGreaterThan(0)
    expect(song.source).toBe('xml')
    // .mxl 应该有 hand 字段 (从 MusicXML clef 来)
    const left = song.notes.filter((n) => n.hand === 'left').length
    const right = song.notes.filter((n) => n.hand === 'right').length
    expect(right).toBeGreaterThan(0)
    expect(left).toBeGreaterThan(0)
  })

  it('Chopin Fantaisie-Impromptu (.mid) 解析成功', () => {
    const buf = readFileSync(
      resolve(
        __dirname,
        './fixtures/fantaisie-impromptu-op66.mid',
      ),
    )
    const song = parseMidi(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
    expect(song.source).toBe('midi')
  })

  it('Waltz Op64 No1 (.mxl) 解析成功 (小狗圆舞曲)', () => {
    const buf = readFileSync(
      resolve(__dirname, './fixtures/waltz_op64_no1.mxl'),
    )
    const song = parseMxl(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
  })

  it('Waltz Op34 No3 (.mxl) 解析成功 (小猫圆舞曲)', () => {
    const buf = readFileSync(
      resolve(__dirname, './fixtures/waltz_op34_no3.mxl'),
    )
    const song = parseMxl(new Uint8Array(buf))
    expect(song.notes.length).toBeGreaterThan(0)
  })
})

