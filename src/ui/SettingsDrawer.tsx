// 设置抽屉 (从右侧滑入)
// 进阶设置: 节拍器 / 判定延迟 / 手别判定 / A-B 循环 / 移调 / 键盘标号 / LED 灯带 / 调试
//
// ★ 2026-11-01:
//   - 删掉了顶部的「重置开头 / 播放」大按钮 —— 底栏 Transport 已经有了, 抽屉里重复一份
//     只会让上面这半屏变成"操作区", 把真正的设置挤到下面.
//   - 换用共享控件 (<Row> / <Section> / <Switch> / <SegmentedControl> / <Slider>).
//   - LED 段落跟右上角浮窗共用 <LedSettings />, 不再各写一套.
//
// ★ 2026-11-08:
//   - 抽屉从 380px 加宽到 1240px, 内容改成**多栏**, 每栏顶上写清楚是哪个领域:
//       ① 演奏判定  ② 谱面显示  ③ LED 灯带
//   - 每栏**各自滚动** (抽屉本身不滚了) —— 拖一栏不影响另外两栏.
//   - 说明文字收紧: 长解释挪进 tooltip, 栏里只留一眼看得懂的短句.
//     之前 9 个 Section 一竖排要滚两三屏 (2423px), 现在一屏基本放得下.
//
// ★ 2026-11-10:
//   - 面板不再满高满宽贴边, 改成四周留 16px 的**浮层** (圆角 + 阴影) ——
//     1240px 满屏会把整个应用盖掉, 看着像被顶掉了, 不像打开了个面板.
//
// ★ 2026-11-13:
//   - 点阵屏那栏**移出去了** (用户要求): 它是「设备」不是「练习参数」,
//     现在跟灯带一样常驻首页右上角 (<LedScreenDock />).
//     原来为四栏加宽的 1440px 也收回 1180px (三栏正好).

import { useEffect, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { Row, Section, SecondaryBtn, SegmentedControl, Slider, Switch, cx } from './controls'
import { LedSettings } from './LedSettings'
import { ledDeviceLabel } from '../led/transport/ledConfig'
import {
  IconBulb,
  IconChevronDown,
  IconClose,
  IconKeyboard,
  IconMetronome,
  IconRepeat,
  IconSliders,
} from './icons'

interface Props {
  open: boolean
  onClose: () => void
}

export function SettingsDrawer({ open, onClose }: Props) {
  const song = useStore((s) => s.song)
  const metronome = useStore((s) => s.metronome)
  const setMetronome = useStore((s) => s.setMetronome)
  const latencyAuto = useStore((s) => s.latencyAuto)
  const setLatencyAuto = useStore((s) => s.setLatencyAuto)
  const handInferMode = useStore((s) => s.handInferMode)
  const setHandInferMode = useStore((s) => s.setHandInferMode)
  // note.hand / song.handInfer 是就地更新的 (song 引用不变) —— 靠版本号触发重渲染
  useStore((s) => s.handInferVersion)
  const latencyOffsetMs = useStore((s) => s.latencyOffsetMs)
  const setLatencyOffsetMs = useStore((s) => s.setLatencyOffsetMs)
  const outputLatencyMs = useStore((s) => s.outputLatencyMs)
  const transpose = useStore((s) => s.transpose)
  const setTranspose = useStore((s) => s.setTranspose)
  // 虚拟键盘上的音名标号 (用户 2026-10-30: "D3 之类的标号, 我不认识")
  const keyLabels = useStore((s) => s.keyLabels)
  const setKeyLabels = useStore((s) => s.setKeyLabels)
  const loopRange = useStore((s) => s.loopRange)
  const setLoopRange = useStore((s) => s.setLoopRange)
  const clearLoopRange = useStore((s) => s.clearLoopRange)
  const currentTime = useStore((s) => s.currentTime)
  const ledEnabled = useStore((s) => s.ledEnabled)
  const ledHost = useStore((s) => s.ledHost)
  const ledActiveDevice = useStore((s) => s.ledActiveDevice)
  const ledError = useStore((s) => s.ledError)
  const ledConnected = useStore((s) => s.ledConnected)

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loopA, setLoopA] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm anim-fade-in" />
      {/* ★ 2026-11-10: 1240px 宽 + 满高 = 整个屏幕被盖住, 右边滑进来的那一下
          看着像"应用被顶掉了", 不像"打开了个面板". 改成**浮在应用上面的一整块**
          (四周留边 + 圆角): 底下还看得见谱面, 知道自己在哪儿. */}
      <div
        className="relative w-[1180px] max-w-[96vw] h-[calc(100%_-_2rem)] my-4 mr-4 rounded-2xl bg-panel border border-border shadow-2xl shadow-black/50 flex flex-col overflow-hidden anim-slide-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-border bg-panel">
          <div className="font-semibold text-text flex items-center gap-2">
            <span className="text-accent" aria-hidden>
              <IconSliders size={16} />
            </span>
            进阶设置
          </div>
          <button
            onClick={onClose}
            className="size-7 grid place-items-center rounded-lg text-muted hover:bg-raised hover:text-text transition-colors"
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>

        {/* 四栏 —— 每栏一个领域, 每栏自己滚. 窄屏 (<lg) 改成上下摞, 整体滚. */}
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-6 px-5 py-4 overflow-y-auto lg:overflow-hidden">
          {/* ① 演奏判定 */}
          <Column title="演奏判定" sub="节拍器 · 判定 · 手别 · 循环" icon={<IconMetronome size={14} />}>
            {/* 节拍器 —— 开关型: 标题 + 右侧开关 */}
            <Section
              title="节拍器声音"
              action={
                <Switch checked={metronome} onChange={setMetronome} title="跟随谱面 BPM 发声" />
              }
            >
              <p className="text-xs text-muted">跟随谱面 BPM 发声 (重音按拍号首拍)。</p>
            </Section>

            {/* 判定延迟补偿 (spec P1-3) */}
            <Section title="判定延迟">
              <p className="text-xs text-muted">
                检测到的输出延迟:{' '}
                <span className="tabular-nums text-text">{Math.round(outputLatencyMs)} ms</span>
                <span className="text-subtle"> (蓝牙耳机常在 100~200ms)</span>
              </p>
              <Switch
                checked={latencyAuto}
                onChange={setLatencyAuto}
                label="按检测值自动补偿"
                title="默认不补偿 —— 跟弹时被判定的那只手本身不发声, 用户是照着画面弹的, 画面没有延迟. 只有「跟着伴奏声音弹」的用户才需要开补偿."
              />
              {!latencyAuto && (
                <Row label="手动补偿">
                  <Slider
                    value={latencyOffsetMs}
                    min={0}
                    max={500}
                    step={10}
                    onChange={setLatencyOffsetMs}
                    className="flex-1"
                    ariaLabel="手动补偿 (毫秒)"
                  />
                  <span className="w-14 text-right tabular-nums text-xs text-muted shrink-0">
                    {latencyOffsetMs} ms
                  </span>
                </Row>
              )}
            </Section>

            {/* 手别判定 (spec P2-6) */}
            <Section title="手别判定">
              <p className="text-xs text-muted">
                {song?.handInfer?.confidence === 'low'
                  ? '左右手是猜出来的, 可能不准 —— 猜错了改成按音高切分。'
                  : song?.handInfer?.confidence === 'medium'
                    ? '左右手是推断的, 可以改成按音高切分。'
                    : '单声部曲子的左右手靠声部聚类猜, 不准时改用按音高切分。'}
              </p>
              <SegmentedControl
                value={handInferMode}
                options={[
                  { value: 'auto', label: '自动 (声部聚类)' },
                  { value: 'pitch', label: '按音高切分' },
                ]}
                onChange={setHandInferMode}
              />
            </Section>

            {/* Loop */}
            <Section title="A-B 循环">
              <p className="text-xs text-muted">练某段时反复循环, 不用手动重头开始。</p>
              <div className="flex items-center gap-2">
                <SecondaryBtn onClick={() => setLoopA(currentTime)} disabled={!song}>
                  {loopA !== null ? `A = ${loopA.toFixed(1)}s ↺` : '设 A 点 (当前)'}
                </SecondaryBtn>
                <SecondaryBtn
                  onClick={() => {
                    if (loopA === null) return
                    const a = Math.min(loopA, currentTime)
                    const b = Math.max(loopA, currentTime)
                    setLoopRange([a, b])
                    setLoopA(null)
                  }}
                  disabled={loopA === null || !song}
                >
                  设 B 点 → 开始循环
                </SecondaryBtn>
              </div>
              {loopRange && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-accent inline-flex items-center gap-1">
                    <IconRepeat size={12} />
                    {loopRange[0].toFixed(1)}s → {loopRange[1].toFixed(1)}s
                  </span>
                  <button onClick={clearLoopRange} className="text-miss hover:underline">
                    取消循环
                  </button>
                </div>
              )}
            </Section>
          </Column>

          {/* ② 谱面显示 */}
          <Column title="谱面显示" sub="移调 · 键盘标号 · 音色" icon={<IconKeyboard size={14} />}>
            {/* Transpose */}
            <Section title="移调">
              <Row label="半音">
                <div className="flex items-center gap-1.5">
                  <StepBtn onClick={() => setTranspose(transpose - 1)} title="降半音">
                    −
                  </StepBtn>
                  <span className="w-9 text-center tabular-nums text-sm text-text">
                    {transpose > 0 ? `+${transpose}` : transpose}
                  </span>
                  <StepBtn onClick={() => setTranspose(transpose + 1)} title="升半音">
                    +
                  </StepBtn>
                  <button
                    onClick={() => setTranspose(0)}
                    disabled={transpose === 0}
                    className="text-xs text-muted hover:text-text px-1.5 disabled:opacity-30"
                  >
                    重置
                  </button>
                </div>
              </Row>
              <p className="text-xs text-subtle leading-relaxed border-l-2 border-border/70 pl-2">
                同时改变: 画布位置、合成器音色、MIDI Out 发出的音。
              </p>
            </Section>

            {/* 键盘音名标号 */}
            <Section title="键盘标号">
              <Row label="标号">
                <SegmentedControl
                  value={keyLabels}
                  options={[
                    { value: 'off', label: '不标' },
                    { value: 'c', label: '只标C' },
                    { value: 'all', label: '全标' },
                  ]}
                  onChange={setKeyLabels}
                  className="w-full"
                />
              </Row>
              <p className="text-xs text-subtle leading-relaxed border-l-2 border-border/70 pl-2">
                在虚拟键盘的键上标出音名 (D3 之类), 方便找键。
              </p>
            </Section>

            {/* 音色 —— 采样钢琴的出处 (CC BY 3.0 要求署名) */}
            <Section title="音色">
              <p className="text-xs text-muted leading-relaxed">
                钢琴声用 Salamander Grand Piano v3 采样 (Alexander Holm, CC BY 3.0), 经 Tone.js
                播放。
              </p>
            </Section>

            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-muted hover:text-accent self-start inline-flex items-center gap-1 transition-colors"
            >
              <IconChevronDown
                size={12}
                className={cx('transition-transform', showAdvanced && 'rotate-180')}
              />
              {showAdvanced ? '收起' : '展开更多'}
            </button>
            {showAdvanced && song && (
              <Section title="调试 / 元数据">
                <MetaGrid song={song} />
              </Section>
            )}
          </Column>

          {/* ③ LED 灯带 —— 跟右上角 💡 浮窗共用 <LedSettings /> */}
          <Column
            title="LED 灯带"
            sub="连接 · 显示 · 配色"
            icon={<IconBulb size={14} />}
            wide
            action={
              <span
                className={cx(
                  'text-[11px] px-1.5 py-0.5 rounded-full border shrink-0',
                  ledConnected
                    ? 'bg-hit/15 text-hit border-hit/30'
                    : ledEnabled
                      ? 'bg-miss/15 text-miss border-miss/30'
                      : 'bg-bg text-muted border-border',
                )}
                title={
                  ledConnected
                    ? `已连接 ${ledDeviceLabel(ledActiveDevice, ledHost)}`
                    : ledEnabled
                      ? '连接中...'
                      : '未启用'
                }
              >
                {ledConnected ? '已连接' : ledEnabled ? '连接中' : '未启用'}
              </span>
            }
          >
            {ledError && <p className="text-xs text-miss/90">{ledError}</p>}
            {/* 设备选择 / 设备地址 / 令牌都在 <LedSettings /> 里了 ——
                2026-11-06: 这几行从抽屉挪进共享组件, 右上角 💡 浮窗也能改地址
                (2026-11-10: 蓝牙配对按钮删了 —— ESP32 现在跟树莓派一样走 WS). */}
            <LedSettings compact />
          </Column>

          {/* ④ 点阵屏**不在这里** (2026-11-13 用户要求):
              它跟灯带一样是「设备」而不是「练习参数」, 已经挪到首页右上角的
              <LedScreenDock /> (图标排里灯带旁边那个格子图标). */}
        </div>
      </div>
    </div>
  )
}

/**
 * 一栏 = 一个领域.
 *
 * 栏头写清楚「这块管什么」, 下面的内容自己滚 —— 抽屉本身不滚,
 * 所以拖 LED 那栏不会把「演奏判定」那栏带着跑.
 */
function Column({
  title,
  sub,
  icon,
  action,
  wide,
  children,
}: {
  title: ReactNode
  /** 栏头下面那行小字 —— 列出这一栏里都有啥. */
  sub?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  /** 宽栏 (LED 那栏内容多, 给它多一点横向空间). */
  wide?: boolean
  children?: ReactNode
}) {
  return (
    <section
      className={cx(
        'flex flex-col min-h-0 min-w-0 flex-none lg:flex-1',
        wide ? 'lg:flex-[1.6]' : 'lg:flex-1',
      )}
    >
      <header className="shrink-0 flex items-start justify-between gap-2 pb-2 mb-3 border-b border-border/60">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-text leading-tight">
            {icon && (
              <span aria-hidden className="text-muted grid place-items-center">
                {icon}
              </span>
            )}
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-[11px] text-subtle truncate">{sub}</p>}
        </div>
        {action && <div className="flex items-center gap-2 shrink-0">{action}</div>}
      </header>
      <div className="flex-1 min-h-0 pr-1 flex flex-col gap-5 lg:overflow-y-auto">{children}</div>
    </section>
  )
}

/** 调试信息 —— 键值网格, 比一坨 JSON 好读 */
function MetaGrid({ song }: { song: NonNullable<ReturnType<typeof useStore.getState>['song']> }) {
  const rows: { label: string; value: string; wide?: boolean }[] = [
    { label: '音符数', value: String(song.notes.length) },
    { label: 'BPM', value: song.bpms.map((b) => b.bpm).join(', ') || '—', wide: true },
    { label: 'PPQ', value: String(song.ppq) },
    { label: '来源', value: song.source === 'xml' ? 'MusicXML' : 'MIDI' },
    { label: '声部', value: `左 track ${song.hands.left} / 右 track ${song.hands.right}` },
    { label: '音高切分', value: song.pitchSplit != null ? `是 (分界 ${song.pitchSplit})` : '否' },
    { label: '时长', value: `${song.duration.toFixed(2)}s` },
    {
      label: '拍号',
      value:
        song.timeSignatures && song.timeSignatures.length > 1
          ? song.timeSignatures.map((s) => `${s.numerator}/${s.denominator}`).join(' → ')
          : `${song.timeSignature.numerator}/${song.timeSignature.denominator}`,
      wide: !!song.timeSignatures && song.timeSignatures.length > 1,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {rows.map((r) => (
        <div
          key={r.label}
          className={cx(
            'flex items-center justify-between gap-2 border-b border-border/40 pb-1 min-w-0',
            r.wide && 'col-span-2',
          )}
        >
          <span className="text-xs text-subtle shrink-0">{r.label}</span>
          <span className="text-xs text-text tabular-nums truncate" title={r.value}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function StepBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="size-7 grid place-items-center rounded-lg bg-bg border border-border text-muted hover:text-text hover:border-accent transition-colors"
    >
      {children}
    </button>
  )
}
