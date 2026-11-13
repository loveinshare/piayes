/**
 * 双色带端到端自检 —— 用**前端真正的代码**驱动树莓派.
 *
 * 为什么不用浏览器: 浏览器要装浏览器 + 起会话, 而这里要验的是
 * 「前端发的 op/字段跟树莓派 daemon 对不对得上」—— 直接把前端的
 * WsTransport + LedController 拿来跑, 走的是**同一份代码**、同一条链路
 * (浏览器 → ws://host:8080 → ws_led_bridge → TCP 127.0.0.1:7777 → led_remote).
 *
 * 验什么:
 *   1. init count=352 被接受 (树莓派白名单放行 352, 且不撞 DMA 通道)
 *   2. 上灯带提示落在 chain 176..351 段, 且**位置对得上**:
 *      A0 (物理最左) → 350/351;  C8 (物理最右=接缝) → 176/177
 *   3. 亮度 = 主灯带亮度 × 比例 (默认 0.7)
 *   4. 切回 176 (单灯带) 不炸
 *
 * 用法:
 *   npx esbuild scripts/bt_pi/pc/check_dual_strip.ts --bundle --platform=node \
 *     --format=esm --outfile=/tmp/check_dual_strip.mjs
 *   node /tmp/check_dual_strip.mjs [host] [port]
 */

import { WsTransport } from '../../../src/led/transport/WsTransport'
import { LedController } from '../../../src/led/LedController'
import type { LedResponse } from '../../../src/led/LedTransport'

const HOST = process.argv[2] ?? '192.168.1.113'
const PORT = process.argv[3] ?? '8080'
const URL = `ws://${HOST}:${PORT}`

interface Wire {
  op: string
  args: any
}

const sent: Wire[] = []

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`)
  process.exit(1)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`=== 双色带端到端自检 → ${URL}`)

  const transport = new WsTransport({ url: URL, count: 352, pin: 18 })
  // 记录发出去的每一条命令 (验「前端发的字段跟 daemon 对不对得上」)
  const origSend = transport.send.bind(transport)
  transport.send = async (op: string, args: Record<string, any>, opts?: any) => {
    sent.push({ op, args: JSON.parse(JSON.stringify(args)) })
    try {
      await origSend(op, args, opts)
    } catch (e) {
      throw e
    }
  }

  const led = new LedController({
    transport,
    count: 352,
    dualStrip: true,
    brightness: 1,
    upperBrightnessRatio: 0.7,
  })

  // --- 1. 连接 (里面会发 init count=352 + off) ----------------------------
  try {
    await led.connect()
  } catch (e) {
    fail(`连不上 / init 失败: ${(e as Error).message}`)
  }
  console.log('✓ connect() 成功')

  const init = sent.find((m) => m.op === 'init')
  if (!init) fail('没发出 init')
  console.log(`  init → ${JSON.stringify(init.args)}`)
  if (init.args.count !== 352) fail(`init 的 count 应该是 352, 实际 ${init.args.count}`)

  // --- 2. 上灯带提示: A0 (最左) + C8 (最右=接缝) -------------------------
  led.setUpperHints([
    { midi: 21, hand: 'left' },   // A0  = 物理最左
    { midi: 108, hand: 'right' }, // C8  = 物理最右 (接缝)
  ])
  await sleep(400)

  const setMany = sent.filter((m) => m.op === 'set_many').pop()
  if (!setMany) fail('上灯带没发出 set_many')
  const pixels: Array<{ i: number; r: number; g: number; b: number }> =
    setMany.args.pixels ?? []
  console.log(`  set_many → ${pixels.length} 个像素: ${JSON.stringify(pixels)}`)

  const idx = pixels.map((p) => p.i).sort((a, b) => a - b)
  const want = [176, 177, 350, 351]
  if (JSON.stringify(idx) !== JSON.stringify(want)) {
    fail(`上灯带像素位置不对: 期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(idx)}`)
  }
  console.log('✓ 上灯带落在 176/177 (物理最右) + 350/351 (物理最左)')

  // --- 3. 亮度 = 主灯带亮度 × 比例 (左手蓝 200 × 0.7 = 140) ---------------
  const left = pixels.find((p) => p.i === 350)!
  if (left.b !== 140) fail(`左手提示的蓝应该是 200×0.7=140, 实际 b=${left.b}`)
  const right = pixels.find((p) => p.i === 176)!
  if (right.r !== 140) fail(`右手提示的红应该是 200×0.7=140, 实际 r=${right.r}`)
  console.log('✓ 亮度 = 主灯带 × 70% (蓝 140 / 红 140)')

  // --- 4. show 刷灯 ------------------------------------------------------
  try {
    await led.show()
  } catch (e) {
    fail(`show 失败: ${(e as Error).message}`)
  }
  console.log('✓ show 成功')

  // --- 5. 切回单灯带: 再 init 一次 176, 验证不炸 -------------------------
  const t176 = new WsTransport({ url: URL, count: 176, pin: 18 })
  const led176 = new LedController({ transport: t176, count: 176, dualStrip: false })
  try {
    await led176.connect()
    await led176.allOff()
  } catch (e) {
    fail(`切回 176 失败: ${(e as Error).message}`)
  }
  console.log('✓ 切回单灯带 (176) 成功')

  transport.disconnect()
  t176.disconnect()
  console.log('\n全部通过 OK')
  // 等 WebSocket 的 close 事件跑完再退 —— 直接 process.exit 会撞 libuv 的
  // "handle->flags & UV_HANDLE_CLOSING" 断言 (Node 自带 WebSocket 的老毛病).
  await sleep(500)
  process.exitCode = 0
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
