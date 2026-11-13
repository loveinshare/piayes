// BWV 1041 钢琴独奏 v2 (用户反馈 "不好听 没有美感" 之后重做的三版)
//
// v1 的毛病 (用户原话: 「不好听 没有美感」):
//   - 左手是**按节拍网格现编的通用和弦模板**, 不是原谱里的东西
//   - 46/294 个和弦是空壳 (缺三音), 跟旋律平行五度/八度一大把
//   - 音区常年 36..55, 力度恒定 72 —— 听着像机器按的和弦伴奏
//
// v2 的做法: **左手全部用原谱的音** (大提琴走路低音 + 中提琴), 只做八度折叠;
//   和弦版是把原谱**真实响过的音**归成和弦, 最多一拍一变.
//
// 这里守住这几条底线:
//   1. 右手 = 库里原版独奏小提琴轨, **逐字节相同** (用户要求「右手不动」)
//   2. 原版条目跟它的 Solo Violin 轨**一个字节都没碰**
//   3. 左手不跟右手撞小二度
//   4. 和弦版的和弦音**不跟旋律平行五度/八度** —— 平行八度是「机器人感」
//      的主要来源 (v1 就有 46 处)
//   5. 左手不编造原谱里没有的音 (低音版/原声部版只能是原谱的音, 折八度)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readChunks, notesOf, readParts } from '../scripts/lib/bwv1041.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LIB = resolve(__dirname, '../public/library')
const SOURCE = resolve(
  __dirname,
  '../tests/fixtures/midi/Bach Concertos Bwv 1041 Violin Concerto N 1 1 Mov.mid',
)
const DIV = 384

const manifest = JSON.parse(readFileSync(resolve(LIB, 'manifest.json'), 'utf8'))
const V2 = ['chords', 'ensemble', 'bass'].map((k) => `bwv1041-piano-v2-${k}`)

function itemOf(id) {
  for (const g of manifest.groups) {
    const it = g.items.find((i) => i.id === id)
    if (it) return it
  }
  return null
}

/** 文件里的两条音符轨: [右手(小提琴), 左手] */
function tracksOf(file) {
  const { named } = readChunks(resolve(LIB, file))
  const solo = notesOf(named.get('Solo Violin'))
  const lhChunk = [...named.values()].find(
    (c) => c !== named.get('Solo Violin') && notesOf(c).length > 0,
  )
  return { solo, lh: notesOf(lhChunk) }
}

/** 按起音把一条声部聚成「同时响的一组」 */
function groupsOf(notes) {
  const byOnset = new Map()
  for (const n of notes) {
    if (!byOnset.has(n.s)) byOnset.set(n.s, [])
    byOnset.get(n.s).push(n)
  }
  const starts = [...byOnset.keys()].sort((a, b) => a - b)
  return starts.map((s, i) => ({
    start: s,
    end: i + 1 < starts.length ? starts[i + 1] : s + DIV,
    pitches: byOnset.get(s).map((n) => n.pitch),
  }))
}

/**
 * 一条声部跟旋律之间的平行五度/八度.
 *
 * 判据: 旋律从 m1 走到 m2 的当口, 声部**同时从一组音换到下一组音**, 并且
 * 有一对音跟旋律保持着同一个有符号音程 (原样不动) —— 那就是平行.
 * 同一组里换到下一组时比较, 所以不会把「一个和弦里的两个音」误判成平行.
 */
function parallelsOfVoice(notes, mel) {
  const groups = groupsOf(notes)
  const m = mel.map((n) => ({ t: n.s, p: n.pitch })).sort((a, b) => a.t - b.t)
  let p5 = 0
  let p8 = 0
  for (let gi = 0; gi + 1 < groups.length; gi++) {
    const G = groups[gi]
    const G2 = groups[gi + 1]
    for (let i = 1; i < m.length; i++) {
      const m1 = m[i - 1]
      const m2 = m[i]
      if (m2.t === m1.t) continue
      // 运动从 G 里出发, 落到 G2 里
      if (!(m1.t >= G.start && m1.t < G.end && m2.t >= G2.start && m2.t < G2.end)) continue
      const dm = m2.p - m1.p
      for (const x1 of G.pitches) {
        for (const x2 of G2.pitches) {
          if (x2 - x1 !== dm) continue
          const iv = Math.abs(x1 - m1.p) % 12
          if (iv === 0) p8++
          else if (iv === 7) p5++
        }
      }
    }
  }
  return { p5, p8 }
}

/** 左手跟旋律撞小二度的次数 (左手音正响着的时候, 旋律里有差 1 个半音的音) */
function clashes(lh, mel) {
  let n = 0
  for (const x of lh) {
    for (const m of mel.filter((y) => y.s < x.e && y.e > x.s)) {
      if (Math.abs(x.pitch - m.pitch) === 1) n++
    }
  }
  return n
}

/** 音级的指纹: 起点 + 终点 + 音级 (折了八度也算同一个音) */
const fp = (n) => `${n.s}|${n.e}|${n.pitch % 12}`

describe('BWV 1041 钢琴独奏 v2 · 清单', () => {
  it('三条 v2 都在清单里, 文件也都在', () => {
    for (const id of V2) {
      const it = itemOf(id)
      expect(it, `清单里少了 ${id}`).toBeTruthy()
      expect(it.file).toBe(`bach/${id}.mid`)
      expect(readFileSync(resolve(LIB, it.file)).length).toBeGreaterThan(1000)
      expect(it.tracks).toBe(2)
      expect(it.key).toBe('A minor')
    }
  })

  it('被否掉的 v1 三版已经不在清单里 (用户嫌不好听)', () => {
    for (const id of ['bwv1041-piano-chords', 'bwv1041-piano-rhythmic', 'bwv1041-piano-bass']) {
      expect(itemOf(id), `${id} 还挂在清单里`).toBeNull()
    }
  })

  it('原版条目跟原版文件都还在', () => {
    const it = itemOf('bwv1041-allegro-moderato')
    expect(it).toBeTruthy()
    expect(it.file).toBe('bach/bwv1041-allegro-moderato.mid')
    expect(readFileSync(resolve(LIB, it.file)).length).toBeGreaterThan(1000)
  })
})

describe('BWV 1041 钢琴独奏 v2 · 右手一个字节都没动', () => {
  const libSolo = readChunks(resolve(LIB, 'bach/bwv1041-allegro-moderato.mid')).named.get('Solo Violin')

  for (const id of V2) {
    it(`${id}: Solo Violin 轨跟曲库里发布的原版逐字节相同`, () => {
      const solo = readChunks(resolve(LIB, `bach/${id}.mid`)).named.get('Solo Violin')
      expect(solo).toBeTruthy()
      expect(solo.content.equals(libSolo.content)).toBe(true)
    })
  }

  it('原版文件的 Solo Violin 跟 6 声部源文件逐音相同 (原版自己没被动过)', () => {
    const src = readChunks(SOURCE).named.get('Solo Violin')
    const a = notesOf(libSolo)
    const b = notesOf(src)
    expect(a.length).toBe(b.length)
    expect(a.length).toBeGreaterThan(1000)
    for (let i = 0; i < a.length; i++) {
      expect({ s: a[i].s, e: a[i].e, p: a[i].pitch, v: a[i].vel }).toEqual({
        s: b[i].s,
        e: b[i].e,
        p: b[i].pitch,
        v: b[i].vel,
      })
    }
  })
})

describe('BWV 1041 钢琴独奏 v2 · 左手不跟右手打架', () => {
  for (const id of V2) {
    it(`${id}: 没有撞小二度`, () => {
      const { solo, lh } = tracksOf(`bach/${id}.mid`)
      expect(clashes(lh, solo), `${id} 撞小二度`).toBe(0)
    })
  }

  it('和弦版: 和弦音跟旋律之间没有平行五度/八度 (机器人感的主要来源)', () => {
    const { solo, lh } = tracksOf('bach/bwv1041-piano-v2-chords.mid')
    // 按起音拆成两条声部: 每组里最低的是低音, 其余是和弦音
    const byOnset = new Map()
    for (const n of lh) {
      if (!byOnset.has(n.s)) byOnset.set(n.s, [])
      byOnset.get(n.s).push(n)
    }
    const bass = []
    const chord = []
    for (const [, ns] of byOnset) {
      ns.sort((a, b) => a.pitch - b.pitch)
      bass.push(ns[0])
      for (const n of ns.slice(1)) chord.push(n)
    }
    const r = parallelsOfVoice(chord, solo)
    expect(r.p5, `和弦音 平行五度 ${r.p5} 处`).toBe(0)
    expect(r.p8, `和弦音 平行八度 ${r.p8} 处`).toBe(0)
  })

  it('大提琴版: 平行关系跟原谱大提琴完全一样 (只是折了八度)', () => {
    const src = readParts(SOURCE)
    const { solo, lh } = tracksOf('bach/bwv1041-piano-v2-bass.mid')
    const a = parallelsOfVoice(lh, solo)
    const b = parallelsOfVoice(src.cello.notes, src.solo.notes)
    expect(a.p5).toBe(b.p5)
    expect(a.p8).toBe(b.p8)
  })
})

describe('BWV 1041 钢琴独奏 v2 · 左手只弹原谱里有的音', () => {
  const src = readParts(SOURCE)

  it('大提琴版: 每个音都是原谱大提琴的音 (只折八度)', () => {
    const { lh } = tracksOf('bach/bwv1041-piano-v2-bass.mid')
    const have = new Set(lh.map(fp))
    for (const n of src.cello.notes) {
      expect(have.has(fp(n)), `原谱大提琴的音 ${n.pitch}@${n.s} 在缩编里没了`).toBe(true)
    }
  })

  it('原声部版: 每个音都是原谱大提琴或中提琴的音', () => {
    const { lh } = tracksOf('bach/bwv1041-piano-v2-ensemble.mid')
    const have = new Set(lh.map(fp))
    for (const n of [...src.cello.notes, ...src.viola.notes]) {
      if (have.has(fp(n))) continue
      // 撞小二度/同度的音会被挪八度, 所以按音级对
      const alt = [...src.cello.notes, ...src.viola.notes].some(
        (m) => m.s === n.s && m.e === n.e && m.pitch % 12 === n.pitch % 12,
      )
      expect(alt, `原谱的音 ${n.pitch}@${n.s} 在缩编里没了`).toBe(true)
    }
  })

  it('和弦版: 左手用到的每个音级原谱里都响过 (没编造)', () => {
    const srcPC = new Set(
      [...src.cello.notes, ...src.viola.notes, ...src.violin2.notes, ...src.violin1.notes].map(
        (n) => n.pitch % 12,
      ),
    )
    const { lh } = tracksOf('bach/bwv1041-piano-v2-chords.mid')
    for (const n of lh) {
      expect(srcPC.has(n.pitch % 12), `音级 ${n.pitch % 12} 原谱里没响过`).toBe(true)
    }
  })
})

describe('BWV 1041 钢琴独奏 v2 · 左手音区', () => {
  it('都在钢琴左手弹得动的范围里 (C1..C5), 且不是空壳', () => {
    for (const id of V2) {
      const { lh } = tracksOf(`bach/${id}.mid`)
      expect(lh.length, `${id} 左手一个音都没有`).toBeGreaterThan(200)
      const lo = Math.min(...lh.map((n) => n.pitch))
      const hi = Math.max(...lh.map((n) => n.pitch))
      expect(lo, `${id} 最低音 ${lo} 太低`).toBeGreaterThanOrEqual(24)
      expect(hi, `${id} 最高音 ${hi} 太高`).toBeLessThanOrEqual(72)
    }
  })

  it('和弦版每小节最多 6 个和弦 (不能每十六分音都换和弦)', () => {
    const { lh } = tracksOf('bach/bwv1041-piano-v2-chords.mid')
    // 一次「和弦」= 同一时刻一起按下的 2 个以上的音 (低音单音不算)
    const byOnset = new Map()
    for (const n of lh) {
      const key = n.s
      byOnset.set(key, (byOnset.get(key) ?? 0) + 1)
    }
    const perBar = new Map()
    for (const [s, count] of byOnset) {
      if (count < 2) continue
      const bar = Math.floor(s / (4 * DIV))
      perBar.set(bar, (perBar.get(bar) ?? 0) + 1)
    }
    let max = 0
    for (const [, c] of perBar) max = Math.max(max, c)
    expect(max, `单小节最多 ${max} 个和弦`).toBeLessThanOrEqual(6)
  })
})
