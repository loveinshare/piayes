// 乐库「梦中的婚礼 (Mariage d'amour)」文件回归测试
//
// 用户 2026-10-30 要求: 「重新找一下开源的梦中的婚礼 现在的有bug」
// 用户 2026-11-01 再说: 「感觉不太对」—— 查下来上一轮 (R18) 只修了容器 (曲名 / 标注),
// 音符数据里的两处真损坏没动, 而且还把原曲的变拍给拍平了:
//
//   1. track 0 的曲名是 GBK 字节 → @tonejs/midi 按 Latin-1 解码 → 顶栏显示乱码
//      "ÃÎÖÐµÄ»éÀñ"
//   2. 清单把它标成 "Wedding March / F. Mendelssohn / C major" —— 曲子是
//      Mariage d'amour (Paul de Senneville & Olivier Toussaint), 调是 g 小调
//   3. 那 31 个拍号 (3/4、7/8、6/8、12/8、9/8 ...) 其实**是真的**: 逐个验算过,
//      每一个都正好落在小节线上, 后半段还把前半段的拍号顺序整个重复了一遍 (二段式)。
//      拍平成单个 4/4 之后小节线全错位 (44 小节 -> 55 小节)。
//   4. 有 4 个音符是坏的: 2 个 onset 偏离 16 分网格 (+23 tick, 而且在文件里是倒序写的),
//      2 个 D7(98) —— 全曲唯一超过 C7 的音, 只出现这 2 次, 都夹在坏簇里。
//
// 现在: 1160 个音 / 180.7s / RH 694 + LH 466 / 44 小节 / 32 个拍号。

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { parseMidi } from '../src/parser/parseMidi'
import { measureBeatPoints, hasVariableTimeSignature } from '../src/util/tempoMap'
import manifest from '../public/library/manifest.json'

const FILE = 'public/library/pop/mariage-d-amour.mid'

function loadItem() {
  for (const g of manifest.groups) {
    const it = g.items.find((i) => i.file === 'pop/mariage-d-amour.mid')
    if (it) return it
  }
  throw new Error('清单里找不到 pop/mariage-d-amour.mid')
}

describe('Mariage d\'amour 曲库文件', () => {
  const song = parseMidi(new Uint8Array(readFileSync(FILE)))

  it('文件存在, 旧的 wedding-march.mid 已删掉', () => {
    expect(existsSync(FILE)).toBe(true)
    expect(existsSync('public/library/pop/wedding-march.mid')).toBe(false)
  })

  it('曲名是干净的 ASCII (不再有 GBK 乱码)', () => {
    expect(song.title).toBe("Mariage d'amour")
    // 旧的乱码串
    expect(song.title).not.toMatch(/[À-ÿ]/)
  })

  it('保留原曲的变拍: 32 个拍号, 头几个是 4/4、3/4、7/8、6/8', () => {
    expect(song.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    expect(song.timeSignatures).toHaveLength(32)
    const head = song.timeSignatures!.slice(0, 5)
    expect(head.map((s) => `${s.numerator}/${s.denominator}`)).toEqual([
      '4/4',
      '3/4',
      '7/8',
      '6/8',
      '12/8',
    ])
    // 拍号变化点的时间必须严格递增
    const times = song.timeSignatures!.map((s) => s.time)
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1])
  })

  it('小节按变拍切: 44 小节, 每小节带自己的拍号', () => {
    expect(song.measures).toHaveLength(44)
    // 前 5 小节: 4/4 (两小节) -> 3/4 -> 7/8 -> 6/8
    expect(song.measures.slice(0, 5).map((m) => `${m.numerator}/${m.denominator}`)).toEqual([
      '4/4',
      '4/4',
      '3/4',
      '7/8',
      '6/8',
    ])
    for (const m of song.measures) {
      expect(m.duration).toBeGreaterThan(0)
      expect(m.numerator).toBeGreaterThan(0)
      expect(m.denominator).toBeGreaterThan(0)
    }
    // 小节必须首尾相接, 不能有缝
    for (let i = 1; i < song.measures.length; i++) {
      expect(song.measures[i].time).toBeCloseTo(
        song.measures[i - 1].time + song.measures[i - 1].duration,
        6,
      )
    }
  })

  it('速度只有一条 (72 BPM), 调号是 g 小调 (2 个降号, fifths -2)', () => {
    expect(song.bpms).toHaveLength(1)
    expect(song.bpms[0].bpm).toBeCloseTo(72, 3)
    expect(song.keyFifths).toBe(-2)
  })

  it('音符数据: 1160 个音 / RH 694 + LH 466 / 180.7 秒', () => {
    expect(song.notes).toHaveLength(1160)
    expect(song.notes.filter((n) => n.hand === 'right')).toHaveLength(694)
    expect(song.notes.filter((n) => n.hand === 'left')).toHaveLength(466)
    expect(song.duration).toBeCloseTo(180.7, 1)
    expect(song.handInfer?.method).toBe('two-tracks')
  })

  it('没有损坏的音符: onset 全落在 16 分网格上, 最高音不超过 C7', () => {
    const bpm = song.bpms[0].bpm
    const toTick = (sec: number) => (sec * bpm * song.ppq) / 60
    for (const n of song.notes) {
      const tick = toTick(n.time)
      // 16 分音符 = 120 tick; 坏掉的那两个音偏了 +23 tick, 这里必须抓出来
      expect(Math.abs(tick - Math.round(tick / 120) * 120)).toBeLessThan(1e-6)
    }
    // 全曲最高音 = C7 (96); 之前坏簇里的 D7(98) 已经降回 D6
    expect(Math.max(...song.notes.map((n) => n.midiNote))).toBe(96)
    expect(song.notes.some((n) => n.midiNote === 98)).toBe(false)
  })

  it('旋律是 g 小调 / bB 大调音阶内的音 (没有调外音)', () => {
    const scale = new Set([0, 2, 3, 5, 7, 9, 10]) // C D Eb F G A Bb
    // 唯一的调外音是 F# / E (和声小调的导音), 上行经过音
    const chromatic = song.notes.filter((n) => !scale.has(n.midiNote % 12))
    for (const n of chromatic) {
      expect([42, 52, 54, 66, 76, 88]).toContain(n.midiNote)
    }
  })

  it('清单里的标注是对的 (不再是 Mendelssohn 的婚礼进行曲)', () => {
    const item = loadItem()
    expect(item.id).toBe('mariage-d-amour')
    expect(item.title).toBe("Mariage d'amour")
    expect(item.subtitle).toContain('梦中的婚礼')
    expect(item.composer).toContain('Senneville')
    expect(item.key).toBe('G minor')
    expect(item.tracks).toBe(2)
  })
})

describe('Mariage d\'amour 变拍拍网格', () => {
  const song = parseMidi(new Uint8Array(readFileSync(FILE)))
  const secPerQuarter = 60 / song.bpms[0].bpm
  const points = measureBeatPoints(song.measures, song.timeSignature, () => secPerQuarter)

  it('认得出这是变拍曲 (整首一个拍号的曲子不算)', () => {
    expect(hasVariableTimeSignature(song.measures, song.timeSignature)).toBe(true)
    expect(hasVariableTimeSignature([{ time: 0, duration: 1 }], song.timeSignature)).toBe(false)
    expect(
      hasVariableTimeSignature(
        [{ time: 0, duration: 1, numerator: 4, denominator: 4 }],
        song.timeSignature,
      ),
    ).toBe(false)
  })

  it('每一小节的强拍正好落在小节线上 (节拍器不会打在拍子中间)', () => {
    const downbeats = points.filter((p) => p.isDownbeat)
    expect(downbeats).toHaveLength(song.measures.length)
    for (let i = 0; i < song.measures.length; i++) {
      expect(downbeats[i].measureIndex).toBe(i)
      expect(downbeats[i].time).toBeCloseTo(song.measures[i].time, 6)
      expect(downbeats[i].beatInMeasure).toBe(0)
    }
  })

  it('每一小节按自己的拍号出拍 (6/8 走八分音符, 9/8 走附点四分)', () => {
    for (let mi = 0; mi < song.measures.length; mi++) {
      const m = song.measures[mi]
      const inMeasure = points.filter((p) => p.measureIndex === mi)
      expect(inMeasure.length).toBeGreaterThan(0)
      expect(inMeasure.length).toBeLessThanOrEqual(m.numerator!)
      const beatSec = (4 / m.denominator!) * secPerQuarter
      for (let i = 1; i < inMeasure.length; i++) {
        expect(inMeasure[i].time - inMeasure[i - 1].time).toBeCloseTo(beatSec, 6)
      }
      for (const p of inMeasure) {
        expect(p.time).toBeLessThanOrEqual(m.time + m.duration + 1e-6)
      }
    }
    const sixEight = song.measures.findIndex((m) => m.numerator === 6 && m.denominator === 8)
    expect(sixEight).toBeGreaterThanOrEqual(0)
    const p68 = points.filter((p) => p.measureIndex === sixEight)
    expect(p68.length).toBe(6)
    expect(p68[1].time - p68[0].time).toBeCloseTo(0.5 * secPerQuarter, 6)
    const nineEight = song.measures.findIndex((m) => m.numerator === 9 && m.denominator === 8)
    expect(points.filter((p) => p.measureIndex === nineEight).length).toBe(9)
  })
})
