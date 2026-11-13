// 节拍器声音 (Web Audio)
// 与视觉小圆点同源: 复用 synth 的 ctx, 走主循环调用 tick(now)
// accent=true 时频率更高 / 力度更大
//
// 参考: sightread/src/features/player/player.ts 的 metronomeSynth / metronomeAccentedSynth

export class Metronome {
  private ctx: AudioContext
  private volume = 0.5

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v))
  }

  /**
   * 在 now (秒, AudioContext 时间轴) 时刻发出一声 "嗒"
   * @param when 排程时刻 (spec P1-2 lookahead); 省略 = 立即发声
   */
  tick(accent = false, when?: number) {
    const now = when !== undefined ? Math.max(when, this.ctx.currentTime) : this.ctx.currentTime
    const osc = this.ctx.createOscillator()
    const gain = this.ctx.createGain()
    osc.frequency.value = accent ? 1600 : 1000
    osc.type = 'square'

    const peak = accent ? 0.5 : 0.3
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(this.volume * peak, now + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)

    osc.connect(gain).connect(this.ctx.destination)
    osc.start(now)
    osc.stop(now + 0.06)
  }
}
