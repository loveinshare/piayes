// 钢琴发声 —— 优先用采样钢琴 (Salamander Grand Piano v3, 见 src/engine/PianoSampler.ts),
// 采样还没加载好 / 加载失败时退回加法合成, 保证任何时候都有声音.
//
// 加法合成 (兜底) 的信号链:
//   osc1 (基频, 1.0) ─┐
//   osc2 (2x, 0.45)   │
//   osc3 (3x, 0.20)   ├── main gain (envelope) ── filter (lowpass, brightness) ── destination
//   osc4 (4x, 0.10)   │
//
// 包络 (钢琴特征):
//   attack  ~5ms    linear ramp to peak
//   hammer  ~200ms  exponential ramp to peak * 0.4 (锤子反弹)
//   body    decay  exponential ramp to peak * 0.2
//   release ~400ms  exponential to ~0
//
// 滤波器模拟"高频随时间流失"的钢琴特性: 起始 freq * 8, 0.4s 内降到 freq * 3

import type { SongNote } from '../types'
import { PianoSampler, type SamplerVoice } from './PianoSampler'

interface Voice {
  /** 音高 (已含 transpose) */
  midi: number
  /**
   * 声部 id.
   * 同一个 midi 可能有多个声部同时响 —— BWV1041 这类曲目左右手同名音并存,
   * 只按 midi 记账会把先响的那个掐掉, 听起来像断奏 (spec P1-13).
   */
  id: number
  /** 声部唯一标识 —— 同一个 midi 可能挂多个声部, 靠它精确移除 */
  token: object
  /** 加法合成的节点 (采样路径为空) */
  mainGain?: GainNode
  oscs?: OscillatorNode[]
  /** 采样声部句柄 (加法合成路径为空) */
  sampler?: SamplerVoice
}

export class Synthesizer {
  private ctx: AudioContext
  /** midi -> 该音高上正在响的 voice 列表 (同 midi 可多声部, 见 P1-13) */
  private active = new Map<number, Voice[]>()
  private masterVolume = 0.6
  /** 采样钢琴 —— 加载完成后才有, 之前用加法合成 */
  private sampler: PianoSampler | null = null

  constructor() {
    this.ctx = new (window.AudioContext ||
      (window as any).webkitAudioContext)()
    void this.loadSampler()
  }

  /**
   * 后台拉采样 (30 个 mp3, ~2MB) 并解码.
   * 失败不报错 —— 保持加法合成, 用户照样能听.
   */
  private async loadSampler() {
    // 假 AudioContext (测试环境) 没有 decodeAudioData —— 直接跳过
    if (typeof this.ctx.decodeAudioData !== 'function') return
    try {
      const sampler = await PianoSampler.create(this.ctx)
      if (!sampler.ready) return
      sampler.setVolume(this.masterVolume)
      this.sampler = sampler
    } catch (err) {
      console.warn('[synth] 采样钢琴加载失败, 继续用加法合成:', err)
    }
  }

  resume() {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }
  }

  /** 0..1 主音量 */
  setMasterVolume(v: number) {
    this.masterVolume = Math.max(0, Math.min(1, v))
    // 采样路径: 主音量在采样器的总增益上, 正在响的音一起变
    this.sampler?.setVolume(this.masterVolume)
    // 已在响的音, fade 到新音量
    for (const list of this.active.values()) {
      for (const { mainGain } of list) {
        if (!mainGain) continue
        mainGain.gain.cancelScheduledValues(this.ctx.currentTime)
        mainGain.gain.linearRampToValueAtTime(
          this.masterVolume,
          this.ctx.currentTime + 0.05,
        )
      }
    }
  }

  getCtx(): AudioContext {
    return this.ctx
  }

  /**
   * Play a note. transpose 半音数 (用于移调练习).
   * voiceId 区分同音高的不同声部 (Player 传 song note 的下标).
   * 同一 (midi, voiceId) re-trigger 时先 stop 旧的避免叠音糊掉;
   * 不同 voiceId 的同名音各自独立存在 (P1-13).
   * when = ctx 时间轴上的发声时刻 (spec P1-2 lookahead).
   *   提前排程 → 声音精确落在 note.time 对应的时刻, 不受主线程抖动影响.
   */
  playNote(n: SongNote, transpose = 0, voiceId = 0, when?: number) {
    const midi = n.midiNote + transpose
    this.stopNote(midi, voiceId)
    const freq = 440 * Math.pow(2, (midi - 69) / 12)
    // 排程时刻早于"现在" → 退化成立即发声 (宁可晚一点, 也不能排到过去)
    const now = when !== undefined ? Math.max(when, this.ctx.currentTime) : this.ctx.currentTime
    const vel = Math.max(0.1, Math.min(1, n.velocity ?? 0.8))

    // 采样钢琴 —— 加载好了就用真的钢琴采样
    const samplerVoice = this.sampler?.play(midi, vel, n.duration, now) ?? null
    if (samplerVoice) {
      const voice: Voice = { midi, id: voiceId, token: {}, sampler: samplerVoice }
      this.trackVoice(voice)
      setTimeout(() => this.removeVoice(voice), (n.duration + 0.5) * 1000 + 50)
      return
    }

    // 谐波权重: 基频强, 越高越弱
    const harmonics = [
      { mult: 1, amp: 1.0 },
      { mult: 2, amp: 0.45 },
      { mult: 3, amp: 0.2 },
      { mult: 4, amp: 0.1 },
    ]

    // main gain (钢琴包络)
    const mainGain = this.ctx.createGain()
    mainGain.gain.setValueAtTime(0, now)

    // 低通滤波器: 起始亮, 随时间变暗 (钢琴特征)
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = 0.5
    const startCutoff = Math.min(Math.max(freq * 8, 800), 12000)
    const endCutoff = Math.min(Math.max(freq * 3, 500), 6000)
    filter.frequency.setValueAtTime(startCutoff, now)
    filter.frequency.exponentialRampToValueAtTime(endCutoff, now + 0.4)

    mainGain.connect(filter).connect(this.ctx.destination)

    const oscs: OscillatorNode[] = []
    const totalDur = n.duration + 0.5
    for (const h of harmonics) {
      const osc = this.ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq * h.mult

      const hgain = this.ctx.createGain()
      hgain.gain.value = h.amp

      osc.connect(hgain).connect(mainGain)
      osc.start(now)
      osc.stop(now + totalDur)
      oscs.push(osc)
    }

    // 钢琴包络
    const peak = vel * this.masterVolume
    const sustainLevel = peak * 0.18
    mainGain.gain.linearRampToValueAtTime(peak, now + 0.005)
    // 锤子: 0.18s 内衰减到 0.4
    mainGain.gain.exponentialRampToValueAtTime(peak * 0.4, now + 0.18)
    // body: 慢慢衰减到 sustain
    const bodyEnd = Math.min(n.duration, 2.0)
    mainGain.gain.exponentialRampToValueAtTime(sustainLevel, now + bodyEnd)
    // release: 0.4s 收
    mainGain.gain.exponentialRampToValueAtTime(0.0001, now + n.duration + 0.4)

    const voice: Voice = { midi, id: voiceId, token: {}, mainGain, oscs }
    this.trackVoice(voice)

    // 自动清理
    const cleanupDelay = (n.duration + 0.5) * 1000 + 50
    setTimeout(() => {
      this.removeVoice(voice)
    }, cleanupDelay)
  }

  /** 挂到 active map (同 midi 可多声部, 见 P1-13) */
  private trackVoice(voice: Voice) {
    const list = this.active.get(voice.midi)
    if (list) list.push(voice)
    else this.active.set(voice.midi, [voice])
  }

  /**
   * 停掉 voice.
   * @param voiceId 指定 → 只停这一个声部; 省略 → 该音高上所有声部全停.
   * @param when    ctx 时刻 → 在那个时刻才真正收尾 (spec P1-2 lookahead).
   */
  stopNote(midi: number, voiceId?: number, when?: number) {
    const list = this.active.get(midi)
    if (!list) return
    const targets = voiceId === undefined ? [...list] : list.filter((v) => v.id === voiceId)
    if (targets.length === 0) return
    for (const v of targets) this.killVoice(v, when)
    const rest = list.filter((v) => !targets.includes(v))
    if (rest.length > 0) this.active.set(midi, rest)
    else this.active.delete(midi)
  }

  private killVoice(v: Voice, when?: number) {
    const now = when !== undefined ? Math.max(when, this.ctx.currentTime) : this.ctx.currentTime
    // 采样声部: 让采样器自己淡出
    if (v.sampler) {
      v.sampler.release(now)
      return
    }
    try {
      v.mainGain!.gain.cancelScheduledValues(now)
      v.mainGain!.gain.setValueAtTime(v.mainGain!.gain.value, now)
      v.mainGain!.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)
      for (const osc of v.oscs!) {
        osc.stop(now + 0.1)
      }
    } catch {
      // 已经停了
    }
  }

  /** 移除一个已经自然结束的 voice (setTimeout 回调) */
  private removeVoice(voice: Voice) {
    const list = this.active.get(voice.midi)
    if (!list) return
    const i = list.findIndex((v) => v.token === voice.token)
    if (i >= 0) list.splice(i, 1)
    if (list.length === 0) this.active.delete(voice.midi)
  }

  stopAll() {
    for (const [midi, list] of [...this.active]) {
      for (const v of list) this.killVoice(v)
      this.active.delete(midi)
    }
  }
}
