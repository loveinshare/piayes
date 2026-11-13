// 状态栏: 主音源 / 输入源 / 节拍器 / Loop / 评分 (左半边)
//       + 连接状态 绿/红 框 (右半边): 电钢 / MIDI In / LED
//
// 连接框是用户最常关心的: 一眼看出「电钢接了没」「灯条连了没」.
// 颜色: 绿=已连, 红=连不上(选过设备又掉了), 黄=连接中, 灰=没配/没启用.
// 用 border-2 描边让框看得见.
//
// ★ 2026-11-10: 蓝牙那条路删了 (ESP32 现在跟树莓派一样走 WebSocket),
//   所以底栏右下角不再有「蓝牙」按钮 —— 设备选择在右上角灯带图标里.

import type { ReactNode } from 'react'
import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { runLedTest } from '../led/emit'
import { ledDeviceLabel } from '../led/transport/ledConfig'
import { accuracyPercent } from '../engine/Scoring'
import {
  IconBulb,
  IconFlame,
  IconInbox,
  IconKeyboard,
  IconMetronome,
  IconPiano,
  IconRepeat,
} from './icons'

export function StatusBar() {
  const hand = useStore((s) => s.hand)
  const hits = useStore((s) => s.hits)
  const misses = useStore((s) => s.misses)
  const perfects = useStore((s) => s.perfects)
  const goods = useStore((s) => s.goods)
  const errors = useStore((s) => s.errors)
  const streak = useStore((s) => s.streak)
  const inputSource = useStore((s) => s.inputSource)
  const midiOutputId = useStore((s) => s.midiOutputId)
  const midiOutputConnected = useStore((s) => s.midiOutputConnected)
  const midiOutputName = useStore((s) => s.midiOutputName)
  const midiInputId = useStore((s) => s.midiInputId)
  const metronome = useStore((s) => s.metronome)
  const loopRange = useStore((s) => s.loopRange)
  const frozenWaiting = useStore((s) => s.frozenWaiting)
  const ledEnabled = useStore((s) => s.ledEnabled)
  const ledConnected = useStore((s) => s.ledConnected)
  const ledActiveDevice = useStore((s) => s.ledActiveDevice)
  const ledHost = useStore((s) => s.ledHost)

  const isPractice = hand !== 'playback'
  // 准确率口径与 sightread 一致: error 计入分母 (spec P1-4)
  const accuracy =
    hits + misses + errors > 0 ? String(accuracyPercent(hits, misses, errors)) : '—'

  // Layout: collapse non-essential chips on narrow viewports to keep the bottom row from overflowing.
  const [compact, setCompact] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 900px)')
    const apply = () => setCompact(mql.matches)
    apply()
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [])

  // LED 状态: 连上/连接中/未启用 — 三种颜色
  //   连上 (绿)   : ledEnabled && ledConnected
  //   连中 (黄)   : ledEnabled && !ledConnected
  //   未启用 (灰) : !ledEnabled
  const ledTone: ConnTone =
    !ledEnabled ? 'idle' : ledConnected ? 'ok' : 'warn'

  return (
    <div className="flex items-center gap-3 text-xs text-muted overflow-hidden whitespace-nowrap">
      {isPractice && (
        <>
          {/* Compact: on ultra-narrow viewports, drop score chips to keep the bottom row single-line */}
          {!compact && frozenWaiting && (
            <span
              className="px-1.5 py-0.5 rounded text-miss bg-miss/15 font-semibold animate-pulse"
              title="Wait 模式冻结中 — 等你弹对再继续"
            >
              等你弹
            </span>
          )}
                    {!compact && <Tag color="text-hit bg-hit/10" title="命中">✓{hits}</Tag>}
                    {!compact && <Tag color="text-accent bg-accent/10" title="完美">S×{perfects}</Tag>}
                    {!compact && <Tag color="text-good bg-good/10" title="良好">G×{goods}</Tag>}
                    {!compact && <Tag color="text-miss bg-miss/10" title="错过">✗{misses}</Tag>}
          <span className="text-muted">{accuracy}% 准</span>
          {!compact && streak > 0 && (
            <span className="text-hit font-semibold flex items-center gap-0.5">
              <IconFlame size={12} />
              ×{streak}
            </span>
          )}
        </>
      )}
      <span title="输入源" className="shrink-0 flex items-center gap-1">
        {inputSource === 'keyboard' ? <IconKeyboard size={13} /> : <IconPiano size={13} />}
        {inputSource === 'keyboard' ? '键盘' : '钢琴'}
      </span>
      {metronome && (
        <span title="节拍器开" className="text-accent/80">
          <IconMetronome size={13} />
        </span>
      )}
      {loopRange && (
        <span title={`Loop ${loopRange[0].toFixed(1)}s → ${loopRange[1].toFixed(1)}s`} className="text-accent/80">
          <IconRepeat size={13} />
        </span>
      )}

      <span className="flex-1" />

      {/* 三个连接框 — 标签固定 (电钢 / MIDI / LED), 连没连全靠框色:
          绿=已连, 红=连不上, 黄=连接中, 灰=没配/没启用.
          ★ 冷启动 (什么都没配) 走**灰**, 不走红 —— 「没选设备」不是故障,
            红框一上来就三个红, 像坏了. 真的异常 (选过设备又掉线) 才红. */}
      <ConnBox
        tone={midiOutputConnected ? 'ok' : midiOutputId ? 'fail' : 'idle'}
        icon={<IconPiano size={12} />}
        label="电钢"
        title={
          midiOutputConnected
            ? 'MIDI Out 已连接 — 伴奏走电钢发声'
            : midiOutputId
            ? `MIDI Out 已断开${midiOutputName ? ' (' + midiOutputName + ')' : ''} — 点「MIDI」重新连接`
            : 'MIDI Out 未选 — 浏览器合成器兜底, 不是电钢音色'
        }
      />
      <ConnBox
        tone={midiInputId ? 'ok' : 'idle'}
        icon={<IconInbox size={12} />}
        label="MIDI"
        title={
          midiInputId
            ? 'MIDI In 已选 — 输入是 MIDI 设备'
            : 'MIDI In 未选 — 按键只能用电脑键盘'
        }
      />
      <ConnBox
        tone={ledTone}
        icon={<IconBulb size={12} />}
        label={ledConnected ? 'LED' : ledEnabled ? '连不上' : '关'}
        title={
          ledConnected
            ? `灯条已连接 (${ledDeviceLabel(ledActiveDevice, ledHost)}) — 跟随乐谱/按键已生效`
            : ledEnabled
            ? '灯条没连上 — 点右上角灯带图标看原因 (可以换设备 / 改地址)'
            : '灯条未启用 — 点右上角灯带图标打开'
        }
      />
      {/* LED 测试按钮: 只在「连上」或「连接中」时显示, 灰灯态没意义 */}
      {ledEnabled && (
        <button
          onClick={() => runLedTest()}
          disabled={!ledConnected}
          className="px-1.5 py-0.5 rounded border-2 border-border bg-bg/60 text-muted hover:text-text hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed text-[11px]"
          title={ledConnected ? '6盏蓝→紫渐变跑马, 跑完强制关灯' : '等灯条连上再测'}
        >
          测试
        </button>
      )}
    </div>
  )
}

type ConnTone = 'ok' | 'fail' | 'warn' | 'idle'

const TONE_STYLE: Record<ConnTone, string> = {
  // 绿 (已连): 边框 + 文字 + 淡背景 — border-2 让「框」真的看得见
  ok: 'border-hit/60 bg-hit/15 text-hit',
  // 红 (未连/异常): 同强度, 警示色
  fail: 'border-miss/60 bg-miss/15 text-miss',
  // 黄 (连接中): 跟 fail 区分, 状态过渡
  warn: 'border-good/60 bg-good/15 text-good',
  // 灰 (未启用): 不抢眼, 但仍然有框
  idle: 'border-border bg-bg/40 text-muted',
}

function ConnBox({
  tone,
  icon,
  label,
  title,
}: {
  tone: ConnTone
  icon: ReactNode
  label: string
  title: string
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border-2 font-semibold shrink-0 ${TONE_STYLE[tone]}`}
    >
      <span aria-hidden className="grid place-items-center">
        {icon}
      </span>
      <span>{label}</span>
    </span>
  )
}

function Tag({
  children,
  color,
  title,
}: {
  children: React.ReactNode
  color: string
  title: string
}) {
  return (
    <span title={title} className={`px-1.5 py-0.5 rounded ${color} tabular-nums`}>
      {children}
    </span>
  )
}
