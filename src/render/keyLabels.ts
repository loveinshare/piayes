// 虚拟键盘上的音名标号 (纯逻辑, 便于单测)
//
// 用户 2026-10-30 要求: "在虚拟钢琴键盘上你需要打上 D3 之类的标号 我不认识".
// 三种模式:
//   - 'off' 不标
//   - 'c'   只标每个八度的 C (最省空间, 也能定位八度)
//   - 'all' 全标 (默认)

import type { KeyLabelMode } from '../types'
import { midiToName } from './colors'

/**
 * 这个键要显示的标号 —— null = 不显示.
 *
 * 标的是**键自己的音名** (位置音高), 不是曲谱里的音名:
 * 画布上位置 P 的键, 标 midiToName(P) —— 跟「未来音符标签」画的
 * midiToName(note.midiNote + transpose) 对得上 (那个标签也落在位置 P 上).
 */
export function labelForMidi(midi: number, mode: KeyLabelMode): string | null {
  if (mode === 'off') return null
  if (mode === 'c' && midi % 12 !== 0) return null
  return midiToName(midi)
}

/**
 * 白键上的标号字号 (px) —— 按白键宽度缩放, 保证横向放得下.
 * 白键只有自然音 (C D E F G A B), 标号最长 2 个字符 ("C4"), 很省空间.
 */
export function whiteKeyLabelSize(whiteKeyW: number): number {
  return Math.max(7, Math.min(11, Math.round(whiteKeyW * 0.34)))
}

/**
 * 黑键上的标号字号 (px) —— 黑键很窄, 标号竖着写, 字号按黑键宽度定.
 * 竖排的文字高度 = 字号, 必须塞进黑键宽度里.
 * 另外不超过白键的字号 —— 黑键更窄, 标号却比白键大看着别扭.
 */
export function blackKeyLabelSize(whiteKeyW: number): number {
  const blackKeyW = whiteKeyW * 0.6
  const byWidth = Math.max(6, Math.min(9, Math.round(blackKeyW * 0.62)))
  return Math.min(byWidth, whiteKeyLabelSize(whiteKeyW))
}
