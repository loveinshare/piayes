#include "ws_led.h"

#if LED_WS_ENABLE

#include <stdarg.h>

#include <WebSocketsServer.h>

#include "wifi_link.h"

#ifndef LED_WS_PORT
#define LED_WS_PORT 8080
#endif
/**
 * 同时接几个客户端 —— 跟树莓派那边 ws_led_bridge.py 的 LED_MAX_CLIENTS=4 一致.
 * 实际上只有浏览器 (或 /led-proxy 反代) 会连, 4 个够用.
 */
#ifndef WEBSOCKETS_SERVER_CLIENT_MAX
#define WEBSOCKETS_SERVER_CLIENT_MAX 4
#endif
/**
 * 单条命令最长多少字节.
 *
 * 前端 LedController 每批最多 80 个像素, 一个像素的 JSON 约 36 字节
 * → 单条命令最长约 2.9KB。
 *
 * ★ 2026-11-11: 8KB → 4KB, 而且这个缓冲**只用于分片重组** ——
 *   浏览器 `WebSocket.send()` 一条消息一个帧 (WStype_TEXT 直接执行,
 *   根本不进 g_msg). 4KB 已经盖住 2.9KB 的 set_many; 4 个客户端 × 4KB
 *   = 16KB (原来 32KB). 真机上这 16KB 是 WiFi 能不能稳住的关键.
 */
#ifndef WS_MSG_MAX
#define WS_MSG_MAX 4096
#endif

static WebSocketsServer g_ws(LED_WS_PORT);

/**
 * 分片累积缓冲 —— 每个客户端一份.
 *
 * 浏览器的 WebSocket.send() 一条消息一个帧 (不分片), 所以正常走不到这里;
 * 留着是为了「万一来了一段不完整的」有个兜底 —— 拼齐了再执行, 绝不半条命令
 * 就去改像素 (那会画出乱七八糟的灯 = 用户报的「乱闪」).
 */
static char g_msg[WEBSOCKETS_SERVER_CLIENT_MAX][WS_MSG_MAX];
static int g_msgLen[WEBSOCKETS_SERVER_CLIENT_MAX];

/** 把一段分片接到累积缓冲上. 超长就丢掉 (回一个错误). */
static bool appendFragment(uint8_t num, const uint8_t* payload, size_t length) {
  if (num >= WEBSOCKETS_SERVER_CLIENT_MAX) return false;
  if (g_msgLen[num] + (int)length > WS_MSG_MAX - 1) {
    g_msgLen[num] = 0;
    return false;
  }
  memcpy(g_msg[num] + g_msgLen[num], payload, length);
  g_msgLen[num] += (int)length;
  g_msg[num][g_msgLen[num]] = '\0';
  return true;
}

/**
 * 把 "key" 的值**原样**拷进 dst.
 *
 * 标量 (true / 12 / "abc") 原样拷; 对象 / 数组连括号一起拷.
 * 找不到就返回 false.
 */
static bool copyRawValue(const char* s, const char* key, char* dst, size_t dstLen) {
  if (dstLen == 0) return false;
  dst[0] = '\0';
  char pat[32];
  snprintf(pat, sizeof(pat), "\"%s\":", key);
  const char* p = strstr(s, pat);
  if (!p) return false;
  p += strlen(pat);
  const char* end = nullptr;
  if (*p == '{' || *p == '[') {
    int depth = 0;
    for (const char* q = p; *q; q++) {
      if (*q == '{' || *q == '[') depth++;
      else if (*q == '}' || *q == ']') {
        depth--;
        if (depth == 0) { end = q + 1; break; }
      }
    }
  } else {
    end = p;
    while (*end && *end != ',' && *end != '}' && *end != ']' && *end != '\n') end++;
  }
  if (!end) return false;
  size_t n = (size_t)(end - p);
  if (n >= dstLen) n = dstLen - 1;
  memcpy(dst, p, n);
  dst[n] = '\0';
  return true;
}

/**
 * 从请求行里取出 op 名 (去掉两边的引号).
 *
 * ★ **不能**把整行拷到栈上的 buffer 里 —— WS 的事件回调跑在 Arduino 的
 *   loopTask 里, 栈只有 8KB; 一来一去 4KB 的局部数组就能把栈冲爆
 *   (真机踩过: "Stack canary watchpoint triggered (loopTask)", 设备直接重启).
 *   所以这里**在原地扫**, 一个字节都不拷.
 */
static bool requestOp(const char* line, int len, char* dst, size_t dstLen) {
  if (dstLen == 0) return false;
  dst[0] = '\0';
  if (len <= 0) return false;
  for (int i = 0; i + 4 < len; i++) {
    if (line[i] != '"' || line[i + 1] != 'o' || line[i + 2] != 'p' || line[i + 3] != '"') continue;
    int j = i + 4;
    while (j < len && (line[j] == ' ' || line[j] == '\t')) j++;
    if (j < len && line[j] == ':') j++;
    while (j < len && (line[j] == ' ' || line[j] == '\t')) j++;
    if (j >= len || line[j] != '"') return false;
    int s = ++j;
    while (j < len && line[j] != '"') j++;
    int n = j - s;
    if (n <= 0 || (size_t)n >= dstLen) return false;
    memcpy(dst, line + s, (size_t)n);
    dst[n] = '\0';
    return true;
  }
  return false;
}

/** 往 fields 尾巴上追加一个 "key":value (逗号分隔). */
static void addField(char* fields, size_t fieldsLen, const char* key, const char* val) {
  size_t used = strlen(fields);
  if (used + 1 >= fieldsLen) return;
  snprintf(fields + used, fieldsLen - used, "%s\"%s\":%s", used ? "," : "", key, val);
}

/** 往 out 尾巴上追加一段格式化文本 (自动截断, 不会越界). */
static size_t appendStr(char* out, size_t outLen, size_t used, const char* fmt, ...) {
  if (used >= outLen) return used;
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(out + used, outLen - used, fmt, ap);
  va_end(ap);
  if (n < 0) return used;
  size_t total = used + (size_t)n;
  return total > outLen ? outLen - 1 : total;
}

/**
 * 把设备回包整成**树莓派 WS 桥**那个样子.
 *
 * 树莓派那边 (led_remote.py) 每个 op 的回包字段是写死的:
 *     init     → {"ok":true,"count":176,"physical":352,"pin":18}
 *     set      → {"ok":true}
 *     set_many → {"ok":true,"set":80}
 *     show     → {"ok":true,"flushed":80}
 *     off      → {"ok":true}
 *     ping     → {"ok":true,"pong":true}
 *     status   → {"ok":true,"ready":true,"count":176,"physical":352,"pin":18,
 *                  "sets_pending":0,"last_show_age_s":12.3}
 *
 * 设备内部 (BLE 那条路用) 是嵌套的, 字段也更多:
 *     {"id":1,"ok":true,"result":{"shown":true,"flushed":2}}
 *
 * 前端只读 ok / id, 两种都能跑 —— 但 WS 这一路是**拿来顶替树莓派的**,
 * 对外长得一样, 现有脚本 (ws_dual_check.py / ws_parity.py 之类) 才能原样接着用.
 *
 * 不在树莓派那张表里的 op (ESP32 独有的 marquee 之类) → 整个 result 摊平回去,
 * 算是**超集**: 多出来的 op 不影响前端 (前端那条路压根不发 marquee).
 */
static size_t piReply(char* out, size_t outLen, const char* op, const char* in) {
  // ★ 局部数组全用 **static** —— 这个函数跑在 Arduino 的 loopTask 里,
  //   栈只有 8KB, 一次 WS 回调里再叠几个 KB 的局部数组就爆了.
  //   (WS 事件回调是单线程的, static 没有重入问题.)
  //
  // ★ 2026-11-11: result / inner / fields 三个缓冲**一起放大** ——
  //   以前 fields 只有 384 字节, 而「ESP32 独有 op」那条分支是**整段**把
  //   result 摊进去的. result 一旦超过 384 就被截断 → 回包变成
  //   `{"ok":true,{"name":"pianoflow"...` 这种**非法 JSON** → 前端
  //   JSON.parse 抛异常 → 回包被丢 → 前端只能等超时.
  //   现在三个缓冲都按「一个 result 能装下的最大尺寸」来 (640 = BLE_TX_MAX+128,
  //   跟 ble_led.cpp 的 g_execResp 一样大), 摊平后原样装得下.
  static char id[32], ok[16], err[256], result[BLE_TX_MAX + 128];
  id[0] = ok[0] = err[0] = result[0] = '\0';
  copyRawValue(in, "id", id, sizeof(id));
  copyRawValue(in, "ok", ok, sizeof(ok));
  copyRawValue(in, "error", err, sizeof(err));
  bool hasResult = copyRawValue(in, "result", result, sizeof(result));

  // result 摊平成 "k":v,"k":v —— 之后按 key 取.
  static char inner[BLE_TX_MAX + 128];
  inner[0] = '\0';
  if (hasResult && result[0] == '{') {
    size_t rl = strlen(result);
    if (rl >= 2) {
      result[rl - 1] = '\0';
      snprintf(inner, sizeof(inner), "%s", result + 1);
    }
  } else if (hasResult) {
    snprintf(inner, sizeof(inner), "%s", result);
  }

  bool isOk = (ok[0] != 'f');

  // ---- auth: 跟树莓派桥同形 —— 回 {"ok":true,"authed":true} --------------------
  // 树莓派那边 auth 是**桥**在管的 (桥没配 token 时压根不认这个 op, 直接
  // "unknown op: 'auth'"). ESP32 设备内部有个 led.auth handler (不校验 token,
  // 直接回 {"auth":true}) —— 但这里以前**故意**把它改成失败, 好让前端退回
  // 「不带 auth 直接 init」的老路径.
  //
  // ★ 2026-11-10: 改成回 ok. 理由:
  //   1. 树莓派桥**配了 token** 的时候也是回 {"ok":true,...} —— 回 ok 才是
  //      两边**同形**的那一种 (ESP32 之前是不管配没配 token 都回 unknown op);
  //   2. 前端 auth 失败本来就有回退路径 (catch → 跳过 auth 直接 init), 改成
  //      ok 只是少一次重试, 不会破坏任何兼容.
  // ★ P1 的校验点还在这儿: 固件加上 token 之后, 把这里改成真比较 args.token.
  if (strcmp(op, "auth") == 0) {
    isOk = true;
    err[0] = '\0';
  }

  // 设备不认识的 op → 它的错误就是 "unknown op"; 树莓派那边带 op 名.
  if (!isOk && strcmp(err, "\"unknown op\"") == 0) {
    snprintf(err, sizeof(err), "\"unknown op: '%s'\"", op);
  }

  // 摊平后的字段串 —— 容量跟 result 一样大, 保证「整段摊平」那步不会截断.
  static char fields[BLE_TX_MAX + 128];
  fields[0] = '\0';
  static char v[64];
  v[0] = '\0';

  if (isOk) {
    if (strcmp(op, "init") == 0) {
      if (copyRawValue(inner, "count", v, sizeof(v))) addField(fields, sizeof(fields), "count", v);
      if (copyRawValue(inner, "physical", v, sizeof(v))) addField(fields, sizeof(fields), "physical", v);
      if (copyRawValue(inner, "pin", v, sizeof(v))) addField(fields, sizeof(fields), "pin", v);
    } else if (strcmp(op, "set_many") == 0) {
      if (copyRawValue(inner, "set", v, sizeof(v))) addField(fields, sizeof(fields), "set", v);
    } else if (strcmp(op, "show") == 0) {
      if (copyRawValue(inner, "flushed", v, sizeof(v))) addField(fields, sizeof(fields), "flushed", v);
    } else if (strcmp(op, "ping") == 0) {
      addField(fields, sizeof(fields), "pong", "true");
    } else if (strcmp(op, "auth") == 0) {
      addField(fields, sizeof(fields), "authed", "true");
    } else if (strcmp(op, "set") == 0 || strcmp(op, "off") == 0) {
      // 树莓派那边 set / off 的回包**只有 ok** —— 没有别的字段.
    } else if (strcmp(op, "status") == 0) {
      if (copyRawValue(inner, "ready", v, sizeof(v))) addField(fields, sizeof(fields), "ready", v);
      if (copyRawValue(inner, "count", v, sizeof(v))) addField(fields, sizeof(fields), "count", v);
      if (copyRawValue(inner, "physical", v, sizeof(v))) addField(fields, sizeof(fields), "physical", v);
      if (copyRawValue(inner, "pin", v, sizeof(v))) addField(fields, sizeof(fields), "pin", v);
      if (copyRawValue(inner, "sets_pending", v, sizeof(v))) addField(fields, sizeof(fields), "sets_pending", v);
      // 内存余量 —— 「跑一阵就掉线 / 连着但不应答」先看它.
      if (copyRawValue(inner, "heap", v, sizeof(v))) addField(fields, sizeof(fields), "heap", v);
      if (copyRawValue(inner, "last_show_age_s", v, sizeof(v))) {
        // 一次都没 show 过 → 树莓派那边报 null (那边 _last_show 初值是 0).
        if (strcmp(v, "-1.000") == 0) snprintf(v, sizeof(v), "null");
        addField(fields, sizeof(fields), "last_show_age_s", v);
      }
    } else {
      // 不在树莓派那张表里的 op → 整个 result 摊平回去 (ESP32 的超集).
      size_t used = strlen(fields);
      if (*inner && used + 1 < sizeof(fields)) {
        snprintf(fields + used, sizeof(fields) - used, "%s", inner);
      }
    }
  }

  size_t used = 0;
  used = appendStr(out, outLen, used, "{\"ok\":%s", isOk ? "true" : "false");
  if (!isOk && err[0]) used = appendStr(out, outLen, used, ",\"error\":%s", err);
  if (*fields) used = appendStr(out, outLen, used, ",%s", fields);
  if (id[0]) used = appendStr(out, outLen, used, ",\"id\":%s", id);
  used = appendStr(out, outLen, used, "}");
  return used;
}

/** 执行一条命令并把回包发回去. */
static void execAndReply(uint8_t num, const char* line, int len) {
  char op[64];
  requestOp(line, len, op, sizeof(op));

  // ★ static: 同上 —— loopTask 的栈只有 8KB, 这两块 buffer 有 1.4KB.
  static char resp[BLE_TX_MAX + 128];
  size_t n = ledExecLine(line, len, resp, sizeof(resp));
  if (n == 0) return;
  // 客户端可能刚好断了 —— 发不出去就算了, 不能因此卡住.
  if (!g_ws.clientIsConnected(num)) return;
  // 对外用树莓派的扁平格式 (WS 这一路是顶替树莓派的桥).
  // 容量 = 摊平后的 fields (640) + 外壳 ({"ok":true, + ,"id":N + }) —— 留够余量.
  static char flat[BLE_TX_MAX + 384];
  size_t fn = piReply(flat, sizeof(flat), op, resp);
  g_ws.sendTXT(num, flat, fn);
}

static void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      g_msgLen[num < WEBSOCKETS_SERVER_CLIENT_MAX ? num : 0] = 0;
      Serial.printf("[ws] 客户端 %u 连上\n", num);
      break;

    case WStype_DISCONNECTED:
      g_msgLen[num < WEBSOCKETS_SERVER_CLIENT_MAX ? num : 0] = 0;
      Serial.printf("[ws] 客户端 %u 断开\n", num);
      break;

    case WStype_TEXT:
      // 完整一条命令 (浏览器不会分片).
      execAndReply(num, (const char*)payload, (int)length);
      break;

    case WStype_FRAGMENT_TEXT_START:
      g_msgLen[num < WEBSOCKETS_SERVER_CLIENT_MAX ? num : 0] = 0;
      appendFragment(num, payload, length);
      break;

    case WStype_FRAGMENT:
      appendFragment(num, payload, length);
      break;

    case WStype_FRAGMENT_FIN:
      if (appendFragment(num, payload, length)) {
        execAndReply(num, g_msg[num < WEBSOCKETS_SERVER_CLIENT_MAX ? num : 0],
                     g_msgLen[num < WEBSOCKETS_SERVER_CLIENT_MAX ? num : 0]);
      }
      g_msgLen[num < WEBSOCKETS_SERVER_CLIENT_MAX ? num : 0] = 0;
      break;

    default:
      break;
  }
}

void wsLedSetup() {
  g_ws.onEvent(onWsEvent);
  g_ws.begin();
  Serial.printf("[ws] WebSocket server 起在 %d 端口\n", (int)LED_WS_PORT);
}

void wsLedLoop() {
  g_ws.loop();
}

int wsLedClientCount() {
  return g_ws.connectedClients();
}

#endif  // LED_WS_ENABLE
