#include "ws2811_bitbang.h"

#include <Arduino.h>
#include <esp_cpu.h>
#include <string.h>

// CPU 频率 (ESP32-S3 = 240MHz)
static const uint32_t CPU_HZ = 240000000;
// 一个 bit 周期 1.25us
static const uint32_t CYCLES_PER_BIT = CPU_HZ / 800000;  // = 300
// 高电平时长: 0 -> 0.4us, 1 -> 0.8us
static const uint32_t CYCLES_HIGH_0 = CPU_HZ * 4 / 10000000;  // 96 (0.4us)
static const uint32_t CYCLES_HIGH_1 = CPU_HZ * 8 / 10000000;  // 192 (0.8us)

// ★ 2026-10-29: 时序改用**校准过的延时循环**, 不用 cycle 计数器.
//
// 为什么不能用计数器等:
//   ESP32-S3 上 cycle 计数器**一次读取要 ~26~37 cycles** (rsr.ccount 的延迟),
//   内层 wait 循环的**轮询间隔实测 74~96 cycles** (0.3~0.4us) —— 分辨率太粗.
//   WS2812 的 T0H 只有 ±0.15us 的余量 (0.4us ±0.15 → 上限 132 cycles),
//   用计数器等出来的实测值是 T0H=136 / T1H=254 —— **两个都超标**
//   (T0H 0.567us > 0.55us, T1H 1.06us > 0.95us):
//     * T0H 超标 → 芯片把 0 读成 1 → 颜色乱 / 灯带「闪烁」
//     * 周期被拉长到 354~390 cycles (1.48~1.62us, 规格 1.1~1.4us)
//       → 一趟设备侧跑马灯 717ms 而不是设计的 500ms
//
// 改法: 用一个**每次迭代固定开销**的空转循环数次数:
//   delay_ticks(n) 耗时 = overhead + n * perIter
// perIter / overhead 在 begin() 里实测一次 (两个不同 n 相减, 消掉固定开销).
// 分辨率 = perIter (实测 ~4 cycles = 0.017us) —— 够用了.
//
// ★ diag6 会实测 T0H/T1H/bit 周期 —— 改完固件先看这三个数, 别凭猜.
//
// ⚠️ cycle_now() **只用来测量**, 不用来等时间 —— 等时间用 delay_ticks().
static inline uint32_t cycle_now() {
  return (uint32_t)esp_cpu_get_cycle_count();
}

// 低电平时长 = 周期 - 高电平
static const uint32_t CYCLES_LOW_0 = CYCLES_PER_BIT - CYCLES_HIGH_0;
static const uint32_t CYCLES_LOW_1 = CYCLES_PER_BIT - CYCLES_HIGH_1;

// show() / 校准 共用的临界区 (见下面 show() 里「为什么必须关中断」的说明).
static portMUX_TYPE g_showMux = portMUX_INITIALIZER_UNLOCKED;

// ── 校准过的延时 ────────────────────────────────────────────────────────
// noinline: 保证**只有一份** delay_ticks 的代码 —— 校准和应用必须是同一份,
// 否则校准出来的 perIter 跟实际跑的不是一个数.
static __attribute__((noinline)) void delay_ticks(uint32_t n) {
  if (n == 0) return;  // 循环是「减到 0 为止」, n=0 会绕 2^32 圈
  // 手写的延时循环: 每次迭代**固定 4 cycles** (addi + nop + bnez + 延迟槽 nop).
  //
  // 为什么不用 C 循环: 循环体里放 volatile asm 时, GCC 会把计数器 i 溢出到
  // 栈上 (存/取/加/比/跳 = 13 cycles/次); 写成 "+r"(i) 也一样 —— GCC 以为
  // asm 改了 i, 必须把 i 存回内存. 手写 asm 是唯一能把迭代次数和指令数
  // 完全钉死的方式.
  __asm__ volatile(
      "1:\n\t"
      "addi %0, %0, -1\n\t"
      "nop\n\t"
      "bnez %0, 1b\n\t"
      "nop\n\t"  // bnez 的延迟槽
      : "+r"(n));
}

// ── 标定结果 ────────────────────────────────────────────────────────────
// s_slopeFP: 每迭代的 cycles, **定点** (低 8 位是小数) —— 整数除法一截断就全废
//            (见下面 calibrateTiming 的注释).
// s_fixed:   延时的固定开销 cycles (函数调用 + 序言 + 返回).
// s_empty:   一次「读计数器」的成本 (测量本身的成本, 要从实测值里扣掉).
static uint32_t s_slopeFP = 0;
static uint32_t s_fixed = 0;
static uint32_t s_empty = 0;
static uint32_t s_perIter = 0;   // s_slopeFP 的整数部分 (只用于显示)
static uint32_t s_overhead = 0;  // s_fixed 的别名 (只用于显示)
static uint32_t s_nHigh0 = 0;    // 0 bit 的高电平迭代数
static uint32_t s_nLow0 = 0;     // 0 bit 的低电平迭代数
static uint32_t s_nHigh1 = 0;
static uint32_t s_nLow1 = 0;

// GPIO 寄存器 (按 pin 算端口号).
//
// ★ 2026-11-11 修正: 以前是 `GPIO_OUT_W1TS_REG + (pin >> 5) * 4` —— 那是
//   **经典 ESP32** 的排布假设, 在 ESP32-S3 上是错的.
//
// S3 的实际布局 (IDF v5.5.1 components/soc/esp32s3/register/soc/gpio_reg.h):
//     out        = base + 0x04
//     out_w1ts   = base + 0x08     ← GPIO0..31
//     out_w1tc   = base + 0x0C
//     out1       = base + 0x10     ← 独立的 22-bit 字段 (GPIO32..53)
//     out1_w1ts  = base + 0x14
//     out1_w1tc  = base + 0x18
//
// pin ≥ 32 时, 老的写法算出 outSet = 0x0C (out_w1tc!) / outClr = 0x10 (out1!) ——
//   **置位和清位写到了两个不相干的寄存器**, 行为完全错乱.
//   IDF 自己的 LL 层 (hal/esp32s3/include/hal/gpio_ll.h) 就是分两段的:
//     if (gpio_num < 32) hw->out_w1ts = 1 << gpio_num;
//     else                hw->out1_w1ts.val = 1 << (gpio_num - 32);
//
// 当前 LED_PIN = 14 (bank 0) → 老写法碰巧是对的, 所以一直没暴露.
// 改引脚到 ≥ 32 之前必须先修这个.
static inline volatile uint32_t* outSetPtr(int pin) {
  if (pin >= 32) return (volatile uint32_t*)GPIO_OUT1_W1TS_REG;
  return (volatile uint32_t*)GPIO_OUT_W1TS_REG;
}
static inline volatile uint32_t* outClrPtr(int pin) {
  if (pin >= 32) return (volatile uint32_t*)GPIO_OUT1_W1TC_REG;
  return (volatile uint32_t*)GPIO_OUT_W1TC_REG;
}
/** 该 pin 在它那个 bank 里的位掩码 (bank 0 = GPIO0..31, bank 1 = GPIO32..53). */
static inline uint32_t outMask(int pin) {
  return 1UL << (pin >= 32 ? pin - 32 : pin);
}

// ── 发一帧 (show() 和标定**共用同一份代码**) ─────────────────────────────
// 为什么必须共用: 线上一个 bit 的周期 = 高电平 + 低电平 + **循环开销**
//   (从 outClr 到下一个 outSet 之间所有指令的时间).
// 标定要减掉这个开销, 而开销**只跟循环代码有关** —— 标定用的循环跟实际发送
// 的循环不一样, 减掉的数就是错的, bit 周期会飘 (实测飘了 30% → 1.7us).
//
// 为什么这么写 (每一条都是为了压掉循环开销):
//   * 四个迭代数**提到局部变量** —— 它们是全局变量的话, 每个 bit 都要
//     l32r + l32i 重新读一遍 (8 条指令/bit).
//   * **不复制**到 bytes[3] 栈数组 —— 直接 px[b] 读, 省掉 3 存 3 取.
//   * ★ 内层循环**必须无分支** —— 见下面「2026-11-11 的回归」.
//
// ★ 2026-11-11 的回归 (第二个根因 —— 让逐 bit 抖动雪上加霜):
//   R31 为了防「标定倒挂时无符号回绕成 2³² 次循环 → 卡死」, 把
//     `nHigh = nH0 + dH * one` (纯算术)
//   改成了
//     `const int32_t dh = one ? dH : 0;
//      const uint32_t nHigh = (dh > 0) ? (nH0 + dh) : nH0;`
//   —— 每个 bit 多出 **3 个依赖数据的条件分支** (dh / dl / nHigh / nLow).
//
//   Xtensa **没有条件传送指令**, `?:` 只能编成分支. 数据的 0/1 是随机的,
//   分支预测必然错; 错一次就把当前这个 bit 的高电平/低电平拉长几个 cycles,
//   而且**高、低两段都会抖**. 标定只用全 0 / 全 1 两种图案 —— 分支方向固定,
//   量出来永远是 300/306, 看着完美; 真实数据一混排, 每个 bit 的宽度都在抖.
//   (但真正的大头还是 WiFi/BT 中断 —— 见 README, 这也是默认换 RMT 的原因.)
//
//   修法: 把「倒挂保护」从**每个 bit** 挪到**标定结束时的归一化**
//   (见 normalizeCalibration()). 归一化之后保证:
//       nH1 >= nH0   (dH = nH1 - nH0 >= 0)
//       nL1 <= nL0   (dL = nL0 - nL1 >= 0)
//   发送循环就退回纯算术 `nH0 + dH*one` / `nL0 - dL*one` —— 没有分支,
//   也没有回绕风险 (dH/dL 都是归一化后的小正数).
static void sendFrame(const uint8_t* pixels, int count, volatile uint32_t* outSet,
                      volatile uint32_t* outClr, uint32_t mask) {
  const uint32_t nH0 = s_nHigh0, nH1 = s_nHigh1;
  const uint32_t nL0 = s_nLow0, nL1 = s_nLow1;
  // 归一化保证这两个差值非负且很小 (见 normalizeCalibration()).
  const uint32_t dH = nH1 - nH0;
  const uint32_t dL = nL0 - nL1;
  const uint8_t* px = pixels;
  for (int i = 0; i < count; i++) {
    for (int b = 0; b < 3; b++) {
      const uint32_t byte = px[b];
      for (int bit = 7; bit >= 0; bit--) {
        // one = 0/1; sel = 0x00000000 / 0xFFFFFFFF (无分支, 不用乘法).
        // Xtensa 的 `neg` + `and` 都是定长指令, 不依赖数据.
        const uint32_t one = (byte >> bit) & 1u;
        const uint32_t sel = (uint32_t)(-(int32_t)one);
        const uint32_t nHigh = nH0 + (dH & sel);
        const uint32_t nLow = nL0 - (dL & sel);
        *outSet = mask;
        delay_ticks(nHigh);
        *outClr = mask;
        delay_ticks(nLow);
      }
    }
    px += 3;
  }
}

/**
 * 标定结束后的归一化 —— 把「倒挂保护」从逐 bit 分支挪到这里 (只跑一次).
 *
 * 目标 (sendFrame 的纯算术形式依赖这三条):
 *   nH1 >= nH0   → dH = nH1 - nH0 非负
 *   nL1 <= nL0   → dL = nL0 - nL1 非负
 *   四个值都 >= 1 → delay_ticks() 的 `if (n == 0) return;` 永远不跳,
 *                   内层循环的分支行为固定 (不会因为 0/1 数据而变).
 *
 * 正常标定不会触发任何一条; 触发了说明闭环没收敛或硬件异常, 打日志.
 * 宁可时序偏一点 (仍在 WS2811 规格内), 也不能让 bit 宽度依赖数据.
 */
static bool normalizeCalibration() {
  bool changed = false;
  if (s_nHigh1 < s_nHigh0) {
    s_nHigh1 = s_nHigh0;
    changed = true;
  }
  if (s_nLow1 > s_nLow0) {
    s_nLow1 = s_nLow0;
    changed = true;
  }
  // 迭代数 0 会让 delay_ticks() 走 early-return —— 这条路径只对 0/1 其中
  // 一种 bit 生效, 又是一条「依赖数据的分支」. 全部抬到 1.
  if (s_nHigh0 < 1) { s_nHigh0 = 1; changed = true; }
  if (s_nLow0 < 1) { s_nLow0 = 1; changed = true; }
  if (s_nHigh1 < 1) { s_nHigh1 = 1; changed = true; }
  if (s_nLow1 < 1) { s_nLow1 = 1; changed = true; }
  return changed;
}



/** 一次「读计数器」的成本 —— 连读两次计数器, 取最小值. */
static uint32_t measureEmpty() {
  uint32_t best = 0xFFFFFFFFu;
  for (int rep = 0; rep < 3; rep++) {
    uint32_t s0 = cycle_now();
    uint32_t s1 = cycle_now();
    uint32_t e = s1 - s0;
    if (e < best) best = e;
  }
  return best;
}

/**
 * 量 delay_ticks(n) 的**真实延时** cycles (已经扣掉测量本身的成本).
 * 重复 3 遍取**最小值**: 万一撞上中断, 最小值那一遍最干净.
 */
static uint32_t measureDelay(uint32_t n) {
  uint32_t best = 0xFFFFFFFFu;
  for (int rep = 0; rep < 3; rep++) {
    uint32_t s0 = cycle_now();
    delay_ticks(n);
    uint32_t s1 = cycle_now();
    uint32_t span = s1 - s0;
    if (span < best) best = span;
  }
  return (best > s_empty) ? (best - s_empty) : 0;
}

/**
 * 找一个迭代次数 n, 使 delay_ticks(n) 的实际延时最接近 target cycles.
 *
 * 做法: 先按 (target - 固定开销) / 每迭代 cycles 估一个初值, 再**实测**修正.
 * 修正步用定点斜率算, 最多修 3 次.
 */
static uint32_t fitOne(uint32_t target) {
  int32_t num = (int32_t)target - (int32_t)s_fixed;
  uint32_t n = (num > 0)
                   ? (uint32_t)((((uint64_t)num << 8) / s_slopeFP) + 0.5)
                   : 0;
  for (int it = 0; it < 3; it++) {
    uint32_t actual = measureDelay(n);
    int32_t d = (int32_t)target - (int32_t)actual;
    if (d > -3 && d < 3) break;  // 差 3 cycles 以内 (0.012us) 就算够准
    int32_t adj = (d * 256) / (int32_t)s_slopeFP;
    int32_t nn = (int32_t)n + adj;
    if (nn < 0) nn = 0;
    n = (uint32_t)nn;
  }
  return n;
}

/**
 * 把误差 (cycles) 换算成迭代数的调整量 —— **四舍五入**, 不是截断.
 *
 * ⚠️ C 的整数除法是**向零取整**的: -5 cycles / 5 cycles 每迭代 = -1, 但
 *   (-5*256)/1281 = 0 —— 调整量直接变成 0, 闭环**卡住不动**
 *   (实测卡在 305 而不是 300). 负数要**减半再除**, 才是远离零的取整.
 */
static int32_t adjIters(int32_t errCycles) {
  int32_t slope = (int32_t)s_slopeFP;
  int32_t num = errCycles * 256;
  if (num >= 0) return (num + slope / 2) / slope;
  return (num - slope / 2) / slope;
}

/**
 * 量「平均 bit 周期」—— 用**真的** sendFrame 发一段全 0 / 全 1 的缓冲, 除以 bit 数.
 *
 * 这个数就是**线上**的 bit 周期 (含循环开销), 是 WS2812 真正在意的时序.
 */
static uint32_t measurePeriod(const uint8_t* buf, int pixels, int pin) {
  volatile uint32_t* outSet = outSetPtr(pin);
  volatile uint32_t* outClr = outClrPtr(pin);
  uint32_t t0 = cycle_now();
  sendFrame(buf, pixels, outSet, outClr, outMask(pin));
  uint32_t t1 = cycle_now();
  uint32_t elapsed = t1 - t0;
  if (elapsed > s_empty) elapsed -= s_empty;  // 扣掉测量本身的成本
  return elapsed / (uint32_t)(pixels * 24);
}

/**
 * 量**线上**的高电平宽度 (cycles).
 *
 * 量法: 读两次计数器之间夹一段延时, 再用「同样的两次读、中间什么都不做」
 * 的那一次相减 —— 两次的「读计数器」成本**完全抵消**, 剩下的就是延时本身.
 */
static uint32_t measureHighWidth(int pin, bool isOne) {
  volatile uint32_t* outSet = outSetPtr(pin);
  volatile uint32_t* outClr = outClrPtr(pin);
  uint32_t mask = outMask(pin);
  uint32_t nHigh = isOne ? s_nHigh1 : s_nHigh0;
  uint32_t nLow = isOne ? s_nLow1 : s_nLow0;
  uint32_t best = 0xFFFFFFFFu;
  for (int rep = 0; rep < 5; rep++) {
    uint32_t a0 = cycle_now();
    *outSet = mask;
    delay_ticks(nHigh);
    uint32_t a1 = cycle_now();
    *outClr = mask;
    delay_ticks(nLow);
    (void)cycle_now();
    uint32_t b0 = cycle_now();
    uint32_t b1 = cycle_now();
    (void)cycle_now();
    uint32_t h = (a1 - a0) - (b1 - b0);
    if (h < best) best = h;
  }
  return best;
}

/**
 * ★ 闭环标定「高电平延时」, 使**线上的高电平宽度**正好等于目标.
 *
 * 为什么不能按公式算: 线上高电平 = 延时 + 「写 GPIO + 调用延时函数」的
 * 那点开销 (~9 cycles). 按公式把延时设成 96, 线上其实是 107 (0.446us).
 * 虽然还在规格内 (0.3~0.55us), 但偏在一头; 闭环量出来正好落在 96.
 */
static uint32_t calibrateHigh(int pin, bool isOne) {
  uint32_t target = isOne ? CYCLES_HIGH_1 : CYCLES_HIGH_0;
  uint32_t n = isOne ? s_nHigh1 : s_nHigh0;
  uint32_t width = 0;
  for (int iter = 0; iter < 6; iter++) {
    if (isOne) {
      s_nHigh1 = n;
    } else {
      s_nHigh0 = n;
    }
    width = measureHighWidth(pin, isOne);
    int32_t err = (int32_t)target - (int32_t)width;
    if (err > -3 && err < 3) break;  // 量化步长 5 cycles, 半步以内就收工
    int32_t nn = (int32_t)n + adjIters(err);
    if (nn < 0) nn = 0;
    n = (uint32_t)nn;
  }
  if (isOne) {
    s_nHigh1 = n;
  } else {
    s_nHigh0 = n;
  }
  return width;
}

/**
 * ★ 闭环标定「低电平延时」, 使**线上的 bit 周期**正好 CYCLES_PER_BIT (300 = 1.25us).
 *
 * 为什么必须闭环 (开环算不准):
 *   线上一个 bit 的周期 = 高电平 + 低电平 + **循环开销**
 *   (从 outClr 到下一个 outSet 之间所有指令的时间 —— 实测 ~60 cycles).
 *   开环按「高 + 低 = 300」算, 那个开销就没人管了 → 周期实测 1.7us,
 *   远超规格上限 1.4us → 芯片把 0 读成 1 → 灯带乱闪.
 *
 * 闭环怎么做: 直接量整帧时间 (measurePeriod), 反推低电平该多长 / 短多少,
 * 再量一次. 量化步长 = 1 个迭代 = 5 cycles, 所以容差取 ±3 cycles (0.0125us).
 *
 * ⚠️ 必须在**高电平标定完之后**做 —— 高电平一变, 周期也跟着变.
 *
 * @param fill  缓冲填什么: 0x00 = 全 0 bit (走 nHigh0/nLow0), 0xFF = 全 1 bit.
 * @param isOne 调的是 1 bit 的低电平 (s_nLow1) 还是 0 bit 的 (s_nLow0).
 * @return 实测到的周期 (cycles).
 */
static uint32_t calibrateLow(int pin, uint8_t fill, bool isOne) {
  static const int CAL_PIXELS = 8;  // 8 颗 = 192 bit, 够长 (误差摊薄到 0.2 cycle/bit)
  static uint8_t buf[CAL_PIXELS * 3];
  memset(buf, fill, sizeof(buf));

  uint32_t nLow = isOne ? s_nLow1 : s_nLow0;
  uint32_t period = 0;
  for (int iter = 0; iter < 6; iter++) {
    if (isOne) {
      s_nLow1 = nLow;
    } else {
      s_nLow0 = nLow;
    }
    period = measurePeriod(buf, CAL_PIXELS, pin);
    int32_t err = (int32_t)CYCLES_PER_BIT - (int32_t)period;
    if (err > -3 && err < 3) break;  // 差 3 cycles 以内 (0.0125us) 就收工
    // 周期偏短 → 低电平要长 → 迭代数增加 (err > 0 时 adj > 0).
    int32_t nn = (int32_t)nLow + adjIters(err);
    if (nn < 0) nn = 0;
    nLow = (uint32_t)nn;
  }
  if (isOne) {
    s_nLow1 = nLow;
  } else {
    s_nLow0 = nLow;
  }
  return period;
}

/**
 * 标定延时循环 —— 算出四个延时各自的迭代次数.
 *
 * ⚠️ **为什么不用「两点求斜率 + 线性公式」** (这版就是这么写的, 结果全灭):
 *   实测 span(n) = 41 + 5·n —— 斜率是 5.0000, 但
 *     perIter = (bestB - bestA) / (N2 - N1) = 19999 / 4000 = **4** (整数截断!)
 *   斜率错 1 → 迭代数按 5 算的却按 4 用 → 高电平时长直接差 20%.
 *   更糟的是**截距**: 它是用斜率从 N=4000 处**外推**出来的, 斜率差 0.004
 *   cycles/iter 就会让截距差 16 cycles —— 那 16 cycles 又被当成「固定开销」
 *   扣掉, 于是迭代数算出来**全是 0**, 延时等于没有, 灯带当然是乱的.
 *
 *   现在的做法: 固定开销**直接量** (measureDelay(0)), 斜率**直接量**
 *   (measureDelay(1000) 减掉固定开销), 高电平按公式拟合后再**实测修正**,
 *   低电平**闭环**调到线上周期正好 300 cycles.
 *
 * ⚠️ **必须关中断测**: 开着中断测的时候, 一次 BLE ISR 就能把测量撑爆.
 *   同理, 重复 3 遍取**最小值**.
 * ⚠️ 临界区里**不能有 Serial.printf** —— USB 串口很慢, 关着中断打印会把
 *   中断看门狗 (TWDT) 憋爆 → panic 重启.
 */
static void calibrateTiming(int pin) {
  uint32_t actH0, actL0, actH1, actL1;
  uint32_t per0, per1;

  portENTER_CRITICAL(&g_showMux);
  delay_ticks(2000);   // 热身: 让这段代码进 cache
  s_empty = measureEmpty();
  uint32_t d0 = measureDelay(0);       // 固定开销
  uint32_t d1 = measureDelay(1000);    // 固定开销 + 斜率 * 1000
  s_fixed = d0;
  uint32_t diff = (d1 > d0) ? (d1 - d0) : 1;
  s_slopeFP = (diff << 8) / 1000;      // 定点: 低 8 位是小数
  if (s_slopeFP == 0) s_slopeFP = 256; // 兜底: 1 cycle/iter
  s_perIter = s_slopeFP >> 8;
  s_overhead = s_fixed;

  // 高电平: 0 -> 96 cycles (0.4us), 1 -> 192 cycles (0.8us) —— **闭环**标定.
  uint32_t wHigh0 = calibrateHigh(pin, false);
  uint32_t wHigh1 = calibrateHigh(pin, true);
  // 低电平先按公式估一个初值, 下面用闭环修 (公式算不准, 见 calibrateLow).
  s_nLow0 = fitOne(CYCLES_LOW_0);
  s_nLow1 = fitOne(CYCLES_LOW_1);

  // ★ 闭环: 让**线上的** bit 周期正好 300 cycles (1.25us).
  per0 = calibrateLow(pin, 0x00, false);
  per1 = calibrateLow(pin, 0xFF, true);

  // ★ 归一化必须在这里、**测量之前**做 —— 它改的是真正用于发送的迭代数.
  bool normalized = normalizeCalibration();

  // ★ 标定完**当场实测**一遍 —— 不合格当场就能看出来, 不用等灯带乱闪.
  actH0 = measureDelay(s_nHigh0);
  actL0 = measureDelay(s_nLow0);
  actH1 = measureDelay(s_nHigh1);
  actL1 = measureDelay(s_nLow1);
  portEXIT_CRITICAL(&g_showMux);

  if (normalized) {
    Serial.println(F("[calib] ⚠ 标定倒挂, 已归一化 (保证发送循环无分支)"));
  }

  Serial.printf("[calib] 空跨度=%lu 固定开销=%lu 每迭代=%.3f cycles\n",
                (unsigned long)s_empty, (unsigned long)s_fixed,
                (double)s_slopeFP / 256.0);
  Serial.printf("[calib] 迭代数: 高0=%lu 低0=%lu 高1=%lu 低1=%lu\n",
                (unsigned long)s_nHigh0, (unsigned long)s_nLow0,
                (unsigned long)s_nHigh1, (unsigned long)s_nLow1);
  Serial.printf("[calib] 延时 cycles: 高0=%lu 低0=%lu 高1=%lu 低1=%lu\n",
                (unsigned long)actH0, (unsigned long)actL0,
                (unsigned long)actH1, (unsigned long)actL1);
  Serial.printf("[calib] ★ 线上 bit 周期: 0bit=%lu 1bit=%lu (目标 300 = 1.25us, 规格 264~336)\n",
                (unsigned long)per0, (unsigned long)per1);
  Serial.printf("[calib] ★ 线上高电平: 0bit=%lu (目标 96, 规格 72~132) 1bit=%lu (目标 192, 规格 168~228)\n",
                (unsigned long)wHigh0, (unsigned long)wHigh1);
}

bool Ws2811Bitbang::begin(int pin, int count) {
  if (count <= 0) return false;

  // ★ 换灯数 (双色带 176 → 352) 会再调一次 begin() —— 旧的像素缓冲必须释放,
  //   否则每切一次模式就泄漏 count*3 字节.
  //
  // ⚠️ 顺序很重要: **先分配新的, 成功后再释放旧的**. 反过来的话, 一旦
  //   malloc 失败, 旧缓冲已经没了 —— 灯带就永久熄了, 但上层 (stripInit /
  //   stripCount) 还以为它是好的 → 「连上了但一颗都不亮」, 而且再也救不回来.
  uint8_t* buf = (uint8_t*)malloc((size_t)count * 3);
  if (!buf) return false;  // 分配失败 → 旧缓冲原封不动, 灯带照常用
  memset(buf, 0, (size_t)count * 3);
  if (pixels_) free(pixels_);
  pixels_ = buf;
  count_ = count;
  pin_ = pin;

  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
  // 标定**只做一次** —— 时序跟灯数无关, 换灯数时不用重来一遍
  // (重来一遍会往灯带上打 8 颗全白, 换模式时闪一下).
  // 引脚也是编译期固定的, 所以「只标定一次」不会漏标别的引脚.
  static bool calibrated = false;
  if (!calibrated) {
    calibrateTiming(pin);
    calibrated = true;
  }
  return true;
}

uint8_t Ws2811Bitbang::scale(uint8_t v) const {
  return (uint8_t)((v * (uint16_t)brightness_) / 255);
}

void Ws2811Bitbang::setPixel(int index, uint8_t r, uint8_t g, uint8_t b) {
  if (!pixels_ || index < 0 || index >= count_) return;
  pixels_[index * 3 + 0] = scale(g);
  pixels_[index * 3 + 1] = scale(r);
  pixels_[index * 3 + 2] = scale(b);
}

void Ws2811Bitbang::setAll(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < count_; i++) setPixel(i, r, g, b);
}

void Ws2811Bitbang::clear() {
  if (pixels_) memset(pixels_, 0, (size_t)count_ * 3);
}

void Ws2811Bitbang::getPixel(int index, uint8_t* r, uint8_t* g, uint8_t* b) const {
  if (!pixels_ || index < 0 || index >= count_) {
    if (r) *r = 0;
    if (g) *g = 0;
    if (b) *b = 0;
    return;
  }
  // 缓冲是 GRB 排列.
  if (g) *g = pixels_[index * 3 + 0];
  if (r) *r = pixels_[index * 3 + 1];
  if (b) *b = pixels_[index * 3 + 2];
}

int Ws2811Bitbang::litCount() const {
  if (!pixels_) return 0;
  int lit = 0;
  for (int i = 0; i < count_; i++) {
    const uint8_t* px = pixels_ + (size_t)i * 3;
    if (px[0] || px[1] || px[2]) lit++;
  }
  return lit;
}

/**
 * ★ 功耗上限 (写死在 LED_MAX_LIT, 见 led_limits.h).
 *
 * 同时点亮的颗数超过上限时, 把**下标大的**那些灭掉, 只留下限颗.
 *
 * 为什么是「按颗数」而不是「按下标」:
 *   按下标限 (比如只有前 30 颗能亮) 会把跑马灯从第 30 颗之后全灭掉 ——
 *   跑马灯是「同时只亮 6 颗、从左扫到右」, 它的亮灯**下标一直在变**,
 *   按颗数限则完全不受影响.
 *
 * 被灭掉的像素是**真的从缓冲里清掉**的 (不是只在这一帧盖掉) ——
 * 这样缓冲里的状态跟灯带上看到的永远一致.
 *
 * ⚠️ 这是**所有**点灯路径的唯一入口 (show() 第一件事就是调它) ——
 *   串口命令、BLE 的 set_many、跑马灯, 一律过这里, 谁都点不亮超过 30 颗.
 */
int Ws2811Bitbang::applyMaxLit() {
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

// show() 的临界区 (g_showMux) 定义在文件上面 —— 校准函数也要用它.

void Ws2811Bitbang::show() {
  if (!pixels_) return;
  applyMaxLit();  // ★ 功耗上限: 最多同时点亮 LED_MAX_LIT 颗 (所有点灯路径的唯一入口)


  // ESP32-S3 的 GPIO 输出寄存器 (bank 0 = GPIO0..31, bank 1 = GPIO32..53):
  //   置位 = GPIO_OUT_W1TS_REG / GPIO_OUT1_W1TS_REG
  //   清位 = GPIO_OUT_W1TC_REG / GPIO_OUT1_W1TC_REG
  // ★ 别在这儿自己按 pin 算地址 —— 用 outSetPtr()/outClrPtr() (见文件上面).
  volatile uint32_t* outSet = outSetPtr(pin_);
  volatile uint32_t* outClr = outClrPtr(pin_);
  uint32_t mask = outMask(pin_);

  // ★ 2026-10-26: 整帧必须**关中断**发送 —— 这是「灯乱闪 / 常亮残灯」的真根因.
  //
  // WS2811 靠 1.25µs 一个 bit 的电平宽度编码数据.
  // ★ 2026-11-11 更正: 以前这里写「一帧 176 颗灯 = 4224 个 bit ≈ 5.3ms」——
  //   那是按**逻辑**灯数算的, 但驱动层的 count_ 永远是**物理** 352
  //   (ble_led.cpp 传的是 LED_PHYSICAL_COUNT) → 一帧 = 8448 bit ≈ **10.6ms**.
  //   下面是「关中断安全吗」的论证, 数字也要跟着翻倍.
  //
  // 这 10.6ms 里只要进一次中断 (FreeRTOS 1ms tick、串口、任何 ISR),
  // 某个 bit 的高电平就被拉长到几微秒 —— WS2811 会把它当成 **reset/latch**:
  //
  //   * 帧在被打断的那颗灯处**提前锁存**, 后面的灯保留上一帧的颜色
  //     → 视觉上「跑马灯跑一半, 其他灯还亮着旧的 / 乱闪」
  //   * off/清屏帧被打断 → 尾巴那几颗灯**灭不掉**, 一直亮着
  //     → 用户报的「几个灯莫名其妙常亮」
  //
  // 树莓派那条路用 rpi_ws281x 的 PWM+DMA 硬件发波形, 中断不影响时序, 所以
  // 树莓派一直没问题、ESP 一直有毛病. 这里和它对齐: 发送期间屏蔽本核中断.
  //
  // 为什么可以关 10.6ms: BLE (NimBLE host/controller) 跑在 core 0, 而 loop()
  // 在 core 1; 关的是当前核 (core 1) 的中断, 蓝牙不断. 只推迟 core 1 的 tick
  // 10.6ms —— FreeRTOS 能接受 (tick 1ms → 延迟 10 个 tick); NimBLE 在 core 0
  // 上完全不受影响.
  portENTER_CRITICAL(&g_showMux);
  sendFrame(pixels_, count_, outSet, outClr, mask);
  // 最后一个 bit 之后保持低电平 —— latch 需要 >50µs 低.
  *outClr = mask;
  portEXIT_CRITICAL(&g_showMux);

  // latch: 低电平 >50us. 中断已经放开, 这里被中断也不影响 (数据已经发完).
  delayMicroseconds(300);
}

// ── 自测: 量出 bit-bang 的真实时序 ─────────────────────────────────────
// 改完驱动先跑这个 —— 数字不对就别烧固件, 烧了也白烧.
//
// out[0] = 一次 cycle 读取的成本 (cycles; 越小越准)
// out[1] = 实测 bit 周期 (cycles; 理论 300)
// out[2] = 实测 T0H (cycles; 理论 96, 上限 132 = 0.55us)
// out[3] = 实测 T1H (cycles; 理论 192, 上限 228 = 0.95us)
// out[4] = rdcycle 与 esp_cpu_get_cycle_count() 的差 (0 = 同一个时基)
// out[5] = 等待循环的**轮询间隔** (cycles) —— 时序分辨率就是它
// out[6] = 校准出来的 perIter (延时循环每次迭代的 cycles)
// out[7] = bit 周期的中位数, out[8] = 最大值
// out[9] = 固定开销, out[10..13] = 高/低电平的迭代数 (0bit高, 0bit低, 1bit高, 1bit低)
void Ws2811Bitbang::selfTest(uint32_t* out) {
  // (1) 一次 cycle 读的成本 —— 内联 rdcycle vs IDF 的 esp_cpu_get_cycle_count()
  uint32_t s = cycle_now();
  for (int i = 0; i < 1000; i++) {
    volatile uint32_t x = cycle_now();
    (void)x;
  }
  uint32_t e = cycle_now();
  out[0] = (e - s) / 1000;

  s = (uint32_t)esp_cpu_get_cycle_count();
  for (int i = 0; i < 1000; i++) {
    volatile uint32_t x = esp_cpu_get_cycle_count();
    (void)x;
  }
  e = (uint32_t)esp_cpu_get_cycle_count();
  out[1] = (e - s) / 1000;

  // (2) rdcycle 和 esp_cpu_get_cycle_count() 是不是同一个时基
  uint32_t a0 = cycle_now();
  uint32_t b0 = (uint32_t)esp_cpu_get_cycle_count();
  delay(20);
  uint32_t a1 = cycle_now();
  uint32_t b1 = (uint32_t)esp_cpu_get_cycle_count();
  uint32_t da = a1 - a0;
  uint32_t db = b1 - b0;
  out[4] = (da > db) ? (da - db) : (db - da);

  // (3) 等待循环的轮询间隔 —— 「等 high 结束」那个 while 每轮询一次要多长时间.
  //     这个数就是**时序分辨率**: 高电平最多会超出目标这么多.
  {
    uint32_t st = cycle_now();
    int n = 0;
    while ((cycle_now() - st) < 1000) n++;
    uint32_t el = cycle_now() - st;
    out[5] = n ? (el / (uint32_t)n) : 0;
  }

  // (4) 校准出来的 perIter / overhead / 四个迭代数 —— 「不用计数器」的方案靠它
  out[6] = s_perIter;
  out[9] = s_overhead;
  out[10] = s_nHigh0;
  out[11] = s_nLow0;
  out[12] = s_nHigh1;
  out[13] = s_nLow1;

  // (5) 实测 bit 周期 / T0H / T1H —— **关中断**测 (和 show() 里的环境一样),
  //     而且走的是**和 show() 完全相同的代码** (同一份 sendFrame / delay_ticks).
  //     测别的代码等于白测.
  //
  //     ★ 线上 bit 周期: 直接量**整帧时间**再除以 bit 数 —— 这样「循环开销」
  //       也算进去了 (那正是之前把周期撑到 1.7us 的元凶).
  //     ★ 高电平宽度: 量两次相减, 把「读计数器」的成本**抵消**掉:
  //         A: r0=读; *outSet; delay(高); r1=读; *outClr; delay(低); r2=读
  //         B: r0'=读; r1'=读; r2'=读            (什么也不做)
  //         高 = (r1-r0) - (r1'-r0')   低 = (r2-r1) - (r2'-r1')
  volatile uint32_t* outSet = outSetPtr(pin_);
  volatile uint32_t* outClr = outClrPtr(pin_);
  uint32_t mask = outMask(pin_);
  const int CAL_PIXELS = 8;
  static uint8_t buf[CAL_PIXELS * 3];

  portENTER_CRITICAL(&g_showMux);
  memset(buf, 0x00, sizeof(buf));
  out[7] = measurePeriod(buf, CAL_PIXELS, pin_);   // 全 0 bit 的线上周期
  memset(buf, 0xFF, sizeof(buf));
  out[8] = measurePeriod(buf, CAL_PIXELS, pin_);   // 全 1 bit 的线上周期

  // 高电平宽度 (读的成本靠相减抵消)
  {
    uint32_t best0 = 0xFFFFFFFFu, best1 = 0xFFFFFFFFu;
    for (int rep = 0; rep < 5; rep++) {
      // A: 真的发一个 0 bit
      uint32_t a0 = cycle_now();
      *outSet = mask;
      delay_ticks(s_nHigh0);
      uint32_t a1 = cycle_now();
      *outClr = mask;
      delay_ticks(s_nLow0);
      uint32_t a2 = cycle_now();
      // B: 同样的三次读, 中间什么都不做
      uint32_t b0 = cycle_now();
      uint32_t b1 = cycle_now();
      uint32_t b2 = cycle_now();

      uint32_t h0 = (a1 - a0) - (b1 - b0);
      uint32_t h1 = (a2 - a1) - (b2 - b1);
      if (h0 < best0) best0 = h0;
      if (h1 < best1) best1 = h1;
    }
    out[2] = best0;   // T0H
    (void)best1;      // 0 bit 的低电平宽度 —— 只是自检用, 不上报
  }
  {
    uint32_t best = 0xFFFFFFFFu;
    for (int rep = 0; rep < 5; rep++) {
      uint32_t a0 = cycle_now();
      *outSet = mask;
      delay_ticks(s_nHigh1);
      uint32_t a1 = cycle_now();
      *outClr = mask;
      delay_ticks(s_nLow1);
      (void)cycle_now();
      uint32_t b0 = cycle_now();
      uint32_t b1 = cycle_now();
      (void)cycle_now();
      uint32_t h = (a1 - a0) - (b1 - b0);
      if (h < best) best = h;
    }
    out[3] = best;   // T1H
  }
  portEXIT_CRITICAL(&g_showMux);
}

/**
 * 延时原语的原始测量表 —— 见头文件里的说明.
 *
 * 打印 span(delay_ticks(n)) = 「读计数器 → delay_ticks(n) → 再读计数器」的总长.
 * 健康的曲线 = 直线: span(n) = 固定开销 + n * perIter.
 *   * 斜率 (相邻两点的差) = perIter —— 应该是个**小整数** (4 左右).
 *   * 截距 = 固定开销 —— 应该只有几十 cycles (一次函数调用 + 栈帧).
 * 如果斜率忽大忽小 / 截距上千 → 延时原语或测量环境有问题.
 */
void Ws2811Bitbang::delayProbe() {
  static const uint32_t NS[] = {0, 100, 500, 1000, 2000, 4000, 8000, 16000};
  const int M = (int)(sizeof(NS) / sizeof(NS[0]));
  uint32_t spans[M];
  uint32_t empties[M];

  portENTER_CRITICAL(&g_showMux);
  delay_ticks(2000);  // 热身

  for (int i = 0; i < M; i++) {
    uint32_t n = NS[i];
    // 同一段里连测 3 遍取最小值 —— 万一撞上中断, 最小值那一遍最干净.
    uint32_t best = 0xFFFFFFFFu;
    for (int rep = 0; rep < 3; rep++) {
      uint32_t s0 = cycle_now();
      delay_ticks(n);
      uint32_t s1 = cycle_now();
      uint32_t span = s1 - s0;
      if (span < best) best = span;
    }
    // 空跨度: 连续读两次计数器 = 测量本身 + 一次函数调用的成本.
    uint32_t e0 = cycle_now();
    uint32_t e1 = cycle_now();

    spans[i] = best;
    empties[i] = e1 - e0;
  }
  portEXIT_CRITICAL(&g_showMux);

  // ⚠️ 打印**必须在临界区外面** —— Serial.printf 很慢 (USB 串口), 关着中断
  //   打印会把中断看门狗 (TWDT) 憋爆 → panic 重启.
  uint32_t prev = 0;
  for (int i = 0; i < M; i++) {
    Serial.printf("[dprobe] n=%6lu span=%8lu 空跨度=%lu 增量=%lu\n",
                  (unsigned long)NS[i], (unsigned long)spans[i],
                  (unsigned long)empties[i],
                  (unsigned long)(i ? (spans[i] - prev) : 0));
    prev = spans[i];
  }
}

/** 重新标定一次 (诊断用) —— 开机时标定一次, 之后随时可以再标一次对比. */
void Ws2811Bitbang::recalibrate() {
  calibrateTiming(pin_);
}

// ── 波形回读: 用 RMT RX 抓自己发出去的波形 ────────────────────────────────
//
// 见头文件 waveProbe() 的说明. 这里只做「抓 2 颗灯 = 48 个 bit」的小帧,
// 重复 N 次, 把每个 bit 的高/低电平宽度按「期望的 0/1」分类统计.
//
// 为什么只用 48 个 symbol: RMT 每个 RX 通道只有 48 个 word 的硬件缓冲
// (SOC_RMT_MEM_WORDS_PER_CHANNEL), 不发 DMA 的话一次最多抓 48 段.
// 2 颗灯正好 48 bit. 要抓整帧 352 颗得用 DMA/流式, 没必要 —— 抖动和
// 中断打断都是**逐 bit** 的现象, 2 颗灯足够暴露.
#include "driver/rmt_rx.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace {
constexpr size_t kWaveSymbols = 48;       // 2 颗灯 × 24 bit
constexpr uint32_t kWaveResHz = 80 * 1000 * 1000;  // 12.5ns/tick
volatile SemaphoreHandle_t g_waveDone = nullptr;
volatile size_t g_waveNum = 0;

bool IRAM_ATTR waveRxDone(rmt_channel_handle_t, const rmt_rx_done_event_data_t* ev,
                          void*) {
  g_waveNum = ev->num_symbols;
  BaseType_t hp = pdFALSE;
  if (g_waveDone) xSemaphoreGiveFromISR((SemaphoreHandle_t)g_waveDone, &hp);
  return hp == pdTRUE;
}

/** 一条统计: min / max / 超出容差的个数. */
struct WidthStat {
  uint32_t minv = 0xFFFFFFFFu;
  uint32_t maxv = 0;
  uint32_t count = 0;
  uint32_t bad = 0;
  void add(uint32_t v, uint32_t expect, uint32_t tol) {
    if (v < minv) minv = v;
    if (v > maxv) maxv = v;
    count++;
    uint32_t d = (v > expect) ? (v - expect) : (expect - v);
    if (d > tol) bad++;
  }
};
}  // namespace

void Ws2811Bitbang::waveProbe() {
  if (pin_ < 0 || !pixels_) {
    Serial.println(F("[wave] 驱动还没 begin()"));
    return;
  }
  if (!g_waveDone) g_waveDone = xSemaphoreCreateBinary();
  if (!g_waveDone) {
    Serial.println(F("[wave] 信号量创建失败"));
    return;
  }

  static rmt_symbol_word_t rxBuf[kWaveSymbols];
  rmt_channel_handle_t rx = nullptr;
  rmt_rx_channel_config_t rxCfg = {};
  rxCfg.gpio_num = (gpio_num_t)pin_;
  rxCfg.clk_src = RMT_CLK_SRC_DEFAULT;
  rxCfg.resolution_hz = kWaveResHz;
  rxCfg.mem_block_symbols = kWaveSymbols;
  esp_err_t err = rmt_new_rx_channel(&rxCfg, &rx);
  if (err != ESP_OK) {
    Serial.printf("[wave] new_rx_channel 失败: %d\n", (int)err);
    return;
  }
  rmt_rx_event_callbacks_t cbs = {};
  cbs.on_recv_done = waveRxDone;
  rmt_rx_register_event_callbacks(rx, &cbs, nullptr);
  rmt_enable(rx);

  volatile uint32_t* outSet = outSetPtr(pin_);
  volatile uint32_t* outClr = outClrPtr(pin_);
  const uint32_t mask = outMask(pin_);
  rmt_receive_config_t rcv = {};
  rcv.signal_range_min_ns = 80;      // < 0.4us 的毛刺并进相邻段
  rcv.signal_range_max_ns = 100000;  // 100us: 超过就算一个「长低电平」

  // 期望值 (80MHz: 0.4us=32 tick, 0.8us=64 tick).
  const uint32_t kH0 = 32, kH1 = 64;
  // 低电平没有固定期望值 (含循环开销) —— 用容差卡「是不是被拉长到离谱」.
  //   T0L ≈ 0.85us = 68 tick, T1L ≈ 0.45us = 36 tick, 再加循环开销 ~10 tick.
  const uint32_t kL0 = 78, kL1 = 46;
  // 0.15us = 12 tick (WS2811 的容差量级).
  const uint32_t kTolH = 6, kTolL = 12;

  struct Case {
    const char* name;
    uint8_t fill;
    bool random;
  } cases[] = {
      {"all0", 0x00, false},
      {"all1", 0xFF, false},
      {"alt ", 0xAA, false},   // 0/1 交替: 专门暴露「依赖数据的分支」
      {"rand", 0x00, true},    // 伪随机: 最接近真实像素数据
  };

  Serial.println(F("[wave] RMT RX 回环抓波形 (2 颗 = 48 bit/次, 每种 100 次)"));
  Serial.println(F("[wave] 目标: 0高=32 / 1高=64 tick (80MHz, 1 tick=12.5ns); 偏差>6 tick = 灯带可能读错"));

  for (const Case& c : cases) {
    WidthStat h0, h1, l0, l1;
    uint32_t misses = 0;
    uint32_t maxLow = 0;
    uint32_t maxHigh = 0;
    uint32_t rng = 0x12345678u;
    for (int rep = 0; rep < 100; rep++) {
      uint8_t pat[6];
      if (c.random) {
        for (int i = 0; i < 6; i++) {
          rng = rng * 1664525u + 1013904223u;
          pat[i] = (uint8_t)(rng >> 24);
        }
      } else {
        memset(pat, c.fill, sizeof(pat));
      }
      xSemaphoreTake((SemaphoreHandle_t)g_waveDone, 0);
      err = rmt_receive(rx, rxBuf, sizeof(rxBuf), &rcv);
      if (err != ESP_OK) { misses++; continue; }
      portENTER_CRITICAL(&g_showMux);
      sendFrame(pat, 2, outSet, outClr, mask);
      *outClr = mask;
      portEXIT_CRITICAL(&g_showMux);
      if (xSemaphoreTake((SemaphoreHandle_t)g_waveDone, pdMS_TO_TICKS(50)) != pdTRUE) {
        misses++;
        continue;
      }
      size_t n = g_waveNum;
      if (n > kWaveSymbols) n = kWaveSymbols;
      for (size_t s = 0; s < n && s < 48; s++) {
        const uint8_t byte = pat[s / 8];
        const uint32_t expectOne = (byte >> (7 - (s % 8))) & 1u;
        uint32_t hi = rxBuf[s].level0 ? rxBuf[s].duration0 : rxBuf[s].duration1;
        uint32_t lo = rxBuf[s].level0 ? rxBuf[s].duration1 : rxBuf[s].duration0;
        if (hi > maxHigh) maxHigh = hi;
        if (lo > maxLow) maxLow = lo;
        if (expectOne) {
          h1.add(hi, kH1, kTolH);
          l1.add(lo, kL1, kTolL);
        } else {
          h0.add(hi, kH0, kTolH);
          l0.add(lo, kL0, kTolL);
        }
      }
    }
    Serial.printf("[wave] %s: 0高 %lu..%lu (坏 %lu) 1高 %lu..%lu (坏 %lu) | "
                  "0低 %lu..%lu (坏 %lu) 1低 %lu..%lu (坏 %lu) | 最长高=%lu 最长低=%lu 丢=%lu\n",
                  c.name,
                  (unsigned long)(h0.count ? h0.minv : 0), (unsigned long)h0.maxv,
                  (unsigned long)h0.bad,
                  (unsigned long)(h1.count ? h1.minv : 0), (unsigned long)h1.maxv,
                  (unsigned long)h1.bad,
                  (unsigned long)(l0.count ? l0.minv : 0), (unsigned long)l0.maxv,
                  (unsigned long)l0.bad,
                  (unsigned long)(l1.count ? l1.minv : 0), (unsigned long)l1.maxv,
                  (unsigned long)l1.bad,
                  (unsigned long)maxHigh, (unsigned long)maxLow, (unsigned long)misses);
  }

  rmt_disable(rx);
  rmt_del_channel(rx);
  // RMT RX 会把引脚改成输入 —— 恢复成 GPIO 输出, 否则灯带从此不亮.
  pinMode(pin_, OUTPUT);
  digitalWrite(pin_, LOW);
  Serial.println(F("[wave] 完成 (引脚已恢复输出)"));
}
