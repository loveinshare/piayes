// 钢琴卷帘 (piano roll) 的几何换算 + 命中测试 + 音符定位.
//
// 单独抽出来是为了能在 vitest 里做**纯逻辑**测试 (不碰 canvas / DOM).
//
// 坐标系:
//   - X = 时间. 网格区左边缘 (keysW) 对应 viewStart 秒, 每秒 zoom 像素.
//   - Y = 音高. 每个半音一行 (rowH), 最高音在顶部, 往下递增.
//   - 顶部 rulerH 是小节标尺 —— 不参与音高换算.
//
// ★ 唯一编码 (2026-11-02): 音符在 `song.notes` 里的下标就是它的唯一编码.
//   下落色块右键、谱子编辑器里看到的编号**完全一致** —— 用户拿编号
//   就能直接说「第 42 号音符弹错了」, 编辑器也能按号定位.

import type { Song, SongNote } from '../types'
import { isBlackKey } from '../render/colors'

/** 网格区左侧琴键条宽度 (px) */
export const KEYS_W = 54
/** 顶部小节标尺高度 (px) */
export const RULER_H = 22
/** 每个半音的行高 (px) */
export const ROW_H = 12

export interface RollView {
  /** 每秒多少像素 */
  zoom: number
  /** 网格区左边缘对应的秒 */
  viewStart: number
  /** 纵向滚动 (px) */
  scrollTop: number
  /** 网格区最上面一行对应的 midi (基准值, 滚动时整体下移) */
  topPitch: number
  /** 左侧琴键条宽度 */
  keysW: number
  /** 顶部标尺高度 */
  rulerH: number
  /** 每个半音的行高 */
  rowH: number
}

export function makeRollView(over: Partial<RollView> = {}): RollView {
  return {
    zoom: 110,
    viewStart: 0,
    scrollTop: 0,
    topPitch: 96,
    keysW: KEYS_W,
    rulerH: RULER_H,
    rowH: ROW_H,
    ...over,
  }
}

/** 秒 -> 屏幕 x */
export function timeToX(v: RollView, t: number): number {
  return v.keysW + (t - v.viewStart) * v.zoom
}

/** 屏幕 x -> 秒 */
export function xToTime(v: RollView, x: number): number {
  return v.viewStart + (x - v.keysW) / v.zoom
}

/** 音高 -> 那一行的**上沿** y */
export function pitchToY(v: RollView, midi: number): number {
  return v.rulerH + (v.topPitch - midi) * v.rowH - v.scrollTop
}

/** 屏幕 y -> 所在行的音高 (向下取整) */
export function yToPitch(v: RollView, y: number): number {
  return v.topPitch - Math.floor((y - v.rulerH + v.scrollTop) / v.rowH)
}

export interface NoteRect {
  x: number
  y: number
  w: number
  h: number
}

/** 音符的屏幕矩形 */
export function noteRect(v: RollView, n: SongNote): NoteRect {
  return {
    x: timeToX(v, n.time),
    y: pitchToY(v, n.midiNote),
    w: Math.max(3, n.duration * v.zoom),
    h: v.rowH,
  }
}

export type RollHitMode = 'move' | 'resize'

/**
 * 白键跨的行 —— 左侧琴键条用.
 *
 * 一个白键的高度 = 到**上方**下一个白键的半音数:
 *   C→D 跨 2 行 (C 那行 + C# 那半格), E→F 只跨 1 行, F→G 跨 2 行……
 *
 * 画的时候从 `topPitch` 那行往下画 `rows` 行, 黑键再盖在右上角.
 * (别算成「下方白键」—— 那样每个黑键都会被更上面的白键刷掉.)
 */
export function whiteKeySpan(midi: number): { topPitch: number; rows: number } {
  let up = midi + 1
  while (up <= 127 && isBlackKey(up)) up++
  return { topPitch: up - 1, rows: Math.max(1, up - midi) }
}

/**
 * 命中测试 —— 屏幕坐标落在哪个音符上.
 *
 * - 琴键条 (x < keysW) 和标尺 (y < rulerH) 不算音符.
 * - 贴着右边缘 (resizeMargin 内) = 拖右边缘改时值, 否则 = 整体拖动.
 * - 同一行叠了多个音 (和弦/重复) → 取离鼠标中心最近的那个.
 */
export function hitTestRoll(
  notes: SongNote[],
  v: RollView,
  x: number,
  y: number,
  resizeMargin = 5,
): { index: number; mode: RollHitMode } | null {
  if (x < v.keysW || y < v.rulerH) return null
  const pitch = yToPitch(v, y)
  let best: { index: number; mode: RollHitMode; dist: number } | null = null
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i]
    if (n.midiNote !== pitch) continue
    const r = noteRect(v, n)
    if (x < r.x - 1 || x > r.x + r.w + 1) continue
    const dist = Math.abs(x - (r.x + r.w / 2))
    const mode: RollHitMode = x >= r.x + r.w - resizeMargin ? 'resize' : 'move'
    // 同距离时 resize 优先 (贴着右边缘的意图更明确)
    if (
      !best ||
      (mode === 'resize' && best.mode === 'move') ||
      (mode === best.mode && dist < best.dist)
    ) {
      best = { index: i, mode, dist }
    }
  }
  return best ? { index: best.index, mode: best.mode } : null
}

/**
 * 音符落在第几小节第几拍 —— 给用户一个「谱子里的位置」,
 * 光有数组下标 (唯一编码) 还不够好找.
 */
export function locateNote(song: Song, note: SongNote): { measure: number; beat: number } {
  let m = song.measures[0]
  for (const mm of song.measures) {
    if (mm.time <= note.time + 1e-6) m = mm
    else break
  }
  if (!m) return { measure: 1, beat: 1 }
  const num = m.numerator ?? song.timeSignature.numerator ?? 4
  const secPerBeat = m.duration > 0 ? m.duration / Math.max(1, num) : 0
  const beat = secPerBeat > 0 ? Math.floor((note.time - m.time) / secPerBeat) + 1 : 1
  return { measure: m.number, beat: Math.max(1, beat) }
}

/** 按起始时间排好序的音符下标 —— 播放调度 / 导出都要用 */
export function sortedNoteIndices(notes: SongNote[]): number[] {
  return notes
    .map((_, i) => i)
    .sort((a, b) => notes[a].time - notes[b].time || notes[a].midiNote - notes[b].midiNote)
}
