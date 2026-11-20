// 点阵屏推帧的「闸门」—— 什么时候该**跳过**这一帧.
//
// 为什么需要 (2026-11-13, 用户报「像素随机乱删 + 整体闪烁」):
//
//   1. **浏览器侧的发队列会越攒越长.** `ws.send()` 是异步的: 链路/树莓派
//      一旦慢下来, 帧就排进浏览器的发送缓冲. rAF 还是每秒 30 次往里塞 ——
//      队列只增不减, 屏幕开始「慢放」, 然后网络一恢复就**一口气灌一串**
//      过期帧进面板, 看起来就是卡顿 + 跳帧.
//      修法: 发送缓冲里积压超过 N 帧就**丢当前帧**, 让队列自己排空.
//      (跟树莓派那边的「只留最新一帧」是同一个思路, 两边都要有.)
//
//   2. **画面完全没变的时候没必要发.** 暂停、停在第一个音、编辑器弹窗挡住
//      画面 —— 这时每帧都一模一样, 30fps 推 24KB 纯属浪费 Wi-Fi 和树莓派
//      的 CPU, 而 CPU 一忙, 面板刷新率就抖 (hzeller README: 网络/IO 负载会
//      让刷新率忽高忽低 → 眼睛看到明暗闪烁).
//      修法: 跟上一帧逐字节比, 一样就跳过; 但**至少每 KEEPALIVE_MS 补发一帧**
//      —— 万一面板那头重启过 / 丢了一帧, 靠它自愈.
//
// 这两条都是纯函数, 单独放一个文件是为了能在测试里直接钉住 (不想要一个
// 假 WebSocket 才能验算术).

/**
 * 浏览器发送缓冲里允许积压几帧.
 *
 * 1 = 「已经有一帧还没发出去, 这一帧就别再塞了」.
 * 局域网上 24KB/帧、30fps 用不了 1 帧的余量; 调到 2 会让恢复时灌得更猛.
 */
export const MAX_BUFFERED_FRAMES = 1

/**
 * 画面没变时, 最多隔这么久补发一帧 (ms).
 *
 * 500ms: 人眼已经看不出「这帧是补发的」, 又能保证面板重启后 0.5 秒内自愈.
 */
export const KEEPALIVE_MS = 500

/**
 * 发送缓冲是不是已经积压太多 —— 是的话这一帧就别发了.
 *
 * @param bufferedBytes WebSocket.bufferedAmount (还没写到网卡上的字节数)
 * @param frameBytes    一帧多少字节; <= 0 表示还没算出来 (不拦)
 * @param maxFrames     允许积压的帧数 (默认 1)
 */
export function bufferedTooMuch(
  bufferedBytes: number,
  frameBytes: number,
  maxFrames: number = MAX_BUFFERED_FRAMES,
): boolean {
  if (!Number.isFinite(frameBytes) || frameBytes <= 0) return false
  if (!Number.isFinite(bufferedBytes) || bufferedBytes <= 0) return false
  return bufferedBytes > frameBytes * Math.max(0, maxFrames)
}

/** 两帧是不是**逐字节**一样 (长度不同 / 有一边是 null 都算不一样). */
export function framesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * 这一帧到底要不要发.
 *
 * 判定顺序 (先背压, 再内容 —— 顺序不能反: 缓冲满了的时候连补发帧也不该发):
 *   1. 缓冲积压 > maxFrames → 不发 (丢帧)
 *   2. 内容跟上一帧一样, 且不到保活间隔 → 不发
 *   3. 其余情况 → 发
 *
 * @param prev        上一帧发出去的内容 (null = 还没发过)
 * @param lastSentAt  上一帧发出去的时刻 (performance.now 基准; 0 = 还没发过)
 * @param now         现在 (performance.now)
 */
export function shouldSendFrame(
  prev: Uint8Array | null,
  lastSentAt: number,
  now: number,
  frame: Uint8Array,
  bufferedBytes: number,
  opts: { maxBufferedFrames?: number; keepaliveMs?: number } = {},
): boolean {
  const maxFrames = opts.maxBufferedFrames ?? MAX_BUFFERED_FRAMES
  const keepalive = opts.keepaliveMs ?? KEEPALIVE_MS
  if (bufferedTooMuch(bufferedBytes, frame.length, maxFrames)) return false
  if (prev === null || lastSentAt <= 0) return true
  if (!framesEqual(prev, frame)) return true
  return now - lastSentAt >= keepalive
}
