// 点阵屏自检图案 —— 用来查哪块屏 / 哪个像素坏了 (2026-11-16 用户要求).
//
// 全屏纯色, 每 4 秒换一个颜色: 红 -> 绿 -> 蓝 -> 白.
//
// 为什么是纯色轮播:
//   - 纯色最好查坏点 —— 整块屏该是**一整片同色**, 有一个点颜色不一样就是坏了.
//   - 白色最容易看出「少了一列 / 少了一块屏」(整片偏暗或缺一块).
//   - 红 / 绿 / 蓝 分着看, 能分清是**哪一路**数据线出了问题
//     (三色都暗 = 那一路 RGB 里少了这个通道; 只有红暗 = 红通道的线断了).
//
// 纯色帧的每个字节都一样, 所以画布上屏的排布 (谁在左谁在右) 对它没影响 ——
// 一整条链 (4 块屏 1x4) 会被涂成同一个颜色.

/** 轮播的颜色 (RGB888). 顺序就是显示顺序. */
export const TEST_PATTERN_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0], // 红
  [0, 255, 0], // 绿
  [0, 0, 255], // 蓝
  [255, 255, 255], // 白
]

/** 每个颜色停留多久 (ms) —— 用户要求「每个 4 秒」. */
export const TEST_PATTERN_PERIOD_MS = 4000

/**
 * 现在该显示第几个颜色.
 *
 * @param elapsedMs 从自检开始到现在过了多久 (ms) —— 用「起点 + 经过时间」算,
 *                  不用记状态, 也不用跟系统时钟对齐.
 */
export function testPatternIndex(
  elapsedMs: number,
  periodMs: number = TEST_PATTERN_PERIOD_MS,
): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0
  const p = periodMs > 0 ? periodMs : TEST_PATTERN_PERIOD_MS
  return Math.floor(elapsedMs / p) % TEST_PATTERN_COLORS.length
}

/**
 * 整屏纯色的一帧 (RGB888, 跟面板要的一样).
 *
 * 尺寸 = 宽 × 高 × 3 —— 链上有几块屏, 宽就是几块屏加起来.
 */
export function solidFrame(
  width: number,
  height: number,
  rgb: readonly [number, number, number],
): Uint8Array {
  const out = new Uint8Array(width * height * 3)
  for (let i = 0; i < out.length; i += 3) {
    out[i] = rgb[0]
    out[i + 1] = rgb[1]
    out[i + 2] = rgb[2]
  }
  return out
}
