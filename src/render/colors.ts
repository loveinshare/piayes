// 渲染配色
// 跟 tailwind.config.js 里的 color 保持一致, Canvas 直接取

import type { Hand } from '../types'

export const COLORS = {
  bg: '#0f1014',
  panel: '#1a1c23',
  border: '#2a2c35',
  text: '#e5e7eb',
  muted: '#6b7280',
  hit: '#22c55e',
  good: '#84cc16',
  miss: '#ef4444',
  hitLine: '#fbbf24',
  hand: {
    // 左手蓝 / 右手红 —— 跟灯带方案 C 的约定一致 (见 src/led/schemes.ts:
    // "蓝左手红右手"), 屏幕和灯带对得上, 不用记两套颜色.
    left: '#60a5fa',   // 蓝
    right: '#ef4444',  // 红
    unknown: '#9ca3af', // 灰 (没 hand 标注时)
  } satisfies Record<Hand | 'unknown', string>,
  whiteKey: '#f3f4f6',
  blackKey: '#1f2937',
  whiteKeyPressed: '#fef08a',
  blackKeyPressed: '#a16207',
  loopRange: 'rgba(167, 139, 250, 0.10)',
  loopRangeLine: 'rgba(167, 139, 250, 0.6)',
  countdown: '#fbbf24',
}

// 钢琴 88 键范围: A0 (MIDI 21) 到 C8 (MIDI 108)
export const MIDI_MIN = 21
export const MIDI_MAX = 108
export const TOTAL_KEYS = MIDI_MAX - MIDI_MIN + 1

/** 给定 midiNote, 返回是否为黑键 */
export function isBlackKey(midi: number): boolean {
  const pc = midi % 12
  // C# D# F# G# A# = 1, 3, 6, 8, 10
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10
}

/** 给定 midiNote, 返回白键索引 (0-based, 范围 [MIDI_MIN, MIDI_MAX]).
 *  原版按 "global" 算: A0 返回 5 (前面有 C-1..G-1 五个 phantom 白键), 画出来钢琴从 x=5*whiteKeyW 开始,
 *  左边 ~10% 画布空着, 右边 C8 反而被裁掉. 改成相对 [MIDI_MIN, MIDI_MAX] 的 0-based,
 *  让 A0 = 0, C8 = 51, 钢琴正好填满画布宽度. */
const PC_TO_WHITE_OFFSET: Record<number, number> = {
  0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6,
}
function rawWhiteKeyIndex(midi: number): number {
  const pc = midi % 12
  const octave = Math.floor(midi / 12) - 1
  return octave * 7 + (PC_TO_WHITE_OFFSET[pc] ?? 0)
}
const WHITE_KEY_BASELINE = rawWhiteKeyIndex(MIDI_MIN) // A0 → 5; 减掉它让最低键从 0 起
export function whiteKeyIndex(midi: number): number {
  return rawWhiteKeyIndex(midi) - WHITE_KEY_BASELINE
}

/** 总白键数 (A0..C8 之间的所有白键) */
export function totalWhiteKeys(midiMin: number, midiMax: number): number {
  return whiteKeyIndex(midiMax) - whiteKeyIndex(midiMin) + 1
}

/** 给 midi 编号 → 音名 (e.g. 60 -> "C4") */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export function midiToName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}
