// 抢先模式 (Lead mode) 的灯带差分 —— 主灯带显示「每只手现在该弹的音」
//
// 跟 LedScanCursor 的分工:
//  - LedScanCursor: **按时间**扫事件流 (谁到点谁亮) —— 播放层的老语义;
//  - leadStrip:    **按状态**驱动 —— 上层每帧把「现在该亮哪几个音」算出来,
//                   跟上一帧比, 只发改动的那些灯.
//
// 抢先模式的灯不是时间的函数, 是**状态的投影**: 弹对了才推进, 不等时钟
// (见 docs/spec-2026-10-20-code-audit.md §R23).
//
// 为什么单独一个模块: 差分逻辑是纯函数, 可以直接单测 —— 不用起浏览器,
// 不用连灯带.

import type { SongNote } from '../types'

/**
 * 一只手的抢先提示.
 *
 * `notes` 是**同一时刻的所有 note** (一「组」) —— 组里的音一起亮,
 * 跟主灯带老语义 (同一时刻的音一起亮) 一致.
 */
export interface LeadHandHint {
  /** 这只手 (左手 / 右手) */
  hand: 'left' | 'right'
  /** 该手待弹组的谱面时间 (秒, 歌曲时间轴) */
  time: number
  /** 该组的所有 note */
  notes: SongNote[]
}

/**
 * 抢先模式的灯带提示 —— **每只手一份**.
 *
 * 为什么按手拆开: 两只手是**两个独立的游标** (各弹各的), 左手弹对了不该
 * 把右手的提示也换掉. 拆开之后每只手各管各的灯位.
 */
export interface LeadHint {
  /** 每只手的提示 (没有待弹音的那只手不出现) */
  hands: LeadHandHint[]
}

/** 差分的一项 —— 带上**手别**, 因为灯位是按 (midi, 手) 记的. */
export interface LeadHintNote {
  /** 键 (0-127) */
  midi: number
  /** 手别 —— 同键双手各占一个灯位 */
  hand: 'left' | 'right'
  /** 原始 note */
  note: SongNote
}

/**
 * 上一帧提示 → 这一帧提示: 要点亮哪些、要灭掉哪些.
 *
 * 规则 (按 **(midi, 手)** 配对 —— 灯位就是这么记的):
 *  - 新出现的 (midi, 手) → 点亮;
 *  - 消失的 (midi, 手) → 灭掉;
 *  - 两边都有 → 什么都不做 (灯一直亮着, 弹对了才推进).
 *
 * 同一个 midi 两只手都在 → **两个灯位**, 各亮各的 (同键双手各占灯位).
 */
export function diffLeadHints(
  prev: LeadHint | null,
  next: LeadHint | null,
): { on: LeadHintNote[]; off: LeadHintNote[] } {
  const on: LeadHintNote[] = []
  const off: LeadHintNote[] = []
  const prevItems = flatten(prev)
  const nextItems = flatten(next)
  for (const it of nextItems) {
    if (!prevItems.some((p) => p.midi === it.midi && p.hand === it.hand)) on.push(it)
  }
  for (const it of prevItems) {
    if (!nextItems.some((p) => p.midi === it.midi && p.hand === it.hand)) off.push(it)
  }
  return { on, off }
}

/** 把按手的提示摊平成 (midi, 手) 列表 */
function flatten(hint: LeadHint | null): LeadHintNote[] {
  const out: LeadHintNote[] = []
  if (!hint) return out
  for (const h of hint.hands) {
    for (const note of h.notes) {
      out.push({ midi: note.midiNote, hand: h.hand, note })
    }
  }
  return out
}
