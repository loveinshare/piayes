// 单手模式下, 把"非活动手"的 note 通过 MIDI Out 发到电钢
// 参考 sightread/src/features/midi/index.tsx 的 pressOutput / releaseOutput
//
// 关键: sendNoteOff 必须由 Player.loop() 显式驱动, 不准用 setTimeout
//      暂停/seek 时也要主动扫一遍发 note off, 否则电钢 note 一直响

import type { SongNote } from '../types'

export class Accompaniment {
  /** 设备列表变化时通知 UI 刷新 (热插拔) */
  onListChange: ((list: { id: string; name: string }[]) => void) | null = null

  private access: MIDIAccess | null = null
  private output: MIDIOutput | null = null
  /** 用户选中的输出端口 id —— 设备被拔掉后仍保留, 用于自动重绑 (见 refresh). */
  private outputId: string | null = null
  private enabled = false
  /**
   * 输出端口**运行时**是否真的连着.
   * 与 outputId (用户的选择) 分开 —— 设备被拔掉时 outputId 还留着,
   * 但这里变 false, UI 据此把「电钢」标成断开 (spec P1-12).
   */
  private connected = false
  /** 连接状态变化通知 (true=连上, false=断开) —— App 转发到 store */
  onConnectionChange: ((connected: boolean) => void) | null = null
  /** 移调半音 (-12..+12). 发送时把 midiNote 加上此值 */
  transpose = 0
  /** 0..1 主音量, 缩放发送 velocity (与 UI volume slider 联动) */
  volume = 1
  /**
   * 当前还在电钢上按着的 note: midi → channel.
   * 参照 neothesia 的 active_notes (refs/neothesia/.../midi_backend.rs:19,69-74,85-100) ——
   * panic 时逐个发显式 NoteOff, 不依赖设备的 "All Notes Off" 状态位 (spec P0-4).
   */
  /**
   * 当前还在电钢上按着的 note: midi → { channel, when }.
   *
   * when = 该 NoteOn 被排程到的 ctx 时刻 (spec P1-2 lookahead).
   * 提前排程的 NoteOn 必须配一个**不早于它**的 NoteOff —— 否则设备上会卡键
   * (NoteOff 先到, 之后 NoteOn 再到 → 键一直压住, 除非再来一次 panic).
   */
  private activeNotes = new Map<number, { channel: number; when?: number }>()
  /**
   * 本次会话里 app 真的往这个输出发过音没有.
   * 用来给 silence() 把关: both 模式 app 一个音都不发, 这时不该动用户的电钢.
   */
  private sentAnyNote = false
  /**
   * panic 递归保护.
   * trySend 失败 → panic() → trySend 失败 → panic() ... 不加这个标志位会无限递归
   * (spec P0-4 / spec §5.3).
   */
  private panning = false

  /**
   * AudioContext —— 只用来做两件事:
   *  1. 把"过去的时刻"夹到现在 (Web MIDI 的 timestamp 早于 currentTime 会抛错);
   *  2. 供 Player 计算 lookahead 的 when.
   */
  private ctx: AudioContext | null = null

  /**
   * MIDI 通道 (0-15). 罗兰默认收 ch=0 (实测, 参见 docs/roland-midi-notes.md §3).
   * 想做左右手分道 (neothesia 的 separate_channels) 时把它设成 1 即可.
   */
  channel = 0

  /** Program Change (0-127); null = 不发 */
  program: number | null = null

  /**
   * 设备是否支持 Web MIDI 的 timestamp 参数.
   * Chrome 支持 (send(data, timestamp)); Safari 不支持 —— 传了会抛.
   * 探测一次就记住, 之后一直走回退路径.
   */
  private timestampSupported = true

  /** 关联 AudioContext (Player 创建时调) */
  attachContext(ctx: AudioContext | null) {
    this.ctx = ctx
  }

  /** 申请 MIDI 权限, 列出可用输出
   *  注意: 每次 connect() 都会拿到一个新的 MIDIAccess, 旧 `output` 引用属于被释放的旧 access,
   *  再调 send() 会 no-op / 抛错. 因此 connect() 第一件事就是清掉旧 output/enabled,
   *  强制后续 use(id) 重新在新 access 里查表.
   */
  async connect() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI API not supported')
    }
    // 旧 access 上的 output 已失效 — 先 panic 旧端口, 再清状态
    if (this.output) {
      try { this.panic() } catch {}
    }
    this.output = null
    this.outputId = null
    this.enabled = false
    this.setConnected(false)
    this.access = await navigator.requestMIDIAccess({ sysex: false })
    this.access.onstatechange = () => {
      this.refresh()
      this.onListChange?.(this.list())
    }
    this.refresh()
    this.onListChange?.(this.list())
    return this.list()
  }

  /**
   * 包装 send(): 设备中途掉线时单条 send 会抛 / no-op, 不让 Player 帧崩.
   *
   * when = ctx 时间轴上的排程时刻 (spec P1-2 lookahead):
   *   - 支持 timestamp 的浏览器 (Chrome): 消息在那个时刻才真正发出去;
   *   - 不支持的 (Safari): 传了会抛 —— 探测一次就永久回退成立即发送.
   */
  private trySend(bytes: number[], when?: number): boolean {
    if (!this.output) return false
    const ts = this.effectiveWhen(when)
    try {
      if (ts !== undefined && this.timestampSupported) {
        this.output.send(bytes, ts)
      } else {
        this.output.send(bytes)
      }
      return true
    } catch (e) {
      // Safari: send(data, timestamp) 直接抛 —— 标记不支持并回退重发一次
      if (ts !== undefined && this.timestampSupported) {
        this.timestampSupported = false
        try {
          this.output.send(bytes)
          return true
        } catch {
          // 还是失败 → 落到下面的断连处理
        }
      }
      console.warn('[midi-out] send failed, treating as disconnect', e)
      // 出错 = 端口已死, 清掉并通知重连
      try { this.panic() } catch {}
      this.handleDisconnect()
      return false
    }
  }

  /** 把排程时刻夹到"不早于现在" —— 过去的 timestamp 在 Web MIDI 里是非法的 */
  private effectiveWhen(when?: number): number | undefined {
    if (when === undefined) return undefined
    if (!this.ctx) return undefined
    return when < this.ctx.currentTime ? undefined : when
  }

  private refresh() {
    // 如果当前 output 断开, panic 一把然后清掉
    if (this.output && this.output.state !== 'connected') {
      // 输出端卡住的 note 必须先停 (防止电钢里头一直响)
      try { this.panic() } catch {}
      this.handleDisconnect()
    }
    // 设备被拔掉又插回来 → 用之前记住的选择自动重绑 (用户不用再选一次).
    // 只在 statechange 时走这条路 (refresh 的另一个调用点); send 失败导致的
    // handleDisconnect 不经过这里, 免得端口真死了还反复重绑造成抖动.
    if (!this.output && this.outputId && this.access) {
      const o = [...this.access.outputs.values()].find((x) => x.id === this.outputId)
      if (o && o.state === 'connected') {
        this.output = o
        this.setConnected(true)
        this.resetDeviceState()
      }
    }
  }

  /** 输出设备断开/丢失事件 (App 用来 re-prompt 弹窗) */
  onDisconnect: (() => void) | null = null

  /**
   * 设备掉线的统一处理: 清端口 + 标断开 + 通知 UI.
   * 幂等 —— 只在「本来还连着」的时候报一次:
   * trySend 失败 -> panic() -> panic 内部第一条 trySend 也失败 -> 里面已经报过,
   * 外层再报一次就会让 App 弹两次重连弹窗 (spec P1-12).
   */
  private handleDisconnect() {
    const wasConnected = this.output !== null
    this.output = null
    this.setConnected(false)
    if (wasConnected) this.onDisconnect?.()
  }

  list(): { id: string; name: string }[] {
    if (!this.access) return []
    const outs: { id: string; name: string }[] = []
    for (const o of this.access.outputs.values()) {
      // 跳过 thru 端口 (避免自激反馈)
      if (o.name?.toLowerCase().includes('through')) continue
      outs.push({ id: o.id, name: o.name ?? 'Unknown' })
    }
    return outs
  }

  /** 选中一个输出, 后续所有 sendNote* 都走它 */
  use(id: string | null) {
    // Always panic the previous output before rebinding so the old device
    // doesn't keep ringing notes that belong to a different channel.
    // 关掉伴奏 (id === null) 时也必须 panic —— 旧实现只在 id 不同时才 panic,
    // 切到 null 会漏掉, 电钢上的音会一直响 (spec P0-4).
    if (this.output && (this.output.id !== id || id === null)) {
      try { this.panic() } catch {}
    }
    this.outputId = id
    this.output = null
    this.enabled = !!id
    this.setConnected(false)
    if (!id || !this.access) return
    for (const o of this.access.outputs.values()) {
      if (o.id === id) {
        this.output = o
        this.setConnected(true)
        this.resetDeviceState()
        return
      }
    }
  }

  /**
   * 绑定设备后复位它的状态 (spec P2-9).
   *
   * 换设备 / 首次连接时, 设备上可能还留着上一次的音色、踏板、控制器状态 ——
   * 发 CC#121 (Reset All Controllers) + Program Change, 让状态变成可预期的.
   * 顺带补上 neothesia 的 separate_channels 能力: channel 可配.
   */
  private resetDeviceState() {
    if (!this.output) return
    const ch = this.channel & 0x0f
    try {
      this.output.send([0xb0 | ch, 121, 0]) // Reset All Controllers
      if (this.program !== null) {
        this.output.send([0xc0 | ch, this.program & 0x7f])
      }
    } catch {
      // 复位是"锦上添花" —— 设备本来就不通 (或刚好被拔掉) 时不该在这里判定断连,
      // 让真正的 send 失败去走 handleDisconnect, 免得刚选中就弹重连提示.
    }
  }

  isEnabled() {
    return this.enabled && this.output !== null
  }

  // 连接状态变化 (幂等) - 通知 UI
  private setConnected(v: boolean) {
    if (this.connected === v) return
    this.connected = v
    this.onConnectionChange?.(v)
  }

  // 输出端口当前是否真的可用
  isConnected() {
    return this.connected
  }

  /** UI volume slider 同步过来: 0..1, 缩放发送的 velocity */
  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v))
  }

  sendNoteOn(n: SongNote, when?: number) {
    const status = 0x90 | this.channel
    const midi = n.midiNote + this.transpose
    const vel = Math.round((n.velocity ?? 0.8) * this.volume * 127)
    if (!this.trySend([status, midi, vel], when)) return
    this.activeNotes.set(midi, { channel: this.channel, when })
    this.sentAnyNote = true
  }

  sendNoteOff(n: SongNote) {
    const status = 0x80 | this.channel
    const midi = n.midiNote + this.transpose
    const rec = this.activeNotes.get(midi)
    this.activeNotes.delete(midi)
    // NoteOn 是提前排程的 → NoteOff 必须不早于它, 否则设备上会卡键
    // (NoteOff 先到, 之后 NoteOn 再到 → 键一直压住).
    const when =
      rec?.when !== undefined && this.ctx && rec.when > this.ctx.currentTime
        ? rec.when
        : undefined
    this.trySend([status, midi, 0], when)
  }

  /**
   * 立刻掐掉所有正在发声的音 (CC#120 All Sound Off) —— **不动踏板/控制器状态**.
   *
   * 与 panic() 的分工:
   *  - silence(): 「暂停」用. 语义对齐 synth.stopAll() —— 浏览器合成器的音
   *    暂停时被 stopAll() 掐掉, 电钢这边也该一样. 不碰 CC#64, 所以用户自己
   *    按住不放的键和踏板状态不受影响.
   *  - panic(): 「设备切走 / 断连 / 页面隐藏」用. 那种场景用户不可能在弹,
   *    所以可以连延音踏板一起断、连控制器一起复位.
   *
   * 只有 app 真的往这个输出发过音才发 (both 模式一个音都不发 → 不该动用户的电钢).
   */
  silence() {
    if (this.panning) return
    if (!this.output) return
    if (!this.sentAnyNote) return
    this.panning = true
    try {
      for (let ch = 0; ch < 16; ch++) {
        this.trySend([0xB0 | ch, 120, 0]) // All Sound Off
      }
      for (const [midi, rec] of this.activeNotes) {
        this.trySend([0x80 | rec.channel, midi, 0])
      }
      this.activeNotes.clear()
    } finally {
      this.panning = false
    }
    this.sentAnyNote = false
  }

  /**
   * 异常路径兜底: 彻底静音, 防止罗兰里卡音。
   *
   * 旧实现只发 CC#123 (All Notes Off) —— **它不关延音踏板 (CC#64)**,
   * 踏板踩着时被 All Notes Off 释放的音仍由踏板维持 → 电钢上一直响 (spec P0-4).
   * 现在按 MIDI 规范依次发:
   *   1) CC#120 (All Sound Off)   —— 立刻掐掉所有正在发声的音
   *   2) CC#64  = 0 (Sustain Off) —— 断延音踏板
   *   3) CC#121 (Reset All Ctrl)  —— 复位其它控制器 (含 Sostenuto)
   *   4) 对每个还在响的 key 发显式 NoteOff —— 不依赖设备状态位 (同 neothesia active_notes)
   *
   * 注意: 暂停/seek 走的是 Player.stopSounds() 的显式 NoteOff, **不发这些全局 CC** ——
   * 电钢的 MIDI Out 与本地键盘是同一个音色引擎, CC#120 会连用户自己弹的音一起掐掉.
   * 任何「可能正在响」的不确定时刻都应调用:
   *  - 切到「关闭伴奏」
   *  - 浏览器 pagehide / beforeunload
   *  - WebMIDI 断开
   */
  panic() {
    if (this.panning) return // 打断 trySend → panic → trySend 的递归
    if (!this.output) return
    this.panning = true
    try {
      for (let ch = 0; ch < 16; ch++) {
        this.trySend([0xB0 | ch, 120, 0]) // All Sound Off
        this.trySend([0xB0 | ch, 64, 0]) // Sustain Off
        this.trySend([0xB0 | ch, 121, 0]) // Reset All Controllers
      }
      // 显式关掉每一个还在响的音 —— 踏板/设备状态位都不靠谱
      for (const [midi, rec] of this.activeNotes) {
        this.trySend([0x80 | rec.channel, midi, 0])
      }
      this.activeNotes.clear()
    } finally {
      this.panning = false
    }
    this.sentAnyNote = false
  }
}
