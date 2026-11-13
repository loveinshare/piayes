// LED 传输层 —— drain() 死循环回归测试
//
// ★ 2026-11-13: 用户报的「点一个歌曲切换就完全卡死, 有时把浏览器带崩」.
//
// 根因链:
//   1) 设备端 (树莓派 led_remote) 是**单 client 互斥** —— 第二个客户端连上
//      会把第一个踢掉. 本机 dev 页 + 公网页同时开着 = 互相踢.
//   2) 被踢掉的那条连接走的是 ws 的 'close' 事件 —— 之前**只在 disconnect() 里**
//      清在途计数 (inFlight), 断链这条路没清 → inFlight 永远 > 0.
//   3) 切歌会走 LedController.allOff() → await transport.drain().
//      drain() 以前是 `while (inFlight > 0) { await 一个立刻 resolve 的 promise }`
//      —— 断链时 (connected=false) 这个 promise **立刻** resolve, 于是 while
//      变成**死循环**: 微任务队列永远排不空 → 主线程 100% 占满 →
//      整个页面点不动 (「完全卡死」), Chrome 的 hung-renderer 看门狗最后
//      直接杀掉这个标签页 (「带崩整个浏览器」).
//
// 修法: 断链时把在途计数清零; drain() 遇到断链立刻返回, 不转圈; 再加个
//       兜底超时 (设备活着但回包丢了的时候, drain 不能永远挂着).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { WsTransport } from '../src/led/transport/WsTransport'

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
  reply(msg: any) {
    this.emit('message', { data: JSON.stringify(msg) })
  }
}

beforeEach(() => {
  FakeWs.instances = []
  ;(globalThis as any).WebSocket = FakeWs as any
})

function lastWs(): FakeWs {
  return FakeWs.instances[FakeWs.instances.length - 1]
}

/** 连上并把握手 (init/off) 走完. */
async function connected(): Promise<{ t: WsTransport; ws: FakeWs }> {
  const t = new WsTransport({ url: 'ws://x:8080', count: 176, pin: 18 })
  const p = t.connect()
  const ws = lastWs()
  ws.emit('open', {})
  await vi.waitFor(() => expect(ws.sent.length).toBe(1))
  ws.reply({ id: JSON.parse(ws.sent[0]).id, ok: true })
  await vi.waitFor(() => expect(ws.sent.length).toBe(2))
  ws.reply({ id: JSON.parse(ws.sent[1]).id, ok: true })
  await p
  return { t, ws }
}

describe('WsTransport.drain —— 断链后不能死循环', () => {
  it('连接被踢掉 (close 事件) 后, drain() 立刻返回而不是转圈', async () => {
    const { t, ws } = await connected()

    // 发一条**不等回执**的命令 (set_many 就是这种) → 在途计数 +1
    void t.send('set_many', { pixels: [] })
    expect(ws.sent.length).toBe(3)

    // 设备端把这条连接踢了 —— 回包永远不会再来
    ws.emit('close', {})
    expect(t.connected).toBe(false)

    // 用微任务看门狗兜底: 死循环的话它会在 2000 轮微任务后判负.
    // (死循环会把事件循环占满, 定时器都跑不了 —— 所以看门狗也必须是微任务.)
    const watchdog = (async () => {
      for (let i = 0; i < 2000; i++) await Promise.resolve()
      throw new Error('drain() 没返回 —— 死循环')
    })()

    const result = await Promise.race([
      t.drain().then(() => 'drained' as const),
      watchdog.then(() => 'watchdog' as const, () => 'HANG' as const),
    ]).catch(() => 'HANG' as const)

    // 收尾: 把可能还在转的 while 停下来 (disconnect 会把 inFlight 清零)
    t.disconnect()

    expect(result, 'drain() 必须返回 —— 否则切歌时页面直接卡死').toBe('drained')
  })

  it('断链后重连, 在途计数不残留 (旧连接的债不能带到新连接上)', async () => {
    const { t, ws } = await connected()

    void t.send('set_many', { pixels: [] })
    ws.emit('close', {}) // 被踢了, 回包永远不来

    // 重连
    const p2 = t.connect()
    const ws2 = lastWs()
    ws2.emit('open', {})
    await vi.waitFor(() => expect(ws2.sent.length).toBe(1))
    ws2.reply({ id: JSON.parse(ws2.sent[0]).id, ok: true })
    await vi.waitFor(() => expect(ws2.sent.length).toBe(2))
    ws2.reply({ id: JSON.parse(ws2.sent[1]).id, ok: true })
    await p2

    // 新连接上再发一条 + 收回包 → 在途计数应该能归零
    void t.send('show', {}, { expectReply: true })
    const showMsg = JSON.parse(ws2.sent[2])
    ws2.reply({ id: showMsg.id, ok: true })

    await expect(
      Promise.race([
        t.drain().then(() => 'drained'),
        new Promise((r) => setTimeout(() => r('TIMEOUT'), 1500)),
      ]),
    ).resolves.toBe('drained')
  })
})
