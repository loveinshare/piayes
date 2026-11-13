// 跑马灯 (「测试」按钮) 的端到端测试 —— 跑在 ESP32 固件模拟器上.
//
// ★ 2026-11-10: 链路从 BLE 换成 WebSocket (ESP32 跟树莓派一样跑 WS 程序).
//   协议 op 名去掉了 "led." 前缀 (树莓派形状): marquee / off / show / set_many.
//
// 用户报的 bug (2026-10-26):
//   1. 跑马灯走了**非常久** (用户记的是 0.5s)
//   2. 跑的时候其他灯**乱闪 / 乱删**
//   3. 跑完之后还有几个单灯亮着
//   4. 按键时有时亮三颗
//
// 根因 (逐条查过, 不是猜的):
//   - **慢**: 老实现一帧发一条 BLE 命令, 176 条 GATT 往返. 就算在途深度 6,
//     真机也要 1.7~3s —— 0.5s 根本到不了.
//   - **闪**: (a) bit-bang show() 被中断打断, WS2811 提前 latch, 后半条灯带
//     保留上一帧颜色; (b) 跑测试时 follower 还在写按键/预览灯.
//   - **残留**: 分片写失败 / 回执丢失时留下的幽灵像素, 没人重刷.
//
// 现在的做法:
//   - ESP32 走**设备侧跑马灯** (marquee op): 一条命令, 板子本地 44 帧 × 10.56ms
//     ≈ 0.46s 跑完, 与链路吞吐无关.
//   - 旧固件 (没有 marquee) 自动回退到前端逐帧, 每帧前进 2 颗, 帧数减半.
//   - App 在测试期间挂起 follower, 跑完再重画 —— 不会插进别的灯.

import { describe, it, expect, beforeEach } from 'vitest'
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util'
import { LedController, marqueeStep, MARQUEE_FRAME_MS, MARQUEE_TARGET_MS } from '../src/led/LedController'
import { WsTransport } from '../src/led/transport/WsTransport'
import { createEsp32Model, type Esp32Model } from './helpers/esp32Model'

if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder as any
if (!globalThis.TextDecoder) globalThis.TextDecoder = NodeTextDecoder as any

async function connectModel(model: Esp32Model) {
  model.install()

  const transport = new WsTransport({
    url: model.url,
    count: 176,
    pin: 14,
    // ESP32 有设备端跑马灯 —— 树莓派没有 (那边 supportsDeviceMarquee=false).
    supportsDeviceMarquee: true,
  })
  await transport.connect()

  const led = new LedController({ transport, count: 176 })
  model.executed.length = 0
  model.marqueeFrames.length = 0
  return { transport, led }
}

describe('marqueeStep —— 0.5s 目标', () => {
  it('176 颗灯每帧前进 4 颗 (44 帧 ≈ 465ms)', () => {
    const step = marqueeStep(176, MARQUEE_TARGET_MS, MARQUEE_FRAME_MS)
    expect(step).toBe(4)
    const frames = Math.ceil(176 / step)
    expect(frames).toBe(44)
    // 物理下限: 44 帧 × 10.56ms (物理 352 颗)
    expect(frames * MARQUEE_FRAME_MS).toBeLessThanOrEqual(MARQUEE_TARGET_MS)
  })

  it('352 颗 (双色带) 也是 44 帧 —— 帧时间按物理灯数算, 跟逻辑数无关', () => {
    const step = marqueeStep(352, MARQUEE_TARGET_MS, MARQUEE_FRAME_MS)
    expect(step).toBe(8)
    const frames = Math.ceil(352 / step)
    expect(frames).toBe(44)
    expect(frames * MARQUEE_FRAME_MS).toBeLessThanOrEqual(MARQUEE_TARGET_MS)
  })

  it('灯很少 / 目标很短时也不会返回 0 帧', () => {
    expect(marqueeStep(10)).toBe(1)
    expect(marqueeStep(1)).toBe(1)
  })
})

describe('跑马灯 (testPattern) —— ESP32 设备侧动画', () => {
  let model: Esp32Model

  beforeEach(() => {
    model = createEsp32Model()
  })

  it('只发一条 marquee 命令 (不再逐帧刷 176 条)', async () => {
    const { led } = await connectModel(model)

    await led.testPattern()

    expect(model.executed).toEqual(['marquee', 'off'])
    expect(model.marqueeFrames).toEqual([44])
  })

  it('估算时长 ≈ 0.46s (不是以前的 1.7~3s)', async () => {
    const { led } = await connectModel(model)

    await led.testPattern()

    // 设备侧跑马灯是同步跑完的 —— 帧数 × 单帧物理时间 = 估算时长.
    expect(model.marqueeFrames).toHaveLength(1)
    const estMs = model.marqueeFrames[0] * MARQUEE_FRAME_MS
    expect(estMs).toBeLessThan(600)
    expect(estMs).toBeGreaterThan(300)
  })

  it('跑完不会留下任何亮着的灯', async () => {
    const { led } = await connectModel(model)

    await led.testPattern()

    expect(model.litIndices()).toEqual([])
  })

  it('不会把固件队列灌爆 (帧数正好, 不多发也不少发)', async () => {
    const { led } = await connectModel(model)
    const showsBefore = model.shows

    await led.testPattern()

    // 设备侧跑马灯每帧推一次灯带 —— 44 帧, 一帧不多一帧不少;
    // 收尾的 allOff() 再推一次 (清屏) → 45.
    expect(model.shows - showsBefore).toBe(45)
  })

  it('ESP32 上不再额外发 show (设备侧跑马灯自己推帧)', async () => {
    const { led } = await connectModel(model)

    await led.testPattern()

    // 设备侧跑马灯整段动画在板子上跑完 (每帧一次 g_strip.show()),
    // 主机这边一条 show 都不用发 —— 跟树莓派的逐帧路径不一样, 但结果一致.
    expect(model.executed.filter((op) => op === 'show')).toHaveLength(0)
  })
})

// ★ 2026-11-11: window 是**客户端给的**, 固件那边的颜色数组只有 64 字节 ——
//   超了就把栈冲掉 (实测 window=176 会把循环变量打烂 → 死循环 → 板子变砖).
//   现在固件直接回 "window too large"; 这个测试盯住这个回错.
describe('跑马灯窗口上限 —— window 超 64 必须被拒', () => {
  let model: Esp32Model

  beforeEach(() => {
    model = createEsp32Model()
  })

  it('window=176 → 回错, 一帧都没跑', async () => {
    model.install()
    const transport = new WsTransport({ url: model.url, count: 176, pin: 14 })
    await transport.connect()

    await expect(
      transport.send('marquee', { window: 176, step: 2 }, { expectReply: true }),
    ).rejects.toThrow(/window too large/)
    expect(model.marqueeFrames).toEqual([])
  })

  it('window=64 (上限本身) → 正常跑', async () => {
    model.install()
    const transport = new WsTransport({ url: model.url, count: 176, pin: 14 })
    await transport.connect()

    await transport.send('marquee', { window: 64, step: 2 }, { expectReply: true })
    expect(model.marqueeFrames.length).toBe(1)
  })
})

describe('跑马灯回退 —— 旧固件没有 marquee', () => {
  let model: Esp32Model

  beforeEach(() => {
    // 旧固件: marquee → unknown op
    model = createEsp32Model({ supportsMarquee: false })
  })

  it('自动回退到前端逐帧, 且帧数减半 (≤ 100 条 set_many)', async () => {
    const { led } = await connectModel(model)

    await led.testPattern()

    // 第一条 marquee 被拒 (unknown op), 之后是前端逐帧.
    expect(model.executed[0]).toBe('marquee')
    const setManys = model.executed.filter((op) => op === 'set_many').length
    expect(setManys).toBeGreaterThan(0)
    expect(setManys).toBeLessThanOrEqual(100)
    // 最后一条必须是清灯
    expect(model.executed[model.executed.length - 1]).toBe('off')
    expect(model.litIndices()).toEqual([])
  })
})
