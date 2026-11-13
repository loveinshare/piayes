// 影子像素表 + resync —— 把"幽灵像素"清掉.
//
// WS 上任何一条 set_many 丢了, 物理灯带就会多一颗不该亮的灯. 用户报的
// 「几个灯莫名其妙常亮」「按一个键亮三颗」就是这些幽灵像素累积出来的.
//
// LedController 现在记住"应该是什么样" (shadow), resync() = 整条 off +
// 把该亮的重点上 —— 通信侧出过问题后可以一键把物理状态拉回来.

import { describe, it, expect, beforeEach } from 'vitest'
import { TextEncoder as NodeTextEncoder, TextDecoder as NodeTextDecoder } from 'node:util'
import { LedController } from '../src/led/LedController'
import { WsTransport } from '../src/led/transport/WsTransport'
import { createEsp32Model, type Esp32Model } from './helpers/esp32Model'

if (!globalThis.TextEncoder) globalThis.TextEncoder = NodeTextEncoder as any
if (!globalThis.TextDecoder) globalThis.TextDecoder = NodeTextDecoder as any

async function waitFor(pred: () => boolean, timeoutMs = 30000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 2))
  }
}

async function connect(model: Esp32Model) {
  model.install()
  const transport = new WsTransport({ url: model.url, count: 176, pin: 14 })
  await transport.connect()
  const led = new LedController({ transport, count: 176 })
  model.executed.length = 0
  return { transport, led }
}

describe('LedController.resync', () => {
  let model: Esp32Model

  beforeEach(() => {
    model = createEsp32Model()
  })

  it('清掉幽灵像素, 同时保留当前该亮的音', async () => {
    const { led } = await connect(model)

    led.noteOn(60) // → LED 78,79 (右手白键 = 红)
    // ★ set_many 只写设备缓冲, 要 show 才推到物理灯带 (跟树莓派一个语义).
    await led.show()
    await waitFor(() => model.litIndices().length === 2)
    expect(model.litIndices()).toEqual([78, 79])

    // 模拟一条丢掉的命令留下的幽灵像素 (物理灯带上多出来的).
    model.pixels[5] = [200, 0, 0]
    model.pixels[170] = [0, 0, 200]

    await led.resync()

    expect(model.litIndices()).toEqual([78, 79])
    expect(model.pixels[5]).toEqual([0, 0, 0])
    expect(model.pixels[170]).toEqual([0, 0, 0])
    expect(model.pixels[78][0]).toBeGreaterThan(0)
  })

  it('没有该亮的灯时, resync 之后全灭', async () => {
    const { led } = await connect(model)

    model.pixels[42] = [1, 2, 3]
    await led.resync()
    expect(model.litIndices()).toEqual([])
  })

  it('allOff 之后影子表也归零 (resync 不会把旧灯又点亮)', async () => {
    const { led } = await connect(model)

    led.noteOn(64)
    await led.show()
    await waitFor(() => model.litIndices().length === 2)
    await led.allOff()
    expect(model.litIndices()).toEqual([])

    await led.resync()
    expect(model.litIndices()).toEqual([])
  })
})
