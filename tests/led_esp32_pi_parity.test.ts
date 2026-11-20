// ESP32 ↔ 树莓派 一致性 —— 换到 ESP32 后用户**完全看不出差别**.
//
// ★ 2026-11-10: 两条链路现在**都是 WebSocket** (协议完全一样), 所以这个文件
//   从「BLE 传输层 vs BLE 设备模型」改成「WS 传输层 vs WS 设备模型」:
//
//     树莓派: 浏览器 → WS(:8080) → ws_led_bridge.py → TCP(:7777) → led_remote.py
//             → rpi_ws281x (PWM+DMA).  set/set_many 只写 _buf, show 才推给灯带.
//     ESP32:  浏览器 → WS(:8080) → 固件 ws_led.cpp (piReply 摊平成树莓派形状)
//             → bit-bang show().  ★ set/set_many 也只写缓冲, show 才推 ——
//             跟树莓派一个语义.
//
//   两者唯一的差别是: 引脚 (树莓派 18 / ESP32 14)、设备端跑马灯 (只有 ESP32 有).
//
// 这个文件把「一致」的部分钉成回归测试. 每条都注明它对应树莓派端的哪一行.
//
// 对照表见 docs/esp32-pi-parity.md.

import { describe, it, expect, beforeEach } from 'vitest'
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util'
import { LedController } from '../src/led/LedController'
import { WsTransport } from '../src/led/transport/WsTransport'
import { createEsp32Model, type Esp32Model } from './helpers/esp32Model'

if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder as any
if (!globalThis.TextDecoder) globalThis.TextDecoder = NodeTextDecoder as any

/** 等一个条件成立 (设备端的执行是异步的). */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 2))
  }
}

/**
 * 连上模拟设备 (走完整的 init / off 握手).
 *
 * count 是**要发给设备的**逻辑灯数 (固件白名单 176 / 352).
 */
async function connect(model: Esp32Model, count = 176) {
  model.install()
  const transport = new WsTransport({ url: model.url, count, pin: 14 })
  await transport.connect()
  model.executed.length = 0
  return transport
}

describe('ESP32 ↔ 树莓派 —— 一致性', () => {
  let model: Esp32Model

  beforeEach(() => {
    model = createEsp32Model()
  })

  // ──────────────────────────────────────────────────────────────────
  // 1. set_many 不自己刷灯带 (树莓派: _op_led_set_many 只写 _buf)
  // ──────────────────────────────────────────────────────────────────
  it('set_many 只写缓冲, show 才刷灯带', async () => {
    const transport = await connect(model)

    // 前端据此知道「设备不自己刷」→ 一帧只推一次.
    expect(transport.setManyShows).toBe(false)

    await transport.send('set_many', { pixels: [{ i: 10, r: 1, g: 2, b: 3 }] })

    // 设备缓冲里有, 物理灯带上还没有.
    expect(model.buffer[10]).toEqual([1, 2, 3])
    expect(model.litIndices()).toEqual([])

    await transport.send('show', {}, { expectReply: true })
    expect(model.litIndices()).toEqual([10])
  })

  // ──────────────────────────────────────────────────────────────────
  // 2. 一帧只推一次 (树莓派: 一帧 = set_many + 一次 show)
  // ──────────────────────────────────────────────────────────────────
  it('上灯带一帧 = 一次 show (不是每条 set_many 都推一次)', async () => {
    const transport = await connect(model, 352)
    const led = new LedController({ transport, count: 352, dualStrip: true })

    const showsBefore = model.shows
    led.setUpperHints([{ midi: 60, hand: 'right' }])
    // 上灯带的下发是排队的 (promise 链) —— 等它真的落到设备上.
    await waitFor(() => model.executed.includes('show'))

    // 上灯带的差量下发 = set_many(灭) → set_many(亮) → show.
    // 设备端只该被推 **一次** (每条 set_many 都推一次 = 画面撕裂).
    const setManys = model.executed.filter((op) => op === 'set_many').length
    expect(setManys).toBeGreaterThanOrEqual(1)
    expect(model.shows - showsBefore).toBe(1)
  })

  // ──────────────────────────────────────────────────────────────────
  // 3. rgb 超范围按 & 0xFF 截断 (树莓派 led_remote.py: r & 0xFF)
  // ──────────────────────────────────────────────────────────────────
  it('rgb 超范围按 & 0xFF 截断, 不报错', async () => {
    const transport = await connect(model)

    await transport.send('set_many', {
      pixels: [{ i: 5, r: 300, g: -1, b: 255 }],
    })

    expect(model.buffer[5]).toEqual([300 & 0xff, -1 & 0xff, 255])
  })

  // ──────────────────────────────────────────────────────────────────
  // 4. 越界 → 整条不写 (原子) + 明确报错
  //    ★ 树莓派端 2026-11-10 也改成原子的 (先全校验再写) —— 两边一致.
  // ──────────────────────────────────────────────────────────────────
  it('有一个像素越界 → 整条 set_many 都不写, 并回错误', async () => {
    const transport = await connect(model)

    await expect(
      transport.send(
        'set_many',
        { pixels: [{ i: 1, r: 9, g: 9, b: 9 }, { i: 999, r: 9, g: 9, b: 9 }] },
        { expectReply: true },
      ),
    ).rejects.toThrow(/out of \[0, 176\)/)

    // 原子: 那颗合法的也没写进去.
    expect(model.buffer[1]).toEqual([0, 0, 0])
  })

  // ──────────────────────────────────────────────────────────────────
  // 5. 空的 set_many → 回 ok (树莓派那边也是 ok, set: 0, 不是错误)
  // ──────────────────────────────────────────────────────────────────
  it('空的 set_many 不报错 (树莓派端也是 ok, set: 0)', async () => {
    const transport = await connect(model)

    // 不抛错 = 设备回了 ok (树莓派那边也是 ok, set: 0).
    await expect(
      transport.send('set_many', { pixels: [] }, { expectReply: true }),
    ).resolves.toBeUndefined()
  })

  // ──────────────────────────────────────────────────────────────────
  // 6. 物理帧长 = 物理灯数 (树莓派 --physical-count 352)
  // ──────────────────────────────────────────────────────────────────
  it('一帧推满物理灯数 —— 上灯带 (176..351) 也在同一条链上', async () => {
    const transport = await connect(model, 352)

    await transport.send('set_many', { pixels: [{ i: 350, r: 1, g: 2, b: 3 }] })
    await transport.send('show', {}, { expectReply: true })

    // 上灯带那颗真的亮了 (链推满了 352 颗).
    expect(model.pixels[350]).toEqual([1, 2, 3])
    expect(model.litIndices()).toContain(350)
  })

  it('旧固件只推 176 颗 → 上灯带那截收不到数据 (尾巴留旧颜色)', async () => {
    // 旧固件的 bug: 链上接了 352 颗, 一帧却只推 176 颗.
    model = createEsp32Model({ frameLength: 176 })
    const transport = await connect(model, 352)

    await transport.send('set_many', { pixels: [{ i: 350, r: 1, g: 2, b: 3 }] })
    await transport.send('show', {}, { expectReply: true })
    // 只推了 176 颗 → 350 那颗没被更新.
    expect(model.pixels[350]).toEqual([0, 0, 0])
  })

  // ──────────────────────────────────────────────────────────────────
  // 7. 同时点亮的颗数上限默认不限 (旧固件写死 30 → 上灯带「自己灭一半」)
  // ──────────────────────────────────────────────────────────────────
  it('默认不限颗数 —— 上灯带 (下标最大) 不会被悄悄灭掉', async () => {
    const transport = await connect(model, 352)

    // 点亮 40 颗 (下标 300..339, 全在上灯带那一截).
    const px = Array.from({ length: 40 }, (_, k) => ({ i: 300 + k, r: 1, g: 2, b: 3 }))
    await transport.send('set_many', { pixels: px })
    await transport.send('show', {}, { expectReply: true })

    expect(model.litIndices()).toHaveLength(40)
    expect(model.litIndices()[39]).toBe(339)
  })

  it('旧固件那个 30 颗上限会把下标最大的灭掉 (上灯带「自己灭一半」)', async () => {
    model = createEsp32Model({ maxLit: 30 })
    const transport = await connect(model, 352)

    const px = Array.from({ length: 40 }, (_, k) => ({ i: 300 + k, r: 1, g: 2, b: 3 }))
    await transport.send('set_many', { pixels: px })
    await transport.send('show', {}, { expectReply: true })

    // 只剩 30 颗, 而且被灭掉的正是**下标最大**的 10 颗.
    expect(model.litIndices()).toHaveLength(30)
    expect(model.litIndices()).not.toContain(339)
  })

  // ──────────────────────────────────────────────────────────────────
  // 8. off 清整条物理链 (树莓派: off 把 physical 颗全清掉再 render)
  // ──────────────────────────────────────────────────────────────────
  it('off 把整条物理链都清掉 (含上灯带那截)', async () => {
    const transport = await connect(model, 352)

    await transport.send('set_many', {
      pixels: [
        { i: 10, r: 1, g: 2, b: 3 },
        { i: 340, r: 1, g: 2, b: 3 },
      ],
    })
    await transport.send('show', {}, { expectReply: true })
    expect(model.litIndices().length).toBe(2)

    await transport.send('off', {}, { expectReply: true })
    expect(model.litIndices()).toEqual([])
  })

  // ──────────────────────────────────────────────────────────────────
  // 9. init 回报 count / physical / pin —— 树莓派也是这三个字段
  //    (引脚值不同: 树莓派 18 / ESP32 14 —— 硬件不同, 不算不一致)
  // ──────────────────────────────────────────────────────────────────
  it('init 回报 count / physical / pin (跟树莓派同形)', async () => {
    const transport = await connect(model, 352)
    const status = await transport.probeStatus?.()
    expect(status).toBeTruthy()
    expect(status?.count).toBe(352)
    expect(status?.physical).toBe(352)
    expect(status?.pin).toBe(14)
    expect(status?.ready).toBe(true)
    expect(status?.sets_pending).toBe(0)
  })

  // ──────────────────────────────────────────────────────────────────
  // 10. 设备指纹: ping → pong, status → 字段齐, marquee → ESP32 有 / 树莓派没有
  //     (见 docs/esp32-pi-parity.md 「怎么确认连的是哪台」)
  // ──────────────────────────────────────────────────────────────────
  it('ping / status 是设备校验接口 —— 字段跟树莓派同形', async () => {
    const transport = await connect(model)

    await transport.send('ping', {}, { expectReply: true })
    const status = await transport.probeStatus?.()
    // 树莓派 status 有这几个字段, ESP32 必须一样.
    for (const k of ['ready', 'count', 'physical', 'pin', 'sets_pending', 'last_show_age_s']) {
      expect(status, `status 缺字段 ${k}`).toHaveProperty(k)
    }
  })

  it('marquee 是设备指纹: ESP32 回 ok (树莓派回 unknown op)', async () => {
    const transport = await connect(model)
    // ESP32 有设备端跑马灯.
    await expect(
      transport.send('marquee', { window: 6, step: 2 }, { expectReply: true }),
    ).resolves.toBeUndefined()
    expect(model.marqueeFrames.length).toBe(1)

    // 老固件没有 marquee → 回 unknown op (跟树莓派一个措辞).
    const old = createEsp32Model({ supportsMarquee: false })
    const t2 = await connect(old)
    await expect(
      t2.send('marquee', {}, { expectReply: true }),
    ).rejects.toThrow(/unknown op: 'marquee'/)
  })

  it('auth 回 ok (固件新版本) —— 前端握手不再退回「不带 auth」', async () => {
    model.install()
    const transport = new WsTransport({ url: model.url, token: 'tok', count: 176, pin: 14 })
    await transport.connect()
    // 握手顺序: auth → init → off.
    expect(model.executed.slice(0, 3)).toEqual(['auth', 'init', 'off'])
  })
})
