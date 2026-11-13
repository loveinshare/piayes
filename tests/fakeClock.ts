// 确定性时钟夹具 (spec P1-2 / P1-3)
// 音频时钟相关的东西必须可测 —— 真实 AudioContext 在 jsdom 里既不跑也不可控.
//
// FakeAudioContext:
//   - currentTime 由测试手动推进 (模拟音频设备按采样率走)
//   - state 可切 (suspended → 模拟浏览器自动播放策略)
//   - outputLatency / baseLatency 可设 (模拟蓝牙耳机 / 有线输出)
//
// FakePerfClock:
//   - 让 performance.now() 可控 —— SongClock 用它做 perf↔ctx 映射.

export class FakeAudioContext {
  currentTime = 0
  state: AudioContextState = 'running'
  baseLatency = 0
  outputLatency = 0

  /** 推进音频时钟 (秒) */
  advance(dt: number) {
    this.currentTime += dt
  }

  /** 模拟"主线程卡了 100ms" —— 音频时钟照走, JS 线程没跑 */
  stall(dt: number) {
    this.currentTime += dt
  }
}

/** 让 performance.now() 返回可控的值 */
export function withFakePerf<T>(startMs: number, fn: (set: (ms: number) => void) => T): T {
  const original = performance.now
  let current = startMs
  try {
    performance.now = () => current
    return fn((ms: number) => {
      current = ms
    })
  } finally {
    performance.now = original
  }
}
