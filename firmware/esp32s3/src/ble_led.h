// ESP32-S3 LED 外设 —— BLE (GATT) 模式
//
// 为什么是 BLE 而不是经典蓝牙 SPP:
//   ESP32-S3 **不支持 BT Classic** (芯片砍掉了经典蓝牙射频, 只留 BLE)。
//   SDK 里 soc_caps.h 有 SOC_BT_SUPPORTED=1 但没有
//   SOC_BT_CLASSIC_BT_DEVICE_SUPPORTED —— 所以 Arduino 的 BluetoothSerial
//   (SPP) 在 S3 上不可用。只能用 BLE。
//
// 角色: GATT **服务端**。设备广播名 "pianoflow", PC (Windows) 主动连。
//   Windows 11/10 原生支持 BLE GATT, 不需要装驱动。
//
// GATT 结构:
//   Service  : 6e400001-b5a3-f393-e0a9-e50e24dcca9e  (Nordic UART 风格)
//     └ RX (write) : 6e400002-...  主机 → 设备, 命令
//     └ TX (notify): 6e400003-...  设备 → 主机, 响应
//
// 命令格式 (与树莓派端 bt_gpio_daemon.py 一致, JSON 行):
//   主机 → 设备: {"id":"x","op":"led.set","args":{"index":0,"r":0,"g":0,"b":200}}
//   设备 → 主机: {"id":"x","ok":true,"result":{...}}
//
// 支持的 op:
//   ping / status / led.init / led.set / led.all / led.set_many /
//   led.show / led.off / led.status
#ifndef BLE_LED_H
#define BLE_LED_H

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

/**
 * 灯带驱动选择.
 *
 *   1 = RMT 硬件 (ws2812_rmt.cpp, **默认**) —— 波形由硬件按 tick 产生,
 *       不受 WiFi/BT 中断影响. 2026-11-11 真机验证:
 *         * RMT RX 回环抓到的 0/1 高电平 = 32/64 tick (80MHz), **零偏差**;
 *         * 同一块板子上 bit-bang 被中断拉到 234/431 tick (2.9/5.4µs) ——
 *           0 bit 被拉成 1 bit = 灯带乱闪、随机几颗亮.
 *   0 = 软件 bit-bang (ws2811_bitbang.cpp) —— 保留作对照/无 RMT 的板子.
 *       ⚠️ 它**无法**在 WiFi/BT 开着时保证波形: 本核临界区挡不住
 *       level 4+ 的无线中断. 只在 esp32s3-selftest 这类不连网的固件里可靠.
 *
 * 两者 API 完全一样 (setPixel / setAll / clear / show / count), 上层
 * (main.cpp / ble_led.cpp) 只认 `LedStrip` 这个别名, 换驱动不用改逻辑.
 */
#ifndef LED_DRIVER_RMT
#define LED_DRIVER_RMT 1
#endif

#if LED_DRIVER_RMT
#include "ws2812_rmt.h"
using LedStrip = Ws2812Rmt;
#else
#include "ws2811_bitbang.h"
using LedStrip = Ws2811Bitbang;
#endif

#include "led_limits.h"  // LED_MAX_LIT —— 同时点亮的颗数上限 (写死)

#ifndef LED_PIN
#define LED_PIN 14
#endif
#ifndef LED_COUNT
#define LED_COUNT 176
#endif
/**
 * **物理**灯数 —— 一帧里实际推出去的颗数 (硬件上真实接了几颗).
 *
 * ★ 2026-11-04 新增, 跟树莓派端 led_remote.py 的 `--physical-count` 同义.
 *
 * 为什么要分「物理 / 逻辑」两个数 (树莓派那边一直就是这么分的):
 *   WS2811/WS2812 是**串联**的 —— 一帧必须把整条链的数据都推出去.
 *   如果链上真实接了 352 颗 (两条灯带串联), 而你只推 176 颗, 后面那 176 颗
 *   的移位寄存器收不到数据, 会**保持上一帧的颜色** (残留鬼影);
 *   树莓派那边为了躲开这个坑, 一直是「不管逻辑灯数是多少, 每帧都推满
 *   physical 颗」—— 发得比物理链**长**是安全的 (多出来的比特没人收),
 *   发得比物理链**短**才危险.
 *
 *   所以这里:
 *     physical = LED_PHYSICAL_COUNT  (编译期固定, 一帧推这么多)
 *     logical  = 前端 init 传的 count  (176 / 352, 只决定「允许写哪几颗」)
 *
 *   默认 352 = 两条灯带串联 (跟树莓派那边 led-remote.service 的
 *   `--physical-count 352` 一致). 只接了一条 176 颗的带的话, 编译时改成
 *   -D LED_PHYSICAL_COUNT=176 (少推一半, 每帧快一倍).
 */
#ifndef LED_PHYSICAL_COUNT
#define LED_PHYSICAL_COUNT (LED_COUNT * 2)
#endif
/**
 * 灯数白名单 —— 前端 init 的 count (逻辑灯数) 只能是这些值.
 *
 *   LED_COUNT      = 单灯带 (一条 88 键的带)
 *   LED_COUNT * 2  = 双色带 (两条灯带串联, 352 颗)
 *
 * 为什么要白名单 (跟树莓派端 led_remote.py 的 DEFAULT_ALLOWED_COUNTS 同理):
 *   count 直接决定 malloc 的大小, 不白名单就能一条 init 让固件申请任意大的
 *   缓冲 (65535 颗 = 196KB 白占着, 再大就 malloc 失败).
 */
#ifndef LED_ALLOWED_COUNTS
#define LED_ALLOWED_COUNTS LED_COUNT, (LED_COUNT * 2)
#endif
#ifndef LED_BRIGHTNESS
#define LED_BRIGHTNESS 64
#endif
/**
 * 上电要不要点亮第 0 颗黄灯 (验烧录/接线/供电用).
 *
 * 默认开 —— 之前是「闪一下就灭」, 用户来不及确认. 这颗灯会一直亮着,
 * 直到主机发来 led.init / led.off (前端握手就是 init + off, 所以连上就没了).
 * 不想有的话编译时加 -D LED_BOOT_TEST_PIXEL=0.
 */
#ifndef LED_BOOT_TEST_PIXEL
#define LED_BOOT_TEST_PIXEL 1
#endif
#ifndef BT_NAME
#define BT_NAME "pianoflow"
#endif
/**
 * 要不要编 WebSocket 那条链路 (WiFi + WS server, 见 ws_led.cpp).
 *
 * 默认开 —— WiFi 是切换到树莓派那套行为的主路径 (「完全一致」).
 * 纯 LED 自检固件 (esp32s3-selftest) 用不到 → 那边编 -D LED_WS_ENABLE=0.
 */
#ifndef LED_WS_ENABLE
#define LED_WS_ENABLE 1
#endif

// UART 风格 service/characteristic UUID
#define SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define RX_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  // 主机写
#define TX_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  // 设备通知

// BLE 通知包有 MTU 上限 (默认 20 字节有效载荷), 响应超长时截断
#define BLE_TX_MAX 512

/**
 * 要不要把每条回包也往串口打一遍 (调试用).
 *
 * 默认 0 (关): 串口回显是**阻塞**写 —— 115200 波特率下一条 45 字节的回应
 * 要 3.9ms, 串口没人读时还会把 TX 缓冲写满卡住命令处理.
 * 每条命令 21ms 的成本里它占掉近 4ms, 前端跑马灯 352 条命令就多花 1.4 秒.
 * 要抓 BLE 流量时用 -D LED_SERIAL_ECHO=1 重新烧录.
 */
#ifndef LED_SERIAL_ECHO
#define LED_SERIAL_ECHO 0
#endif

void bleLedSetup();
void bleLedLoop();

// 全局唯一的灯带实例 (BLE 命令和 USB 串口命令共用)
LedStrip& ledStrip();

// 初始化灯带 (幂等), 返回是否成功
bool ledStripEnsure();

/**
 * 逻辑灯数 —— 前端 init 说的「这一条要亮几颗」(176 / 352).
 *
 * 只有「允许写哪几颗」受它管; **一帧推多少颗**由 LED_PHYSICAL_COUNT 决定
 * (见 ble_led.h 里 LED_PHYSICAL_COUNT 的说明).
 */
int ledStripLogicalCount();

/**
 * 重新配置**逻辑**灯数 —— 双色带需要 352 (单灯带 176).
 *
 * count 必须在白名单 LED_ALLOWED_COUNTS 里 —— 不在白名单里直接返回 false
 * (固件不认这个灯数, 灯带保持原样).
 * 逻辑灯数变小时, 逻辑范围之外的那些像素会被**抹黑并刷出去**
 * (跟树莓派端 led_remote.py 的 _init_strip 一个行为).
 */
bool ledStripSetCount(int count);

// 把一段文本发给已连接的主机 (带换行)
void bleSend(const char* text);

/**
 * 执行一行 JSON 命令, 把回包写进 out —— **WebSocket 链路用这个**.
 *
 * op 词汇跟树莓派那边一样 (裸的 "init" / "set_many" / "show" / "off" ...);
 * BLE 那边的 "led.xxx" 前缀在内部统一补上, 所以两条链路共用一套实现.
 *
 * 回包里的 id **原样回显请求里的片段** (BLE 是字符串 "p1", WS 是数字 1) ——
 * 前端按 id 配对, 类型必须对上.
 *
 * 返回写入的字节数 (含末尾换行); 0 = 没写进去 (out 太小).
 */
size_t ledExecLine(const char* line, int len, char* out, int outLen);

// USB 串口诊断: 打印 BLE RX 队列深度 / 坏帧 / 被拒帧 (status 命令用).
void blePrintRxStats();

// 当前编译进去的灯带驱动名 ("bitbang" / "rmt") —— 确认烧的是哪一版.
const char* ledDriverName();

#endif  // BLE_LED_H
