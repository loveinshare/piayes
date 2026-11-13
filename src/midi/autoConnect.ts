// 共享的 MIDI 自动连接逻辑 — 启动 / 重连 / MidiModal 都用同一份
//
// 目标: 避免在 MidiModal 和 App.tsx 各写一份"挑电钢 + 配对"的代码漂移.
import type { Accompaniment } from '../engine/Accompaniment'
import type { MidiInput } from '../input/MidiInput'
import type { InputBus } from '../input/InputBus'
import {
  getRememberedMidiInputName,
  getRememberedMidiOutputName,
  rememberMidiInputName,
  rememberMidiOutputName,
  useStore,
} from '../store'

/** 跳过 PC 合成器, 优先选电钢 (Roland/Yamaha/Casio 等) */
function isSynthLike(name: string): boolean {
  return /microsoft.*gs|wavetable|software.*synth|maplesoft|virtual/i.test(name)
}

const BRAND_ORDER = ['roland', 'yamaha', 'casio', 'kawai', 'korg']

function pickOutput(
  outs: { id: string; name: string }[],
  preferredName?: string | null,
): { id: string; name: string } | null {
  if (preferredName) {
    const m = outs.find((o) => o.name === preferredName)
    if (m) return m
  }
  const electric = outs.filter((o) => !isSynthLike(o.name))
  if (electric.length > 0) {
    electric.sort((a, b) => {
      const sa = BRAND_ORDER.findIndex((k) => a.name.toLowerCase().includes(k))
      const sb = BRAND_ORDER.findIndex((k) => b.name.toLowerCase().includes(k))
      const va = sa === -1 ? 99 : sa
      const vb = sb === -1 ? 99 : sb
      return va - vb
    })
    return electric[0]
  }
  return outs[0] ?? null
}

function pickInput(
  ins: { id: string; name: string }[],
  preferredName?: string | null,
): { id: string; name: string } | null {
  if (preferredName) {
    const m = ins.find((i) => i.name === preferredName)
    if (m) return m
  }
  return ins.find((i) => !isSynthLike(i.name)) ?? ins[0] ?? null
}

export interface AutoConnectResult {
  ok: boolean
  reason?: string
  inputId?: string
  outputId?: string
}

/**
 * 自动连接: 申请 Web MIDI 权限 → 挑输入 + 输出 → 切 bus → 记 remembered name.
 * 不会自动 close 弹窗 (由调用方根据 result.ok 决定).
 *
 * Web MIDI 需要用户手势, 浏览器会在第一次 navigator.requestMIDIAccess() 时弹
 * "允许 MIDI 设备" 系统提示. 如果调用栈不是手势触发的, 浏览器可能静默拒绝.
 * App 启动时的 auto-connect 通常在 DOMContentLoaded 之后几百 ms, 部分浏览器
 * 视为 OK (因为同一 page load 内的 microtask 算手势上下文), 部分不行. 不行的话
 * MidiModal 的手动按钮仍能触发.
 */
export async function autoConnectMidi(deps: {
  midiInput: MidiInput
  acc: Accompaniment
  bus: InputBus
}): Promise<AutoConnectResult> {
  const { midiInput, acc, bus } = deps
  const setMidiInputId = useStore.getState().setMidiInputId
  const setMidiOutputId = useStore.getState().setMidiOutputId
  const setMidiOutputName = useStore.getState().setMidiOutputName
  const setInputSource = useStore.getState().setInputSource

  try {
    await Promise.all([midiInput.start(), acc.connect()])
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }

  const ins = midiInput.list()
  const outs = acc.list()

  const inPicked = pickInput(ins, getRememberedMidiInputName())
  const outPicked = pickOutput(outs, getRememberedMidiOutputName())

  if (inPicked) {
    setMidiInputId(inPicked.id)
    midiInput.use(inPicked.id)
    setInputSource('midi')
    bus.use(midiInput)
    rememberMidiInputName(inPicked.name)
  } else {
    rememberMidiInputName(null)
  }
  if (outPicked) {
    setMidiOutputId(outPicked.id)
    setMidiOutputName(outPicked.name)
    acc.use(outPicked.id)
    rememberMidiOutputName(outPicked.name)
  } else {
    setMidiOutputName(null)
    rememberMidiOutputName(null)
  }

  if (!inPicked && !outPicked) {
    return { ok: false, reason: '没找到 MIDI 设备' }
  }
  return { ok: true, inputId: inPicked?.id, outputId: outPicked?.id }
}
