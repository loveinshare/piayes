// LED 灯带传输层抽象.
//
// 上层 (LedController) 只认 "发一条 JSON 命令, 收一条 JSON 响应" 这一件事,
// 底下具体走哪条链路它不关心. 现在只有一条:
//
//   WsTransport —— WebSocket. 树莓派上的 ws_led_bridge.py, 或者 ESP32 新固件
//                 自带的 WS server (端口 8080) —— **协议完全一样**.
//
// ★ 2026-11-10: 蓝牙那条路删了 (旧固件的 Web Bluetooth). ESP32 现在跟树莓派
//   一样跑 WebSocket 程序, 前端用「设备选择器」选连哪台 —— 区别只有 IP 和
//   引脚 (树莓派 18 / ESP32 14), 所以不需要两套传输层.

/** 一条命令的响应. 与树莓派 daemon / ESP32 固件的 JSON 形状一致. */
export interface LedResponse {
  id: number | string
  ok: boolean
  result?: any
  error?: string
}

export interface LedTransport {
  /** 人类可读的名字, 用于 UI 显示当前连的是哪个后端. */
  readonly name: string
  /** 是否已连上. */
  readonly connected: boolean
  /** 建连. 失败要 reject. */
  connect(): Promise<void>
  /** 断开并清理. */
  disconnect(): void
  /**
   * 发一条命令.
   *
   * 两条路径:
   * - **需要响应** (init / off / show): 返回 Promise, 收到响应才 resolve.
   * - **不需要响应** (set / set_many): 立即 resolve —— LED 是"写一次就生效"的
   *   命令, 等响应只会拖慢节拍.
   *
   * 对 WebSocket 来说两种都实现了; 对 BLE 来说设备其实也会回响应,
   * 但没必要等 —— 等了反而让 80 像素一批的 set_many 变慢.
   *
   * `timeoutMs` —— 等回执的上限 (毫秒). WS 这条路认:
   * 握手 (auth/init/off) 给 5 秒, 运行时命令给 1 秒,
   * 设备侧跑马灯给 3 秒 (动画跑完才回执).
   */
  send(
    op: string,
    args: Record<string, any>,
    opts?: { expectReply?: boolean; timeoutMs?: number },
  ): Promise<void>
  /** 后端断了 (WS close) 时通知上层. */
  onDisconnect?: (reason: string) => void
  /**
   * 等到**所有**已发出的命令都被设备消化完.
   *
   * 为什么需要: `send()` 对 set/set_many 是 fire-and-forget (不等回执, 免得拖慢节拍),
   * 所以「off 已经发出去了」≠「off 是设备执行的最后一条」. 后面排队的 set_many
   * 可能在 off 之后才落地 → 灯又被点回来 (用户报的「跑完还有灯亮着」).
   *
   * 跑马灯 / 清灯这类**要保证顺序**的场景, 发完最后一条后必须 drain 一下.
   *
   * 不实现的话 (可选方法): 调用方要自己保证顺序.
   */
  drain?(): Promise<void>
  /**
   * `set_many` 之后设备会不会**自己**把像素刷到灯带上?
   *
   * - 树莓派 daemon: 不会 —— `_op_led_set_many` 只写 `_buf`,
   *   真正的 `strip.show()` 要等单独的 `led.show` 命令.
   * - ESP32 **新**固件 (2026-11-04 起): 也不会 —— `led.set` / `led.set_many`
   *   只写像素缓冲, `led.show` 才推给灯带. `led.init` 的回执里带
   *   `"set_many_shows": false` 告诉主机这件事.
   * - ESP32 **老**固件: 会 —— `led.set_many` 内部直接调 `g_strip.show()`.
   *
   * 不写这个标志的传输层按「会自己刷」处理 (true) —— 那是更安全的一侧
   * (多刷一次最多闪一下, 少刷一次灯就不亮了).
   *
   * ★ 为什么要区分: 「一帧只推一次」才跟树莓派**完全一致**.
   *   设备自己刷的话, 一个动画帧里的多条 set_many 会各自推一次 →
   *   中间状态被看到 = 画面撕裂 (用户报的「异常闪」).
   */
  setManyShows?: boolean
  /**
   * 后端是否支持**设备侧跑马灯** (`marquee` op, 动画在设备上跑完).
   *
   * ESP32 固件支持 (`led.marquee`): 一条命令 0.5s 跑完, 不受网络往返影响.
   * 树莓派 daemon 没有这个 op —— 只能前端逐帧发.
   */
  readonly supportsDeviceMarquee?: boolean
  /**
   * 问设备「你是谁」—— 读 `status` op 的回包 (count / physical / pin).
   *
   * ★ 这是**唯一的设备校验接口**: 树莓派和 ESP32 都实现了 `status`, 但两边
   *   都没有 HTTP 健康检查端点. pin 能认出连的是哪台 (树莓派 18 / ESP32 14).
   */
  probeStatus?(): Promise<Record<string, any> | null>
}
