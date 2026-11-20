---
name: led-strip-protocol
description: piano-follow 灯带的协议层 —— 四套 op 词汇 (前端 / 树莓派 TCP / BLE 设备 / 树莓派 daemon)、像素字段差异 (i vs index)、DEVICE_OPS 翻译表、WS 桥 token 鉴权、BLE 分片与帧头 STX、RX 队列与在途窗口。改任何 op、字段或通信参数前读这个技能。
---

# 协议: 四套 op 词汇 (最容易搞混的地方)

piano-follow 里 LED 控制有**四套互不相同的 op 词汇**。改这块时第一件事永远是
**确认自己在改哪一套**:

| # | 谁说 | op 名 | 像素字段 | 出处 |
|---|---|---|---|---|
| 1 | **前端** `LedController` | `init` `set` `set_many` `show` `off` `marquee` `ping` `status` (+ WS 专用 `auth`) | `{"i":..,"r":..,"g":..,"b":..}` | `src/led/LedController.ts` |
| 2 | **树莓派 TCP** `led_remote.py` | 同 #1 (完全一致) | `i` | `scripts/bt_pi/pi/led_remote.py` |
| 3 | **ESP32 BLE 设备** | `led.init` `led.set` `led.set_many` `led.show` `led.off` `led.marquee` `led.all` `led.status` + 无前缀的 `ping` `status` | `led.set` 用 **`index`**; `led.set_many` 的像素数组用 `i` | `firmware/esp32s3/src/ble_led.cpp` |
| 4 | **树莓派蓝牙 daemon** `bt_gpio_daemon.py` | `led.init` `led.set` `led.all` `led.set_many` `led.show` `led.off` `led.status` (+ `ping` `status` + 一堆 gpio.* op) | `index` | `scripts/bt_pi/pi/bt_gpio_daemon.py` |

**#1 → #3 的翻译在浏览器里** (`src/led/transport/BleTransport.ts`):

```ts
const DEVICE_OPS: Record<string, string> = {
  init: 'led.init', set: 'led.set', set_many: 'led.set_many',
  show: 'led.show', off: 'led.off', marquee: 'led.marquee',
  ping: 'ping', status: 'status',
}
// translateArgs(): set 的 i → index (set_many 不翻译)
```

> **踩过的坑**: `BleTransport.connect()` 里的 init/off 一开始直接用了前端的 op 名,
> 绕过了 `DEVICE_OPS` —— 设备只认 `led.init`/`led.off`, 回 `unknown op`,
> 蓝牙握手永远过不去。**发任何命令都要先过 `DEVICE_OPS`。**

树莓派 WS 链路不需要翻译 (桥只是 TCP 透传, 用的就是 #1)。

## 消息格式

请求 / 响应都是 **JSON 行** (`\n` 结尾), 响应带原样的 `id`:

```jsonc
→ {"id":1,"op":"led.set","args":{"index":0,"r":0,"g":0,"b":200}}
← {"id":1,"ok":true,"result":{"index":0,"r":0,"g":0,"b":200}}
← {"id":1,"ok":false,"error":"rx queue full"}
```

## WS 桥的 token 鉴权 (只在树莓派链路)

- 前端连上 `ws://<host>:8080` 后, **第一条消息必须是** `{"op":"auth","token":"..."}`。
- token 来源: 环境变量 `LED_TOKEN` 或文件 `/opt/bt-gpio/led_token` (chmod 600)。
- 没配置 token 时只打警告并放行 (向后兼容); 设 `LED_REQUIRE_TOKEN=1` 则强制拒绝。
- 还有 Origin 白名单 + 令牌桶限流 + 握手超时 (连上但不发 auth 的客户端不能白占名额)。
- 前端默认 `ledToken` 为空字符串 —— 树莓派没配 token 时能连, 配了就必须在 UI 填。

## BLE 链路 (ESP32) 的四个关键设计

这四条是 2026-10-26 一次连环 bug 的修复, **别改回去**:

1. **帧头 STX (`\x02`)** —— 每条命令以 `\x02` 开头。固件一看到它就把当前半行丢掉,
   从头重收 → 分片失败重试是安全的, 不会拼出垃圾 JSON。
   旧固件不认识 STX (按 key 搜的解析器, 多一个控制字符不影响) → 新前端仍能连旧固件。
2. **固件只在整行是完整 JSON 对象 (`{...}`) 时才入队** —— 半行/拼坏的帧直接丢,
   计入 `bad_frames`, **绝不"半解析"后执行** (半解析会写出错误下标 → 随机像素亮灭)。
3. **一问一答 (write-with-response)** —— 不是 write-without-response。后者在 Chrome 里
   把数据交给系统蓝牙栈就 resolve, 控制器缓冲满了会**静默丢包** → 设备收到半条命令
   → 「乱闪 / 常亮 / 亮三颗」。一问一答慢一点, 但每片都确认到达, 天然有背压。
4. **严格串行写** —— 一条 `set_many` 拆成十几片, 两条命令并发写片会**交错**,
   设备按行重组出来就是垃圾。

### 分片与流控参数

| 参数 | 值 | 位置 |
|---|---|---|
| MTU 首选 | 247 → 载荷 **244** 字节 | `BleTransport.CHUNK_PREFERRED` |
| 写失败时 | 片长减半重试 (最小 20) | `BleTransport` |
| 前端一批像素 | 最多 **80** 个 / `set_many` | `LedController.CHUNK = 80` |
| 前端在途命令 | 最多 **6** 条 | `BleTransport.MAX_OUTSTANDING` |
| 回执超时 | **1500 ms** | `BleTransport.REPLY_TIMEOUT_MS` |
| 固件 RX 队列 | **8** 槽, 满了回 `rx queue full` | `ble_led.cpp: RX_QUEUE_SLOTS` |

树莓派 WS 侧的超时常量 (`src/led/transport/WsTransport.ts`):

| 参数 | 值 | 说明 |
|---|---|---|
| `WS_CONNECT_TIMEOUT_MS` | **20000** | 建连超时 (2026-10-28 从 10s 提到 20s) |
| `WS_HANDSHAKE_TIMEOUT_MS` | **5000** | 握手三步 (auth / init / off) 每步的上限 |
| `WS_RPC_TIMEOUT_MS` | **1000** | 普通 RPC 的回执上限 |

> 握手超时从 1s 提到 5s 的起因就是用户报的「前端显示 rpc init timeout」——
> 设备正忙时多等一会儿, 别把慢当成断线。

**在途窗口为什么是 6** (真机实测, `scripts/bt_pi/pc/probe_ble_depth.py`):

| 在途深度 | 收到/发出 | ms/条 | 结果 |
|---|---|---|---|
| 2 (旧值) | 60/60 | 62.6 | 179 条 = **11.2 秒** |
| 4 | 60/60 | 32.4 | ✓ |
| **6 (现值)** | 120/120 | **8.6** | ✓ 179 条 = 1.66 秒 |
| 12 | 118/120 | 36.9 | ⚠️ 丢 2 |

瓶颈**不是**设备算得慢 (bit-bang `show()` 只要 10.6ms), 是**回执延迟**:
设备处理完 → 发通知 → 通知要等下一个连接事件才到主机; 窗口只有 2 时整条流水
被「等回执」的往返卡死。深度 12 就开始丢 —— 固件队列只有 8 槽, 6 给它留 2 槽余量。

### 超时/报错时的自愈

前端命令超时会**按影子像素表整条重刷** (`LedController.resync()`), 把幽灵像素清掉。
所以「偶发一颗灯常亮」通常能自愈; 持续常亮 = 影子表和设备真的不一致了。

### 设备诊断

```
{"id":"x","op":"status"}
← {"id":"x","ok":true,"result":{"pin":14,"count":176,"queue":0,"bad_frames":0,"dropped":0}}
```

`bad_frames > 0` 或 `dropped > 0` = **通信侧真的丢过帧** (不是前端画错), 要查 MTU / 链路。
前端也能读: `BackendTransport.probeStatus()` → `BleTransport.probeStatus()`。

## 前端 op 的两个特殊约定

- `expectReply` 只对 `show` / `off` / `init` / `marquee` 为 true
  (`LedController.ts:785`) —— 其余 op 不等回执, 攒着批量发。
- 树莓派侧 `set` / `set_many` **只写 buffer**, 真正推灯带靠 `show`。
  ESP32 侧 `led.set` / `led.set_many` **内部就 show 了** —— 前端用
  `transport.setManyShows` 判断要不要补一次 `show`。
