// LED 传输层测试 —— WsTransport
//
// ★ 2026-11-10: 蓝牙那条路整个删了 (ESP32 现在跟树莓派一样跑 WebSocket
//   程序), 所以这个文件只剩 WsTransport —— BLE / BackendTransport 的用例
//   跟着对应的源码一起删掉.
//
// 重点验证几件"不看代码就会踩"的事:
//  1. WsTransport: auth → init → off 的握手顺序; auth 被拒时退回直接 init
//  2. WsTransport: 握手超时 5s / 运行时超时 1s / 建连总超时 20s
//
// ★ 2026-10-26: 以前还有一条「自动挑后端」的用例. 那个「自动」是用户报
//   「换回树莓派但没自动连接」的真凶 —— 配对过但离线的 ESP32 会让
//   gatt.connect() 挂死, 树莓派那条分支永远走不到, 而且不报错、不重试.
//   现在只有一条链路 (WS), 设备由用户在灯带菜单里自己选.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util'
import { WsTransport, WS_CONNECT_TIMEOUT_MS, WS_HANDSHAKE_TIMEOUT_MS } from '../src/led/transport/WsTransport'

// jsdom 环境可能没有 TextEncoder/TextDecoder —— 补上, 源码里也在用.
if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder as any
if (!globalThis.TextDecoder) globalThis.TextDecoder = NodeTextDecoder as any

// ---------------------------------------------------------------------------
// WebSocket 假实现
// ---------------------------------------------------------------------------

class FakeWs {
  static instances: FakeWs[] = []
  sent: string[] = []
  handlers: Record<string, Array<(e: any) => void>> = {}
  readyState = 0

  constructor(public url: string) {
    FakeWs.instances.push(this)
  }
  addEventListener(t: string, fn: (e: any) => void) {
    ;(this.handlers[t] ||= []).push(fn)
  }
  removeEventListener(t: string, fn: (e: any) => void) {
    this.handlers[t] = (this.handlers[t] || []).filter((f) => f !== fn)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.emit('close', {})
  }
  emit(t: string, e: any) {
    for (const fn of this.handlers[t] || []) fn(e)
  }
  /** 模拟服务端收到一条消息并回应. */
  reply(msg: any) {
    this.emit('message', { data: JSON.stringify(msg) })
  }
}

beforeEach(() => {
  FakeWs.instances = []
  ;(globalThis as any).WebSocket = FakeWs as any
})

afterEach(() => {
  vi.useRealTimers()
})

function lastWs(): FakeWs {
  return FakeWs.instances[FakeWs.instances.length - 1]
}

// ---------------------------------------------------------------------------
// WsTransport
// ---------------------------------------------------------------------------

describe('WsTransport', () => {
  it('连上后先 auth 再 init 再 off (有 token 时)', async () => {
    const t = new WsTransport({ url: 'ws://x:8080', token: 'tok', count: 176, pin: 18 })
    const p = t.connect()
    const ws = lastWs()
    ws.emit('open', {})

    // 服务端回应 auth
    ws.reply({ id: 1, ok: true, authed: true })
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(1))

    // init 的参数
    const initMsg = JSON.parse(ws.sent[1])
    expect(initMsg.args).toEqual({ count: 176, pin: 18 })
    expect(JSON.parse(ws.sent[0]).op).toBe('auth')

    // 回应 init → 才轮到 off
    ws.reply({ id: initMsg.id, ok: true, result: { count: 176, pin: 18 } })
    await vi.waitFor(() => expect(ws.sent.length).toBe(3))
    const ops = ws.sent.map((s) => JSON.parse(s).op)
    expect(ops).toEqual(['auth', 'init', 'off'])

    const offMsg = JSON.parse(ws.sent[2])
    ws.reply({ id: offMsg.id, ok: true })
    await p
    expect(t.connected).toBe(true)
  })

  it('auth 被拒时退回直接 init (旧版桥不认识 auth op)', async () => {
    const t = new WsTransport({ url: 'ws://x:8080', token: 'bad', count: 176, pin: 18 })
    const p = t.connect()
    const ws = lastWs()
    ws.emit('open', {})
    await vi.waitFor(() => expect(ws.sent.length).toBe(1))

    // auth 被拒
    ws.reply({ id: 1, ok: false, error: 'bad token' })
    await vi.waitFor(() => expect(ws.sent.length).toBe(2))
    expect(JSON.parse(ws.sent[1]).op).toBe('init')

    const initMsg = JSON.parse(ws.sent[1])
    ws.reply({ id: initMsg.id, ok: true })
    await vi.waitFor(() => expect(ws.sent.length).toBe(3))
    const offMsg = JSON.parse(ws.sent[2])
    ws.reply({ id: offMsg.id, ok: true })
    await p
  })

  it('没有 token 时直接 init', async () => {
    const t = new WsTransport({ url: 'ws://x:8080', count: 176, pin: 18 })
    const p = t.connect()
    const ws = lastWs()
    ws.emit('open', {})
    await vi.waitFor(() => expect(ws.sent.length).toBe(1))
    expect(JSON.parse(ws.sent[0]).op).toBe('init')
    const initMsg = JSON.parse(ws.sent[0])
    ws.reply({ id: initMsg.id, ok: true })
    await vi.waitFor(() => expect(ws.sent.length).toBe(2))
    const offMsg = JSON.parse(ws.sent[1])
    ws.reply({ id: offMsg.id, ok: true })
    await p
  })

  // ★ 2026-10-28: 用户报的「前端显示 rpc init timeout」.
  //   握手 (auth/init/off) 的单条超时以前是 1 秒 —— 树莓派那边稍慢一点
  //   (或者回包在「踢人」那一下被销毁) 就误报成「连不上」.
  //   现在握手给 5 秒, 运行时命令仍然 1 秒 (不能拖慢节拍).
  it('握手里的 init 迟迟不回 → 5 秒才报超时, 1 秒时不能误报', async () => {
    vi.useFakeTimers()
    try {
      const t = new WsTransport({ url: 'ws://x:8080', count: 176, pin: 18 })
      const p = t.connect()
      const ws = lastWs()
      ws.emit('open', {})
      expect(ws.sent.length).toBe(1)
      expect(JSON.parse(ws.sent[0]).op).toBe('init')

      let err: any = null
      p.catch((e) => { err = e })

      // 1 秒 —— 以前就是这里报「rpc init timeout」的
      await vi.advanceTimersByTimeAsync(1000)
      expect(err, '1 秒就报超时 —— 握手超时不该这么短').toBeNull()

      // 到 5 秒才真的超时
      await vi.advanceTimersByTimeAsync(WS_HANDSHAKE_TIMEOUT_MS)
      expect(err).toBeTruthy()
      expect(String(err.message)).toMatch(/rpc init timeout/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('运行时的 show 迟迟不回 → 1 秒就超时 (不能被握手的 5 秒拖慢)', async () => {
    const t = new WsTransport({ url: 'ws://x:8080', count: 176, pin: 18 })
    const p = t.connect()
    const ws = lastWs()
    ws.emit('open', {})
    await vi.waitFor(() => expect(ws.sent.length).toBe(1))
    ws.reply({ id: JSON.parse(ws.sent[0]).id, ok: true })
    await vi.waitFor(() => expect(ws.sent.length).toBe(2))
    ws.reply({ id: JSON.parse(ws.sent[1]).id, ok: true })
    await p

    vi.useFakeTimers()
    try {
      let err: any = null
      t.send('show', {}, { expectReply: true }).catch((e) => { err = e })
      await vi.advanceTimersByTimeAsync(999)
      expect(err).toBeNull()
      await vi.advanceTimersByTimeAsync(2)
      expect(err).toBeTruthy()
      expect(String(err.message)).toMatch(/rpc show timeout/)
    } finally {
      vi.useRealTimers()
    }
  })

  // 设备地址填错 / 设备没开机 → 建连总超时 (20 秒) 后明确报错, 消息里带 url.
  it('连不上时 20 秒后报错, 消息里带 url', async () => {
    vi.useFakeTimers()
    try {
      // 假 WS 永远不发 'open' 也不发 'error' —— 模拟连不上的地址
      const t = new WsTransport({ url: 'ws://unreachable:8080', count: 176, pin: 18 })
      const p = t.connect()
      const rejected = expect(p).rejects.toThrow(/unreachable/)
      await vi.advanceTimersByTimeAsync(WS_CONNECT_TIMEOUT_MS + 1000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
