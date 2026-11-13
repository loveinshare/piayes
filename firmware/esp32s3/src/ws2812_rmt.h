// WS2812 灯带驱动 —— RMT 硬件后端 (ESP32-S3, Arduino-ESP32 3.x / ESP-IDF 5.x)
//
// ★ 默认驱动. 波形由 RMT 外设按 10MHz tick 产生, WiFi/BT 中断完全不参与.
//
// 为什么不用 bit-bang (2026-11-11 真机定案):
//   `portENTER_CRITICAL()` 只把本核中断抬到 level 3, 挡不住 level 4+ 的
//   WiFi/BT 控制器中断. 用 RMT RX 回环抓波形实测: 有无线时 0 bit 的高电平
//   被拉到 234 tick (2.9µs, 正常 32) → WS2811 读成 1 → 灯带乱闪/随机亮.
//   RMT 硬件生成则每个 bit 都精确 32/64 tick.
//
// ★ 内存 (2026-11-11 第二版, 修「连一会儿就掉线」):
//   第一版把 352 颗的整帧 symbol 预编码进 33.8KB 堆缓冲 + 8KB 查表 ——
//   真机上 free heap 被压到 **7.8KB**, lwIP 分配不出 ARP/DHCP 缓冲,
//   表现是「WiFi.status() 报 connected, 但 PC 完全 ping 不通」.
//   现在改用 IDF 自带的 **bytes encoder**:
//     * 每个 byte 由驱动直接展开成 8 个 symbol (bit0/bit1 模板, MSB first);
//     * 传的负载就是 pixels_ (352×3 = 1056B), **不需要整帧 symbol 缓冲**;
//     * 不查表、不预编码, 省下 33.8KB + 8KB.
//
// 编码: 10MHz 分辨率 (1 tick = 0.1µs), GRB, 24bit/颗.
//   T0H=4 (0.4µs) T0L=8 (0.8µs) / T1H=8 (0.8µs) T1L=4 (0.4µs)
//   复位: 发完让线保持低电平 300µs (>50µs 要求).
#ifndef WS2812_RMT_H
#define WS2812_RMT_H

#include <stddef.h>
#include <stdint.h>

#include "led_limits.h"  // LED_MAX_LIT —— 同时点亮的颗数上限 (写死)

class Ws2812Rmt {
 public:
  bool begin(int pin, int count);
  void setPixel(int index, uint8_t r, uint8_t g, uint8_t b);
  void setAll(uint8_t r, uint8_t g, uint8_t b);
  void clear();
  void setBrightness(uint8_t b) { brightness_ = b; }
  void show();
  int count() const { return count_; }
  /** 回读像素缓冲 (r/g/b 已还原成发送前的颜色) —— 调试/自检用. */
  void getPixel(int index, uint8_t* r, uint8_t* g, uint8_t* b) const;
  /** 当前缓冲里「点亮」的颗数 (诊断用). */
  int litCount() const;
  /**
   * 对缓冲执行功耗上限 (超过 LED_MAX_LIT 颗就把下标大的灭掉), 返回剩下的颗数.
   * LED_MAX_LIT == 0 → 不限 (默认, 跟树莓派一致).
   * show() 内部会调它; 诊断命令也可以单独调 (**不点灯**, 零电流).
   */
  int applyMaxLit();
  /**
   * ★ 波形回读 (诊断用): 用 RMT RX 在同一根 GPIO 上把发出去的波形抓回来,
   * 验证编码真的落到了线上 (0 高 = 32 tick, 1 高 = 64 tick @80MHz).
   *
   * RMT 是硬件生成波形, 不依赖中断 —— 这个诊断用来证明「换到 RMT 之后,
   * 之前 bit-bang 被 WiFi/BT 中断拉长的 bit 消失了」.
   */
  void waveProbe();

 private:
  uint8_t scale(uint8_t v) const;
  /** 把 RMT 通道复位 (关→清→开) —— transmit 失败 / wait 超时后调用. */
  void resetChannel();
  /** 用 bytes encoder 把一段 GRB 字节流发出去并等发完. 返回是否成功. */
  bool transmitBytes(const uint8_t* data, size_t len);

  int pin_ = -1;
  int count_ = 0;
  uint8_t brightness_ = 255;
  uint8_t* pixels_ = nullptr;  // GRB
  void* chan_ = nullptr;       // rmt_channel_handle_t
  void* encoder_ = nullptr;    // rmt_encoder_handle_t (bytes encoder)
  bool ready_ = false;
};

#endif  // WS2812_RMT_H
