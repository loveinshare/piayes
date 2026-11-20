// 下落音符渲染 (v3 - 增强: 移调 / Loop 区间 / 未来音符标签)
// Canvas 2D + requestAnimationFrame, 走 useStore.getState() 同步读取 currentTime
// 避免触发 React 重渲染
//
// 增强项:
// - 圆角头部 + 拖尾渐变
// - 节拍器小圆点 (左侧 1/4 拍提示)
// - 键盘"即将到来"光晕 (note 0.4s 内到达时, 对应琴键淡黄色光晕)
// - 左右手分隔线 (Middle C 处)
// - 移调: 所有 note 在 x 方向偏移, 便于练习其他调
// - Loop 区间: 进度区间半透明叠加
// - 未来音符标签: 0.8s 内到达的活动手音符画 "C4" 等文字

import { useEffect, useRef } from 'react'
import { useStore, isActiveHand, type PracticeHand } from '../store'
import { resolveHand } from '../hand'
import type { SongNote, Song, KeyLabelMode, NoteHit, Hand } from '../types'
import {
  COLORS,
  MIDI_MIN,
  MIDI_MAX,
  isBlackKey,
  whiteKeyIndex,
  totalWhiteKeys,
  midiToName,
} from './colors'
import { labelForMidi, whiteKeyLabelSize, blackKeyLabelSize } from './keyLabels'
import type { InputBus } from '../input/InputBus'
import type { Synthesizer } from '../engine/Synthesizer'
import { renderTime } from './timeSource'
import {
  TempoMap,
  measureBeatPoints,
  hasVariableTimeSignature,
  type BeatPoint,
} from '../util/tempoMap'
import { locateNote } from '../editor/roll'

const PPS = 280 // pixels per second (基准下落速度)
/**
 * 命中线到画布底边的距离 (px).
 *
 * ★ 2026-10-30: 从 100 改成 110 —— 命中线现在**贴着琴键的上沿**
 *   (keyboardTop = H - KEYBOARD_HEIGHT = H - 110).
 *   以前命中线在琴键上沿**上方** 10px, 音符还悬在半空 (差一点点没落键)
 *   就已经算触发了 —— 跟用户说的「需要等音符落到钢琴键的上沿时才触发」不符.
 *   现在 dt = 0 时音符底边正好落在琴键上沿, 判定 = 画面所见.
 */
const HIT_LINE_OFFSET = 110
const KEYBOARD_HEIGHT = 110
/**
 * 命中线上方至少留多少秒的**预读** —— 音符从出现在画布顶端到落键的时间.
 *
 * ★ 2026-11-10: 以前 PPS 是死的 (280), 于是「能看到多远」完全由窗口高度决定:
 *   同样的 280px/s, 画布高 600 时上面只装得下 (600-110)/280 ≈ 1.75s,
 *   画布高 900 时能装 2.8s —— 同一首曲子在矮窗口上明显更难 (来不及看).
 *   矮画布上把下落速度调慢, 预读时间就稳住了.
 */
const MIN_HORIZON = 2.2

/**
 * 画布高度 -> 实际用的下落速度 (px/s).
 * 画布够高 (usable / MIN_HORIZON ≥ PPS) 就用基准速度, 一根汗毛都不动;
 * 矮下来才按比例放慢 —— 宁可音符掉得慢一点, 也不能让人来不及读谱.
 */
export function ppsFor(H: number): number {
  const usable = Math.max(80, H - KEYBOARD_HEIGHT)
  return Math.min(PPS, usable / MIN_HORIZON)
}
const APPROACH_WINDOW = 0.4
const LABEL_WINDOW = 0.8 // 距命中线 < 0.8s 的活动手音符画标签
const METRO_LEFT_PAD = 14

export type PlayerRef = {
  getPressedNotes: () => Set<number>
  getPlayingNotes: () => Set<SongNote>
  isFrozen: () => boolean
  getWaitTarget: () => SongNote | null
  /**
   * 播放器的**连续**歌曲时间 (秒) —— 不经 store.
   * store 的 currentTime 被 emitTick 限流到 10Hz, 直接读它会让下落音符
   * 每 100ms 跳 28px (PPS=280) —— 肉眼可见的台阶感. 见 spec P1-1.
   */
  getCurrentTime?: () => number
  /** per-note 评分状态, 键 = noteIndex (song.notes 数组下标), 解决重复 midi 互相覆盖.
   *  value: 'hit' = 已成功弹, 'miss' = 已过 good window 算漏, 'late' = 当前还在 good window */
  getNoteStates?: () => Map<number, 'hit' | 'miss' | 'late'>
}

interface Props {
  playerRef: React.MutableRefObject<PlayerRef | null>
  bus: InputBus
  synth: Synthesizer
  /**
   * 右键点中了一个音符 —— 抛给上层弹检视浮层.
   * pos 是**视口坐标** (clientX / clientY), 上层用 fixed 定位.
   */
  onNoteRightClick?: (hit: NoteHit, pos: { x: number; y: number }) => void
}

export function FallingNotes({ playerRef, bus, synth, onNoteRightClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 画布尺寸 —— 右键命中测试要用 (在 effect 里维护, 事件回调里读)
  const viewRef = useRef({ W: 0, H: 0, whiteKeyW: 0 })
  // 当前按下的 midi (用于 drag 时切换音)
  const activeMidiRef = useRef<number | null>(null)

  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs) return

    const dpr = window.devicePixelRatio || 1
    const rect = cvs.getBoundingClientRect()
    cvs.width = rect.width * dpr
    cvs.height = rect.height * dpr

    const ctx = cvs.getContext('2d')!
    ctx.scale(dpr, dpr)

    // Mutable view state. Both initial mount and resize() update these; draw() reads
    // fresh values every frame. Keeping W/H here (instead of const captures) fixes
    // a stale-pixel bug: when the canvas grew (PracticeBar wrap-to-multiple-rows,
    // fullscreen toggle, devtools dock, browser zoom, dpr change), the previous
    // code only updated whiteKeyW and cvs.width/height, while drawFrame still
    // cleared and drew into the original W x H bounding box. Pixels outside that
    // box kept whatever was drawn in the previous frame, which looked like "notes
    // piled up and frozen in place".
    const view = {
      W: rect.width,
      H: rect.height,
      whiteKeyW: rect.width / totalWhiteKeys(MIDI_MIN, MIDI_MAX),
    }
    viewRef.current = { ...view }

    let raf = 0
    const draw = () => {
      const state = useStore.getState()
      // 时间源: 优先用播放器的连续时间 (spec P1-1).
      // store.currentTime 被 emitTick 限流到 10Hz, 拿它渲染会让音符每 100ms 跳 28px.
      const t = renderTime(playerRef.current, state.currentTime)
      const song = state.song
      const practiceHand = state.hand
      const waitOn = state.wait
      const transpose = state.transpose
      const loopRange = state.loopRange
      const keyLabels = state.keyLabels
      const pressed = playerRef.current?.getPressedNotes() ?? new Set<number>()
      // 「现在该弹哪个」的提示 —— 抢先模式 (单手) **不冻结**, 但那个音照样要
      // 提示 (琴键上的琥珀色高亮): 谱面不跟玩家走之后, 这是唯一的位置提示.
      const waitTarget = waitOn ? playerRef.current?.getWaitTarget?.() ?? null : null
      // 真实评分状态 (noteIndex 键). 替代之前 dt<0 启发式 — 后者在 Wait 冻结时
      // 会把已过期未弹的 note 也染绿, 给用户错误反馈.
      const noteStates = playerRef.current?.getNoteStates?.() ?? new Map<number, 'hit' | 'miss' | 'late'>()

      drawFrame(
        ctx, view.W, view.H, view.whiteKeyW, song, t, practiceHand,
        pressed, waitTarget, transpose, loopRange,
        noteStates, keyLabels,
      )
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    // Bug #5 fix: re-sync canvas size to actual rendered size + DPR on window resize,
    // fullscreen toggle, or devicePixelRatio change (HiDPI zoom). Without this the
    // canvas stays at the initial 1x size and becomes blurry on HiDPI / resize.
    const resize = () => {
      const r = cvs.getBoundingClientRect()
      const dpr2 = window.devicePixelRatio || 1
      cvs.width = r.width * dpr2
      cvs.height = r.height * dpr2
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.scale(dpr2, dpr2)
      // Keep W/H/whiteKeyW in lockstep with the actual canvas rect so draw()
      // clears the full new area and uses the right scaling on the next frame.
      view.W = r.width
      view.H = r.height
      view.whiteKeyW = r.width / totalWhiteKeys(MIDI_MIN, MIDI_MAX)
      viewRef.current = { ...view }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(cvs)

    // Re-sync when zoom changes the devicePixelRatio even if the canvas DOM size does not
    // change. (resolution: Xdppx) fires whenever dpr crosses an integer value.
    const dprMql = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    const onDprChange = () => resize()
    if (dprMql.addEventListener) {
      dprMql.addEventListener('change', onDprChange)
    } else if (typeof dprMql.addListener === 'function') {
      dprMql.addListener(onDprChange)
    }

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      if (dprMql.removeEventListener) {
        dprMql.removeEventListener('change', onDprChange)
      } else if (typeof dprMql.removeListener === 'function') {
        dprMql.removeListener(onDprChange)
      }
    }
  }, [playerRef])

  // canvas 坐标 → midi (返回 null 表示没击中琴键)
  const findMidi = (clientX: number, clientY: number): number | null => {
    const cvs = canvasRef.current
    if (!cvs) return null
    const rect = cvs.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const W = rect.width
    const H = rect.height
    const keyboardTop = H - KEYBOARD_HEIGHT
    if (y < keyboardTop || y > H || x < 0 || x > W) return null
    const whiteKeyW = W / totalWhiteKeys(MIDI_MIN, MIDI_MAX)
    const blackKeyH = KEYBOARD_HEIGHT * 0.62

    // 黑键高度区域内优先黑键 (黑键会覆盖在白键上)
    if (y < keyboardTop + blackKeyH) {
      for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
        if (!isBlackKey(midi)) continue
        const prevWhite = whiteKeyIndex(midi - 1)
        const w = whiteKeyW * 0.6
        const kx = (prevWhite + 1) * whiteKeyW - w / 2
        if (x >= kx && x <= kx + w) return midi
      }
    }
    // 白键
    const targetIndex = Math.floor(x / whiteKeyW)
    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      if (isBlackKey(midi)) continue
      if (whiteKeyIndex(midi) === targetIndex) return midi
    }
    return null
  }

  // 直接调 synth 出声 (不走 loop, 因为 loop 只发曲谱, 不响应用户输入)
  const playDirect = (midi: number) => {
    synth.resume()
    const fake: SongNote = {
      midiNote: midi,
      duration: 0.5, // 短一点, 0.5s 内 stopNote 截断
      velocity: 0.7,
      time: 0,
      track: 0,
    }
    synth.playNote(fake, 0)
  }
  const stopDirect = (midi: number) => {
    synth.stopNote(midi)
  }

  // 统一 down 处理: 切音时先 up 旧的再 down 新的
  const press = (midi: number) => {
    if (activeMidiRef.current === midi) return
    if (activeMidiRef.current !== null) {
      const old = activeMidiRef.current
      stopDirect(old)
      bus.emit({ type: 'up', midi: old, t: performance.now(), source: 'input' })
    }
    playDirect(midi)
    bus.emit({ type: 'down', midi, velocity: 80, t: performance.now(), source: 'input' })
    activeMidiRef.current = midi
  }
  const release = () => {
    const m = activeMidiRef.current
    if (m === null) return
    stopDirect(m)
    bus.emit({ type: 'up', midi: m, t: performance.now(), source: 'input' })
    activeMidiRef.current = null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const midi = findMidi(e.clientX, e.clientY)
    if (midi === null) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    press(midi)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeMidiRef.current === null) return
    const midi = findMidi(e.clientX, e.clientY)
    if (midi !== null && midi !== activeMidiRef.current) press(midi)
  }
  const onPointerUp = () => release()
  const onPointerCancel = () => release()

  // 右键 → 找出鼠标下的音符, 交给上层弹检视浮层 (显示唯一编码, 点一下复制)
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    if (!onNoteRightClick) return
    const cvs = canvasRef.current
    if (!cvs) return
    const rect = cvs.getBoundingClientRect()
    const { W, H, whiteKeyW } = viewRef.current
    if (W <= 0 || H <= 0) return
    const state = useStore.getState()
    const song = state.song
    if (!song) return
    const now = renderTime(playerRef.current, state.currentTime)
    const hitLineY = H - HIT_LINE_OFFSET
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const hit = hitTestNote(
      song,
      x,
      y,
      now,
      hitLineY,
      whiteKeyW,
      state.transpose,
      ppsFor(H),
    )
    if (!hit) return
    onNoteRightClick(
      { index: hit.index, note: hit.note, ...locateNote(song, hit.note) },
      { x: e.clientX, y: e.clientY },
    )
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full"
      style={{ background: COLORS.bg, touchAction: 'none', cursor: 'pointer' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerUp}
      onContextMenu={onContextMenu}
    />
  )
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  whiteKeyW: number,
  song: Song | null,
  t: number,
  practiceHand: PracticeHand,
  pressed: Set<number>,
  waitTarget: SongNote | null,
  transpose: number,
  loopRange: [number, number] | null,
  noteStates: Map<number, 'hit' | 'miss' | 'late'>,
  keyLabels: KeyLabelMode,
) {
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, H)

  const hitLineY = H - HIT_LINE_OFFSET
  const keyboardTop = H - KEYBOARD_HEIGHT
  // 下落速度跟着画布高度走 (矮画布 → 慢一点 → 预读时间不变). 见 ppsFor.
  const pps = ppsFor(H)
  // 命中线以上能看到的时长 (秒) —— 超出这个范围的音符在屏幕外, 直接跳过
  const horizon = (H - HIT_LINE_OFFSET) / pps

  if (!song) {
    ctx.fillStyle = COLORS.muted
    ctx.font = '16px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('加载 MIDI 或 MusicXML 文件开始', W / 2, H / 2)
    drawKeyboard(ctx, whiteKeyW, keyboardTop, pressed, 0, null)
    drawKeyLabels(ctx, whiteKeyW, keyboardTop, KEYBOARD_HEIGHT, keyLabels)
    return
  }

  // Loop 区间背景
  if (loopRange) {
    const yStart = hitLineY - (loopRange[0] - t) * pps
    const yEnd = hitLineY - (loopRange[1] - t) * pps
    const top = Math.min(yStart, yEnd)
    const bot = Math.max(yStart, yEnd)
    if (bot > 0 && top < hitLineY) {
      ctx.fillRect(METRO_LEFT_PAD + 6, Math.max(0, top), W - METRO_LEFT_PAD - 6, Math.min(hitLineY, bot) - Math.max(0, top))
    }
    // 边界线
    ctx.strokeStyle = COLORS.loopRangeLine
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 4])
    if (yStart > 0 && yStart < hitLineY) {
      ctx.beginPath()
      ctx.moveTo(METRO_LEFT_PAD + 6, yStart)
      ctx.lineTo(W, yStart)
      ctx.stroke()
    }
    if (yEnd > 0 && yEnd < hitLineY) {
      ctx.beginPath()
      ctx.moveTo(METRO_LEFT_PAD + 6, yEnd)
      ctx.lineTo(W, yEnd)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  drawMeasureLines(ctx, W, hitLineY, song, t, pps)
  drawMetronome(ctx, H, hitLineY, song, t, pps)
  drawHandDivider(ctx, hitLineY, whiteKeyW)

  // 命中线
  ctx.strokeStyle = COLORS.hitLine
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, hitLineY)
  ctx.lineTo(W, hitLineY)
  ctx.stroke()

  // 琴键即将到来光晕
  drawApproachGlow(
    ctx, whiteKeyW, keyboardTop, song, t, practiceHand,
    waitTarget, transpose,
  )

  // 八度色彩条 (中央 C4 红色 + 最高, 两端依次降低)
  drawOctaveBars(ctx, whiteKeyW, keyboardTop)

  // 琴键本体
  // 「等你弹」的键 (Wait 冻结时) 用琥珀色染出来 —— 用户 2026-10-30 要求
  // 「等你弹 xx 时需要在该键渲染一个颜色, 让我好找」.
  // 注意: 这个颜色必须画在**琴键之上**, 以前那个光晕画在琴键下面, 整个被盖住了.
  const waitKey = waitTarget ? waitTarget.midiNote + transpose : null
  drawKeyboard(ctx, whiteKeyW, keyboardTop, pressed, transpose, waitKey)

  // 琴键上的音名标号 (D3 之类) —— 画在琴键之上、音条之下
  drawKeyLabels(ctx, whiteKeyW, keyboardTop, KEYBOARD_HEIGHT, keyLabels)

  // 下落音符 —— **分两遍画**: 先画非优先手, 再画优先手 (练习的那只手).
  //
  // 为什么: 不练习的那只手画出来是半透明的 (alpha 0.4). 以前按时间顺序一笔画完,
  // 半透明的蓝色音条会盖在红色的旋律音条上 —— 两种颜色一混就成了紫色.
  // (BWV 1041 的小提琴音部显示成紫色就是这么来的: 蓝 (左手伴奏) 叠在红 (右手小提琴) 上.)
  // 优先手后画, 它的音条压在最上面, 颜色就是干净的.
  const priorityHand: Hand = practiceHand === 'left' ? 'left' : 'right'
  for (const pass of [0, 1]) {
    for (let noteIndexInSong = 0; noteIndexInSong < song.notes.length; noteIndexInSong++) {
      const n = song.notes[noteIndexInSong]
      const isPriority = resolveHand(n.hand, n.track, song.hands) === priorityHand
      if (isPriority !== (pass === 1)) continue
      const dt = n.time - t
      if (dt < -0.5 || dt > horizon + 0.2) continue
      const y = hitLineY - dt * pps
      const noteH = Math.max(4, n.duration * pps)
      const x = noteX(n.midiNote, whiteKeyW, transpose)
      const noteW = noteWidth(n.midiNote, whiteKeyW)
      drawNote(
        ctx, x, y, noteW, noteH, n, t, practiceHand, song, noteIndexInSong, noteStates,
      )
    }
  }

  // 未来音符标签
  drawUpcomingLabels(ctx, song, t, hitLineY, whiteKeyW, practiceHand, transpose, pps)

  // Wait 提示
  if (waitTarget) {
    drawWaitHint(ctx, W, waitTarget)
  }
}

function drawNote(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  n: SongNote, t: number, practiceHand: PracticeHand,
  song: Song,
  noteIndex: number,
  noteStates: Map<number, 'hit' | 'miss' | 'late'>,
) {
  const active = isActiveHand(n.hand, n.track, song.hands, practiceHand)
  const dt = n.time - t
  // 真实评分 (noteIndex-keyed). 替代之前 dt<0 启发式 — 后者在 Wait 冻结时把过期未弹的
  // note 也染绿, 给用户错误反馈. 现在: 只有 player 真正 mark hit 的才染绿.
  const scoreState = noteStates.get(noteIndex)
  const isHit = active && scoreState === 'hit'

  // 手色
  let color: string
  if (isHit) color = COLORS.hit
  else if (n.hand === 'left') color = COLORS.hand.left
  else if (n.hand === 'right') color = COLORS.hand.right
  else color = COLORS.hand.unknown

  let alpha: number
  if (isHit) alpha = 1
  else if (!active) alpha = 0.55
  else if (dt < 0) alpha = 0.8
  else alpha = 1

  // 拖尾渐变 —— 顶端别太透 (用户 2026-11-04: 「太透明了, 不太好看」).
  // 以前顶端只有 0.15, 整根音条上半截几乎是透明的, 看着发灰发淡.
  // 现在顶端 0.45 —— 还是有个拖尾, 但条身是实的.
  const grad = ctx.createLinearGradient(0, y - h, 0, y)
  grad.addColorStop(0, withAlpha(color, 0.45))
  grad.addColorStop(0.7, withAlpha(color, alpha * 0.95))
  grad.addColorStop(1, withAlpha(color, alpha))
  ctx.fillStyle = grad

  roundRect(ctx, x, y - h, w, h, 4)
  ctx.fill()

  // 底部高亮条
  ctx.fillStyle = withAlpha('#ffffff', isHit ? 0.6 : 0.3)
  roundRect(ctx, x, y - 4, w, 4, 2)
  ctx.fill()

  // 描边
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = 1
  roundRect(ctx, x + 0.5, y - h + 0.5, w - 1, h - 1, 4)
  ctx.stroke()
}

function drawUpcomingLabels(
  ctx: CanvasRenderingContext2D,
  song: Song,
  t: number,
  hitLineY: number,
  whiteKeyW: number,
  practiceHand: PracticeHand,
  transpose: number,
  pps: number,
) {
  // 找接下来的活动手 notes (in LABEL_WINDOW)
  ctx.save()
  ctx.font = '600 11px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const n of song.notes) {
    const dt = n.time - t
    if (dt < 0 || dt > LABEL_WINDOW) continue
    if (!isActiveHand(n.hand, n.track, song.hands, practiceHand)) continue
    const y = hitLineY - dt * pps
    const x = noteX(n.midiNote, whiteKeyW, transpose) + noteWidth(n.midiNote, whiteKeyW) / 2
    const label = midiToName(n.midiNote + transpose)
    // 文字背景
    const textW = ctx.measureText(label).width + 8
    ctx.fillStyle = 'rgba(15,16,20,0.85)'
    roundRect(ctx, x - textW / 2, y - 8, textW, 16, 4)
    ctx.fill()
    ctx.fillStyle = COLORS.text
    ctx.fillText(label, x, y)
  }
  ctx.restore()
}

// 节拍器
// 变拍曲子的拍点缓存 (按 song 对象缓存 —— 同一首歌的 measures / bpms 不会变)
const beatPointsCache = new WeakMap<Song, BeatPoint[]>()

/** 变拍曲子的拍点 (整首一个拍号 → null, 走老的连续拍网格) */
function beatPointsOf(song: Song, tempoMap: TempoMap): BeatPoint[] | null {
  if (!hasVariableTimeSignature(song.measures, song.timeSignature)) return null
  const cached = beatPointsCache.get(song)
  if (cached) return cached
  const points = measureBeatPoints(
    song.measures,
    song.timeSignature,
    (sec) => tempoMap.secPerQuarterAt(sec),
  )
  beatPointsCache.set(song, points)
  return points
}

function drawMetronomeDot(ctx: CanvasRenderingContext2D, y: number, isDownbeat: boolean) {
  ctx.beginPath()
  ctx.arc(METRO_LEFT_PAD, y, isDownbeat ? 5 : 3, 0, Math.PI * 2)
  ctx.fillStyle = isDownbeat
    ? 'rgba(251, 191, 36, 0.9)'
    : 'rgba(156, 163, 175, 0.5)'
  ctx.fill()
}

function drawMetronome(
  ctx: CanvasRenderingContext2D,
  H: number,
  hitLineY: number,
  song: Song,
  t: number,
  pps: number,
) {
  if (song.bpms.length === 0) return
  // tempo map (spec P2-3) —— 拍点跟着变速走, 不再死用 bpms[0].bpm
  const tempoMap = new TempoMap(song.bpms, song.timeSignature.denominator)
  const beatsPerMeasure = song.timeSignature.numerator

  // 变拍曲子 (如「梦中的婚礼」4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8):
  // 拍点按每小节自己的拍号切 —— 否则 6/8 / 9/8 小节里的点会跟小节线错开
  const points = beatPointsOf(song, tempoMap)
  if (points) {
    for (const p of points) {
      const dt = p.time - t
      if (dt < -2 || dt > 5) continue
      const y = hitLineY - dt * pps
      if (y > H - 10) continue

      drawMetronomeDot(ctx, y, p.isDownbeat)

      if (p.isDownbeat && dt > -0.2) {
        ctx.fillStyle = 'rgba(251, 191, 36, 0.7)'
        ctx.font = '10px sans-serif'
        ctx.textAlign = 'left'
        ctx.fillText(String(p.measureIndex + 1), METRO_LEFT_PAD + 8, y + 3)
      }
    }
    return
  }

  const startBeat = Math.floor(tempoMap.beatIndexAt(t - 2))
  const endBeat = Math.ceil(tempoMap.beatIndexAt(t + 5))

  for (let beat = startBeat; beat <= endBeat; beat++) {
    const beatTime = tempoMap.timeOfBeat(beat)
    const dt = beatTime - t
    if (dt < -2 || dt > 5) continue
    const y = hitLineY - dt * pps
    if (y > H - 10) continue

    const measureBeat = ((beat % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure
    const isDownbeat = measureBeat === 0

    drawMetronomeDot(ctx, y, isDownbeat)

    if (isDownbeat && dt > -0.2) {
      const measureNum = Math.floor(beat / beatsPerMeasure) + 1
      ctx.fillStyle = 'rgba(251, 191, 36, 0.7)'
      ctx.font = '10px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(String(measureNum), METRO_LEFT_PAD + 8, y + 3)
    }
  }
}

// 左右手分隔线
function drawHandDivider(
  ctx: CanvasRenderingContext2D,
  hitLineY: number,
  whiteKeyW: number,
) {
  const x = whiteKeyIndex(60) * whiteKeyW + whiteKeyW / 2
  ctx.save()
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(x, 0)
  ctx.lineTo(x, hitLineY)
  ctx.stroke()
  ctx.restore()
}

// 即将到来光晕
function drawApproachGlow(
  ctx: CanvasRenderingContext2D,
  whiteKeyW: number,
  keyboardTop: number,
  song: Song,
  t: number,
  practiceHand: PracticeHand,
  waitTarget: SongNote | null,
  transpose: number,
) {
  const keyboardH = KEYBOARD_HEIGHT

  if (waitTarget) {
    const midi = waitTarget.midiNote + transpose
    if (midi >= MIDI_MIN && midi <= MIDI_MAX) {
      drawKeyGlow(ctx, midi, whiteKeyW, keyboardTop, keyboardH, {
        color: '251, 191, 36',
        innerAlpha: 0.95,
        outerAlpha: 0,
        extra: 0.6,
      })
      drawKeyOutline(ctx, midi, whiteKeyW, keyboardTop, keyboardH, 'rgba(251, 191, 36, 0.95)', 3)
    }
    return
  }

  // 正常模式: 0.4s 内的活动手音高亮
  for (const n of song.notes) {
    const dt = n.time - t
    if (dt < 0 || dt > APPROACH_WINDOW) continue
    if (!isActiveHand(n.hand, n.track, song.hands, practiceHand)) continue
    const midi = n.midiNote + transpose
    if (midi < MIDI_MIN || midi > MIDI_MAX) continue
    drawKeyGlow(ctx, midi, whiteKeyW, keyboardTop, keyboardH, {
      color: '251, 191, 36',
      innerAlpha: 0.6 * (1 - dt / APPROACH_WINDOW),
      outerAlpha: 0,
      extra: 0.3 * (1 - dt / APPROACH_WINDOW),
    })
  }
}

/**
 * 八度色彩条 — 每个八度在键盘上方画一条彩色横条.
 * 中央八度 (C4-B4) 红色 + 最高; 越往两端颜色越冷, 高度越低.
 * 用途: 让用户扫一眼就能定位中央 C 在哪, 方便找键位.
 */
const OCTAVE_BAR_SPEC: { fromMidi: number; toMidi: number; color: string; height: number }[] = [
  // 中心向外 4 档: 红色 → 橙 → 黄 → 绿
  // 高度: 用户 2026-11-04 说「太高了」→ 整体缩到原来的 1/3 (32/26/20/14 → 11/9/7/5)
  // 中央: C4-B4 (60-71)
  { fromMidi: 60, toMidi: 71, color: 'rgba(239, 68, 68, 0.55)', height: 11 },   // 红
  { fromMidi: 48, toMidi: 59, color: 'rgba(251, 146, 60, 0.50)', height: 9 },   // 橙
  { fromMidi: 72, toMidi: 83, color: 'rgba(251, 146, 60, 0.50)', height: 9 },
  { fromMidi: 36, toMidi: 47, color: 'rgba(250, 204, 21, 0.45)', height: 7 },   // 黄
  { fromMidi: 84, toMidi: 95, color: 'rgba(250, 204, 21, 0.45)', height: 7 },
  { fromMidi: 24, toMidi: 35, color: 'rgba(34, 197, 94, 0.40)', height: 5 },    // 绿
  { fromMidi: 96, toMidi: 107, color: 'rgba(34, 197, 94, 0.40)', height: 5 },
  // A0-B0 (21-23) 和 C8 (108): 极短, 跳过
]

function drawOctaveBars(
  ctx: CanvasRenderingContext2D,
  whiteKeyW: number,
  keyboardTop: number,
) {
  for (const spec of OCTAVE_BAR_SPEC) {
    // 八度左边界 = 该八度 C 的白键 x; 右边界 = 下个音的 x (即 B+1 的白键起点)
    const xLeft = whiteKeyIndex(spec.fromMidi) * whiteKeyW
    const xRight = (whiteKeyIndex(spec.toMidi) + 1) * whiteKeyW
    const y = keyboardTop - spec.height
    ctx.fillStyle = spec.color
    ctx.fillRect(xLeft, y, xRight - xLeft, spec.height)
    // 描边, 让色块更清晰
    ctx.strokeStyle = spec.color.replace(/[\d.]+\)$/, '0.9)')
    ctx.lineWidth = 1
    ctx.strokeRect(xLeft + 0.5, y + 0.5, xRight - xLeft - 1, spec.height - 1)
  }
}

function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  whiteKeyW: number,
  keyboardTop: number,
  pressed: Set<number>,
  transpose: number,
  /** 「等你弹」的键 (Wait 冻结时) —— 用琥珀色染出来, null = 不染. */
  highlightMidi: number | null = null,
) {
  const keyboardH = KEYBOARD_HEIGHT

  // 白键
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    if (isBlackKey(midi)) continue
    const x = whiteKeyIndex(midi) * whiteKeyW
    // 移调后, 用户按下的 (transposed) 键要按 (rawKey = e.midi) - transpose 来比对
    const isPressed = pressed.has(midi + transpose)
    ctx.fillStyle = isPressed ? COLORS.whiteKeyPressed : COLORS.whiteKey
    ctx.fillRect(x, keyboardTop, whiteKeyW, keyboardH)
    ctx.strokeStyle = COLORS.border
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, keyboardTop + 0.5, whiteKeyW - 1, keyboardH - 1)
    // 「等你弹」的键: 染色画在白键上、黑键下 —— 这样压在旁边的黑键仍然盖在上面 (物理正确)
    if (midi === highlightMidi) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.55)'
      ctx.fillRect(x, keyboardTop, whiteKeyW, keyboardH)
    }
  }
  // 黑键
  const blackKeyW = whiteKeyW * 0.6
  const blackKeyH = keyboardH * 0.62
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    if (!isBlackKey(midi)) continue
    const prevWhite = whiteKeyIndex(midi - 1)
    const x = (prevWhite + 1) * whiteKeyW - blackKeyW / 2
    const isPressed = pressed.has(midi + transpose)
    ctx.fillStyle = isPressed ? COLORS.blackKeyPressed : COLORS.blackKey
    ctx.fillRect(x, keyboardTop, blackKeyW, blackKeyH)
    if (midi === highlightMidi) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.65)'
      ctx.fillRect(x, keyboardTop, blackKeyW, blackKeyH)
    }
  }
  // 高亮键的描边 —— 画在所有键之上, 才不会被黑键盖掉
  if (highlightMidi !== null) {
    drawKeyOutline(ctx, highlightMidi, whiteKeyW, keyboardTop, keyboardH, 'rgba(251, 191, 36, 0.95)', 3)
  }
}

/**
 * 琴键上的音名标号 (D3 之类) —— 用户 2026-10-30 要求:
 * 「在虚拟钢琴键盘上你需要打上 D3 之类的标号, 我不认识」.
 *
 * 标的是**键自己的音名** (位置音高): 位置 P 的键标 midiToName(P),
 * 跟画在同一个位置上的「未来音符标签」midiToName(note.midiNote + transpose) 一致.
 *
 * 布局:
 *  - 白键: 横排, 放在白键下半部分 (上半部分被黑键压住)
 *  - 黑键: 太窄放不下横排 → 竖着写 (旋转 -90°), 字号按黑键宽度定
 */
function drawKeyLabels(
  ctx: CanvasRenderingContext2D,
  whiteKeyW: number,
  keyboardTop: number,
  keyboardH: number,
  mode: KeyLabelMode,
) {
  if (mode === 'off') return
  const blackKeyH = keyboardH * 0.62
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 白键
  ctx.font = `${whiteKeyLabelSize(whiteKeyW)}px ui-monospace, monospace`
  ctx.fillStyle = 'rgba(31, 41, 55, 0.8)'
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    if (isBlackKey(midi)) continue
    const label = labelForMidi(midi, mode)
    if (!label) continue
    const x = whiteKeyIndex(midi) * whiteKeyW + whiteKeyW / 2
    const y = keyboardTop + blackKeyH + (keyboardH - blackKeyH) / 2
    ctx.fillText(label, x, y)
  }

  // 黑键 (竖排)
  ctx.font = `${blackKeyLabelSize(whiteKeyW)}px ui-monospace, monospace`
  ctx.fillStyle = 'rgba(229, 231, 235, 0.85)'
  for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
    if (!isBlackKey(midi)) continue
    const label = labelForMidi(midi, mode)
    if (!label) continue
    const prevWhite = whiteKeyIndex(midi - 1)
    const x = (prevWhite + 1) * whiteKeyW
    const y = keyboardTop + blackKeyH / 2
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(-Math.PI / 2)
    ctx.fillText(label, 0, 0)
    ctx.restore()
  }
  ctx.restore()
}

// Wait 提示
function drawWaitHint(
  ctx: CanvasRenderingContext2D,
  W: number,
  target: SongNote,
) {
  const transpose = useStore.getState().transpose
  const p = target.midiNote + transpose
  const name = midiToName(p)
  const handLabel = target.hand === 'left' ? '左手' : '右手'
  // 注意: 不用 emoji —— canvas 里的 emoji 各平台渲染完全不一样, 还会撑大行高.
  // 想要"瞄准"的感觉, 画一个圆环图标更可控.
  const text = `等你弹 ${name}  (${handLabel})`

  ctx.save()
  const boxW = 240
  const boxH = 38
  const x = (W - boxW) / 2
  const y = 16
  ctx.fillStyle = 'rgba(15, 16, 20, 0.85)'
  roundRect(ctx, x, y, boxW, boxH, 6)
  ctx.fill()
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)'
  ctx.lineWidth = 1.5
  roundRect(ctx, x, y, boxW, boxH, 6)
  ctx.stroke()
  ctx.fillStyle = '#fbbf24'
  ctx.font = '600 15px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, W / 2, y + boxH / 2)

  // 左侧小圆环 (代替 emoji 靶心)
  const ringX = x + 22
  const ringY = y + boxH / 2
  ctx.strokeStyle = '#fbbf24'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(ringX, ringY, 6, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(ringX, ringY, 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// 小节竖线
function drawMeasureLines(
  ctx: CanvasRenderingContext2D,
  W: number,
  hitLineY: number,
  song: Song,
  t: number,
  pps: number,
) {
  ctx.strokeStyle = COLORS.border
  ctx.lineWidth = 1
  for (const m of song.measures) {
    const dt = m.time - t
    if (dt < -2 || dt > 10) continue
    const y = hitLineY - dt * pps
    if (y < 0 || y > hitLineY) continue
    ctx.beginPath()
    ctx.moveTo(METRO_LEFT_PAD + 6, y)
    ctx.lineTo(W, y)
    ctx.stroke()
  }
}

// 工具函数

function noteX(midi: number, whiteKeyW: number, transpose = 0): number {
  const m = midi + transpose
  if (isBlackKey(m)) {
    const prevWhite = whiteKeyIndex(m - 1)
    return (prevWhite + 1) * whiteKeyW - (whiteKeyW * 0.3)
  }
  return whiteKeyIndex(m) * whiteKeyW + 1
}

function noteWidth(midi: number, whiteKeyW: number): number {
  if (isBlackKey(midi)) return whiteKeyW * 0.6
  return whiteKeyW - 2
}

/**
 * 右键命中测试 —— 找出鼠标按在哪个音符上.
 *
 * 屏幕 y -> 时间: 色块的**下沿**才是起音时刻 (画的时候 y = hitLineY - (t_note - t)*pps,
 * 色块从 y-h 画到 y), 所以 time = now + (hitLineY - mouseY) / pps;
 * 落在 [n.time, n.time + n.duration] 区间里的就是它.
 *
 * pps 必须跟画的时候用的是**同一个**值 (见 ppsFor) —— 不然点出来的音符会偏.
 *
 * 黑键的色块比白键窄一截且叠在上面 —— 同一区域两者都命中时优先黑键
 * (跟钢琴卷帘 / DAW 的习惯一致).
 */
export function hitTestNote(
  song: Song,
  mouseX: number,
  mouseY: number,
  now: number,
  hitLineY: number,
  whiteKeyW: number,
  transpose: number,
  pps: number = PPS,
): { index: number; note: SongNote } | null {
  const time = now + (hitLineY - mouseY) / pps
  let best: { index: number; note: SongNote; dist: number; black: boolean } | null = null
  for (let i = 0; i < song.notes.length; i++) {
    const n = song.notes[i]
    if (time < n.time - 1e-6 || time > n.time + n.duration + 1e-6) continue
    const x = noteX(n.midiNote, whiteKeyW, transpose)
    const w = noteWidth(n.midiNote, whiteKeyW)
    if (mouseX < x || mouseX > x + w) continue
    const black = isBlackKey(n.midiNote + transpose)
    const dist = Math.abs(mouseX - (x + w / 2))
    if (
      !best ||
      (black && !best.black) ||
      (black === best.black && dist < best.dist)
    ) {
      best = { index: i, note: n, dist, black }
    }
  }
  return best ? { index: best.index, note: best.note } : null
}

// 「第几小节第几拍」的定位逻辑挪到 editor/roll.ts —— 谱子编辑器也要用,
// 放在 render 层会让编辑器反向依赖渲染模块. 这里转出去, 外部 import 路径不变.
export { locateNote } from '../editor/roll'

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
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

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
  }
  return color
}

function drawKeyGlow(
  ctx: CanvasRenderingContext2D,
  midi: number,
  whiteKeyW: number,
  keyboardTop: number,
  keyboardH: number,
  cfg: { color: string; innerAlpha: number; outerAlpha: number; extra: number },
) {
  let x: number, y: number, w: number, h: number
  if (isBlackKey(midi)) {
    const prevWhite = whiteKeyIndex(midi - 1)
    w = whiteKeyW * 0.6
    h = keyboardH * 0.62
    x = (prevWhite + 1) * whiteKeyW - w / 2
  } else {
    x = whiteKeyIndex(midi) * whiteKeyW
    w = whiteKeyW
    h = keyboardH
  }
  y = keyboardTop
  ctx.save()
  const grad = ctx.createRadialGradient(
    x + w / 2, y + h / 2, 0,
    x + w / 2, y + h / 2, Math.max(w, h) * 1.4 + cfg.extra * 20,
  )
  grad.addColorStop(0, `rgba(${cfg.color},${cfg.innerAlpha})`)
  grad.addColorStop(0.7, `rgba(${cfg.color},${cfg.outerAlpha})`)
  grad.addColorStop(1, `rgba(${cfg.color},0)`)
  ctx.fillStyle = grad
  ctx.fillRect(x - cfg.extra * 20, y - cfg.extra * 20, w + cfg.extra * 40, h + cfg.extra * 40)
  ctx.restore()
}

function drawKeyOutline(
  ctx: CanvasRenderingContext2D,
  midi: number,
  whiteKeyW: number,
  keyboardTop: number,
  keyboardH: number,
  color: string,
  width: number,
) {
  let x: number, y: number, w: number, h: number
  if (isBlackKey(midi)) {
    const prevWhite = whiteKeyIndex(midi - 1)
    w = whiteKeyW * 0.6
    h = keyboardH * 0.62
    x = (prevWhite + 1) * whiteKeyW - w / 2
  } else {
    x = whiteKeyIndex(midi) * whiteKeyW
    w = whiteKeyW
    h = keyboardH
  }
  y = keyboardTop
  ctx.strokeStyle = color
  ctx.lineWidth = width
  roundRect(ctx, x + 1, y + 1, w - 2, h - 2, 4)
  ctx.stroke()
}

