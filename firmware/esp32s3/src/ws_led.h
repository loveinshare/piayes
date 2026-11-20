// WebSocket 链路 —— ESP32-S3 当 WS server, 前端连过来 (跟树莓派那套一样).
//
// 为什么要有这条链路: 蓝牙每条命令一次 ATT 往返 (~46ms), 一个动画帧 5~15 条
// 命令 → 一帧 ~600ms, 灯跟音对不上 (用户报的「跳闪 / 节奏不对」).
// 局域网 WS 一条命令 ~2-5ms → 一帧 ~15ms, 跟树莓派一个量级.
//
// 协议跟树莓派那边的 led_remote.py **完全一致** (前端一行都不用改):
//   主机 → 设备: {"id":1,"op":"set_many","args":{"pixels":[{"i":0,"r":255,...}]}}
//   设备 → 主机: {"id":1,"ok":true,"result":{"set":80}}
//
// ★ 每条命令**必须**回一条 —— 前端的 drain() 靠回包计数, 不回就一直卡着
//   (用户报的「跑完还有灯亮着」).
//
// id 原样回显: 前端发数字就回数字, 发字符串就回字符串 —— 前端按 id 配对.
#ifndef WS_LED_H
#define WS_LED_H

#include "ble_led.h"  // LED_WS_ENABLE 的默认值在这

#if LED_WS_ENABLE

/** 起 WS server (监听 8080). */
void wsLedSetup();

/** 收命令 + 回包 —— 放在 Arduino loop() 里反复调. */
void wsLedLoop();

/** 当前连着的 WS 客户端数 (status 里报). */
int wsLedClientCount();

#else  // LED_WS_ENABLE

// 不编 WS 链路时 (esp32s3-selftest) 也要能回答「有几个客户端」——
// ble_led.cpp 的 status 回包无条件读它. 以前这里什么都没有, selftest
// 环境因此**根本编不过** (`wsLedClientCount was not declared`).
inline int wsLedClientCount() { return 0; }

#endif  // LED_WS_ENABLE

#endif  // WS_LED_H
