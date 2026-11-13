// WiFi 联网 —— ESP32-S3 走 WiFi 接前端 (替代蓝牙).
//
// 为什么走 WiFi: 蓝牙每条命令一次 ATT 往返 (~46ms), 一个动画帧 5~15 条命令
// → 一帧 ~600ms, 灯和音彻底对不上 (用户报的「跳闪 / 节奏不对」).
// 局域网 WebSocket 一条命令 ~2-5ms, 一帧 ~15ms —— 跟树莓派一个量级.
//
// 凭据从哪来 (优先级从高到低):
//   1. NVS (串口 `wifi <ssid> <pass>` 存进去的) —— 不用重新烧录
//   2. wifi_config.h 里的编译期默认值
//
// IP 策略: 平时走 DHCP (路由器上做「DHCP 保留」→ IP 固定);
//         DHCP 拿不到 IP 时退回静态 IP (wifi_config.h 里的).
#ifndef WIFI_LINK_H
#define WIFI_LINK_H

#include <Arduino.h>
#include <IPAddress.h>
#include <String.h>

/** 初始化 WiFi 协议栈并发起连接 (非阻塞 —— 结果由 wifiLinkLoop() 轮询). */
void wifiLinkSetup();

/** 掉线重连 + 链路看门狗处理 —— 放在 Arduino loop() 里反复调. */
void wifiLinkLoop();

/** 当前有没有连上 (IP 非 0). */
bool wifiLinkConnected();

/** 当前 IP (没连上返回 0.0.0.0). */
IPAddress wifiLinkIp();

/** 实际用的 SSID (NVS 优先, 空的表示没配). */
String wifiLinkSsid();

/**
 * 重新连一次 —— 存完凭据**不用重启**就能生效 (串口 `wifi connect`).
 * 会把静态 IP 兜底也重新试一遍.
 */
void wifiLinkReconnect();

/** 扫一遍周围的 WiFi —— 用来确认 2.4GHz 频段上有没有自己的路由器. */
void wifiLinkScan();

/** 打印 WiFi 链路的真实状态 (驱动的省电模式 / listen_interval / AP beacon 周期). */
void wifiLinkInfo();

/** 从设备侧量「同频段」的 TCP 往返 (到网关) —— 用来定位延迟在哪一段. */
void wifiLinkRtt(int count);

// --- NVS 里的凭据 (串口 `wifi` 命令读写) ---
String wifiLinkSavedSsid();
String wifiLinkSavedPass();
bool wifiLinkSaveCredentials(const char* ssid, const char* pass);
void wifiLinkClearCredentials();

#endif  // WIFI_LINK_H
