#include "wifi_link.h"

#include <Preferences.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include "wifi_config.h"

// NVS 分区名 —— 跟固件里其他用法不冲突.
static const char* kPrefsNs = "pianoflow";
static const char* kKeySsid = "wifi_ssid";
static const char* kKeyPass = "wifi_pass";

static bool g_connected = false;
static uint32_t g_lastTry = 0;
/** 已经试过静态 IP 兜底了没 —— 别无限重试. */
static bool g_triedStatic = false;
/**
 * 看门狗判定的「链路已死，等 loop() 来强制重连」标志.
 *
 * ★ 2026-11-11 真机踩到的死法: 板子**关联着** AP、`WiFi.status()` 一直报
 *   `WL_CONNECTED`、RSSI 也有值，但 lwIP 已经不回 ARP / 连不上网关 ——
 *   从 PC 和树莓派 ping 全是 100% 丢包，前端就一直「连接中」。
 *   只靠 `WiFi.status()` 永远发现不了 (它只反映驱动状态机，不反映链路).
 *   所以用一个**独立任务**定期从设备侧 TCP 连一下网关:
 *   连续 2 次失败 → 置标志 → `wifiLinkLoop()` 里 `WiFi.disconnect()` + 重连.
 */
static volatile bool g_linkSuspect = false;
static TaskHandle_t g_wdTask = nullptr;

String wifiLinkSavedSsid() {
  Preferences prefs;
  prefs.begin(kPrefsNs, true);  // 只读
  String s = prefs.getString(kKeySsid, "");
  prefs.end();
  return s;
}

String wifiLinkSavedPass() {
  Preferences prefs;
  prefs.begin(kPrefsNs, true);
  String s = prefs.getString(kKeyPass, "");
  prefs.end();
  return s;
}

bool wifiLinkSaveCredentials(const char* ssid, const char* pass) {
  if (!ssid || !*ssid) return false;
  Preferences prefs;
  prefs.begin(kPrefsNs, false);
  prefs.putString(kKeySsid, ssid);
  prefs.putString(kKeyPass, pass ? pass : "");
  prefs.end();
  return true;
}

void wifiLinkClearCredentials() {
  Preferences prefs;
  prefs.begin(kPrefsNs, false);
  prefs.remove(kKeySsid);
  prefs.remove(kKeyPass);
  prefs.end();
}

/** 当前该用的凭据 —— NVS 优先, 编译期兜底. */
static void currentCredentials(String* ssid, String* pass) {
  String s = wifiLinkSavedSsid();
  if (s.length() > 0) {
    *ssid = s;
    *pass = wifiLinkSavedPass();
    return;
  }
  *ssid = String(LED_WIFI_SSID);
  *pass = String(LED_WIFI_PASS);
}

/**
 * 关掉 WiFi 省电 (modem sleep).
 *
 * ★ 必须**连上之后**再调 —— Arduino-ESP32 3.x 的 WiFi.setSleep():
 *   STA 还没启动时, 它只把值记在 _sleepEnabled 里就返回, **根本不调
 *   esp_wifi_set_ps()**. 之后也没有任何地方把这个缓存值用上.
 *   → 后果: 省电模式一直是 IDF 的默认 (WIFI_PS_MIN_MODEM),
 *     发出去的包会被压在 WiFi 驱动里等下一个 beacon/DTIM 才发.
 *     表现 = 延迟飘 (几十 ms 一跳) + 回执挤成一坨 (实测 70ms 一坨).
 *   灯和音对不上就是这个.
 *
 * 所以: 连上 → 再调一次 → 这时 STA.started() 为 true, esp_wifi_set_ps 真的执行.
 */
static void applyNoSleep() {
  WiFi.setSleep(false);
  // 顺手确认一下 —— 万一失败要看得见, 不然又变成「延迟莫名变高」这种玄学问题.
  wifi_ps_type_t ps = WiFi.getSleep();
  if (ps != WIFI_PS_NONE) {
    Serial.printf("[wifi] ⚠ 省电关不掉 (ps=%d) —— 延迟会飘\n", (int)ps);
  }
}

/**
 * listen_interval: 关联请求里报给 AP 的「这个 STA 最多隔几个 beacon 才醒一次」.
 *
 * ★ 实测把它从 3 调成 1 (断开重连一次) —— WS 往返和帧耗时**一点没变**
 *   (ping 中位 9.0ms → 10.5ms, 每帧 115ms → 118ms).
 *   → 延迟的锅不在关联参数上, 在**路由器往 2.4GHz 客户端发下行**那一段.
 *   所以固件里**不**去动它 —— 白白多一次重连, 换不来一点好处.
 *   (`wifi info` 仍然会把这个值打出来, 方便复查.)
 */

// ---------------------------------------------------------------------------
// ★ 2026-11-11: **非阻塞**重连.
//
// 问题: 以前这里是同步的 —— WiFi.begin() 之后 delay() 等 10 秒, 静态兜底再等
// 10 秒, 全程卡在 delay() 里. 而它是在 wifiLinkLoop() (也就是 Arduino 的
// loop() 里) 调用的 → 这 10~20 秒里 **wsLedLoop() 跟着一起停摆** → WS server
// 完全不应答 → 前端那边就是「连着但什么都不回」→ 20 秒超时判死.
//
// 改法: begin() 之后**不等**, 靠 wifiLinkLoop() 每次进来轮询一下状态.
// 连接过程变成「后台跑着」, loop() 照常转, WS server 照常应答.
// ---------------------------------------------------------------------------

/** 正在等连接结果吗. */
static bool g_connecting = false;
/** 这次尝试的截止时间 (millis). 超了就换静态 IP / 放弃. */
static uint32_t g_connectDeadline = 0;
/** 这次连的是不是静态 IP (决定超时后要不要换策略). */
static bool g_connectIsStatic = false;
/**
 * 这次尝试用的凭据 (startConnect 时存一份).
 *
 * ★ 不在 loop 里现读 NVS —— currentCredentials() 每次都要开一次 Preferences,
 *   而 loop() 一秒能转几千次, 开着连的时候这么读纯属浪费.
 */
static String g_trySsid, g_tryPass;

/** 开始一次连接尝试 (不等结果). */
static void startConnect(const String& ssid, const String& pass, bool useStatic) {
  if (g_connecting) return;
  g_connecting = true;
  g_connectIsStatic = useStatic;
  g_connectDeadline = millis() + (useStatic ? 10000 : 12000);
  g_trySsid = ssid;
  g_tryPass = pass;
  if (useStatic) {
    IPAddress ip, gw, sn, dns;
    if (ip.fromString(String(LED_WIFI_STATIC_IP).c_str()) &&
        gw.fromString(String(LED_WIFI_GATEWAY).c_str()) &&
        sn.fromString(String(LED_WIFI_SUBNET).c_str()) &&
        dns.fromString(String(LED_WIFI_DNS).c_str())) {
      Serial.printf("[wifi] 静态 IP 兜底: %s\n", ip.toString().c_str());
      // ★ 顺序很重要: config() 必须在 begin() 之前, 否则 DHCP 已经开跑.
      WiFi.config(ip, gw, sn, dns);
    }
  }
  Serial.printf("[wifi] 连接 %s ...%s\n", ssid.c_str(), useStatic ? " (静态)" : "");
  WiFi.begin(ssid.c_str(), pass.c_str());
}

/** 轮询一次连接结果. 返回 true = 连上了. */
static bool pollConnect() {
  if (!g_connecting) return false;
  if (WiFi.status() == WL_CONNECTED) {
    g_connecting = false;
    applyNoSleep();
    g_connected = true;
    Serial.printf("[wifi] 已连接 IP=%s  RSSI=%d dBm\n", WiFi.localIP().toString().c_str(),
                  (int)WiFi.RSSI());
    return true;
  }
  if ((int32_t)(millis() - g_connectDeadline) < 0) return false;  // 还没超时

  // 超时了 —— DHCP 没成的话换静态 IP 兜底 (只换一次).
  g_connecting = false;
  if (!g_connectIsStatic && !g_triedStatic) {
    // 静态 IP 兜底 —— 只试一次 (试过之后 WiFi.config() 改过的配置会一直生效,
    // 再走 DHCP 就不对了). 想再试就重启, 或者串口 `wifi connect`.
    g_triedStatic = true;
    Serial.println(F("[wifi] DHCP 超时 —— 试静态 IP"));
    startConnect(g_trySsid, g_tryPass, true);
  } else {
    Serial.println(F("[wifi] 还是连不上"));
  }
  return false;
}

/**
 * 从设备侧探一下网关还通不通.
 *
 * 用 TCP 而不是 ICMP: 路由器不一定回 ping, 但 DNS (TCP 53) 或管理页 (80)
 * 基本都在. 两个都试, 任一个通就算链路活着.
 */
static bool probeGateway(uint32_t timeoutMs) {
  IPAddress gw = WiFi.gatewayIP();
  if (gw == IPAddress(0, 0, 0, 0)) return false;
  // 80 (路由器管理页) 先试 —— 实测家里的网关只开了 80, TCP 53 是关的;
  // 53 留作备用 (有些路由器/防火墙只放 DNS).
  const uint16_t ports[2] = {80, 53};
  for (int i = 0; i < 2; i++) {
    WiFiClient c;
    bool ok = c.connect(gw, ports[i], timeoutMs);
    c.stop();
    if (ok) return true;
  }
  return false;
}

/**
 * WiFi 链路看门狗任务 (跑在 core 0, 不占 loop()).
 *
 * 为什么必须有: `WiFi.status()` 会撒谎 —— 见 g_linkSuspect 的注释.
 * 每 15 秒探一次网关; 连续 2 次失败就请 loop() 强制重连.
 */
static void wifiWatchdogTask(void*) {
  uint32_t fail = 0;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(15000));
    if (WiFi.status() != WL_CONNECTED || g_connecting) {
      fail = 0;
      continue;
    }
    if (probeGateway(1200)) {
      if (fail > 0) Serial.println(F("[wifi-wd] 网关恢复可达"));
      fail = 0;
      continue;
    }
    fail++;
    Serial.printf("[wifi-wd] 网关探测失败 %lu/2\n", (unsigned long)fail);
    if (fail >= 2) {
      fail = 0;
      g_linkSuspect = true;
      Serial.println(F("[wifi-wd] 驱动报 connected 但网关不可达 —— 请求强制重连"));
    }
  }
}

void wifiLinkSetup() {
  // ★ 不管有没有凭据, 都得**先把 WiFi/lwIP 协议栈拉起来** ——
  //   Arduino-ESP32 3.x 的 socket() 依赖 lwIP 的 tcpip 线程, 而那个线程是
  //   WiFi.mode() → wifiLowLevelInit() → Network.begin() → esp_netif_init()
  //   才起的. 栈没起来就开 WS server → 断言 xQueueSemaphoreTake (null queue)
  //   → 无限重启 (真机踩过).
  //
  //   所以这里先 mode(), 再看有没有凭据.
  WiFi.mode(WIFI_STA);
  // ★ 关掉 WiFi 省电休眠 —— 不关的话延迟会飘 (有时几十 ms), 灯跟音就对不上.
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  // 链路看门狗 —— 即使驱动一直报 connected, 网关不通也能自愈.
  if (!g_wdTask) {
    xTaskCreatePinnedToCore(wifiWatchdogTask, "wifi-wd", 4096, nullptr, 1, &g_wdTask, 0);
  }

  String ssid, pass;
  currentCredentials(&ssid, &pass);
  if (ssid.length() == 0) {
    Serial.println(F("[wifi] 没配 SSID —— 用串口命令 `wifi <SSID> <密码>` 配一个"));
    Serial.println(F("[wifi] (只支持 2.4GHz!)"));
    // 协议栈已经起来了 —— WS server 能监听, 只是没人连得上.
    return;
  }

  // ★ 不阻塞 —— 连接过程交给 wifiLinkLoop() 轮询.
  //   setup 里卡 10 秒的话, WS server (wsLedSetup) 还没起来, 整块板子看着像死了.
  startConnect(ssid, pass, false);
}

void wifiLinkReconnect() {
  String ssid, pass;
  currentCredentials(&ssid, &pass);
  if (ssid.length() == 0) {
    Serial.println(F("[wifi] 还没配 SSID"));
    return;
  }
  g_triedStatic = false;  // 手动触发 → 静态 IP 兜底也重新试
  g_connecting = false;   // 打断正在等的那次, 重新发起
  startConnect(ssid, pass, false);
  Serial.println(F("[wifi] 重连已发起 (结果稍后打印)"));
}

void wifiLinkScan() {
  int n = WiFi.scanNetworks();
  Serial.printf("[scan] 看到 %d 个网络 (只看 2.4GHz —— ESP32-S3 不支持 5G)\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("  %-24s ch=%-3d rssi=%d %s\n", WiFi.SSID(i).c_str(), (int)WiFi.channel(i),
                  (int)WiFi.RSSI(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "加密");
  }
}

void wifiLinkLoop() {
  // ★ 正在等连接结果 → 轮询一下. 顺序很重要: 必须**先**轮询 ——
  //   连上的那一瞬间 WL_CONNECTED 就成立了, 如果下面那个「已连接就 return」
  //   的分支在前, pollConnect 永远轮不到 → applyNoSleep() 也就永远不调
  //   (省电关不掉 → 延迟飘).
  if (g_connecting) {
    pollConnect();
    // 还在等 → 这次 loop 就到这儿 (别重复发起新的连接).
    if (g_connecting) return;
  }

  // ★ 看门狗说「链路已死」—— 驱动可能还报 connected, 必须硬断一次再连.
  if (g_linkSuspect) {
    g_linkSuspect = false;
    String ssid, pass;
    currentCredentials(&ssid, &pass);
    if (ssid.length() == 0) return;
    Serial.println(F("[wifi] 看门狗强制重连 (wireless 状态机没报掉线)"));
    g_connected = false;
    g_triedStatic = false;
    g_connecting = false;
    WiFi.disconnect(false, false);
    delay(150);  // 让驱动把 disconnect 处理完, 否则紧跟的 begin() 会被忽略
    startConnect(ssid, pass, false);
    return;
  }

  if (WiFi.status() == WL_CONNECTED) {
    if (!g_connected) {
      g_connected = true;
      Serial.printf("[wifi] 恢复连接 IP=%s\n", WiFi.localIP().toString().c_str());
    }
    return;
  }
  if (g_connected) {
    g_connected = false;
    Serial.println(F("[wifi] 掉线"));
  }
  // 掉线后隔 5 秒重试一次.
  uint32_t now = millis();
  if (now - g_lastTry < 5000) return;
  g_lastTry = now;
  String ssid, pass;
  currentCredentials(&ssid, &pass);
  // 没凭据就别刷屏了 (也不会连上).
  if (ssid.length() == 0) return;
  Serial.println(F("[wifi] 重连 ..."));
  startConnect(ssid, pass, false);
}

bool wifiLinkConnected() { return g_connected && WiFi.status() == WL_CONNECTED; }

IPAddress wifiLinkIp() { return WiFi.localIP(); }

// ---------------------------------------------------------------------------
// 诊断: WiFi 链路的真实状态 + 往返延迟
// ---------------------------------------------------------------------------
//
// 为什么需要这些:
//   PC↔ESP32 的 WS 往返是**双峰**的 —— 一半 5~17ms, 一半 40~103ms.
//   尾部最大值 103ms ≈ 一个 beacon 周期 (100 TU = 102.4ms) → 典型的
//   「下行被路由器压到下一个 beacon 才发」.
//
//   要分清是**哪一段**慢, 就得从设备侧量一次「同频段」的往返 (到网关):
//     - 到网关也慢 → AP→ESP32 的**下行**被缓存了 (路由器 2.4G 省电).
//     - 到网关快   → 下行没问题, 慢在 PC→AP→ESP32 的**跨频段**转发.
//
// wifiLinkInfo(): 打印驱动里**真实的**省电状态 (Arduino 的 getSleep() 返回的
//   是缓存值, 骗人 —— 必须用 esp_wifi_get_ps() 直接问驱动).
void wifiLinkInfo() {
  wifi_ps_type_t ps = WIFI_PS_NONE;
  esp_err_t err = esp_wifi_get_ps(&ps);
  Serial.printf("[info] esp_wifi_get_ps = %d (%s)\n", (int)ps,
                ps == WIFI_PS_NONE ? "NONE 无省电" : (ps == WIFI_PS_MIN_MODEM ? "MIN_MODEM" : "MAX_MODEM"));
  if (err != ESP_OK) Serial.printf("[info] esp_wifi_get_ps 失败 0x%x\n", (unsigned)err);

  wifi_sta_config_t conf;
  if (esp_wifi_get_config(WIFI_IF_STA, (wifi_config_t*)&conf) == ESP_OK) {
    Serial.printf("[info] listen_interval = %d (0 = 常醒)\n", (int)conf.listen_interval);
  }

  wifi_ap_record_t ap;
  if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
    Serial.printf("[info] AP: ch=%d  RSSI=%d dBm  协议=%s\n", (int)ap.primary, (int)ap.rssi,
                  ap.phy_11ax ? "ax" : (ap.phy_11ac ? "ac" : (ap.phy_11n ? "n" : "?")));
  }
}

/** 一次 TCP 连接的往返 (SYN→SYN-ACK) —— 单位毫秒. 连不上返回 -1. */
static double tcpRttMs(IPAddress ip, uint16_t port) {
  WiFiClient c;
  uint32_t t0 = micros();
  bool ok = c.connect(ip, port, 2000);
  uint32_t dt = micros() - t0;
  c.stop();
  return ok ? (double)dt / 1000.0 : -1.0;
}

/** 量 N 次到网关的 TCP 往返 —— 同频段, 用来跟「跨频段」的 WS 往返对比. */
void wifiLinkRtt(int count) {
  if (count <= 0) count = 10;
  IPAddress gw = WiFi.gatewayIP();
  Serial.printf("[rtt] 网关 %s (同频段) TCP 连接往返:\n", gw.toString().c_str());
  double worst = 0;
  int okCount = 0;
  double sum = 0;
  for (int i = 0; i < count; i++) {
    double ms = tcpRttMs(gw, 80);
    Serial.printf("  #%d %s %.2f ms\n", i, ms < 0 ? "连不上" : "", ms);
    if (ms >= 0) {
      okCount++;
      sum += ms;
      if (ms > worst) worst = ms;
    }
    delay(30);
  }
  if (okCount) {
    Serial.printf("[rtt] 成功 %d/%d  平均 %.2f ms  最大 %.2f ms\n", okCount, count,
                  sum / okCount, worst);
  }
}

String wifiLinkSsid() {
  String ssid, pass;
  currentCredentials(&ssid, &pass);
  return ssid;
}
