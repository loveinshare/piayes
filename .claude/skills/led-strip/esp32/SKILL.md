---
name: led-strip-esp32
description: ESP32-S3 灯带外设固件 (pianoflow) —— 硬件与框架约束 (无 SPP / 8MB flash / RMT 放不下 / Adafruit 爆栈 / NimBLE 回调)、BLE GATT 结构与命令协议、帧头 STX 与 RX 队列、bit-bang 驱动的关中断要求、编译烧录与自检 env、USB 串口诊断命令。改固件、烧录、BLE 握手失败、灯常亮时读这个技能。
---

# ESP32-S3 固件 (pianoflow)

固件在 `firmware/esp32s3/`。**最全的一份笔记是 `firmware/esp32s3/README.md`** ——
本技能是它的浓缩 + 排障视角。

## 1. 硬件与框架的硬约束 (不看代码就会踩)

| 约束 | 事实 | 后果 / 绕法 |
|---|---|---|
| **没有经典蓝牙 (SPP)** | `soc_caps.h` 有 `SOC_BT_SUPPORTED=1` 但**没有** `SOC_BT_CLASSIC_BT_DEVICE_SUPPORTED` | Arduino 的 `BluetoothSerial` 用不了 → 只能 BLE (GATT 服务端) |
| **flash 实际 8MB** | esptool 的 flash-id 报 16MB 是**错的**, 以 ROM bootloader 为准 | 用 16MB 分区表会启动失败: `partition 3 invalid ... exceeds flash chip size 0x800000` → `board_build.flash_size = 8MB` + `default_8MB.csv` |
| **RMT 装不下整帧** | `SOC_RMT_MEM_WORDS_PER_CHANNEL` 只有 48; 物理 352 颗要 352×24 = **8448 symbols**; DMA 模式开到 2047 symbols 也 "flush timeout" | 用自写的软件 bit-bang (`src/ws2811_bitbang.cpp`), 物理 352 颗 ≈ 10.6ms |
| **Adafruit_NeoPixel 不可用** | `espShow()` 在栈上开 `rmt_data_t led_data[numBytes*8]` ≈ **34KB**, Arduino 默认任务栈 8KB | 爆栈 (Guru Meditation: Stack canary) → 不要引这个库 |
| **Arduino-ESP32 4.x 在 S3 上是 NimBLE 不是 Bluedroid** | 回调签名 `onConnect(BLEServer*, ble_gap_conn_desc*)`; `chr->getValue()` 返回 `String` 不是 `std::string` | 照 Bluedroid 的写法编译不过 |
| **框架默认 `advertiseOnDisconnect = false`** | 主机断开后设备停止广播, PC 再也扫不到 | 必须显式 `g_server->advertiseOnDisconnect(true)`, 否则「自动连接」直接断送 |
| **BLE 单次写受 MTU 限制** | 协商到 247 → 载荷 **244** 字节 | 前端一批 80 像素的 `set_many` 约 2.5KB, 必须分片, 否则 `GATT Protocol Error: Insufficient Resource` |
| **写回调不能执行耗时命令** | 回调在蓝牙 host task 里, bit-bang 的 `show()` 阻塞 10.6ms | 回调只入队, 命令解析/执行放 Arduino `loop()` |
| **国内没有 PlatformIO / GitHub ESP32 镜像** | 清华/中科大/南大/北外都没有 | `firmware/esp32s3/fetch_pkgs.py` 做 32 连接分段下载 (~19KB/s → ~600KB/s) |

## 2. GATT 结构

```
Service  : 6e400001-b5a3-f393-e0a9-e50e24dcca9e   (Nordic UART 风格)
  └ RX (write)  : 6e400002-...   主机 → 设备
  └ TX (notify) : 6e400003-...   设备 → 主机
```

- 广播名: **`pianoflow`**
- 角色: GATT **服务端**, 主机主动连。Windows 11/10 原生支持, 不用装驱动。

## 3. 命令协议

JSON 行, `\n` 结尾, 请求/响应都带 `id`:

```
主机 → 设备: \x02{"id":"x","op":"led.set","args":{"index":0,"r":0,"g":0,"b":200}}\n
设备 → 主机: {"id":"x","ok":true,"result":{"index":0,"r":0,"g":0,"b":200}}\n
```

- **开头的 `\x02` (STX) 是帧头** (2026-10-26 加的): 固件一看到它就把上一轮残留的半行丢掉,
  从头开始收 → 分片失败重试是安全的。旧固件不认识它 (按 key 搜的解析器, 多一个控制字符不影响)。
- op 集: `ping` / `status` / `led.init` / `led.set` / `led.all` / `led.set_many` /
  `led.show` / `led.off` / `led.marquee` / `led.status`
- `led.set` 像素字段是 `index`; `led.set_many` 的像素数组用 `i`。
  前端的 `i` → `index` 的翻译在 `src/led/transport/BleTransport.ts`。
- `led.init` **忽略**前端传的 pin (ESP32 引脚是编译期固定的), 回报本机实际 pin/count。

### 队列与坏帧

- `RX_QUEUE_SLOTS = 8` (2026-10-26 从 4 加上来 —— 4 槽时在途深度 6 就丢)。
- 队列满 → 回 `{"ok":false,"error":"rx queue full"}` (旧行为是**静默丢**, 灯会漏亮)。
- 只有整行是**完整 JSON 对象** (`{...}`) 时才入队; 半行 / 拼坏的帧直接丢, 计入 `bad_frames`,
  **绝不"半解析"后执行** (半解析会把错误下标写进有效颜色 → 随机像素亮灭)。

### 设备侧跑马灯 `led.marquee`

```json
{"id":"x","op":"led.marquee","args":{"window":6,"step":2}}
{"id":"x","ok":true,"result":{"frames":88}}
```

一条命令, 板子本地 44 帧 × 10.6ms ≈ **0.47s** 跑完, 与 BLE 吞吐无关;
动画期间别的命令插不进来 (不会「跑的时候其他灯乱闪」)。**跑完才回执** ——
前端 `await` 到回执时灯已经停了。旧固件没这个 op (回 `unknown op`), 前端自动回退到逐帧发。

## 4. 灯带驱动

### 默认: 软件 bit-bang (`src/ws2811_bitbang.cpp`)

直接翻 GPIO 寄存器 (`GPIO_OUT_W1TS_REG` / `GPIO_OUT_W1TC_REG`),
用 `esp_cpu_get_cycle_count()` 精确计时。

> **⚠️ 关键修复 (2026-10-26): `show()` 整帧必须关中断。**
> 这 10.6ms 里只要进一次中断, 某个 bit 的高电平就被拉长几微秒, WS2811 会把它当成 latch:
>
> - 帧在被打断的灯处**提前锁存**, 后面的灯保留上一帧颜色 → 「跑马灯跑一半, 其他灯乱闪」
> - `off`/清屏帧被打断 → 尾巴几颗灯**灭不掉**, 一直亮着 → 「几个灯莫名其妙常亮」
>
> 现在 `show()` 用 `portENTER_CRITICAL` 把 8448 个 bit (物理 352 颗 × 24) 一次发完
> (BLE 在 core 0, 关的是 loop 所在的 core 1, 蓝牙不断)。

### 可选: 自写 RMT (`src/ws2812_rmt.cpp`)

IDF 5 的新 RMT TX + 流式 copy encoder, 波形由硬件生成。**能编译, 但没在真机验证过**
→ 单独放在 `env:esp32s3-rmt`, 别当默认。

之前关于 RMT 的两个说法要**更正**:

1. 「RMT 每 channel 48 words 放不下 176 颗灯」—— 那是**旧 API 把整帧预装进 RMT 内存**的思路。
   新驱动的 `mem_block_symbols` 只是硬件缓冲 (我们用 64), 编码器是**流式**回调。
2. 「DMA 只能 2047 symbols」—— 那是旧驱动的上限。新驱动用 `flags.with_dma` + 流式编码。

但 RMT 只解决**发波形**这一层; 「跑马灯慢 / 常亮 / 亮三颗」还有 BLE 协议层的原因, 光换 RMT 不够。

## 5. 编译 / 烧录 / 自检

```bash
cd firmware/esp32s3

# 默认 (已真机验证, 先烧这个)
python -m platformio run -e esp32s3 -t upload --upload-port COM5

# RMT (未真机验证)
python -m platformio run -e esp32s3-rmt -t upload --upload-port COM5

# 纯 LED 自检 (不初始化 BLE): 上电亮第 1 颗黄 + 第 10 颗红
python -m platformio run -e esp32s3-selftest -t upload --upload-port COM5

# 工具链 (国内网络)
python fetch_pkgs.py
```

`env:esp32s3-npbus` (NeoPixelBus + NeoPixelBusIdf5Rmt) **编不过** ——
NeoPixelBus 的 `NeoEsp32LcdXMethod.h` 用了 IDF 已移除的 `gpio_hal_iomux_func_sel`。
自检固件仍用仓库里的 bit-bang / RMT 驱动, 不引外部库。

### 编译期常量 (`platformio.ini`)

```
LED_PIN=14   LED_COUNT=176   LED_BRIGHTNESS=255
```

- `LED_BRIGHTNESS` 必须保持 **255** —— 前端已经在主机侧乘过 brightness,
  树莓派端 `rpi_ws281x` 也是满亮度, 再乘一次就比树莓派暗一倍。
- `LED_COUNT` 只是默认; 实际可切到 **176 / 352** (`LED_ALLOWED_COUNTS`), **不用重烧固件** ——
  通过 `led.init` 的 count 切。

### `led_limits.h` —— 功耗上限写死在固件里

`LED_MAX_LIT = 30`。`show()` 之前扫一遍像素缓冲, **点亮的颗数超上限时把下标大的那些灭掉**
(只留下限颗)。是「颗数」上限, 不是「下标」上限 —— 跑马灯 (同时只亮 6 颗) 不受影响。

## 6. USB 串口诊断 (不用重烧固件就能调灯)

串口 115200 (自检固件):

```
on <idx> <r> <g> <b>   点亮第 idx 颗        (索引 0-based, 0 = 最低音 A0)
off <idx>              熄灭第 idx 颗
offall                 全灭
status                 回读状态
```

自检固件额外有: `first` / `walk` (0..5 逐颗, 查物理偏移) / `sweep` (全条逐颗) / `count 176|352`。

> **任何测试都不得超过 30 颗同时点亮。**

## 7. 诊断命令

```
{"id":"x","op":"status"}
{"id":"x","ok":true,"result":{"pin":14,"count":176,"queue":0,"bad_frames":0,"dropped":0}}
```

- `bad_frames > 0` 或 `dropped > 0` = **通信侧真的丢过帧** (不是前端画错) → 查 MTU / 链路。
- `queue` 长期不降 = 设备处理不过来或命令被丢。

## 8. 「几颗灯常亮」怎么解释

前端配色: 红(右手白键) / 橙(右手黑键) / 蓝(左手白键) / 绿(左手黑键),
**每个音固定 2 颗灯** → 所以:

- **偶数颗、成对** → 很可能是真实的按键 / 预览状态 (暂停时预览当前和弦是正常的)。
- **奇数颗 (比如 3 绿 + 1 红 + 1 蓝 = 5 颗)** → 不可能是正常状态, 一定发生了
  「半条命令生效」或「整帧只刷了一半」:
  - 清屏帧被中断打断 → 截断点之后的灯保持旧颜色 (灯集中在灯带某一端基本就是它);
  - 分片丢包 + 半解析 → 错误下标被写进有效颜色 (灯散落在不同音区)。

**上电只闪一下**: 固件上电亮第 0 颗蓝 300ms 再熄灭 —— 以前这颗会一直亮着等主机 `led.off`,
握手失败 / 页面没连上 / 中途断开时就变成「有个蓝灯莫名其妙常亮」。现在只闪 300ms 验证接线。

## 9. PC 端调试工具

```bash
pip install bleak
python scripts/bt_pi/pc/ble_led_client.py         # 交互式: ping/status/led/ledall/off/ledstatus
python scripts/bt_pi/pc/check_frontend_protocol.py  # 模拟前端 BleTransport 连真机验协议
python scripts/bt_pi/pc/probe_ble_depth.py          # 在途深度 vs 吞吐 (真机数据来源)
python scripts/bt_pi/pc/probe_ble_marquee.py        # 跑马灯耗时
python scripts/bt_pi/pc/probe_ble_show_time.py      # show() 耗时
python scripts/bt_pi/pc/probe_ble_reassembly.py     # 分片重组
```

> bleak 在 Windows 上单包上限 244 字节 (6 像素 = 276 字节直接报
> `WinError -2147024809`) —— 写脚本必须自己切分, 浏览器里的前端不受影响。
