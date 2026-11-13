// Lookahead 排程器 (spec P1-2)
//
// 老实现是"到达即发声": setInterval 的回调里才决定"现在该发哪个音", 然后用
// ctx.currentTime (此刻) 发声. 主线程一卡 (GC / LED 批量刷 / React 渲染), 这一帧的
// 音就晚发十几到几十毫秒 —— 抖动 1:1 传导到音乐, 用户感觉"节拍不稳".
//
// Chris Wilson《A Tale of Two Clocks》的做法: 定时器只负责"唤醒", 音频事件必须
// **提前**排到 AudioContext 的时间轴上. 本模块负责"哪些 note 该排了", 具体的
// 排程 (算 when / 调 synth / 发 MIDI) 由 Player 做.
//
// 关键性质: 排程窗口 (lookahead) 只影响"什么时候把活交给 Web Audio",
// 不影响"声音什么时候出来" —— 声音永远落在 note.time 对应的 ctx 时刻上.

import type { SongNote } from '../types'

export class Scheduler {
  private cursor = 0

  constructor(private notes: SongNote[]) {}

  /** 下一个待排程的 note 下标 */
  get index(): number {
    return this.cursor
  }

  /** 定位到指定下标 (seek / 回卷后重置游标) */
  reset(index = 0) {
    this.cursor = Math.max(0, Math.min(index, this.notes.length))
  }

  /**
   * 取出所有 `note.time <= horizon` 的 note.
   * horizon = 当前歌曲时间 + lookahead.
   * notes 按 time 升序 —— 遇到第一个超时的就停, 后面更不会到.
   */
  takeDue(horizon: number, out: SongNote[] = []): SongNote[] {
    const notes = this.notes
    while (this.cursor < notes.length && notes[this.cursor].time <= horizon) {
      out.push(notes[this.cursor])
      this.cursor++
    }
    return out
  }

  /** 剩下的 note 数 (调试) */
  get remaining(): number {
    return Math.max(0, this.notes.length - this.cursor)
  }
}
