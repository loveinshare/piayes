// WS2811/WS2812 灯带驱动 —— 纯软件 bit-banging (GPIO 直翻)。
//
// 为什么需要这个:
//   ESP32-S3 的 RMT 外设每 channel 只有 48 words (SOC_RMT_MEM_WORDS_PER_CHANNEL),
//   放不下 352 颗灯 (8448 bit); DMA 模式虽然能开到 2047 symbols, 但实测
//   rmt_tx_wait_all_done 一直 "flush timeout" —— 数据没被硬件消费。
//   既然硬件外设这条路在 S3 上不通, 直接用 CPU 精确计时翻 GPIO。
//
// 时序 (WS2811 @ 800kHz):
//   一个 bit 周期 = 1.25us = 30 个 CPU 周期 (240MHz)
//     0 -> 高 0.4us (~10 cycles) + 低 0.8us (~20 cycles)
//     1 -> 高 0.8us (~20 cycles) + 低 0.4us (~10 cycles)
//
// 用 esp_cpu_set_cycle_count() 精确控制, 不受编译器优化影响。
// 代价: 传输期间占满 CPU —— 352 颗 (物理) = 8448 bit × 1.25us ≈ 10.6ms。
// 对于"跟着乐谱亮灯"这种场景完全够用 (前端 rAF 也是 60fps = 16ms/帧)。
#ifndef WS2811_BITBANG_H
#define WS2811_BITBANG_H

#include <stdint.h>

#include "led_limits.h"  // LED_MAX_LIT —— 同时点亮的颗数上限 (写死)

class Ws2811Bitbang {
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
   * 自测: 量出 bit-bang 的真实时序 (诊断用, 实现见 ws2811_bitbang.cpp).
   * out[0]=一次 cycle 读的成本 out[1]=esp_cpu_get_cycle_count() 的读成本
   * out[2]=实测 T0H (线上高电平宽度) out[3]=实测 T1H
   * out[4]=rdcycle 与 esp_cpu_get_cycle_count() 的差 (0 = 同一时基).
   * out[5]=旧方案(计数器轮询)的轮询间隔 out[6]=延时循环 cycles/次
   * out[7]=线上 bit 周期 (全 0 bit) out[8]=线上 bit 周期 (全 1 bit)
   * out[9]=延时循环固定开销 out[10..13]=高0/低0/高1/低1 的迭代数.
   */
  void selfTest(uint32_t* out);
  /**
   * 延时原语的**原始测量表** —— 直接打印 span(delay_ticks(n)) 对 n 的曲线.
   * 校准出问题时先跑这个: 曲线应该是**直线** (斜率 = perIter, 截距 = 固定开销).
   * 曲线不直 / 截距离谱 → 延时原语本身有问题 (不是标定公式的问题).
   */
  void delayProbe();
  /** 重新标定延时 (诊断用) —— 开机标定一次后可以随时再标一次, 对比结果. */
  void recalibrate();
  /**
   * ★ 波形回读 (诊断用): 用 RMT RX 在同一个 GPIO 上把**自己发出去的波形**
   * 抓回来, 逐个 bit 量高/低电平宽度, 统计抖动和长低电平 (被中断打断).
   *
   * 为什么需要它: `selfTest()`/`[calib]` 只量「全 0」「全 1」两种图案 ——
   * 那两种图案走的是**固定**的代码路径, 量出来当然漂亮. 真实数据 0/1 混排,
   * 如果逐 bit 的代码有**依赖数据的分支** (或发送期间被 ISR 打断), 全 0/全 1
   * 的标定**完全看不出来**, 但灯带上就是「乱闪 / 随机灯亮」.
   *
   * 输出: 每种图案的 0/1 高电平、低电平 min/max (RMT tick, 80MHz = 12.5ns),
   * 偏差超过 0.15µs 的 bit 数, 以及最长的低电平 (被 ISR 拉长会远大于 1.25µs).
   */
  void waveProbe();

 private:
  uint8_t scale(uint8_t v) const;

  int pin_ = -1;
  int count_ = 0;
  uint8_t brightness_ = 255;
  uint8_t* pixels_ = nullptr;  // GRB 排列
};

#endif  // WS2811_BITBANG_H
