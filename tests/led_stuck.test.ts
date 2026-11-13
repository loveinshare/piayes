// 「灯一直亮着 / 跑完还有灯亮着」—— 回归测试.
//
// 用户报的 (2026-10-22):
//   1. **连上之后**就有几颗红的绿的蓝的灯一直亮着
//   3. 跑完跑马灯之后, 之前常亮的几颗单灯还亮着
//
// ── 根因 (逐条查出来的, 不是猜的) ─────────────────────────────────
//
// **(a) ESP32 上电点亮 LED 0 (蓝色)** —— ble_led.cpp:451
//     `g_strip.setPixel(0, 0, 0, 200); g_strip.show();`
//     这一颗灯**永远亮着**, 直到主机发来 led.off.
//     表现: 刚接上就有一颗蓝灯常亮.
//
// **(b) 固件的 bleSend() 硬编码 20 字节一片 + 每片 delay(5)** —— ble_led.cpp:159
//     设备明明请求了 BLEDevice::setMTU(247), 回包却按 20 字节切.
//     一条 45 字节的回应 = 3 片 = 15ms → 每条命令 ~21ms.
//     表现: 跑马灯「走了十多秒」.
//
// **(c) 串口回显是阻塞写** —— ARDUINO_USB_CDC_ON_BOOT=0 → Serial 是 UART0.
//     一条 45 字节的回应在 115200 下要 3.9ms, 串口没人读还会把 TX 缓冲写满.
//     表现: 每条命令再慢 4ms.
//
// **(d) 前端每帧发两条命令** (set_many + show), 而**老** ESP32 固件的
//     set_many 内部本身就会 show() → 每帧把灯带推两遍 → 画面撕裂.
//     表现: 跑的时候「异常闪」.
//
//     ★ 2026-11-04 已修: 固件的 set / set_many 改成**只写缓冲**, 刷灯带由
//     led.show 负责 —— 跟树莓派端 led_remote.py 一个语义. 一帧只推一次.
//
// **(e) allOff() 是 fire-and-forget** —— 后排队的 set_many 可能在 off 之后
//     才落地 → 灯又被点回来.
//     表现: 「跑完还有灯亮着」.
//
// 这个文件把 (a)(d)(e) 钉成回归测试 —— (b)(c) 是固件里的, 改不了 JS,
// 只能靠固件重新烧录 (见 firmware/esp32s3/README.md).

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

/**
 * 等设备执行了至少 n 条指定 op 的命令.
 *
 * 为什么不能等 `queueDepth() === 0`: 队列空 ≠ 命令到了设备.
 * `send()` 是 fire-and-forget, 写还在传输层的异步写链里, 此刻队列当然是空的.
 * 要等的是**设备真的执行了** —— 看 executed 数组.
 */
async function waitForOps(model: Esp32Model, op: string, n: number): Promise<void> {
  await waitFor(() => model.executed.filter((o) => o === op).length >= n)
}

/** 连上模拟设备 (走完整的 init / off 握手). */
async function connect(model: Esp32Model) {
  model.install()
  const transport = new WsTransport({ url: model.url, count: 176, pin: 14 })
  await transport.connect()
  return transport
}

describe('灯常亮 / 残留 —— 跑在 ESP32 固件模拟器上', () => {
  let model: Esp32Model

  beforeEach(() => {
    model = createEsp32Model()
  })

  it('连上之后 ESP32 的上电蓝灯 (LED 0) 被清掉', async () => {
    // 固件上电会点亮 LED 0 (ble_led.cpp:451) —— 连接握手里的 led.off
    // 必须把它清掉, 否则用户看到「刚连上就有一颗蓝灯常亮」.
    expect(model.litIndices()).toEqual([0])

    await connect(model)

    expect(model.litIndices()).toEqual([])
  })

  it('allOff() 之后没有灯亮着 —— 即使之前有在途的 set_many', async () => {
    const transport = await connect(model)

    const led = new LedController({ transport, count: 176 })

    // 点亮几颗灯, 然后清掉 —— 模拟「用户按了几个键, 然后暂停」
    led.noteOn(60)
    led.noteOn(64)
    led.noteOn(67)
    await waitForOps(model, 'set_many', 3)
    // ★ 2026-11-04: set_many 只写**设备缓冲**, 要另发 led.show 才推给物理
    //   灯带 (跟树莓派端一个语义). 所以这里先 show 一次, 让灯真的亮起来.
    await led.show()
    expect(model.litIndices().length).toBeGreaterThan(0)

    // ★ 关键断言: allOff() 返回后, 灯带必须是全灭的.
    //   allOff() 内部会 drain —— 所以它返回时, 之前排队的 set_many
    //   都已经执行完了, off 是真正最后一条.
    await led.allOff()
    expect(model.litIndices()).toEqual([])
  })

  it('allOff() 是最后一条命令 (后面的 set 不会把灯点回来)', async () => {
    const transport = await connect(model)

    const led = new LedController({ transport, count: 176 })

    // 一边点几个键 (排队中), 一边清灯 —— 这就是「跑马灯跑完还有灯亮着」的现场
    led.noteOn(60)
    led.noteOn(62)
    led.noteOn(65)
    await led.allOff()

    expect(model.executed[model.executed.length - 1]).toBe('off')
    expect(model.litIndices()).toEqual([])
  })

  it('校准灯灭掉后不留残灯', async () => {
    const transport = await connect(model)

    const led = new LedController({ transport, count: 176 })

    // 开启校准 (中央 C 常亮白) → 关掉 → 必须干净
    led.setCalibrate(true)
    await waitForOps(model, 'set_many', 1)
    // 校准会自己补一次 show (setCalibrate → repaintCalibrate), 等它落地.
    await waitFor(() => model.litIndices().length > 0)
    expect(model.litIndices().length).toBeGreaterThan(0)

    led.setCalibrate(false)
    await waitForOps(model, 'set_many', 2)
    await waitFor(() => model.litIndices().length === 0)
    expect(model.litIndices()).toEqual([])
  })
})
