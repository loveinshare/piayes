// 右键检视浮层 —— 告诉你「刚才右键的是哪个音」.
//
// 用户需求 (2026-11-02): 下落色块右键要能显示**唯一编码**(最好是数字),
// 点一下就复制, 方便把「第 42 号音符弹错了」这种话直接甩给对方.
//
// 唯一编码 = 该音符在 `song.notes` 数组里的下标 —— 全程唯一、稳定、可被
// 谱子编辑器按号定位. 下标是 0 起的, 和代码里 `song.notes[i]` 对得上.
//
// 浮层不飘在 canvas 里 (canvas 每帧重画, 会闪), 而是普通 DOM 浮在画面上.

import { useEffect, useRef, useState } from 'react'
import type { NoteHit } from '../types'
import { copyText } from './clipboard'
import { IconCheck, IconClose, IconEdit } from './icons'

interface Props {
  hit: NoteHit | null
  /** 视口坐标 (clientX / clientY) —— 用 fixed 定位, 不受父容器影响 */
  pos: { x: number; y: number } | null
  onClose: () => void
  /** 在谱子编辑器里打开并定位到这个音 */
  onEdit?: (hit: NoteHit) => void
}

const NOTE_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** midi 号 -> 音名 (C4 = 60) */
export function midiNoteName(midi: number): string {
  return `${NOTE_NAME[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function NoteInspector({ hit, pos, onClose, onEdit }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    setCopied(null)
  }, [hit?.index])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  if (!hit || !pos) return null

  /** 复制一段文字, 并在界面上闪一下「已复制」 */
  const doCopy = async (text: string, key: string) => {
    if (!(await copyText(text))) return
    setCopied(key)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 1200)
  }

  const { note, index } = hit
  const name = midiNoteName(note.midiNote)
  const hand = note.hand === 'left' ? '左手' : note.hand === 'right' ? '右手' : '未分手'

  /** 详情行 —— 点哪行复制哪行的值 */
  const rows: { key: string; label: string; value: string }[] = [
    { key: 'name', label: '音名', value: name },
    { key: 'midi', label: '音高', value: String(note.midiNote) },
    { key: 'time', label: '时间', value: `${note.time.toFixed(3)}s` },
    { key: 'dur', label: '时值', value: `${note.duration.toFixed(3)}s` },
    { key: 'measure', label: '位置', value: `第 ${hit.measure} 小节 第 ${hit.beat} 拍` },
    { key: 'hand', label: '手别', value: hand },
  ]

  return (
    <div
      className="fixed z-[60] w-56 rounded-lg bg-panel border border-border shadow-xl shadow-black/50 backdrop-blur overflow-hidden anim-fade-in"
      style={{
        left: Math.max(8, Math.min(pos.x + 12, window.innerWidth - 240)),
        top: Math.max(8, Math.min(pos.y - 8, window.innerHeight - 260)),
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border bg-raised/60">
        <span className="text-[11px] text-muted">音符唯一编码</span>
        <button
          onClick={onClose}
          className="size-5 grid place-items-center rounded text-muted hover:text-text transition"
          title="关闭"
          aria-label="关闭音符信息"
        >
          <IconClose size={12} />
        </button>
      </div>

      {/* 唯一编码 —— 点一下就复制 */}
      <button
        onClick={() => doCopy(String(index), 'index')}
        title="点击复制编码"
        className="w-full px-2.5 py-2 flex items-center justify-between gap-2 hover:bg-accent/10 transition-colors cursor-pointer"
      >
        <span className="text-xs text-muted">编码</span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono text-lg font-bold text-accent tabular-nums">
            {index}
          </span>
          {copied === 'index' && <IconCheck size={13} className="text-hit" />}
        </span>
      </button>

      <div className="border-t border-border">
        {rows.map((r) => (
          <button
            key={r.key}
            onClick={() => doCopy(r.value, r.key)}
            title="点击复制"
            className="w-full px-2.5 py-1 flex items-center justify-between gap-2 text-xs hover:bg-accent/10 transition-colors cursor-pointer"
          >
            <span className="text-muted">{r.label}</span>
            <span className="flex items-center gap-1.5 text-text font-mono tabular-nums">
              {r.value}
              {copied === r.key && <IconCheck size={11} className="text-hit" />}
            </span>
          </button>
        ))}
      </div>

      {onEdit && (
        <button
          onClick={() => onEdit(hit)}
          className="w-full px-2.5 py-1.5 flex items-center justify-center gap-1.5 border-t border-border bg-raised/40 text-xs text-accent hover:bg-accent/10 transition-colors cursor-pointer"
        >
          <IconEdit size={12} />
          在编辑器中打开
        </button>
      )}
    </div>
  )
}
