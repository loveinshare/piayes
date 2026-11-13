// 谱子编辑器 —— 快速改 MIDI / MXL 谱子的**音高**和**时值**.
//
// 用户需求 (2026-11-02):
//   - 下落色块右键能看到「唯一编码」(数字), 点一下就复制 —— 方便跟人对齐
//     「第 42 号音符弹错了」. 那部分在 NoteInspector 里.
//   - 要一个简易的 MIDI / MXL 编辑器: 快速改音高和时值, 右键色块能定位过来,
//     乐谱文件那里也能右键打开, 并且要有简易播放能力.
//
// 设计:
//   - 钢琴卷帘 (piano roll): X = 时间, Y = 音高, 左侧一条琴键.
//   - 编辑的是**当前曲目的副本**; 改完点「应用到当前曲目」才写回 ——
//     免得改到一半把正在弹的曲子弄乱.
//   - 唯一编码 = 音符在 song.notes 里的下标, 和下落色块右键看到的编号**完全一致**.
//   - 删除用「墓碑」(removed 集合) 而不是 splice —— 编辑过程中编号不漂移,
//     用户对号入座需要稳定编号; 点「应用到当前曲目」时才真正剔除.
//
// 快捷键: 空格 播放/停止 · ↑↓ 改音高 (Shift = 八度) · ←→ 挪时间 ·
//         Delete 删除 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · Esc 关闭

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Song, SongNote } from '../types'
import type { Synthesizer } from '../engine/Synthesizer'
import { TempoMap } from '../util/tempoMap'
import { COLORS, isBlackKey, midiToName } from '../render/colors'
import { buildMidi } from '../editor/exportMidi'
import { buildMxl } from '../editor/exportMusicXml'
import {
  hitTestRoll,
  locateNote,
  makeRollView,
  noteRect,
  pitchToY,
  RULER_H,
  ROW_H,
  type RollView,
  whiteKeySpan,
} from '../editor/roll'
import { copyText } from './clipboard'
import { NoteInspector } from './NoteInspector'
import { cx } from './controls'
import { useAuth, openAuthModal } from '../auth'
import { useStore } from '../store'
import { uploadMyScore, saveToPublicLibrary } from '../library'
import {
  IconCheck,
  IconClose,
  IconDownload2,
  IconGrid,
  IconMinus,
  IconPause,
  IconPlay,
  IconPlus,
  IconRedo,
  IconSave,
  IconSoundWave,
  IconTrash,
  IconUndo,
  IconUpload,
} from './icons'

interface Props {
  open: boolean
  song: Song | null
  /** 打开时要定位到的音符下标 (从下落色块右键跳过来) */
  focusIndex?: number | null
  synth: Synthesizer
  /**
   * MIDI 输出 (电钢) —— 点音符时联动发一声.
   * 只声明用到的几个方法, 编辑器不直接依赖 Accompaniment 类 (好测).
   */
  midiOut?: {
    isEnabled: () => boolean
    sendNoteOn: (n: SongNote) => void
    sendNoteOff: (n: SongNote) => void
  }
  /**
   * 灯带 —— 点音符时亮一下.
   *
   * 传 ref 而不是实例: LED 是异步连上的, 传实例的话连上之前渲染的那次
   * 拿到的永远是 null.
   *
   * ★ 不走 LED 事件总线: 总线上的 'input' 事件会被「跟随输入」开关过滤掉
   *   (用户关了就没灯), 而且会一路送到 Player —— 那儿会当成「用户按了这个键」
   *   去判命中/错音. 直接控制灯带最干净.
   *
   * ★ show() 必须一起调: 树莓派 (WS) 的 set_many 只写缓冲区, 不 show 就
   *   永远刷不到物理灯带上 —— 表现就是「点了没反应」. ESP32 那边 set_many
   *   自己会 show, 所以 show() 在那边是空操作.
   */
  ledRef?: {
    current: {
      noteOn: (n: number, hand?: 'left' | 'right') => void
      noteOff: (n: number, hand?: 'left' | 'right') => void
      show?: () => unknown
    } | null
  }
  onClose: () => void
  /** 把改好的音符写回当前曲目 */
  onApply: (notes: SongNote[]) => void
}

/** 编辑快照 —— 撤销 / 重做用 */
interface Snapshot {
  notes: SongNote[]
  removed: number[]
}

interface DragState {
  kind: 'move' | 'resize' | 'pan'
  /** live 下标 (在 liveNotes 里的位置) */
  index: number
  startX: number
  startY: number
  origTime: number
  origDur: number
  origPitch: number
  viewStart0: number
  scrollTop0: number
  snapshot: Snapshot
}

export function ScoreEditor({ open, song, focusIndex, synth, midiOut, ledRef, onClose, onApply }: Props) {
  /* ---------------- 状态 ---------------- */
  const user = useAuth((s) => s.user)
  const [notes, setNotes] = useState<SongNote[]>([])
  /** 被删掉的音符下标 (墓碑) —— 保证编辑过程中唯一编码不漂移 */
  const [removed, setRemoved] = useState<Set<number>>(new Set())
  /** 选中的音符下标 (**原始下标**, 不是 live 下标) */
  const [selected, setSelected] = useState<number | null>(null)
  const [view, setView] = useState<RollView>(() => makeRollView())
  const [playing, setPlaying] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [inspect, setInspect] = useState<{
    hit: { index: number; note: SongNote; measure: number; beat: number }
    pos: { x: number; y: number }
  } | null>(null)
  const [undoDepth, setUndoDepth] = useState(0)
  const [redoDepth, setRedoDepth] = useState(0)

  /* ---------------- refs (给 canvas / 事件回调读最新值) ---------------- */
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const notesRef = useRef<SongNote[]>([])
  const removedRef = useRef<Set<number>>(new Set())
  const liveIdxRef = useRef<number[]>([])
  const liveNotesRef = useRef<SongNote[]>([])
  const viewRef = useRef<RollView>(view)
  const selectedRef = useRef<number | null>(null)
  const songRef = useRef<Song | null>(song)
  const dragRef = useRef<DragState | null>(null)
  const undoRef = useRef<Snapshot[]>([])
  const redoRef = useRef<Snapshot[]>([])
  const playheadRef = useRef<number | null>(null)
  const playFromRef = useRef(0)
  const audioStartRef = useRef(0)
  const nextRef = useRef(0)
  const sortedRef = useRef<number[]>([])
  const wasOpenRef = useRef(false)
  /** MIDI 输出 (电钢) —— 放 ref 里, 事件回调读最新值 */
  const midiOutRef = useRef(midiOut)
  useEffect(() => { midiOutRef.current = midiOut }, [midiOut])
  const appliedRef = useRef(false)
  /**
   * 当前亮着的那个音 (点音符定位用).
   *
   * ★ 同一时刻只亮一个 —— 用户要求「点哪个音符你就只亮那个音符」,
   *   这样他能在琴上找到那个键. 点下一个音 → 上一个灭, 新的亮.
   */
  const litNoteRef = useRef<{ midi: number; hand?: 'left' | 'right' } | null>(null)
  /** 已经处理过的 focusIndex —— 防止「应用到当前曲目」后又被拉回去 */
  const handledFocusRef = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)
  const copiedTimer = useRef<number | null>(null)

  /* ---------------- 派生数据 ---------------- */
  /** 活着的音符下标 (原始下标) */
  const liveIdx = useMemo(() => {
    const out: number[] = []
    for (let i = 0; i < notes.length; i++) if (!removed.has(i)) out.push(i)
    return out
  }, [notes, removed])
  const liveNotes = useMemo(() => liveIdx.map((i) => notes[i]), [liveIdx, notes])
  const selNote = selected != null ? notes[selected] ?? null : null

  const tempoMap = useMemo(
    () => new TempoMap(song?.bpms ?? [], song?.timeSignature.denominator ?? 4),
    [song],
  )
  /** 方向键挪动的最小单位 = 一拍的四分之一 (16 分音符) */
  const gridStep = useMemo(() => {
    const beat = tempoMap.secPerBeatAt(0)
    return beat > 0 ? beat / 4 : 0.125
  }, [tempoMap])

  /* ---------------- refs 同步 ---------------- */
  useEffect(() => { notesRef.current = notes }, [notes])
  useEffect(() => { removedRef.current = removed }, [removed])
  useEffect(() => { liveIdxRef.current = liveIdx }, [liveIdx])
  useEffect(() => { liveNotesRef.current = liveNotes }, [liveNotes])
  useEffect(() => { viewRef.current = view }, [view])
  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { songRef.current = song }, [song])

  /* ---------------- 提示 ---------------- */
  const flash = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2200)
  }, [])
  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
  }, [])

  /* ---------------- 撤销 / 重做 ---------------- */
  const takeSnapshot = useCallback((): Snapshot => ({
    notes: notesRef.current.map((n) => ({ ...n })),
    removed: [...removedRef.current],
  }), [])

  const pushUndo = useCallback((snap: Snapshot) => {
    undoRef.current.push(snap)
    if (undoRef.current.length > 200) undoRef.current.shift()
    redoRef.current = []
    setUndoDepth(undoRef.current.length)
    setRedoDepth(0)
  }, [])

  const undo = useCallback(() => {
    const snap = undoRef.current.pop()
    if (!snap) return
    redoRef.current.push(takeSnapshot())
    setNotes(snap.notes)
    setRemoved(new Set(snap.removed))
    setUndoDepth(undoRef.current.length)
    setRedoDepth(redoRef.current.length)
  }, [takeSnapshot])

  const redo = useCallback(() => {
    const snap = redoRef.current.pop()
    if (!snap) return
    undoRef.current.push(takeSnapshot())
    setNotes(snap.notes)
    setRemoved(new Set(snap.removed))
    setUndoDepth(undoRef.current.length)
    setRedoDepth(redoRef.current.length)
  }, [takeSnapshot])

  /* ---------------- 编辑操作 ---------------- */
  const updateNote = useCallback((index: number, patch: Partial<SongNote>) => {
    pushUndo(takeSnapshot())
    setNotes((prev) => {
      if (index < 0 || index >= prev.length) return prev
      const next = prev.slice()
      next[index] = { ...next[index], ...patch }
      return next
    })
  }, [pushUndo, takeSnapshot])

  const deleteNote = useCallback((index: number) => {
    pushUndo(takeSnapshot())
    setRemoved((prev) => {
      const next = new Set(prev)
      next.add(index)
      return next
    })
    setSelected((cur) => (cur === index ? null : cur))
  }, [pushUndo, takeSnapshot])

  const addNote = useCallback(() => {
    pushUndo(takeSnapshot())
    const base = selectedRef.current != null ? notesRef.current[selectedRef.current] : null
    const at = base ? base.time + base.duration : 0
    const pitch = base ? base.midiNote : 60
    const n: SongNote = {
      midiNote: pitch,
      time: at,
      duration: 0.5,
      track: base?.track ?? songRef.current?.hands.right ?? 0,
      hand: base?.hand ?? 'right',
      velocity: 0.8,
    }
    setNotes((prev) => [...prev, n])
    flash('已添加音符 (编号 ' + notesRef.current.length + ')')
  }, [pushUndo, takeSnapshot, flash])

  /* ---------------- 载入 / 定位 ---------------- */
  const loadSong = useCallback((s: Song | null) => {
    const list = s ? s.notes.map((n) => ({ ...n })) : []
    setNotes(list)
    setRemoved(new Set())
    setSelected(null)
    undoRef.current = []
    redoRef.current = []
    setUndoDepth(0)
    setRedoDepth(0)
    // 音高范围 → 初始视图
    const pitches = list.map((n) => n.midiNote)
    const maxP = Math.min(108, (pitches.length ? Math.max(...pitches) : 84) + 3)
    const minP = Math.max(0, (pitches.length ? Math.min(...pitches) : 48) - 3)
    setView((prev) => ({ ...prev, topPitch: maxP, scrollTop: 0, viewStart: 0 }))
    // 竖向滚动: 让最低音落在网格底部 (内容比网格矮就贴着顶)
    requestAnimationFrame(() => {
      const cvs = canvasRef.current
      if (!cvs) return
      const H = cvs.getBoundingClientRect().height
      const gridH = Math.max(0, H - RULER_H)
      const scrollTop = Math.max(0, (maxP - minP) * ROW_H - gridH)
      setView((v) => ({ ...v, scrollTop }))
    })
  }, [])

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      handledFocusRef.current = null
      return
    }
    if (appliedRef.current) {
      // 刚「应用到当前曲目」—— 工作副本已经跟新曲目对齐, 不用重载
      appliedRef.current = false
      wasOpenRef.current = true
      return
    }
    if (!wasOpenRef.current) {
      loadSong(song)
    }
    wasOpenRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, song])

  /** 把某个音符滚到视野中央 (从下落色块跳过来时用) */
  const scrollToNote = useCallback((index: number) => {
    const cvs = canvasRef.current
    const n = notesRef.current[index]
    if (!cvs || !n) return
    const H = cvs.getBoundingClientRect().height
    setView((prev) => {
      const gridH = Math.max(0, H - prev.rulerH)
      const rowY = prev.rulerH + (prev.topPitch - n.midiNote) * prev.rowH
      const scrollTop = Math.max(0, rowY - gridH / 2)
      return { ...prev, scrollTop, viewStart: Math.max(0, n.time - 1.5) }
    })
  }, [])

  useEffect(() => {
    if (!open || focusIndex == null) return
    if (focusIndex === handledFocusRef.current) return
    if (focusIndex < 0 || focusIndex >= notes.length) return
    handledFocusRef.current = focusIndex
    setSelected(focusIndex)
    // ★ 同步写 ref —— useEffect 是**被动**的, DOM 已经显示选中态了 ref 还可能是
    //   旧的 (null). 用户紧接着按 ↑ 就会没反应.
    selectedRef.current = focusIndex
    scrollToNote(focusIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, focusIndex, notes])

  /* ---------------- 画布绘制 ---------------- */
  const draw = useCallback(() => {
    const cvs = canvasRef.current
    if (!cvs) return
    const ctx = cvs.getContext('2d')
    if (!ctx) return
    const rect = cvs.getBoundingClientRect()
    const W = Math.max(1, Math.floor(rect.width))
    const H = Math.max(1, Math.floor(rect.height))
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(W * dpr)
    const ph = Math.round(H * dpr)
    if (cvs.width !== pw || cvs.height !== ph) {
      cvs.width = pw
      cvs.height = ph
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)

    const v = viewRef.current
    const all = notesRef.current
    const dead = removedRef.current
    const sel = selectedRef.current
    const gridX = v.keysW
    const gridY = v.rulerH
    const gridW = W - v.keysW
    const gridH = H - v.rulerH

    ctx.fillStyle = '#0f1014'
    ctx.fillRect(0, 0, W, H)

    // --- 音高行 ---
    // 只画**可见**的行: 上边界 = 网格顶 + 一行余量, 下边界 = 网格底.
    // (之前从 topPitch 往下循环 + break, 结果第一行就在标尺上面 → 整个循环
    //  立刻退出, 琴键条和行底色全没了.)
    const pTop = Math.min(127, v.topPitch)
    const pBot = Math.max(0, v.topPitch - Math.ceil((H - gridY + v.scrollTop) / v.rowH) - 2)
    for (let p = pBot; p <= pTop; p++) {
      const y = pitchToY(v, p)
      if (y + v.rowH < gridY || y > H) continue
      ctx.fillStyle = isBlackKey(p) ? '#131519' : '#191c23'
      ctx.fillRect(gridX, y, gridW, v.rowH)
      if (p % 12 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)'
        ctx.fillRect(gridX, y, gridW, v.rowH)
      }
    }

    // --- 小节线 ---
    const measures = songRef.current?.measures ?? []
    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
    ctx.textBaseline = 'middle'
    for (const m of measures) {
      const x = gridX + (m.time - v.viewStart) * v.zoom
      if (x < gridX - 1 || x > W) continue
      ctx.strokeStyle = 'rgba(255,255,255,0.09)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(Math.round(x) + 0.5, gridY)
      ctx.lineTo(Math.round(x) + 0.5, H)
      ctx.stroke()
      ctx.fillStyle = '#6b7280'
      ctx.fillText(String(m.number), x + 3, v.rulerH / 2)
    }

    // --- 音符 ---
    // 选中态: 只有它亮 (其余压暗) —— 用户要点哪就能一眼找到哪.
    const hasSel = sel != null
    for (let i = 0; i < all.length; i++) {
      if (dead.has(i)) continue
      const n = all[i]
      const r = noteRect(v, n)
      if (r.x + r.w < gridX || r.x > W) continue
      const y = r.y + 1
      const h = Math.max(2, r.h - 2)
      const color =
        n.hand === 'left' ? COLORS.hand.left
        : n.hand === 'right' ? COLORS.hand.right
        : COLORS.hand.unknown
      const isSel = i === sel
      ctx.globalAlpha = hasSel && !isSel ? 0.32 : 1
      ctx.fillStyle = color
      roundRect(ctx, r.x, y, Math.max(3, r.w), h, 3)
      ctx.fill()
      if (isSel) {
        // 亮色描边 + 光晕 —— 远处也能一眼看见
        ctx.save()
        ctx.shadowColor = 'rgba(251,191,36,0.95)'
        ctx.shadowBlur = 14
        ctx.strokeStyle = '#fbbf24'
        ctx.lineWidth = 2
        roundRect(ctx, r.x + 1, y + 1, Math.max(2, r.w - 2), Math.max(2, h - 2), 3)
        ctx.stroke()
        ctx.restore()
        // 底下再垫一条亮条, 短的音也看得见
        ctx.fillStyle = 'rgba(251,191,36,0.28)'
        ctx.fillRect(r.x, y + h - 2, Math.max(3, r.w), 2)
      }
      ctx.globalAlpha = 1
      // 唯一编码 —— 宽度够就写上, 用户可以直接对号
      if (r.w > 18) {
        ctx.fillStyle = isSel ? '#1a1206' : 'rgba(15,16,20,0.8)'
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(i), r.x + 3, y + h / 2 + 0.5)
      }
    }

    // --- 播放头 ---
    if (playheadRef.current != null) {
      const x = gridX + (playheadRef.current - v.viewStart) * v.zoom
      if (x >= gridX && x <= W) {
        ctx.strokeStyle = '#fbbf24'
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(x, gridY)
        ctx.lineTo(x, H)
        ctx.stroke()
      }
    }

    // --- 左侧琴键条 ---
    ctx.fillStyle = '#0b0c10'
    ctx.fillRect(0, gridY, gridX, gridH)
    for (let p = pBot; p <= pTop; p++) {
      const y = pitchToY(v, p)
      if (y + v.rowH < gridY || y > H) continue
      const black = isBlackKey(p)
      const isSel = sel != null && all[sel]?.midiNote === p
      // 选中的键亮, 其余压暗 —— 只亮用户点的那一个音
      ctx.globalAlpha = sel != null && !isSel ? 0.45 : 1
      if (black) {
        // 黑键: 靠右、窄一点、圆角 —— 不然只是一列色块, 不像钢琴
        const bx = gridX * 0.6
        const bw = gridX * 0.36
        ctx.fillStyle = isSel ? '#fbbf24' : '#05070b'
        roundRect(ctx, bx, y + 0.5, bw, v.rowH - 1, 2)
        ctx.fill()
        if (!isSel) {
          ctx.strokeStyle = 'rgba(255,255,255,0.14)'
          ctx.lineWidth = 1
          ctx.stroke()
        }
      } else {
        // 白键: 从**上方**那个白键一直连下来 —— C 要盖住 C# 那半格,
        // E 只占一格. 之前错算成「下方白键」, 结果每个黑键都被更上面的
        // 白键盖掉, 整条琴键变成一片白, 黑键全没了.
        const span = whiteKeySpan(p)
        const top = pitchToY(v, span.topPitch)
        const h = span.rows * v.rowH
        ctx.fillStyle = isSel ? '#fbbf24' : '#dfe3ea'
        ctx.fillRect(0, top, gridX, h)
        // 白键之间的缝
        ctx.fillStyle = 'rgba(0,0,0,0.22)'
        ctx.fillRect(0, top + h - 1, gridX, 1)
      }
      if (!black && p % 12 === 0 && v.rowH >= 10) {
        ctx.fillStyle = '#5b6270'
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'
        ctx.textBaseline = 'middle'
        ctx.fillText(`C${Math.floor(p / 12) - 1}`, 3, y + v.rowH / 2)
      }
      ctx.globalAlpha = 1
    }

    // --- 顶栏 (小节标尺) ---
    ctx.fillStyle = '#12141a'
    ctx.fillRect(0, 0, W, v.rulerH)
    ctx.strokeStyle = '#2a2c35'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, v.rulerH - 0.5)
    ctx.lineTo(W, v.rulerH - 0.5)
    ctx.stroke()
  }, [])

  // 状态变了就重画
  useEffect(() => {
    if (!open) return
    draw()
  }, [open, notes, removed, selected, view, draw])

  // 画布尺寸变了要重画 (窗口缩放)
  useEffect(() => {
    if (!open) return
    const cvs = canvasRef.current
    if (!cvs) return
    // jsdom / 老浏览器没有 ResizeObserver —— 直接跳过 (重画靠状态变化那条 effect)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => draw())
    ro.observe(cvs)
    return () => ro.disconnect()
  }, [open, draw])

  /* ---------------- 播放 ---------------- */
  const stopPlay = useCallback(() => {
    synth.stopAll()
    setPlaying(false)
    playheadRef.current = null
    draw()
  }, [synth, draw])

  const startPlay = useCallback((fromTime: number) => {
    const ctx = synth.getCtx()
    synth.resume()
    const all = notesRef.current
    const idxs = liveIdxRef.current.slice()
    idxs.sort((a, b) => all[a].time - all[b].time)
    sortedRef.current = idxs
    nextRef.current = 0
    playFromRef.current = Math.max(0, fromTime)
    audioStartRef.current = ctx.currentTime + 0.08
    setPlaying(true)
  }, [synth])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const ctx = synth.getCtx()
      const elapsed = ctx.currentTime - audioStartRef.current
      const songNow = playFromRef.current + Math.max(0, elapsed)
      const all = notesRef.current
      const sorted = sortedRef.current
      const LOOKAHEAD = 0.3
      while (nextRef.current < sorted.length) {
        const i = sorted[nextRef.current]
        const n = all[i]
        if (!n) { nextRef.current++; continue }
        if (n.time > songNow + LOOKAHEAD) break
        if (n.time >= playFromRef.current - 1e-6) {
          const when = audioStartRef.current + (n.time - playFromRef.current)
          synth.playNote(n, 0, i, when)
        }
        nextRef.current++
      }
      playheadRef.current = songNow
      draw()
      const last = sorted.length ? all[sorted[sorted.length - 1]] : null
      const end = last ? last.time + last.duration : 0
      if (songNow > end + 0.4) {
        stopPlay()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, synth, draw, stopPlay])

  useEffect(() => {
    if (!open) stopPlay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 试听一个音高 (点左侧琴键 / 点「试听」按钮) */
  const audition = useCallback((midi: number, dur = 0.6) => {
    const n: SongNote = {
      midiNote: Math.max(0, Math.min(127, midi)),
      time: 0,
      duration: dur,
      track: 0,
      velocity: 0.8,
    }
    synth.playNote(n, 0, 9999)
  }, [synth])

  /**
   * 灯带: 只亮这一个音.
   *
   * ★ show() 必须跟着调 —— 树莓派 (WS) 的 set_many 只写缓冲区, 不 show
   *   就刷不到物理灯带上 (表现: 点了完全没反应). ESP32 那边 set_many 自己
   *   会 show, show() 在那边是空操作.
   */
  const lightOnly = useCallback((midi: number, hand?: 'left' | 'right') => {
    const led = ledRef?.current
    if (!led) return
    const prev = litNoteRef.current
    try {
      if (prev && prev.midi !== midi) led.noteOff(prev.midi, prev.hand)
      litNoteRef.current = { midi, hand }
      led.noteOn(midi, hand)
      led.show?.()
    } catch {}
  }, [ledRef])

  // 编辑器关掉 (或卸载) 时把定位灯灭掉 —— 别留着一直亮.
  useEffect(() => {
    return () => {
      const led = ledRef?.current
      const prev = litNoteRef.current
      litNoteRef.current = null
      if (!led || !prev) return
      try {
        led.noteOff(prev.midi, prev.hand)
        led.show?.()
      } catch {}
    }
  }, [open, ledRef])

  /**
   * 点一个音符 → 发一声 + 灯带亮这个音.
   *
   * 走了 MIDI 输出 (电钢) 就发到电钢上, 没连就走浏览器合成器 ——
   * 和 app 播放时的路由逻辑一致 (不会两处同时响).
   * 灯带直接控制 (不走事件总线): 点一下就该看到对应的键亮, 否则
   * 没法确认「点的这个音」到底是哪个键.
   */
  const previewNote = useCallback((n: SongNote) => {
    const dur = Math.max(0.25, Math.min(1.5, n.duration || 0.4))
    const note: SongNote = { ...n, duration: dur }
    const hand = n.hand
    // 灯带: 亮到用户点下一个音为止 (定位用)
    lightOnly(note.midiNote, hand)
    const out = midiOutRef.current
    if (out?.isEnabled()) {
      try {
        out.sendNoteOn(note)
        window.setTimeout(() => {
          try { out.sendNoteOff(note) } catch {}
        }, dur * 1000 + 120)
      } catch {
        synth.playNote(note, 0, 9999)
      }
      return
    }
    synth.playNote(note, 0, 9999)
  }, [synth, lightOnly])

  /* ---------------- 鼠标交互 ---------------- */
  const canvasPos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const cvs = canvasRef.current
    if (!cvs) return { x: 0, y: 0 }
    const rect = cvs.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const { x, y } = canvasPos(e)
    const v = viewRef.current
    if (x < v.keysW) {
      // 琴键条 → 试听
      const p = v.topPitch - Math.floor((y - v.rulerH + v.scrollTop) / v.rowH)
      audition(p)
      return
    }
    const hit = hitTestRoll(liveNotesRef.current, v, x, y)
    const snapshot = takeSnapshot()
    if (hit) {
      const orig = liveIdxRef.current[hit.index]
      const n = notesRef.current[orig]
      setSelected(orig)
      selectedRef.current = orig
      // 点哪个音就响哪个音 —— 联动电钢 (没连 MIDI 输出就走浏览器合成器)
      if (n) previewNote(n)
      dragRef.current = {
        kind: hit.mode,
        index: hit.index,
        startX: x,
        startY: y,
        origTime: n.time,
        origDur: n.duration,
        origPitch: n.midiNote,
        viewStart0: v.viewStart,
        scrollTop0: v.scrollTop,
        snapshot,
      }
    } else {
      dragRef.current = {
        kind: 'pan',
        index: -1,
        startX: x,
        startY: y,
        origTime: 0,
        origDur: 0,
        origPitch: 0,
        viewStart0: v.viewStart,
        scrollTop0: v.scrollTop,
        snapshot,
      }
    }
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) return
    const { x, y } = canvasPos(e)
    const v = viewRef.current
    if (d.kind === 'pan') {
      setView((prev) => ({
        ...prev,
        viewStart: d.viewStart0 - (x - d.startX) / prev.zoom,
        scrollTop: Math.max(0, d.scrollTop0 - (y - d.startY)),
      }))
      return
    }
    const orig = liveIdxRef.current[d.index]
    if (orig == null) return
    if (d.kind === 'move') {
      const dt = (x - d.startX) / v.zoom
      const dp = Math.round((y - d.startY) / v.rowH)
      setNotes((prev) => {
        if (orig < 0 || orig >= prev.length) return prev
        const next = prev.slice()
        next[orig] = {
          ...next[orig],
          time: Math.max(0, d.origTime + dt),
          midiNote: Math.max(0, Math.min(127, d.origPitch + dp)),
        }
        return next
      })
    } else {
      const dt = (x - d.startX) / v.zoom
      setNotes((prev) => {
        if (orig < 0 || orig >= prev.length) return prev
        const next = prev.slice()
        next[orig] = {
          ...next[orig],
          duration: Math.max(0.05, d.origDur + dt),
        }
        return next
      })
    }
  }

  const onMouseUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.kind === 'pan') return
    pushUndo(d.snapshot)
  }

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const { x, y } = canvasPos(e)
    const hit = hitTestRoll(liveNotesRef.current, viewRef.current, x, y)
    if (!hit) {
      setInspect(null)
      return
    }
    const orig = liveIdxRef.current[hit.index]
    const note = notesRef.current[orig]
    if (!note) return
    const s = songRef.current
    const loc = s ? locateNote(s, note) : { measure: 1, beat: 1 }
    setInspect({
      hit: { index: orig, note, measure: loc.measure, beat: loc.beat },
      pos: { x: e.clientX, y: e.clientY },
    })
  }

  // 滚轮: 上下滚音高, Shift+滚轮横向平移
  useEffect(() => {
    if (!open) return
    const cvs = canvasRef.current
    if (!cvs) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.shiftKey) {
        setView((prev) => ({ ...prev, viewStart: prev.viewStart + e.deltaY / prev.zoom }))
      } else {
        setView((prev) => ({
          ...prev,
          scrollTop: Math.max(0, prev.scrollTop + e.deltaY * 0.6),
        }))
      }
    }
    cvs.addEventListener('wheel', onWheel, { passive: false })
    return () => cvs.removeEventListener('wheel', onWheel)
  }, [open])

  /* ---------------- 键盘 ---------------- */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      if (mod) return
      const cur = selectedRef.current
      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (playing) stopPlay()
          else startPlay(cur != null ? notesRef.current[cur]?.time ?? 0 : 0)
          return
        case 'Delete':
        case 'Backspace':
          if (cur == null) return
          e.preventDefault()
          deleteNote(cur)
          return
        case 'ArrowUp':
        case 'ArrowDown': {
          if (cur == null) return
          e.preventDefault()
          const n = notesRef.current[cur]
          const step = e.shiftKey ? 12 : 1
          const delta = e.key === 'ArrowUp' ? step : -step
          const midiNote = Math.max(0, Math.min(127, n.midiNote + delta))
          updateNote(cur, { midiNote })
          // 挪完立刻响一声 + 灯带跟到新的键 —— 边挪边听边找位置
          previewNote({ ...n, midiNote })
          return
        }
        case 'ArrowLeft':
        case 'ArrowRight': {
          if (cur == null) return
          e.preventDefault()
          const n = notesRef.current[cur]
          const stepSize = e.shiftKey ? gridStep * 4 : gridStep
          const delta = e.key === 'ArrowRight' ? stepSize : -stepSize
          const time = Math.max(0, n.time + delta)
          updateNote(cur, { time })
          // 横向挪 → 音高没变, 但要响一声 (灯带还亮在同一个键上)
          previewNote({ ...n, time })
          return
        }
        default:
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, playing, startPlay, stopPlay, undo, redo, deleteNote, updateNote, gridStep, previewNote])

  /* ---------------- 复制 / 导出 ---------------- */
  const doCopy = useCallback(async (text: string, key: string) => {
    if (!(await copyText(text))) return
    setCopied(key)
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current)
    copiedTimer.current = window.setTimeout(() => setCopied(null), 1200)
  }, [])

  const download = useCallback((data: BlobPart | Uint8Array, filename: string, mime: string) => {
    const blob = new Blob([data as unknown as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [])

  /** 文件名安全化 */
  const safeName = useCallback((ext: string) => {
    const raw = (songRef.current?.title ?? 'score').replace(/[\\/:*?"<>|]/g, '_').trim()
    return `${raw || 'score'}.${ext}`
  }, [])

  const exportMidi = useCallback(() => {
    const s = songRef.current
    if (!s) return
    const list = liveNotesRef.current.slice().sort((a, b) => a.time - b.time)
    try {
      const bytes = buildMidi({ ...s, notes: list }, list)
      download(bytes, safeName('mid'), 'audio/midi')
      flash(`已导出 ${safeName('mid')} (${list.length} 个音符)`)
    } catch (e) {
      flash('导出 MIDI 失败: ' + (e as Error).message)
    }
  }, [download, safeName, flash])

  const exportMxl = useCallback(() => {
    const s = songRef.current
    if (!s) return
    const list = liveNotesRef.current.slice().sort((a, b) => a.time - b.time)
    try {
      const bytes = buildMxl({ ...s, notes: list }, list)
      download(bytes, safeName('mxl'), 'application/vnd.recordare.musicxml')
      flash(`已导出 ${safeName('mxl')} (${list.length} 个音符)`)
    } catch (e) {
      flash('导出 MXL 失败: ' + (e as Error).message)
    }
  }, [download, safeName, flash])

  /* ---------------- 保存到乐库 ---------------- */

  /**
   * 当前编辑后的内容打包成「能上传的文件」.
   *
   * source 必须跟着**实际导出的格式**走 —— 不然服务端会把导出的 MIDI
   * 按 MusicXML 记 (tracks='mxl'), 左右手判定就废了.
   */
  const buildSavePayload = useCallback(
    (format: 'mid' | 'mxl') => {
      const s = songRef.current
      if (!s) return null
      const list = liveNotesRef.current.slice().sort((a, b) => a.time - b.time)
      const song: Song = { ...s, notes: list, source: format === 'mxl' ? 'xml' : 'midi' }
      const bytes = format === 'mxl' ? buildMxl(song, list) : buildMidi(song, list)
      return { song, bytes, filename: safeName(format) }
    },
    [safeName],
  )

  /** 存到「我的谱子」 —— 自己的私有谱库 (谁都能存). */
  const saveToMine = useCallback(async () => {
    if (!user) {
      openAuthModal('login')
      flash('先登录才能保存')
      return
    }
    try {
      const p = buildSavePayload('mid')
      if (!p) return
      const file = new File([p.bytes as unknown as BlobPart], p.filename, { type: 'audio/midi' })
      await uploadMyScore(file, p.song)
      // 乐库面板重新拉列表 —— 存完立刻能在「我的谱子」里看到
      useStore.getState().bumpLibrary()
      flash(`已存到「我的谱子」 (${p.filename})`)
    } catch (e) {
      flash('保存失败: ' + (e as Error).message)
    }
  }, [user, buildSavePayload, flash])

  /** 存到公共乐库 —— 只有管理员能存 (服务端也会再校验一次). */
  const saveToPublic = useCallback(async () => {
    if (!user?.isAdmin) {
      flash('只有管理员能存到公共乐库')
      return
    }
    try {
      const p = buildSavePayload('mid')
      if (!p) return
      const file = new File([p.bytes as unknown as BlobPart], p.filename, { type: 'audio/midi' })
      const src = useStore.getState().librarySource
      // 当前曲目本来就来自公共乐库 → 覆盖那一条, 而不是多出一份重复的
      const opts = src?.scope === 'public' ? { itemId: src.id, groupId: src.groupId } : undefined
      const item = await saveToPublicLibrary(file, p.song, opts)
      // 存完把出处换成刚存的那条 —— 之后再存就是覆盖它, 不会又多一条
      useStore.getState().setLibrarySource({
        id: item.id,
        groupId: item.groupId ?? opts?.groupId ?? 'admin',
        scope: 'public',
        file: item.file,
        title: item.title,
      })
      // 乐库面板重新拉列表 (并展开刚存的那条所在的分组)
      useStore.getState().bumpLibrary(item.id)
      // 覆盖还是新建 —— 说清楚, 否则用户以为存了, 刷新一看还是老的
      flash(
        opts?.itemId
          ? `已覆盖公共乐库里的《${item.title}》`
          : `已在公共乐库新建《${item.title}》`,
      )
    } catch (e) {
      flash('保存失败: ' + (e as Error).message)
    }
  }, [user, buildSavePayload, flash])

  const applyToSong = useCallback(() => {
    const list = liveNotesRef.current
      .slice()
      .sort((a, b) => a.time - b.time || a.midiNote - b.midiNote)
    appliedRef.current = true
    onApply(list)
    // 应用后工作副本跟着新曲目走 —— 编号以新曲目为准
    setNotes(list.map((n) => ({ ...n })))
    setRemoved(new Set())
    setSelected(null)
    flash('已应用到当前曲目 (' + list.length + ' 个音符)')
  }, [onApply, flash])

  /* ---------------- 渲染 ---------------- */
  if (!open) return null

  const zoomPct = Math.round((view.zoom / 110) * 100)

  return (
    <div
      className="fixed inset-0 z-[70] bg-bg flex flex-col anim-fade-in"
      role="dialog"
      aria-label="谱子编辑器"
    >
      {/* 顶栏 —— 按钮多, 窄屏会挤出去 → 允许横向滚动 (不然「存公共」会被挤出屏幕点不到) */}
      <div className="h-11 shrink-0 border-b border-border bg-panel/70 flex items-center gap-2 px-3 overflow-x-auto">
        <span className="text-accent grid place-items-center" aria-hidden>
          <IconGrid size={15} />
        </span>
        <span className="text-sm font-semibold text-text shrink-0">谱子编辑器</span>
        <span className="text-xs text-muted truncate max-w-[200px] hidden md:block" title={song?.title}>
          {song?.title ?? '未选择曲目'}
        </span>
        <span className="w-px h-5 bg-border mx-1" />

        <TBtn onClick={() => (playing ? stopPlay() : startPlay(0))} title="播放 / 停止 (空格)">
          {playing ? <IconPause size={13} /> : <IconPlay size={13} />}
          <span>{playing ? '停止' : '播放'}</span>
        </TBtn>
        <TBtn
          onClick={() => {
            const cur = selectedRef.current
            startPlay(cur != null ? notesRef.current[cur]?.time ?? 0 : 0)
          }}
          title="从选中的音符开始播"
          disabled={selected == null}
        >
          <IconSoundWave size={13} />
          <span>从这里</span>
        </TBtn>
        <TBtn onClick={undo} title="撤销 (Ctrl+Z)" disabled={undoDepth === 0}>
          <IconUndo size={13} />
        </TBtn>
        <TBtn onClick={redo} title="重做 (Ctrl+Shift+Z)" disabled={redoDepth === 0}>
          <IconRedo size={13} />
        </TBtn>

        <div className="flex-1" />

        <span className="text-[11px] text-muted hidden lg:block">缩放</span>
        <TBtn
          onClick={() => setView((v) => ({ ...v, zoom: Math.max(20, v.zoom / 1.25) }))}
          title="缩小"
        >
          <IconMinus size={13} />
        </TBtn>
        <span className="text-[11px] text-muted w-9 text-center tabular-nums">{zoomPct}%</span>
        <TBtn
          onClick={() => setView((v) => ({ ...v, zoom: Math.min(600, v.zoom * 1.25) }))}
          title="放大"
        >
          <IconPlus size={13} />
        </TBtn>

        <span className="w-px h-5 bg-border mx-1" />
        <TBtn onClick={exportMidi} title="导出 MIDI 文件" disabled={!song}>
          <IconDownload2 size={13} />
          <span className="hidden sm:inline">MIDI</span>
        </TBtn>
        <TBtn onClick={exportMxl} title="导出 MXL (压缩 MusicXML) 文件" disabled={!song}>
          <IconDownload2 size={13} />
          <span className="hidden sm:inline">MXL</span>
        </TBtn>
        <TBtn onClick={saveToMine} title="存到「我的谱子」 (自己的私有谱库)" disabled={!song}>
          <IconSave size={13} />
          <span className="hidden sm:inline">存我的</span>
        </TBtn>
        {user?.isAdmin && (
          <TBtn
            onClick={saveToPublic}
            title="存到公共乐库 (所有人可见 —— 覆盖当前这首)"
            disabled={!song}
            tone="primary"
          >
            <IconUpload size={13} />
            <span className="hidden sm:inline">存公共</span>
          </TBtn>
        )}
        <TBtn onClick={applyToSong} title="把改动写回当前曲目" disabled={!song} tone="primary">
          <IconSave size={13} />
          <span>应用到当前曲目</span>
        </TBtn>
        <button
          onClick={onClose}
          className="size-7 grid place-items-center rounded-lg text-muted hover:text-text hover:bg-raised transition-colors"
          title="关闭 (Esc)"
          aria-label="关闭谱子编辑器"
        >
          <IconClose size={14} />
        </button>
      </div>

      {/* 主体 */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 relative bg-bg">
          {song && notes.length > 0 ? (
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full cursor-crosshair"
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
              onContextMenu={onContextMenu}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted">
              {song ? '这首曲子还没有音符' : '先在乐库里选一首曲子'}
            </div>
          )}
          {toast && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-4 px-3 py-1.5 rounded-lg bg-panel border border-border text-xs text-text shadow-lg anim-fade-in">
              {toast}
            </div>
          )}
        </div>

        {/* 右侧属性面板 */}
        <aside className="w-60 shrink-0 border-l border-border bg-panel/50 overflow-y-auto">
          <div className="p-3 flex flex-col gap-3">
            <PanelTitle icon={<IconGrid size={13} />}>选中音符</PanelTitle>
            {selNote && selected != null ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">唯一编码</span>
                  <button
                    onClick={() => doCopy(String(selected), 'idx')}
                    title="点击复制编码"
                    className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-raised border border-border hover:border-accent/50 transition-colors cursor-pointer"
                  >
                    <span className="font-mono text-base font-bold text-accent tabular-nums">
                      {selected}
                    </span>
                    {copied === 'idx' && <IconCheck size={12} className="text-hit" />}
                  </button>
                </div>
                <div className="text-[11px] text-muted leading-relaxed">
                  这个编号和下落色块右键看到的是同一个 —— 跟对方说「第 {selected} 号音符」就能对上.
                </div>
                <NumField
                  label="音高"
                  value={selNote.midiNote}
                  min={0}
                  max={127}
                  onChange={(v) => updateNote(selected, { midiNote: Math.round(v) })}
                  title="MIDI 音高 (C4 = 60)"
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted w-14 shrink-0">音名</span>
                  <span className="text-sm font-mono text-text">{midiToName(selNote.midiNote)}</span>
                  <span className="flex-1" />
                  <MiniBtn
                    onClick={() => updateNote(selected, { midiNote: Math.max(0, selNote.midiNote - 1) })}
                    title="降半音"
                  >
                    <IconMinus size={12} />
                  </MiniBtn>
                  <MiniBtn
                    onClick={() => updateNote(selected, { midiNote: Math.min(127, selNote.midiNote + 1) })}
                    title="升半音"
                  >
                    <IconPlus size={12} />
                  </MiniBtn>
                </div>
                <NumField
                  label="起始"
                  value={Number(selNote.time.toFixed(3))}
                  step={0.05}
                  min={0}
                  suffix="秒"
                  onChange={(v) => updateNote(selected, { time: Math.max(0, v) })}
                />
                <NumField
                  label="时值"
                  value={Number(selNote.duration.toFixed(3))}
                  step={0.05}
                  min={0.05}
                  suffix="秒"
                  onChange={(v) => updateNote(selected, { duration: Math.max(0.05, v) })}
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted w-14 shrink-0">手别</span>
                  <HandBtn on={selNote.hand === 'left'} onClick={() => updateNote(selected, { hand: 'left' })}>
                    左手
                  </HandBtn>
                  <HandBtn on={selNote.hand === 'right'} onClick={() => updateNote(selected, { hand: 'right' })}>
                    右手
                  </HandBtn>
                  <HandBtn on={!selNote.hand} onClick={() => updateNote(selected, { hand: undefined })}>
                    未定
                  </HandBtn>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => audition(selNote.midiNote, Math.max(0.4, selNote.duration))}
                    className="h-7 flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-raised border border-border text-xs text-text hover:border-accent/50 transition-colors cursor-pointer"
                  >
                    <IconSoundWave size={13} />
                    试听
                  </button>
                  <button
                    onClick={() => deleteNote(selected)}
                    className="h-7 inline-flex items-center justify-center gap-1.5 rounded-lg bg-raised border border-border text-xs text-miss hover:border-miss/50 transition-colors cursor-pointer px-2.5"
                    title="删除这个音符 (Delete)"
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted leading-relaxed">
                点左边卷帘里的音符来编辑.
                <br />
                拖动 = 改音高和时间, 拖右边缘 = 改时值.
              </p>
            )}

            <div className="border-t border-border/60 pt-3 flex flex-col gap-2">
              <PanelTitle icon={<IconPlus size={13} />}>操作</PanelTitle>
              <button
                onClick={addNote}
                disabled={!song}
                className="h-7 inline-flex items-center justify-center gap-1.5 rounded-lg bg-raised border border-border text-xs text-text hover:border-accent/50 transition-colors cursor-pointer disabled:opacity-40"
              >
                <IconPlus size={13} />
                添加音符
              </button>
              <div className="text-[11px] text-muted leading-relaxed">
                音符总数 <span className="text-text font-mono tabular-nums">{liveNotes.length}</span>
                {removed.size > 0 && (
                  <>
                    {' · 已删 '}
                    <span className="text-miss font-mono tabular-nums">{removed.size}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* 底栏提示 */}
      <div className="h-7 shrink-0 border-t border-border bg-panel/60 flex items-center gap-3 px-3 text-[11px] text-muted overflow-x-auto">
        <span>空格 播放</span>
        <span>↑↓ 改音高</span>
        <span>←→ 挪时间</span>
        <span>Delete 删除</span>
        <span>Ctrl+Z 撤销</span>
        <span>右键音符看编码</span>
        <span className="flex-1" />
        <span>编号 = 音符在曲目里的序号, 全程唯一</span>
      </div>

      {/* 右键 → 唯一编码 (跟下落色块同一个浮层) */}
      <NoteInspector
        hit={inspect?.hit ?? null}
        pos={inspect?.pos ?? null}
        onClose={() => setInspect(null)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 小控件
 * ------------------------------------------------------------------ */

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  ctx.lineTo(x + rr, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
  ctx.lineTo(x, y + rr)
  ctx.quadraticCurveTo(x, y, x + rr, y)
  ctx.closePath()
}

function TBtn({
  onClick,
  children,
  title,
  disabled,
  tone = 'default',
}: {
  onClick: () => void
  children: React.ReactNode
  title?: string
  disabled?: boolean
  tone?: 'default' | 'primary'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cx(
        'h-7 px-2 inline-flex items-center gap-1.5 rounded-lg text-xs border transition-colors shrink-0',
        tone === 'primary'
          ? 'bg-accent/15 text-accent border-accent/40 hover:bg-accent/25'
          : 'bg-raised/60 text-muted border-border hover:text-text hover:border-borderStrong',
        disabled && 'opacity-40 pointer-events-none',
      )}
    >
      {children}
    </button>
  )
}

function MiniBtn({
  onClick,
  children,
  title,
}: {
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="size-6 grid place-items-center rounded-md bg-raised border border-border text-muted hover:text-text hover:border-borderStrong transition-colors cursor-pointer"
    >
      {children}
    </button>
  )
}

function HandBtn({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cx(
        'h-6 px-2 rounded-md text-[11px] border transition-colors cursor-pointer',
        on
          ? 'bg-accent/20 text-accent border-accent/40 font-semibold'
          : 'bg-raised/60 text-muted border-border hover:text-text',
      )}
    >
      {children}
    </button>
  )
}

function PanelTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-text">
      <span aria-hidden className="text-muted grid place-items-center">
        {icon}
      </span>
      {children}
    </div>
  )
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  title,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  title?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? String(value)
  const commit = () => {
    if (draft === null) return
    const raw = Number(draft)
    setDraft(null)
    if (!Number.isFinite(raw)) return
    let v = raw
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    if (v !== value) onChange(v)
  }
  return (
    <label className="flex items-center gap-2" title={title}>
      <span className="text-xs text-muted w-14 shrink-0">{label}</span>
      <input
        type="number"
        value={shown}
        step={step}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        className="h-7 min-w-0 flex-1 px-2 rounded-lg bg-raised border border-border text-xs text-text font-mono tabular-nums"
      />
      {suffix && <span className="text-[11px] text-muted w-6 shrink-0">{suffix}</span>}
    </label>
  )
}
