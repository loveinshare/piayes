// MIDI 导出 —— 把改过的音符写回 .mid 文件.
//
// 用 @tonejs/midi (解析 MIDI 用的同一个库), 但**不碰**它的 time/duration
// setter —— 那两个 setter 依赖 header 的 tempo map, 顺序错了会算错;
// 这里自己算 ticks, 直接喂 addNote({ticks, durationTicks}), 结果精确可预测.

import { Midi } from '@tonejs/midi'
import type { Song, SongNote, Bpm } from '../types'

/** 曲子里的 tempo 段 (没给就用 120) */
function tempoSegments(song: Song): Bpm[] {
  if (song.bpms && song.bpms.length > 0) {
    const sorted = [...song.bpms].sort((a, b) => a.time - b.time)
    // 保证第一个 tempo 从 0 开始 (否则 0 之前的秒数没定义)
    if (sorted[0].time > 1e-9) sorted.unshift({ time: 0, bpm: sorted[0].bpm })
    return sorted
  }
  return [{ time: 0, bpm: 120 }]
}

/**
 * 秒 -> tick (按 tempo map 逐段累加).
 * 自己实现而不是用 header.secondsToTicks —— 后者依赖 header 已经排好的
 * tempo 事件, 而我们正是要**写**这些事件.
 */
export function secondsToTicks(segments: Bpm[], seconds: number, ppq: number): number {
  if (seconds <= 0) return 0
  let ticks = 0
  for (let i = 0; i < segments.length; i++) {
    const segStart = segments[i].time
    const segEnd = i + 1 < segments.length ? segments[i + 1].time : Infinity
    if (seconds <= segStart) break
    const end = Math.min(seconds, segEnd)
    ticks += ((end - segStart) / (60 / segments[i].bpm)) * ppq
  }
  return Math.round(ticks)
}

/** 音符 -> MIDI 音名 (C4 = 60) */
export function midiToPitchName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1)
}

/**
 * Song + 音符 -> .mid 字节.
 *
 * 左右手分成两条轨 (跟原文件的通道结构一致), 音符按 tick 精确定位.
 */
export function buildMidi(song: Song, notes: SongNote[]): Uint8Array {
  const midi = new Midi()
  const ppq = midi.header.ppq
  const segs = tempoSegments(song)

  // tempo 事件 (自己排好 tick 再交给 header)
  midi.header.tempos = segs.map((b) => ({
    bpm: b.bpm,
    ticks: secondsToTicks(segs, b.time, ppq),
  }))
  midi.header.update()
  if (song.title) midi.header.name = latin1Safe(song.title)

  // 分轨: 右手一条, 左手一条; 没分手别的归右手
  const right = midi.addTrack()
  const left = midi.addTrack()
  right.name = 'Right hand'
  left.name = 'Left hand'

  for (const n of notes) {
    const target = n.hand === 'left' ? left : right
    const ticks = secondsToTicks(segs, n.time, ppq)
    const endTicks = secondsToTicks(segs, n.time + Math.max(0.01, n.duration), ppq)
    target.addNote({
      midi: n.midiNote,
      ticks,
      durationTicks: Math.max(1, endTicks - ticks),
      velocity: Math.max(0.01, Math.min(1, n.velocity ?? 0.8)),
    })
  }

  return midi.toArray()
}

/**
 * MIDI 的 meta 文本是 **Latin-1 单字节**, 不是 UTF-8.
 *
 * @tonejs/midi 直接 `charCodeAt(i) & 0xff` 写字节, 所以中文标题会变成乱码
 * (`测试曲` → `KÕò`). 这里把非 ASCII 字符换掉 —— 真正的曲名放在**下载文件名**
 * 里, 那儿是 UTF-8, 中文能正常显示.
 */
export function latin1Safe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '?')
}
