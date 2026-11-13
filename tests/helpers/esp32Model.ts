// ESP32-S3 固件模拟器 —— 照着 firmware/esp32s3/src/{ble_led,ws_led}.cpp 的行为写的.
//
// ★ 2026-11-10: 从「BLE 形状」改成「**WS 形状**」.
//
//   以前这个模型是 BLE GATT 设备模型 (led.xxx op + 嵌套 result), 因为前端
//   那时有一条 Web Bluetooth 的路. 现在蓝牙那条路**整个删了** —— ESP32 跟
//   树莓派一样跑 WebSocket 程序 (端口 8080, 裸 op: init/set/set_many/show/
//   off/ping/status/marquee), 所以这个模型改成模拟固件的 **WS 面**:
//
//     主机 → {"id":N,"op":"set_many","args":{...}}
//     设备 → {"ok":true,"set":80,"id":N}      ← 树莓派形状 (字段摊平在顶层)
//
//   这跟树莓派那边 ws_led_bridge.py → led_remote.py 讲的是**同一套协议**
//   (固件的 ws_led.cpp: piReply() 就是照着树莓派的回包形状写的).
//   于是同一个模型既能当「ESP32 over WS」, 也能当一致性对照.
//
// 为什么需要它: 用户报的 bug (跑马灯走了十多秒 / 灯异常闪 / 跑完还有灯亮着)
//   只有在**真设备**上才复现 —— 硬件不在手边就没法验证. 这个模型把固件最
//   关键的几个行为搬进 JS, 让 WsTransport (真代码) 跑在它上面, 就能在 CI 里
//   复现并钉住.
//
// 照搬的固件行为 (每条都标了固件里的出处):
//
//  1. **像素缓冲 vs 物理灯带** (ble_led.cpp: ledStripSetPixel / g_strip.show):
//     - `set` / `set_many` **只写缓冲**, **不** show —— 要另发一条 `show`
//       才推给灯带. 跟树莓派端 led_remote.py 一个语义.
//     - `show` 才把缓冲推出去.
//     - `off` 清空**整个物理**缓冲并 show.
//
//  2. **物理灯数 / 逻辑灯数分开**: 一帧永远推 `physical` 颗 (WS2811 串联,
//     推短了尾巴那截会留着上一帧的颜色), 逻辑灯数只决定「允许写哪几颗」.
//
//  3. **`set_many` 是原子的**: 先全校验再写 —— 有一个下标越界就整条不写.
//
//  4. **`led.marquee` 在板子上跑完整段动画** (每帧一次 show).
//
//  5. **rgb 超范围按 & 0xFF 截断** (跟树莓派端一个行为).
//
//  6. **init 的引脚是编译期固定的**: 请求的 pin 一律忽略, 回报本机的 14.
//
//  7. **未知 op 回 "unknown op: 'xxx'"** —— 跟树莓派那边一个措辞.
//     `marquee` 在树莓派那边也是这个回包 (设备指纹, 见 docs/esp32-pi-parity.md).

/** 假 WebSocket —— 直连到模型, 不走真网络 (省一个端口, 也更快). */
type Handler = (e: any) => void

/** 模型注册表 —— URL 里的 id 决定连的是哪个模型. */
const models = new Map<string, Esp32Model>()
let modelSeq = 0

export interface Esp32ModelOpts {
  /** 逻辑灯数 (固件的白名单 176 / 352). */
  count?: number
  /**
   * 物理灯数 —— 一帧实际推出去的颗数.
   *
   * 默认 352 = 固件 platformio.ini 里的 LED_PHYSICAL_COUNT (两条灯带串联).
   */
  physical?: number
  /** 灯带引脚 (固件编译期固定 14). */
  pin?: number
  /** 固件是否支持 marquee (老固件没有 → 回 unknown op, 前端应回退). */
  supportsMarquee?: boolean
  /**
   * 新固件语义 (默认 true): set / set_many **只写缓冲**, 要另发 show.
   * false = 老固件 (set_many 内部自己 show).
   */
  bufferOnly?: boolean
  /**
   * 同时点亮的颗数上限 (固件的 LED_MAX_LIT).
   *
   * 0 = 不限 (新固件默认, 跟树莓派一致). 30 = 旧固件那个写死的值 ——
   * 固件的 applyMaxLit() 会把**下标最大**的若干颗灭掉 (双色带的上灯带
   * 恰好是下标最大的那截 → 上灯带「自己灭一半」).
   */
  maxLit?: number
  /**
   * 一帧实际推出去的颗数 (WS2811 是串联的!).
   *
   * 默认 = 物理灯数 (正确做法). 传 176 = 旧固件那个 bug —— 链上接了 352 颗
   * 却只推 176 颗, 后面那截的移位寄存器收不到数据, **保留上一帧的颜色**
   * (残留鬼影).
   */
  frameLength?: number
}

export interface Esp32Model {
  /** 连这个模型用的 URL (传给 WsTransport). */
  url: string
  /** 执行过的 op 序列. */
  executed: string[]
  /**
   * 设备端的像素缓冲 (set / set_many 写的是这里).
   *
   * 只有 `show` 才会把它推给物理灯带.
   */
  buffer: Array<[number, number, number]>
  /** 物理灯带上真正亮着的 (只有 show / off / marquee 会改它). */
  pixels: Array<[number, number, number]>
  /** show 执行了几次 —— 「一帧只推一次」的计数. */
  shows: number
  /** 每次 marquee 实际画了几帧. */
  marqueeFrames: number[]
  /** 丢掉这些 id 的响应 (模拟回执丢包). */
  dropReplies: Set<number | string>
  /** 丢掉**所有**响应 (模拟回执整体丢失; 可随时开关). */
  dropAllReplies: boolean
  /** 现在物理灯带上亮着的像素下标. */
  litIndices(): number[]
  /** 现在设备缓冲里亮着的像素下标 (还没推给灯带). */
  bufferIndices(): number[]
  /** 把假 WebSocket 装到 globalThis 上 (连这个模型用). */
  install(): void
  /** 处理一条命令 → 回包 (假 WebSocket 内部用). */
  handle(line: string): Record<string, any>
}

/**
 * 造一个 ESP32 固件模拟器 (WS 形状).
 */
export function createEsp32Model(opts: Esp32ModelOpts = {}): Esp32Model {
  // 灯数是**运行期可改**的 (固件 ble_led.cpp: ledStripSetCount) —— 白名单
  // (176, 352), 不在白名单里的 count 固件会直接报错.
  const ALLOWED_COUNTS = [176, 352]
  let count = opts.count ?? 176
  // 物理灯数是编译期固定的 (固件 LED_PHYSICAL_COUNT) —— 一帧永远推这么多.
  const physical = opts.physical ?? 352
  const pin = opts.pin ?? 14
  const supportsMarquee = opts.supportsMarquee ?? true
  const bufferOnly = opts.bufferOnly ?? true
  /** 固件的 LED_MAX_LIT (0 = 不限). */
  const maxLit = opts.maxLit ?? 0
  /**
   * 一帧推出去的颗数 (WS2811 串联 → 推短了尾巴那截保留上一帧的颜色).
   * 默认 = 物理灯数 (正确).
   */
  const frameLength = Math.min(opts.frameLength ?? physical, physical)
  /** 固件的像素数组上限 (ble_led.cpp: static int idx[1024]). */
  const MAX_PIXELS = 1024
  /**
   * 跑马灯窗口上限 (固件 ble_led.cpp: MARQUEE_WINDOW_MAX).
   *
   * ★ 2026-11-11: 固件那边数组只有 64 字节, window 是**客户端给的** ——
   *   超了就把栈冲掉 (实测 window=176 会把循环变量打烂 → 死循环).
   *   现在固件直接回 "window too large", 这个模型得跟着回同样的错.
   */
  const MARQUEE_WINDOW_MAX = 64

  const id = `m${++modelSeq}`
  const url = `ws://esp32-sim/${id}`

  // 固件的两个数组 (g_strip 的像素缓冲 / 物理灯带上的状态)
  const buffer: Array<[number, number, number]> = Array.from({ length: physical }, () => [0, 0, 0])
  const pixels: Array<[number, number, number]> = Array.from({ length: physical }, () => [0, 0, 0])
  const executed: string[] = []
  const marqueeFrames: number[] = []
  let shows = 0
  let setsSinceShow = 0
  let lastShowAt: number | null = null
  const dropReplies = new Set<number | string>()
  let dropAllReplies = false

  /** rgb 超范围 → 按 & 0xFF 截断 (跟树莓派端 led_remote.py 一个行为). */
  const rgb = (v: unknown): number => (Number(v) || 0) & 0xff

  /**
   * 功耗上限 (固件 ws2811_bitbang.cpp: applyMaxLit).
   *
   * 超了上限就把**下标最大**的若干颗灭掉 —— 这正是旧固件「上灯带只亮一半」
   * 的根因 (双色带的上灯带是下标最大的那截).
   *
   * 0 = 不限 (新固件默认, 跟树莓派一致).
   */
  const applyMaxLit = () => {
    if (maxLit <= 0) return
    let lit = 0
    for (let i = 0; i < physical; i++) {
      const p = buffer[i]
      if (p[0] || p[1] || p[2]) lit++
    }
    if (lit <= maxLit) return
    for (let i = physical - 1; i >= 0 && lit > maxLit; i--) {
      const p = buffer[i]
      if (p[0] || p[1] || p[2]) {
        p[0] = 0
        p[1] = 0
        p[2] = 0
        lit--
      }
    }
  }

  /**
   * 把缓冲推给物理灯带 (固件的 g_strip.show()).
   *
   * 只推 `frameLength` 颗 —— WS2811 是串联的, 推短了后面那截的移位寄存器
   * 收不到数据, **保留上一帧的颜色** (残留鬼影).
   */
  const pushOut = () => {
    applyMaxLit()
    for (let i = 0; i < frameLength; i++) {
      const b = buffer[i]
      pixels[i] = [b[0], b[1], b[2]]
    }
    shows++
    setsSinceShow = 0
    lastShowAt = Date.now()
  }

  /** 写一颗像素到缓冲 —— 超出逻辑范围直接忽略 (固件会先做边界校验). */
  const writeBuffer = (index: number, r: number, g: number, b: number) => {
    if (index < 0 || index >= count) return
    buffer[index] = [r, g, b]
  }

  /** 设备侧跑马灯 (ble_led.cpp: marqueeRun) —— 同步跑完, 返回帧数. */
  const runMarquee = (window: number, step: number): number => {
    const w = Math.max(1, Math.min(64, window || 6))
    const st = Math.max(1, step || 2)
    for (let i = 0; i < physical; i++) {
      buffer[i] = [0, 0, 0]
      pixels[i] = [0, 0, 0]
    }
    let frames = 0
    for (let pos = 0; pos < count; pos += st) {
      for (let i = pos - st - w + 1; i <= pos - w; i++) {
        if (i >= 0 && i < count) {
          buffer[i] = [0, 0, 0]
          pixels[i] = [0, 0, 0]
        }
      }
      for (let k = 0; k < w; k++) {
        const i = pos - k
        if (i >= 0 && i < count) {
          buffer[i] = [50, 0, 200]
          pixels[i] = [50, 0, 200]
        }
      }
      frames++
      shows++
    }
    // 收尾清屏 (固件 marqueeRun 最后 clear + show)
    for (let i = 0; i < physical; i++) {
      buffer[i] = [0, 0, 0]
      pixels[i] = [0, 0, 0]
    }
    marqueeFrames.push(frames)
    return frames
  }

  /**
   * 处理一条命令, 回**树莓派形状**的回包 (字段摊平在顶层).
   *
   * 这就是固件 ws_led.cpp 的 piReply() 干的事 —— 主机只读 ok / id,
   * 两种形状都能跑, 但对外长得一样才有「一致性」可言.
   */
  const handleCommand = (line: string): Record<string, any> => {
    let cmd: any
    try {
      cmd = JSON.parse(line)
    } catch {
      return { ok: false, error: 'bad json' }
    }
    const id = cmd?.id
    const op = String(cmd?.op ?? '')
    const args = cmd?.args ?? {}
    executed.push(op)

    const ok = (fields: Record<string, any> = {}) => ({ ok: true, ...fields, id })
    const fail = (error: string) => ({ ok: false, error, id })

    switch (op) {
      // 固件新版本: auth 回 ok (树莓派桥配了 token 时也是这个形状).
      case 'auth':
        return ok({ authed: true })
      case 'ping':
        return ok({ pong: true })
      case 'status':
        return ok({
          ready: true,
          count,
          physical,
          pin,
          sets_pending: setsSinceShow,
          last_show_age_s: lastShowAt === null ? null : (Date.now() - lastShowAt) / 1000,
        })
      case 'init': {
        // 固件: count 不在白名单 → 直接报错, 灯带保持原样.
        const want = Number(args.count)
        if (Number.isFinite(want) && want !== count) {
          if (!ALLOWED_COUNTS.includes(want)) return fail('count not allowed')
          // 换**逻辑**灯数 —— 物理缓冲大小不变 (LED_PHYSICAL_COUNT 恒定).
          const shrunk = want < count
          count = want
          if (shrunk) {
            // 逻辑范围之外的那截抹黑 (固件 ledStripSetCount).
            for (let i = count; i < physical; i++) {
              buffer[i] = [0, 0, 0]
              pixels[i] = [0, 0, 0]
            }
          }
        }
        // init 之后灯带是灭的 (固件: g_strip.clear(); g_strip.show()).
        for (let i = 0; i < physical; i++) buffer[i] = [0, 0, 0]
        pushOut()
        // 引脚是编译期固定的 —— 请求的 pin 一律忽略, 回报本机的.
        return ok({ count, physical, pin })
      }
      case 'set': {
        let index = Number(args.i)
        if (!Number.isFinite(index)) index = Number(args.index)
        if (!(index >= 0 && index < count)) {
          return fail(`i ${index} out of [0, ${count})`)
        }
        writeBuffer(index, rgb(args.r), rgb(args.g), rgb(args.b))
        setsSinceShow++
        if (!bufferOnly) pushOut()
        return ok()
      }
      case 'set_many': {
        const px: any[] = Array.isArray(args.pixels) ? args.pixels : []
        if (px.length > MAX_PIXELS) return fail('too many pixels')
        // 原子: 先全部校验, 有一个下标不对就整条不写.
        for (const p of px) {
          let i = Number(p?.i)
          if (!Number.isFinite(i)) i = Number(p?.index)
          if (!(i >= 0 && i < count)) return fail(`i ${i} out of [0, ${count})`)
        }
        for (const p of px) {
          let i = Number(p?.i)
          if (!Number.isFinite(i)) i = Number(p?.index)
          writeBuffer(i, rgb(p.r), rgb(p.g), rgb(p.b))
        }
        setsSinceShow += px.length
        if (!bufferOnly) pushOut()
        return ok({ set: px.length })
      }
      case 'show': {
        const flushed = setsSinceShow
        pushOut()
        return ok({ flushed })
      }
      case 'off': {
        // 清空**整个物理**缓冲并刷出去 (固件: g_strip.clear(); g_strip.show()).
        for (let i = 0; i < physical; i++) buffer[i] = [0, 0, 0]
        pushOut()
        return ok()
      }
      case 'marquee': {
        if (!supportsMarquee) return fail(`unknown op: '${op}'`)
        const win = Number(args.window) || 6
        // ★ 固件: window 超上限直接回错 (arrays 只有 64 字节, 超了会冲掉栈).
        if (win > MARQUEE_WINDOW_MAX) return fail('window too large')
        const frames = runMarquee(win, Number(args.step) || 2)
        return ok({ frames })
      }
      default:
        return fail(`unknown op: '${op}'`)
    }
  }

  const model: Esp32Model = {
    url,
    executed,
    buffer,
    pixels,
    marqueeFrames,
    dropReplies,
    get shows() {
      return shows
    },
    get dropAllReplies() {
      return dropAllReplies
    },
    set dropAllReplies(v: boolean) {
      dropAllReplies = v
    },
    litIndices() {
      return litOf(pixels)
    },
    bufferIndices() {
      return litOf(buffer)
    },
    install() {
      installEsp32WebSocket()
    },
    handle(line: string) {
      return handleCommand(line)
    },
  }

  models.set(id, model)

  // 上一次会话的残留灯 (WS2811 掉电前会锁存最后一帧) —— 那是**物理**状态,
  // 不是设备缓冲里的东西.
  pixels[0] = [0, 0, 200]

  return model
}

function litOf(arr: Array<[number, number, number]>): number[] {
  const out: number[] = []
  for (let i = 0; i < arr.length; i++) {
    const [r, g, b] = arr[i]
    if (r || g || b) out.push(i)
  }
  return out
}

// ---------------------------------------------------------------------------
// 假 WebSocket —— 直连模型, 不走真网络
// ---------------------------------------------------------------------------

class Esp32FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = 0
  private handlers: Record<string, Handler[]> = {}
  private model: Esp32Model | null = null
  private closed = false

  constructor(public url: string) {
    const id = url.split('/').pop() ?? ''
    this.model = models.get(id) ?? null
    // 真 WebSocket 是异步 open 的 —— 这里也异步, 免得测试里的时序跟真机不一样.
    setTimeout(() => {
      if (this.closed) return
      if (!this.model) {
        this.emit('error', { error: new Error('unknown esp32 model: ' + url) })
        this.emit('close', { code: 1006 })
        return
      }
      this.readyState = 1
      this.emit('open', {})
    }, 0)
  }

  addEventListener(t: string, fn: Handler) {
    ;(this.handlers[t] ||= []).push(fn)
  }
  removeEventListener(t: string, fn: Handler) {
    this.handlers[t] = (this.handlers[t] || []).filter((f) => f !== fn)
  }
  send(data: string) {
    if (!this.model) return
    const reply = this.model.handle(data)
    if (this.model.dropAllReplies || this.model.dropReplies.has(reply.id)) return
    setTimeout(() => {
      if (this.closed) return
      this.emit('message', { data: JSON.stringify(reply) })
    }, 0)
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close', { code: 1000 })
  }
  private emit(t: string, e: any) {
    for (const fn of this.handlers[t] || []) fn(e)
  }
}

/**
 * 把假 WebSocket 装到 globalThis 上.
 *
 * jsdom 自带的 WebSocket 也能用, 但我们既要模拟「设备回包」又要模拟
 * 「回执丢包」, 自己写的假实现更好控.
 */
export function installEsp32WebSocket(): void {
  ;(globalThis as any).WebSocket = Esp32FakeSocket
}
