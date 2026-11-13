#include "ble_led.h"

#include <string.h>

#include "ws_led.h"  // wsLedClientCount() —— status 里报当前连了几个 WS 客户端

// ---------------------------------------------------------------------------
// 灯带 —— 全局唯一实例, BLE 和 USB 串口共用
// ---------------------------------------------------------------------------

static LedStrip g_strip;
static bool stripInit = false;
static int stripPin = LED_PIN;
/**
 * 逻辑灯数 —— 前端 init 说的「这一条要亮几颗」.
 *
 * 只有「允许写哪几颗」受它管. 一帧推多少颗是 LED_PHYSICAL_COUNT (物理灯数),
 * 恒定的 —— 跟树莓派端 led_remote.py 的 _phys_count 一个意思.
 */
static int stripCount = LED_COUNT;

// 灯数白名单 (见 ble_led.h 的 LED_ALLOWED_COUNTS) —— 176 / 352.
static const int kAllowedCounts[] = { LED_ALLOWED_COUNTS };
static const int kAllowedCountNum = (int)(sizeof(kAllowedCounts) / sizeof(kAllowedCounts[0]));

static bool countAllowed(int c) {
  for (int i = 0; i < kAllowedCountNum; i++) {
    if (kAllowedCounts[i] == c) return true;
  }
  return false;
}

LedStrip& ledStrip() { return g_strip; }

int ledStripLogicalCount() { return stripCount; }

bool ledStripEnsure() {
  if (stripInit) return true;
  // ★ 缓冲按**物理**灯数分配 —— 一帧永远推满 physical 颗 (见 ble_led.h
  //   里 LED_PHYSICAL_COUNT 的说明: 推得比物理链短 → 尾巴那截保持旧颜色).
  if (!g_strip.begin(stripPin, LED_PHYSICAL_COUNT)) return false;
  g_strip.setBrightness(LED_BRIGHTNESS);
  g_strip.clear();
  stripInit = true;
  return true;
}

/**
 * 换**逻辑**灯数 (双色带 176 → 352).
 *
 * ★ 2026-11-04: 不再重建像素缓冲了 —— 缓冲大小是**物理**灯数 (恒定),
 *   逻辑灯数只决定「允许写哪几颗」.
 *
 * 逻辑灯数变小时 (352 → 176), 逻辑范围之外的那些像素会被抹黑**并刷出去**
 * —— 跟树莓派端 led_remote.py 的 _init_strip 一个行为 (那边是
 * "blackout count..phys_count"). 不这么做的话, 上灯带 (chain 176..351)
 * 会一直留着上一轮的颜色 (残留鬼影).
 */
bool ledStripSetCount(int count) {
  if (!countAllowed(count)) return false;
  if (!ledStripEnsure()) return false;
  bool shrunk = count < stripCount;
  stripCount = count;
  if (shrunk) {
    // 把逻辑范围之外的像素抹黑.
    for (int i = stripCount; i < g_strip.count(); i++) g_strip.setPixel(i, 0, 0, 0);
    // 刷出去 —— 不然物理灯带还留着旧颜色.
    g_strip.show();
  }
  return true;
}

// ---------------------------------------------------------------------------
// JSON 解析 (只支持协议里用到的类型)
// ---------------------------------------------------------------------------

// 抠出一个 JSON 值的片段 [start,end)
static int scanValue(const char* buf, int len, int start) {
  if (start >= len) return -1;
  if (buf[start] == '{' || buf[start] == '[') {
    int depth = 0;
    bool inStr = false;
    for (int i = start; i < len; i++) {
      char c = buf[i];
      if (inStr) {
        if (c == '\\') { i++; continue; }
        if (c == '"') inStr = false;
        continue;
      }
      if (c == '"') { inStr = true; continue; }
      if (c == '{' || c == '[') depth++;
      else if (c == '}' || c == ']') {
        depth--;
        if (depth == 0) return i + 1;
      }
    }
    return -1;
  }
  if (buf[start] == '"') {
    for (int i = start + 1; i < len; i++) {
      if (buf[i] == '\\') { i++; continue; }
      if (buf[i] == '"') return i + 1;
    }
    return -1;
  }
  int i = start;
  while (i < len && buf[i] != ',' && buf[i] != '}' && buf[i] != ']' &&
         buf[i] != ' ' && buf[i] != '\n' && buf[i] != '\r') {
    i++;
  }
  return i;
}

// 找 key 的值起点
static int findKey(const char* obj, int len, const char* key) {
  char pat[48];
  snprintf(pat, sizeof(pat), "\"%s\"", key);
  int patLen = strlen(pat);
  for (int i = 0; i + patLen <= len; i++) {
    if (strncmp(obj + i, pat, patLen) != 0) continue;
    int j = i + patLen;
    while (j < len && (obj[j] == ' ' || obj[j] == '\t')) j++;
    if (j < len && obj[j] == ':') {
      j++;
      while (j < len && (obj[j] == ' ' || obj[j] == '\t')) j++;
      return j;
    }
  }
  return -1;
}

static int getInt(const char* obj, int len, const char* key, int def) {
  int p = findKey(obj, len, key);
  if (p < 0) return def;
  int end = scanValue(obj, len, p);
  if (end < 0) return def;
  return atoi(obj + p);
}

static bool getStr(const char* obj, int len, const char* key, char* dst, int dstLen) {
  int p = findKey(obj, len, key);
  if (p < 0) return false;
  int end = scanValue(obj, len, p);
  if (end < 0 || end - p < 2 || obj[p] != '"') return false;
  int n = end - p - 2;
  if (n >= dstLen) n = dstLen - 1;
  memcpy(dst, obj + p + 1, n);
  dst[n] = '\0';
  return true;
}

// args 子对象
static void getArgs(const char* obj, int len, const char** aStart, int* aLen) {
  int p = findKey(obj, len, "args");
  if (p < 0) { *aStart = obj; *aLen = len; return; }
  int end = scanValue(obj, len, p);
  if (end < 0) { *aStart = obj; *aLen = len; return; }
  *aStart = obj + p;
  *aLen = end - p;
}

// ---------------------------------------------------------------------------
// BLE 通道
// ---------------------------------------------------------------------------

static BLECharacteristic* g_txChar = nullptr;
static BLEServer* g_server = nullptr;
static bool g_connected = false;

// 命令接收队列。
// BLE 写回调跑在 NimBLE 的 host task 里, 而灯带的 bit-bang show() 要占住
// CPU 10.6ms (物理 352 颗) —— 不能在回调里直接执行, 否则会阻塞蓝牙栈。
// 所以回调只负责把字节搬进队列, 真正的命令解析/执行放在 loop() 里做。
// ★ 2026-10-26: 从 4 改成 8 —— 实测 (scripts/bt_pi/pc/probe_ble_depth.py,
//   真机, Windows 上位机):
//
//   在途深度 | 收到/发出 | ms/条 | 丢?
//   ---------+-----------+-------+-----
//      2     |   60/60   | 62.6  | ✓   ← 旧值: 179 条 = 11.2 秒 (用户报的「十多秒」)
//      4     |   60/60   | 32.4  | ✓
//      5     |   60/60   | 27.3  | ✓
//      6     |   59/60   | 77.1  | ⚠️ 丢 1  ← 4 槽队列的溢出点
//      8     |   57/60   | 80.5  | ⚠️ 丢 3
//
//   瓶颈**不是**设备算得慢 (bit-bang show 只要 10.6ms), 是**回执延迟**:
//   设备处理完 → 发通知 → 通知要等下一个连接事件才到主机.
//   在途窗口只有 2 时, 主机每收一个回执才敢发下一条, 于是整条流水被
//   「等回执」的往返卡住. 窗口放宽 → 设备能被喂饱 → 逼近 10.6ms 的物理地板.
//
//   队列只有 4 槽时, 深度 6 就开始丢. 加到 8 槽后深度可以开到 6,
//   代价是 8 × 4096 = 32KB 静态 RAM (ESP32-S3 有 512KB, 够用).
// ★ 2026-11-11: 8 → 4 槽. 每个槽是一个 4KB 行缓冲 (16KB 静态 RAM).
//   8 槽是 BLE 时代为「在途深度 6」留的; 现在前端只走 WebSocket
//   (WS 命令在事件回调里直接执行, 根本不进这个队列), BLE 只剩兼容.
//   真机 free heap 只剩 7.8KB 时, 这几 KB 就是 WiFi 能不能分到 ARP 缓冲的区别.
//   旧固件/BLE 客户端如果真把队列打满, 固件会回 `rx queue full` (不静默丢).
#define RX_QUEUE_SLOTS 4
// 前端 LedController 每批最多 80 个像素, 一个像素 JSON 约 34 字节
// → 单条命令最长约 2.8KB。留到 4KB。
#define RX_LINE_MAX 4096

/**
 * 帧起始字节 (STX) —— 每条命令的第一个字节.
 *
 * 为什么需要它: 一条命令要拆成好几个 ATT 包. 如果某一包写失败/被丢, 设备
 * 手上就剩了半行; 前端从头发一遍重试, 半行 + 新命令会拼成一条垃圾 JSON.
 * 旧固件把垃圾行**半解析**后照常执行 → 随机像素亮/灭 (用户报的「乱闪」).
 *
 * 有了帧头, 设备一看到 STX 就把旧半行整个丢掉, 从这条命令重新开始 ——
 * 重试变得安全. 旧固件不认识 STX, 但它的解析器是按 key 搜的, 前面的 STX
 * 不影响 id/op/pixels 的查找, 所以新前端 + 旧固件仍然能用 (只是没有重同步).
 */
#define RX_FRAME_START 0x02

static portMUX_TYPE g_rxMux = portMUX_INITIALIZER_UNLOCKED;
static char g_rxQueue[RX_QUEUE_SLOTS][RX_LINE_MAX];
static int g_rxQueueLen[RX_QUEUE_SLOTS];
static int g_rxHead = 0;   // 下一个要处理的槽位
static int g_rxTail = 0;   // 下一个要写入的槽位
static int g_rxFill = 0;   // 队列里待处理的命令数
static char g_rxLine[RX_LINE_MAX];
static int g_rxLineLen = 0;
/** 诊断计数: 拼不成 JSON 对象的坏帧 / 队列满被拒的帧 (status 里可读). */
static uint32_t g_badFrames = 0;
static uint32_t g_droppedFrames = 0;
/**
 * 距上次 show 以来 set/set_many 了多少颗 —— 跟树莓派 led_remote.py 的
 * `_sets_since_show` 一个语义 (show 的回执里回报 flushed, status 里回报
 * sets_pending).
 */
static int g_setsSinceShow = 0;
/** 上次 show 的时刻 (millis) —— status 里回报 last_show_age_s. 0 = 还没 show 过. */
static uint32_t g_lastShowMs = 0;

void bleSend(const char* text) {
#if LED_SERIAL_ECHO
  // 同时输出到串口, 方便调试.
  //
  // ⚠️ 默认关闭 (LED_SERIAL_ECHO=0): 这是**阻塞**写 —— 一条 45 字节的回应
  // 在 115200 波特率下要 3.9ms, 而且串口没人读的时候会把 TX 缓冲写满,
  // 直接卡住命令处理. 一条命令 21ms 的成本里, 串口回显要占掉 3.9ms.
  // 要抓 BLE 流量时在 platformio.ini 里加 -D LED_SERIAL_ECHO=1 重新烧录.
  Serial.println(text);
#endif
  if (!g_connected || !g_txChar) return;

  // 通知有 MTU 限制, 长响应要分片发.
  //
  // ★ 2026-10-24: 这里**必须用协商好的 MTU**, 不能硬编码 20.
  //   旧实现硬编码 20 字节一片 + 每片 delay(5) —— 一条 45 字节的回应要
  //   3 片 = 15ms. 前端的跑马灯 176 帧 × 2 条命令 = 352 条, 光回包就
  //   5.3 秒 (用户报的「跑马灯走了十多秒」).
  //   设备明明请求了 BLEDevice::setMTU(247), 拿协商结果直接一发就完事.
  int chunk = 20;  // 兜底: 没连上 / 没谈拢 MTU 时的最小值
  if (g_server) {
    uint16_t mtu = g_server->getPeerMTU(g_server->getConnId());
    if (mtu > 23) chunk = (int)(mtu - 3);  // ATT 载荷 = MTU - 3
    if (chunk > BLE_TX_MAX) chunk = BLE_TX_MAX;
  }

  int len = strlen(text);
  int off = 0;
  while (off < len) {
    int n = len - off;
    if (n > chunk) n = chunk;
    if (n > BLE_TX_MAX) n = BLE_TX_MAX;
    // +1: 末尾要补 '\0'; n 可以等于 BLE_TX_MAX, 不能只开 BLE_TX_MAX.
    char part[BLE_TX_MAX + 1];
    memcpy(part, text + off, n);
    part[n] = '\0';
    g_txChar->setValue((uint8_t*)part, n);
    g_txChar->notify();
    off += n;
    // 还有下一片才等一下 —— 最后一片发完立刻返回.
    // 主机是 write-without-response, 一个 ATT 包就是一个包, 不需要额外延迟.
    if (off < len) delay(2);
  }
}

// ---------------------------------------------------------------------------
// 命令处理
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 回包
// ---------------------------------------------------------------------------
//
// 回包里的 id **原样回显请求里的 JSON 片段** ——
//   BLE 那边是字符串 ("p1"), WebSocket 那边是数字 (1).
// 前端按 id 把回包配回请求, 类型必须对上, 所以不能一律加引号.

/** 取出 "id" 的**原始** JSON 片段 (字符串带引号, 数字不带). */
static void getRawId(const char* obj, int len, char* dst, int dstLen) {
  if (dstLen <= 0) return;
  dst[0] = '\0';
  int p = findKey(obj, len, "id");
  if (p < 0) return;
  int end = scanValue(obj, len, p);
  if (end < 0) return;
  int n = end - p;
  if (n > dstLen - 1) n = dstLen - 1;
  memcpy(dst, obj + p, n);
  dst[n] = '\0';
}

/** 造一条回包 (ok + 可选的 result). */
static void buildResp(char* dst, int dstLen, const char* rawId, bool ok,
                      const char* resultJson) {
  const char* id = (rawId && *rawId) ? rawId : "null";
  if (resultJson && *resultJson) {
    snprintf(dst, dstLen, "{\"id\":%s,\"ok\":%s,\"result\":%s}\n", id,
             ok ? "true" : "false", resultJson);
  } else {
    snprintf(dst, dstLen, "{\"id\":%s,\"ok\":%s}\n", id, ok ? "true" : "false");
  }
}

/** 造一条错误回包. */
static void buildRespErr(char* dst, int dstLen, const char* rawId, const char* msg) {
  char esc[256];
  int j = 0;
  for (int i = 0; msg[i] && j < (int)sizeof(esc) - 2; i++) {
    if (msg[i] == '"' || msg[i] == '\\') esc[j++] = '\\';
    esc[j++] = msg[i];
  }
  esc[j] = '\0';
  const char* id = (rawId && *rawId) ? rawId : "null";
  snprintf(dst, dstLen, "{\"id\":%s,\"ok\":false,\"error\":\"%s\"}\n", id, esc);
}

// led.set_many 的 pixels 数组
//
// ★ 2026-11-04: 像素下标字段 **i** 和 **index** 都认 (树莓派那边叫 i,
//   设备这一套原本叫 index —— 现在两个都收, 少一层翻译, 也不怕哪边改名).
//   另外 rgb 超出 0..255 时**按 & 0xFF 截断**, 不报错 —— 跟树莓派端
//   led_remote.py 一个行为 (那边是 `r & 0xFF`).
//
// overflow: 像素个数超过 maxPixels 时置 true —— 宁可报错, 也**不能默默
//   截断** (截断了就是「点亮了一半」的鬼片).
static int parsePixels(const char* args, int argsLen, int* idx, uint8_t* r, uint8_t* g,
                        uint8_t* b, int maxPixels, bool* overflow) {
  if (overflow) *overflow = false;
  int p = findKey(args, argsLen, "pixels");
  if (p < 0) return 0;
  int arrEnd = scanValue(args, argsLen, p);
  if (arrEnd < 0) return 0;

  int n = 0;
  int i = p + 1;
  while (i < arrEnd) {
    while (i < arrEnd && (args[i] == ' ' || args[i] == ',' || args[i] == '\n' ||
                          args[i] == '\r')) {
      i++;
    }
    if (i >= arrEnd || args[i] != '{') break;
    int objEnd = scanValue(args, arrEnd, i);
    if (objEnd < 0) break;
    if (n >= maxPixels) {
      // 还有像素没读完 —— 装不下.
      if (overflow) *overflow = true;
      break;
    }
    int objLen = objEnd - i;
    int ix = getInt(args + i, objLen, "i", -2);
    if (ix == -2) ix = getInt(args + i, objLen, "index", -1);
    idx[n] = ix;
    r[n] = (uint8_t)(getInt(args + i, objLen, "r", 0) & 0xFF);
    g[n] = (uint8_t)(getInt(args + i, objLen, "g", 0) & 0xFF);
    b[n] = (uint8_t)(getInt(args + i, objLen, "b", 0) & 0xFF);
    n++;
    i = objEnd;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 设备侧跑马灯 (led.marquee)
// ---------------------------------------------------------------------------
//
// 为什么放设备上: 一帧一条 BLE 命令 + 回执, 176 帧光 GATT 往返就要好几秒
// (真机实测 1.7~3s, 用户报「测试跑得比 0.5s 慢太多」). 设备本地按 bit-bang
// 的物理速度推进, 一条命令就能跑完, 完全不依赖蓝牙吞吐.
//
// 同时它也顺手解决了「测试时其他灯乱闪」: 整个动画在 loop() 里一次做完,
// 中间不会插进别的 set_many.

/** 窗口内第 k 颗的颜色: 头最亮蓝 → 尾最暗紫 (与前端 testPattern 的渐变一致). */
static void marqueeColor(int k, int window, uint8_t* r, uint8_t* g, uint8_t* b) {
  float t = window <= 1 ? 0.0f : (float)k / (float)(window - 1);
  float hue = (240.0f + t * 40.0f) / 360.0f;
  float v = 1.0f - t * 0.75f;
  int i = (int)(hue * 6.0f);
  float f = hue * 6.0f - (float)i;
  float p = 0.0f;
  float q = v * (1.0f - f);
  float tt = v * (1.0f - (1.0f - f));
  float rr = 0, gg = 0, bb = 0;
  switch (i % 6) {
    case 0: rr = v; gg = tt; bb = p; break;
    case 1: rr = q; gg = v; bb = p; break;
    case 2: rr = p; gg = v; bb = tt; break;
    case 3: rr = p; gg = q; bb = v; break;
    case 4: rr = tt; gg = p; bb = v; break;
    case 5: rr = v; gg = p; bb = q; break;
  }
  if (r) *r = (uint8_t)(rr * 255.0f + 0.5f);
  if (g) *g = (uint8_t)(gg * 255.0f + 0.5f);
  if (b) *b = (uint8_t)(bb * 255.0f + 0.5f);
}

/**
 * 跑马灯窗口的上限 —— **同时点亮几颗**.
 *
 * ★ 2026-11-11: 这个上限以前是隐形的 —— window 只被裁到「逻辑灯数」
 *   (176 / 352), 而下面那三个颜色数组只有 64 字节. window 一旦超过 64,
 *   marqueeColor() 就会往数组外面写 → 踩坏栈上的返回地址 / 循环变量 →
 *   **设备直接挂死** (实测 window=176 时循环变量 k 被冲掉, 变成死循环).
 *
 *   window 是**客户端给的** (args.window), 公网那条 WS 通道又没鉴权 ——
 *   所以这不是「理论上越界」, 是**一条消息就能把板子打成砖**.
 *
 *   前端只发 window=6 (见 LedController.testPattern), 64 绰绰有余.
 *   超了怎么办: 见 led.marquee 那个分支 —— **回错**, 不照做.
 *     跟 set_many 的「宁可报错, 也不能默默截断」一个原则 (截断了就是
 *     「点亮了一半」的鬼片).
 */
#define MARQUEE_WINDOW_MAX 64

/** 同步跑一遍跑马灯. 返回实际画了几帧 (每帧一次 show() ≈ 10.6ms —— 物理 352 颗). */
static int marqueeRun(int window, int step) {
  // 扫的**逻辑**范围 (前端说这一条有几颗) —— 跟树莓派那边前端逐帧跑马灯
  // 用的范围一致 (那边也是按逻辑 count 算 step 和帧数).
  const int count = stripCount;
  if (count <= 0) return 0;
  if (window < 1) window = 1;
  if (window > count) window = count;
  // 功耗上限 (LED_MAX_LIT > 0 时): 窗口就是「同时点亮的颗数」, 不能超过上限 ——
  // 超了的话固件里的功耗上限会把多出来的灭掉, 跑马灯就会「缺一块」.
  if (LED_MAX_LIT > 0 && window > LED_MAX_LIT) window = LED_MAX_LIT;
  // ★ 数组只有 MARQUEE_WINDOW_MAX 大 —— 这里再兜一道底 (正常路径
  //   上面 led.marquee 已经把超限的挡掉了, 这里是防「以后有人改代码忘了」).
  if (window > MARQUEE_WINDOW_MAX) window = MARQUEE_WINDOW_MAX;
  if (step < 1) step = 1;

  uint8_t cr[MARQUEE_WINDOW_MAX], cg[MARQUEE_WINDOW_MAX], cb[MARQUEE_WINDOW_MAX];
  for (int k = 0; k < window; k++) marqueeColor(k, window, &cr[k], &cg[k], &cb[k]);

  g_strip.clear();
  g_strip.show();

  int frames = 0;
  for (int pos = 0; pos < count; pos += step) {
    // 掉出窗口的 step 颗灭掉 (窗口每帧前移 step)
    for (int i = pos - step - window + 1; i <= pos - window; i++) {
      if (i >= 0 && i < count) g_strip.setPixel(i, 0, 0, 0);
    }
    for (int k = 0; k < window; k++) {
      int i = pos - k;
      if (i >= 0 && i < count) g_strip.setPixel(i, cr[k], cg[k], cb[k]);
    }
    g_strip.show();
    frames++;
  }

  // 收尾: 清缓冲 + 刷一次, 灯带不留残影 (前端后面还会发 off, 双保险).
  g_strip.clear();
  g_strip.show();
  return frames;
}

/**
 * 命令回包缓冲 —— 执行完写在这儿, 由调用方决定发到哪条链路.
 *
 * BLE 走通知 (bleSend), WS 走 WS 帧 (ledExecLine 拷出去).
 * 两条链路都在同一个任务里跑 (Arduino loop), 不会并发写.
 */
static char g_execResp[BLE_TX_MAX + 128];

/**
 * 命令执行 —— BLE 和 WebSocket **共用**这一套.
 *
 * 两条链路说同一种话 (一行 JSON 进, 一行 JSON 出), 差别只在 op 的前缀:
 *   BLE : "led.init" / "led.set" / "led.set_many" / ...
 *   WS  : "init" / "set" / "set_many" / ...   (树莓派那边那套词汇)
 * 所以这里把 op 统一补成 "led.xxx" 再分派 —— 一套实现, 两条链路.
 *
 * 回包写在 g_execResp 里 (谁执行谁负责发出去): BLE 发通知, WS 发 WS 帧.
 */
static void execLine(const char* line, int len) {
  char rawId[64] = "";
  char op[64] = "";
  getRawId(line, len, rawId, sizeof(rawId));
  getStr(line, len, "op", op, sizeof(op));

  if (op[0] == '\0') {
    buildRespErr(g_execResp, sizeof(g_execResp), rawId, "missing op");
    return;
  }

  // op 统一成 "led.xxx" (BLE 本来就带前缀, WS 的裸 op 在这里补上).
  char norm[80];
  if (strncmp(op, "led.", 4) == 0) {
    snprintf(norm, sizeof(norm), "%s", op);
  } else {
    snprintf(norm, sizeof(norm), "led.%s", op);
  }

  const char* args;
  int argsLen;
  getArgs(line, len, &args, &argsLen);

  // ping: 裸的 "ping" (WS 那条路) 和 "led.ping" (BLE 那条路) 都认 ——
  // 以前只有前者, BLE 那边发 "led.ping" 会掉到 unknown op.
  if (strcmp(op, "ping") == 0 || strcmp(norm, "led.ping") == 0) {
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, "{\"pong\":true}");
    return;
  }

  if (strcmp(op, "status") == 0) {
    // ★ 字段跟树莓派 led_remote.py 对齐: ready / count / physical / pin /
    //   sets_pending / last_show_age_s —— 前端和诊断脚本都认这几个.
    //   下面那几个 ble_* / ws_* 是 ESP32 独有的诊断信息 (留着不碍事).
    char r[512];
    snprintf(r, sizeof(r),
             "{\"name\":\"%s\",\"ble_connected\":%s,\"led_initialized\":%s,"
             "\"ready\":%s,\"pin\":%d,\"count\":%d,\"physical\":%d,\"max_lit\":%d,"
             "\"sets_pending\":%d,\"last_show_age_s\":%.3f,"
             "\"queue\":%d,\"bad_frames\":%u,\"dropped\":%u,\"heap\":%u,\"ws_clients\":%d}",
             BT_NAME, g_connected ? "true" : "false", stripInit ? "true" : "false",
             stripInit ? "true" : "false", stripPin, stripCount, LED_PHYSICAL_COUNT,
             LED_MAX_LIT, g_setsSinceShow, g_lastShowMs ? (millis() - g_lastShowMs) / 1000.0 : -1.0,
             g_rxFill, (unsigned)g_badFrames, (unsigned)g_droppedFrames,
             (unsigned)ESP.getFreeHeap(), wsLedClientCount());
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, r);
    return;
  }

  if (strcmp(norm, "led.auth") == 0) {
    // WebSocket 握手的**第一条**消息 (树莓派那边 ws_led_bridge.py 要求先 auth).
    //
    // ★ P0: **不校验 token** —— 直接回 ok, 让前端跳过鉴权继续走 init.
    //   真要跟树莓派一个强度 (共享 token + Origin 白名单 + 限流) 是 P1,
    //   校验点就在这里: 把下面的 ok 换成比较 args.token.
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, "{\"auth\":true}");
    return;
  }

  if (strcmp(norm, "led.init") == 0) {
    // 引脚是编译期固定的 (platformio.ini), 不能运行时改。
    // 前端发的 pin 是树莓派的 GPIO 18, 这里忽略并回报本机的实际值。
    //
    // 灯数**可以**改 (白名单 176 / 352) —— 双色带要 352 颗.
    //
    // ★ set_many_shows: false —— 告诉主机「set / set_many **只写缓冲**, 要自己
    //   发 led.show 才刷到灯带上」. 跟树莓派端 led_remote.py 一个语义.
    //   (老固件没有这个字段 → 主机按「set_many 自己会 show」处理, 兼容.)
    int pin = getInt(args, argsLen, "pin", LED_PIN);
    int count = getInt(args, argsLen, "count", LED_COUNT);
    if (!countAllowed(count)) {
      // 不在白名单里 —— 明确报错 (前端能提示用户), 灯带保持原样.
      buildRespErr(g_execResp, sizeof(g_execResp), rawId, "count not allowed");
      return;
    }
    if (!ledStripSetCount(count)) { buildRespErr(g_execResp, sizeof(g_execResp), rawId, "strip init failed"); return; }
    // init 之后灯带是**灭的** (跟树莓派那边 init 完把 count..phys 抹黑一个行为).
    g_strip.clear();
    g_strip.show();
    // ★ init 也算一次「刷灯」 —— 树莓派那边 _init_strip() 里就有
    //   `self._last_show = time.time()`, 所以 status 里的 last_show_age_s
    //   从 init 那一刻开始算 (不是 null).
    g_lastShowMs = millis();
    g_setsSinceShow = 0;
    char r[192];
    if (pin != LED_PIN) {
      snprintf(r, sizeof(r),
               "{\"pin\":%d,\"count\":%d,\"physical\":%d,\"requested_pin\":%d,"
               "\"set_many_shows\":false}",
               LED_PIN, stripCount, LED_PHYSICAL_COUNT, pin);
    } else {
      snprintf(r, sizeof(r),
               "{\"pin\":%d,\"count\":%d,\"physical\":%d,\"set_many_shows\":false}",
               LED_PIN, stripCount, LED_PHYSICAL_COUNT);
    }
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, r);
    return;
  }

  if (strcmp(norm, "led.set") == 0) {
    ledStripEnsure();
    // 下标字段 index / i 都认 (树莓派那边叫 i, 设备这套叫 index).
    int index = getInt(args, argsLen, "index", -2);
    if (index == -2) index = getInt(args, argsLen, "i", -1);
    if (index < 0 || index >= stripCount) { buildRespErr(g_execResp, sizeof(g_execResp), rawId, "index out of range"); return; }
    // rgb 超范围 → 按 & 0xFF 截断, 不报错 (跟树莓派端一个行为).
    int r = getInt(args, argsLen, "r", 0) & 0xFF;
    int g = getInt(args, argsLen, "g", 0) & 0xFF;
    int b = getInt(args, argsLen, "b", 0) & 0xFF;
    // ★ 只写缓冲, **不** show —— 刷灯带由 led.show 负责 (跟树莓派端一个语义).
    g_strip.setPixel(index, r, g, b);
    g_setsSinceShow++;
    char out[96];
    snprintf(out, sizeof(out), "{\"index\":%d,\"r\":%d,\"g\":%d,\"b\":%d}", index, r, g, b);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  if (strcmp(norm, "led.all") == 0) {
    ledStripEnsure();
    int r = getInt(args, argsLen, "r", 0) & 0xFF;
    int g = getInt(args, argsLen, "g", 0) & 0xFF;
    int b = getInt(args, argsLen, "b", 0) & 0xFF;
    g_strip.setAll(r, g, b);
    char out[96];
    snprintf(out, sizeof(out), "{\"count\":%d,\"r\":%d,\"g\":%d,\"b\":%d}", stripCount, r, g, b);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  if (strcmp(norm, "led.set_many") == 0) {
    ledStripEnsure();
    static int idx[1024];
    static uint8_t rr[1024], gg[1024], bb[1024];
    bool overflow = false;
    int n = parsePixels(args, argsLen, idx, rr, gg, bb, 1024, &overflow);
    if (overflow) { buildRespErr(g_execResp, sizeof(g_execResp), rawId, "too many pixels"); return; }
    // n == 0 (空的 pixels 列表) → 跟树莓派端一个行为: 回 ok, set: 0.
    // (树莓派那边 "pixels must be a list" / "pixel must be an object" 才报错.)
    // 先全部校验再写 —— 有一个下标不对就整条不写 (原子).
    for (int i = 0; i < n; i++) {
      if (idx[i] < 0 || idx[i] >= stripCount) { buildRespErr(g_execResp, sizeof(g_execResp), rawId, "index out of range"); return; }
    }
    for (int i = 0; i < n; i++) g_strip.setPixel(idx[i], rr[i], gg[i], bb[i]);
    g_setsSinceShow += n;
    // ★ 只写缓冲, **不** show (跟树莓派端一个语义).
    char out[64];
    snprintf(out, sizeof(out), "{\"set\":%d}", n);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  if (strcmp(norm, "led.show") == 0) {
    ledStripEnsure();
    // 把整个像素缓冲推给灯带 (一帧 = LED_PHYSICAL_COUNT 颗).
    g_strip.show();
    g_lastShowMs = millis();
    // flushed = 距上次 show 以来 set 了几次 —— 跟树莓派 led_remote.py 一个字段
    // (ws_dual_check.py 靠它判断「一帧推满没有」).
    char out[64];
    snprintf(out, sizeof(out), "{\"shown\":true,\"flushed\":%d}", g_setsSinceShow);
    g_setsSinceShow = 0;
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  if (strcmp(norm, "led.off") == 0) {
    ledStripEnsure();
    // 清空**整个物理**缓冲并刷出去 —— 跟树莓派端的 off 一个语义
    // (那边是把 physical 颗全清掉再 render).
    g_strip.clear();
    g_strip.show();
    // ★ off **不**更新 g_lastShowMs —— 树莓派那边 _op_led_off 也没碰 _last_show
    //   (它只把 _sets_since_show 清零). status 里的 last_show_age_s 指的是
    //   「距上次 show 多久」, off 之后还是老的那个时间.
    g_setsSinceShow = 0;
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, "{\"off\":true}");
    return;
  }

  if (strcmp(norm, "led.marquee") == 0) {
    // 设备侧跑马灯 —— 动画跑完才回执, 前端 await 到回执时灯已经停了.
    // window: 拖尾长度; step: 每帧前进几颗 (前端按 0.5s 目标算出 step).
    ledStripEnsure();
    int window = getInt(args, argsLen, "window", 6);
    int step = getInt(args, argsLen, "step", 2);
    // ★ window 超了上限 → **回错**, 不照做 (照做会踩坏栈, 见 marqueeRun).
    //   前端收到错会回退到「逐帧发」那条路 (LedController.testPattern 有 catch),
    //   所以对用户来说只是慢一点, 不会把设备搞挂.
    if (window > MARQUEE_WINDOW_MAX) {
      buildRespErr(g_execResp, sizeof(g_execResp), rawId, "window too large");
      return;
    }
    int frames = marqueeRun(window, step);
    char out[64];
    snprintf(out, sizeof(out), "{\"frames\":%d}", frames);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  // -------------------------------------------------------------------------
  // 调试回读: 不用眼睛也能确认固件里的像素缓冲到底是什么.
  // 这是判断"软件写对了但灯带没显示" vs "软件就写错了"的关键.
  // -------------------------------------------------------------------------
  if (strcmp(norm, "led.getpix") == 0) {
    // 诊断用 —— 允许读**物理**范围内的任意一颗 (含逻辑范围之外的那截).
    int index = getInt(args, argsLen, "index", -2);
    if (index == -2) index = getInt(args, argsLen, "i", -1);
    if (index < 0 || index >= g_strip.count()) { buildRespErr(g_execResp, sizeof(g_execResp), rawId, "index out of range"); return; }
    uint8_t r = 0, g = 0, b = 0;
    g_strip.getPixel(index, &r, &g, &b);
    char out[96];
    snprintf(out, sizeof(out), "{\"index\":%d,\"r\":%d,\"g\":%d,\"b\":%d}", index, r, g, b);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  if (strcmp(norm, "led.litcount") == 0) {
    int lit = 0;
    uint32_t sum = 0;
    for (int i = 0; i < g_strip.count(); i++) {
      uint8_t r = 0, g = 0, b = 0;
      g_strip.getPixel(i, &r, &g, &b);
      if (r || g || b) {
        lit++;
        sum = sum * 131u + (((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b);
      }
    }
    char out[96];
    snprintf(out, sizeof(out), "{\"lit\":%d,\"sum\":%lu}", lit, (unsigned long)sum);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, out);
    return;
  }

  if (strcmp(norm, "led.status") == 0) {
    // ★ 2026-11-10: 补 ready / sets_pending / last_show_age_s —— 跟上面那个
    //   顶层 status op 同一个形状 (树莓派 led_remote.py 的 status 就是这几个
    //   字段). 少了这几个, 拿 led.status 当「设备校验接口」的人会看不到
    //   缓冲里还压着几帧、上次刷灯是什么时候.
    char r[320];
    snprintf(r, sizeof(r),
             "{\"initialized\":%s,\"ready\":%s,\"pin\":%d,\"count\":%d,\"physical\":%d,"
             "\"brightness\":%d,\"max_lit\":%d,\"set_many_shows\":false,"
             "\"sets_pending\":%d,\"last_show_age_s\":%.3f}",
             stripInit ? "true" : "false", stripInit ? "true" : "false",
             stripPin, stripCount, LED_PHYSICAL_COUNT,
             LED_BRIGHTNESS, LED_MAX_LIT, g_setsSinceShow,
             g_lastShowMs ? (millis() - g_lastShowMs) / 1000.0 : -1.0);
    buildResp(g_execResp, sizeof(g_execResp), rawId, true, r);
    return;
  }

  buildRespErr(g_execResp, sizeof(g_execResp), rawId, "unknown op");
}

/**
 * 从一行 JSON 里抠出 "id" 的**原始**片段 —— 只用于队列满时回错误包
 * (正常回包在 execLine 里).
 *
 * 原始片段 = 字符串带引号 ("p1"), 数字不带 (1) —— 跟回包里回显的格式一致.
 */
static int extractId(const char* line, int len, char* out, int outLen) {
  if (outLen <= 0) return 0;
  out[0] = '\0';
  int p = findKey(line, len, "id");
  if (p < 0) return 0;
  int end = scanValue(line, len, p);
  if (end < 0) return 0;
  int n = end - p;
  if (n > outLen - 1) n = outLen - 1;
  memcpy(out, line + p, n);
  out[n] = '\0';
  return n;
}

/**
 * 一行收齐后的处理: 严格校验 + 入队; 队列满了**回一个错误**, 不静默丢.
 *
 * 以前是静默丢 —— 前端那条命令永远等不到回执, 要等超时才放槽位, 整条
 * BLE 流水就卡住 (跑马灯「非常慢」). 现在设备明确回 ok:false, 前端立刻知道.
 */
static void enqueueLine() {
  char id[64] = "";
  bool bad = false;
  bool full = false;

  portENTER_CRITICAL(&g_rxMux);
  int n = g_rxLineLen;
  g_rxLineLen = 0;
  if (n < 4 || g_rxLine[0] != '{' || g_rxLine[n - 1] != '}') {
    // 半行 / 拼坏的帧: 直接丢弃, 绝不"半解析"后执行 (那会画错像素 = 乱闪).
    g_badFrames++;
    bad = true;
  } else if (g_rxFill >= RX_QUEUE_SLOTS) {
    g_droppedFrames++;
    full = true;
    extractId(g_rxLine, n, id, sizeof(id));
  } else {
    int slot = g_rxTail;
    memcpy(g_rxQueue[slot], g_rxLine, n);
    g_rxQueue[slot][n] = '\0';
    g_rxQueueLen[slot] = n;
    g_rxTail = (g_rxTail + 1) % RX_QUEUE_SLOTS;
    g_rxFill++;
  }
  portEXIT_CRITICAL(&g_rxMux);

  if (full) {
    // 队列满了 —— 明确回一条错误 (用局部缓冲, 别踩 g_execResp).
    char buf[BLE_TX_MAX];
    buildRespErr(buf, sizeof(buf), id, "rx queue full");
    bleSend(buf);
  }
  (void)bad;
}

// BLE 写回调 —— 主机发来的命令。只搬字节, 不执行。
static void onRxWrite(BLECharacteristic* chr, uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    char c = (char)data[i];
    if (c == (char)RX_FRAME_START) {
      // 新帧开始: 丢掉上一帧可能残留的半行.
      portENTER_CRITICAL(&g_rxMux);
      g_rxLineLen = 0;
      portEXIT_CRITICAL(&g_rxMux);
      continue;
    }
    if (c == '\n' || c == '\r') {
      portENTER_CRITICAL(&g_rxMux);
      bool hasLine = g_rxLineLen > 0;
      portEXIT_CRITICAL(&g_rxMux);
      if (hasLine) enqueueLine();
      continue;
    }
    if (c == '\0') continue;
    portENTER_CRITICAL(&g_rxMux);
    if (g_rxLineLen < RX_LINE_MAX - 1) g_rxLine[g_rxLineLen++] = c;
    portEXIT_CRITICAL(&g_rxMux);
  }
}

class RxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* chr) override {
    String v = chr->getValue();
    onRxWrite(chr, (uint8_t*)v.c_str(), v.length());
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  // ESP32-S3 的 Arduino 框架用 NimBLE (不是 Bluedroid), 回调签名不一样。
  void onConnect(BLEServer* server, ble_gap_conn_desc* desc) override {
    g_connected = true;
    Serial.println(F("[ble] host connected"));
  }
  void onDisconnect(BLEServer* server, ble_gap_conn_desc* desc) override {
    g_connected = false;
    Serial.println(F("[ble] host disconnected"));
  }
};

static ServerCallbacks g_serverCbs;

// ---------------------------------------------------------------------------
// setup / loop
// ---------------------------------------------------------------------------

void bleLedSetup() {
  ledStripEnsure();

  Serial.println(F("[ble] init..."));
  BLEDevice::init(BT_NAME);
  BLEDevice::setMTU(247);  // 大 MTU —— 批量下发像素时少分片

  g_server = BLEDevice::createServer();
  g_server->setCallbacks(&g_serverCbs);
  // 主机断开后自动恢复广播 —— 否则设备一次连过就再也扫不到了,
  // PC 端也就没法"自动连接"。
  g_server->advertiseOnDisconnect(true);

  BLEService* svc = g_server->createService(SERVICE_UUID);

  // RX: 主机写命令进来
  BLECharacteristic* rxChar = svc->createCharacteristic(
      RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  rxChar->setCallbacks(new RxCallbacks());

  // TX: 响应通知出去
  g_txChar = svc->createCharacteristic(
      TX_UUID, BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_READ);

  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->setName(BT_NAME);
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();

  Serial.print(F("[ble] advertising as "));
  Serial.println(BT_NAME);

  // ★ 2026-10-26: 上电点亮**第一颗黄灯**, 一直亮着 —— 用来验烧录/接线/供电
  //   是否通了. 之前是蓝灯 + 300ms 后自动熄灭, 蓝灯跟前端「左手白键蓝」撞色,
  //   分不清是固件点的还是前端点的; 而且闪一下就灭, 用户来不及确认.
  //
  //   ⚠️ 这颗黄灯会一直亮着, 直到主机发来 led.init / led.off
  //     (前端握手就是 init + off, 所以连上就没了).
  //     不想有这颗灯的话编译时加 -D LED_BOOT_TEST_PIXEL=0.
#if LED_BOOT_TEST_PIXEL
  g_strip.setPixel(0, 255, 255, 0);
  g_strip.show();
#endif
}

void bleLedLoop() {
  // 从队列里取命令执行 (BLE 回调只负责入队).
  // line 用 static: 4KB 放 loop task 的 8KB 栈上太紧张 (execLine 里还会
  // 再嵌一层 parsePixels / show).
  static char line[RX_LINE_MAX];
  while (true) {
    portENTER_CRITICAL(&g_rxMux);
    if (g_rxFill == 0) {
      portEXIT_CRITICAL(&g_rxMux);
      break;
    }
    int slot = g_rxHead;
    int n = g_rxQueueLen[slot];
    memcpy(line, g_rxQueue[slot], n);
    line[n] = '\0';
    g_rxHead = (g_rxHead + 1) % RX_QUEUE_SLOTS;
    g_rxFill--;
    portEXIT_CRITICAL(&g_rxMux);

    execLine(line, n);
    bleSend(g_execResp);
  }
}

/**
 * 执行一行 JSON 命令, 把回包写进 out —— **WebSocket 链路用这个**.
 *
 * op 词汇跟树莓派那边一样 (裸的 "init" / "set_many" / "show" / "off" ...),
 * 回包里的 id 原样回显 (数字就是数字).
 *
 * 返回写入的字节数 (含末尾换行); 0 = 没写进去 (out 太小).
 */
size_t ledExecLine(const char* line, int len, char* out, int outLen) {
  if (!out || outLen <= 0) return 0;
  execLine(line, len);
  int n = (int)strlen(g_execResp);
  int c = n < outLen - 1 ? n : outLen - 1;
  memcpy(out, g_execResp, c);
  out[c] = '\0';
  return (size_t)c;
}

void blePrintRxStats() {
  Serial.printf("rx queue=%d bad_frames=%u dropped=%u\n", g_rxFill,
                (unsigned)g_badFrames, (unsigned)g_droppedFrames);
}

const char* ledDriverName() {
#if LED_DRIVER_RMT
  return "rmt";
#else
  return "bitbang";
#endif
}
