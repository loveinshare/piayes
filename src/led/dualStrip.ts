// 双色带模式的「几何」+「下一个音」索引.
//
// ── 硬件 (2026-10-30 实机标定) ─────────────────────────────────────────
// 两条灯带**串联**接一根数据线, 共 352 颗. 实测接线:
//
//   chain 0..175    主灯带 (下) —— 数据从**左**端进, 往右推
//   chain 176..351  上灯带     —— 数据从**右**端进, 往左推 (**倒叙**)
//
// 两条带在物理**右**端对接 (主带末端 → 上带的进数据端), 所以上带的 chain
// 序号跟物理从左到右**相反**.
//
// 标定证据 (实机点 6 颗 + 2 颗定点验证):
//   chain 176 (蓝) 在物理最右, chain 350 (黄) 在物理最左.
//   chain 351 那颗物理损坏 —— 它是整条链的**最后一颗**, 坏了不截断链
//   (后面没灯可断; 红/绿/蓝/青/品红/白全亮即为证). 它属于上带 A0 那一对,
//   所以 A0 的提示只会亮 1 颗而不是 2 颗 —— 最边上的键, 不影响使用.
//
// ── 补偿换算 (用户要求「两条带物理位置对齐」) ───────────────────────────
// 上灯带的局部序号 L 放在物理位置 x = 175 - L, 所以「物理位置对齐」意味着
// 上灯带的**全局** chain 索引 = 176 + (175 - L) = 351 - x:
//
//   主带第 x 颗  ↔  上带第 (351 - x) 颗
//
//   key k (0..87)  →  主 [2k, 2k+2)      上 [350-2k, 352-2k)
//
//   A0 (k=0)  主 [0,2)     上 [350,352)   ← 物理最左
//   C8 (k=87) 主 [174,176) 上 [176,178)   ← 物理最右 (接缝)
//
// (区间都是**左闭右开** —— 跟 LedController 里 noteOn/noteOff 的写法一致.)
//
// 上灯带**不是**「同一个音再亮一颗」—— 它显示的是左右手各自的**接下来几个音**
// (每只手 N 个, 越往后越暗 —— 亮度阶梯现在由用户设「最高/最低百分比」,
//  中间按等比数列插值, 见 schemes.ts 的 ledLevelLadder).

import type { Song, SongNote } from '../types'
import { resolveHand } from '../hand'

/** 一条灯带的灯数 (88 键 × 2 LED). */
export const LEDS_PER_STRIP = 176

/**
 * 上灯带显示几个音 —— **每只手各 N 个** (用户 2026-10-31 定的).
 *
 * 上限 6 是功耗算出来的: 上灯带 N 个音 × 2 颗灯 × 2 只手 = 4N 颗,
 * 加上主灯带当前的那一组 (最多几个键) —— 4×6 + 2 = 26 颗, 在 ESP32 固件的
 * LED_MAX_LIT (30 颗同时点亮) 之内. 再多的话固件会把高下标的灯灭掉
 * (上灯带的下标最高 → 先被砍).
 */
export const UPPER_MIN_NOTES = 1
export const UPPER_MAX_NOTES = 6
/**
 * 上灯带的亮度递减系数 —— 每往后一个音, 亮度 × 这个数.
 *
 * ★ 旧的固定系数 (用户 2026-10-31 定的: 100% / 65% / 42% …).
 *   现在改成用户设「最高 / 最低相对百分比」, 中间按等比数列插值 ——
 *   见 `schemes.ts` 的 `ledLevelLadder()`. 这个常量只留着给旧测试用.
 */
export const UPPER_LEVEL_FALLOFF = 0.65

/** 一条带里, 某个 midi 占的 LED 区间 (带内**局部**索引, 左闭右开). */
export function stripRange(note: number): [number, number] | null {
  if (note < 21 || note > 108) return null
  const k = note - 21
  return [k * 2, k * 2 + 2]
}

/**
 * 上灯带 (第二条, 反着接的) 的**全局** chain 区间 (176..351, 左闭右开).
 * 已经做过补偿 —— 返回的索引跟主灯带**物理位置对齐**.
 */
export function upperRange(note: number): [number, number] | null {
  const r = stripRange(note)
  if (!r) return null
  // 主带 [start, end) → 上带 [352-end, 352-start)
  return [LEDS_PER_STRIP * 2 - r[1], LEDS_PER_STRIP * 2 - r[0]]
}

/** 某一时刻左右手各自的「接下来几个音」. */
export interface NextNotePair {
  left: SongNote[]
  right: SongNote[]
}

/**
 * 「下一个音」索引 —— 按手分成两条按时间有序的数组, 查询时二分.
 *
 * 为什么不用 `LedScanCursor` (预扫描器): 它只在
 * `isPlaying && offset!==0 && followPlayback && enabled` 时才跑,
 * 而「下一个音」必须**暂停时**、**offset=0 时**也能显示.
 *
 * 为什么不用可变游标: 拖进度条来回 seek 时游标状态容易错.
 * 这里每次查询都是纯二分 → 任何时刻查出来的都是对的.
 */
export class NextNoteIndex {
  private left: SongNote[] = []
  private right: SongNote[] = []

  /**
   * @param split 单轨谱 (分不出左右手) 时的**音高兜底切分点**:
   *   midi < split → 左手, 否则右手. 跟 LedController.baseColor 的兜底一致.
   */
  constructor(song: Song, split = 60) {
    // copy + sort: 过滤不改变相对顺序, 但不假设谱面一定已排序.
    const notes = [...song.notes].sort((a, b) => a.time - b.time)
    for (const n of notes) {
      const h =
        resolveHand(n.hand, n.track, song.hands) ??
        (n.midiNote < split ? 'left' : 'right')
      if (h === 'left') this.left.push(n)
      else this.right.push(n)
    }
  }

  /**
   * 时刻 t 的左右手接下来 count 个音 (严格晚于 t).
   *
   * 每只手各 count 个 —— 用户 2026-10-31 定的: 上灯带左边显示左手接下来的
   * N 个, 右边显示右手接下来的 N 个, 越往后越暗.
   */
  at(t: number, count = 1): NextNotePair {
    return {
      left: findNext(this.left, t, count),
      right: findNext(this.right, t, count),
    }
  }
}

/** 从第一个 time > t 的 note 开始, 取 count 个 (正在响的音不算「下一个」). */
function findNext(list: SongNote[], t: number, count: number): SongNote[] {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid].time <= t) lo = mid + 1
    else hi = mid
  }
  return list.slice(lo, lo + Math.max(0, count))
}
