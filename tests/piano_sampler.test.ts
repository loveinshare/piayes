// 采样钢琴的音高映射 —— 采样点每 3 个半音一个, 中间的音靠 playbackRate 移调.
//
// 这里只测纯函数 (采样文件名 / 最近采样点选取), 不碰 WebAudio ——
// 真正发声在浏览器里验 (见 src/engine/PianoSampler.ts 的注释).

import { describe, it, expect } from 'vitest'
import { nearestSample, sampleFileName } from '../src/engine/PianoSampler'

describe('采样钢琴: 音高映射', () => {
  it('采样文件名跟 public/samples/piano/ 里的对得上', () => {
    expect(sampleFileName(21)).toBe('A0.mp3')
    expect(sampleFileName(24)).toBe('C1.mp3')
    expect(sampleFileName(27)).toBe('Ds1.mp3')
    expect(sampleFileName(30)).toBe('Fs1.mp3')
    expect(sampleFileName(60)).toBe('C4.mp3')
    expect(sampleFileName(63)).toBe('Ds4.mp3')
    expect(sampleFileName(66)).toBe('Fs4.mp3')
    expect(sampleFileName(108)).toBe('C8.mp3')
  })

  it('正好落在采样点上 → 不移调', () => {
    expect(nearestSample(60)).toEqual({ base: 60, semitones: 0 })
    expect(nearestSample(21)).toEqual({ base: 21, semitones: 0 })
    expect(nearestSample(108)).toEqual({ base: 108, semitones: 0 })
  })

  it('中间的音取最近的采样点, 移调不超过 1.5 个半音', () => {
    for (let midi = 21; midi <= 108; midi++) {
      const { base, semitones } = nearestSample(midi)
      expect(Math.abs(semitones)).toBeLessThanOrEqual(1.5)
      expect(base).toBeGreaterThanOrEqual(21)
      expect(base).toBeLessThanOrEqual(108)
      // 移调后的音高差 == 半音数
      expect(base + semitones).toBe(midi)
    }
  })

  it('超出采样范围 → 贴边移调', () => {
    expect(nearestSample(20)).toEqual({ base: 21, semitones: -1 })
    expect(nearestSample(110)).toEqual({ base: 108, semitones: 2 })
  })
})
