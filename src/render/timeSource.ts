// 渲染层时间源 (spec P1-1 / P1-14)
//
// store 的 currentTime 被 Player.emitTick 限流到 10Hz —— 直接拿它渲染会让
// 下落音符每 100ms 跳 PPS(280) * 0.1 = 28px, 肉眼可见的台阶感; LED 预扫描
// 的亮灭时刻同样被量化 (±900ms 窗口下约 11% 的误差).
//
// 播放器的 getCurrentTime() 是连续的 (每帧推进), 渲染层应该优先用它.
// store 的 currentTime 只留给需要 React 重渲染的 UI (进度条等).

/** 只要有 player 的连续时间就用它, 否则退回 store 的量化值 */
export function renderTime(
  player: { getCurrentTime?: () => number } | null | undefined,
  storeTime: number,
): number {
  const t = player?.getCurrentTime?.()
  return typeof t === 'number' && Number.isFinite(t) ? t : storeTime
}
