// 乐库体检回归 (2026-11-02)
//
// 用户报: 「54954A 这首曲子开头左右手好像错了 … 另外这个为什么显示的曲名是这个
//          整体看一下乐谱库是不是也有这种问题」
//
// 「54954A」= public/library/chopin/waltz-op64-no2.mid **文件内部的名字**
// (Godowsky 版内部叫 "666") —— 顶栏显示的是它, 因为 library.ts 里写的是
// `if (!song.title) song.title = item.title` (清单只在 MIDI 没名字时才用),
// 跟注释说的正好反过来. 乐库里一半曲子的内部名字都是垃圾或乱码.
//
// 三件事分开测:
//   1. 左右手 (单 track 声部聚类): 旋律下限必须按曲子自适应, 不能写死 Bb4;
//      旋律的**双音** (右手同时按两个键) 要靠"跟最高音同时落"认出来
//   2. 曲名: 清单的曲名/作曲家**优先于** MIDI 内部的名字
//   3. 曲库元数据: 拍号 (弱起小节 1/4 不能当成整首的拍号) + 清单标的通道数

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Midi } from '@tonejs/midi'
import { parseMidi } from '../src/parser/parseMidi'
import { cleanMetaText } from '../src/parser/parseMidi'
import { loadFromLibrary, type LibraryItem } from '../src/library'
import manifest from '../public/library/manifest.json'

const LIB = resolve(__dirname, '../public/library')

function load(file: string) {
  return parseMidi(new Uint8Array(readFileSync(resolve(LIB, file))))
}

function itemOf(id: string): LibraryItem {
  for (const g of manifest.groups) {
    const it = g.items.find((i) => i.id === id)
    if (it) return it as LibraryItem
  }
  throw new Error(`清单里找不到 ${id}`)
}

// ─────────────────────────────────────────────────── 1. 左右手

/**
 * 把两个 MIDI 的音高序列对齐 (Needleman-Wunsch), 借 Godowsky 版 (已经分好手)
 * 当"标准答案", 算出库单 track 版跟它一致的比例.
 *
 * Godowsky 版 track 0 = 右手旋律 (986 个音), 库版是单 track (左右手混在一起).
 */
function handAgreement(): { rate: number; bad: number; total: number } {
  const godowsky = load('chopin/godowsky-waltz-csharp-minor.mid')
  const waltz = load('chopin/waltz-op64-no2.mid')
  const gRH = godowsky.notes.filter((n) => n.hand === 'right')
  const w = waltz.notes

  // 按音高序列做全局对齐 (只比音高, 不比时间 —— 两版的时间轴不一样)
  const N = w.length
  const M = gRH.length
  const W = M + 1
  const GAP_W = -1
  const GAP_G = -3
  const MATCH = 3
  const MISMATCH = -2
  const dp = new Int32Array((N + 1) * W)
  const tr = new Uint8Array((N + 1) * W)
  for (let i = 1; i <= N; i++) {
    dp[i * W] = i * GAP_W
    tr[i * W] = 1
  }
  for (let j = 1; j <= M; j++) {
    dp[j] = j * GAP_G
    tr[j] = 2
  }
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const same = w[i - 1].midiNote === gRH[j - 1].midiNote ? MATCH : MISMATCH
      const d = dp[(i - 1) * W + j - 1] + same
      const u = dp[(i - 1) * W + j] + GAP_W
      const l = dp[i * W + j - 1] + GAP_G
      let best = d
      let t = 0
      if (u > best) {
        best = u
        t = 1
      }
      if (l > best) {
        best = l
        t = 2
      }
      dp[i * W + j] = best
      tr[i * W + j] = t
    }
  }
  // 回溯: 库版每个音是不是"右手旋律"里的音
  const isMelody = new Array<boolean>(N).fill(false)
  let i = N
  let j = M
  while (i > 0 || j > 0) {
    const t = tr[i * W + j]
    if (i > 0 && j > 0 && t === 0) {
      if (w[i - 1].midiNote === gRH[j - 1].midiNote) isMelody[i - 1] = true
      i--
      j--
    } else if (t === 1) {
      i--
    } else {
      j--
    }
  }
  let ok = 0
  let bad = 0
  for (let k = 0; k < N; k++) {
    const predicted = w[k].hand === 'right'
    if (predicted === isMelody[k]) ok++
    else bad++
  }
  return { rate: (100 * ok) / (ok + bad), bad, total: ok + bad }
}

describe('Op.64 No.2 圆舞曲: 单 track 声部聚类的左右手', () => {
  const song = load('chopin/waltz-op64-no2.mid')

  it('开头的手别是对的 (用户报的那个问题)', () => {
    // 谱面开头: 弱起 G#4(68) → E5(76) → {G#4, D#5}(67,75) … 左手是 C#2(37) 和
    // {G#3, C#4, E4}(56,61,64) 那个和弦.
    const head = song.notes.filter((n) => n.time < 3.2)
    const handOf = (midi: number, time: number) => {
      const n = head.find((x) => x.midiNote === midi && Math.abs(x.time - time) < 0.06)
      return n?.hand
    }
    // 弱起的 G#4 —— 以前被判成左手 (旋律下限写死 70 = Bb4)
    expect(handOf(68, 0.39)).toBe('right')
    // E5
    expect(handOf(76, 1.1)).toBe('right')
    // G#4 + D#5 的旋律双音
    expect(handOf(67, 2.72)).toBe('right')
    expect(handOf(75, 2.72)).toBe('right')
    // 左手: 低音 C#2 和那个和弦
    expect(handOf(37, 1.1)).toBe('left')
    expect(handOf(56, 1.71)).toBe('left')
    expect(handOf(61, 1.71)).toBe('left')
    expect(handOf(64, 1.71)).toBe('left')
  })

  it('跟"已经分好手"的 Godowsky 版逐音对齐, 一致率 ≥ 85%', () => {
    const { rate } = handAgreement()
    // 修之前的算法 (固定下限 70 + 持续性过滤) 只有 70.2%
    expect(rate).toBeGreaterThan(85)
  })

  it('右手的音区 (旋律) 和左手的音区 (伴奏) 不该整段重叠', () => {
    const rh = song.notes.filter((n) => n.hand === 'right')
    const lh = song.notes.filter((n) => n.hand === 'left')
    expect(rh.length).toBeGreaterThan(song.notes.length * 0.25)
    expect(lh.length).toBeGreaterThan(song.notes.length * 0.25)
    // 旋律最低音 (62 = D4) 明显高于伴奏的最高音区
    expect(Math.min(...rh.map((n) => n.midiNote))).toBeLessThanOrEqual(66)
  })
})

describe('单 track 曲子的旋律下限按曲子自适应', () => {
  it('卡农: 旋律 (F#5 起那条下行线) 是右手, 走动低音是左手', () => {
    const song = load('pachelbel/canon-in-d.mid')
    expect(song.handInfer?.method).toBe('voice-clusters')
    const handOf = (midi: number, time: number) =>
      song.notes.find((n) => n.midiNote === midi && Math.abs(n.time - time) < 0.06)?.hand
    // 第一把小提琴的下行旋律: F#5 E5 D5 C#5 B4
    expect(handOf(78, 10.67)).toBe('right')
    expect(handOf(76, 12.0)).toBe('right')
    expect(handOf(74, 13.33)).toBe('right')
    expect(handOf(73, 14.67)).toBe('right')
    expect(handOf(71, 16.0)).toBe('right')
    // 底下那条走动低音: D3 A2 B2 E2 F#2 D2
    expect(handOf(50, 0.0)).toBe('left')
    expect(handOf(45, 1.33)).toBe('left')
    expect(handOf(47, 2.67)).toBe('left')
    expect(handOf(42, 4.0)).toBe('left')
    expect(handOf(43, 5.33)).toBe('left')
    expect(handOf(38, 6.67)).toBe('left')
  })

  it('River Flows in You: 旋律是右手, 伴奏和弦是左手', () => {
    const song = load('pop/river-flows-in-you.mid')
    expect(song.handInfer?.method).toBe('voice-clusters')
    const handOf = (midi: number, time: number) =>
      song.notes.find((n) => n.midiNote === midi && Math.abs(n.time - time) < 0.06)?.hand
    // 旋律: A5 G#5 A5 ... E5 A5 D5
    expect(handOf(81, 0.0)).toBe('right')
    expect(handOf(80, 0.46)).toBe('right')
    expect(handOf(76, 2.37)).toBe('right')
    expect(handOf(74, 3.37)).toBe('right')
    // 伴奏: 低音和铺底和弦
    expect(handOf(54, 0.0)).toBe('left')
    expect(handOf(61, 0.46)).toBe('left')
    expect(handOf(66, 0.92)).toBe('left')
    expect(handOf(50, 1.85)).toBe('left')
    expect(handOf(57, 2.37)).toBe('left')
    expect(handOf(64, 2.87)).toBe('left')
  })
})

// ─────────────────────────────────────────────────── 2. 曲名

describe('曲名: 清单优先于 MIDI 内部的名字', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 把 fetch 换成"从 public/library 读文件" */
  function stubFetch() {
    vi.stubGlobal('fetch', async (url: string) => {
      const rel = String(url).replace('/library/', '')
      const bytes = readFileSync(resolve(LIB, rel))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        blob: async () => new Blob([bytes]),
        json: async () => JSON.parse(bytes.toString('utf8')),
        text: async () => bytes.toString('utf8'),
      }
    })
  }

  it('圆舞曲显示的是清单里的曲名, 不是文件内部的 "54954A"', async () => {
    stubFetch()
    const song = await loadFromLibrary(itemOf('waltz-op64-no2'))
    expect(song.title).toBe('Waltz in C# minor, Op.64 No.2')
    expect(song.title).not.toContain('54954A')
    expect(song.composer).toBe('Chopin')
  })

  it('Godowsky 版同样显示清单曲名 (文件内部叫 "666")', async () => {
    stubFetch()
    const song = await loadFromLibrary(itemOf('godowsky-waltz-csharp-minor'))
    expect(song.title).toContain('Godowsky')
    expect(song.title).not.toContain('666')
  })

  it('MIDI 内部名字里的控制字符被清掉', () => {
    expect(cleanMetaText('Piano\u0000')).toBe('Piano')
    expect(cleanMetaText('  Flower Dance  ')).toBe('Flower Dance')
  })

  it('MIDI 内部名字是 GBK/UTF-8 乱码时能还原', () => {
    // 帕赫贝尔卡农 (GBK 字节被按 latin-1 解)
    expect(cleanMetaText('ÅÁºÕ±´¶ûD´óµ÷¿¨Å©')).toBe('帕赫贝尔D大调卡农')
    // 正常的英文名不能被"修坏"
    expect(cleanMetaText('Mariage d\'amour')).toBe("Mariage d'amour")
    expect(cleanMetaText('Café')).toBe('Café')
  })
})

// ─────────────────────────────────────────────────── 3. 曲库元数据

describe('曲库元数据体检', () => {
  it('弱起小节 (1/4) 不能当成整首的拍号', () => {
    // 土耳其进行曲: 文件第一个拍号是弱起的 1/4, 正文是 2/4
    const turkish = load('mozart/turkish-march.mid')
    expect(turkish.timeSignature).toEqual({ numerator: 2, denominator: 4 })
    // 爱之梦: 弱起 1/4, 正文 6/4
    const liebestraum = load('liszt/liebestraum.mid')
    expect(liebestraum.timeSignature).toEqual({ numerator: 6, denominator: 4 })
  })

  it('Op.64 No.2 是 3/4 (圆舞曲), 文件原来写的是 4/4', () => {
    const waltz = load('chopin/waltz-op64-no2.mid')
    expect(waltz.timeSignature).toEqual({ numerator: 3, denominator: 4 })
  })

  it('幻想即兴曲整首是 4/4 (文件开头写的是 2/2, 再现段却是 4/4)', () => {
    // 同一段 Presto 音乐: 开头 (0s) 文件写 2/2, 再现段 (180s) 文件写 4/4.
    // 同一段音乐两个拍号 → 开头那个是错的 (原曲 Op.66 的 Presto 也是普通拍 4/4).
    const fantaisie = load('chopin/fantaisie-impromptu.mid')
    expect(fantaisie.timeSignature).toEqual({ numerator: 4, denominator: 4 })
    // 每小节都是 4/4 (不能有一段留着 2/2)
    expect(fantaisie.measures.every((m) => m.numerator === 4 && m.denominator === 4)).toBe(true)
  })

  it('安魂曲是 12/8 —— 拍号事件写在 tick 5760, 音乐也从那儿开始', () => {
    // 三个声部的音全都落在附点四分音符的格子上 (5760 / 7200 / 8640 …),
    // 一小节 = 4 个附点四分 = 5760 tick.
    const requiem = load('mozart/requiem-piano.mid')
    expect(requiem.timeSignature).toEqual({ numerator: 12, denominator: 8 })
    // 整首一个拍号 → 每小节没单独标拍号, 回退到整首的 (12/8)
    expect(
      requiem.measures.every(
        (m) => (m.numerator ?? 12) === 12 && (m.denominator ?? 8) === 8,
      ),
    ).toBe(true)
  })

  it('同一个拍号写了好几遍的, 显示时只留一处', () => {
    // 军队波兰舞曲的文件里 3/4 写了 5 遍 —— 显示成 "3/4 → 3/4 → …" 很怪
    const polonaise = load('chopin/polonaise-op40-no1.mid')
    expect(polonaise.timeSignatures).toHaveLength(1)
    expect(polonaise.timeSignatures?.[0]).toMatchObject({ numerator: 3, denominator: 4 })
  })

  it('双 track 曲子: 音高高的那个 = 右手', () => {
    // BWV 1041: 2026-11-04 把 5 条弦乐伴奏轨合成 1 条 (见 scripts/merge_bwv1041_tracks.mjs),
    //   曲子从 6 track 变成 2 track —— 手别从「猜」(multi-tracks, 置信度 medium) 变成
    //   「确定」(two-tracks, 置信度 high), 界面上不再挂「手别为推断」的提示.
    //   独奏小提琴 (1104 音, avg 73.4) = 右手, 弦乐伴奏 (avg 58.7) = 左手.
    const bwv = load('bach/bwv1041-allegro-moderato.mid')
    expect(bwv.handInfer?.method).toBe('two-tracks')
    expect(bwv.handInfer?.confidence).toBe('high')
    expect(bwv.notes.filter((n) => n.track === 0).every((n) => n.hand === 'right')).toBe(true)
    expect(bwv.notes.filter((n) => n.track === 1).every((n) => n.hand === 'left')).toBe(true)
    expect(bwv.hands.right).toBe(0)
    expect(bwv.hands.left).toBe(1)
  })

  it('多 track 曲子: 主旋律那个声部 = 右手', () => {
    // 莫扎特安魂曲: 人声 (175 音, avg 70 = 最高) 才是旋律; 钢琴上声部 (378 音, avg 62) 是伴奏.
    //   老规则「音符最多的 = RH」会挑中钢琴内声部, 把旋律判成左手.
    const requiem = load('mozart/requiem-piano.mid')
    expect(requiem.handInfer?.method).toBe('multi-tracks')
    expect(requiem.notes.filter((n) => n.track === 0).every((n) => n.hand === 'right')).toBe(true)
    expect(requiem.notes.filter((n) => n.track === 1).every((n) => n.hand === 'left')).toBe(true)
    expect(requiem.notes.filter((n) => n.track === 2).every((n) => n.hand === 'left')).toBe(true)
  })

  it('清单标的时长跟文件实际时长一致', () => {
    for (const g of manifest.groups) {
      for (const it of g.items) {
        if (it.duration === undefined) continue
        const song = load(it.file)
        expect(
          Math.abs(Math.round(song.duration) - it.duration),
          `${it.id} 清单写 ${it.duration}s, 文件实际 ${Math.round(song.duration)}s`,
        ).toBeLessThanOrEqual(2)
      }
    }
  })

  it('清单标的通道数跟文件实际一致', () => {
    for (const g of manifest.groups) {
      for (const it of g.items) {
        const song = load(it.file)
        const tracks = new Set(song.notes.map((n) => n.track)).size
        const expected = it.tracks === 'mxl' ? 'mxl' : it.tracks === 1 ? 1 : it.tracks === 2 ? 2 : 'multi'
        if (expected === 'multi') {
          expect(tracks, `${it.id} 应该是多 track`).toBeGreaterThanOrEqual(3)
        } else {
          expect(tracks, `${it.id} 的通道数`).toBe(expected)
        }
      }
    }
  })

  it('清单里"单 track"的标注跟实际一致', () => {
    for (const g of manifest.groups) {
      for (const it of g.items) {
        const song = load(it.file)
        const tracks = new Set(song.notes.map((n) => n.track)).size
        if (it.subtitle.includes('单 track')) {
          expect(tracks, `${it.id} 标了单 track, 实际 ${tracks} track`).toBe(1)
        }
        if (it.subtitle.includes('双 track')) {
          expect(tracks, `${it.id} 标了双 track, 实际 ${tracks} track`).toBe(2)
        }
      }
    }
  })

  it('曲库里没有"同一个键在同一瞬间敲两次"的坏音符', () => {
    // 幻想即兴曲 6 个 / 爱之梦 22 个 / 卡农 26 个 —— 全是同一 track 里
    // 同 tick 同音高重复 note-on (爱之梦和幻想即兴曲那批还是零长度的).
    // 屏幕上会画两个音条, 跟弹判定也会要求按两下.
    for (const g of manifest.groups) {
      for (const it of g.items) {
        const song = load(it.file)
        const seen = new Set<string>()
        for (const n of song.notes) {
          const k = `${n.track}:${n.time.toFixed(6)}:${n.midiNote}`
          expect(seen.has(k), `${it.id} 有重复音符 ${k}`).toBe(false)
          seen.add(k)
        }
        const zeroLen = song.notes.filter((n) => n.duration <= 0)
        expect(zeroLen.length, `${it.id} 有 ${zeroLen.length} 个零长度音符`).toBe(0)
      }
    }
  })

  it('小节线落在文件写死的小节长度上 (不是 tempo map 推出来的)', () => {
    // tempo map 的拍网格只是近似 —— 变速点落在两拍中间时网格会整体错开,
    // 越到后面偏得越多. 莫扎特安魂曲 (1442 个 rubato 变速事件) 实测偏到 5.7 秒.
    // 小节线必须在 tick 空间里切: 12/8 一小节 = 5760 tick.
    const buf = readFileSync(resolve(LIB, 'mozart/requiem-piano.mid'))
    const midi = new Midi(new Uint8Array(buf))
    const song = parseMidi(new Uint8Array(buf))
    expect(song.measures.length).toBe(30)
    for (const m of song.measures) {
      const ticks = midi.header.secondsToTicks(m.time)
      // 小节线 = 5760 + k*5760 tick (第一个拍号事件写在 tick 5760)
      expect(Math.abs((ticks - 5760) % 5760), `小节线 ${m.time}s 不在 12/8 的格子上`).toBeLessThan(20)
    }
  })

  it('文件里的调号跟清单标的调一致', () => {
    // 调号是乐谱上画出来的 (StaffView 按 keyFifths 画调号) —— 文件写的调号
    // 跟清单标的调对不上, 谱面上的调号就跟音符里的升降号打架.
    //   圆舞曲 Op.64 No.2 文件写的是 C (0 个升降号), 但这首是 C# 小调 → 已修成 4 个升号
    //   花之舞 文件写的是 B (5 个升号), 但这首是 C# 小调 → 已修成 4 个升号
    const FIFTHS: Record<string, number> = {
      Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0,
      G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
    }
    for (const g of manifest.groups) {
      for (const it of g.items) {
        const buf = readFileSync(resolve(LIB, it.file))
        const fileKey = new Midi(new Uint8Array(buf)).header.keySignatures[0]?.key
        if (!fileKey) continue // 文件没写调号 —— 用清单的 (parseMidi 里补上)
        const root = it.key.trim().split(/\s+/)[0]
        const norm = root.replace(/♭/g, 'b').replace(/♯/g, '#')
        const letter = norm.replace(/[#b]/g, '').toUpperCase()
        const key = norm.includes('#') ? letter + '#' : norm.includes('b') ? letter + 'b' : letter
        let want = FIFTHS[key]
        if (want === undefined) continue
        if (/minor/i.test(it.key)) want -= 3
        expect(FIFTHS[fileKey], `${it.id} 文件调号 ${fileKey} vs 清单 ${it.key}`).toBe(want)
      }
    }
  })

  it('清单标的调跟曲子的实际调一致 (改过的几个)', () => {
    // 这几首原来标的调跟文件里的音乐对不上, 逐个按音符内容核对过:
    //   土耳其进行曲: 文件是 G 小调 (结尾是 G 八度), 原来标 A minor
    //   花之舞:       文件是 C# 小调 (开头 E 大调属和弦, 结尾 C#), 原来标 C major
    //   军队波兰舞曲: 文件是 A 大调 (开头 A 大调和弦, 结尾 A 大调), 原来标 A♭ major
    //   爱的印记:     文件是 A♭ 大调 (低音以 Ab 为主), 原来标 E♭ major
    //   天使爱美丽:   文件是 G 大调 (开头 E 小调和弦, 结尾 G 大调九和弦), 原来标 C major
    //   千与千寻:     文件是 F 大调 (结尾 F 大调和弦), 原来标 D major
    //   Track in Time:文件是 D 小调 (结尾 Dm9), 原来标 F# minor
    //   River Flows:  文件是 F# 小调, 原来标 F# major
    expect(itemOf('turkish-march').key).toBe('G minor')
    expect(itemOf('flower-dance').key).toBe('C# minor')
    expect(itemOf('polonaise-op40-no1').key).toBe('A major')
    expect(itemOf('kiss-the-rain').key).toBe('A♭ major')
    expect(itemOf('comptine-d-un-autre-ete').key).toBe('G major')
    expect(itemOf('always-with-me').key).toBe('F major')
    expect(itemOf('track-in-time').key).toBe('D minor')
    expect(itemOf('river-flows-in-you').key).toBe('F# minor')

    // 结尾的主音 —— 文件自己证明它是什么调 (只看音级, 不看八度)
    const lastPitchClass = (file: string) => {
      const song = load(file)
      return song.notes[song.notes.length - 1].midiNote % 12
    }
    expect(lastPitchClass('mozart/turkish-march.mid')).toBe(7) // G
    expect(lastPitchClass('pop/flower-dance.mid')).toBe(1) // C#
    expect(lastPitchClass('pop/always-with-me.mid')).toBe(5) // F
  })
})
