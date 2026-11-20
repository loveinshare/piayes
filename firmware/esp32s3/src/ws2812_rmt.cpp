#include "ws2812_rmt.h"

#include <Arduino.h>
#include <esp_cpu.h>
#include <string.h>

#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"

// 10MHz 分辨率: 1 tick = 0.1µs
static const uint32_t RMT_RES_HZ = 10 * 1000 * 1000;
/** 默认开 DMA —— 整帧由 DMA 连续搬, 不依赖 encoder 的 CPU 重填. */
#ifndef LED_RMT_DMA
#define LED_RMT_DMA 1
#endif
// WS2812 时序 (tick). 一个 symbol = 一个 bit 周期 (高半截 + 低半截).
static const uint16_t T0H = 4, T0L = 8;
static const uint16_t T1H = 8, T1L = 4;
// 发完之后保持低电平 300µs —— WS2811 靠 >50µs 的低电平锁存.
static const uint16_t RESET_US = 300;

bool Ws2812Rmt::begin(int pin, int count) {
  if (count <= 0) return false;
  pin_ = pin;

  // ★ 换灯数 (双色带 176 → 352) 会再调一次 begin() —— 旧的通道/编码器
  //   必须先释放, 否则每切一次模式就泄漏一份 RMT 通道.
  if (ready_) {
    rmt_disable((rmt_channel_handle_t)chan_);
    if (encoder_) rmt_del_encoder((rmt_encoder_handle_t)encoder_);
    if (chan_) rmt_del_channel((rmt_channel_handle_t)chan_);
    encoder_ = nullptr;
    chan_ = nullptr;
    ready_ = false;
  }
  // ⚠️ 分配顺序很重要: **先分配新的像素缓冲, 成功后再释放旧的**. 反过来的话,
  //   一旦 malloc 失败, 旧缓冲已经没了 —— 灯带就永久熄了, 但上层还以为是好的.
  uint8_t* buf = (uint8_t*)malloc((size_t)count * 3);
  if (!buf) return false;
  memset(buf, 0, (size_t)count * 3);
  if (pixels_) free(pixels_);
  pixels_ = buf;
  count_ = count;

  // ★ 用 IDF 的 bytes encoder 直接吃像素字节 —— 不再自己预编码整帧.
  //
  // 为什么 (2026-11-11 真机掉线事故): 第一版把 352 颗 × 24 bit 预编码成
  // 8449 个 rmt_symbol_word_t (33.8KB 堆) + 8KB 查表. 启动时没事, 但
  // 把 free heap 压到 **7.8KB** —— lwIP 一旦要分配 ARP/DHCP/TCP 缓冲就失败,
  // 于是 WiFi.status() 还报 connected, 板子却从网络上消失 (PC ping 全丢).
  //
  // bytes encoder 的 bit0/bit1 模板正好就是「一个 bit 的高/低两段」:
  //   bit0 = 高 4 tick + 低 8 tick, bit1 = 高 8 tick + 低 4 tick, MSB first.
  // 每个字节由驱动展开成 8 个 symbol, 负载就是 pixels_ (352×3 = 1056B).
  rmt_bytes_encoder_config_t encCfg = {};
  encCfg.bit0.level0 = 1;
  encCfg.bit0.duration0 = T0H;
  encCfg.bit0.level1 = 0;
  encCfg.bit0.duration1 = T0L;
  encCfg.bit1.level0 = 1;
  encCfg.bit1.duration0 = T1H;
  encCfg.bit1.level1 = 0;
  encCfg.bit1.duration1 = T1L;
  encCfg.flags.msb_first = 1;

  rmt_tx_channel_config_t cfg = {};
  cfg.gpio_num = (gpio_num_t)pin;
  cfg.clk_src = RMT_CLK_SRC_DEFAULT;
  cfg.resolution_hz = RMT_RES_HZ;
  // 64 个符号 = 128 bit ≈ 160µs 的硬件缓冲 —— 中断晚到也不会断流.
  cfg.mem_block_symbols = 64;
  cfg.trans_queue_depth = 1;
#if LED_RMT_DMA
  cfg.flags.with_dma = 1;
#endif
  rmt_channel_handle_t chan = nullptr;
  if (rmt_new_tx_channel(&cfg, &chan) != ESP_OK) {
    Serial.println(F("[rmt] new_tx_channel failed"));
    return false;
  }

  rmt_encoder_handle_t encoder = nullptr;
  if (rmt_new_bytes_encoder(&encCfg, &encoder) != ESP_OK) {
    Serial.println(F("[rmt] new_bytes_encoder failed"));
    rmt_del_channel(chan);
    return false;
  }

  if (rmt_enable(chan) != ESP_OK) {
    Serial.println(F("[rmt] enable failed"));
    rmt_del_encoder(encoder);
    rmt_del_channel(chan);
    return false;
  }

  chan_ = chan;
  encoder_ = encoder;
  ready_ = true;
  return true;
}

uint8_t Ws2812Rmt::scale(uint8_t v) const {
  return (uint8_t)((v * (uint16_t)brightness_) / 255);
}

void Ws2812Rmt::setPixel(int index, uint8_t r, uint8_t g, uint8_t b) {
  if (!pixels_ || index < 0 || index >= count_) return;
  pixels_[index * 3 + 0] = scale(g);
  pixels_[index * 3 + 1] = scale(r);
  pixels_[index * 3 + 2] = scale(b);
}

void Ws2812Rmt::setAll(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < count_; i++) setPixel(i, r, g, b);
}

void Ws2812Rmt::clear() {
  if (pixels_) memset(pixels_, 0, (size_t)count_ * 3);
}

void Ws2812Rmt::getPixel(int index, uint8_t* r, uint8_t* g, uint8_t* b) const {
  if (!pixels_ || index < 0 || index >= count_) {
    if (r) *r = 0;
    if (g) *g = 0;
    if (b) *b = 0;
    return;
  }
  if (g) *g = pixels_[index * 3 + 0];
  if (r) *r = pixels_[index * 3 + 1];
  if (b) *b = pixels_[index * 3 + 2];
}

int Ws2812Rmt::litCount() const {
  if (!pixels_) return 0;
  int lit = 0;
  for (int i = 0; i < count_; i++) {
    const uint8_t* px = pixels_ + (size_t)i * 3;
    if (px[0] || px[1] || px[2]) lit++;
  }
  return lit;
}

/**
 * ★ 功耗上限 —— 见 led_limits.h. 超过上限就把下标大的那些灭掉.
 * show() 第一件事就是调它 —— 所有点灯路径 (串口 / BLE set_many / 跑马灯)
 * 都过这里, 谁都点不亮超过 LED_MAX_LIT 颗.
 */
int Ws2812Rmt::applyMaxLit() {
  int lit = litCount();
  // LED_MAX_LIT == 0 → 不限 (跟树莓派端 led_remote.py 一致, 见 led_limits.h).
  if (LED_MAX_LIT <= 0) return lit;
  if (lit <= LED_MAX_LIT) return lit;
  for (int i = count_ - 1; i >= 0 && lit > LED_MAX_LIT; i--) {
    uint8_t* px = pixels_ + (size_t)i * 3;
    if (px[0] || px[1] || px[2]) {
      px[0] = 0;
      px[1] = 0;
      px[2] = 0;
      lit--;
    }
  }
  return lit;
}

void Ws2812Rmt::show() {
  if (!ready_ || !pixels_) return;
  applyMaxLit();  // ★ 功耗上限: 最多同时点亮 LED_MAX_LIT 颗 (所有点灯路径的唯一入口)
  if (transmitBytes(pixels_, (size_t)count_ * 3)) {
    // 最后一个 bit 之后线已经回到低电平; 再保持 300µs 让整条链锁存.
    delayMicroseconds(RESET_US);
  }
}

/** 用 bytes encoder 把一段 GRB 字节流发出去并等发完. */
bool Ws2812Rmt::transmitBytes(const uint8_t* data, size_t len) {
  if (!ready_ || !chan_ || !encoder_ || !data || len == 0) return false;
  rmt_transmit_config_t tx = {};
  tx.loop_count = 0;
  esp_err_t err = rmt_transmit((rmt_channel_handle_t)chan_, (rmt_encoder_handle_t)encoder_,
                               data, len, &tx);
  if (err != ESP_OK) {
    // 上层每帧都会调用, 连续失败会在串口里看到.
    static uint32_t lastLog = 0;
    if (millis() - lastLog > 1000) {
      lastLog = millis();
      Serial.printf("[rmt] transmit failed: %d\n", (int)err);
    }
    // ★ 不复位的话驱动里的在途描述符不释放, 而 trans_queue_depth = 1 →
    //   下一次 rmt_transmit() 直接 ESP_ERR_NO_MEM → 从此每一帧都失败.
    resetChannel();
    return false;
  }
  // 等这一帧真正发完 —— DMA/encoder 还在读 data, 下一帧改写像素前必须等.
  err = rmt_tx_wait_all_done((rmt_channel_handle_t)chan_, 1000);
  if (err != ESP_OK) {
    static uint32_t lastLog = 0;
    if (millis() - lastLog > 1000) {
      lastLog = millis();
      Serial.printf("[rmt] wait_all_done failed: %d\n", (int)err);
    }
    resetChannel();
    return false;
  }
  return true;
}

/**
 * 把 RMT 通道复位 (关 → 开) —— 强制 driver 和 encoder 的状态归零.
 *
 * 用在两个地方: rmt_transmit() 失败之后, 和 rmt_tx_wait_all_done() 超时之后.
 *
 * ⚠️ API 名字别写错: **IDF 5.5 没有 `rmt_channel_reset()` / `rmt_channel_enable()` /
 *   `rmt_channel_disable()`** —— 通道级的开关就叫 `rmt_enable()` / `rmt_disable()`
 *   (在 `driver/rmt_common.h` 里).
 */
void Ws2812Rmt::resetChannel() {
  if (!chan_) return;
  rmt_disable((rmt_channel_handle_t)chan_);
  rmt_enable((rmt_channel_handle_t)chan_);
  if (encoder_) rmt_encoder_reset((rmt_encoder_handle_t)encoder_);
}

// ── 波形回读 (RMT RX 回环) ────────────────────────────────────────────────
//
// 见头文件里的说明. 只抓 2 颗灯 = 48 个 symbol, 用 80MHz 分辨率回读:
//   期望: 0 的高电平 = 4 tick@10MHz = 32 tick@80MHz
//         1 的高电平 = 8 tick@10MHz = 64 tick@80MHz
// 硬件生成的波形应该是**每个 bit 都精确相等** (没有任何抖动).
#include "driver/rmt_rx.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace {
constexpr size_t kRmtWaveSymbols = 48;
volatile SemaphoreHandle_t g_rmtWaveDone = nullptr;
volatile size_t g_rmtWaveNum = 0;

bool IRAM_ATTR rmtWaveDone(rmt_channel_handle_t, const rmt_rx_done_event_data_t* ev,
                           void*) {
  g_rmtWaveNum = ev->num_symbols;
  BaseType_t hp = pdFALSE;
  if (g_rmtWaveDone) xSemaphoreGiveFromISR((SemaphoreHandle_t)g_rmtWaveDone, &hp);
  return hp == pdTRUE;
}
}  // namespace

void Ws2812Rmt::waveProbe() {
  if (!ready_) {
    Serial.println(F("[rmt-wave] 驱动还没就绪"));
    return;
  }
  if (!g_rmtWaveDone) g_rmtWaveDone = xSemaphoreCreateBinary();
  if (!g_rmtWaveDone) {
    Serial.println(F("[rmt-wave] 信号量创建失败"));
    return;
  }
  static rmt_symbol_word_t rxBuf[kRmtWaveSymbols];
  rmt_channel_handle_t rx = nullptr;
  rmt_rx_channel_config_t rxCfg = {};
  rxCfg.gpio_num = (gpio_num_t)pin_;
  rxCfg.clk_src = RMT_CLK_SRC_DEFAULT;
  rxCfg.resolution_hz = 80 * 1000 * 1000;
  rxCfg.mem_block_symbols = kRmtWaveSymbols;
  esp_err_t err = rmt_new_rx_channel(&rxCfg, &rx);
  if (err != ESP_OK) {
    Serial.printf("[rmt-wave] new_rx_channel 失败: %d (可能没有空闲 RX 通道)\n", (int)err);
    return;
  }
  rmt_rx_event_callbacks_t cbs = {};
  cbs.on_recv_done = rmtWaveDone;
  rmt_rx_register_event_callbacks(rx, &cbs, nullptr);
  rmt_enable(rx);
  rmt_receive_config_t rcv = {};
  rcv.signal_range_min_ns = 80;
  rcv.signal_range_max_ns = 100000;

  // 2 颗灯, 0xAA / 0x55 交替 —— 0/1 交替最能检查两种 bit 的编码.
  static const uint8_t pat[6] = {0xAA, 0xAA, 0xAA, 0x55, 0x55, 0x55};

  xSemaphoreTake((SemaphoreHandle_t)g_rmtWaveDone, 0);
  err = rmt_receive(rx, rxBuf, sizeof(rxBuf), &rcv);
  if (err != ESP_OK) {
    Serial.printf("[rmt-wave] receive 失败: %d\n", (int)err);
    rmt_disable(rx);
    rmt_del_channel(rx);
    return;
  }
  bool txOk = transmitBytes(pat, sizeof(pat));
  bool rxOk = xSemaphoreTake((SemaphoreHandle_t)g_rmtWaveDone, pdMS_TO_TICKS(100)) == pdTRUE;

  uint32_t h0min = 0xFFFFFFFF, h0max = 0, h1min = 0xFFFFFFFF, h1max = 0;
  uint32_t l0min = 0xFFFFFFFF, l0max = 0, l1min = 0xFFFFFFFF, l1max = 0;
  uint32_t hbad = 0, maxGap = 0;
  size_t got = rxOk ? g_rmtWaveNum : 0;
  if (got > kRmtWaveSymbols) got = kRmtWaveSymbols;
  for (size_t s = 0; s < got && s < 48; s++) {
    const uint8_t byte = pat[s / 8];
    const uint32_t one = (byte >> (7 - (s % 8))) & 1u;
    uint32_t hi = rxBuf[s].level0 ? rxBuf[s].duration0 : rxBuf[s].duration1;
    uint32_t lo = rxBuf[s].level0 ? rxBuf[s].duration1 : rxBuf[s].duration0;
    if (lo > maxGap) maxGap = lo;
    if (one) {
      if (hi < h1min) h1min = hi;
      if (hi > h1max) h1max = hi;
      if (hi != 64) hbad++;
      if (lo < l1min) l1min = lo;
      if (lo > l1max) l1max = lo;
    } else {
      if (hi < h0min) h0min = hi;
      if (hi > h0max) h0max = hi;
      if (hi != 32) hbad++;
      if (lo < l0min) l0min = lo;
      if (lo > l0max) l0max = lo;
    }
  }

  Serial.printf("[rmt-wave] tx=%s rx=%s 抓到 %u/%u symbol\n",
                txOk ? "ok" : "FAIL", rxOk ? "ok" : "FAIL", (unsigned)got,
                (unsigned)kRmtWaveSymbols);
  Serial.printf("[rmt-wave] 0高 %lu..%lu (期望 32)  1高 %lu..%lu (期望 64)  偏差=%lu\n",
                (unsigned long)(h0min == 0xFFFFFFFF ? 0 : h0min), (unsigned long)h0max,
                (unsigned long)(h1min == 0xFFFFFFFF ? 0 : h1min), (unsigned long)h1max,
                (unsigned long)hbad);
  Serial.printf("[rmt-wave] 0低 %lu..%lu  1低 %lu..%lu  最长低=%lu tick\n",
                (unsigned long)(l0min == 0xFFFFFFFF ? 0 : l0min), (unsigned long)l0max,
                (unsigned long)(l1min == 0xFFFFFFFF ? 0 : l1min), (unsigned long)l1max,
                (unsigned long)maxGap);

  rmt_disable(rx);
  rmt_del_channel(rx);
}
