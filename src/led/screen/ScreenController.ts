// LED 点阵屏的传输层 —— 跟树莓派的 matrix_server 讲协议.
//
// 协议 (端口 8081)
// ----------------
//   1. {"id":1,"op":"auth","token":"..."}      仅当服务端配了 token
//   2. {"id":2,"op":"matrix.init","args":{"width":128,"height":64,"screens":[3]}}
//   3. <binary>  一帧 RGB888, 长度 = width*height*3
//
// auth 和 init 是**连着发**的: 服务端配了 token 就先读第一条 (auth),
// 没配就直接进主循环把 auth 当「未知 op」回掉 —— 两种情况都能跑通.
//
// 帧率
// ----
// 浏览器这边按 fps 限流 (默认 30). 树莓派那边的 led_anim 是「来一帧画一帧」,
// 它自己的 --fps 60 只是上限 —— 真正决定节奏的是我们发多快.
//
// 实测 (2026-11-12, 树莓派 + 一块 128x64 屏):
//   发 15fps -> 屏上 14.5fps, 丢 0 帧
//   发 30fps -> 屏上 28.5fps, 丢 0 帧
//   发 60fps -> 屏上 55.3fps, 丢 0 帧
// 也就是「发多少画多少」, 面板本身不是瓶颈 (画一帧只要 0.9ms).
//
// 背压: 树莓派只留最新一帧 (旧的直接丢), 所以网络抖动不会攒延迟 ——
// 但如果树莓派那边忙不过来, 画面最多慢一拍, 不会越拖越久. 30fps 一帧 24KB,
// 局域网完全够.
//
// ★ 2026-11-13 浏览器这一侧也加了闸门 (见 frameGate.ts):
//   - 发送缓冲积压 > 1 帧 -> 丢当前帧 (否则队列越攒越长, 恢复时一口气灌一串
//     过期帧 = 卡顿 + 跳帧);
//   - 画面跟上一帧一模一样 -> 跳过 (暂停时白推 30fps 只会让树莓派更忙, 而
//     树莓派一忙刷新率就抖 = 屏幕明暗闪), 但每 500ms 补发一帧保活.

import { ScreenRenderer, type ScreenSource, type PanelLayout } from './ScreenRenderer'
import { SCREEN_W, SCREEN_H, type LedScreenColors } from './screenConfig'
import { shouldSendFrame } from './frameGate'

export interface ScreenControllerOpts {
  /** ws://host:8081 或 wss://host/led-proxy/screen */
  url: string
  /** 令牌 (服务端没配就留空) */
  token?: string
  /** 帧率 (fps) */
  fps: number
  /** 渲染哪几块屏 (1..4), 升序 */
  screens: number[]
  /** 亮度 0..100 (由树莓派按帧缩放, 改了不重连) */
  brightness?: number
  /** 画面左右翻转 —— 插头 (进线) 在右边时开 */
  flip?: boolean
  /** 每帧取一次画面数据 */
  getSource: () => ScreenSource
  /** 连接状态变化 */
  onStatus?: (connected: boolean, error: string | null) => void
}

/** 断了以后多久重连 (毫秒) */
const RETRY_MS = 2000

/** 服务端踢人时用的关闭码 —— 意思是「被别的客户端接管了」 */
const REPLACED_CODE = 1012

/** 亮度夹到 1..100 (0 等于关屏, 没有意义). */
function clampBrightness(v: number): number {
  if (!Number.isFinite(v)) return 100
  return Math.max(1, Math.min(100, Math.round(v)))
}

export class ScreenController {
  private opts: ScreenControllerOpts
  private renderer = new ScreenRenderer()
  private ws: WebSocket | null = null
  private raf = 0
  /** 下一次该发帧的截止时间 (performance.now 基准) */
  private nextSendAt = 0
  private nextId = 1
  private retryTimer: number | null = null
  private stopped = false
  /** 被别的客户端接管了 —— 不再重连 */
  private replaced = false
  private fps: number

  /** 当前渲染的屏号 (升序) */
  screens: number[]
  /** 画面左右翻转 */
  private flip: boolean
  /** 亮度 0..100 —— 每次 init 都带上去, 重连后设置不会丢. */
  private brightness: number
  /** 上一帧发出去的内容 —— 跟新帧逐字节比, 一样就跳过 (见 frameGate). */
  private lastFrame: Uint8Array | null = null
  /** 上一帧发出去的时刻 (performance.now; 0 = 还没发过) */
  private lastSentAt = 0
  /**
   * 因为「发送缓冲积压」而丢掉的帧数 (诊断用).
   *
   * 一直涨 = 链路/树莓派吃不下当前帧率, 该把 fps 调低.
   */
  droppedFrames = 0
  /** 因为「画面没变」而省掉的帧数 (诊断用). */
  skippedFrames = 0

  constructor(opts: ScreenControllerOpts) {
    this.opts = opts
    this.fps = opts.fps
    this.screens = [...opts.screens]
    this.flip = opts.flip ?? false
    this.brightness = clampBrightness(opts.brightness ?? 100)
  }

  /** 连上并开始推帧. */
  start() {
    this.stopped = false
    this.open()
  }

  /** 断开并停掉推帧 (不会重连). */
  stop() {
    this.stopped = true
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.stopLoop()
    const ws = this.ws
    this.ws = null
    try {
      ws?.close()
    } catch {}
  }

  /**
   * 换屏号.
   *
   * 屏数变了 -> 树莓派那边菊花链长度变了, 得重新 init (它会重启 led_anim,
   * 屏幕会黑一下); 屏数没变只是内容换了位置, 树莓派不用动.
   */
  setScreens(screens: number[]) {
    const changed = screens.join(',') !== this.screens.join(',')
    this.screens = [...screens]
    if (changed) this.sendInit()
  }

  setFps(fps: number) {
    this.fps = fps
  }

  /**
   * 改亮度 (0..100).
   *
   * 不走 init —— 树莓派那边按帧缩放, **下一帧就生效, 不重启 led_anim**,
   * 所以拖滑块时屏不会黑一下. 但如果还没连上, 就先只记住: 下次 init 会带上.
   */
  setBrightness(pct: number) {
    const v = clampBrightness(pct)
    if (v === this.brightness) return
    this.brightness = v
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    this.send({ op: 'matrix.brightness', args: { brightness: v } })
  }

  getBrightness(): number {
    return this.brightness
  }

  /**
   * 画面左右翻转 —— 插头在右边时开.
   *
   * 不用重连, 下一帧就换.
   */
  setFlip(flip: boolean) {
    this.flip = flip
  }

  /**
   * 改版面 (琴键区高度 / 音符大小).
   *
   * 不用重连 —— 渲染器下一帧就用新的版面.
   */
  setLayout(layout: Partial<PanelLayout>) {
    this.renderer.setLayout(layout)
  }

  /**
   * 改配色 (左手 / 右手 / 命中 / 黑键).
   *
   * 不用重连 —— 渲染器下一帧就用新的颜色.
   */
  setColors(colors: Partial<LedScreenColors>) {
    this.renderer.setColors(colors)
  }

  // ---- 连接 ----

  private open() {
    if (this.stopped || this.replaced) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch (e) {
      this.opts.onStatus?.(false, `连不上: ${(e as Error)?.message ?? e}`)
      this.scheduleRetry()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      if (this.stopped) {
        ws.close()
        return
      }
      this.opts.onStatus?.(true, null)
      if (this.opts.token) {
        this.send({ op: 'auth', args: { token: this.opts.token } })
      }
      this.sendInit()
      this.startLoop()
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data)
        if (msg.ok === false && msg.error && !String(msg.error).startsWith('unknown op: auth')) {
          console.warn('[screen]', msg.error)
        }
        // 面板真实像素尺寸跟这边发出去的帧对不上 —— 面板右侧/下方会有
        // 一条永远收不到数据的区域 (保持上一帧颜色 = 看着像随机像素乱闪).
        // 这是**服务端**的硬件参数 (MATRIX_COLS/ROWS) 跟前端几何不一致,
        // 调 UI 没用, 得改树莓派那边的环境变量 (见 docs/deployment.md §1.7).
        if (msg.ok && msg.result && msg.result.mismatch) {
          const hw = msg.result.hardware ?? {}
          console.warn(
            `[screen] 面板尺寸对不上: 硬件 ${hw.width}x${hw.height}, ` +
              `这边在发 ${msg.result.width}x${msg.result.height} —— ` +
              `面板右侧/下方会缺一块 (残影像随机像素). ` +
              `改树莓派的 MATRIX_COLS / MATRIX_ROWS / MATRIX_CHAIN_PER_SCREEN`,
          )
        }
      } catch {}
    }
    ws.onerror = () => {}
    ws.onclose = (ev) => {
      this.stopLoop()
      if (this.ws === ws) this.ws = null
      if (this.stopped) return
      // 1012 = 被另一个标签页接管了. 别再重连 ——
      // 两个客户端都往面板推帧的话, 面板会在两路画面之间来回跳 (抖 + 闪).
      if (ev.code === REPLACED_CODE) {
        this.replaced = true
        this.opts.onStatus?.(false, '面板被另一个标签页接管了 —— 关掉那个标签页, 再刷新本页')
        return
      }
      this.opts.onStatus?.(false, '连接断开')
      this.scheduleRetry()
    }
  }

  private scheduleRetry() {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, RETRY_MS)
  }

  private send(obj: Record<string, unknown>) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ id: this.nextId++, ...obj }))
  }

  private sendInit() {
    const screens = this.screens
    // init 可能会重启 led_anim (菊花链长度变了 -> 屏被清空) —— 下一帧必须
    // 无条件重发, 不能因为「内容跟上一帧一样」被跳过, 否则屏就一直黑着.
    this.lastFrame = null
    this.lastSentAt = 0
    this.send({
      op: 'matrix.init',
      args: {
        width: SCREEN_W * screens.length,
        height: SCREEN_H,
        screens,
        // 亮度跟着 init 走 —— 重连/刷新页面之后设置不会丢.
        brightness: this.brightness,
      },
    })
  }

  // ---- 推帧 ----

  private startLoop() {
    this.stopLoop()
    this.nextSendAt = 0
    // 新连接 / 重连: 设备那头是空的 → 下一帧必须真发 (不能因为「跟上一帧
    // 一样」被跳过), 否则重连之后屏幕会一直停在上次的内容上.
    this.lastFrame = null
    this.lastSentAt = 0
    const tick = () => {
      const ws = this.ws
      if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) return
      this.raf = requestAnimationFrame(tick)
      const now = performance.now()
      const interval = 1000 / Math.max(1, this.fps)
      // 用「截止时间」推进, 别用「距上次发送多久」——
      // 后者会把发送时刻钉死在 rAF 网格上: 掉一个 rAF 就变成 50ms 一帧,
      // 音符走两步才动一下, 看起来就是一顿一顿地抖.
      if (this.nextSendAt === 0) this.nextSendAt = now
      if (now < this.nextSendAt) return
      this.nextSendAt += interval
      // 落后太多 (标签页挂起过/主线程卡过) 就重新对表, 别攒出一串补发.
      if (this.nextSendAt < now - interval) this.nextSendAt = now
      this.sendFrame()
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stopLoop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }

  private sendFrame() {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    let frame: Uint8Array
    try {
      this.renderer.render(this.opts.getSource())
      frame = this.renderer.extract(this.screens, this.flip)
    } catch (e) {
      console.warn('[screen] 推帧失败:', e)
      return
    }
    const now = performance.now()
    if (!shouldSendFrame(this.lastFrame, this.lastSentAt, now, frame, ws.bufferedAmount)) {
      // 分开记账: 「缓冲满」和「画面没变」是两种完全不同的问题.
      if (ws.bufferedAmount > frame.length) this.droppedFrames++
      else this.skippedFrames++
      return
    }
    try {
      ws.send(frame)
    } catch (e) {
      console.warn('[screen] ws.send 失败:', e)
      return
    }
    // ★ 只在真的发出去之后才更新「上一帧」—— 发送抛异常时不能把它记成已发,
    //   否则这段画面就再也补不上了.
    this.lastFrame = frame
    this.lastSentAt = now
  }
}

/**
 * 点阵屏的 WS 地址.
 *
 * - HTTPS 部署 -> 同源 wss://<当前页 host>/led-proxy/screen (服务器反代到树莓派).
 * - 否则 -> 直连 ws://<host>:8081.
 */
export function buildScreenWsUrl(host: string, port = 8081, proxyPath?: string): string {
  if (proxyPath) {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${window.location.host}${proxyPath}`
  }
  return `ws://${host}:${port}`
}

/** 反代路径 —— 屏幕这条跟灯带不是一台设备, 得单开一个路径. */
export const SCREEN_PROXY_PATH = '/led-proxy/screen'
