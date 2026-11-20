# ESP32-S3 LED 外设固件 (pianoflow)

把 piano-follow 的 176 颗 WS2811/WS2812 灯带从树莓派挪到一块 ESP32-S3 上,
通过 BLE 无线控制。

## 硬件

| 项 | 值 |
|---|---|
| 板子 | ESP32-S3 DevKitC-1 (QFN56, rev 0.2) |
| 数据线 | GPIO14 → 灯带 DIN |
| 灯带 | 176 颗 WS2811/WS2812, 800kHz, **GRB** (双色带时两条串联 = 352 颗) |
| 物理灯数 | `LED_PHYSICAL_COUNT` = 352 (一帧推出去的颗数, 见下面「物理 / 逻辑灯数」) |
| 供电 | 树莓派的 3.3V 电源直接可用 —— 树莓派 GPIO 也是 3.3V, 不需要电平转换 |
| Flash | **实际 8MB** (esptool 的 flash-id 报 16MB 是错的, 以 ROM bootloader 为准) |

## 为什么是 BLE 而不是经典蓝牙 SPP

ESP32-S3 **砍掉了经典蓝牙射频**, 只有 BLE。SDK 里 `soc_caps.h` 有
`SOC_BT_SUPPORTED=1` 但没有 `SOC_BT_CLASSIC_BT_DEVICE_SUPPORTED`,
所以 Arduino 的 `BluetoothSerial` (SPP) 在 S3 上根本用不了。

BLE 走 GATT 服务端: Windows 11/10 原生支持, 不需要装驱动。

## GATT 结构

Nordic UART 风格:

```
Service  : 6e400001-b5a3-f393-e0a9-e50e24dcca9e
  └ RX (write) : 6e400002-...   主机 → 设备
  └ TX (notify): 6e400003-...   设备 → 主机
```

设备广播名 **`pianoflow`**。

## 命令协议

跟树莓派端 `scripts/bt_pi/pi/bt_gpio_daemon.py` 一致 (JSON 行):

```
主机 → 设备: \x02{"id":"x","op":"led.set","args":{"index":0,"r":0,"g":0,"b":200}}\n
设备 → 主机: {"id":"x","ok":true,"result":{"index":0,"r":0,"g":0,"b":200}}\n
```

开头的 `\x02` (STX) 是 **2026-10-26 加的帧头**: 分片写失败重试时, 设备看到它
就把上一轮残留的半行丢掉, 从头开始收 —— 不会拼出垃圾 JSON。

支持的 op: `ping` / `status` / `led.init` / `led.set` / `led.all` /
`led.set_many` / `led.show` / `led.off` / `led.marquee` / `led.status`

### ★ 缓冲 vs 物理灯带: `set` / `set_many` **只写缓冲** (2026-11-04)

跟树莓派端 `scripts/bt_pi/pi/led_remote.py` **完全一致**的语义:

| op | 作用 |
|---|---|
| `led.set` / `led.set_many` / `led.all` | **只写像素缓冲**, 不推给灯带 |
| `led.show` | 把缓冲推给灯带 (一帧) |
| `led.off` | 清空**整个物理**缓冲并推出去 |
| `led.marquee` | 设备侧跑完整段动画 (每帧自己 show) |

`led.init` 的回执里带 `"set_many_shows": false`, 主机据此知道「set_many 不
会自己刷」, 于是**一帧只推一次**:

```json
{"id":"x","op":"led.init","args":{"count":352,"pin":14}}
{"id":"x","ok":true,"result":{"pin":14,"count":352,"physical":352,"set_many_shows":false}}
```

老固件没有这个字段 → 主机按「set_many 自己会 show」处理, 新前端连老固件照样能用。

为什么值得改: 以前 `led.set_many` 内部就 `show()`, 一个动画帧里的多条
set_many 会各自推一次 → **中间状态被看到** = 画面撕裂 (用户报的「异常闪」)。
现在跟树莓派一样, 一帧只推一次。

### 物理 / 逻辑灯数 (2026-11-04)

WS2811 是**串联**的: 一帧必须把整条链的数据都推出去。链上真实接了 352 颗
(两条灯带串联) 而只推 176 颗的话, 后面那截的移位寄存器收不到数据, 会**保持
上一帧的颜色** (残留鬼影)。

所以固件分两个数:

- **物理** (`LED_PHYSICAL_COUNT`, 编译期固定) = 一帧推出去的颗数。默认 352。
  只接了一条 176 颗的带的话, 编译时改成 `-D LED_PHYSICAL_COUNT=176`
  (少推一半, 每帧快一倍)。
- **逻辑** (`led.init` 的 `count`, 白名单 176 / 352) = 「允许写哪几颗」。
  逻辑灯数变小时, 逻辑范围之外的那截会被抹黑并刷出去。

树莓派那边 (`led_remote.py`) 一直就是这么分的 (`--physical-count 352`)。

### 同时点亮的颗数上限 (LED_MAX_LIT)

**默认 0 = 不限**, 跟树莓派端一致 (那边根本没有这个限制)。

以前这里写死 30 颗, 结果谱子一密就把**下标最大**的那批灯悄悄灭掉 —— 而双色带
的上灯带恰好是下标最大的 → 上灯带经常「自己灭一半」。供电真的扛不住时再打开:
`-D LED_MAX_LIT=30` (30 颗 ≈ 1.8A; 176 颗全亮 = 10.5A, 真机已经因此掉过一次线)。

`led.marquee` 的窗口也会被这个上限夹住 (开了上限时), 免得跑马灯「缺一块」。

`led.marquee` 是设备侧跑马灯 (一条命令跑完整个动画):

```json
{"id":"x","op":"led.marquee","args":{"window":6,"step":2}}
{"id":"x","ok":true,"result":{"frames":88}}
```

`led.set` 的像素字段 `index` / `i` **都认**; `led.set_many` 里的像素数组同样
两个都认 (树莓派那边叫 `i`)。rgb 超出 0..255 时按 `& 0xFF` 截断, 不报错 ——
跟树莓派端一个行为。

## 编译 / 烧录

```bash
cd firmware/esp32s3

# 默认: RMT 硬件驱动 (真机验证过, 波形零抖动) —— 烧这个
python -m platformio run -e esp32s3 -t upload --upload-port COM5

# 可选: 软件 bit-bang (对照/没有 RMT 的板子; ⚠️ 连网时会被无线中断打坏)
python -m platformio run -e esp32s3-bitbang -t upload --upload-port COM5

# 纯 LED 自检 (不连 BLE/WiFi, 上电亮第 1 黄 + 第 10 红)
python -m platformio run -e esp32s3-selftest -t upload --upload-port COM5
```

串口日志 (115200):

```
[boot] app start
[boot] strip ok
[ble] init...
[ble] advertising as pianoflow
esp32s3-led ready
status count=176 physical=352 pin=14 bright=255 driver=rmt lit=1/inf
```

### 工具链下载 (国内网络)

PlatformIO 官方源单连接限速 ~19KB/s。`fetch_pkgs.py` 是绕过办法 ——
对 `api.registry.platformio.org` 做 32 连接分段下载 + sha256 校验,
装到 `~/.platformio/packages/`。约 600KB/s。

```bash
python fetch_pkgs.py
```

注: 国内没有 PlatformIO / GitHub ESP32 包的镜像 (清华/中科大/南大/北外
的 github-release 镜像里都没有)。

## USB 串口命令

不重新烧固件就能调灯:

```
on <idx> <r> <g> <b>   点亮第 idx 颗
off <idx>              熄灭第 idx 颗
offall                 全灭
status                 回读状态
wave                   ★ RMT RX 回环抓自己发出去的波形 (逐 bit 量宽度)
diag                   分步诊断 (diag 连按 6 次, 第 6 步是 bit-bang 时序)
dprobe / recal         bit-bang 延时原语的原始曲线 / 重新标定
first / walk / sweep   静态基准图案 / 逐颗走位 / 全条扫一遍
count <176|352>        换逻辑灯数 (范围外的那截会被抹黑)
```

索引 0-based, 与前端 `LedController` 的 LED 索引一致 (0 = 最低音 A0)。

`wave` 是最有用的一个: 它用另一个 RMT 通道 (RX) 在**同一根 GPIO** 上
回环抓波形, 打印每种图案的 0/1 高电平宽度范围。RMT 驱动应该是
`0高 32..32 / 1高 64..64 (偏差 0)`; 如果是 bit-bang, 会看到被中断拉长的
234/431 tick —— 那就是「乱闪」的根因。

## PC 端

### WiFi / WebSocket (顶替树莓派那座桥)

固件自己起一个 WebSocket server (:8080), 说的是**树莓派那边同一套裸 op**
(`init` / `set` / `set_many` / `show` / `off` / `ping` / `status`),
回包也重排成树莓派的扁平格式 —— 所以**前端一行代码都不用改**, 把
`ledHost` 填成这块板子的 IP 就行:

| 什么 | 值 |
|---|---|
| 主机 | `192.168.1.108` (DHCP 拿到的, 建议在路由器上按 MAC 保留) |
| 后端 | WebSocket |
| token | 留空 (固件目前不校验) |

DHCP 挂了时的静态兜底是 `192.168.1.120` (`src/wifi_config.h`)。

- WiFi 凭据**不写进仓库** —— 用串口命令现填 (存 NVS, 断电不丢):
  `wifi <SSID> <密码>` / `wifi clear` / `wifi` (只看当前凭据)。
- ⚠️ **ESP32-S3 只支持 2.4GHz** —— 路由器把 2.4G / 5G 拆成两个 SSID 的话,
  一定要连 2.4G 那个。
- 固件连上后会调 `esp_wifi_set_ps(WIFI_PS_NONE)` 关掉省电 —— 不关的话
  发出去的包会被压在驱动里等下一个 beacon, 延迟飘 (几十 ms 一跳)。
  ⚠️ 必须**连上之后**再调 (Arduino 3.x 的 `WiFi.setSleep()` 在 STA 没启动时
  只缓存值不生效)。

逐条 op 的回包对照、延迟实测与定位过程 → `docs/esp32-pi-parity.md` §7。

#### 诊断脚本 (都在这个目录)

| 脚本 | 干什么 |
|---|---|
| `ws_parity.py` | 树莓派 vs ESP32 的回包**逐字段**对比 |
| `ws_dual_check.py` | 照抄前端的握手顺序走一遍, 并用设备自己的 `getpix` 回读缓冲 |
| `ws_frame_bench.py` | 照抄前端一帧真正发的东西, 量帧率 |
| `ws_rtt.py` | 连发 N 条 ping, 出往返分布直方图 |
| `ws_curve.py` | 延迟是「每条命令的固定成本」还是「随 payload 变大」 |
| `serial_cli.py` | 串口跟板子说话 (`wifi info` / `wifi rtt` / `wifi scan` …) |

```bash
python ws_parity.py                                  # 默认打 树莓派 + ESP32
python ws_dual_check.py 192.168.1.108 352            # 双色带 (352 颗)
python serial_cli.py "wifi info" 5                  # 串口: 真实省电状态 / AP 信息
python serial_cli.py "wifi rtt" 6 12                # 串口: 到网关的往返 (同频段)
```

### 浏览器直连 (蓝牙, 当前主用)

前端**直接**用 Web Bluetooth 连这块板子, 中间不需要任何常驻进程:

```
浏览器 --Web Bluetooth--> ESP32-S3 (pianoflow)
```

实现在 `src/led/transport/BleTransport.ts`, 外面套一层
`BackendTransport` —— 后端由**用户自己选** (蓝牙 / 树莓派), 不猜、不回落。
详见仓库根目录 README。

要点:

- `requestDevice()` **必须**在用户手势里同步调用 —— 所以只有设置面板的
  「连接 ESP32」按钮能触发配对, 自动连接流程弹不出选择器。
- 一条命令按 MTU 247 (244 字节载荷) 分片, **所有写严格串行** ——
  两条命令并发写的话片会交错, 设备按行重组出来就是垃圾。
- **每片用 write-with-response (一问一答)**, 不是 write-without-response。
  后者在 Chrome 里把数据交给系统蓝牙栈就 resolve, 控制器缓冲满了会**静默
  丢包** —— 设备收到半条命令, 正好是「乱闪 / 常亮 / 亮三颗」的来源。
  一问一答慢一点, 但每片都确认到达, 而且天然有背压。
- 每条命令带**帧头 STX (`\x02`)**: 分片失败重试时, 设备靠帧头把上一轮的
  半行丢掉, 不会拼出垃圾 JSON。
- 在途 (已发未回) 的命令最多 6 条 —— 固件的 RX 队列有 8 个槽, 满了会回
  `rx queue full`。回执超时 1.5s (握手 5s, 设备侧跑马灯 3s); 超时后前端
  按影子表整条重刷。
- 刷新页面后 Chrome/Edge 交不出上次授权的设备 (`getDevices()` 默认关闭),
  用户得再点一次「连接 ESP32」。
- `led.init` 的回执决定「set_many 自己刷不刷」(`set_many_shows`): 新固件
  回报 `false` → 前端一帧只发一次 `show`, 跟树莓派完全一致。老固件没这个
  字段 → 前端按老行为 (不额外发 show), 照样能连。

### 交互式客户端 (调试用)

```bash
pip install bleak
python scripts/bt_pi/pc/ble_led_client.py
```

```
ping / status / led <i> <r> <g> <b> / ledall <r> <g> <b> / off / ledstatus
```

### 协议自检 (改固件或前端后跑一下)

`scripts/bt_pi/pc/check_frontend_protocol.py` 模拟前端 `BleTransport` 的写法
(同样的 op 名、同样的 MTU 分片), 连真机验一遍:

```bash
python scripts/bt_pi/pc/check_frontend_protocol.py
```

会检查: `led.init`/`led.off` 握手、`led.set` 的 `index` 字段、
80 像素 `led.set_many` 分片后能重组、以及前端那套不带前缀的 op 名固件确实不认。

### WebSocket ↔ BLE 桥 (旧方案, 保留)

以前前端只会说 WebSocket, 需要一个桥把 WS 翻译成 BLE。现在前端已经能直连
蓝牙了, 这个桥不再是必需的, 但代码留着 (比如给不支持 Web Bluetooth 的
浏览器用):

```bash
pip install bleak websockets
python scripts/bt_pi/pc/ble_led_bridge.py --port 8080
```

前端把 `ledHost` 指向这台机器的 IP 即可, 协议跟树莓派端的
`ws_led_bridge.py` 完全一致 (含 token 鉴权)。

## 实现上的坑

### 灯带驱动: 默认 RMT 硬件, bit-bang 只作对照

**默认**: `src/ws2812_rmt.cpp` —— IDF 5 的 RMT TX 驱动 + **bytes encoder + DMA**。
波形由硬件按 10MHz tick 生成 (0.4/0.8µs)，WiFi/BT 中断完全不参与。
352 颗 = **10.44ms/帧** (物理下限)，`show()` 实测 **~10.6ms**。

bytes encoder 的 `bit0`/`bit1` 模板正好是「一个 bit 的高/低两段」：
`bit0 = 高4+低8 tick`、`bit1 = 高8+低4 tick`、MSB first。传的负载就是
`pixels_` (352×3 = 1056B) —— **不需要把整帧预编码成 8449 个 symbol**。

> ★ 2026-11-11 的教训（真机掉线）：第一版是「整帧 33.8KB symbol 缓冲 + 8KB
> 查表」，启动看着没事，但把 free heap 压到 **7.8KB** → lwIP 分配不出
> ARP/DHCP 缓冲 → `WiFi.status()` 仍报 connected，PC/树莓派却 100% 丢包、
> ARP 一直 INCOMPLETE。换成 bytes encoder 后 static RAM 143KB → **106KB**，
> 不再占那 42KB。

**链路看门狗** (`wifi_link.cpp`)：`WiFi.status()` 会撒谎 —— 驱动状态机报
connected，实际 lwIP 已经死了。所以有一个跑在 core 0 的任务每 15 秒从设备侧
TCP 连一下网关 (80/53)，连续 2 次失败就让 `loop()` 强制 `WiFi.disconnect()`
+ 重连。`status` 里新增 `heap` / `minheap` / `reset`，掉线先看这两个数。

**为什么换掉 bit-bang** (2026-11-11): 用户刷了 R31 之后「跑马灯有, 但乱闪 +
有一些奇怪的灯亮起来」。给 bit-bang 加了 **RMT RX 回环** (`wave` 命令),
把发出去的波形抓回来逐 bit 量:

| 图案 / 指标 (tick @80MHz) | 无 BLE/WiFi (selftest) | **有 BLE/WiFi (正常固件)** | RMT |
|---|---|---|---|
| 0 bit 高电平 min..max | 29..256 | **27..234** | **32..32** |
| 1 bit 高电平 min..max | 61..82 | **60..431** | **64..64** |

理论值 0 高 = 32 tick (0.4µs), 1 高 = 64 tick (0.8µs)。有无线时 0 bit 的
高电平被拉到 **234 tick = 2.9µs** → WS2811 把它读成 1 → 灯带乱闪/随机亮。

**根因**: `portENTER_CRITICAL()` 只把本核中断级别抬到 3,
**level 4+ 的 WiFi/BT 控制器中断照跑**。一次几微秒的 ISR 就足以把一个
0 bit 拉成 1 bit —— 这条路在「WiFi/BT 同时开着」的固件里**无解**。
所以 RMT 不是「可选优化」, 而是**唯一正确的做法**。

**bit-bang** (`src/ws2811_bitbang.cpp`) 仍然保留 (`env:esp32s3-bitbang`),
但只适合不连网的固件 (selftest)。R31 那版热循环里为了让「标定倒挂」不回绕,
把 `nHigh = nH0 + dH*one` 改成了三处 `?:` —— Xtensa 没有条件传送, `?:`
会编成分支, 数据 0/1 随机 → 分支预测失败 → 每个 bit 都抖。现在改回纯算术,
倒挂保护挪到标定结束的 `normalizeCalibration()` (只跑一次)。

> ★ 调驱动之前先跑串口 `wave`。别再凭「`[calib]` 数字漂亮」下结论 ——
> 标定只测全 0/全 1 两种图案, 分支/中断造成的逐 bit 抖动**完全看不出来**。

试过但不能用的:

1. **Adafruit_NeoPixel** —— `espShow()` 在栈上开 `rmt_data_t led_data[numBytes*8]`,
   176 颗灯约 34KB, Arduino 默认任务栈 8KB → 爆栈
   ("Guru Meditation Error: Stack canary watchpoint triggered")。
2. **NeoPixelBus + NeoPixelBusIdf5Rmt** —— 在当前 Arduino-ESP32 3.3.12 /
   IDF 5.5 上编不过 (用了已移除的 `gpio_hal_iomux_func_sel`)。

### BLE 命令不能在写回调里执行

BLE 的写回调跑在蓝牙 host task 里, 而 `show()` 要占住 CPU 10.6ms —— 在回调
里直接执行会阻塞蓝牙栈。所以写回调只负责把字节搬进队列, 真正的命令解析/执行
放在 Arduino `loop()` 里。

### 断开后要恢复广播

框架默认 `advertiseOnDisconnect = false` —— 主机断开后设备就停止广播,
PC 端再也扫不到, "自动连接"直接断送。必须显式开:

```cpp
g_server->advertiseOnDisconnect(true);
```

### 命令分片: 帧头 + 严格校验 (2026-10-26)

一条 `led.set_many` 经常超过 ATT 载荷 (244 字节), 要拆成好几片。以前有两类
问题:

1. **某片写失败/被丢** → 设备手上剩半行 JSON; 前端从头发一遍重试 → 半行 +
   新命令拼成一条垃圾. 固件按 key 搜索, 会把它"半解析"成错误的像素 →
   **随机像素亮/灭、按一个键亮三颗**.
2. **队列满静默丢** → 前端等不到回执, 要等超时才放槽位, 整条 BLE 流水卡住.

现在的协议:

- 每条命令以**帧头 STX (`\x02`)** 开头。固件一看到 STX 就把当前半行丢掉,
  从新命令重新开始 —— 重试是安全的。旧固件不认识 STX, 但它的解析器按 key 搜,
  多一个控制字符不影响, 所以新前端仍能连旧固件。
- 固件只在整行是**完整 JSON 对象** (`{...}`) 时才入队; 半行/拼坏的帧直接丢,
  计入 `bad_frames`, 绝不"半解析"后执行。
- 队列满时回 `{"ok":false,"error":"rx queue full"}`, 不再静默丢。
- 前端改成**一问一答** (write-with-response): 每片都确认到达, 不再出现
  "Chrome 提前 resolve、控制器静默丢包"的情况。
- 回执超时 5s → **1.5s**; 超时/设备报错时前端按"影子像素表"整条重刷
  (`LedController.resync()`), 把幽灵像素清掉。

### 跑马灯: 设备侧动画 (2026-10-26)

旧实现一帧一条 BLE 命令, 176 条 GATT 往返 —— 真机 1.7~3 秒, 用户记的 0.5s
根本到不了。

现在 ESP32 走 **`led.marquee`**: 一条命令, 板子本地 44 帧 × 10.44ms ≈ **0.49s**
跑完, 与 BLE 吞吐无关; 动画期间也不会有别的命令插进来 (不会「跑的时候其他灯
乱闪」). 树莓派端 (`led_remote.py`) 2026-11-11 也加了同语义的 `marquee`. 参数:

```json
{"id":"x","op":"led.marquee","args":{"window":6,"step":4}}
```

`step` = 每帧前进几颗 (`marqueeStep()` 按 0.5s 目标算, 176 颗 → 4, 352 颗 → 8). 设备
**跑完动画才回执**, 前端 `await` 到回执时灯已经停了.

旧固件没有这个 op (回 `unknown op`), 前端会自动回退到逐帧发 —— 帧数同样减半
(≤ 100 条), 慢一点但能用.

### 上电点亮第 1 颗黄灯, 一直亮到主机握手

```cpp
g_strip.setPixel(0, 255, 255, 0);   // LED 0 = 黄色
g_strip.show();
```

以前是「闪一下就灭」, 用户来不及确认烧录/接线/供电通不通。这颗黄灯会一直亮着,
直到主机发来 `led.init` / `led.off` (前端握手就是 init + off, 所以连上就没了)。

不想要这颗灯: 编译时加 `-D LED_BOOT_TEST_PIXEL=0`。

### 「几颗灯常亮」到底是怎么来的

前端的配色: 红 (右手白键) / 橙 (右手黑键) / 蓝 (左手白键) / 绿 (左手黑键).
**每个音固定 2 颗灯**, 所以:

- **偶数颗、成对** → 很可能是真实的按键/预览状态 (暂停时预览当前和弦是正常的).
- **奇数颗 (比如 3 绿 + 1 红 + 1 蓝 = 5 颗)** → 不可能是正常状态, 一定发生了
  "半条命令生效" 或 "整帧只刷了一半":
  - 清屏帧被中断打断 → 截断点之后的灯保持旧颜色 (灯如果集中在灯带某一端,
    基本就是它);
  - 分片丢包 + 旧固件半解析 → 错误下标被写进有效颜色 (灯如果散落在不同音区).

用 `status` 命令可以看固件的 `queue` / `bad_frames` / `dropped` 计数:

```json
{"id":"x","op":"status"}
{"id":"x","ok":true,"result":{"name":"pianoflow","ble_connected":true,"led_initialized":true,"pin":14,"count":176,"physical":352,"max_lit":0,"queue":0,"bad_frames":0,"dropped":0}}
```

`bad_frames > 0` 或 `dropped > 0` = 通信侧真的丢过帧, 需要查 MTU / 链路。
`max_lit` = 同时点亮的颗数上限 (0 = 不限)。

### 前端发的 pin 是树莓派的

前端默认 `pin: 18` (树莓派 GPIO)。ESP32 的引脚是编译期固定的
(platformio.ini 里的 `LED_PIN`), 硬件上改不了, 所以 `led.init` 忽略传入值,
回报本机的实际 pin/count。

### op 名要翻译

固件只认 `led.init` / `led.set` / `led.set_many` / `led.show` / `led.off` /
`led.marquee` 这一套 (`led.*`), 前端内部说的是 `init` / `set` / `set_many` /
`show` / `off` / `marquee`。蓝牙传输层里有一张 `DEVICE_OPS` 表做映射 ——
**写的时候别忘了翻译**, 直接发前端的 op 名, 设备会回 `unknown op`。

### 亮度

前端 `LedController` 已经在主机侧乘过 brightness, 树莓派端 `rpi_ws281x`
也是满亮度 (255), 所以固件的 `LED_BRIGHTNESS` 保持 255, 与树莓派行为一致。

## 与树莓派端的一致性

固件的目标是**换到 ESP32 后用户完全看不出差别**。逐条 op 的对照表、两条链路的
「触发方式」差异 (WS→TCP→PWM/DMA vs Web Bluetooth→GATT→bit-bang), 以及
2026-11-04 那轮对齐改了哪些东西, 都写在:

```
docs/esp32-pi-parity.md
```

回归测试在 `tests/led_esp32_pi_parity.test.ts` —— 它跑在
`tests/helpers/esp32Model.ts` (固件的 JS 模拟器) 上, 钉住「一帧只推一次」
「物理帧长」「rgb 截断」「越界报错」「老固件兼容」这几条。
