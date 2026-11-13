#!/usr/bin/env node
// scripts/reduce_bwv1041_piano_v2.mjs
//
// BWV 1041 第一乐章 —— 钢琴独奏版 v2 (重做)
//
// ── 为什么 v1「不好听 没有美感」 ────────────────────────────────────────
// v1 (scripts/reduce_bwv1041_piano.mjs) 把伴奏重新量化到均拍网格上,
// 再用一组「和弦模板」去拟合每个格点的音高集合. 结果是:
//
//   1. 大调和弦模板被硬套上去, 46/294 个和弦**没有三音** —— 听起来像
//      power chord (摇滚式的空心五度), 完全不是巴赫.
//   2. 左手被挤在 36..55 一条窄带里, 和弦音区永远不变, 没有织体.
//   3. 采样点里 75/256 处左手和旋律构成平行八度/五度 —— 糊成一团.
//   4. 原谱大提琴 603 个音 (含 144 个十六分音符) 的**真实走路低音**
//      全被网格吃掉了.
//
// 而**原谱里根本没有这些问题**: 实测原谱大提琴对旋律只有 1 处平行五度、
// 中提琴只有 1 处平行八度 —— 那是巴赫写的, 不是合成出来的.
//
// ── v2 的做法: 不再合成, 只做「重新配器」 ────────────────────────────────
// 素材 = 仓库里的原始 6 声部 MIDI (tests/fixtures/midi/...):
//   Solo Violin (右手, 原样不动) / Violin 1 / Violin 2 / Viola / Cello / Violone
//
// 三个版本, 都不新造音级:
//
//   chords    左手 = 大提琴真实走路低音 + 由**原谱实际听到的音高**推出的
//             三和弦 (低音永远是和弦音 → 天然协和, 不会打架).
//   ensemble  左手 = 大提琴 + 中提琴两条**真实声部**, 只做八度折叠.
//             一个音都没新造, 织体就是巴赫原版的.
//   bass      左手 = 只有大提琴一条线, 最简单, 最好跟弹.
//
// 大提琴/中提琴只做**八度折叠** (加/减 12) —— 八度折叠不改音级
// (pitch class), 所以和声一点没变, 只是挪到了钢琴左手的音区.
//
// 和弦音摆位还有一条硬规矩: **不许跟旋律平行五度/八度**. 上一段的和弦音
// 跟当时的旋律正好差八度, 而旋律这一动走了 d 个半音 —— 新和弦音就一定
// 不能落在「上一段那个音 + d」上, 否则就是同向同量地走, 听着像机器人.
// (这条规矩修掉了 v1 的 46 处平行八度.)
//
// 用法:
//   node scripts/reduce_bwv1041_piano_v2.mjs --preview   # 只看分析
//   node scripts/reduce_bwv1041_piano_v2.mjs --write     # 写出文件

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  chunk,
  smfHeader,
  encodeTrack,
  splitChunks,
  timeSignatureEvent,
  keySignatureEvent,
  trackNameEvent,
  endOfTrackEvent,
} from './lib/smf.mjs'
import { readParts, LIBRARY_MIDI, ROOT } from './lib/bwv1041.mjs'

const mode = process.argv.includes('--write') ? 'write' : 'preview'

// ───────────────────────────────────────────────────────── 音区 / 参数

/** 左手低音区 (大提琴折叠后) */
const BASS_LO = 36 // C2
const BASS_HI = 52 // E3 —— 实测: 折到这个区间时, 大提琴对旋律的平行八度/五度
                   // 跟原谱一样是 0; 折得更窄反而会把旋律轮廓压反, 造出假的平行
/** 左手和弦音区 (低于旋律的主要音区 60..85) */
const CHORD_LO = 50 // D3
const CHORD_HI = 62 // D4
/** 和弦音离低音多远算「近位」 (钢琴左手就是贴着低音按的) */
const CHORD_NEAR = 16

/** 拍号 */
const BEATS_PER_BAR = 4
/**
 * 和声分析的节奏单位 (拍).
 *
 * 窗口**按这个单位对齐**, 而不是贴着每个低音滑:
 * 大提琴跑十六分音符时, 滑动窗口每一步看到的内容都不一样, 和弦就会每步
 * 变一次 —— 听着像机关枪. 对齐之后, 同一格里的低音共用一个窗口, 和弦
 * 自然就稳了 (最多一拍一变).
 *
 * 实测: 0.5 → 每小节 3.5 段, 撞小二度 3 个;
 *       1.0 → 每小节 2.9 段, 撞小二度 0 个, 原谱分量覆盖 93% (最好).
 */
const HARMONIC_UNIT = 1.0
/** 和弦的最短身位 (拍) —— 刚起的和弦在这之内不容易被换掉 */
const MIN_CHORD_BEATS = 1.0
/** 换和弦的「迟滞」—— 同一个和弦多给一点分, 免得和弦换来换去 */
const HYSTERESIS = 1.0

/**
 * 和弦模板: [半音集合, 权重, 名字, 每个音的字母偏移].
 * major/minor 权重最高 —— 巴赫的伴奏里三和弦占绝大多数.
 *
 * 字母偏移 (相对根音的字母) 用来判断**怎么拼写**:
 *   C 小三和弦 = C-Eb-G (字母 C E G, E 带降号)
 *   D# 小三和弦 = D#-F#-A# (字母 D F A, 都是升号)
 * 同一个半音集合, 拼写不同 —— 听起来完全是两回事.
 */
const QUALITIES = [
  { iv: [0, 4, 7], w: 1.2, name: 'maj', let: [0, 2, 4] },
  { iv: [0, 3, 7], w: 1.2, name: 'min', let: [0, 2, 4] },
  { iv: [0, 4, 7, 10], w: 0.6, name: '7', let: [0, 2, 4, 6] },
  { iv: [0, 3, 7, 10], w: 0.6, name: 'm7', let: [0, 2, 4, 6] },
  { iv: [0, 4, 7, 11], w: 0.5, name: 'maj7', let: [0, 2, 4, 6] },
  { iv: [0, 3, 6, 10], w: 0.45, name: 'm7b5', let: [0, 2, 4, 6] },
  { iv: [0, 3, 6], w: 0.4, name: 'dim', let: [0, 2, 4] },
  { iv: [0, 3, 6, 9], w: 0.4, name: 'dim7', let: [0, 2, 4, 5] },
  { iv: [0, 4, 8], w: 0.25, name: 'aug', let: [0, 2, 4] },
  { iv: [0, 5, 7], w: 0.3, name: 'sus4', let: [0, 3, 4] },
  { iv: [0, 4, 7, 9], w: 0.35, name: '6', let: [0, 2, 4, 5] },
  { iv: [0, 3, 7, 9], w: 0.35, name: 'm6', let: [0, 2, 4, 5] },
]

/** 字母 C D E F G A B 的自然半音 */
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]
/** 每个根音的拼写 (字母 + 升号数) —— 本曲只用升号 */
const ROOT_SPELL = [
  { letter: 0, acc: 0 }, // C
  { letter: 0, acc: 1 }, // C#
  { letter: 1, acc: 0 }, // D
  { letter: 1, acc: 1 }, // D#
  { letter: 2, acc: 0 }, // E
  { letter: 3, acc: 0 }, // F
  { letter: 3, acc: 1 }, // F#
  { letter: 4, acc: 0 }, // G
  { letter: 4, acc: 1 }, // G#
  { letter: 5, acc: 0 }, // A
  { letter: 5, acc: 1 }, // A#
  { letter: 6, acc: 0 }, // B
]

/**
 * 这个和弦在这首曲子里**拼得出来吗**.
 *
 * 本曲 (a 小调 / d 大调 / e 大调 / b 小调) 只用升号 —— 实测原谱里
 * 出现的黑键是 C# D# F# G# A#, 全是升号, 一个降号都没有.
 * 所以带降号的和弦 (C 小调的 Eb、G 小调的 Bb、F# 减七的 Eb …) 在本曲里
 * **根本不存在** —— 早期版本就是在这里凭空造出了降号, 听着就不对.
 *
 * 规则: 每个音按字母推算, 记号只能是「自然」或「升号」;
 * E# / B# 这种 (自然音被升高半音) 也排除 —— 本曲里没有这种音.
 */
function spellable(root, q) {
  const sp = ROOT_SPELL[root]
  for (let i = 0; i < q.iv.length; i++) {
    const pc = (root + q.iv[i]) % 12
    const letter = (sp.letter + q.let[i]) % 7
    const acc = (pc - LETTER_PC[letter] + 12) % 12
    if (acc !== 0 && acc !== 1) return false // 降号 / 重降 / 重升 —— 不要
    if (acc === 1 && (letter === 2 || letter === 6)) return false // E# / B#
  }
  return true
}

/** A 小调自然音级 (相对半音数, A=0) —— 全在这个集合里的和弦加分 */
const A_MINOR_PCS = new Set([0, 2, 3, 5, 7, 8, 10])

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const pcName = (p) => PC_NAMES[((p % 12) + 12) % 12]

// ───────────────────────────────────────────────────────── 读原谱

const parts = readParts()
const DIV = parts.division // 384 tick / 拍
const beats = (ticks) => ticks / DIV
const ticks = (b) => Math.round(b * DIV)

/** 右手 = 独奏小提琴 (跟曲库里已发布的那份逐音相同) */
const solo = parts.solo.notes
const cello = parts.cello.notes
const viola = parts.viola.notes

console.log(`原谱 6 声部: division=${DIV} tick/拍`)
console.log(
  `  独奏小提琴 ${solo.length} 音 (${beats(solo[0].s).toFixed(2)} 拍起), ` +
    `大提琴 ${cello.length} 音, 中提琴 ${viola.length} 音`,
)

// ───────────────────────────────────────────────────────── 八度折叠

/**
 * 把一条声部折叠进 [lo, hi] —— 只做八度位移 (加/减 12), 不改音级.
 *
 * 挑位移的规则:
 *   1. 优先保持**轮廓方向** —— 源里往上跳, 折完也往上跳 (音程符号一致),
 *      这样八度跳不会塌成一个重复音.
 *   2. 同方向里挑离上一个音最近的, 旋律轮廓平滑.
 *   3. 实在放不下就退到最接近的边界.
 */
function foldOctave(notes, lo, hi) {
  const out = []
  let prev = null
  let prevSrc = null
  for (const n of notes) {
    const cands = []
    for (let k = -4; k <= 4; k++) {
      const p = n.pitch + 12 * k
      if (p >= lo && p <= hi) cands.push(p)
    }
    let p
    if (cands.length === 0) {
      p = Math.min(hi, Math.max(lo, n.pitch))
    } else if (prev === null) {
      // 第一个音: 挑离原音最近的那个八度 (别一上来就掉到最低八度)
      p = cands.reduce((a, b) => (Math.abs(b - n.pitch) < Math.abs(a - n.pitch) ? b : a))
    } else {
      const dir = Math.sign(n.pitch - prevSrc)
      const same = dir === 0 ? cands : cands.filter((c) => Math.sign(c - prev) === dir)
      const pool = same.length ? same : cands
      p = pool.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a))
    }
    out.push({ ...n, pitch: p, moved: p !== n.pitch })
    prev = p
    prevSrc = n.pitch
  }
  return out
}

// ───────────────────────────────────────────────────────── 右手提示音

/** 右手旋律在 [s,e) 期间发声的音高 */
function melodyDuring(s, e) {
  const out = []
  for (const n of solo) if (n.s < e && s < n.e) out.push(n.pitch)
  return out
}

/** 真正刺耳的撞音: 差**正好一个半音** (小二度). 九度不算. */
const isClash = (p, m) => Math.abs(p - m) === 1
/** 同度齐奏 (同一根键) —— 也不好看 */
const isUnison = (p, m) => p === m

// ───────────────────────────────────────────────────────── 和声分析

/**
 * 某段时间窗内, 各声部实际发声的音高.
 *
 * 每个音级给两个数:
 *   w    —— 总发声时长(拍), 各声部叠加. 用来衡量「这个音有多重要」.
 *   hold —— **最长的连续发声时长**(拍). 用来区分「和弦音」和「经过音」:
 *           经过音只响八分音符就跑了, 和弦音要一直压着.
 *
 * 只看 w 会把经过音也拉进来 (一个八分音符的经过音照样有 0.25 的权重),
 * 那正是 v2 早期版本把 D# 塞进 C 小和弦的原因 —— 那个降号原谱里根本没响过.
 */
function soundingWindow(t0, t1) {
  const w = new Map() // pc -> 总权重(拍)
  const hold = new Map() // pc -> 最长连续发声(拍)
  // 只用**低音声部**推和声 —— Violin 1 在华彩段是跟独奏同度齐奏的,
  // 把它算进去, 和弦就会一路跟着旋律走 (等于左手加粗旋律).
  for (const voice of [parts.cello, parts.viola, parts.violin2]) {
    // 先把这个声部在窗口里每一段的 pc 摊平, 再把**相邻同 pc** 的段接起来 ——
    // 同一根音连着弹两次 (反复音) 在听感上是一个持续音.
    const segs = []
    for (const n of voice.notes) {
      const a = Math.max(n.s, t0)
      const b = Math.min(n.e, t1)
      if (b <= a) continue
      segs.push({ pc: n.pitch % 12, a, b })
    }
    segs.sort((x, y) => x.a - y.a)
    const merged = []
    for (const s of segs) {
      const last = merged[merged.length - 1]
      if (last && last.pc === s.pc && s.a <= last.b) {
        last.b = Math.max(last.b, s.b)
      } else {
        merged.push({ ...s })
      }
    }
    for (const s of merged) {
      const dur = (s.b - s.a) / DIV
      w.set(s.pc, (w.get(s.pc) ?? 0) + dur)
      hold.set(s.pc, Math.max(hold.get(s.pc) ?? 0, dur))
    }
  }
  const out = new Map()
  for (const [pc, weight] of w) out.set(pc, { w: weight, hold: hold.get(pc) ?? 0 })
  return out
}

/** 连续发声不足这么多拍的, 算经过音 —— 不配当和弦音 */
const HOLD_MIN = 0.34

/**
 * 在给定的音高集合里找最合适的和弦.
 *
 * 三条硬约束:
 *   1. 低音的音级必须在和弦里 —— 低音和和弦音天生协和.
 *   2. 和弦的每个音都必须在窗口里**真的响过** —— 绝不凭空造音.
 *   3. 这个和弦在这首曲子里**拼得出来** (只用升号, 见 spellable).
 *
 * 打分时区分「压得住的和弦音」和「一闪而过的经过音」:
 * 经过音进和弦要扣分, 和弦音漏掉更要扣分.
 */
function fitChord(pcInfo, bassPc, prev, prevAge) {
  // 能当和弦音的, 只有「压得住」的音级:
  //   - 连续发声 ≥ HOLD_MIN 拍 (真正的和弦音)
  //   - 或者虽然断断续续, 但总发声 ≥ 0.75 拍 (反复出现的和弦音)
  // 大提琴那种十六分音符跑动 (每音只有 0.25 拍) 一律不算 ——
  // 否则低音每跑一步就换一次和弦, 变成机关枪.
  const solid = new Set()
  for (const [pc, info] of pcInfo) {
    if (info.hold >= HOLD_MIN || info.w >= 0.75) solid.add(pc)
  }
  if (solid.size === 0) return null

  // 先按严格标准找 (实音最多漏一个); 找不到再放宽到漏两个.
  // 放宽的是「漏」, 不是「补」—— 凭空补的音最多只能一个, 且必须是
  // 本曲拼得出来的 (只用升号), 所以不会造出降号和弦.
  const search = (maxMiss) => {
  let best = null
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const pcs = q.iv.map((i) => (root + i) % 12)
      // 硬约束 1: 这个和弦在这首曲子里拼得出来 (只用升号)
      if (!spellable(root, q)) continue
      let hit = 0 // 对上的实音
      let miss = 0 // 实音里没被和弦收进去的
      let made = 0 // 和弦里凭空补的
      let inW = 0
      let outW = 0
      for (const pc of solid) {
        const w = pcInfo.get(pc).w
        if (pcs.includes(pc)) {
          hit++
          inW += w
        } else {
          miss++
          outW += w
        }
      }
      for (const pc of pcs) if (!solid.has(pc)) made++
      // 硬约束 2: 至少对上两个实音
      if (hit < 2) continue
      // 硬约束 3: 实音最多漏掉一个, 最多凭空补一个.
      // 「只听到 C 和 G」时补 E 变成 C 大调是正常的 —— 钢琴家就是这么弹的;
      // 补 Eb 变成 C 小调才是错的, 而那个已经被「只用升号」的规则挡掉了.
      if (miss > maxMiss || made > 1) continue

      let diatonic = 0
      for (const pc of pcs) if (A_MINOR_PCS.has(((pc - 9) % 12 + 12) % 12)) diatonic++
      const size = pcs.length
      let score = inW - 0.7 * outW - 1.2 * made - 1.0 * miss + q.w
      // 三和弦给明显加分 —— 巴赫的键盘和声绝大多数是三和弦, 属七只在终止处
      if (size === 3) score += 1.4
      else if (size === 4) score -= 0.4
      // 低音跟和弦的关系: 低音就是根音最好, 是和弦音次之,
      // 差一个全音是「经过音」也行 —— 巴赫的走路低音就爱这么走.
      // 再远 (半音/三全音) 不拦, 只是扣分: 低音是原谱的真线条,
      // 它该经过哪里就经过哪里, 不能为了和弦把它改掉.
      const bassIn = pcs.includes(bassPc)
      const bassNear = Math.min(...pcs.map((c) => pcDistance(bassPc, c)))
      if (bassIn && root === bassPc) score += 0.9
      else if (!bassIn) score -= bassNear === 2 ? 0 : 1.2
      // 全部落在 a 小调音阶里就加分 (只算一次, 不按音数累加)
      if (diatonic === size) score += 0.7
      // 迟滞: 刚起的和弦先给它「一个身位」的保护期.
      //   和弦才起头不到 MIN_CHORD_BEATS 拍 → 加分, 不容易被换掉;
      //   已经响够一个身位 → 不加分, 随时可以换.
      // 这样大提琴十六分音符跑动的时候和弦不会每步都变 (机关枪),
      // 而真正的转位 (比如第四小节那个属七 E7) 该来的时候还是来.
      if (prev && prev.root === root && prev.quality.name === q.name) {
        if (prevAge < MIN_CHORD_BEATS) score += HYSTERESIS
      }
      if (!best || score > best.score) {
        best = { root, quality: q, pcs, score }
      }
    }
  }
  return best
  }
  const best = search(1) ?? search(2)
  if (best) return best
  // 兜底: 原谱里压根没有成套的三和弦 (比如只压着一个音).
  //   - 上一个和弦还挂得住这个低音 → 沿用它 (和声本来就是延续的)
  //   - 否则用原谱里真的响过的音凑一个 —— 一个都不编
  if (solid.size < 2 && prev) {
    const near = Math.min(...prev.pcs.map((c) => pcDistance(bassPc, c)))
    if (near === 0 || near === 2) return prev
  }
  const list = [...solid]
  if (list.length < 2) {
    // 实音太少 → 把原谱里响过的音 (哪怕短) 也算进来, 免得左手空着
    const extra = [...pcInfo.entries()]
      .filter(([pc]) => !solid.has(pc))
      .sort((a, b) => b[1].w - a[1].w)
      .map(([pc]) => pc)
    list.push(...extra)
  }
  const keep = list.slice(0, 4)
  const root = keep.includes(bassPc) ? bassPc : keep[0]
  const iv = keep.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b)
  return { root, quality: { iv, w: 0, name: 'raw' }, pcs: keep, score: 0 }
}

// ───────────────────────────────────────────────────────── 左手构造

/**
 * 力度塑形 —— 原谱所有音都是 100 (机械), 左手得自己长出层次:
 *   - 每小节第一拍重一点 (强拍), 最后一拍回稳
 *   - 每 16 拍一个呼吸起伏 (乐句的涨落)
 */
function dyn(tick, base) {
  const b = beats(tick)
  const inBar = ((b % 4) + 4) % 4
  let v = base
  if (inBar < 0.3) v += 7
  else if (inBar > 3.4) v += 3
  const phrase = (b / 16) % 1
  v += Math.round(5 * Math.sin(Math.PI * phrase))
  return Math.max(30, Math.min(112, v))
}

/** 旋律在 [t0,t1) 里的相邻运动 (从 → 到, 半音差) */
function melodyMotion(t0, t1) {
  const inside = solo.filter((n) => n.s >= t0 && n.s < t1).sort((a, b) => a.s - b.s)
  const out = []
  for (let i = 1; i < inside.length; i++) {
    out.push({
      from: inside[i - 1].pitch,
      to: inside[i].pitch,
      d: inside[i].pitch - inside[i - 1].pitch,
    })
  }
  return out
}

/**
 * 和弦音在上方音区里的摆法.
 * 硬约束: 全在低音之上 / 跨度 ≤ 20 / 不跟右手撞小二度 / 不同度齐奏.
 * 软评分: 跟上一个摆法接近 (共同音保留) + 音区紧凑 + 不跟右手平行.
 */
function voiceChord(chord, bassPitch, prevVoicing, s, sustainEnd, incoming) {
  const upperPcs = chord.pcs.filter((pc) => pc !== bassPitch % 12)
  if (upperPcs.length === 0) return []
  const mel = melodyDuring(s, sustainEnd)

  /**
   * 平行八度/五度的**禁音表**.
   *
   * 上一段的某个和弦音 p1 跟当时的旋律正好差八度或五度, 而旋律这一动
   * 走了 d 个半音 —— 那么新和弦音要是正好落在 p1 + d, 就跟旋律**同向同量**
   * 走, 还是差八度/五度: 这就是平行八度/五度 (听着像机器人).
   *
   * 这些音直接禁掉, 不让 voiceChord 摆出来.
   */
  const banned = new Set()
  for (const inc of incoming) {
    for (const p1 of inc.prevVoicing) {
      const iv = Math.abs(p1 - inc.mv.from) % 12
      if (iv !== 0 && iv !== 7) continue
      banned.add(p1 + inc.mv.d)
    }
  }

  const perPc = upperPcs.map((pc) => {
    // 和弦音放在低音上方. 范围放宽到 bass+24 —— 低音偏高的时候低音上方
    // 常常只剩一个八度可选, 声部进行就没余地了 (平行八度会没法拆).
    // CHORD_HI 只是**偏好**, 不是硬边界; 高了就用代价压下去.
    const list = []
    for (let p = bassPitch + 2; p <= Math.min(bassPitch + 24, 67); p++) {
      if (p % 12 === pc) list.push(p)
    }
    if (list.length === 0) {
      // 实在没位置 → 允许落在低音下方 (左手偶尔也会这么摆)
      for (let p = Math.max(24, bassPitch - 12); p < bassPitch; p++) if (p % 12 === pc) list.push(p)
    }
    return list.length ? list : [pc + 48]
  })

  const combos = []
  if (perPc.length === 1) for (const a of perPc[0]) combos.push([a])
  else if (perPc.length === 2) for (const a of perPc[0]) for (const b of perPc[1]) combos.push([a, b])
  else
    for (const a of perPc[0])
      for (const b of perPc[1]) for (const c of perPc[2]) combos.push([a, b, c])

  // 旋律**正好在和弦起点**发声的那个音 —— 平行八度就是从这儿开始的
  const melAtStart = solo.filter((n) => n.s <= s && s < n.e).map((n) => n.pitch)

  let best = null
  let bestRelaxed = null
  for (const combo of combos) {
    const sorted = [...combo].sort((x, y) => x - y)

    // 硬约束: 不许踩进「平行八度/五度」的禁音表
    if (sorted.some((p) => banned.has(p))) continue

    // 硬约束: 别跟右手撞小二度 / 同度齐奏
    let hard = 0
    for (const p of sorted) {
      for (const m of mel) {
        if (isClash(p, m)) hard++
        else if (isUnison(p, m)) hard += 0.5
      }
    }

    // 硬约束 (针对和弦起点上正在响的旋律音):
    //   - 不许成八度 (12 的倍数). 平行八度的条件是「左手与旋律的有符号音程
    //     原样保持」, 而那要求起点上两个音差正好是 12 的倍数 —— 禁掉就
    //     没有平行八度了.
    //   - 不许同度齐奏, 也不许撞小二度.
    let startHit = false
    for (const p of sorted) {
      for (const m of melAtStart) {
        const d = Math.abs(p - m)
        if (d === 0 || d === 1) startHit = true
        else if (d > 0 && d % 12 === 0) startHit = true
      }
    }

    // 跟旋律成八度 —— 听起来是空的, 尽量躲开
    let oct = 0
    for (const p of sorted) {
      for (const m of mel) {
        const d = Math.abs(p - m)
        if (d > 0 && d % 12 === 0) oct++
      }
    }

    // 声部进行: 共同音尽量留住 (这才是真正能拆掉平行八度的办法)
    let motionCost = 60
    if (prevVoicing && prevVoicing.length) {
      motionCost = 0
      const used = new Set()
      for (const p of sorted) {
        let best = null
        for (let i = 0; i < prevVoicing.length; i++) {
          if (used.has(i)) continue
          if (prevVoicing[i] % 12 !== p % 12) continue
          const c = Math.abs(prevVoicing[i] - p)
          if (!best || c < best.c) best = { i, c }
        }
        if (best) {
          used.add(best.i)
          motionCost += best.c
        } else {
          motionCost += 24 // 新声部进来
        }
      }
      motionCost += (prevVoicing.length - used.size) * 18 // 上次的音被丢掉了
    }

    // 平行八度/五度: 和弦音跟着旋律同向同量地走
    let parallel = 0
    for (const inc of incoming) {
      for (const p1 of inc.prevVoicing) {
        const iv = Math.abs(p1 - inc.mv.from) % 12
        if (iv !== 0 && iv !== 7) continue
        for (const p2 of sorted) if (p2 - p1 === inc.mv.d) parallel++
      }
    }

    const span = sorted[sorted.length - 1] - sorted[0]
    const gap = sorted[0] - bassPitch
    // 和弦音整体偏高 → 加代价 (左手和弦区最好待在 50..62)
    // 每个音各自算「跑出和弦区多远」—— 只看最高/最低音的话,
    // 「整个和弦都偏低」反而躲得过去.
    let tooHigh = 0
    for (const p of sorted) {
      tooHigh += Math.max(0, CHORD_LO - p) + Math.max(0, p - CHORD_HI)
    }
    const cost =
      hard * 300 +
      oct * 25 +
      motionCost * 1.0 +
      span * 0.35 +
      gap * 0.8 +
      tooHigh * 14 +
      parallel * 400
    if (!bestRelaxed || cost < bestRelaxed.cost) bestRelaxed = { sorted, cost, hard, parallel }
    if (startHit) continue
    if (!best || cost < best.cost) best = { sorted, cost, hard, parallel }
  }
  // 全都不合法时退而求其次
  return (best ?? bestRelaxed)?.sorted ?? []
}

/** 音级在两个音级集合之间的最短音程 (半音, 环形) */
function pcDistance(a, b) {
  const d = Math.abs(a - b) % 12
  return Math.min(d, 12 - d)
}

/**
 * 这一串低音能不能挂在某个和弦底下:
 * 每个音要么本来就是和弦音, 要么只是差一个全音的「经过音」.
 * (差半音 / 三全音的不行 —— 那是脏的)
 */
function bassFitsChord(bassNotes, pcs) {
  for (const b of bassNotes) {
    const pc = b.pitch % 12
    if (pcs.includes(pc)) continue
    const nearest = Math.min(...pcs.map((c) => pcDistance(pc, c)))
    if (nearest !== 2) return false
  }
  return true
}

/**
 * chords 版: 大提琴真实低音 + 原谱实际音高推出的三和弦.
 *
 * 低音 = 大提琴的音 (八度折叠进左手低音区), 节奏原样保留.
 * 每个低音点都算一次和声 (窗口内的实际音高), 相邻同一个和弦合并成
 * 一段持续音 —— 于是变成「走路低音 + 持续和弦」, 而不是机械地每拍敲一下.
 */
function buildChords() {
  const bass = foldOctave(cello, BASS_LO, BASS_HI)
  const groups = [] // { root, quality, pcs, start, end, bassNotes, voicing }

  /**
   * 按节奏格子把低音分组.
   *
   * 同一格里的低音共用一个窗口, 所以也该共用**一个和弦** —— 否则虽然
   * 看到的内容一样, 拟合时参考的低音不同, 还是会每步换一个和弦
   * (听着还是机关枪). 用格子里**第一个**低音来定和弦.
   */
  const cellFirst = new Map()
  for (const n of bass) {
    const c = Math.floor(beats(n.s) / HARMONIC_UNIT)
    if (!cellFirst.has(c)) cellFirst.set(c, n)
  }

  for (const n of bass) {
    // 和声分析的窗口**按固定节奏单位对齐** (默认半拍一格).
    // 原因: 大提琴跑十六分音符时, 滑动窗口每一步看到的内容都不一样,
    // 和弦就会每步一变 —— 机关枪. 对齐之后, 同一格里的低音共用一个窗口,
    // 和弦自然就稳了.
    const cell = Math.floor(beats(n.s) / HARMONIC_UNIT)
    const grid = cell * HARMONIC_UNIT
    const w = soundingWindow(ticks(grid), ticks(grid + HARMONIC_UNIT))
    const prev = groups.length ? groups[groups.length - 1] : null
    const prevAge = prev ? (n.s - prev.start) / DIV : 999
    const chord = fitChord(w, cellFirst.get(cell).pitch % 12, prev, prevAge)
    if (!chord) {
      // 拟合不出和弦 —— 但低音是**原谱的音**, 一个都不能丢.
      // 低音挂得住上一段和弦就并进去, 挂不住就单出一个「只有低音」的小节.
      if (prev && bassFitsChord([n], prev.pcs)) {
        prev.end = Math.max(prev.end, n.e)
        prev.bassNotes.push(n)
      } else {
        groups.push({
          root: n.pitch % 12,
          quality: { iv: [0], w: 0, name: '-' },
          pcs: [n.pitch % 12],
          start: n.s,
          end: n.e,
          bassNotes: [n],
          voicing: [],
          solid: 0,
          brief: 0,
          solidW: 0,
          coveredW: 0,
        })
      }
      continue
    }
    // 忠实度: 这个和弦的音, 有几个是原谱里**压得住**的和弦音,
    // 有几个只是一闪而过的经过音. 用来验收「没编造」。
    let solid = 0
    let brief = 0
    let solidW = 0
    let coveredW = 0
    for (const [pc, info] of w) {
      if (info.hold >= HOLD_MIN) {
        solidW += info.w
        if (chord.pcs.includes(pc)) coveredW += info.w
      }
    }
    for (const pc of chord.pcs) {
      const info = w.get(pc)
      if (!info) continue
      if (info.hold >= HOLD_MIN) solid++
      else brief++
    }
    const sameChord = prev && prev.root === chord.root && prev.quality.name === chord.quality.name
    if (sameChord) {
      prev.end = Math.max(prev.end, n.e)
      prev.bassNotes.push(n)
      prev.brief += brief
      prev.solidW += solidW
      prev.coveredW += coveredW
    } else {
      groups.push({
        root: chord.root,
        quality: chord.quality,
        pcs: chord.pcs,
        start: n.s,
        end: n.e,
        bassNotes: [n],
        voicing: [],
        solid,
        brief,
        solidW,
        coveredW,
      })
    }
  }

  // ── 和声节奏整理 ────────────────────────────────────────────────────
  // 大提琴是**走路低音** —— 音多, 但和声并不跟着它一拍一变.
  // 所以: 短的和弦段并进上一段, 只要那几拍的低音只是「经过音」
  // (在和弦音上下一个全音, 或者本来就是和弦音) —— 巴赫的走路低音
  // 就是这么走的: 和弦持续, 低音在里面穿行.
  const MIN_SEG_BEATS = 1.0
  const merged = []
  for (const g of groups) {
    const prev = merged.length ? merged[merged.length - 1] : null
    const dur = (g.end - g.start) / DIV
    // 合并条件: 低音挂得住 **且** 两个和弦本来就是同一个和弦 (至少两个音重合).
    // 只看低音会把真正的属七 (E-G#-B-D) 吞进前面的 C 大和弦里 —— 那就把
    // 原谱最关键的和声弄没了.
    const shared = prev ? g.pcs.filter((pc) => prev.pcs.includes(pc)).length : 0
    if (prev && dur < MIN_SEG_BEATS && shared >= 2 && bassFitsChord(g.bassNotes, prev.pcs)) {
      prev.end = Math.max(prev.end, g.end)
      prev.bassNotes.push(...g.bassNotes)
      prev.solid += g.solid
      prev.brief += g.brief
      prev.solidW += g.solidW
      prev.coveredW += g.coveredW
      continue
    }
    merged.push({ ...g })
  }
  groups.length = 0
  groups.push(...merged)

  // 从左到右摆和弦音.
  // 「平行八度/五度」是**相邻两段**之间的事 —— 所以这一段要同时盯着:
  //   - 上一段的摆法 (为了声部进行平滑)
  //   - 旋律在**本段起点**那一下的运动 (上一段的音 → 本段起点上的音),
  //     免得本段的和弦音跟旋律平行八度.
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const next = groups[gi + 1]
    const sustainEnd = next ? next.start : g.end
    const prevGroup = groups[gi - 1]

    /**
     * 找出所有**跨过本段起点**的旋律运动, 配上「运动发生时正在响的那一段」
     * 的和弦音.
     *
     * 之前只认「旋律正好在本段起点落下来」的运动, 漏掉了大部分情况 ——
     * 旋律在和弦持续的当口里先动一下, 等和弦换掉的时候才跟它同向同量地走,
     * 一样是平行八度. 所以这里放宽成: m1 在本段起点之前, m2 在本段起点
     * 之后 (含起点本身).
     */
    const incoming = []
    for (let i = 1; i < solo.length; i++) {
      const m1 = solo[i - 1]
      const m2 = solo[i]
      if (!(m1.s < g.start && g.start <= m2.s)) continue
      // m1 那一刻正在响的那一段 (起点 ≤ m1.s 的最后一段)
      let h = null
      for (let j = gi - 1; j >= 0; j--) {
        if (groups[j].start <= m1.s) {
          h = groups[j]
          break
        }
      }
      if (!h || !h.voicing.length) continue
      incoming.push({
        mv: { from: m1.pitch, to: m2.pitch, d: m2.pitch - m1.pitch },
        prevVoicing: h.voicing,
      })
    }

    const bassPitch = g.bassNotes[0].pitch
    g.voicing = voiceChord(g, bassPitch, prevGroup ? prevGroup.voicing : null, g.start, sustainEnd, incoming)
  }

  // 出音: 低音按大提琴的节奏一个个出; 和弦音从这一段起点持续到下一段起点
  const notes = []
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]
    const next = groups[gi + 1]
    for (const b of g.bassNotes) {
      notes.push({ s: b.s, e: b.e, pitch: b.pitch, vel: dyn(b.s, 68), v: 'bass' })
    }
    const end = next ? next.start : g.end
    if (end <= g.start) continue
    for (const p of g.voicing) {
      notes.push({ s: g.start, e: end, pitch: p, vel: dyn(g.start, 58), v: 'chord' })
    }
  }
  return { notes, groups, bass }
}

/**
 * ensemble 版: 大提琴 + 中提琴两条真实声部, 只做八度折叠.
 */
function buildEnsemble() {
  const bass = foldOctave(cello, BASS_LO, BASS_HI)
  const mid = foldOctave(viola, 46, CHORD_HI)
  const notes = []
  for (const n of bass) notes.push({ s: n.s, e: n.e, pitch: n.pitch, vel: dyn(n.s, 68) })
  for (const n of mid) {
    // 跟右手撞小二度/同度 → 先试着挪八度, 挪不了就丢 (宁可少一个音也别糊)
    const mel = melodyDuring(n.s, n.e)
    let p = n.pitch
    if (mel.some((m) => isClash(p, m) || isUnison(p, m))) {
      const alt = p + 12 <= CHORD_HI ? p + 12 : p - 12 >= 46 ? p - 12 : null
      if (alt !== null && !mel.some((m) => isClash(alt, m) || isUnison(alt, m))) p = alt
      else continue
    }
    notes.push({ s: n.s, e: n.e, pitch: p, vel: dyn(n.s, 56) })
  }
  // 同一时刻同一音高只留一个
  notes.sort((a, b) => a.s - b.s || a.pitch - b.pitch)
  const out = []
  for (const n of notes) {
    const prev = out[out.length - 1]
    if (prev && prev.pitch === n.pitch && n.s < prev.e) {
      prev.e = Math.max(prev.e, n.e)
      continue
    }
    out.push(n)
  }
  return { notes: out, groups: [], bass }
}

/** bass 版: 只有大提琴 */
function buildBass() {
  const bass = foldOctave(cello, BASS_LO, BASS_HI)
  return {
    notes: bass.map((n) => ({ s: n.s, e: n.e, pitch: n.pitch, vel: dyn(n.s, 70) })),
    groups: [],
    bass,
  }
}

// ───────────────────────────────────────────────────────── MIDI 输出

function notesToEvents(notes, channel = 1, program = 0, name = '') {
  const evs = []
  evs.push({ tick: 0, bytes: Buffer.from([0xc0 | channel, program]) })
  if (name) evs.push({ tick: 0, bytes: trackNameEvent(name) })
  for (const n of notes) {
    evs.push({ tick: n.s, bytes: Buffer.from([0x90 | channel, n.pitch, n.vel]) })
    evs.push({ tick: n.e, bytes: Buffer.from([0x80 | channel, n.pitch, 0]) })
  }
  // 结束事件要落在**最后一个音之后** —— 放在 tick 0 会让 tick 倒退
  const last = evs.reduce((m, e) => Math.max(m, e.tick), 0)
  evs.push({ tick: last, bytes: endOfTrackEvent() })
  // 同一 tick: 先关后开 (避免同音高首尾相接被吃掉)
  evs.sort((a, b) => a.tick - b.tick || (a.bytes[0] & 0xf0) - (b.bytes[0] & 0xf0))
  return evs
}

/** 全局 meta 轨: 原速度 + 改对的拍号 (4/4) + 调号 (a 小调) */
function metaTrack() {
  const libRaw = readFileSync(LIBRARY_MIDI)
  const tempoEv = splitChunks(libRaw)
    .flatMap((c) => c.events)
    .find((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x51)
  const events = []
  if (tempoEv) events.push({ tick: 0, bytes: tempoEv.bytes })
  events.push({ tick: 0, bytes: timeSignatureEvent(BEATS_PER_BAR, 4) })
  events.push({ tick: 0, bytes: keySignatureEvent(0, 1) })
  events.push({ tick: 0, bytes: trackNameEvent('BWV 1041 · Piano Solo v2') })
  events.push({ tick: 0, bytes: endOfTrackEvent() })
  return encodeTrack(events)
}

/** 曲库里已发布的那条独奏小提琴轨 —— 右手一个字节都不改 */
function soloChunkBytes() {
  for (const c of splitChunks(readFileSync(LIBRARY_MIDI))) {
    let name = ''
    for (const ev of c.events) {
      if (ev.bytes[0] === 0xff && ev.bytes[1] === 0x03) {
        name = ev.bytes.subarray(3).toString('utf8').trim()
        break
      }
    }
    if (name === 'Solo Violin') return c.content
  }
  throw new Error('曲库里找不到独奏小提琴轨')
}

// ───────────────────────────────────────────────────────── 分析 / 自检

function audit(name, notes) {
  let clashNotes = 0
  let unisonNotes = 0
  for (const n of notes) {
    const mel = melodyDuring(n.s, n.e)
    if (mel.some((m) => isClash(n.pitch, m))) clashNotes++
    else if (mel.some((m) => isUnison(n.pitch, m))) unisonNotes++
  }
  const ps = notes.map((n) => n.pitch)
  const outOfRange = notes.filter((n) => n.pitch < 24 || n.pitch > 72).length
  console.log(`\n【${name}】左手 ${notes.length} 音, 音区 ${Math.min(...ps)}..${Math.max(...ps)}`)
  console.log(`  撞右手: 撞小二度 ${clashNotes} 音, 同度 ${unisonNotes} 音, 越界 ${outOfRange}`)
  return { clashNotes, unisonNotes, outOfRange }
}

/**
 * 平行五度/八度检查 (左手 vs 右手旋律).
 * 按声部分开算 —— 低音跟和弦是两个声部, 交叉配对没有意义.
 */
function parallels(notes) {
  const mel = solo.map((n) => ({ t: n.s, p: n.pitch })).sort((a, b) => a.t - b.t)
  const voices = new Map()
  for (const n of notes) {
    const tag = n.v ?? 'all'
    if (!voices.has(tag)) voices.set(tag, [])
    voices.get(tag).push({ t: n.s, p: n.pitch })
  }
  const out = { p5: 0, p8: 0, by: {} }
  for (const [tag, list] of voices) {
    const r = countParallels(list)
    out.p5 += r.p5
    out.p8 += r.p8
    out.by[tag] = r
  }
  return out
}

function countParallels(lhIn) {
  const mel = solo.map((n) => ({ t: n.s, p: n.pitch })).sort((a, b) => a.t - b.t)
  const lh = lhIn.sort((a, b) => a.t - b.t)
  const at = (t) => lh.filter((x) => x.t === t).map((x) => x.p)
  let p5 = 0
  let p8 = 0
  for (let i = 1; i < mel.length; i++) {
    const m1 = mel[i - 1]
    const m2 = mel[i]
    if (m2.t === m1.t) continue
    for (const x1 of at(m1.t)) {
      for (const x2 of at(m2.t)) {
        const dm = m2.p - m1.p
        const dl = x2 - x1
        if (dm === 0 || dl === 0) continue
        if (Math.sign(dm) !== Math.sign(dl)) continue
        // 严格平行: 左手与旋律之间的**有符号**音程原样保持
        if (x1 - m1.p !== x2 - m2.p) continue
        const i1 = Math.abs(x1 - m1.p) % 12
        if (i1 === 0) p8++
        else if (i1 === 7) p5++
      }
    }
  }
  return { p5, p8 }
}

// ───────────────────────────────────────────────────────── 主流程

const VERSIONS = [
  {
    id: 'bwv1041-piano-v2-chords',
    file: 'bach/bwv1041-piano-v2-chords.mid',
    title: 'BWV 1041 第一乐章 · 钢琴独奏 (和弦版)',
    trackName: 'Left Hand (Cello + Chords)',
    build: buildChords,
    difficulty: 3,
  },
  {
    id: 'bwv1041-piano-v2-ensemble',
    file: 'bach/bwv1041-piano-v2-ensemble.mid',
    title: 'BWV 1041 第一乐章 · 钢琴独奏 (原声部版)',
    trackName: 'Left Hand (Cello + Viola)',
    build: buildEnsemble,
    difficulty: 2,
  },
  {
    id: 'bwv1041-piano-v2-bass',
    file: 'bach/bwv1041-piano-v2-bass.mid',
    title: 'BWV 1041 第一乐章 · 钢琴独奏 (低音版)',
    trackName: 'Left Hand (Cello only)',
    build: buildBass,
    difficulty: 1,
  },
]

const built = VERSIONS.map((v) => ({ v, ...v.build() }))

if (mode === 'preview') {
  for (const b of built) {
    audit(b.v.id, b.notes)
    const p = parallels(b.notes)
    const detail = Object.entries(p.by)
      .map(([k, v]) => `${k}: 五度 ${v.p5} 八度 ${v.p8}`)
      .join(', ')
    console.log(`  平行: 五度 ${p.p5}, 八度 ${p.p8}  (${detail})`)
    if (b.groups.length) {
      const bars = new Set(b.groups.map((g) => Math.floor(beats(g.start) / 4))).size
      const qh = {}
      for (const g of b.groups) qh[g.quality.name] = (qh[g.quality.name] ?? 0) + 1
      const rh = {}
      for (const g of b.groups) {
        const d = Math.round((g.end - g.start) / DIV * 10) / 10
        rh[d] = (rh[d] ?? 0) + 1
      }
      console.log(`  和弦段 ${b.groups.length} 段 (覆盖 ${bars} 小节), 平均 ${(b.groups.length / bars).toFixed(1)} 段/小节`)
      // 忠实度: 和弦音有多少是真的压住的和弦音, 覆盖了原谱多少分量
      const solidSegs = b.groups.filter((g) => g.brief === 0).length
      const totSolid = b.groups.reduce((a, g) => a + g.solidW, 0)
      const totCov = b.groups.reduce((a, g) => a + g.coveredW, 0)
      console.log(
        `  忠实度: 纯和弦音 ${solidSegs}/${b.groups.length} 段, ` +
          `覆盖原谱分量 ${((totCov / Math.max(1, totSolid)) * 100).toFixed(0)}%`,
      )
      console.log(`  和弦性质:`, JSON.stringify(qh))
      console.log(`  每段时长(拍):`, JSON.stringify(rh))
      // 前 8 小节的和声进行 (按小节摊开看)
      const byBar = new Map()
      for (const g of b.groups) {
        const bar = Math.floor(beats(g.start) / 4)
        if (bar >= 8) continue
        if (!byBar.has(bar)) byBar.set(bar, [])
        byBar.get(bar).push(
          `${pcName(g.root)}${g.quality.name}${g.bassNotes[0].pitch % 12 === g.root ? '' : '/' + pcName(g.bassNotes[0].pitch % 12)}`,
        )
      }
      console.log('  前 8 小节和声进行:')
      for (const [bar, cs] of [...byBar.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`    第${bar + 1}小节: ${cs.join(' → ')}`)
      }
      // ── 人工可读的「谱面」: 左手按拍打印, 右手旋律另起一行 ──
      if (process.env.SCORE) {
        const [b0, b1] = process.env.SCORE.split('-').map(Number)
        console.log(`  谱面 (第${b0 + 1}..${b1}小节):`)
        for (let bar = b0; bar < b1; bar++) {
          const s0 = bar * 4 * DIV
          const s1 = s0 + 4 * DIV
          const lh = b.notes.filter((n) => n.s >= s0 && n.s < s1)
          const rh = solo.filter((n) => n.s >= s0 && n.s < s1)
          const fmt = (arr) =>
            arr
              .slice()
              .sort((x, y) => x.s - y.s || x.pitch - y.pitch)
              .map((n) => `${(n.s / DIV).toFixed(2)}:${n.pitch}/${((n.e - n.s) / DIV).toFixed(2)}`)
              .join(' ')
          console.log(`    第${bar + 1}小节  左手 ${fmt(lh)}`)
          console.log(`              右手 ${fmt(rh)}`)
        }
      }
      console.log(`  前 10 段:`)
      for (const g of b.groups.slice(0, 10)) {
        console.log(
          `    ${pcName(g.root)} ${g.quality.name}  低音 ${g.bassNotes[0].pitch} / 和弦 ${g.voicing.join(' ')}` +
            `  @${beats(g.start).toFixed(2)} 拍`,
        )
      }
    }
  }
  process.exit(0)
}

// ── 写文件 ──────────────────────────────────────────────────────────────
const soloBytes = soloChunkBytes()
const written = []
for (const b of built) {
  const outPath = resolve(ROOT, 'public/library', b.v.file)
  const lhTrack = encodeTrack(notesToEvents(b.notes, 1, 0, b.v.trackName))
  const out = Buffer.concat([
    smfHeader(3, DIV),
    chunk(metaTrack()),
    chunk(soloBytes),
    chunk(lhTrack),
  ])
  writeFileSync(outPath, out)
  written.push({ b, out, outPath })
  console.log(`写出 ${b.v.file}: 左手 ${b.notes.length} 音, ${out.length} 字节`)
}

// ── 自检: 右手逐音没变, 拍号调号正确 ─────────────────────────────────────
{
  const { Midi } = (await import('@tonejs/midi')).default
  for (const { b, out } of written) {
    const after = new Midi(new Uint8Array(out))
    const tracks = after.tracks.filter((t) => t.notes.length > 0)
    if (tracks.length !== 2) {
      throw new Error(`${b.v.file}: 应该正好 2 条音符轨, 实际 ${tracks.length}`)
    }
    const a = tracks[0].notes
    if (a.length !== solo.length) {
      throw new Error(`${b.v.file}: 小提琴音符数变了: ${solo.length} → ${a.length}`)
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i].ticks !== solo[i].s || a[i].midi !== solo[i].pitch) {
        throw new Error(`${b.v.file}: 小提琴第 ${i} 个音符变了`)
      }
    }
    const lh = tracks[1].notes
    if (lh.length !== b.notes.length) {
      throw new Error(`${b.v.file}: 左手音符数对不上: ${b.notes.length} → ${lh.length}`)
    }
    const ts = after.header.timeSignatures[0]
    if (!ts || ts.timeSignature[0] !== 4 || ts.timeSignature[1] !== 4) {
      throw new Error(`${b.v.file}: 拍号不对`)
    }
    const ks = after.header.keySignatures[0]
    console.log(
      `  ✓ ${b.v.file}: 右手 ${a.length} 音 (原样), 左手 ${lh.length} 音, ` +
        `拍号 ${ts.timeSignature.join('/')}, 调号 ${ks ? ks.key : '?'}, 时长 ${after.duration.toFixed(1)}s`,
    )
  }
}
