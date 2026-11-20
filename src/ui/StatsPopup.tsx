// 统计浮层: 命中 / 错过 / 完美 / 良好 / 连击 / 等级 (A-F)

import { useEffect } from 'react'
import { useStore } from '../store'
import { accuracyPercent } from '../engine/Scoring'
import { IconChart, IconClose, IconRefresh } from './icons'

interface Props {
  open: boolean
  onClose: () => void
  onRetry: () => void
}

function gradeFromAccuracy(acc: number): { letter: string; color: string } {
  if (acc >= 95) return { letter: 'S', color: 'text-accent' }
  if (acc >= 90) return { letter: 'A', color: 'text-hit' }
  if (acc >= 80) return { letter: 'B', color: 'text-good' }
  if (acc >= 70) return { letter: 'C', color: 'text-yellow-400' }
  if (acc >= 60) return { letter: 'D', color: 'text-orange-400' }
  return { letter: 'F', color: 'text-miss' }
}

export function StatsPopup({ open, onClose, onRetry }: Props) {
  const hits = useStore((s) => s.hits)
  const misses = useStore((s) => s.misses)
  const perfects = useStore((s) => s.perfects)
  const goods = useStore((s) => s.goods)
  const errors = useStore((s) => s.errors)
  const streak = useStore((s) => s.streak)
  const maxStreak = useStore((s) => s.maxStreak)
  const song = useStore((s) => s.song)
  const resetScore = useStore((s) => s.resetScore)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    // capture: true so we beat SettingsDrawer/LibraryOverlay
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, onClose])

  if (!open) return null

  // 准确率口径与 sightread 一致: error 计入分母 (spec P1-4)
  const acc = accuracyPercent(hits, misses, errors)
  const grade = gradeFromAccuracy(acc)

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-[420px] max-w-full bg-panel border border-border rounded-2xl shadow-2xl shadow-black/40 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div className="font-semibold text-text flex items-center gap-2">
            <span className="text-accent" aria-hidden>
              <IconChart size={16} />
            </span>
            本次成绩
          </div>
          <button
            onClick={onClose}
            className="size-7 grid place-items-center rounded-lg text-muted hover:bg-raised hover:text-text transition-colors"
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>

        <div className="px-6 py-5">
          <div className="flex items-center gap-4 mb-5">
            <div
              className={`size-20 rounded-full grid place-items-center text-4xl font-bold ${grade.color} bg-bg/40 border-2 border-current/40`}
            >
              {grade.letter}
            </div>
            <div className="flex-1">
              <div className="text-2xl font-semibold text-text">
                命中率 {acc}%
              </div>
              <div className="text-xs text-muted mt-1">
                {hits} 命中 · {misses} 错过 · {errors} 错按
              </div>
              <div className="text-xs text-muted mt-1">
                最长连击 ×{maxStreak} · 当前 ×{streak}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 mb-4">
            <Stat label="完美" value={perfects} color="bg-accent/15 text-accent" />
            <Stat label="良好" value={goods} color="bg-good/15 text-good" />
            <Stat label="错按" value={errors} color="bg-miss/15 text-miss" />
          </div>

          <div className="rounded bg-bg/60 px-3 py-2 text-xs text-muted">
            当前曲目: <span className="text-text">{song?.source ?? '—'}</span>
            {song?.duration ? ` · ${song.duration.toFixed(0)}s` : ''}
            {song?.bpms[0] ? ` · ${song.bpms[0].bpm.toFixed(0)} BPM` : ''}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-border flex items-center justify-end gap-2 bg-bg/30">
          <button
            onClick={() => {
              resetScore()
            }}
            className="px-3 py-1.5 rounded text-xs border border-border text-muted hover:text-text hover:border-muted"
          >
            清零统计
          </button>
          <button
            onClick={onRetry}
            className="px-4 py-1.5 rounded-lg text-sm bg-accent text-bg font-medium inline-flex items-center gap-1.5 hover:bg-accent/90 transition"
          >
            <IconRefresh size={13} />
            重新练习
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={`rounded px-3 py-2 text-center ${color}`}>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs mt-0.5 opacity-80">{label}</div>
    </div>
  )
}
