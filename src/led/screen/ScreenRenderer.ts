// LED 点阵屏的渲染器 —— 把一段乐谱画成虚拟画布 (512x64) 再切成「每块屏一份」.
//
// 画面跟网页的 FallingNotes 对齐 (左蓝右红 / 命中绿 / 底部琴键盘面),
// 只是因为屏小, 砍掉了标签、小节线、节拍点这些细节 —— 64 行塞不下.
//
// ★ 2026-11-13: 画面改成**纯色 + 全灭**两种像素 (0 / 100), 不再有中间值.
//   面板是 PWM 调光的 —— 每个像素的亮度 = 它在 7 个 bit-plane 里被点亮的比例.
//   想让一个像素「一直亮着」, 它的 RGB 得映射成**每个 bit 都是 1** 的值,
//   也就是输入必须是纯色 (255,0,0 这种). 混色 (60,120,255) 的三个通道落在
//   不同的 bit-plane 上 —— 一帧里先偏蓝、再偏紫、再偏白, 看着像在闪.
//   所以: ① 面板用自己的纯色调色板; ② 所有坐标取整 (不抗锯齿, 免得出现半灰的边);
//   ③ extract() 再把每个像素砍成「全灭」或「纯色满值」两档.
//
// ★ 2026-11-13 (后一条覆盖上面那条): 颜色**不再**压成两档.
//   上面那条判断错了 —— 实测闪的根源是刷新率 (94.7Hz -> 已修到 209Hz),
//   不是占空比/混色. 现在颜色按用户选的准确输出 (粉色 #ffc0cb 这种混色
//   在面板上必须能显示出来). 画面里仍不会出现抗锯齿的灰边 ——
//   所有绘制坐标都是整数.
//
// ★ 2026-11-13: 翻转改成**整条链左右镜像** (屏序反过来 + 每块屏里的两块模组也反过来).
//   一块屏 = 两块 64 宽的模组菊花链, 模组的顺序由接线决定: 插头 (进线) 在右边时
//   链是从右往左串的 —— 链头那块模组落在物理上的最右边.
//   所以「左进线」的画面 = 把整条链的 64px 模组序列**整个倒过来**:
//   屏与屏换位, 每块屏内部的两块模组也换位.
//   (只换屏序 -> 每块屏内部的画面还是反的; 只换模组 -> 屏与屏的顺序反了. 都不对.)
//
// 坐标
// ----
// 全部按**虚拟画布**算 (0..511), 琴键从 MARGIN_X 开始.
// 最后 extract() 才按选中的屏号切出每块屏那 128 列, 拼成一帧发出去.

import { MIDI_MIN, MIDI_MAX, isBlackKey, whiteKeyIndex } from '../../render/colors'
import { isActiveHand, type PracticeHand } from '../../store'
import { resolveHand } from '../../hand'
import type { Song, Hand } from '../../types'
import {
  CANVAS_W,
  MAX_SCREENS,
  SCREEN_H,
  SCREEN_W,
  WHITE_KEY_W,
  MARGIN_X,
  KEYBOARD_H,
  MIN_HORIZON,
  MIDDLE_C_X,
  MIDDLE_C_MIDI,
  DEFAULT_SCREEN_COLORS,
  PER_SCREEN_COLORS,
  screensPerPort,
  type LedScreenColors,
} from './screenConfig'

/** 渲染一帧要的所有东西 —— 每帧从 store/player 现取. */
export interface ScreenSource {
  song: Song | null
  /** 当前歌曲时间 (秒) */
  t: number
  practiceHand: PracticeHand
  /** 当前按住的 midi */
  pressed: Set<number>
  transpose: number
  /** 音符评分 (键 = note 在 song.notes 里的下标) */
  noteStates: Map<number, 'hit' | 'miss' | 'late'>
}

/**
 * 面板的版面 —— 用户在设置里能改的两样东西.
 *
 * 琴键区高度是**动态**的: 改了它, 音符区高度跟着变, 下落速度 (px/s) 也跟着变
 * (保持「命中线上方 2.2 秒」这个预读时间不变, 跟网页一个道理).
 */
export interface PanelLayout {
  /** 底部琴键区占多少行 (0 = 关闭) */
  keyboardH: number
  /** 音符方块大小比例 (1 = 当前大小) */
  noteScale: number
}

export const DEFAULT_LAYOUT: PanelLayout = {
  keyboardH: KEYBOARD_H,
  noteScale: 1,
}

/**
 * 面板自己的固定色 —— 这些不开放给用户改.
 *
 * 音符色 / 黑键色在 <LedScreenColors> 里 (设置里可以逐个改).
 * 不用网页那套 (半透明底色 / 灰边框 / 淡蓝淡红): 面板上「更暗」只能用
 * 像素开/关 (空间上的点阵) 表达, 颜色深浅在 PWM 上会变成另一种颜色.
 */
const PANEL = {
  bg: '#000000',
  band: '#000000',
  whiteKey: '#ffffff',
  whiteKeyPressed: '#ffff00',
  blackKeyPressed: '#00ffff',
  /** 音符的落点线 —— 白线标出「该弹了」的位置. */
  edge: '#ffffff',
} as const

export class ScreenRenderer {
  private cvs: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private layout: PanelLayout
  private colors: LedScreenColors

  constructor(layout?: Partial<PanelLayout>) {
    this.cvs = document.createElement('canvas')
    this.cvs.width = CANVAS_W
    this.cvs.height = SCREEN_H
    // willReadFrequently —— 每帧都要 getImageData 抠像素, 走 CPU 端快很多
    this.ctx = this.cvs.getContext('2d', { willReadFrequently: true })!
    this.layout = { ...DEFAULT_LAYOUT, ...layout }
    this.colors = { ...DEFAULT_SCREEN_COLORS }
  }

  /** 改版面 (设置里拖滑块) —— 下一帧就生效, 不用重连. */
  setLayout(layout: Partial<PanelLayout>) {
    this.layout = { ...this.layout, ...layout }
  }

  /** 改配色 (设置里换颜色) —— 下一帧就生效, 不用重连. */
  setColors(colors: Partial<LedScreenColors>) {
    this.colors = { ...this.colors, ...colors }
  }

  /** 琴键区上沿的 y —— 音符落到这儿就算「该弹了」. 琴键区关掉时就是屏幕最底. */
  private get hitY(): number {
    return SCREEN_H - this.layout.keyboardH
  }

  /** 下落速度 (px/s) —— 音符区越高落得越快, 预读时间恒定 2.2 秒. */
  private get pps(): number {
    return this.hitY / MIN_HORIZON
  }

  /** 画一帧到虚拟画布. */
  render(src: ScreenSource) {
    const ctx = this.ctx
    ctx.fillStyle = PANEL.bg
    ctx.fillRect(0, 0, CANVAS_W, SCREEN_H)

    // ★ 2026-11-14: 不画屏与屏之间的分隔线了.
    //   屏是**紧挨着**装的, 中间那条白线会变成一条刺眼的亮缝.
    if (this.layout.keyboardH > 0) this.drawKeyboard(ctx, src)
    this.drawNotes(ctx, src)
    this.drawMiddleCMarker(ctx)
  }

  /**
   * 整张虚拟画布的像素 (RGBA) —— 预览/调试用.
   *
   * extract() 只给选中的屏, 想看整条画布长什么样 (或者对着屏幕排布) 用这个.
   */
  snapshot(): { data: Uint8ClampedArray; width: number; height: number } {
    return this.ctx.getImageData(0, 0, CANVAS_W, SCREEN_H)
  }

  /**
   * 把选中的屏切出来, 拼成一帧 RGB888.
   *
   * 屏号按**升序**拼 —— 菊花链是从左往右串的, 第 1 块屏在链头.
   *
   * ★ 2026-11-14: 多个 HUB75 口 (ports > 1) 时, 每个口是一条**独立的链**,
   *   画面按竖条切给各口 (口 1 = 画布左边一段, 口 2 = 右边一段).
   *   所以帧里还是「屏按升序排开」—— 口 1 的那几块屏排在前面.
   *
   * flip = true 时把每条链**左右镜像** (规则见 screenCols()).
   *
   * vflip = true 时把整帧**上下镜像** —— 面板的行 0 在下边时开.
   *
   * ★ 2026-11-13: 颜色**原样**输出, 不再压成两档.
   *   以前压两档是因为以为混色会闪 —— 实测闪的根源是刷新率 (94.7Hz, 已修到
   *   209Hz). 现在粉色 (#ffc0cb) 这种混色要能准确显示出来.
   *   画面里不会有抗锯齿的灰边: 所有绘制坐标都是整数.
   */
  extract(screens: number[], flip = false, ports = 1, vflip = false): Uint8Array {
    const n = screens.length
    const out = new Uint8Array(SCREEN_W * n * SCREEN_H * 3)
    if (n === 0) return out
    const img = this.ctx.getImageData(0, 0, CANVAS_W, SCREEN_H).data
    const cols = this.screenCols(screens, flip, ports)
    let o = 0
    // 帧是**按行**排的: 一行 = 各屏的 128 列依次排开.
    for (let y = 0; y < SCREEN_H; y++) {
      // 上下翻转 —— 面板的行 0 在下边时开 (见 screenConfig 的说明).
      const rowBase = (vflip ? SCREEN_H - 1 - y : y) * CANVAS_W
      for (let k = 0; k < n; k++) {
        const base = rowBase + cols[k]
        // ★ 2026-11-16: 这里**不再**把屏内的两块 64px 模组对调.
        //
        //   以前 flip 是「屏序反过来 + 每块屏内部的两块模组也换位」, 那是给
        //   **64px 宽的小模组**写的 (一块「屏」= 两块 64x64 串联, 整条链倒过来
        //   时模组顺序也倒). 但用户手上是一块 128x64 的模组 (320x160mm) ——
        //   模组是**一个整体**, 链倒过来只是「哪块屏在左/右」变了, 屏内部不该动.
        //   对调之后每块屏自己左右两半互换, 于是画布最左/最右那 11px 冗余黑边
        //   被搬到第 1 和第 4 块屏的中间 —— 用户实测到的「黑带跑到中间」.
        o = copyPixels(out, o, img, base, SCREEN_W)
      }
    }
    return out
  }

  /**
   * 自检用: 每块屏涂一个固定颜色 (屏1 红 / 屏2 绿 / 屏3 蓝 / 屏4 白).
   *
   * 屏的摆放跟正常画面**完全一样** (同一套 flip / 口 的映射),
   * 所以面板上看到哪一块是红的, 就知道那块物理屏对应的是几号屏 ——
   * 接线顺序反了、哪块没接上, 一眼就看得出来.
   */
  extractPerScreen(screens: number[], flip = false, ports = 1, vflip = false): Uint8Array {
    const n = screens.length
    const out = new Uint8Array(SCREEN_W * n * SCREEN_H * 3)
    if (n === 0) return out
    const cols = this.screenCols(screens, flip, ports)
    for (let k = 0; k < n; k++) {
      // cols[k] = 这个位置放的是几号屏 (1..4) 的画布列 -> 反推屏号.
      const screen = Math.round(cols[k] / SCREEN_W) + 1
      const rgb = PER_SCREEN_COLORS[Math.min(PER_SCREEN_COLORS.length, Math.max(1, screen)) - 1]
      for (let y = 0; y < SCREEN_H; y++) {
        const o = ((vflip ? SCREEN_H - 1 - y : y) * SCREEN_W * n + k * SCREEN_W) * 3
        for (let x = 0; x < SCREEN_W; x++) {
          out[o + x * 3] = rgb[0]
          out[o + x * 3 + 1] = rgb[1]
          out[o + x * 3 + 2] = rgb[2]
        }
      }
    }
    return out
  }

  /**
   * 帧里第 k 个位置 (0-based) 放的是**几号屏**的画布列.
   *
   * flip = true 时把每条链的**屏序倒过来** (只倒屏, 屏内部不动):
   * 进线在右边、链从右往左串时, 物理上的最左边是链尾那块屏 ——
   * 要让画面「从左边依次过去」, 就得把屏序反过来.
   *
   * ★ 2026-11-16: 只倒**屏序**, 不再动屏内的 64px 模组.
   *   用户的模组是 128x64 一体 (320x160mm), 不是两块 64x64 拼的;
   *   动屏内顺序会让画布最左/最右那条冗余黑边跑到屏中间 (实测过的症状).
   *
   * ★ 2026-11-14: **按口**翻 —— 翻转是接线的事, 每个口可以各自插头朝左/朝右,
   *   不能把口 2 的屏串到口 1 前面去.
   */
  private screenCols(screens: number[], flip: boolean, ports: number): number[] {
    const n = screens.length
    const cols: number[] = new Array(n)
    const perPort = screensPerPort(n, ports)
    for (let k = 0; k < n; k++) {
      // 这个位置属于第几个口 (0-based)
      const port = Math.min(Math.max(1, ports) - 1, Math.floor(k / perPort))
      // 口内第几块 (flip 时在口内倒着数)
      const inPort = k - port * perPort
      const portLen = Math.min(perPort, n - port * perPort)
      const idx = flip ? portLen - 1 - inPort : inPort
      const screen = screens[port * perPort + idx]
      // 屏号越界就夹住 —— 越界读会把别的屏的像素混进来 (看着像随机错位).
      const s = Math.min(MAX_SCREENS, Math.max(1, screen | 0))
      cols[k] = (s - 1) * SCREEN_W
    }
    return cols
  }

  /**
   * 底部琴键盘面.
   *
   * 白键之间留 1 像素黑缝 —— 不留的话一整排白键连成一片, 分不出键.
   * 黑键: 中央 C 左边一个颜色 (品红), 右边另一个 (粉色) ——
   * 以前黑键画的是纯黑, 在黑底上等于没画, 看不出左右两半分在哪.
   *
   * ★ 2026-11-14: 白键宽按**真实长度** 9.4px (23.5mm ÷ 2.5mm) 画 ——
   *   四块屏比 88 键宽, 左右多出来的 11.6px 就空着 (那是冗余, 不是画错).
   */
  private drawKeyboard(ctx: CanvasRenderingContext2D, src: ScreenSource) {
    const top = this.hitY
    const h = this.layout.keyboardH
    ctx.fillStyle = PANEL.band
    ctx.fillRect(0, top, CANVAS_W, h)

    // 白键
    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      if (isBlackKey(midi)) continue
      const idx = whiteKeyIndex(midi)
      const x0 = Math.round(MARGIN_X + idx * WHITE_KEY_W)
      const x1 = Math.round(MARGIN_X + (idx + 1) * WHITE_KEY_W)
      const isPressed = src.pressed.has(midi + src.transpose)
      ctx.fillStyle = isPressed ? PANEL.whiteKeyPressed : PANEL.whiteKey
      ctx.fillRect(x0, top, x1 - x0 - 1, h)
    }

    // 黑键 (比白键窄一半, 高 62%)
    const blackKeyW = Math.round(WHITE_KEY_W * 0.6)
    const blackKeyH = Math.round(h * 0.62)
    for (let midi = MIDI_MIN; midi <= MIDI_MAX; midi++) {
      if (!isBlackKey(midi)) continue
      const prevWhite = whiteKeyIndex(midi - 1)
      const x = Math.round(MARGIN_X + (prevWhite + 1) * WHITE_KEY_W) - Math.floor(blackKeyW / 2)
      const isPressed = src.pressed.has(midi + src.transpose)
      // 中央 C (MIDI 60) 左边 = 左手那边, 右边 = 右手那边.
      ctx.fillStyle = isPressed
        ? PANEL.blackKeyPressed
        : midi < MIDDLE_C_MIDI
          ? this.colors.blackLeft
          : this.colors.blackRight
      ctx.fillRect(x, top, blackKeyW, blackKeyH)
    }
  }

  /**
   * 下落音符.
   *
   * 两遍画 (先非优先手后优先手) —— 跟网页一样: 优先手的颜色必须压在最上面,
   * 免得两种颜色混在一起.
   *
   * 不练习的那只手**不调暗** —— 面板上「更暗」只能用像素点阵 (空间抖动) 表达,
   * 而音符是往下落的, 抖动的点阵跟着一起动, 看着就是在闪.
   * 改成: 两只手都是纯色 (左手蓝右手红), 只给「要弹的那只手」画白色落点线.
   */
  private drawNotes(ctx: CanvasRenderingContext2D, src: ScreenSource) {
    const song = src.song
    if (!song) return
    const pps = this.pps
    const hitY = this.hitY
    const horizon = hitY / pps
    const scale = this.layout.noteScale
    const priorityHand: Hand = src.practiceHand === 'left' ? 'left' : 'right'

    for (const pass of [0, 1]) {
      for (let i = 0; i < song.notes.length; i++) {
        const n = song.notes[i]
        const isPriority = resolveHand(n.hand, n.track, song.hands) === priorityHand
        if (isPriority !== (pass === 1)) continue
        const dt = n.time - src.t
        if (dt < -0.5 || dt > horizon + 0.2) continue

        const y = hitY - dt * pps
        // 音符块的大小乘比例 —— 下沿 (落点) 不动, 往上长, 看得更清楚.
        // ★ 2026-11-13 用户要求: 「音符大小只改长度比例, 不能改胖瘦」——
        //   所以比例只乘高度, 宽度还是键宽 (音符该多宽还是多宽).
        const h = Math.max(4, n.duration * pps * scale)
        const x = MARGIN_X + noteX(n.midiNote, src.transpose)
        const w = Math.min(noteWidth(n.midiNote, src.transpose), WHITE_KEY_W * 1.6)

        const active = isActiveHand(n.hand, n.track, song.hands, src.practiceHand)
        const isHit = active && src.noteStates.get(i) === 'hit'
        const color = isHit
          ? this.colors.hit
          : n.hand === 'left'
            ? this.colors.left
            : this.colors.right

        // 音符只画到键盘上沿 —— 落下去以后别再盖住白键.
        // 盖住会让白键一闪一闪 (看着像白键在抽).
        //
        // ★ 2026-11-13: 高度**先取整成固定像素**, 再用它反推上沿 ——
        //   以前是 `yTop = round(y - h)` 和 `yBottom = round(y)` 各自取整,
        //   两个 round 不同步, 方块的高度就在 N / N+1 之间跳. 21.8px/s 的
        //   下落速度下, 每秒有几十次这种 1px 抽动 = 满屏音符都在「闪」.
        const x0 = Math.round(x)
        const x1 = Math.round(x + w)
        const hPx = Math.max(4, Math.round(h))
        const yBottom = Math.min(hitY, Math.round(y))
        const yTop = Math.max(0, Math.round(y) - hPx)
        if (yBottom > yTop) {
          ctx.fillStyle = color
          ctx.fillRect(x0, yTop, x1 - x0, yBottom - yTop)
        }
        // 落点那 1 行 —— 白线标出「该弹了」的位置 (命中时是绿的).
        // 只给「要弹的那只手」画 —— 另一只手不弹, 不给它画落点.
        const edgeY = yBottom - 1
        if (active && edgeY >= yTop && (y <= hitY || isHit)) {
          ctx.fillStyle = isHit ? this.colors.hit : PANEL.edge
          ctx.fillRect(x0, edgeY, x1 - x0, 1)
        }
      }
    }
  }

  /**
   * 中央 C 对齐线 (1px 白线).
   *
   * 画在音符区里 (黑底, 白线看得见), 下端正好停在中央 C 白键的**左边缘**
   * —— 屏贴到琴上时, 这条线的落点就是中央 C 的起点.
   *
   * 注意: 画在键盘上没用 —— 中央 C 本身就是白键, 白线压白键看不见.
   *
   * ★ 2026-11-14 用户要求: 白线太长, 缩短为 1/2 (16px -> 8px).
   */
  private drawMiddleCMarker(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(Math.round(MIDDLE_C_X), this.hitY - 8, 1, 8)
  }
}

/**
 * 从画布上抄一段像素到帧里 (RGBA -> RGB888, alpha 丢掉).
 *
 * 一行 = 连续 count 个像素. 返回写完后的新位置.
 */
function copyPixels(
  out: Uint8Array,
  o: number,
  img: Uint8ClampedArray,
  srcStart: number,
  count: number,
): number {
  let i = srcStart * 4
  for (let x = 0; x < count; x++) {
    out[o++] = img[i]
    out[o++] = img[i + 1]
    out[o++] = img[i + 2]
    i += 4
  }
  return o
}

/** 音符条的 x (虚拟画布坐标, 不含 MARGIN_X) */
function noteX(midi: number, transpose: number): number {
  const m = midi + transpose
  if (isBlackKey(m)) {
    const prevWhite = whiteKeyIndex(m - 1)
    return (prevWhite + 1) * WHITE_KEY_W - WHITE_KEY_W * 0.3
  }
  return whiteKeyIndex(m) * WHITE_KEY_W + 1
}

/** 音符条的宽 */
function noteWidth(midi: number, transpose: number): number {
  return isBlackKey(midi + transpose) ? WHITE_KEY_W * 0.6 : WHITE_KEY_W - 2
}

/**
 * 音符在虚拟画布上的 x —— 设置里用它算「这块屏覆盖到哪些音」.
 */
export function noteCanvasX(midi: number, transpose: number): number {
  return MARGIN_X + noteX(midi, transpose)
}
