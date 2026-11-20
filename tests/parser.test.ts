// 解析器单元测试
// 跑法: npm test

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMidi } from '../src/parser/parseMidi'
import { parseXml } from '../src/parser/parseXml'

// jsdom 默认没 DOMParser, 用 linkedom 注入
import { DOMParser, NodeFilter } from 'linkedom'
beforeAll(() => {
  ;(globalThis as any).DOMParser = DOMParser
  ;(globalThis as any).NodeFilter = NodeFilter
  // linkedom 的 parseHTML 走不同入口, 实际不需要
})

describe('parseMidi', () => {
  it('Fur Elise 解析出 notes + bpms + hands', () => {
    const buf = readFileSync(
      resolve(__dirname, '../public/sample.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))

    expect(song.notes.length).toBeGreaterThan(0)
    expect(song.bpms.length).toBeGreaterThan(0)
    expect(song.bpms[0].bpm).toBeGreaterThan(0)
    expect(song.duration).toBeGreaterThan(0)
    expect(song.ppq).toBeGreaterThan(0)
    expect(song.source).toBe('midi')
    // hands 应该是不同 track
    expect(song.hands.left).not.toBe(song.hands.right)
  })

  it('notes 按 time 升序', () => {
    const buf = readFileSync(
      resolve(__dirname, '../public/sample.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))
    for (let i = 1; i < song.notes.length; i++) {
      expect(song.notes[i].time).toBeGreaterThanOrEqual(
        song.notes[i - 1].time,
      )
    }
  })

  it('每个 note 有 hand 字段 (left/right)', () => {
    const buf = readFileSync(
      resolve(__dirname, '../public/sample.mid'),
    )
    const song = parseMidi(new Uint8Array(buf))
    const left = song.notes.filter((n) => n.hand === 'left').length
    const right = song.notes.filter((n) => n.hand === 'right').length
    expect(left).toBeGreaterThan(0)
    expect(right).toBeGreaterThan(0)
  })
})

describe('parseXml', () => {
  // 内联一个简单的右手单声部 MusicXML 测
  const simpleXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <sound tempo="120"/>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>D</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
      <note>
        <pitch><step>F</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
      </note>
    </measure>
  </part>
</score-partwise>`

  it('单 part (G clef) 全部标为 right', () => {
    const song = parseXml(simpleXml)
    expect(song.notes.length).toBe(4)
    for (const n of song.notes) {
      expect(n.hand).toBe('right')
    }
    // C4 D4 E4 F4
    expect(song.notes[0].midiNote).toBe(60)
    expect(song.notes[1].midiNote).toBe(62)
    expect(song.notes[2].midiNote).toBe(64)
    expect(song.notes[3].midiNote).toBe(65)
    // bpm 120, 4/4, divisions 4, duration 4 -> 0.5s/quarter
    // 第一音 time = 0
    expect(song.notes[0].time).toBe(0)
    // 后续每秒 2 个 quarter (120bpm)
    expect(song.notes[1].time).toBeCloseTo(0.5, 2)
  })

  it('chord 复用上一 note 的 time', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
      </note>
      <note>
        <chord/>
        <pitch><step>E</step><octave>4</octave></pitch>
        <duration>4</duration>
      </note>
      <note>
        <chord/>
        <pitch><step>G</step><octave>4</octave></pitch>
        <duration>4</duration>
      </note>
    </measure>
  </part>
</score-partwise>`
    const song = parseXml(xml)
    expect(song.notes.length).toBe(3)
    // 三个和弦 time 都是 0
    for (const n of song.notes) {
      expect(n.time).toBe(0)
    }
  })

  it('F clef 标为 left', () => {
    const xml = `<?xml version="1.0"?>
<score-partwise>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>3</octave></pitch>
        <duration>4</duration>
      </note>
    </measure>
  </part>
</score-partwise>`
    const song = parseXml(xml)
    expect(song.notes[0].hand).toBe('left')
  })
})
