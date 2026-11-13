// QWERTY 键盘模拟 MIDI 输入 (demo 用)
// 参考 sightread/src/features/midi/index.tsx 的 KEYBOARD_TO_MIDI
//
// 映射:
//   z s x d c v g b h n j m  -> C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5
//   2 3       5 6 7 9 0      -> Db4 Eb4   Gb4 Ab4 Bb4
//   q w e r t y u i          -> C5 D5 E5 F5 G5 A5 B5
//   1 4 8                    -> Db5 Eb5 Ab5 (sightread 同款排布)

import type { IInput, NoteEvent } from '../types'

// 第一组白键 (C4 起)
const ROW1: Record<string, number> = {
  KeyZ: 60, // C4
  KeyS: 62, // D4
  KeyX: 64, // E4
  KeyD: 65, // F4
  KeyC: 67, // G4
  KeyV: 69, // A4
  KeyG: 71, // B4
  KeyB: 72, // C5
  KeyH: 74, // D5
  KeyN: 76, // E5
  KeyJ: 77, // F5
  KeyM: 79, // G5
}

// 黑键 (C#4 D#4 F#4 G#4 A#4)
const BLACK1: Record<string, number> = {
  Digit2: 61, // C#4
  Digit3: 63, // D#4
  Digit5: 66, // F#4
  Digit6: 68, // G#4
  Digit7: 70, // A#4
}

// 高八度白键 (C5 起, 第二排)
const ROW2: Record<string, number> = {
  KeyQ: 72, // C5
  KeyW: 74, // D5
  KeyE: 76, // E5
  KeyR: 77, // F5
  KeyT: 79, // G5
  KeyY: 81, // A5
  KeyU: 83, // B5
}

// 高八度黑键
const BLACK2: Record<string, number> = {
  Digit1: 73, // C#5
  Digit4: 75, // D#5
  Digit8: 78, // F#5
  Digit9: 80, // G#5
  Digit0: 82, // A#5
}

const ALL: Record<string, number> = {
  ...ROW1,
  ...ROW2,
  ...BLACK1,
  ...BLACK2,
}

export class KeyboardInput implements IInput {
  onEvent: ((e: NoteEvent) => void) | null = null
  private pressed = new Set<string>()

  start() {
    window.addEventListener('keydown', this.onDown)
    window.addEventListener('keyup', this.onUp)
    window.addEventListener('blur', this.onBlur)
  }

  stop() {
    window.removeEventListener('keydown', this.onDown)
    window.removeEventListener('keyup', this.onUp)
    window.removeEventListener('blur', this.onBlur)
  }

  private onDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    // 忽略修饰键组合
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // Focus in an editable field: typing should not fire MIDI key presses.
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return
    if ((e.target as HTMLElement | null)?.isContentEditable) return
    const midi = ALL[e.code]
    if (midi === undefined) return
    if (this.pressed.has(e.code)) return
    this.pressed.add(e.code)
    this.onEvent?.({
      type: 'down',
      midi,
      velocity: 80,
      t: performance.now(),
      source: 'input',
    })
  }

  private onUp = (e: KeyboardEvent) => {
    const midi = ALL[e.code]
    if (midi === undefined) return
    // 幂等: 没按过的键不要发 up —— 否则会发出一个永远找不到对应 down 的 up
    if (!this.pressed.delete(e.code)) return
    this.onEvent?.({
      type: 'up',
      midi,
      t: performance.now(),
      source: 'input',
    })
  }

  /**
   * 窗口失焦时浏览器**不会再派发 keyup** —— 按住的键会永远卡在 pressed 里.
   * 结果: 灯一直亮着, 判定里也以为用户还按着 —— 切到别的窗口回来就“卡键”了.
   * 解决: blur 时主动释放所有按住的键 (spec P1-8).
   */
  private onBlur = () => {
    for (const code of [...this.pressed]) {
      const midi = ALL[code]
      this.pressed.delete(code)
      if (midi === undefined) continue
      this.onEvent?.({
        type: 'up',
        midi,
        t: performance.now(),
        source: 'input',
      })
    }
  }
}
