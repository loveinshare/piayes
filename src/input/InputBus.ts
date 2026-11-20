// InputBus: 统一事件流
// Player 只看 InputBus, 不直接接 KeyboardInput / MidiInput
// 切换输入源 = InputBus.use(new KeyboardInput() / new MidiInput())
//
// 多订阅者: Player 是主订阅者 (setHandler), LED 跟随等次要订阅者用
// addHandler 追加. 事件 fan-out 到所有订阅者.

import type { IInput, NoteEvent } from '../types'

export class InputBus {
  private current: IInput | null = null
  private handler: ((e: NoteEvent) => void) | null = null
  private extras: Array<(e: NoteEvent) => void> = []

  /** Player 调用: 注册主回调 (单实例, 后注册覆盖前注册) */
  setHandler(fn: (e: NoteEvent) => void) {
    this.handler = fn
  }

  /** 次要订阅者 (e.g. LED 跟随). 可多次调用, 都收到事件. */
  addHandler(fn: (e: NoteEvent) => void): () => void {
    this.extras.push(fn)
    return () => {
      const i = this.extras.indexOf(fn)
      if (i >= 0) this.extras.splice(i, 1)
    }
  }

  /** 切换输入源 (键盘 / MIDI 输入, 来自 IInput 物理设备, 标 source='input') */
  use(input: IInput) {
    this.current?.stop()
    this.current = input
    input.onEvent = (e) => {
      const tagged = e.source ? e : { ...e, source: 'input' as const }
      this.handler?.(tagged)
      for (const fn of this.extras) fn(tagged)
    }
    input.start()
  }

  /** 直接发一个事件 (用于 LED 播放事件等, 已带 source) */
  emit(e: NoteEvent) {
    this.handler?.(e)
    for (const fn of this.extras) fn(e)
  }

  stop() {
    this.current?.stop()
    this.current = null
  }

  getCurrent(): IInput | null {
    return this.current
  }
}
