// 倒计时模块: 3 -> 2 -> 1 -> GO -> 完成
// start() 一次性启动; 完成后由 onDone 回调通知 App, App 再调用 Player.play()
//
// 用 setInterval 1s 步进; 用户也可中途 cancel()

export type CountdownStep = 3 | 2 | 1 | 0
type Listener = (step: CountdownStep | null) => void

export class Countdown {
  private timer: number | null = null
  /**
   * 「GO」之后那个 1 秒收尾定时器.
   * 以前没存 id —— cancel() 只 clearInterval, 那个 setTimeout 照样会触发 finish()
   * → cb?.() → Player.play() → **倒计时被取消了却自己开始播** (spec P2-12).
   */
  private finishTimer: number | null = null
  private step: CountdownStep = 3
  private listeners = new Set<Listener>()
  private onDone: (() => void) | null = null
  private isActive = false

  /** 启动一次倒计时; onDone 在显示 "GO" 1 秒后调用 */
  start(onDone: () => void) {
    this.cancel()
    this.onDone = onDone
    this.step = 3
    this.isActive = true
    this.emit()
    this.timer = window.setInterval(() => this.tick(), 1000)
  }

  private tick() {
    if (this.step === 0) {
      this.finish()
      return
    }
    this.step = (this.step - 1) as CountdownStep
    this.emit()
    if (this.step === 0) {
      this.finishTimer = window.setTimeout(() => {
        this.finishTimer = null
        this.finish()
      }, 1000)
      if (this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  private finish() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
    const cb = this.onDone
    this.onDone = null
    this.isActive = false
    this.emit()
    cb?.()
  }

  cancel() {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
    this.onDone = null
    this.isActive = false
    this.step = 3
    this.emit()
  }

  /** 订阅 step 变化; 返回 unsub 函数 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    const v: CountdownStep | null = this.isActive ? this.step : null
    for (const l of this.listeners) l(v)
  }
}
