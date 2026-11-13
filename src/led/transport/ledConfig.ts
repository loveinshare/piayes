// LED 灯带的共享常量和小工具.
//
// 抽出来是因为 App.tsx 和 transport 层都要用 —— 特别是 LED_COUNT / LED_PIN:
// 这俩既发给设备做 init, 又决定前端 index 空间, 两边不一致会串位.

/** 灯珠数 —— ESP32 固件 (LED_COUNT) 和树莓派 (DEFAULT_COUNT) 都是 176. */
export const LED_COUNT = 176

/**
 * 树莓派的灯带引脚.
 *
 * 能驱动 WS2812 的只有 **12 / 18 / 21** 三个引脚 (rpi_ws281x 实测: 其余一律
 * "Gpio N is illegal for LED channel 0"). 12 和 18 复用功能相同 (都是 PWM0_0).
 *
 * 树莓派那边会**真的切 GPIO** (白名单 12/18/21) —— 传别的值 init 直接被拒.
 */
export const LED_PIN = 18

/** ESP32-S3 的灯带引脚 (firmware/esp32s3/platformio.ini 的 LED_PIN, 编译期固定). */
export const ESP32_LED_PIN = 14

/**
 * 灯带设备 —— 树莓派 还是 ESP32.
 *
 * ★ 2026-11-10: 蓝牙那条路整个删掉了 (旧固件的 Web Bluetooth). 现在两个设备
 *   **都走 WebSocket**: 树莓派跑 ws_led_bridge.py, ESP32 的新固件自带 WS
 *   server —— 协议完全一样 (裸 op: init/set/set_many/show/off/ping/status).
 *   所以前端唯一的区别就是: 连哪台 + 每台的引脚不一样.
 */
export type LedDevice = 'pi' | 'esp32'

export interface LedDeviceInfo {
  /** UI 上显示的名字. */
  label: string
  /** 这台设备的默认 IP (用户没改过地址时用). */
  defaultHost: string
  /** init 时发给设备的引脚 —— 两边不一样, 发错了树莓派会拒. */
  pin: number
  /** 设备端有没有跑马灯 (ESP32 有 `led.marquee`, 树莓派没有). */
  supportsDeviceMarquee: boolean
}

export const LED_DEVICE_INFO: Record<LedDevice, LedDeviceInfo> = {
  pi: {
    label: '树莓派',
    defaultHost: '192.168.1.113',
    pin: LED_PIN,
    // ★ 2026-11-11: 树莓派端 led_remote.py 也加了设备侧 marquee (跟 ESP32
    //   同一套 window/step/渐变语义). 以前只能前端逐帧发 —— 44 帧 ≈ 176 条
    //   TCP 往返, 浏览器/网络一抖就「跑马灯乱闪」. 老版本 Pi 服务回
    //   "unknown op: 'marquee'", testPattern 会自动回退到逐帧发.
    supportsDeviceMarquee: true,
  },
  esp32: {
    label: 'ESP32',
    // DHCP 拿到的地址 (路由器上按 MAC 保留) —— 这才是板子平时的地址.
    // 固件的静态兜底是 .120 (见 ESP32_STATIC_FALLBACK_HOST), 只在 DHCP 挂了才用.
    defaultHost: '192.168.1.108',
    pin: ESP32_LED_PIN,
    supportsDeviceMarquee: true,
  },
}

/**
 * ESP32 的静态 IP 兜底 (firmware/esp32s3/src/wifi_config.h) —— DHCP 挂了才用.
 *
 * ★ 2026-11-11: 之前把**兜底**的 .120 当成了默认地址, 跟板子平时的 DHCP 地址
 *   (.108) 对不上 —— 服务器反代指向了一个板子根本不在的地址.
 *   现在默认地址改回 .108, 这个 .120 仍然算「ESP32 的地址」—— 用户的板子
 *   万一 DHCP 没拿到、跑在静态兜底上, 前端照样认得出.
 */
export const ESP32_STATIC_FALLBACK_HOST = '192.168.1.120'

/** 这个地址算不算「这台设备的默认地址」? (含静态兜底) */
export function isDefaultHostOf(device: LedDevice, host: string): boolean {
  if (host === LED_DEVICE_INFO[device].defaultHost) return true
  if (device === 'esp32' && host === ESP32_STATIC_FALLBACK_HOST) return true
  return false
}

/**
 * 切设备时的地址处理: 当前地址正好是「另一台设备的默认地址」→ 跟着换成
 * 新设备的默认地址; 用户自己改过的地址**不动** (别替用户做主).
 */
export function hostAfterDeviceSwitch(current: string, from: LedDevice, to: LedDevice): string {
  if (from === to) return current
  if (isDefaultHostOf(from, current)) return LED_DEVICE_INFO[to].defaultHost
  return current
}

/**
 * 取灯带令牌: 显式传入 > VITE_LED_TOKEN > localStorage['ledToken'].
 *
 * 三者都没有时返回空字符串 (不带令牌连接) —— 旧版树莓派桥的行为.
 */
export function resolveLedToken(explicit?: string): string {
  if (explicit) return explicit
  try {
    const env = (import.meta as any).env?.VITE_LED_TOKEN
    if (env) return String(env)
  } catch {}
  try {
    // ★ 2026-11-01 修 (审核报告 §3.8): 原来读的是 localStorage['ledToken'],
    //   但 store 把令牌存在 'piayes.prefs.v1' 的 ledToken 字段里 ——
    //   两个不同的 key. explicit 优先所以功能上没坏, 但这条 fallback
    //   读的是一个几乎没人写入的 key. 现在读真的那个.
    //   ('piano-follow.prefs.v1' 是改名前的旧 key —— 还在读, 兼容老用户.)
    for (const key of ['piayes.prefs.v1', 'piano-follow.prefs.v1']) {
      const raw = globalThis.localStorage?.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      const token = parsed?.ledToken
      if (typeof token === 'string' && token) return token
    }
  } catch {}
  return ''
}

/**
 * WebSocket 那条路的 URL.
 *
 * ★ 2026-11-10: 蓝牙那条路删了 —— 现在只有 WS, 树莓派和 ESP32 都走它
 *   (ESP32 的新固件自带 WebSocket server, 端口 8080, 协议跟树莓派那座桥
 *   **完全一样**).
 *
 * - 设了 proxyPath → 同源 wss://<当前页 host><proxyPath>.
 *   HTTPS 部署时走这条: 设备那边是明文 ws://, 直连会被浏览器按
 *   mixed content 拦掉, 服务端反代一次就绕开了.
 *   ★ proxyPath 里带设备段 (`/led-proxy/pi` / `/led-proxy/esp32`) —— 服务器
 *     按路径选上游, 所以 HTTPS 下**填的地址是不生效的**, 生效的是服务器上
 *     配的 LED_WS_TARGET_PI / LED_WS_TARGET_ESP32.
 * - 否则 → 直连 ws://<host>:<port> (本地开发 / HTTP 部署).
 */
export function buildLedWsUrl(host: string, port = 8080, proxyPath?: string): string {
  if (proxyPath) {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${window.location.host}${proxyPath}`
  }
  return `ws://${host}:${port}`
}

/** 反代路径 —— 按设备分 (服务器端按这个选上游). */
export function ledProxyPath(device: LedDevice): string {
  return `/led-proxy/${device}`
}

/**
 * 当前连的是哪台设备 (给 UI 显示用).
 *
 * 把地址也带出来 —— 用户一眼知道自己连的是哪台 (免得「以为连着 ESP32,
 * 其实连的还是树莓派」).
 */
export function ledDeviceLabel(active: LedDevice | null, host: string): string {
  if (active === 'pi') return `树莓派 · ${host}`
  if (active === 'esp32') return `ESP32 · ${host}`
  return '未连接'
}
