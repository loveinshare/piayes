// 手别判定 —— 从 store 里拆出来单独一个模块.
//
// 为什么拆: `src/led/dualStrip.ts` (双色带的「下一个音」索引) 需要用
// `resolveHand`, 而 store.ts 又 import 了 `led/LedController` —— 放着不动会
// 形成 store → LedController → dualStrip → store 的循环依赖.
// 单独一个叶子模块, 两边都 import 它, 环就没了.

import type { Hand } from './types'

/**
 * 给定一个 note, 判定它属于哪只手 (用于 UI 着色; 不参与 MIDI 路由)
 */
export function noteHand(
  noteHand: Hand | undefined,
  noteTrack: number,
  songHands: { left: number; right: number },
): Hand | undefined {
  if (noteHand) return noteHand
  if (noteTrack === songHands.left) return 'left'
  if (noteTrack === songHands.right) return 'right'
  return undefined
}

/**
 * 给定一个 note, 判定它属于哪只手.
 *
 * 关键: 单轨曲 (songHands.left === songHands.right) 里 note 没标 hand 时,
 * **不能**默认判成 'left' —— 那会让 right 模式下所有 note 都不 active,
 * 表现为"←/→ 键完全失灵" (findAdjacentActiveNoteTime 找不到任何候选).
 * 这种曲子通常由 inferHands 的声部聚类补过 hand, 补不上的就标 undefined,
 * 交给调用方按"未知"处理.
 */
export function resolveHand(
  noteHand: Hand | undefined,
  noteTrack: number,
  songHands: { left: number; right: number },
): Hand | undefined {
  if (noteHand) return noteHand
  if (noteTrack === songHands.left && noteTrack === songHands.right) return undefined
  if (noteTrack === songHands.left) return 'left'
  if (noteTrack === songHands.right) return 'right'
  return undefined
}
