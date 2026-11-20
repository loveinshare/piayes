# ESP32 ↔ 树莓派 一致性对照

> 目标: 用户从树莓派换到 ESP32-S3 之后, **完全看不出差别**.
>
> 本文是逐条 op 的对照表 + 两条链路的「触发方式」差异说明, 以及
> 2026-11-04 / 2026-11-10 那两轮对齐具体改了哪些东西。
>
> - 树莓派参考实现: `scripts/bt_pi/pi/led_remote.py` (灯带服务)
>   + `scripts/bt_pi/pi/ws_led_bridge.py` (WS→TCP 中继)
> - ESP32 固件: `firmware/esp32s3/src/ble_led.cpp`
>   (WS 那一路: `firmware/esp32s3/src/ws_led.cpp` —— 见 §7)
> - 回归测试: `tests/led_esp32_pi_parity.test.ts`
>   (跑在 `tests/helpers/esp32Model.ts` —— 固件的 JS 模拟器上)
>
> ★ **2026-11-10: 两条链路现在都是 WebSocket** —— 前端的蓝牙那条路整个删了,
>   ESP32 跟树莓派走**同一个协议** (裸 op, 端口都是 8080)。§1 里「ESP32 (Web Bluetooth)」
>   那一节讲的是**历史** (固件的 BLE GATT 那条路还在固件里, 只是前端不再用)。

---

## 1. 触发方式: 两条链路到底差在哪

### 树莓派 (WS)

```
浏览器 ──WebSocket──> ws_led_bridge.py (:8080) ──TCP──> led_remote.py (:7777)
                                                              │
                                                        rpi_ws281x (PWM+DMA)
```

- 一条 WS 帧 = 一条 JSON 命令。桥是**纯中继**, 不含任何逻辑。
- 设备端 `led_remote.py` 收到命令 → 改 Python 侧的 `_buf` → `show` 时才
  `ws2811_render()` + `ws2811_wait()`, 由 **DMA 硬件**把波形打出去。
- 一帧的耗时 ≈ 1~2ms (DMA 推 352 颗) + WS 往返 (~1ms, 局域网)。
- 回包是**扁平**的 `{"ok":true,...}`; 桥把多个客户端的回包合并成一条发回。

### ESP32 (WebSocket —— 现在前端走的就是这条)

```
浏览器 ──WebSocket──> ESP32-S3 固件 (:8080, ws_led.cpp)
                                  │
                             bit-bang show()
```

- 一条 WS 帧 = 一条 JSON 命令, 跟树莓派那座桥**完全一样**。
- 回包是**扁平**的 `{"ok":true,...}` —— 固件用 `piReply()` 把自己内部的嵌套回包
  重排成树莓派那张表 (见 §7.1)。
- 一帧的耗时 = 352 颗 × 30µs ≈ **10.6ms** (bit-bang, 关中断保证 bit 宽度)。

### ESP32 (Web Bluetooth —— **历史**, 2026-11-10 前前端走的那条)

```
浏览器 ──GATT write-with-response──> NimBLE host task ──RX 队列(8槽)──> Arduino loop()
                                                                              │
                                                                     bit-bang show()
```

- 一条命令按 **MTU 247 (载荷 244 字节)** 分片, **所有写严格串行**。
- 每片都带**帧头 STX (`\x02`)** —— 分片失败重试时设备靠它丢掉残缺的半行。
- 写回调只搬字节, 真正的执行放在 `loop()` 里 (bit-bang 的 `show()` 要占住
  CPU, 在蓝牙栈的回调里跑会阻塞协议栈)。
- 回包是**嵌套**的 `{"id":"x","ok":true,"result":{...}}` (每条命令都有 id,
  主机靠 id 对上是哪一条的回复)。
- ⚠️ 这条路的**前端代码已经删干净了** (`BleTransport` / `bleDevice` /
  `webBluetooth` / `BackendTransport` / `IconBluetooth`)。固件里的 BLE GATT
  还在 (`ble_led.cpp`), 但前端不再碰它 —— §2 那张表里 BLE 形状的部分只作对照。

### 差异带来的三个真实后果 (2026-11-04 修掉的)

| # | 差异 | 后果 | 怎么修的 |
|---|---|---|---|
| 1 | 旧固件 `led.set_many` 内部就 `show()` | 一个动画帧里的多条 set_many 各自推一次 → **中间状态被看到** = 画面撕裂 (用户报的「异常闪」) | 固件改成 `set`/`set_many` **只写缓冲**, `led.show` 才推; init 回执里回报 `set_many_shows:false`, 前端据此决定要不要补 show |
| 2 | 旧固件一帧只推 `count` 颗 | 链上接了 352 颗却只推 176 颗 → 后面那截收不到数据, **保留上一帧的颜色** (鬼影) | 固件分「物理 / 逻辑」两个数: 一帧永远推 `LED_PHYSICAL_COUNT` (默认 352), 逻辑灯数只决定「允许写哪几颗」 |
| 3 | 旧固件 `LED_MAX_LIT` 写死 30 | 超了就灭掉**下标最大**的若干颗 —— 双色带的上灯带恰好是下标最大的那截 → **上灯带自己灭一半** | 默认改成 0 (不限), 跟树莓派一致; 供电真扛不住时再 `-D LED_MAX_LIT=30` |

---

## 2. 逐条 op 对照

前端内部说的是 `init` / `set` / `set_many` / `show` / `off` / `ping` / `status`
(`marquee` 只在 ESP32 上有)。**现在只有一条 WebSocket 链路** —— 说的就是这些
**裸 op 名**, 两边一模一样 (BLE 传输层那套 `led.*` 翻译 2026-11-10 已删)。

| op | 树莓派 `led_remote.py` | ESP32 固件 | 一致? |
|---|---|---|---|
| `init` | count 必须在白名单 (176, 352), pin 也要在白名单; 换引脚要重建 strip; **逻辑范围变小 (352→176) 时把范围外刷黑**; 回 `{ok, count, physical, pin}` | count 必须在白名单 (176, 352); **pin 编译期固定, 忽略传入值并回报本机实际值**; 逻辑范围变小时把范围外抹黑并刷出去; 回 `{ok, count, physical, pin, set_many_shows:false}` | ⚠️ pin: 树莓派运行期可换, ESP32 编译期固定 (硬件决定的) |
| `set` | 写 `_buf[i]`, **不推**; 越界报错; rgb `& 0xFF` | 写像素缓冲, **不推**; 越界报错; rgb `& 0xFF`; 下标字段 `index`/`i` 都认 | ✅ |
| `set_many` | 写 `_buf`, **不推**; 越界报错 (**原子**: 2026-11-10 改成「先全校验再写」); rgb `& 0xFF`; 超过上限报 "too many pixels"; **空的 pixels 列表 → 回 ok (`set:0`)** | 写像素缓冲, **不推**; 越界报错 (**原子**: 先全校验再写); rgb `& 0xFF`; 超过 1024 报 "too many pixels"; **空的 pixels 列表 → 回 ok (`set:0`)** | ✅ (2026-11-10 起两边都原子) |
| `all` | 无 | 整个**物理**缓冲刷成同一色 (**不推**) | ESP32 独有 |
| `show` | 把 `_buf` 推给 strip (一帧 = `physical` 颗) | 把像素缓冲推给灯带 (一帧 = `physical` 颗) | ✅ |
| `off` | 清**整条物理链**再 render | 清**整个物理**缓冲并 show | ✅ |
| `ping` | `{ok, pong}` | `{ok, pong}` (WS 面; BLE 面是 `{ok, result:{pong}}`) | ✅ |
| `status` | ready / count / physical / pin / sets_pending / last_show_age_s | WS 面同形 (ready / count / physical / pin / sets_pending / last_show_age_s); BLE 面另有 name / ble_connected / led_initialized / max_lit / queue / bad_frames / dropped | ✅ (WS 面同形) |
| `marquee` | **没有** → 前端回退到逐帧发 | 设备侧跑完整段动画, 跑完才回执 | ESP32 独有 (更快) |
| `led.status` | 无 | 灯带状态 (initialized/pin/count/physical/brightness/max_lit) | ESP32 独有 |
| `led.getpix` / `led.litcount` | 无 | 回读像素缓冲 / 亮着的颗数 (诊断用) | ESP32 独有 |

> 这张表比的是**设备内部**的语义。前端现在走 WS 那条路 —— 固件会把回包重排成
> 树莓派那张扁平表, 对外长得一样 (见 §7.1)。

### 一帧的完整序列

两边**完全一样**:

```
set_many(要灭的像素)   → 只写缓冲
set_many(要点亮的像素) → 只写缓冲
show                   → 推一帧 (physical 颗)
```

树莓派端 `led.show` 走 WS 一次往返; ESP32 端 `led.show` 也是 WS 一次往返
(固件本地 bit-bang 推 352 颗 ≈ 10.6ms)。

---

## 3. 硬件差异 (改不了, 也不需要改)

| 项 | 树莓派 | ESP32-S3 |
|---|---|---|
| 波形生成 | rpi_ws281x (PWM + DMA, 硬件) | RMT (硬件 + DMA) —— 2026-11-11 起默认; bit-bang 只作对照 |
| 一帧耗时 (352 颗) | ~1~2ms (DMA) + Python 逐颗 setPixelColor | ~10.44ms 线上 + ~0.9ms 编码 = **11.37ms** |
| 帧长 | 永远 `physical` = 352 | 永远 `LED_PHYSICAL_COUNT` = 352 |
| 同时点亮上限 | 无 | 默认无 (`LED_MAX_LIT=0`), 可选 30 |
| 亮度 | 满亮度 255 | 满亮度 255 (`LED_BRIGHTNESS=255`) |
| 跑马灯 | 设备侧 `marquee` (2026-11-11 新增; 老服务回退前端逐帧) | 设备侧 `led.marquee` (一条命令) |
| 中间进程 | WS 桥 + 灯带服务 (两个) | **没有** (浏览器直连) |
| 前端链路 | WebSocket | WebSocket (2026-11-10 起 —— BLE 那条路删了) |

两边的跑马灯现在都是**设备侧**一条命令跑完 (44 帧 × ~11ms ≈ 0.5s),
帧间隔不受浏览器 rAF / 网络抖动影响 —— 这是「测试时乱闪」的另一半修法。
ESP32 的 `show()` 比树莓派慢 ~10ms 是 WS2811 串联移位的物理代价, 不是逻辑差异。

---

## 4. 前端怎么知道设备是哪种语义

★ **2026-11-10: 现在只有一个传输层 (`WsTransport`)**, 两台设备都是它:

| 能力 | 树莓派 | ESP32 | 前端怎么用 |
|---|---|---|---|
| `setManyShows` | `false` (永远要另发 show) | `false` (新固件) | `LedController.show()` 只在 `setManyShows === false` 时发 show —— 一帧只推一次 |
| `supportsDeviceMarquee` | `true` (2026-11-11 起; 老服务回退) | `true` | 设备端跑马灯; 老服务回 `unknown op` 时前端自动回退到逐帧 |
| `pin` (init 时发) | 18 (运行期可换, 白名单 12/18/21) | 14 (编译期固定) | `LED_DEVICE_INFO[device].pin` —— **按设备发** |

⚠️ **老固件/老服务例外**: 线上的 ESP32 可能还是旧固件, 树莓派也可能还没部署
新的 `led_remote.py`。`WsTransport` 对两种情况都有回退路径:
- `auth` 被拒 → 退回不带 auth 直接 init (旧固件回 `unknown op: 'auth'`)。
- `marquee` 回 `unknown op` → `LedController.testPattern()` 回退到前端逐帧。

2026-11-11: 固件已刷机验证 (RMT + `marquee`), 树莓派的 `marquee` 需要重新部署
`led_remote.py` / `led-remote.service` 才生效。

回归测试: `tests/led_esp32_pi_parity.test.ts` (14 例, 跑在 `WsTransport` 上)。

---

## 5. 2026-11-04 那轮对齐改了哪些

**固件 (`firmware/esp32s3/`)**

- `ble_led.cpp`
  - `led.set` / `led.set_many` / `led.all` → **只写缓冲, 不 show**。
  - `led.init` → 清屏 + show, 回执加 `physical` / `set_many_shows:false`。
  - `led.off` → 清**整个物理**缓冲 + show。
  - `led.set` / `led.set_many` → 下标 `index`/`i` 都认; rgb `& 0xFF`。
  - `led.set_many` → 像素个数超 1024 报 "too many pixels" (不默默截断); 空的
    pixels 列表回 ok (`set:0`), 跟树莓派端一个行为 (原来是报 "no pixels")。
  - `marqueeRun` → 扫**逻辑**范围 (跟树莓派那边前端逐帧的范围一致)。
  - `marqueeRun` 的窗口上限 **64** (`MARQUEE_WINDOW_MAX`) —— 颜色数组只有 64 字节,
    `window` 又是**客户端给的**, 超了会冲掉栈 (实测 `window=176` 把循环变量打烂 →
    死循环 → 板子变砖)。现在超了直接回 `"window too large"`。
- `ble_led.h` / `platformio.ini`
  - 新增 `LED_PHYSICAL_COUNT` (默认 352): 一帧推出去的颗数。
  - `stripCount` 改成**逻辑**灯数; 缓冲按物理灯数分配。
- `led_limits.h`
  - `LED_MAX_LIT` 默认 **0 (不限)**, 跟树莓派一致。
- `ws2811_bitbang.cpp` / `ws2812_rmt.cpp`
  - `applyMaxLit()` → `LED_MAX_LIT <= 0` 时直接返回 (不限)。

**前端 (`src/led/`)**

- `transport/BleTransport.ts`
  - `setManyShows` 改成 **getter**, 由 init 回执驱动。
  - `rpc()` 支持**每条命令**的 `timeoutMs`; 握手 5s, 跑马灯 3s, 运行时 1.5s。
- `LedController.ts`
  - `marquee` 的回执上限放宽到 3s (固件跑完动画才回执)。
  - `show()` 的注释改成「设备不自己刷时才发」。

**测试 (`tests/`)**

- `helpers/esp32Model.ts` → 重写成**忠实**的模拟器: 区分「设备缓冲」和
  「物理灯带」, 支持 `bufferOnly` (老固件) / `frameLength` (推短了尾巴留旧色) /
  `maxLit` (旧固件那个 30 颗上限) 三个开关。
- 新增 `tests/led_esp32_pi_parity.test.ts` (10 条)。
- `led_stuck` / `led_resync` / `led_ble_reliability` / `led_dual_strip_ble`
  → 按新语义 (set_many 只写缓冲, show 才刷) 调整断言。

---

## 6. 还没对齐 / 已知差异

| 项 | 说明 |
|---|---|
| pin | 树莓派运行期可换 (`--pin`), ESP32 编译期固定 (`LED_PIN`)。固件忽略前端传的 pin, 回报自己的实际值。 |
| `set_many` 原子性 | ★ **2026-11-10 已对齐**: 树莓派端也改成「先全校验再写」, 两边都原子。 |
| 一帧耗时 | ESP32 RMT ~10.44ms 线上 + ~0.9ms 编码 vs 树莓派 DMA ~1~2ms + Python 逐颗 setPixelColor。这是硬件差异, 不是逻辑差异。 |
| 跑马灯 | **两边都设备侧跑** (2026-11-11): 一条命令、一个回执, 44 帧 ≈ 0.5s。老服务/老固件回 `unknown op` 时前端逐帧回退。 |
| `marquee` 回执 | 两端都是跑完动画才回执, 所以前端的回执超时必须 > 动画时长 (现在是 3s)。 |
| `marquee` 谁有 | 两端都有 —— 树莓派 2026-11-11 新增, 与 ESP32 的 window/step/渐变语义一致。 |
| `auth` | ★ 树莓派那边**没配 token** → 桥不认 `auth` 这个 op, 转给 TCP server → 回 `"unknown op: 'auth'"`; ESP32 固件回 `{ok:true, authed:true}`。前端对两种回包都有回退。 |
| WS 那条路的延迟 | 树莓派走 5GHz (~2.7ms 往返), ESP32 只能 2.4GHz (~9ms 往返, 尾部 100ms) —— 瓶颈在**路由器往 2.4GHz 客户端发下行**那一段, 固件改不动 (§7.3)。 |

---

## 7. WiFi (WS) 这条路 —— 顶替树莓派那座桥

2026-11-05 加的第三条链路: 固件自己起一个 WebSocket server, **直接顶替**
树莓派上的 `ws_led_bridge.py` + `led_remote.py` 两层。

```
浏览器 ──WebSocket──> ESP32-S3 固件 (:8080, ws_led.cpp)
                                  │
                             bit-bang show()
```

前端**一行代码都不用改** —— `WsTransport` 说的是同一套裸 op
(`init` / `set` / `set_many` / `show` / `off` / `ping` / `status`),
`ledHost` 填 ESP32 的 IP 就行。

### 7.1 回包格式: 对外长得跟树莓派**一模一样**

设备内部 (固件的 BLE 那条路用) 的回包是嵌套的:

```json
{"id":1,"ok":true,"result":{"shown":true,"flushed":2}}
```

树莓派那边发出来的是扁平的:

```json
{"ok":true,"flushed":2,"id":1}
```

WS 这一路就是**拿来顶替那座桥的**, 对外必须长得一样 —— 不然现有脚本
(`ws_dual_check.py` / `ws_parity.py` 之类) 接不上。所以 `ws_led.cpp` 里
`piReply()` 把内部回包**重排**成树莓派那张表:

| op | 树莓派回包 | ESP32 (WS) 回包 |
|---|---|---|
| `init` | `{ok, count, physical, pin}` | 同 (pin 是本机的 GPIO 14) |
| `set` | `{ok}` | 同 |
| `set_many` | `{ok, set}` | 同 |
| `show` | `{ok, flushed}` | 同 |
| `off` | `{ok}` | 同 |
| `ping` | `{ok, pong}` | 同 |
| `status` | `{ok, ready, count, physical, pin, sets_pending, last_show_age_s}` | 同 |
| 别的 op | `{ok:false, error:"unknown op: 'xxx'"}` | 同 (`marquee` 是 ESP32 的**超集**, 见下) |

字段集、字段名、值的类型全一样; 只有 JSON 的空格和引号顺序不同
(树莓派是 `json.dumps` 默认带空格, 设备是紧凑格式) —— 解析后完全相等。

对照脚本: `firmware/esp32s3/ws_parity.py` —— 同一串命令分别打给两边,
把回包**解析后**并排比 (字段和值都要对得上):

```
$ python ws_parity.py
auth       {"ok": false, "error": "unknown op: 'auth'"}   ⚠️ 树莓派侧 (没配 token)
init       {"ok": true, "count": 176, "physical": 352, "pin": 18}  ✅ 一致 (pin 除外)
status     {...}                                            ✅ 一致
set_many   {"ok": true, "set": 2}                           ✅ 一致
show       {"ok": true, "flushed": 2}                       ✅ 一致
marquee    {"ok": false, "error": "unknown op: 'marquee'"}  ➕ ESP32 超集
off        {"ok": true}                                     ✅ 一致
ping       {"ok": true, "pong": true}                       ✅ 一致
```

已知差异 (脚本里的白名单):

- **`pin`**: 树莓派 GPIO 18, ESP32 GPIO 14 —— 硬件不同, 固件忽略前端传的
  pin 并回报自己的实际值。
- **`last_show_age_s`**: 运行时值 (距上次 show 多久), 两边各算各的。
- **`marquee`**: 树莓派没这个 op, ESP32 有 (设备侧跑动画, 一条命令跑完)。
  前端按 `supportsDeviceMarquee` 声明: 选 ESP32 时走设备端, 选树莓派时前端逐帧;
  老固件回 `unknown op` 时 `testPattern()` 自动回退到逐帧。
- **`auth`**: 树莓派那边是**桥**管的 —— 没配 token 时桥不认 `auth` 这个 op,
  直接转给 TCP server, 于是回 `"unknown op: 'auth'"`。ESP32 固件源码
  **2026-11-10 已改成回 `{ok:true, authed:true}`** (还没刷机, 线上的旧固件仍回
  unknown op)。前端 `WsTransport` 对 auth 失败有回退 —— 退回不带 auth 直接 init,
  所以两代固件都能连上。

### 7.2 前端怎么切过去

设置 → 灯带设备 → 选「**ESP32**」(默认是「树莓派」), 地址自动换成那台的默认 IP:

| 什么 | 值 |
|---|---|
| 设备 | ESP32 |
| 设备地址 | `192.168.1.108` (DHCP 拿到的, 路由器上按 MAC 保留) |
| 引脚 | 14 (编译期固定, 前端按设备自动发) |
| token | 留空 (ESP32 目前不校验) |

固件里的**静态兜底**是 `192.168.1.120` (`firmware/esp32s3/src/wifi_config.h`) —— 只在
DHCP 拿不到地址时才用, 不是板子平时的地址。前端两个都认 (算「ESP32 的地址」),
默认填 `.108`。

> ⚠️ **2026-11-11 更正**: 这段之前写反了 —— 当时把**静态兜底**的 `.120` 当成了默认地址,
> 还说 `.108` 是「旧值」。实际上板子平时跑在 DHCP 的 `.108` 上, `.120` 只是兜底。
> 前端默认地址、服务器反代目标 (`LED_WS_TARGET_ESP32`) 都已改回 `.108`。

HTTPS 部署时**地址栏不生效** —— 走服务端反代, 服务器按设备选上游:
`/led-proxy/pi` → `LED_WS_TARGET_PI`, `/led-proxy/esp32` → `LED_WS_TARGET_ESP32`。

### 7.2b 怎么确认设备在线 (设备校验接口)

固件里**没有** HTTP 健康检查端点 (`firmware/esp32s3/src/` 里没有 http 相关代码),
所以校验只能走 WS 的三个 op:

| op | 树莓派 | ESP32 | 用途 |
|---|---|---|---|
| `ping` | `{ok:true, pong:true}` | 同左 | 活着没 |
| `status` | `{ok:true, ready, count, physical, pin, sets_pending, last_show_age_s}` | 同形 | 几颗灯 / 哪个 GPIO |
| `marquee` | `{ok:false, error:"unknown op: 'marquee'"}` | `{ok:true, frames:N}` | **设备指纹** |

- `status` 里的 **`pin`** 字段一眼认出连的是哪台: 树莓派 **18** / ESP32 **14**。
- `marquee` 是第二个指纹: `ok:true` → ESP32; `unknown op` → 树莓派。

实测 (2026-11-10, 局域网扫 192.168.0.1–192.168.5.254 的 8080 端口): **只有
192.168.1.113 (树莓派) 开着**, ESP32 当时不在线 (没上电 / 没连上 WiFi)。

### 7.3 延迟: 这条路的**真问题** (不是固件的锅)

实测 (2026-11-05, PC 和树莓派都在 5GHz, ESP32-S3 只能 2.4GHz):

| 指标 | 树莓派 (5G) | ESP32 (2.4G) |
|---|---|---|
| `ping` 往返 (中位) | 2.7 ms | **9.0 ms** (p95 66ms, 最大 108ms) |
| `show` 往返 (中位) | 13.8 ms | 24.8 ms |
| 一帧 (5×set_many + show, 前端的发法) | 51 ms | **115 ms** (中位 103ms) |
| 折算帧率 | ~20 fps | **~9 fps** |

**定位过程** (每一步都是实测, 不是猜):

1. 固件侧的省电**已经关掉了** —— `esp_wifi_get_ps()` 直接问驱动 = `0 (NONE)`。
   (Arduino 的 `WiFi.getSleep()` 返回的是缓存值, 骗人, 必须用
   `esp_wifi_get_ps()`。)
2. 设备**到网关**的 TCP 往返 (同频段、不跨频段、不经过 PC) 同样是
   平均 23ms / 最大 57ms → **慢的是「路由器 → ESP32」这一段下行**,
   跟 PC 在哪个频段无关。
3. WS 往返的尾部最大值 103ms ≈ **一个 beacon 周期** (100 TU = 102.4ms)
   → 典型的「下行被路由器压到下一个 beacon 才发」。
4. `listen_interval` 从 3 调到 1 (断开重连一次) —— **实测延迟一点没变**
   (ping 中位 9.0 → 10.5ms, 每帧 115 → 118ms) → 关联参数不是瓶颈,
   固件里**没有**去动它 (白折腾一次重连, 换不来好处)。

结论: 瓶颈在**路由器 (D268G) 的 2.4GHz 无线口给客户端发下行**这一段
(它那会儿在打盹), 固件改不动。三个可选的解法:

- **路由器侧**: 关掉 2.4GHz 的省电 / 换个 AP。树莓派走 5GHz 所以没事。
- **硬件侧**: 换支持 5GHz 的 ESP32 (C5) —— 一步到位。
- **维持现状**: LED 跟随的更新本来就是「按音符事件」触发的 (一秒钟几次,
  不是 60fps), 多 30~100ms 的延迟肉眼看得出但不致命。

固件侧还能省的一块: `show()` 的 **bit-bang 10.6ms** (树莓派 DMA 只要 1~2ms)。
RMT 驱动 (`esp32s3-rmt` env) 就是干这个的 —— 见 §6 的「一帧耗时」。

### 7.4 固件里 WS 那一路的两个坑

- **栈**: WS 的事件回调跑在 Arduino 的 **loopTask** 里, 栈只有 8KB。
  回调里放一个 4KB 的局部数组就能把栈冲爆 —— 真机踩过:
  `Guru Meditation / Stack canary watchpoint triggered (loopTask)`, 设备直接重启。
  → `ws_led.cpp` 里所有大 buffer 都是 `static`, `requestOp()` 在原地扫、
  一个字节都不拷。
- **回执必须条条有**: 前端 `WsTransport` 的 `onMessage` 每收到一条回包就把
  `inFlight` 减一 —— **设备少回一条, `drain()` 就永远挂着**。
  固件对每条命令都回一条 (包括错误)。

### 7.5 诊断脚本 (都在 `firmware/esp32s3/`)

| 脚本 | 干什么 |
|---|---|
| `ws_parity.py` | 树莓派 vs ESP32 的回包**逐字段**对比 (§7.1) |
| `ws_dual_check.py` | 照抄前端的握手顺序走一遍, 并用设备自己的 `getpix` 回读缓冲 |
| `ws_frame_bench.py` | 照抄前端一帧真正发的东西, 量帧率 (§7.3) |
| `ws_rtt.py` | 连发 N 条 ping, 出往返分布直方图 |
| `ws_curve.py` | 延迟是「每条命令的固定成本」还是「随 payload 变大」 |
| `serial_cli.py` | 串口跟板子说话 (`wifi info` / `wifi rtt` / `wifi scan` …) |

串口的 `wifi` 子命令:

- `wifi info` —— 打印**驱动里真实的**省电状态 (`esp_wifi_get_ps`),
  `listen_interval`, 当前 AP 的信道/RSSI/协议。
- `wifi rtt [n]` —— 量 n 次**到网关**的 TCP 往返 (同频段, 用来把
  「路由器下行慢」和「跨频段慢」分开)。
