// 播放位置导航 (← / → 按任意 note, ↑ / ↓ 按小节)
// 抽成纯函数是为了好测试 — 见 tests/navigation.test.ts

import type { Song, SongNote } from '../types'
import { isActiveHand, type PracticeHand } from '../store'

/**
 * 找 curT 之后 (dir=1) 或之前 (dir=-1) 的「任意 note 时间」.
 * 用于 ←/→ 跳过卡住的 note (wait 模式冻在 required 上时, 让用户能跳过去).
 */
export function findAdjacentNoteTime(song: Song, curT: number, dir: 1 | -1): number | null {
  if (song.notes.length === 0) return null
  if (dir === 1) {
    const next = song.notes.find((n) => n.time > curT + 0.001)
    return next ? next.time : null
  } else {
    for (let i = song.notes.length - 1; i >= 0; i--) {
      if (song.notes[i].time < curT - 0.001) return song.notes[i].time
    }
    return null
  }
}

/**
 * 找 curT 之前 (dir=-1) 或之后 (dir=1) 的「active-hand note 时间」 (跟 practice 模式对齐).
 * 用于 ←/→ 跳过非 active-hand 的 note — wait 模式卡住时, 跳到 active-hand note
 * 才能让用户继续 (跳到 non-active 位置后 required 空, 视觉不动, 像「卡死」).
 *
 * 'playback' 模式 = 所有 note 都算 active.
 *
 * 注意: 这里**不能**直接用 isActiveHand —— 它对 'playback' 返回 false
 * (playback 模式下用户不弹任何音, 从"跟弹"语义看确实都不 active),
 * 但从"导航"语义看 playback 模式没有任何手别之分, 所有 note 都该能跳到.
 * 之前照抄 isActiveHand 的结果 = playback 模式下 ←/→ 完全失灵.
 */
export function findAdjacentActiveNoteTime(
  song: Song,
  curT: number,
  dir: 1 | -1,
  practiceHand: PracticeHand,
): number | null {
  if (song.notes.length === 0) return null
  // playback: 没有手别之分, 全部可选
  const active = (n: SongNote) =>
    practiceHand === 'playback' ||
    isActiveHand(n.hand, n.track, song.hands, practiceHand)
  if (dir === 1) {
    for (let i = 0; i < song.notes.length; i++) {
      if (song.notes[i].time > curT + 0.001 && active(song.notes[i])) {
        return song.notes[i].time
      }
    }
    return null
  } else {
    for (let i = song.notes.length - 1; i >= 0; i--) {
      if (song.notes[i].time < curT - 0.001 && active(song.notes[i])) {
        return song.notes[i].time
      }
    }
    return null
  }
}

/**
 * 找 curT 之后 (dir=1) 或之前 (dir=-1) 的「第一个右手 note 时间」.
 * 右手 = hand === 'right', 未标 hand 的 (单 track pitch-split 模式) 视为右手.
 */
export function findAdjacentRightNoteTime(song: Song, curT: number, dir: 1 | -1): number | null {
  const rights = song.notes.filter((n) => n.hand !== 'left')
  if (rights.length === 0) return null
  if (dir === 1) {
    const next = rights.find((n) => n.time > curT + 0.001)
    return next ? next.time : null
  } else {
    for (let i = rights.length - 1; i >= 0; i--) {
      if (rights[i].time < curT - 0.001) return rights[i].time
    }
    return null
  }
}

/** 找 curT 之后 (dir=1) 或之前 (dir=-1) 的「第一个 measure 开始时间」. */
export function findAdjacentMeasureTime(song: Song, curT: number, dir: 1 | -1): number | null {
  if (song.measures.length === 0) return null
  const sorted = [...song.measures].sort((a, b) => a.time - b.time)
  if (dir === 1) {
    const next = sorted.find((m) => m.time > curT + 0.001)
    return next ? next.time : null
  } else {
    for (let i = sorted.length - 1; i >= 0; i--) {
      if (sorted[i].time < curT - 0.001) return sorted[i].time
    }
    return null
  }
}

/**
 * 找时间 t 附近 (window 秒内) 的所有 note, 按 time 排序.
 * 用于跳转后播放预览, 让用户听到自己跳到了哪.
 */
export function notesAt(song: Song, t: number, window: number): SongNote[] {
  return song.notes
    .filter((n) => Math.abs(n.time - t) <= window)
    .sort((a, b) => a.time - b.time)
}

