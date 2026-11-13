// 采样钢琴 —— Salamander Grand Piano v3 (CC BY 3.0, 见 public/samples/piano/LICENSE.md)
//
// 采样集每 3 个半音一个 (A0 起: A, C, D#, F#, …, C8, 共 30 个), 中间的音用
// playbackRate 移调 (2^(半音数/12)), 所以 2MB 采样就覆盖 A0..C8。
//
// 引擎用 Tone.js 的 ToneBufferSource:
//   - 注入我们自己创建的 AudioContext —— 不新建 context, 不抢全局
//     (Tone.setContext(ctx, false), disposeOld=false 才不会关掉我们的 context)
//   - 传给 Tone 的数字时间 = **绝对 context 秒**, 和现有 lookahead 排程
//     (spec P1-2) 同一套时间轴
//   - 一个声部一个 source —— 保住 (midi, voiceId) 的声部粒度 (spec P1-13)
//
// 采样自己 fetch + decodeAudioData (不用 Tone 的下载器), ToneAudioBuffer 只做包装。

import type { ToneAudioBuffer, ToneBufferSource } from 'tone'

type ToneModule = typeof import('tone')

/** 采样点 (midi): A0=21 起每 3 个半音, 到 C8=108 —— 共 30 个 */
const BASE_MIDI: number[] = Array.from({ length: 30 }, (_, i) => 21 + i * 3)

/** midi → 采样文件名 (C4 / Cs4 / Ds4 …) */
const NOTE_NAMES = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B']

export function sampleFileName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}.mp3`
}

/** 采样点里离 midi 最近的那个 + 相差几个半音 */
export function nearestSample(midi: number): { base: number; semitones: number } {
  const idx = Math.round((midi - BASE_MIDI[0]) / 3)
  const clamped = Math.max(0, Math.min(BASE_MIDI.length - 1, idx))
  const base = BASE_MIDI[clamped]
  return { base, semitones: midi - base }
}

/** 一个正在响的采样声部 */
export interface SamplerVoice {
  /** 在 when (绝对 ctx 时刻) 收尾 —— 淡出 */
  release(when: number): void
}

export interface PianoSamplerOptions {
  /** 采样目录 (public/ 下的相对路径) */
  baseUrl?: string
}

export class PianoSampler {
  private readonly ctx: AudioContext
  private readonly tone: ToneModule
  /** Tone 的 context (包着我们的 AudioContext) */
  private readonly toneCtx: InstanceType<ToneModule['Context']>
  /** base midi → 已解码的采样 */
  private readonly buffers = new Map<number, ToneAudioBuffer>()
  /** 所有声部汇到这个增益 (主音量在这里调) */
  private readonly output: GainNode
  private masterVolume = 0.6

  private constructor(ctx: AudioContext, tone: ToneModule, toneCtx: InstanceType<ToneModule['Context']>) {
    this.ctx = ctx
    this.tone = tone
    this.toneCtx = toneCtx
    this.output = ctx.createGain()
    this.output.gain.value = this.masterVolume
    this.output.connect(ctx.destination)
  }

  /**
   * 建一个采样器并把 30 个采样都拉下来解码.
   * 任何一步失败都 throw —— 调用方 (Synthesizer) 保留加法合成兜底.
   */
  static async create(
    ctx: AudioContext,
    options: PianoSamplerOptions = {},
  ): Promise<PianoSampler> {
    const tone = await import('tone')
    // 绑到我们自己创建的 AudioContext 上: 不新建, 不抢全局, disposeOld=false
    // 才不会把我们的 context 关掉
    const toneCtx = new tone.Context({ context: ctx })
    tone.setContext(toneCtx, false)

    const sampler = new PianoSampler(ctx, tone, toneCtx)
    await sampler.load(options.baseUrl ?? `${import.meta.env.BASE_URL}samples/piano/`)
    return sampler
  }

  private async load(baseUrl: string): Promise<void> {
    // 并发别拉满 —— 30 个请求一起来会挤掉别的资源
    const CONCURRENCY = 6
    const queue = [...BASE_MIDI]
    const worker = async () => {
      for (;;) {
        const midi = queue.shift()
        if (midi === undefined) return
        const res = await fetch(`${baseUrl}${sampleFileName(midi)}`)
        if (!res.ok) throw new Error(`采样下载失败 ${sampleFileName(midi)}: HTTP ${res.status}`)
        const raw = await res.arrayBuffer()
        const audio = await this.ctx.decodeAudioData(raw)
        this.buffers.set(midi, new this.tone.ToneAudioBuffer(audio))
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  }

  /** 采样是否都就绪 */
  get ready(): boolean {
    return this.buffers.size === BASE_MIDI.length
  }

  /** 0..1 主音量 (正在响的音一起变) */
  setVolume(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v))
    const now = this.ctx.currentTime
    this.output.gain.cancelScheduledValues(now)
    this.output.gain.setValueAtTime(this.output.gain.value, now)
    this.output.gain.linearRampToValueAtTime(this.masterVolume, now + 0.05)
  }

  /**
   * 发一个音.
   * @param midi 音高 (已含移调)
   * @param velocity 0..1
   * @param duration 音符时长 (秒) —— 采样按 自然衰减 + 0.4s 收
   * @param when 绝对 ctx 时刻 (lookahead 排程)
   */
  play(midi: number, velocity: number, duration: number, when: number): SamplerVoice | null {
    const { base, semitones } = nearestSample(midi)
    const buffer = this.buffers.get(base)
    if (!buffer) return null

    // Tone 的节点在构造时抓全局 context —— 多个采样器共存时 (dev 的
    // StrictMode 会挂两次) 先把全局切回自己这个, 声音才不会跑到别人的 context
    this.tone.setContext(this.toneCtx, false)

    const playbackRate = Math.pow(2, semitones / 12)
    const source: ToneBufferSource = new this.tone.ToneBufferSource({
      url: buffer,
      playbackRate,
      fadeIn: 0.005,
      fadeOut: 0.08,
      curve: 'exponential',
    })
    source.connect(this.output)

    // 采样自然收尾: 音符时长 + 0.4s 余韵, 之后淡出
    const tail = Math.min(duration + 0.4, buffer.duration / playbackRate)
    source.start(when, 0, tail, Math.max(0.1, Math.min(1, velocity)))

    return {
      release: (t: number) => {
        try {
          source.stop(t)
        } catch {
          // 已经停了
        }
      },
    }
  }

}
