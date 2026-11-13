// 歌曲时钟 (spec P1-2 / P1-3)
//
// 项目里同时存在三套时间域, 过去各算各的, 是"判定跟不准"的根因:
//
//   perf 域 —— performance.now() / DOMHighResTimeStamp
//              输入事件 (MIDI 硬件时间戳)、UI 帧
//   ctx  域 —— AudioContext.currentTime
//              音频排程时间轴 (音符真正什么时候从设备发出去)
//   song 域 —— 乐曲时间 (跟曲谱对齐, 秒)
//
// 旧实现的问题 (spec P1-3):
//   1. song 域是用 setInterval 累加出来的逻辑时间 —— 主线程一卡就漂, 播几分钟
//      之后判定时钟跟音频时钟能差几十毫秒, 用户"跟得很准"却被判早/晚;
//   2. 输入事件用 performance.now() 在**处理时**才取时间 —— 事件在队列里等了
//      多久, 判定误差就有多大 (主线程忙的时候 10~50ms);
//   3. 输出延迟 (蓝牙耳机 100~200ms) 没有任何建模.
//
// 本模块的职责:
//   - song 域直接锚定到 ctx 域 (音频时钟) —— 不再累加, 不再漂;
//   - 输入的硬件时间戳 → song 域, 判定精度不再受主线程抖动影响;
//   - 测量输出延迟, 并提供"按听到的声音对齐"的可选补偿.
//
// 关于输出延迟补偿 (重要, 别当成 bug):
//   判定发生在 practice 模式, 而 practice 模式下**被判定的那只手是不发声的**
//   (routeFor → silent), 用户靠**画面**(下落音符 / 乐谱)对齐, 画面在 song 域,
//   没有延迟. 所以默认补偿 = 0 (视觉对齐).
//   戴蓝牙耳机、习惯"听伴奏对齐"的用户可以打开自动补偿 ——
//   那是把判定从视觉域搬到听觉域, 两者不能同时满足.

export interface ClockOptions {
  /** 真实 AudioContext; 没有则退化成逻辑时钟 (测试 / ctx 被挂起) */
  ctx?: AudioContext | null
  /** 注入 perf↔ctx 偏移 (ms) —— 测试用, 注入后不再自动采样 */
  perfOffsetMs?: number
}

export class SongClock {
  private ctx: AudioContext | null
  private speed = 1
  /**
   * 速度**倍率** (跟 speed 分开).
   *
   * speed = 用户设的倍速 (夹在 [0.25, 2]); rate = 抢先模式跟着玩家走的加速倍率
   * (1 = 原速, 2 = 两倍速). 分开是因为 speed 有夹取 —— 用户倍速 1.2 时,
   * 「两倍速」应该是 2.4 而不是被夹回 2.
   */
  private rate = 1
  /** 锚点: song 时间 (秒) */
  private anchorSong = 0
  /** 锚点: ctx 时间 (秒) */
  private anchorCtx = 0
  /** 主时钟模式: ctx = 音频时钟 (不漂), logical = 逻辑累加 (无 ctx 时) */
  private mode: 'ctx' | 'logical' = 'logical'
  /** perf↔ctx 偏移 (ms): perfTime ≈ ctxTime * 1000 + perfOffset */
  private perfOffset = 0
  /** 测试注入的偏移 —— 注入后不再自动采样 */
  private injectedOffset: number | null = null
  /** 检测到的输出延迟 (ms) */
  private latencyMs = 0
  /** 用户设置的补偿 (ms) —— 0 = 不补偿 (视觉对齐) */
  private latencyCompMs = 0
  private lastSampleAt = 0

  constructor(opts: ClockOptions = {}) {
    this.ctx = opts.ctx ?? null
    if (typeof opts.perfOffsetMs === 'number' && Number.isFinite(opts.perfOffsetMs)) {
      this.injectedOffset = opts.perfOffsetMs
      this.perfOffset = opts.perfOffsetMs
    }
    this.anchor(0)
  }

  /** 底层 AudioContext (可能为 null) */
  get context(): AudioContext | null {
    return this.ctx
  }

  /** 当前是否跑在音频时钟上 (false = 逻辑时钟, 判定会退化) */
  get isAudioBacked(): boolean {
    return this.mode === 'ctx'
  }

  /**
   * 重新锚定到指定歌曲时间.
   * seek / 冻结 / 解冻 / 变速 都要调它 —— 锚点一变, song↔ctx 的映射就重算.
   */
  anchor(songTime: number) {
    this.anchorSong = songTime
    this.anchorCtx = this.ctx ? this.ctx.currentTime : 0
    // 锚点是在"此刻"取的 —— 主时钟模式也该跟着此刻的 ctx 状态走
    this.mode = this.desiredMode()
  }

  /** 变速 —— 重新锚定以保持歌曲位置连续 */
  setSpeed(speed: number) {
    const s = Math.max(0.25, Math.min(2, speed))
    if (s === this.speed) return
    const now = this.songTime()
    this.speed = s
    this.anchor(now)
  }

  /**
   * 速度倍率 (抢先模式的加速) —— 重新锚定以保持歌曲位置连续.
   *
   * 跟 speed **相乘**: 实际速度 = speed × rate. 夹取范围比 speed 宽,
   * 因为 rate 表达的是「相对用户倍速的加速倍数」.
   */
  setRate(rate: number) {
    const r = Math.max(0.25, Math.min(4, rate))
    if (r === this.rate) return
    const now = this.songTime()
    this.rate = r
    this.anchor(now)
  }

  /** 当前的速度倍率 */
  getRate(): number {
    return this.rate
  }

  /** 当前歌曲时间 (秒) */
  songTime(): number {
    if (this.mode === 'ctx' && this.ctx) {
      return (
        this.anchorSong + (this.ctx.currentTime - this.anchorCtx) * this.speed * this.rate
      )
    }
    return this.anchorSong
  }

  /**
   * 推进一帧.
   * - 音频时钟模式: 主时钟是 ctx, dt 被忽略 (主线程抖动**不会**传导到音乐时间);
   * - 逻辑时钟模式: 按 dt 累加 (测试里手动 stepLoop 就是靠它推进时间).
   *
   * ★ 2026-11-06: 逻辑时钟模式下 dt 必须是**真实经过的时间** (由调用方量),
   *   不能是"假定每帧 16ms" —— 浏览器会把后台标签页的定时器压到 1s 一次,
   *   按 16ms 累加的话整首曲子会慢几十倍 (退路本身就成了 bug).
   */
  advance(dt: number): number {
    const want = this.desiredMode()
    if (want !== this.mode) {
      // 模式切换 —— 以当前歌曲时间为新锚点, 避免跳变
      const now = this.songTime()
      this.mode = want
      this.anchor(now)
      // ctx 挂起/恢复过 → perf 与 ctx 的相对偏移已经变了 (perf 一直走, ctx 冻住).
      // 把采样节流清掉, 下一帧强制重采样 —— 否则恢复后最长 250ms 内的按键
      // 会用旧偏移换算, 判定凭空偏掉一截.
      this.lastSampleAt = 0
    }
    if (this.mode === 'ctx') return this.songTime()
    this.anchorSong += dt * this.rate
    return this.anchorSong
  }

  /** 歌曲时间 → ctx 时间 (秒); 没有 ctx 时返回 null */
  toCtxTime(songTime: number): number | null {
    if (!this.ctx) return null
    return this.anchorCtx + (songTime - this.anchorSong) / (this.speed * this.rate)
  }

  /** ctx 时间 (秒) → 歌曲时间 */
  toSongTime(ctxTime: number): number {
    return this.anchorSong + (ctxTime - this.anchorCtx) * this.speed * this.rate
  }

  /**
   * 输入事件的 perf 时间戳 → 歌曲时间 (秒).
   * 这是判定精度的关键: 用**硬件时间戳**而不是"事件被处理的那一刻".
   */
  pressSongTime(pressPerfMs: number): number {
    if (!this.ctx || this.mode !== 'ctx') return this.songTime()
    if (!Number.isFinite(pressPerfMs) || pressPerfMs <= 0) return this.songTime()
    this.sampleOffset()
    // 补偿方向: 负向平移 —— 听到声音的时刻比排程时刻晚 L, 用户"跟声音弹"
    // 就会比 song 域晚 L 毫秒, 减掉 L 才能让 delta 归零.
    const pressCtx = (pressPerfMs - this.perfOffset - this.latencyCompMs) / 1000
    return this.toSongTime(pressCtx)
  }

  /** 检测到的输出延迟 (ms) */
  outputLatencyMs(): number {
    this.sampleOffset()
    return this.latencyMs
  }

  /** 设置输出延迟补偿 (ms); 负数 = 用自动检测值 */
  setLatencyCompensation(ms: number) {
    if (ms < 0) {
      this.sampleOffset()
      this.latencyCompMs = this.latencyMs
    } else {
      this.latencyCompMs = Math.max(0, Math.min(1000, ms))
    }
  }

  /** 当前生效的补偿 (ms) */
  latencyCompensation(): number {
    return this.latencyCompMs
  }

  private desiredMode(): 'ctx' | 'logical' {
    // ctx 必须真的在跑 —— 被挂起时 currentTime 不动, 用它当主时钟会卡住整首歌
    return this.ctx && this.ctx.state === 'running' ? 'ctx' : 'logical'
  }

  /** 采样 perf↔ctx 偏移与输出延迟 (最多 4Hz) */
  private sampleOffset() {
    const ctx = this.ctx
    if (!ctx) return
    // 输出延迟跟输出设备有关 (蓝牙/有线/扬声器各不相同), 每次都重新读.
    // 注意: 它跟注入的 perf↔ctx 偏移是两回事 —— 注入只锁偏移, 不锁延迟.
    const ol = (ctx as unknown as { outputLatency?: number }).outputLatency
    const bl = ctx.baseLatency
    const sec =
      typeof ol === 'number' && ol > 0 ? ol : typeof bl === 'number' && bl > 0 ? bl : 0
    this.latencyMs = sec * 1000
    if (this.injectedOffset !== null) return
    const now = performance.now()
    if (this.lastSampleAt > 0 && now - this.lastSampleAt < 250) return
    this.lastSampleAt = now
    // 调度域映射: 现在排程的声音对应哪个 perf 时刻
    this.perfOffset = now - ctx.currentTime * 1000
  }
}
