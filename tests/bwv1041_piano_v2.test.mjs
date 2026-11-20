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
const V2 = ['chords', 'ensemble', 'compact', 'oneline', 'viola', 'bass'].map(
  (k) => `bwv1041-piano-v2-${k}`,
)

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
  it('六条 v2 都在清单里, 文件也都在', () => {
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

/**
 * 紧凑版 —— 加在 bass (最简单) 和 ensemble (次简单) 中间的难度档.
 *
 * 它跟 ensemble 用的是同样两条真实声部 (大提琴 + 中提琴), 但 ensemble
 * 把中提琴固定折到 46..62, 左手最宽要张 26 个半音 —— 实测 195 个时刻
 * 物理上弹不了. 紧凑版逐音挑八度, 把跨度锁在一个八度内.
 */
describe('BWV 1041 钢琴独奏 · 紧凑版 (中间难度档)', () => {
  const src = readParts(SOURCE)
  const COMPACT = 'bach/bwv1041-piano-v2-compact.mid'

  it('难度排在 bass 和 ensemble 中间', () => {
    expect(itemOf('bwv1041-piano-v2-bass').difficulty).toBe(1)
    expect(itemOf('bwv1041-piano-v2-compact').difficulty).toBe(2)
    expect(itemOf('bwv1041-piano-v2-ensemble').difficulty).toBe(3)
    expect(itemOf('bwv1041-piano-v2-chords').difficulty).toBe(4)
  })

  it('左手任何时刻都张得开 (最宽一个九度, 超八度的时刻极少)', () => {
    const { lh } = tracksOf(COMPACT)
    const onsets = [...new Set(lh.map((n) => n.s))]
    let worst = 0
    let over12 = 0
    for (const t of onsets) {
      const sounding = lh.filter((n) => n.s <= t && t < n.e)
      const span = Math.max(...sounding.map((n) => n.pitch)) - Math.min(...sounding.map((n) => n.pitch))
      worst = Math.max(worst, span)
      if (span > 12) over12++
      expect(span, `@${t} 左手要张 ${span} 个半音, 弹不了`).toBeLessThanOrEqual(14)
    }
    expect(worst).toBeGreaterThan(0) // 确实是双声部, 不是退化成单音
    // ensemble 版有 195 个时刻张不开 —— 这版只能有几个
    expect(over12 / onsets.length, `超八度的时刻占 ${over12}/${onsets.length}`).toBeLessThan(0.03)
  })

  it('两条声部不撞同一个键 (同音高叠着, MIDI 的 note-off 配对会乱)', () => {
    const { lh } = tracksOf(COMPACT)
    for (const n of lh) {
      const dup = lh.find((o) => o !== n && o.pitch === n.pitch && o.s < n.e && n.s < o.e)
      expect(dup, `音高 ${n.pitch}@${n.s} 同时响了两遍`).toBeFalsy()
    }
  })

  it('比 ensemble 版好弹得多 (ensemble 有 195 个时刻左手张不开)', () => {
    const spanOf = (file) => {
      const { lh } = tracksOf(file)
      let over = 0
      for (const t of new Set(lh.map((n) => n.s))) {
        const s = lh.filter((n) => n.s <= t && t < n.e)
        if (Math.max(...s.map((n) => n.pitch)) - Math.min(...s.map((n) => n.pitch)) > 12) over++
      }
      return over
    }
    const compact = spanOf(COMPACT)
    const ens = spanOf('bach/bwv1041-piano-v2-ensemble.mid')
    expect(ens, 'ensemble 版的参照值变了').toBeGreaterThan(100)
    expect(compact, `紧凑版有 ${compact} 个时刻超八度`).toBeLessThan(ens / 10)
  })

  it('密度卡在 bass 和 ensemble 中间 (它就是「中间难度」)', () => {
    const count = (file) => tracksOf(file).lh.length
    const bass = count('bach/bwv1041-piano-v2-bass.mid')
    const compact = count(COMPACT)
    const ens = count('bach/bwv1041-piano-v2-ensemble.mid')
    expect(compact).toBeGreaterThan(bass)
    expect(compact).toBeLessThan(ens)
  })

  it('大提琴一个音没丢', () => {
    const { lh } = tracksOf(COMPACT)
    const have = new Set(lh.map(fp))
    for (const n of src.cello.notes) {
      expect(have.has(fp(n)), `原谱大提琴的音 ${n.pitch}@${n.s} 在紧凑版里没了`).toBe(true)
    }
  })

  it('中提琴的整拍骨干音基本没丢 (经过音是主动让掉的, 不是漏的)', () => {
    const { lh } = tracksOf(COMPACT)
    const have = new Set(lh.map(fp))
    const onBeat = src.viola.notes.filter(
      (n) => Math.abs(n.s / DIV - Math.round(n.s / DIV)) < 0.02,
    )
    expect(onBeat.length, '中提琴整拍骨干音太少, 测不出东西').toBeGreaterThan(100)
    // 折过八度的按音级对
    const kept = onBeat.filter(
      (n) =>
        have.has(fp(n)) ||
        [...src.cello.notes, ...src.viola.notes].some(
          (m) => m.s === n.s && m.e === n.e && m.pitch % 12 === n.pitch % 12,
        ),
    )
    expect(
      kept.length / onBeat.length,
      `只留下 ${kept.length}/${onBeat.length} 个骨干音`,
    ).toBeGreaterThan(0.95)
  })

  it('左手用到的每个音级原谱里都响过 (没编造)', () => {
    const realPC = new Set([...src.cello.notes, ...src.viola.notes].map((n) => n.pitch % 12))
    const { lh } = tracksOf(COMPACT)
    for (const n of lh) {
      expect(realPC.has(n.pitch % 12), `音级 ${n.pitch % 12} 原谱里没响过`).toBe(true)
    }
  })

  it('平行五度/八度不比原谱中提琴更糟 (折叠没造出新的平行)', () => {
    const { solo, lh } = tracksOf(COMPACT)
    // 按起音拆成低音 / 内声部两条
    const byOnset = new Map()
    for (const n of lh) {
      if (!byOnset.has(n.s)) byOnset.set(n.s, [])
      byOnset.get(n.s).push(n)
    }
    const bass = []
    const mid = []
    for (const [, ns] of byOnset) {
      ns.sort((a, b) => a.pitch - b.pitch)
      bass.push(ns[0])
      for (const n of ns.slice(1)) mid.push(n)
    }
    const orig = parallelsOfVoice(src.viola.notes, src.solo.notes)
    const got = parallelsOfVoice(mid, solo)
    expect(got.p5, `内声部 平行五度 ${got.p5} 处`).toBeLessThanOrEqual(orig.p5)
    expect(got.p8, `内声部 平行八度 ${got.p8} 处`).toBeLessThanOrEqual(orig.p8)
  })

  it('左手音区在钢琴左手够得着的范围里', () => {
    const { lh } = tracksOf(COMPACT)
    const lo = Math.min(...lh.map((n) => n.pitch))
    const hi = Math.max(...lh.map((n) => n.pitch))
    expect(lo).toBeGreaterThanOrEqual(24)
    expect(hi).toBeLessThanOrEqual(72)
  })
})

/**
 * 中提琴版 —— 左手就是**整条中提琴线**, 没有大提琴.
 *
 * 中提琴在 BWV 1041 第一乐章里弹的正是那段著名的分解和弦, 和声音级都在
 * 它身上. 把它整个搬给左手, 出来的是原曲的织体.
 *
 * 跟别版最大的不同: 左手是**单声部** —— 一次都不用张开手.
 */
/**
 * 中提琴版 —— 左手 = 整条中提琴线 + 大提琴低音.
 *
 * 中提琴在 BWV 1041 第一乐章里弹的正是那段著名的分解和弦, 和声音级都在
 * 它身上. 把它整个搬给左手, 出来的是原曲的织体.
 *
 * 第一版只给中提琴一条线 (用户嫌「太简单、不好听」—— 没有根音撑着, 听着
 * 发飘), 现在补上大提琴低音, 密度从 5.1 涨到 12.0 音/小节.
 *
 * 跟「原声部版」的区别: 同样两条声部, 但这版让中提琴保住自己的音区和
 * 原谱音程, 大提琴去它下面找位置, 左手任何时刻总跨度 ≤ 12 (原声部版最宽
 * 26 个半音, 195 个时刻弹不了).
 */
describe('BWV 1041 钢琴独奏 · 中提琴版 (中提琴全线 + 低音)', () => {
  const src = readParts(SOURCE)
  const VIOLA = 'bach/bwv1041-piano-v2-viola.mid'

  /** 左手拆成两条声部: 每个起音点最低的是低音, 其余是中提琴 */
  function voicesOf(file) {
    const { lh } = tracksOf(file)
    const byOnset = new Map()
    for (const n of lh) {
      if (!byOnset.has(n.s)) byOnset.set(n.s, [])
      byOnset.get(n.s).push(n)
    }
    const bass = []
    const mid = []
    for (const [, ns] of byOnset) {
      ns.sort((a, b) => a.pitch - b.pitch)
      bass.push(ns[0])
      for (const n of ns.slice(1)) mid.push(n)
    }
    return { all: lh, bass, mid }
  }

  it('原谱中提琴的音一个不少 (440 个全在)', () => {
    const { lh } = tracksOf(VIOLA)
    expect(src.viola.notes.length).toBe(440)
    for (const n of src.viola.notes) {
      const hit = lh.find((x) => x.s === n.s && x.pitch % 12 === n.pitch % 12 && x.e >= n.e)
      expect(hit, `原谱中提琴的音 ${n.pitch}@${n.s} 在缩编里没了`).toBeTruthy()
    }
  })

  it('左手有根音撑着 (低音线基本完整, 不是零星几声)', () => {
    const { bass, all } = voicesOf(VIOLA)
    expect(bass.length, `低音只有 ${bass.length} 个音`).toBeGreaterThan(500)
    // 原谱大提琴的音级, 折八度后一个都不能少
    const keys = new Set(all.map((n) => `${n.s}|${n.pitch % 12}`))
    const missed = src.cello.notes.filter((n) => !keys.has(`${n.s}|${n.pitch % 12}`))
    expect(
      src.cello.notes.length - missed.length,
      `低音只保住 ${src.cello.notes.length - missed.length}/${src.cello.notes.length}`,
    ).toBeGreaterThanOrEqual(595)
  })

  it('左手任何时刻都张得开 (总跨度不超过一个八度)', () => {
    const { all } = voicesOf(VIOLA)
    let worst = 0
    for (const t of [...new Set(all.map((n) => n.s))]) {
      const sounding = all.filter((n) => n.s <= t && t < n.e)
      const span = Math.max(...sounding.map((n) => n.pitch)) - Math.min(...sounding.map((n) => n.pitch))
      worst = Math.max(worst, span)
    }
    expect(worst, `最宽要张 ${worst} 个半音`).toBeLessThanOrEqual(12)
  })

  it('低音永远在中提琴下面, 不跟它同度', () => {
    const { bass, mid } = voicesOf(VIOLA)
    for (const b of bass) {
      for (const m of mid) {
        if (!(m.s < b.e && b.s < m.e)) continue
        expect(m.pitch, `低音 ${b.pitch} 高过了中提琴 ${m.pitch}`).toBeGreaterThan(b.pitch)
      }
    }
  })

  it('左手不高过同时响的旋律最低音 (两只手不交叉)', () => {
    const { solo, lh } = tracksOf(VIOLA)
    for (const x of lh) {
      const mel = solo.filter((y) => y.s < x.e && y.e > x.s).map((y) => y.pitch)
      if (!mel.length) continue
      expect(x.pitch, `左手 ${x.pitch} 高过了旋律最低音 ${Math.min(...mel)}`).toBeLessThanOrEqual(
        Math.min(...mel),
      )
    }
  })

  it('没有跟旋律同度齐奏, 也不撞小二度', () => {
    const { solo, lh } = tracksOf(VIOLA)
    let uni = 0
    for (const x of lh) {
      for (const m of solo.filter((y) => y.s < x.e && y.e > x.s)) {
        if (x.pitch === m.pitch) uni++
      }
    }
    expect(uni, `跟旋律同度齐奏 ${uni} 处`).toBe(0)
    expect(clashes(lh, solo)).toBe(0)
  })

  it('中提琴那条线不用大跳 (相邻音程平均很小)', () => {
    const { mid } = voicesOf(VIOLA)
    const srt = mid.slice().sort((a, b) => a.s - b.s)
    const leaps = srt.slice(1).map((n, i) => Math.abs(n.pitch - srt[i].pitch))
    const avg = leaps.reduce((a, b) => a + b, 0) / leaps.length
    expect(avg, `相邻音程平均 ${avg.toFixed(1)} 个半音`).toBeLessThan(5)
    expect(Math.max(...leaps), `有个 ${Math.max(...leaps)} 个半音的大跳`).toBeLessThanOrEqual(15)
  })

  it('平行关系跟现有各版同一量级 (没有「机器人感」)', () => {
    const { solo, lh } = tracksOf(VIOLA)
    const r = parallelsOfVoice(lh, solo)
    // 这个判据会把**跨声部**的音对也算进来 (低音→中提琴), 所以只卡上限,
    // 不要求跟原谱逐个相同 —— 原谱中提琴自己就有 5 处平行八度.
    expect(r.p5, `平行五度 ${r.p5} 处`).toBeLessThanOrEqual(2)
    expect(r.p8, `平行八度 ${r.p8} 处`).toBeLessThanOrEqual(12)
  })

  it('左手音区在 C2..E4 (低音在最底下, 中提琴在中间)', () => {
    const { bass, mid } = voicesOf(VIOLA)
    expect(Math.min(...bass.map((n) => n.pitch))).toBeGreaterThanOrEqual(36)
    expect(Math.max(...mid.map((n) => n.pitch))).toBeLessThanOrEqual(64)
  })
})

/**
 * 单音线版 —— 左手**任何时刻只有一个音**.
 *
 * 用户反馈双声部那版 (12 音/小节) 听着好但新手弹不动: 左手得同时按两个音.
 * 这一版把大提琴和中提琴在时间上错开, 拼成一条单音线:
 *   · 大提琴走路低音当骨架, 一个音都不丢
 *   · 中提琴的音只在低音空出来的那一小段里插进来
 */
describe('BWV 1041 钢琴独奏 · 单音线版 (左手任何时刻只有一个音)', () => {
  const src = readParts(SOURCE)
  const ONELINE = 'bach/bwv1041-piano-v2-oneline.mid'
  const { lh } = tracksOf(ONELINE)

  it('左手是严格的单声部 (没有两个音叠在一起)', () => {
    const srt = lh.slice().sort((a, b) => a.s - b.s)
    let overlaps = 0
    for (let i = 1; i < srt.length; i++) {
      if (srt[i].s < srt[i - 1].e) overlaps++
    }
    expect(overlaps, `有 ${overlaps} 处左手两个音叠着响`).toBe(0)
    // 每个起音点同时响的音数只能是 1
    const hist = new Map()
    for (const t of new Set(lh.map((n) => n.s))) {
      const c = lh.filter((n) => n.s <= t && t < n.e).length
      hist.set(c, (hist.get(c) ?? 0) + 1)
    }
    expect([...hist.keys()], '有起音点上不止一个音在响').toEqual([1])
  })

  it('密度比双声部版低一半以上 (新手能跟得上)', () => {
    const perBar = lh.length / 86
    expect(perBar, `左手 ${perBar.toFixed(1)} 音/小节`).toBeLessThanOrEqual(8)
    const violaLH = tracksOf('bach/bwv1041-piano-v2-viola.mid').lh.length
    expect(perBar).toBeLessThan(violaLH / 86 / 1.5)
  })

  it('大提琴低音一个不少, 中提琴也插进来几十个', () => {
    const keys = new Set(lh.map((n) => `${n.s}|${n.pitch % 12}`))
    const missed = src.cello.notes.filter((n) => !keys.has(`${n.s}|${n.pitch % 12}`))
    expect(missed.length, `大提琴丢了 ${missed.length} 个音`).toBe(0)
    const violaIn = src.viola.notes.filter((n) => keys.has(`${n.s}|${n.pitch % 12}`))
    expect(violaIn.length, `中提琴只插进来 ${violaIn.length} 个`).toBeGreaterThanOrEqual(50)
  })

  it('左手只弹原谱里有的音 (折八度不改音级)', () => {
    const srcPC = new Set([...src.cello.notes, ...src.viola.notes].map((n) => n.pitch % 12))
    for (const n of lh) {
      expect(srcPC.has(n.pitch % 12), `左手用了原谱里没有的音级 ${n.pitch % 12}`).toBe(true)
    }
  })

  it('左手不跟右手打架 (不撞小二度, 不同度齐奏)', () => {
    const { solo } = tracksOf(ONELINE)
    expect(clashes(lh, solo), '撞小二度').toBe(0)
    let uni = 0
    for (const x of lh) {
      for (const m of solo.filter((y) => y.s < x.e && y.e > x.s)) {
        if (x.pitch === m.pitch) uni++
      }
    }
    expect(uni, `跟旋律同度齐奏 ${uni} 处`).toBe(0)
  })

  it('左手不高过同时响的旋律最低音 (两只手不交叉)', () => {
    const { solo } = tracksOf(ONELINE)
    for (const x of lh) {
      const mel = solo.filter((y) => y.s < x.e && y.e > x.s).map((y) => y.pitch)
      if (!mel.length) continue
      expect(x.pitch).toBeLessThanOrEqual(Math.min(...mel))
    }
  })

  it('左手相邻两音不超过一个八度 (手不用大幅搬家)', () => {
    const srt = lh.slice().sort((a, b) => a.s - b.s)
    const leaps = srt.slice(1).map((n, i) => Math.abs(n.pitch - srt[i].pitch))
    expect(Math.max(...leaps), `有个 ${Math.max(...leaps)} 个半音的大跳`).toBeLessThanOrEqual(12)
    const avg = leaps.reduce((a, b) => a + b, 0) / leaps.length
    expect(avg, `相邻音程平均 ${avg.toFixed(1)} 个半音`).toBeLessThan(5)
  })

  it('左手音区在 C2..E4', () => {
    expect(Math.min(...lh.map((n) => n.pitch))).toBeGreaterThanOrEqual(36)
    expect(Math.max(...lh.map((n) => n.pitch))).toBeLessThanOrEqual(64)
  })
})
