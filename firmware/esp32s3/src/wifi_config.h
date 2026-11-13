// WiFi 配置 —— 编译期默认值 (NVS 里的会覆盖它).
//
// ⚠️ 这里**不要**填真密码 —— 这个仓库会进 git.
//    推荐用 USB 串口命令现填 (存进 NVS, 断电不丢, 不用重新烧录):
//        wifi <SSID> <密码>      存下来
//        wifi clear              忘掉
//        wifi                    只看当前用的凭据 (密码打码)
//
// ★ 2.4GHz! ESP32-S3 只支持 2.4GHz —— 路由器把 2.4G 和 5G 拆成两个 SSID 的
//   话, 一定要连 2.4G 那个.
//
// 静态 IP 兜底: DHCP 拿不到 IP 时用这个. 建议跟路由器上的「DHCP 保留」
// (按 MAC 绑定) 填**同一个**地址 —— 平时走 DHCP (IP 固定), DHCP 挂了走静态.
#ifndef WIFI_CONFIG_H
#define WIFI_CONFIG_H

#define LED_WIFI_SSID ""
#define LED_WIFI_PASS ""

// 静态 IP 兜底 (跟树莓派 192.168.1.113 / 服务器 192.168.1.111 同一个网段).
#define LED_WIFI_STATIC_IP "192.168.1.120"
#define LED_WIFI_GATEWAY "192.168.1.1"
#define LED_WIFI_SUBNET "255.255.255.0"
#define LED_WIFI_DNS "192.168.1.1"

#endif  // WIFI_CONFIG_H
