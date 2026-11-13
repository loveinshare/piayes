// Web MIDI 输入 (接 Roland 电钢后用)
// 解析 status byte: 0x9n = Note On, 0x8n = Note Off

import type { IInput, NoteEvent } from '../types'

export class MidiInput implements IInput {
  onEvent: ((e: NoteEvent) => void) | null = null
  /** 设备列表变化时通知 UI 刷新 (热插拔) */
  onListChange: ((list: { id: string; name: string }[]) => void) | null = null

  private access: MIDIAccess | null = null
  private selectedId: string | null = null
  private bound = new Map<string, (e: MIDIMessageEvent) => void>()
  /**
   * running status: 上一条状态字节.
   * 很多设备在同一通道连续发送时会省略状态字节 ——
   * 旧实现把它当「非法长度 < 2」直接 return, 整个音丢了 (spec P1-7).
   */
  private lastStatus = 0
  /** 延音踏板 (CC64) 状态 */
  private sustain = false
  /** 当前按住的 note (midi → channel) —— 断连/停止时用来释放 */
  private active = new Map<number, number>()

  async start() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI API not supported')
    }
    // Idempotent against re-call from InputBus.use():
    //   - request MIDIAccess only on first call (browsers dedupe permission
    //     grants but we want onstatechange assigned exactly once)
    //   - always rebind() + notifyList() so a fresh bus.use() cycle re-attaches
    //     midimessage listeners after stop() removed them
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess({ sysex: false })
      this.access.onstatechange = () => {
        this.rebind()
        this.notifyList()
      }
    }
    this.rebind()
    this.notifyList()
  }

  private notifyList() {
    this.onListChange?.(this.list())
  }

  stop() {
    for (const [, fn] of this.bound) {
      for (const input of this.access?.inputs.values() ?? []) {
        input.removeEventListener('midimessage', fn)
      }
    }
    this.bound.clear()
    // 切设备/停止时释放所有按住的键 —— 否则灯会卡在按住状态
    this.releaseAll()
  }

  /** 延音踏板是否按下 */
  isSustainOn() {
    return this.sustain
  }

  /** 当前按住的 note 集合 (调试/清理用) */
  activeNotes(): number[] {
    return [...this.active.keys()]
  }

  list(): { id: string; name: string }[] {
    if (!this.access) return []
    const inputs: { id: string; name: string }[] = []
    for (const i of this.access.inputs.values()) {
      if (i.name?.toLowerCase().includes('through')) continue
      inputs.push({ id: i.id, name: i.name ?? 'Unknown' })
    }
    return inputs
  }

  use(id: string | null) {
    this.selectedId = id
    this.rebind()
  }

  private rebind() {
    if (!this.access) return
    // 解绑旧的
    for (const [, fn] of this.bound) {
      for (const input of this.access.inputs.values()) {
        input.removeEventListener('midimessage', fn)
      }
    }
    this.bound.clear()
    // 绑新的
    for (const input of this.access.inputs.values()) {
      if (this.selectedId && input.id !== this.selectedId) continue
      if (input.name?.toLowerCase().includes('through')) continue
      const handler = (e: MIDIMessageEvent) => this.onMessage(e)
      input.addEventListener('midimessage', handler)
      this.bound.set(input.id, handler)
    }
  }

  private onMessage(e: MIDIMessageEvent) {
    const data = e.data
    if (!data || data.length === 0) return
    // 保留浏览器给的硬件时间戳 —— 旧实现用 performance.now() 覆盖了它,
    // 把硬件时间戳的优势丢了 (spec P1-7). 部分环境不会给 timeStamp, 那时回退到 performance.now().
    const t = typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : performance.now()

    // running status: 1 字节消息复用上一条状态字节
    let status = data[0]
    let d1: number | undefined
    let d2: number | undefined
    if (status < 0x80) {
      if (this.lastStatus === 0) return
      status = this.lastStatus
      d1 = data[0]
      d2 = data[1]
    } else {
      this.lastStatus = status
      d1 = data[1]
      d2 = data[2]
    }
    if (d1 === undefined) return

    const cmd = status & 0xf0
    const vel = d2 ?? 0
    if (cmd === 0x90 && vel > 0) {
      this.active.set(d1, status & 0x0f)
      this.onEvent?.({
        type: 'down',
        midi: d1,
        velocity: vel,
        t,
        source: 'input',
      })
    } else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) {
      this.active.delete(d1)
      this.onEvent?.({
        type: 'up',
        midi: d1,
        t,
        source: 'input',
      })
    } else if (cmd === 0xb0) {
      this.handleControl(d1, vel)
    }
  }

  /** 控制器事件 (0xB0): 踏板 + All Sound/Notes Off */
  private handleControl(cc: number, value: number) {
    if (cc === 64) {
      // 踏板: 值 >= 64 视为按下
      this.sustain = value >= 64
      return
    }
    if (cc === 120 || cc === 123) {
      // All Sound Off / All Notes Off —— 释放所有按住的键
      this.releaseAll()
    }
  }

  /** 释放所有按住的键 (断连 / 停止 / All Notes Off) */
  private releaseAll() {
    if (this.active.size === 0) return
    const t = performance.now()
    for (const midi of [...this.active.keys()]) {
      this.active.delete(midi)
      this.onEvent?.({ type: 'up', midi, t, source: 'input' })
    }
  }
}
