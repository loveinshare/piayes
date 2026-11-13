// LED 灯带设置 —— 浮窗 (LedDock) 和设置抽屉 (SettingsDrawer) 共用同一份.
//
// ★ 2026-11-01: 之前两边各写一套, 9 项设置里重叠 8 项, 而且两边布局语言不同
//   (浮窗是竖排 Row, 抽屉是横排 Row) —— 同一个设置在两个地方长得不一样.
//   现在收敛到这里, 两边只提供自己的"额外行"插槽.
//
// ★ 2026-11-02: 加了「配色方案」 (C / D / 自动) + 预告行配色 + 预告行亮度阶梯
//   (用户只设最高/最低百分比, 中间按等比数列插值).

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import { UPPER_MIN_NOTES, UPPER_MAX_NOTES } from '../led/dualStrip'
import {
  SCHEME_C,
  SCHEME_D,
  FAST_BPM_THRESHOLD,
  ledLevelLadder,
  type LedPalette,
  type LedSchemeId,
} from '../led/schemes'
import { OptionPicker, Row, SegmentedControl, Slider, Switch, cx, type ControlOption } from './controls'
import { IconChip, IconCheck, IconCopy, IconServer, IconStrip, IconStripDual } from './icons'
import { copyText } from './clipboard'
import { LED_DEVICE_INFO, ledDeviceLabel, type LedDevice } from '../led/transport/ledConfig'

/** 上灯带显示几个音 —— 可选的档位 (1..6). */
const UPPER_NOTE_CHOICES = Array.from(
  { length: UPPER_MAX_NOTES - UPPER_MIN_NOTES + 1 },
  (_, i) => UPPER_MIN_NOTES + i,
)

/**
 * 灯带设备选项 —— 树莓派 / ESP32.
 *
 * ★ 2026-11-10: 原来的「WiFi / 蓝牙」二选一删了. ESP32 现在跟树莓派一样跑
 *   WebSocket 程序 (协议完全一样, 端口都是 8080), 所以前端只差「连哪台」.
 */
const DEVICE_OPTIONS: ControlOption<LedDevice>[] = [
  {
    value: 'pi',
    label: '树莓派',
    description: 'GPIO 18',
    icon: <IconServer size={18} />,
    title:
      '树莓派 —— 跑 ws_led_bridge.py (端口 8080). 引脚 18 (能驱动 WS2812 的只有 12/18/21). ' +
      '设备端没有跑马灯, 预告动画由前端逐帧发.',
  },
  {
    value: 'esp32',
    label: 'ESP32',
    description: 'GPIO 14',
    icon: <IconChip size={18} />,
    title:
      'ESP32 —— 新固件自带 WebSocket server (端口 8080), 跟树莓派讲同一套协议. ' +
      '引脚 14 (编译期固定), 支持设备端跑马灯.',
  },
]

const MODE_OPTIONS: ControlOption<boolean>[] = [
  {
    value: false,
    label: '单灯带',
    description: '176 颗 · 当前音',
    icon: <IconStrip size={18} />,
    title: '单灯带 = 一条 176 颗, 只显示当前该弹的音',
  },
  {
    value: true,
    label: '双色带',
    description: '双排 · 预告下一音',
    icon: <IconStripDual size={18} />,
    title: '双色带 = 上面那条显示左右手接下来要弹的音',
  },
]

const UPPER_NOTE_OPTIONS: ControlOption<number>[] = UPPER_NOTE_CHOICES.map((n) => ({
  value: n,
  label: n,
}))

/**
 * 配色方案选项.
 *
 * 每张卡片的图标是那套方案的 4 个颜色 (左上/右上 = 白键, 左下/右下 = 黑键),
 * 一眼能看出「右手是深红还是浅品红」—— 这正是方案 C / D 的区别所在.
 */
const SCHEME_OPTIONS: ControlOption<LedSchemeId>[] = [
  {
    value: 'c',
    label: '方案 C',
    description: SCHEME_C.description,
    icon: <SchemeSwatch palette={SCHEME_C.current} />,
    title: SCHEME_C.title,
  },
  {
    value: 'd',
    label: '方案 D',
    description: '快速 · 高辨识',
    icon: <SchemeSwatch palette={SCHEME_D.current} />,
    title: SCHEME_D.title,
  },
  {
    value: 'auto',
    label: '自动',
    description: '快 → D · 慢 → C',
    icon: <AutoSwatch />,
    title: `按曲速自动选: BPM ≥ ${FAST_BPM_THRESHOLD} 用方案 D (快速高辨识), 否则用方案 C (耐看)`,
  },
  {
    value: 'custom',
    label: '自定义',
    description: '手动调色',
    icon: <CustomSwatch />,
    title: '你手动调过配色 —— 选 C / D 可以恢复预设',
  },
]

/** 方案缩略图 —— 2×2 的四个颜色. */
function SchemeSwatch({ palette, size = 26 }: { palette: LedPalette; size?: number }) {
  const cells = [palette.leftWhite, palette.rightWhite, palette.leftBlack, palette.rightBlack]
  return (
    <span
      aria-hidden
      className="grid grid-cols-2 gap-0.5 rounded-md overflow-hidden ring-1 ring-white/15 shrink-0"
      style={{ width: size, height: size }}
    >
      {cells.map((c, i) => (
        <span key={i} style={{ background: rgbToHex(c) }} />
      ))}
    </span>
  )
}

/** 「自动」缩略图 —— 左半 C 右半 D (各画左手白键 + 右手白键). */
function AutoSwatch({ size = 26 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="flex gap-0.5 rounded-md overflow-hidden ring-1 ring-white/15 shrink-0"
      style={{ width: size, height: size }}
    >
      {[SCHEME_C.current, SCHEME_D.current].map((s, i) => (
        <span key={i} className="flex flex-1 flex-col gap-0.5">
          <span className="flex-1" style={{ background: rgbToHex(s.leftWhite) }} />
          <span className="flex-1" style={{ background: rgbToHex(s.rightWhite) }} />
        </span>
      ))}
    </span>
  )
}

/** 「自定义」缩略图 —— 显示当前实际用的颜色 (没有 store 就用方案 C 的). */
function CustomSwatch() {
  const colors = useStore((s) => s.ledColors)
  const palette: LedPalette = {
    leftWhite: colors.leftWhite,
    leftBlack: colors.leftBlack,
    rightWhite: colors.rightWhite,
    rightBlack: colors.rightBlack,
  }
  return <SchemeSwatch palette={palette} />
}

export function LedSettings({
  afterBackend,
  afterFollowSource,
  compact = false,
}: {
  /** 抽屉专属: 渲染在「灯带设备」之后 */
  afterBackend?: ReactNode
  /** 抽屉专属: 渲染在「跟随源」之后 */
  afterFollowSource?: ReactNode
  /**
   * 紧凑摆法 (2026-11-08) —— 抽屉第三栏 (LED) 用:
   * 设置项分两小栏并排, 调色板四色一行, 整块压到一屏放得下.
   * 💡 浮窗窄, 用默认的单栏摆法 (选项卡片带说明文字).
   */
  compact?: boolean
}) {
  const ledEnabled = useStore((s) => s.ledEnabled)
  const setLedEnabled = useStore((s) => s.setLedEnabled)
  const ledBrightness = useStore((s) => s.ledBrightness)
  const setLedBrightness = useStore((s) => s.setLedBrightness)
  const ledDevice = useStore((s) => s.ledDevice)
  const setLedDevice = useStore((s) => s.setLedDevice)
  const ledDualStrip = useStore((s) => s.ledDualStrip)
  const setLedDualStrip = useStore((s) => s.setLedDualStrip)
  const ledUpperBrightnessRatio = useStore((s) => s.ledUpperBrightnessRatio)
  const setLedUpperBrightnessRatio = useStore((s) => s.setLedUpperBrightnessRatio)
  const ledUpperLevelMax = useStore((s) => s.ledUpperLevelMax)
  const setLedUpperLevelMax = useStore((s) => s.setLedUpperLevelMax)
  const ledUpperLevelMin = useStore((s) => s.ledUpperLevelMin)
  const setLedUpperLevelMin = useStore((s) => s.setLedUpperLevelMin)
  const ledUpperNoteCount = useStore((s) => s.ledUpperNoteCount)
  const setLedUpperNoteCount = useStore((s) => s.setLedUpperNoteCount)
  const ledCalibrate = useStore((s) => s.ledCalibrate)
  const setLedCalibrate = useStore((s) => s.setLedCalibrate)
  const ledFollowPlayback = useStore((s) => s.ledFollowPlayback)
  const setLedFollowPlayback = useStore((s) => s.setLedFollowPlayback)
  const ledFollowInput = useStore((s) => s.ledFollowInput)
  const setLedFollowInput = useStore((s) => s.setLedFollowInput)
  const ledColors = useStore((s) => s.ledColors)
  const setLedColors = useStore((s) => s.setLedColors)
  const ledUpcomingColors = useStore((s) => s.ledUpcomingColors)
  const setLedUpcomingColors = useStore((s) => s.setLedUpcomingColors)
  const ledScheme = useStore((s) => s.ledScheme)
  const setLedScheme = useStore((s) => s.setLedScheme)
  const resetLedColors = useStore((s) => s.resetLedColors)
  const ledConnected = useStore((s) => s.ledConnected)
  const ledActiveDevice = useStore((s) => s.ledActiveDevice)
  const ledHost = useStore((s) => s.ledHost)
  const setLedHost = useStore((s) => s.setLedHost)
  const ledToken = useStore((s) => s.ledToken)
  const setLedToken = useStore((s) => s.setLedToken)

  // ★ 2026-11-08: 说明文字收紧 —— 长解释挪进控件的 tooltip,
  // 栏里只留一眼看得懂的一小句 (抽屉第三栏高度有限).
  const deviceInfo = LED_DEVICE_INFO[ledDevice]
  const backendHint = ledConnected
    ? `已连上 ${ledDeviceLabel(ledActiveDevice, ledHost)}.`
    : `${deviceInfo.label} —— 引脚 ${deviceInfo.pin}, 设备地址填它的 IP.`

  const modeHint = ledDualStrip
    ? '双色带 = 上条显示左右手接下来要弹的音.'
    : '单灯带 = 176 颗, 只显示当前该弹的音.'

  const schemeHint =
    ledScheme === 'auto'
      ? `自动 —— BPM ≥ ${FAST_BPM_THRESHOLD} 用方案 D, 否则用 C.`
      : ledScheme === 'custom'
        ? '自定义 —— 手动调过色了, 选 C / D 可恢复预设.'
        : ledScheme === 'd'
          ? '方案 D —— 右手黑键更偏品红, 分离度最高.'
          : '方案 C —— 左手蓝系 / 右手红色系, 慢速最舒服.'

  /** 预告行的亮度阶梯 (等比数列) —— 给提示文字用. */
  const ladder = ledLevelLadder(ledUpperLevelMax, ledUpperLevelMin, ledUpperNoteCount)

  /* 左半 —— 连什么 / 怎么连 (compact 时占第一小栏) */
  const leftGroup = (
    <>
      <Row label="灯带跟随" narrow={compact}>
        <Switch
          checked={ledEnabled}
          onChange={setLedEnabled}
          label="启用 LED 灯带"
          title="关掉 = 完全不往灯带发数据"
        />
      </Row>

      <Row label="灯带设备" hint={backendHint} wide>
        <OptionPicker
          value={ledDevice}
          options={DEVICE_OPTIONS}
          onChange={setLedDevice}
          className="w-full"
        />
      </Row>

      {afterBackend}

      {/* 设备地址 —— 两台设备走的是**同一个协议**, 所以一个地址栏通吃:
          选树莓派就填树莓派的 IP, 选 ESP32 就填 ESP32 的 IP (端口都是 8080).
          ★ HTTPS 下这个地址**不生效** —— 走服务器反代, 服务器按设备路由
            (LED_WS_TARGET_PI / LED_WS_TARGET_ESP32). 局域网直连调试时才用得上. */}
      <Row label="设备地址" narrow={compact}>
        <input
          type="text"
          value={ledHost}
          onChange={(e) => setLedHost(e.target.value)}
          disabled={!ledEnabled}
          placeholder={`${deviceInfo.label} 的 IP`}
          className="flex-1 min-w-0 h-7 bg-bg border border-border rounded-lg px-2 text-xs text-text placeholder:text-muted disabled:opacity-40 focus:border-accent/60 outline-none transition-colors"
        />
      </Row>
      <Row label="令牌" hint="留空 = 不带令牌 (两边当前都没开)." narrow={compact}>
        <input
          type="password"
          value={ledToken}
          onChange={(e) => setLedToken(e.target.value)}
          disabled={!ledEnabled}
          placeholder="( 留空 = 不带令牌 )"
          className="flex-1 min-w-0 h-7 bg-bg border border-border rounded-lg px-2 text-xs text-text placeholder:text-muted disabled:opacity-40 focus:border-accent/60 outline-none transition-colors"
        />
      </Row>

      <Row label="灯带模式" hint={modeHint} wide>
        <OptionPicker
          value={ledDualStrip}
          options={MODE_OPTIONS}
          onChange={setLedDualStrip}
          className="w-full"
        />
      </Row>
    </>
  )

  /* 右半 —— 什么色 / 亮多少 / 跟谁 (compact 时占第二小栏) */
  const rightGroup = (
    <>
      <Row label="配色方案" hint={schemeHint} wide>
        <OptionPicker
          value={ledScheme}
          options={SCHEME_OPTIONS}
          onChange={setLedScheme}
          cols={2}
          className="w-full"
        />
      </Row>

      <Row label="亮度" narrow={compact}>
        <Slider
          value={ledBrightness}
          min={0}
          max={1}
          step={0.05}
          onChange={setLedBrightness}
          disabled={!ledEnabled}
          className="flex-1 min-w-0"
          ariaLabel="灯带亮度"
        />
        <span className="w-11 text-right tabular-nums text-xs text-muted shrink-0">
          {Math.round(ledBrightness * 100)}%
        </span>
      </Row>

      {ledDualStrip && (
        <Row
          label="上灯带亮度"
          narrow={compact}
          hint={`上灯带 = 主灯带亮度 × 这个比例 (${Math.round(ledBrightness * 100)}% → ${Math.round(
            ledBrightness * ledUpperBrightnessRatio * 100,
          )}%).`}
        >
          <Slider
            value={ledUpperBrightnessRatio}
            min={0}
            max={1}
            step={0.05}
            onChange={setLedUpperBrightnessRatio}
            disabled={!ledEnabled}
            className="flex-1 min-w-0"
            ariaLabel="上灯带亮度"
          />
          <span className="w-11 text-right tabular-nums text-xs text-muted shrink-0">
            {Math.round(ledUpperBrightnessRatio * 100)}%
          </span>
        </Row>
      )}

      {ledDualStrip && (
        <Row
          label="预告行亮度"
          hint={`最亮 ${Math.round(ledUpperLevelMax * 100)}%, 最暗 ${Math.round(
            ledUpperLevelMin * 100,
          )}%, 中间等比插值${
            ladder.length > 2 ? ` (${ladder.map((v) => Math.round(v * 100)).join(' → ')}%)` : ''
          }.`}
          wide
        >
          <div className="flex flex-col gap-2">
            <LevelSlider
              label="最亮"
              value={ledUpperLevelMax}
              onChange={setLedUpperLevelMax}
              disabled={!ledEnabled}
            />
            <LevelSlider
              label="最暗"
              value={ledUpperLevelMin}
              onChange={setLedUpperLevelMin}
              disabled={!ledEnabled}
            />
          </div>
        </Row>
      )}

      {ledDualStrip && (
        <Row
          label="上灯带显示几个"
          hint="左右手各自接下来的 N 个音, 越往后越暗."
          /* 7 个汉字放不进窄标签列 —— compact 时标签独占一行, 不换行 */
          narrow={!compact}
          wide={compact}
        >
          <SegmentedControl
            value={ledUpperNoteCount}
            options={UPPER_NOTE_OPTIONS}
            onChange={setLedUpperNoteCount}
            className="w-full"
          />
        </Row>
      )}

      <Row label="跟随源" narrow={compact}>
        <div className="flex flex-col gap-1.5">
          <Switch
            checked={ledFollowPlayback}
            onChange={setLedFollowPlayback}
            disabled={!ledEnabled}
            label={compact ? '跟随乐谱' : '跟随乐谱 (学习用)'}
            title="灯带跟着谱面走 —— 学习用."
          />
          <Switch
            checked={ledFollowInput}
            onChange={setLedFollowInput}
            disabled={!ledEnabled}
            label={compact ? '按键跟随' : '按键跟随 (单独模式, 默认关)'}
            title="单独模式 —— 灯带只跟键盘输入走, 默认关."
          />
        </div>
      </Row>

      {afterFollowSource}

      <Row label="校准模式" wide={compact}>
        <Switch
          checked={ledCalibrate}
          onChange={setLedCalibrate}
          disabled={!ledEnabled}
          label="左手白黑 / 右手白黑 各亮一格"
          title="左边是左手的白键/黑键, 右边是右手的白键/黑键 —— 各显示自己的颜色 (上灯带显示预告行的颜色), 亮度跟着上面的「亮度」走. 换配色方案或改自定义颜色都会跟着变."
        />
      </Row>
    </>
  )

  /* 调色板 —— 当前音 (主灯带) + 预告行 (上灯带) 各 4 色.
     compact 时四个色一行, 整块矮一半. */
  const palette = (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/70 bg-bg/40 p-2.5">
      <PaletteGroup
        title="当前音 (主灯带)"
        sub="高饱和纯色 · 色号可直接输入"
        cols={compact ? 4 : 2}
        leftWhite={ledColors.leftWhite}
        leftBlack={ledColors.leftBlack}
        rightWhite={ledColors.rightWhite}
        rightBlack={ledColors.rightBlack}
        onChange={setLedColors}
        disabled={!ledEnabled}
      />
      <PaletteGroup
        title="预告行 (上灯带)"
        sub="第一排纯、第二排柔, 两排不混 · 色号可直接输入"
        cols={compact ? 4 : 2}
        leftWhite={ledUpcomingColors.leftWhite}
        leftBlack={ledUpcomingColors.leftBlack}
        rightWhite={ledUpcomingColors.rightWhite}
        rightBlack={ledUpcomingColors.rightBlack}
        onChange={setLedUpcomingColors}
        disabled={!ledEnabled}
      />
      <div className="flex items-center gap-2 self-start">
        <CopyAllButton
          text={paletteSummary(ledColors, ledUpcomingColors)}
          label="复制全部色值"
        />
        <button
          onClick={resetLedColors}
          disabled={!ledEnabled}
          className="h-6 px-2 rounded-md text-xs border border-border bg-panel text-muted hover:text-text hover:border-borderStrong transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          恢复方案 C 默认色
        </button>
      </div>
    </div>
  )

  if (compact) {
    // 抽屉第三栏: 两小栏并排 + 调色板压底 —— 整块一屏放得下.
    return (
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-x-5 items-start">
          <div className="flex flex-col gap-3 min-w-0">{leftGroup}</div>
          <div className="flex flex-col gap-3 min-w-0">{rightGroup}</div>
        </div>
        {palette}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {leftGroup}
      {rightGroup}
      {palette}
    </div>
  )
}

/** 一条带标签的亮度滑杆. */
function LevelSlider({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted w-8 shrink-0">{label}</span>
      <Slider
        value={value}
        min={0}
        max={1}
        step={0.01}
        onChange={onChange}
        disabled={disabled}
        className="flex-1"
        ariaLabel={`预告行${label}亮度`}
      />
      <span className="w-11 text-right tabular-nums text-xs text-muted shrink-0">
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

/** 一组 4 色 (左手/右手 × 白键/黑键). */
function PaletteGroup({
  title,
  sub,
  cols = 2,
  leftWhite,
  leftBlack,
  rightWhite,
  rightBlack,
  onChange,
  disabled,
}: {
  title: string
  sub: string
  /** 4 个色摆几列 —— 2 = 两行两列 (窄), 4 = 一行四个 (宽). */
  cols?: 2 | 4
  leftWhite: [number, number, number]
  leftBlack: [number, number, number]
  rightWhite: [number, number, number]
  rightBlack: [number, number, number]
  onChange: (patch: {
    leftWhite?: [number, number, number]
    leftBlack?: [number, number, number]
    rightWhite?: [number, number, number]
    rightBlack?: [number, number, number]
  }) => void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div>
        <div className="text-xs font-medium text-text">{title}</div>
        <div className="text-[11px] text-subtle">{sub}</div>
      </div>
      <div className={cx('grid gap-x-3 gap-y-1.5', cols === 4 ? 'grid-cols-4' : 'grid-cols-2')}>
        <ColorRow
          label="左白键"
          rgb={leftWhite}
          onChange={(c) => onChange({ leftWhite: c })}
          disabled={disabled}
        />
        <ColorRow
          label="左黑键"
          rgb={leftBlack}
          onChange={(c) => onChange({ leftBlack: c })}
          disabled={disabled}
        />
        <ColorRow
          label="右白键"
          rgb={rightWhite}
          onChange={(c) => onChange({ rightWhite: c })}
          disabled={disabled}
        />
        <ColorRow
          label="右黑键"
          rgb={rightBlack}
          onChange={(c) => onChange({ rightBlack: c })}
          disabled={disabled}
        />
      </div>
    </div>
  )
}

export function rgbToHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3
    ? h.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)]
  return [v[0] || 0, v[1] || 0, v[2] || 0]
}

function ColorRow({
  label,
  rgb,
  onChange,
  disabled,
}: {
  label: string
  rgb: [number, number, number]
  onChange: (c: [number, number, number]) => void
  disabled?: boolean
}) {
  const hex = rgbToHex(rgb)
  const [draft, setDraft] = useState(hex)
  const [focused, setFocused] = useState(false)
  const colorRef = useRef<HTMLInputElement>(null)

  // 没在编辑的时候, 外面改了色 (切方案 / 恢复默认色) → 跟着刷新
  useEffect(() => {
    if (!focused) setDraft(hex)
  }, [hex, focused])

  /**
   * 提交色号草稿 —— 认 `#rrggbb` / `rrggbb` (大小写都行).
   * 不合法就还原成当前的值 (不弹错, 静默改回去).
   */
  const commit = () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(draft.trim())
    if (!m) {
      setDraft(hex)
      return
    }
    const next = hexToRgb('#' + m[1])
    if (next[0] !== rgb[0] || next[1] !== rgb[1] || next[2] !== rgb[2]) onChange(next)
    else setDraft(rgbToHex(next))
  }

  return (
    // 两行: 上面「色块 + 名字 + 复制」, 下面「色号输入框」.
    // 单行排不下 —— 色号框会把「左白键」挤成一个「左」字.
    <div className={cx('flex flex-col gap-1 text-xs', disabled && 'opacity-40')}>
      <div className="flex items-center gap-1.5">
        <input
          ref={colorRef}
          type="color"
          value={hex}
          onChange={(e) => onChange(hexToRgb(e.target.value))}
          disabled={disabled}
          title={`${label} —— 点左边色块用取色器挑`}
          aria-label={`${label} 取色`}
          className="size-5 shrink-0 cursor-pointer rounded-md border border-border bg-panel p-0.5 disabled:cursor-not-allowed [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
          style={{ ['--swatch' as string]: hex }}
        />
        <span
          className="text-muted flex-1 min-w-0 truncate cursor-pointer"
          title={`${label} —— 点这里打开取色器`}
          onClick={() => {
            const el = colorRef.current as (HTMLInputElement & { showPicker?: () => void }) | null
            if (!el) return
            if (typeof el.showPicker === 'function') {
              try {
                el.showPicker()
                return
              } catch {
                // 老浏览器没有 showPicker → 退回 click
              }
            }
            el.click()
          }}
        >
          {label}
        </span>
        <CopyHex hex={hex} />
      </div>
      {/* 色号输入框 —— 直接敲 #4169e1 这种, 回车生效 */}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          setFocused(true)
          e.currentTarget.select()
        }}
        onBlur={() => {
          setFocused(false)
          commit()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            setDraft(hex)
            e.currentTarget.blur()
          }
        }}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        aria-label={`${label} 色号`}
        title="直接输入色号, 回车确认 (例: #4169e1)"
        className="w-full rounded border border-border bg-bg px-1.5 py-0.5 text-[11px] tabular-nums uppercase text-text outline-none focus:border-accent transition-colors disabled:cursor-not-allowed"
      />
    </div>
  )
}

/**
 * 复制色号的小按钮 —— 单击把 #RRGGBB 写进剪贴板.
 *
 * 用户自己调完色, 直接把 hex 复制走发给我改配色, 不用手抄.
 */
function CopyHex({ hex }: { hex: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  const onCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!(await copyText(hex))) return
    setCopied(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? '已复制' : `点击复制 ${hex}`}
      aria-label={copied ? '已复制色号' : `复制色号 ${hex}`}
      className="size-5 shrink-0 grid place-items-center rounded text-subtle hover:text-accent hover:bg-accent/10 transition-colors cursor-pointer"
    >
      {copied ? <IconCheck size={11} className="text-hit" /> : <IconCopy size={12} />}
    </button>
  )
}

/** 复制一整段文字的按钮 —— 复制成功闪一下「已复制」. */
function CopyAllButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  const onCopy = async () => {
    if (!(await copyText(text))) return
    setCopied(true)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1400)
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      title={`复制:\n${text}`}
      className="h-6 px-2 rounded-md text-xs border border-border bg-panel text-muted hover:text-text hover:border-borderStrong transition flex items-center gap-1"
    >
      {copied ? (
        <>
          <IconCheck size={11} className="text-hit" />
          已复制
        </>
      ) : (
        label
      )}
    </button>
  )
}

/** 把 8 个色拼成一段能直接粘走的文字. */
function paletteSummary(current: LedPalette, upcoming: LedPalette): string {
  const line = (p: LedPalette) =>
    `左白 ${rgbToHex(p.leftWhite)} · 左黑 ${rgbToHex(p.leftBlack)} · 右白 ${rgbToHex(
      p.rightWhite,
    )} · 右黑 ${rgbToHex(p.rightBlack)}`
  return `当前音(主灯带): ${line(current)}\n预告行(上灯带): ${line(upcoming)}`
}
