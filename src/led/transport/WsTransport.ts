// WebSocket 传输 —— 树莓派上的 ws_led_bridge.py.
//
// 行为跟以前 LedController 里内联的 WS 逻辑完全一样, 只是搬出来了.
import type { LedResponse, LedTransport } from '../LedTransport'

/**
 * 建连总上限 (ms) —— 握手 (auth → init → off) 拖太久就放弃.
 *
 * 超时消息里带上 url, 用户能一眼看出是「地址填错」还是「树莓派没开机」.
 *
 * ★ 2026-10-28 从 10s 提到 20s: 握手三步每步最多 WS_HANDSHAKE_TIMEOUT_MS
 *   (5s), 三步串起来最坏 15s —— 建连上限必须盖得住它, 否则先报的是
 *   「WebSocket 连不上」这种误导性的错.
 */
export const WS_CONNECT_TIMEOUT_MS = 20000

/**
 * 握手命令 (auth / init / off) 的单条超时 (ms).
 *
 * ★ 2026-10-28 从 1s 提到 5s. 起因是用户报的「前端显示 rpc init timeout」:
 *   树莓派那边 led_remote 的「踢人」逻辑 (shutdown+close) 会把旧连接**正在
 *   处理的那条命令的回包**一起销毁, 前端等不到回包, 1 秒后就报超时.
 *   现在踢人改成只关读方向 (回包保得住), 超时也放宽 —— 两边都留出余量,
 *   设备忙 (比如正在刷一整帧) 的时候不至于误判成「连不上」.
 */
export const WS_HANDSHAKE_TIMEOUT_MS = 5000

/**
 * 运行时命令 (show / off / marquee) 的单条超时 (ms).
 *
 * 保持 1s: 灯带每帧都要发 show, 等太久会直接卡住节拍. 真的丢命令了
 * 1 秒足够暴露出来.
 */
export const WS_RPC_TIMEOUT_MS = 1000

/**
 * drain() 的兜底超时 (ms) —— 等在途命令归零最多等这么久.
 *
 * ★ 2026-11-13: 以前 drain() 没有上限, 断链时更是个死循环 (见 drain()).
 *   加个上限: 设备活着但回包丢了 (桥把某条命令的回包吞了) 的时候,
 *   allOff()/resync() 不能永远挂着 —— 宁可灯带慢半秒灭, 也不能把页面卡死.
 */
export const WS_DRAIN_TIMEOUT_MS = 2000

export interface WsTransportOpts {
  /** ws://host:port 或 wss://host/path */
  url: string
  /** 共享 token. 空 = 不带 token (旧版桥的行为). */
  token?: string
  /** init 用的 count / pin. */
  count: number
  pin: number
  /**
   * 设备端有没有跑马灯 (`marquee` op).
   *
   * ESP32 有 (固件 ble_led.cpp 的 led.marquee), 树莓派没有 (回
   * "unknown op: 'marquee'") —— 所以树莓派那边只能前端逐帧画.
   */
  supportsDeviceMarquee?: boolean
  /** 状态栏/设置里显示的名字. */
  label?: string
}

export class WsTransport implements LedTransport {
  readonly name: string
  /**
   * 树莓派 daemon 的 led.set_many 只写 _buf, 不刷灯带 —— 必须另外发 show.
   * (led_remote.py: `_op_led_set_many` 里只有 `self._buf[i] = ...`)
   *
   * ESP32 新固件也一样 (只写缓冲, 刷灯带由 show 负责) —— 两边一致.
   */
  readonly setManyShows = false
  /** 设备端跑马灯 —— 只有 ESP32 有. */
  readonly supportsDeviceMarquee: boolean
  private ws: WebSocket | null = null
  connected = false
  onDisconnect?: (reason: string) => void
  /**
   * 命令丢了 (回执超时) —— 上层据此把整条灯带重刷一遍.
   *
   * WS 不会像 BLE 那样「静默丢命令」, 但回执超时说明这一条**多半**没执行
   * (设备正忙 / 连接抖动) → 那一帧就没刷出去 → 得重画.
   */
  onCommandError?: (msg: string) => void
  private nextId = 1
  private pending = new Map<number, { resolve: (r: LedResponse) => void; reject: (e: Error) => void }>()
  /** 已发出但还没收到响应的命令数 —— drain() 等它归零. */
  private inFlight = 0
  /** 等 drain() 的人. */
  private drainWaiters: Array<() => void> = []

  constructor(private opts: WsTransportOpts) {
    this.name = opts.label ?? 'WebSocket'
    this.supportsDeviceMarquee = opts.supportsDeviceMarquee ?? false
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const url = this.opts.url
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.ws = ws
      // 新连接 = 新账本 —— 上一条连接欠下的在途计数不能带过来.
      this.resetInFlight('reconnecting')
      // ★ 建连总上限 (ms). 握手是 auth → init → off 三步, 每步各自有 1 秒
      //   超时; 加上浏览器连不可达地址时 'error' 可能迟到, 最坏能拖十几秒
      //   还没结果 —— 期间 UI 一直转圈. 现在有硬上限, 超了就明确报错.
      const timer = setTimeout(() => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        try { ws.close() } catch {}
        reject(new Error(`WebSocket 连不上 (${WS_CONNECT_TIMEOUT_MS / 1000} 秒超时): ${url}`))
      }, WS_CONNECT_TIMEOUT_MS)
      const settle = (fn: () => void) => {
        clearTimeout(timer)
        fn()
      }
      const onError = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        settle(() => reject(new Error(`WebSocket connect failed: ${url}`)))
      }
      const onOpen = () => {
        ws.removeEventListener('error', onError)
        this.connected = true
        ws.addEventListener('message', (e) => this.onMessage(e))
        ws.addEventListener('close', () => {
          // 旧连接的 close 不能影响新连接的账本.
          if (this.ws !== ws) return
          this.connected = false
          // ★ 2026-11-13: 断链时**必须**把在途计数清零.
          //   以前只在 disconnect() 里清 —— 设备端 (树莓派 led_remote) 是单
          //   client 互斥, 第二个客户端连上会把第一个踢掉; 被踢的那条走的是
          //   'close' 事件, 在途计数就永远停在 >0. 接着 drain() 变成死循环
          //   (见 drain()) → 切歌时页面 100% 卡死, Chrome 看门狗最后把标签页
          //   杀掉 (「把浏览器带崩」).
          this.resetInFlight('WebSocket closed')
          this.onDisconnect?.('WebSocket closed')
        })
        // init strip + clear (先鉴权: Pi 上的桥要求第一条消息是 auth)
        // 握手三步都用 WS_HANDSHAKE_TIMEOUT_MS —— 设备正忙的时候多等一会儿.
        const hs = { expectReply: true, timeoutMs: WS_HANDSHAKE_TIMEOUT_MS }
        const init = () =>
          this.send('init', { count: this.opts.count, pin: this.opts.pin }, hs)
            .then(() => this.send('off', {}, hs))
            .then(() => settle(resolve))
            .catch((e) => settle(() => reject(e)))
        const token = this.opts.token
        if (token) {
          // 桥有两种版本: 新的要求首条必须是 auth, 旧的不认识 auth op.
          // auth 被拒时退回直接 init —— 否则旧桥上 LED 完全连不上.
          this.send('auth', { token }, hs)
            .then(init)
            .catch(() => {
              console.warn('[led] auth failed, retry without auth')
              init()
            })
        } else {
          init()
        }
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })
  }

  disconnect() {
    if (this.ws) {
      try { this.ws.close() } catch {}
    }
    this.ws = null
    this.connected = false
    this.resetInFlight('disconnected')
  }

  /**
   * 把「在途」账本清零 —— 所有还没回来的命令一律拒掉.
   *
   * 在途的命令要**拒掉**, 不能直接丢 ——
   * 丢了的话那些 promise 永远不 settle, 等着它们的人 (follower 的
   * await show / drain) 会跟着一起卡死.
   *
   * 断链 (close 事件)、重连、主动断开 —— 三条路都得走这里.
   * 漏了哪条, 在途计数就会永远停在 >0, drain() 跟着挂死.
   */
  private resetInFlight(reason: string) {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) p.reject(new Error(reason))
    this.inFlight = 0
    this.releaseDrainWaiters()
  }

  send(
    op: string,
    args: Record<string, any>,
    opts?: { expectReply?: boolean; timeoutMs?: number },
  ): Promise<void> {
    return this.request(op, args, opts).then(() => {})
  }

  /**
   * 发一条命令, 等回包 —— 回包原样返回 (status 那些字段要靠它).
   *
   * 不等回执时 (expectReply=false) 立刻 resolve, 但**照样要记账** ——
   * 否则 drain() 不知道这条命令设备还没执行.
   */
  private request(
    op: string,
    args: Record<string, any>,
    opts?: { expectReply?: boolean; timeoutMs?: number },
  ): Promise<LedResponse> {
    if (!this.ws || !this.connected) {
      return Promise.reject(new Error('not connected'))
    }
    const expectReply = opts?.expectReply ?? false
    const timeoutMs = opts?.timeoutMs ?? WS_RPC_TIMEOUT_MS
    const id = this.nextId++
    const msg = JSON.stringify({ id, op, args })
    if (!expectReply) {
      // 不等回执 —— 但**照样要记账**, 否则 drain() 不知道这条命令设备还没执行.
      // 桥会回每条命令的响应 (onMessage 里没人等就丢掉), 所以记一笔就够了.
      this.inFlight++
      try {
        this.ws.send(msg)
      } catch {
        this.inFlight--
        throw new Error('ws send failed')
      }
      return Promise.resolve({ ok: true, id } as LedResponse)
    }
    return new Promise<LedResponse>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r),
        reject: (e) => reject(e),
      })
      this.inFlight++
      try {
        this.ws!.send(msg)
      } catch (e) {
        this.pending.delete(id)
        this.inFlight--
        reject(e as Error)
        return
      }
      // safety timeout (don't block forever on dropped WS)
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          this.inFlight--
          const msg = `rpc ${op} timeout`
          this.onCommandError?.(msg)
          reject(new Error(msg))
        }
      }, timeoutMs)
    })
  }

  /**
   * 问设备「你是谁」—— 树莓派回 {count, physical, pin, ...}, ESP32 回同形的.
   *
   * ★ 这是**唯一的设备校验接口**: 两边都实现了 `status` op, 没有 HTTP 健康
   *   检查端点. pin 字段能认出连的是哪台 (树莓派 18 / ESP32 14).
   */
  async probeStatus(): Promise<Record<string, any> | null> {
    try {
      const resp = await this.request('status', {}, { expectReply: true, timeoutMs: WS_RPC_TIMEOUT_MS })
      return resp as unknown as Record<string, any>
    } catch {
      return null
    }
  }

  private onMessage(e: MessageEvent) {
    try {
      const resp = JSON.parse(e.data) as LedResponse
      const cb = this.pending.get(Number(resp.id))
      // 每条发出去的命令都有回音 —— 在途计数减一 (不管有没有人在等).
      this.inFlight = Math.max(0, this.inFlight - 1)
      if (cb) {
        this.pending.delete(Number(resp.id))
        if (resp.ok === false) cb.reject(new Error(resp.error || 'rpc failed'))
        else cb.resolve(resp)
      }
      if (this.inFlight === 0) this.releaseDrainWaiters()
    } catch {}
  }

  /**
   * 等到所有已发出的命令都被设备消化完.
   *
   * WS 是**请求-响应**模型 —— 桥会回每条命令的响应 (即使调用方没等),
   * 所以 drain 只要等在途计数归零.
   *
   * ★ 2026-11-13: 以前这里是个**死循环** —— 用户报「点一个歌曲切换就完全
   *   卡死, 有时把浏览器带崩」. 原因:
   *   ① 设备端 (树莓派 led_remote) 是单 client 互斥, 第二个客户端连上会
   *      把第一个踢掉 → 被踢的那条走 ws 的 'close' 事件;
   *   ② 断链时在途计数没清 (只在 disconnect() 里清) → inFlight 永远 > 0;
   *   ③ 这个 while 里的 promise 在 !connected 时**立刻** resolve → while
   *      原地空转 → 微任务队列永远排不空 → 主线程 100% 占满 → 页面点不动.
   *   Chrome 的 hung-renderer 看门狗最后直接把标签页杀掉 → 「浏览器带崩」.
   *   切歌会走 LedController.allOff() → await drain() —— 正好撞上.
   *
   * 现在: 断链立刻返回 (计数已经被 close 处理器清零), 再加个兜底超时 ——
   * 设备活着但某条回包丢了的时候, drain 不能永远挂着.
   */
  async drain(): Promise<void> {
    const deadline = Date.now() + WS_DRAIN_TIMEOUT_MS
    while (this.inFlight > 0) {
      if (!this.connected) {
        // 断链了 —— 在途计数已经被 close 处理器清零, 直接走.
        this.inFlight = 0
        return
      }
      const rest = deadline - Date.now()
      if (rest <= 0) {
        // 超时 —— 别把调用方 (allOff / resync) 永远吊着.
        this.inFlight = 0
        this.releaseDrainWaiters()
        return
      }
      await new Promise<void>((resolve) => {
        // 兜底定时器 —— 设备活着但某条回包丢了的时候, 也得有出路.
        const timer = setTimeout(() => {
          const i = this.drainWaiters.indexOf(wake)
          if (i >= 0) this.drainWaiters.splice(i, 1)
          resolve()
        }, rest)
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        this.drainWaiters.push(wake)
        // 连接断了 → 别永远挂着.
        if (!this.connected) {
          this.drainWaiters.pop()
          wake()
        }
      })
    }
  }

  private releaseDrainWaiters() {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const w of waiters) w()
  }
}
