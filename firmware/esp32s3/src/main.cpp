// ESP32-S3 LED 外设 —— piano-follow
//
// 硬件: GPIO14 → WS2811/WS2812 灯带 DIN, 176 颗, GRB, 800kHz
//       (与树莓派端 led_remote.py 的默认值一致: count=176, GRB, 800kHz)
//
// 电平: 树莓派 GPIO 也是 3.3V, ESP32-S3 GPIO14 同为 3.3V —— 直连即可, 不需要电平转换。
//
// 第一步 (点亮验证): 上电即点亮 LED 0 (蓝色), 肉眼确认接线 + 供电正常。
//
// 串口命令 (USB Serial, 115200, 换行结尾) —— 调灯不用重新烧固件:
//
//   on <idx> <r> <g> <b>   点亮第 idx 颗
//   off <idx>              熄灭第 idx 颗
//   offall                 全灭
//   status                 回读状态
//
//   索引 0-based, 与前端 LedController 的 LED 索引一致 (0 = 最低音 A0)。
//
// 蓝牙 (BLE): 设备广播名 "pianoflow", PC 用 bleak 连, 命令格式跟树莓派端一致。
//   ESP32-S3 **不支持经典蓝牙 SPP** (芯片只有 BLE), 所以走 GATT。
#include <Arduino.h>
#include <esp_cpu.h>
#include <esp_system.h>
#include <string>

#include "soc/gpio_struct.h"

#include "ble_led.h"
#include "wifi_link.h"
#include "ws_led.h"

#ifndef LED_PIN
#define LED_PIN 14
#endif
#ifndef LED_COUNT
#define LED_COUNT 176
#endif
#ifndef LED_BRIGHTNESS
#define LED_BRIGHTNESS 64
#endif

// 灯带驱动由 ble_led.h 里的 LED_DRIVER_RMT 选择:
//   默认 bit-bang (已真机验证); LED_DRIVER_RMT=1 走 RMT 硬件.
// 实例由 ble_led.cpp 持有 —— BLE 和 USB 串口共用同一块像素缓冲.

static LedStrip& strip = ledStrip();

static void printStatus() {
  Serial.print(F("status count="));
  Serial.print(ledStripLogicalCount());
  Serial.print(F(" physical="));
  Serial.print(strip.count());
  Serial.print(F(" pin="));
  Serial.print(LED_PIN);
  Serial.print(F(" bright="));
  Serial.print(LED_BRIGHTNESS);
  Serial.print(F(" driver="));
  Serial.print(ledDriverName());
  // 内存 / 复位原因 —— 「跑一阵就掉线」先看这两个:
  //   heap 掉到几 KB → 多半是泄漏 (WiFi/lwIP 分配不出来, 表现就是「连着但不通」);
  //   reset 原因能区分「自己重启」和「一直没重启但网络死了」.
  Serial.print(F(" heap="));
  Serial.print(ESP.getFreeHeap());
  Serial.print(F(" minheap="));
  Serial.print(ESP.getMinFreeHeap());
  Serial.print(F(" reset="));
  Serial.print((int)esp_reset_reason());
  // 功耗上限 + 当前点亮颗数 —— 「同时亮了 176 颗」这种事要一眼能看出来.
  Serial.print(F(" lit="));
  Serial.print(strip.litCount());
  Serial.print(F("/"));
  if (LED_MAX_LIT > 0) {
    Serial.print(LED_MAX_LIT);
  } else {
    Serial.print(F("inf"));
  }
  Serial.println();
  // RX 队列 / 坏帧 / 被拒帧 —— 灯出现"常亮/乱闪"时先看这三个数.
  blePrintRxStats();
#if LED_WS_ENABLE
  // WiFi / WS —— 前端走 WebSocket 连过来时先看这两个.
  Serial.print(F("wifi "));
  Serial.print(wifiLinkConnected() ? F("connected ip=") : F("disconnected "));
  Serial.print(wifiLinkIp());
  Serial.print(F(" ssid="));
  Serial.print(wifiLinkSsid());
  Serial.printf(" ws_clients=%d\n", wsLedClientCount());
#endif
}

// 自检模式的走灯状态 (见下面的 sweep 命令)
static int g_sweepIdx = -1;
static uint32_t g_sweepNext = 0;

// diag 命令的分步计数 (每跑一次 diag 走一步, 见下面的 diag 分支).
static int diagStep = 0;

/**
 * 自检固件的默认图案: **第 1 颗黄 + 第 10 颗红**, 其余全灭, 常亮.
 *
 * ⚠️ 索引是 0-based (跟前端 LedController 一致, 0 = 最低音 A0):
 *   BASE_IDX_YELLOW = 0  → 第 1 颗
 *   BASE_IDX_RED    = 9  → 第 10 颗
 *   「第十个」按自然数数 (第 1 个 = 索引 0), 所以是 9 不是 10.
 *
 * 为什么用黄色和红色:
 *   - 黄 (255,255,0): GRB / RGB 两种字节顺序下**都是黄** —— 一眼就能确认
 *     配色顺序没问题, 排除「颜色不对」的干扰.
 *   - 红 (255,0,0): 与黄区分度高, 两颗一眼能数清.
 *
 * 常亮 (不闪、不动) —— 就是要看「哪几颗亮着」的静态结果.
 */
#ifndef BASE_IDX_YELLOW
#define BASE_IDX_YELLOW 0
#endif
#ifndef BASE_IDX_RED
#define BASE_IDX_RED 9
#endif

/** 全灭 + 点亮基准图案 (第 1 颗黄 / 第 10 颗红). */
static void applyBasePattern() {
  strip.clear();
  strip.setPixel(BASE_IDX_YELLOW, 255, 255, 0);
  strip.setPixel(BASE_IDX_RED, 255, 0, 0);
  strip.show();
}

static void handleCommand(char* line) {
  char* cmd = strtok(line, " ");
  if (!cmd) return;

  if (strcmp(cmd, "on") == 0) {
    char* a = strtok(nullptr, " ");
    char* b = strtok(nullptr, " ");
    char* c = strtok(nullptr, " ");
    char* d = strtok(nullptr, " ");
    if (!a || !b || !c || !d) {
      Serial.println(F("err usage: on <idx> <r> <g> <b>"));
      return;
    }
    int idx = atoi(a);
    if (idx < 0 || idx >= ledStripLogicalCount()) {
      Serial.println(F("err index out of range"));
      return;
    }
    strip.setPixel(idx, atoi(b), atoi(c), atoi(d));
    strip.show();
    Serial.print(F("ok "));
    Serial.println(idx);
  } else if (strcmp(cmd, "off") == 0) {
    char* a = strtok(nullptr, " ");
    if (!a) { Serial.println(F("err usage: off <idx>")); return; }
    int idx = atoi(a);
    if (idx < 0 || idx >= ledStripLogicalCount()) {
      Serial.println(F("err index out of range"));
      return;
    }
    strip.setPixel(idx, 0, 0, 0);
    strip.show();
    Serial.print(F("ok "));
    Serial.println(idx);
  } else if (strcmp(cmd, "offall") == 0) {
    // 停掉正在跑的 sweep, 否则下一帧又把灯点回来.
    g_sweepIdx = -1;
    strip.clear();
    strip.show();
    Serial.println(F("ok offall"));
  } else if (strcmp(cmd, "count") == 0) {
    // 换**逻辑**灯数 —— 双色带 352 (两条灯带串联), 白名单只有 176 / 352.
    // 一帧实际推多少颗是编译期的 LED_PHYSICAL_COUNT, 不受这个影响.
    char* a = strtok(nullptr, " ");
    if (!a) { Serial.println(F("err usage: count <176|352>")); return; }
    int n = atoi(a);
    g_sweepIdx = -1;
    if (!ledStripSetCount(n)) {
      Serial.printf("err count %d not allowed\n", n);
      return;
    }
    Serial.printf("ok count=%d physical=%d\n", ledStripLogicalCount(), strip.count());
  } else if (strcmp(cmd, "dprobe") == 0) {
    // 延时原语的原始测量表 —— 只测时间, **不点灯** (零电流).
#if LED_DRIVER_RMT
    Serial.println(F("[dprobe] RMT driver — 没有 bit-bang 延时可用"));
#else
    strip.delayProbe();
#endif
  } else if (strcmp(cmd, "wave") == 0) {
    // ★ 波形回读: 用 RMT RX 在同一根 GPIO 上抓自己发出去的 bit 波形.
    //   bit-bang: 全 0/全 1/交替/随机 四种图案各 100 次 (暴露中断打断).
    //   RMT: 抓 2 颗灯的编码, 验证 0/1 高电平正好是 32/64 tick.
    //   这是唯一能「不用示波器、不用眼睛」证明驱动时序好坏的诊断.
    strip.waveProbe();
  } else if (strcmp(cmd, "recal") == 0) {
    // 重新标定延时 —— 跟开机那次对比, 看标定是不是稳定.
#if LED_DRIVER_RMT
    Serial.println(F("[recal] RMT driver — 没有 bit-bang 延时可用"));
#else
    strip.recalibrate();
#endif
  } else if (strcmp(cmd, "captest") == 0) {
    // ★ 验证功耗上限 —— **只动缓冲, 不发送** (零电流, 一颗都不亮).
    //
    // 为什么不直接「整条点亮」看效果: 万一上限的代码有 bug, 176 颗全亮 =
    // 10.5A —— 板子/USB 直接被拉垮 (真机已经因此掉过一次线).
    // 所以这里把缓冲填满, 直接调 applyMaxLit() (跟 show() 里是同一份代码),
    // 报个数, 然后清掉 —— 全程不 show(), 电流为零.
    //
    // LED_MAX_LIT == 0 (默认, 跟树莓派一致) → 不限, 这里只是报个数.
    g_sweepIdx = -1;
    strip.setAll(255, 255, 255);
    int before = strip.litCount();
    int after = strip.applyMaxLit();
    strip.clear();
    if (LED_MAX_LIT > 0) {
      Serial.printf("ok captest 缓冲 %d 颗 → 上限后 %d 颗 (上限 %d, 未发送)\n",
                    before, after, LED_MAX_LIT);
    } else {
      Serial.printf("ok captest 缓冲 %d 颗 → 上限后 %d 颗 (不限, 未发送)\n",
                    before, after);
    }
  } else if (strcmp(cmd, "on30") == 0) {
    // 点亮前 30 颗 —— 肉眼确认接线/供电扛得住 30 颗 (30 × 60mA ≈ 1.8A).
    // ⚠️ 这是**测试**用的命令, 不是「上限」—— 上限见 led_limits.h.
    g_sweepIdx = -1;
    strip.clear();
    int n = 30;
    for (int i = 0; i < n && i < ledStripLogicalCount(); i++) {
      strip.setPixel(i, 255, 255, 0);
    }
    strip.show();
    Serial.printf("ok on30 lit=%d\n", strip.litCount());
  } else if (strcmp(cmd, "first") == 0) {
    // 全部关掉, 只留基准图案 (第 1 颗黄 / 第 10 颗红).
    g_sweepIdx = -1;
    applyBasePattern();
    Serial.println(F("ok base: LED 0 = yellow, LED 9 = red"));
  } else if (strcmp(cmd, "walk") == 0) {
    // 0..5 逐颗点亮 (每颗 400ms), 串口打印下标 ——
    // 用肉眼确认"第 0 颗"到底对应物理灯带的哪一颗 (查偏移).
    g_sweepIdx = -1;
    for (int i = 0; i < 6; i++) {
      strip.clear();
      strip.setPixel(i, 255, 255, 0);
      strip.show();
      Serial.printf("walk idx=%d\n", i);
      delay(400);
    }
    strip.clear();
    strip.show();
    Serial.println(F("ok walk done"));
  } else if (strcmp(cmd, "sweep") == 0) {
    // 从头到尾逐颗点亮 (150ms/颗), 串口打印下标.
    g_sweepIdx = 0;
    g_sweepNext = 0;
    Serial.println(F("ok sweep start"));
  } else if (strcmp(cmd, "status") == 0) {
    printStatus();
  } else if (strcmp(cmd, "wifi") == 0) {
    // WiFi 凭据 —— 存进 NVS, 断电不丢, 不用重新烧录.
    //
    //   wifi <SSID> <密码>   存下来
    //   wifi connect         立刻重连 (存完凭据不用重启)
    //   wifi scan            扫一遍周围的网络 (确认 2.4GHz 上有没有自己的路由)
    //   wifi info            驱动的省电状态 / listen_interval / AP beacon 周期
    //   wifi rtt             量到网关的 TCP 往返 (同频段基线)
    //   wifi clear           忘掉
    //   wifi                 只看当前状态 (密码打码)
    char* a = strtok(nullptr, " ");
    if (!a) {
      String ssid = wifiLinkSsid();
      Serial.print(F("ok wifi ssid="));
      Serial.print(ssid.length() ? ssid : F("(没配)"));
      Serial.print(F(" pass="));
      Serial.println(wifiLinkSavedPass().length() ? F("******") : F("(没配)"));
      Serial.print(F("   当前: "));
      Serial.print(wifiLinkConnected() ? F("已连接 ") : F("没连上 "));
      Serial.println(wifiLinkIp());
      return;
    }
    if (strcmp(a, "clear") == 0) {
      wifiLinkClearCredentials();
      Serial.println(F("ok wifi 已清除 (重启后生效)"));
      return;
    }
    if (strcmp(a, "connect") == 0) {
      wifiLinkReconnect();
      return;
    }
    if (strcmp(a, "scan") == 0) {
      wifiLinkScan();
      return;
    }
    if (strcmp(a, "info") == 0) {
      wifiLinkInfo();
      return;
    }
    if (strcmp(a, "rtt") == 0) {
      wifiLinkRtt(10);
      return;
    }
    char* b = strtok(nullptr, " ");
    if (!b) {
      Serial.println(F("err usage: wifi <SSID> <密码> | wifi connect | wifi scan | wifi clear | wifi"));
      return;
    }
    wifiLinkSaveCredentials(a, b);
    Serial.printf("ok wifi 已存 %s —— 正在重连 ...\n", a);
    wifiLinkReconnect();
  } else if (strcmp(cmd, "diag") == 0) {
    // 诊断: 量出「物理输出层」到底有没有在动.
    //
    // ⚠️ 分步执行, 每步一条命令 —— 之前一整块跑会把板子挂死 (Serial.printf
    //   在临界区外, 但 delay(10000) 期间如果撞上别的任务就很难查).
    //   每步单独跑, 出问题能立刻定位到是哪一步.
    diagStep++;
    switch (diagStep) {
      case 1: {
        // (a) cycle 计数器的实际频率. CPU 频率假设错了的话 bit 宽度全错 →
        //     灯一颗都不亮. 这是最可疑的一条.
        uint32_t c0 = esp_cpu_get_cycle_count();
        uint32_t t0 = micros();
        delay(50);  // 50ms —— Arduino 的 delay() 单位是**毫秒**
        uint32_t t1 = micros();
        uint32_t c1 = esp_cpu_get_cycle_count();
        uint32_t dCycles = c1 - c0;
        uint32_t dUs = t1 - t0;
        Serial.printf("[diag1] %lu cycles / %lu us = %lu MHz (assumed 240)\n",
                      (unsigned long)dCycles, (unsigned long)dUs,
                      (unsigned long)(dUs ? dCycles / dUs : 0));
        Serial.printf("[diag1] getCpuFrequencyMhz=%lu\n", (unsigned long)getCpuFrequencyMhz());
        break;
      }
      case 2: {
        // (b) show() 的真实耗时 (cycle 计数器量, 不受调度抖动影响).
        uint32_t s0 = esp_cpu_get_cycle_count();
        strip.show();
        uint32_t s1 = esp_cpu_get_cycle_count();
        uint32_t mhz = getCpuFrequencyMhz();
        Serial.printf("[diag2] show()=%lu cycles = %.2f ms (theory 10.56 ms)\n",
                      (unsigned long)(s1 - s0),
                      mhz ? (double)(s1 - s0) / (double)mhz / 1000.0 : 0.0);
        break;
      }
      case 3: {
        // (c) GPIO 状态回读.
        //     ⚠️ enable_w1ts / out_w1ts 是**只写**寄存器, 读出来永远是 0 ——
        //     必须读 enable / out 这两个真正的状态寄存器.
        gpio_dev_t* g = (gpio_dev_t*)DR_REG_GPIO_BASE;
        Serial.printf("[diag3] out=0x%08lx enable=0x%08lx\n",
                      (unsigned long)g->out, (unsigned long)g->enable);
        Serial.printf("[diag3] bit%d: out=%d enable=%d\n", LED_PIN,
                      (int)((g->out >> LED_PIN) & 1),
                      (int)((g->enable >> LED_PIN) & 1));
        // func_out_sel_cfg: pad 的输出信号选择. 0 = 默认 (GPIO_OUT) .
        Serial.printf("[diag3] func_out_sel_cfg[%d]=0x%08lx  func_in_sel_cfg[%d]=0x%08lx\n",
                      LED_PIN, (unsigned long)g->func_out_sel_cfg[LED_PIN].val,
                      LED_PIN, (unsigned long)g->func_in_sel_cfg[LED_PIN].val);
        // 直接写一次再回读 —— 验证寄存器写读路径通不通.
        g->out_w1tc = (1UL << LED_PIN);
        uint32_t low = g->out;
        g->out_w1ts = (1UL << LED_PIN);
        uint32_t high = g->out;
        Serial.printf("[diag3] manual: after W1TC out=0x%08lx  after W1TS out=0x%08lx\n",
                      (unsigned long)low, (unsigned long)high);
        g->out_w1tc = (1UL << LED_PIN);
        break;
      }
      case 4: {
        // (d) 慢速闪烁: 直接把引脚当普通 GPIO 以 2Hz 翻转.
        //     肉眼能看见 → pin 到灯带 DIN 的**物理通路**是通的,
        //     问题在 WS2811 波形; 看不见 → 接线/引脚/供电的问题.
        Serial.println(F("[diag4] blinking GPIO14 at 2Hz, 10s (look at the strip!)"));
        for (int i = 0; i < 10; i++) {
          digitalWrite(LED_PIN, HIGH);
          delay(250);
          digitalWrite(LED_PIN, LOW);
          delay(250);
        }
        Serial.println(F("[diag4] blink done"));
        break;
      }
      case 5: {
        // (e) 用**已知可行**的波形再试一次: 只推前 8 颗, 全白.
        //     8 颗够短, 万一 CPU 时钟被降频也能过.
        strip.clear();
        for (int i = 0; i < 8; i++) strip.setPixel(i, 255, 255, 255);
        strip.show();
        Serial.println(F("[diag5] pushed 8 white pixels (LED 0..7 should be white)"));
        break;
      }
      case 6: {
        // (f) ★ bit-bang 的**真实时序** —— 「灯乱闪 / 跑马灯快慢」就看这四个数.
        //     out[0]=一次 cycle 读的成本  out[1]=bit 周期  out[2]=T0H  out[3]=T1H
        //     out[4]=rdcycle 与 esp_cpu_get_cycle_count() 的差
        //     理论: 读成本 ~2, bit 周期 300, T0H 96 (上限 132), T1H 192 (上限 228)
#if LED_DRIVER_RMT
        Serial.println(F("[diag6] RMT driver — 没有 bit-bang 时序可测"));
#else
        uint32_t t[14] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
        strip.selfTest(t);
        Serial.printf("[diag6] cycle 读成本: rdcycle = %lu cycles, esp_cpu_get_cycle_count() = %lu cycles\n",
                      (unsigned long)t[0], (unsigned long)t[1]);
        Serial.printf("[diag6] 轮询间隔(旧方案) = %lu cycles   延时循环 %lu cycles/次 (开销 %lu)\n",
                      (unsigned long)t[5], (unsigned long)t[6], (unsigned long)t[9]);
        Serial.printf("[diag6] ★ 线上 bit 周期: 0bit=%lu 1bit=%lu (目标 300 = 1.25us, 规格 264~336)\n",
                      (unsigned long)t[7], (unsigned long)t[8]);
        Serial.printf("[diag6] T0H = %lu cycles (理论 96, 规格 72~132)   T1H = %lu cycles (理论 192, 规格 168~228)\n",
                      (unsigned long)t[2], (unsigned long)t[3]);
        Serial.printf("[diag6] 迭代数: 高0=%lu 低0=%lu 高1=%lu 低1=%lu\n",
                      (unsigned long)t[10], (unsigned long)t[11],
                      (unsigned long)t[12], (unsigned long)t[13]);
        Serial.printf("[diag6] rdcycle vs esp_cpu_get_cycle_count() 差 = %lu cycles (0 = 同一时基)\n",
                      (unsigned long)t[4]);
#endif
        break;
      }
      default:
        diagStep = 0;
        Serial.println(F("[diag] done; 'diag' again for step 1"));
        break;
    }
  } else {
    Serial.println(F("err unknown command"));
  }
}

#ifdef LED_SELFTEST
/**
 * 自检模式: 完全不初始化 BLE, 不解析任何网络命令 ——
 * 只验证「ESP32 → 灯带」这一层. 上电默认: 全灭, 第 0 颗 = 黄色.
 */
static void selftestLoop() {
  if (g_sweepIdx < 0) return;
  uint32_t now = millis();
  if ((int32_t)(now - g_sweepNext) < 0) return;
  if (g_sweepIdx >= ledStripLogicalCount()) {
    g_sweepIdx = -1;
    strip.clear();
    strip.show();
    Serial.println(F("ok sweep done"));
    return;
  }
  strip.clear();
  strip.setPixel(g_sweepIdx, 0, 200, 0);  // 绿色, 肉眼最敏感
  strip.show();
  Serial.printf("sweep idx=%d\n", g_sweepIdx);
  g_sweepIdx++;
  g_sweepNext = now + 150;
}
#endif

void setup() {
  Serial.begin(115200);
  // 立刻打一行 —— 确认应用层跑起来了 (ROM 输出只说明 bootloader 正常)
  Serial.println(F("[boot] app start"));

  if (!ledStripEnsure()) {
    Serial.println(F("FATAL: strip init failed"));
    while (true) delay(1000);
  }
  Serial.println(F("[boot] strip ok"));

#ifdef LED_SELFTEST
  g_sweepIdx = -1;
  printStatus();
  Serial.println(F("[selftest] BLE off; serial commands: first / walk / sweep / on / off / offall / status"));
  // 默认图案: 第 1 颗黄 + 第 10 颗红, 其余全灭, 常亮.
  applyBasePattern();
  Serial.printf("[selftest] LED %d = YELLOW, LED %d = RED, all others off\n",
                BASE_IDX_YELLOW, BASE_IDX_RED);
#else
  // BLE 初始化 (内含 "点亮第一颗灯" 的上电动作)
  bleLedSetup();
#if LED_WS_ENABLE
  // WiFi + WebSocket server —— 前端走 WebSocket 连过来 (跟树莓派那套一样).
  //
  // ★ 2026-11-11: wifiLinkSetup() 现在**不阻塞**了 (连接过程交给 wifiLinkLoop()
  //   轮询), 所以放在 bleLedSetup() 之后只是习惯 —— 不会卡住后面的 WS server 起来.
  wifiLinkSetup();
  wsLedSetup();
#endif
  Serial.println(F("esp32s3-led ready"));
  printStatus();
#endif
}

void loop() {
  static char buf[64];
  static size_t len = 0;

  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (len > 0) {
        buf[len] = '\0';
        handleCommand(buf);
        len = 0;
      }
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    }
  }

#ifdef LED_SELFTEST
  selftestLoop();
#else
  bleLedLoop();
#if LED_WS_ENABLE
  // WiFi 掉线重连 + WS 收命令/回包.
  wifiLinkLoop();
  wsLedLoop();
#endif
#endif
}
