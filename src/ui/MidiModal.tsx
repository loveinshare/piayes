// MIDI 设备弹窗 (中央)
// 设计目标: 用户点击「连接」后, 输入 + 输出一次性配对, 不要再点两次

import { useEffect, useState } from 'react'
import { useStore, rememberMidiOutputName, rememberMidiInputName } from '../store'
import { MidiInput } from '../input/MidiInput'
import { KeyboardInput } from '../input/KeyboardInput'
import { InputBus } from '../input/InputBus'
import { Accompaniment } from '../engine/Accompaniment'
import { autoConnectMidi } from '../midi/autoConnect'
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconKeyboard,
  IconLoader,
  IconMidi,
  IconPiano,
  IconPlug,
  IconRefresh,
  IconSpeaker,
} from './icons'

interface Props {
  open: boolean
  onClose: () => void
  midiInput: MidiInput
  acc: Accompaniment
  bus: InputBus
  kbInput: KeyboardInput
}

export function MidiModal({ open, onClose, midiInput, acc, bus, kbInput }: Props) {
  const inputSource = useStore((s) => s.inputSource)
  const setInputSource = useStore((s) => s.setInputSource)
  const midiInputId = useStore((s) => s.midiInputId)
  const setMidiInputId = useStore((s) => s.setMidiInputId)
  const midiOutputId = useStore((s) => s.midiOutputId)
  const setMidiOutputId = useStore((s) => s.setMidiOutputId)
  const setMidiOutputName = useStore((s) => s.setMidiOutputName)

  const [midiSupported, setMidiSupported] = useState(true)
  const [inputs, setInputs] = useState<{ id: string; name: string }[]>([])
  const [outputs, setOutputs] = useState<{ id: string; name: string }[]>([])
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [justConnected, setJustConnected] = useState(false)

  useEffect(() => {
    setMidiSupported(typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess)
  }, [])

  useEffect(() => {
    if (!open) return
    midiInput.onListChange = setInputs
    acc.onListChange = setOutputs
    if (midiInput.list().length > 0) setInputs(midiInput.list())
    if (acc.list().length > 0) setOutputs(acc.list())
    return () => {
      midiInput.onListChange = null
      acc.onListChange = null
      // Clear the success banner so it does not stick around between sessions
      setJustConnected(false)
    }
  }, [open, midiInput, acc])

  // Esc 关
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  /**
   * 一键连接: 申请 MIDI 权限 + 自动挑输入和输出 + 切到 MIDI 输入源 + 关弹窗
   * 复用 autoConnectMidi, 与 App 启动时的自动连接走同一份代码 (避免漂移).
   */
  const handleConnect = async () => {
    setError(null)
    setRequesting(true)
    try {
      const result = await autoConnectMidi({ midiInput, acc, bus })
      setInputs(midiInput.list())
      setOutputs(acc.list())
      if (result.ok) {
        setJustConnected(true)
        // 成功就自动关掉, 跟用户「点完就走」的体验一致
        onClose()
      } else {
        setError(result.reason ?? '没找到 MIDI 设备. 检查电钢是否插好 / 蓝牙模式不可用.')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRequesting(false)
    }
  }

  // 手动切换 (如果自动挑的不对)
  const useInId = (id: string | null) => {
    setMidiInputId(id)
    midiInput.use(id)
    if (id) {
      setInputSource('midi')
      bus.use(midiInput)
      const dev = inputs.find((i) => i.id === id)
      rememberMidiInputName(dev?.name ?? null)
    } else {
      setInputSource('keyboard')
      bus.use(kbInput)
      rememberMidiInputName(null)
    }
  }
  const useOutId = (id: string | null) => {
    setMidiOutputId(id)
    acc.use(id)
    const dev = outputs.find((o) => o.id === id)
    setMidiOutputName(dev?.name ?? null)
    rememberMidiOutputName(dev?.name ?? null)
  }

  const isConnected = midiInputId !== null || midiOutputId !== null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-[460px] max-w-full bg-panel border border-border rounded-2xl shadow-2xl shadow-black/40 overflow-hidden anim-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="font-semibold text-text flex items-center gap-2">
            <span className="text-accent" aria-hidden>
              <IconMidi size={16} />
            </span>
            MIDI 设备
          </div>
          <button
            onClick={onClose}
            className="size-7 grid place-items-center rounded-lg text-muted hover:bg-raised hover:text-text transition-colors"
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4 text-sm">
          {!midiSupported ? (
            <div className="text-miss bg-miss/10 rounded px-3 py-2 text-sm">
              当前浏览器不支持 Web MIDI API。请用 Chrome / Edge (Win11 免驱)。
            </div>
          ) : !isConnected ? (
            <div className="rounded-lg bg-bg p-5 flex flex-col items-center gap-3 border border-border">
              <div className="size-16 grid place-items-center rounded-2xl bg-accent/10 text-accent border border-accent/20">
                <IconPiano size={30} />
              </div>
              <div className="text-text text-center text-sm">
                接好电钢后, <b>一次点击</b> 同时配对输入 + 输出。
              </div>
              <div className="text-xs text-muted text-center">
                罗兰 / Yamaha / Casio 等 USB MIDI 设备插入即识别。
                <br />
                默认优先选「电钢」类设备, 不选 PC 合成器 (Microsoft GS Wavetable 等)。
              </div>
              <button
                onClick={handleConnect}
                disabled={requesting}
                className="mt-2 px-5 py-2.5 rounded-xl bg-accent text-bg font-semibold hover:bg-accent/90 shadow-lg shadow-accent/20 disabled:opacity-50 transition inline-flex items-center gap-2"
              >
                {requesting ? <IconLoader size={15} className="anim-spin" /> : <IconPlug size={15} />}
                {requesting ? '连接中…' : '连接电钢 (输入 + 输出)'}
              </button>
              {error && (
                <div className="text-xs text-miss bg-miss/10 border border-miss/25 rounded-md px-2 py-1.5 flex items-start gap-1.5">
                  <IconAlert size={13} className="mt-px shrink-0" />
                  {error}
                </div>
              )}
            </div>
          ) : (
            <>
              {justConnected && (
                <div className="rounded-lg bg-hit/10 border border-hit/30 text-hit text-sm px-3 py-2 flex items-center gap-2">
                  <IconCheck size={15} className="shrink-0" />
                  已连接. 想换设备或重选, 在下方列表里换即可.
                </div>
              )}

              {/* 输入 */}
              <div className="flex flex-col gap-2">
                <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
                  <IconKeyboard size={13} aria-hidden />
                  输入 (你弹奏 → 跟弹判断)
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => useInId(null)}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border transition inline-flex items-center justify-center gap-1.5 ${
                      inputSource === 'keyboard'
                        ? 'border-accent bg-accent/15 text-accent'
                        : 'border-border text-muted hover:text-text'
                    }`}
                  >
                    <IconKeyboard size={14} aria-hidden />
                    键盘
                  </button>
                  <button
                    onClick={() => midiInputId && useInId(midiInputId)}
                    disabled={!midiInputId}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm border transition disabled:opacity-50 inline-flex items-center justify-center gap-1.5 ${
                      inputSource === 'midi'
                        ? 'border-accent bg-accent/15 text-accent'
                        : 'border-border text-muted hover:text-text'
                    }`}
                  >
                    <IconPiano size={14} aria-hidden />
                    钢琴
                  </button>
                </div>
                {inputSource === 'midi' && (
                  <select
                    value={midiInputId ?? ''}
                    onChange={(e) => useInId(e.target.value || null)}
                    className="w-full bg-bg border border-border rounded-lg px-2 py-1.5 text-sm focus:border-accent/60 outline-none transition-colors"
                  >
                    <option value="">— 选择 MIDI 输入 —</option>
                    {inputs.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* 输出 */}
              <div className="flex flex-col gap-2">
                <div className="text-xs font-semibold text-muted flex items-center gap-1.5">
                  <IconSpeaker size={13} aria-hidden />
                  输出 (曲谱发到电钢)
                </div>
                <select
                  value={midiOutputId ?? ''}
                  onChange={(e) => useOutId(e.target.value || null)}
                  className="w-full bg-bg border border-border rounded-lg px-2 py-1.5 text-sm focus:border-accent/60 outline-none transition-colors"
                >
                  <option value="">— 关闭 (合成器兜底) —</option>
                  {outputs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
                <div className={`text-xs flex items-start gap-1.5 ${midiOutputId ? 'text-hit' : 'text-miss'}`}>
                  {midiOutputId ? (
                    <IconCheck size={13} className="mt-px shrink-0" />
                  ) : (
                    <IconAlert size={13} className="mt-px shrink-0" />
                  )}
                  {midiOutputId
                    ? '曲谱已路由到电钢 — 浏览器不响, 只听电钢自身音色'
                    : '未选 — 用浏览器合成器发声 (不是电钢音色)'}
                </div>
              </div>

              <button
                onClick={handleConnect}
                disabled={requesting}
                className="text-xs text-muted hover:text-accent self-center inline-flex items-center gap-1.5"
              >
                <IconRefresh size={13} aria-hidden />
                {requesting ? '刷新中…' : '重新扫描设备'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
