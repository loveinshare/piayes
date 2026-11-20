// LED 点阵屏设置 —— HUB75 面板 (320x160mm, 2.5mm 点距).
//
// 跟灯带设置是**两回事**, 只是以前塞在同一块面板里:
// - 灯带: 176 颗 WS2812, 推「第几颗什么颜色」, 端口 8080
// - 点阵屏: 128x64 像素, 推整屏 RGB888 图像帧, 端口 8081
//
// 四块屏 1x4 横排 (菊花链) -> 虚拟画布 512x64.
// 选哪几块 -> 树莓派那边就串几块, 前端按屏号把虚拟画布切开发过去.
//
// ★ 2026-11-13: 从 <LedSettings /> 里独立出来, 抽屉里单独占一栏 ——
//   点阵屏和灯带是两套设备两套设置, 挤在一栏里互相干扰.

import { useStore } from '../store'
import { Row, SegmentedControl, Slider, Switch, cx } from './controls'
import { LED_DEVICE_INFO } from '../led/transport/ledConfig'
import { noteCanvasX } from '../led/screen/ScreenRenderer'
import { isBlackKey, midiToName, whiteKeyIndex, MIDI_MIN, MIDI_MAX } from '../render/colors'
import {
  MAX_SCREENS,
  MAX_PORTS,
  SCREEN_LABELS,
  SCREEN_W,
  MIDDLE_C_SCREEN,
  MIDDLE_C_X,
  KEYBOARD_H_MAX,
  NOTE_SCALE_MIN,
  NOTE_SCALE_MAX,
  MARGIN_X,
  WHITE_KEY_W,
  DEFAULT_SCREEN_COLORS,
  type LedScreenColors,
} from '../led/screen/screenConfig'

const FPS_OPTIONS = [15, 30, 60].map((v) => ({ value: v, label: `${v}` }))

/**
 * 可以自己改的颜色 (2026-11-13 用户要求: 「也可以加一个自定义我自己设置」).
 *
 * 默认: 左蓝右红、弹对变绿、左黑键品红、右黑键粉色.
 */
const COLOR_FIELDS: { key: keyof LedScreenColors; label: string }[] = [
  { key: 'left', label: '左手' },
  { key: 'right', label: '右手' },
  { key: 'hit', label: '弹对' },
  { key: 'blackLeft', label: '左黑键' },
  { key: 'blackRight', label: '右黑键' },
]

/**
 * 连接状态的小圆牌 —— 抽屉里那一栏的栏头用.
 */
export function LedScreenStatus() {
  const enabled = useStore((s) => s.ledScreenEnabled)
  const connected = useStore((s) => s.ledScreenConnected)
  const error = useStore((s) => s.ledScreenError)
  const screens = useStore((s) => s.ledScreenScreens)

  const statusText = !enabled
    ? '没启用'
    : connected
      ? `已连接 · 渲染 ${screens.join('/')} 号屏`
      : error
        ? `连不上: ${error}`
        : '连接中…'

  return (
    <span
      className={cx(
        'text-[11px] px-1.5 py-0.5 rounded-full border shrink-0',
        connected
          ? 'bg-hit/15 text-hit border-hit/30'
          : enabled
            ? 'bg-miss/15 text-miss border-miss/30'
            : 'bg-bg text-muted border-border',
      )}
    >
      {statusText}
    </span>
  )
}

export function LedScreenSettings({ compact = false }: { compact?: boolean }) {
  const enabled = useStore((s) => s.ledScreenEnabled)
  const setEnabled = useStore((s) => s.setLedScreenEnabled)
  const host = useStore((s) => s.ledScreenHost)
  const setHost = useStore((s) => s.setLedScreenHost)
  const screens = useStore((s) => s.ledScreenScreens)
  const setScreens = useStore((s) => s.setLedScreenScreens)
  const ports = useStore((s) => s.ledScreenPorts)
  const setPorts = useStore((s) => s.setLedScreenPorts)
  const fps = useStore((s) => s.ledScreenFps)
  const setFps = useStore((s) => s.setLedScreenFps)
  const brightness = useStore((s) => s.ledScreenBrightness)
  const setBrightness = useStore((s) => s.setLedScreenBrightness)
  const keyboardH = useStore((s) => s.ledScreenKeyboardH)
  const setKeyboardH = useStore((s) => s.setLedScreenKeyboardH)
  const noteScale = useStore((s) => s.ledScreenNoteScale)
  const setNoteScale = useStore((s) => s.setLedScreenNoteScale)
  const flip = useStore((s) => s.ledScreenFlip)
  const setFlip = useStore((s) => s.setLedScreenFlip)
  const vflip = useStore((s) => s.ledScreenVFlip)
  const setVFlip = useStore((s) => s.setLedScreenVFlip)
  const colors = useStore((s) => s.ledScreenColors)
  const setColors = useStore((s) => s.setLedScreenColors)
  const testMode = useStore((s) => s.ledScreenTestMode)
  const setTestMode = useStore((s) => s.setLedScreenTestMode)
  const ledDevice = useStore((s) => s.ledDevice)
  // 当前曲子 —— 用来提醒「这块屏覆盖不到某些音」.
  const song = useStore((s) => s.song)
  const transpose = useStore((s) => s.transpose)

  const toggleScreen = (n: number) => {
    const next = screens.includes(n) ? screens.filter((x) => x !== n) : [...screens, n]
    // 一块都不选 = 什么都不亮 —— 没意义, 直接挡回去 (store 里也兜了一层).
    if (!next.length) return
    // 屏数变了 -> 口数不再整除的话, store 会自动退回 1 个口.
    setScreens(next)
  }

  // 这几块屏在虚拟画布上覆盖哪一段 (屏号是画布上的位置, 1..4 从左往右)
  const sorted = [...screens].sort((a, b) => a - b)
  const coverX0 = (sorted[0] - 1) * SCREEN_W
  const coverX1 = sorted[sorted.length - 1] * SCREEN_W
  const contiguous = sorted.length === sorted[sorted.length - 1] - sorted[0] + 1

  // 口数选项 —— 只能选能整除屏数的 (每个口的链必须一样长)
  const portOptions = Array.from({ length: MAX_PORTS }, (_, i) => i + 1).filter(
    (p) => p <= sorted.length && sorted.length % p === 0,
  )
  // 存的口数跟当前屏数不配 (比如只剩 1 块屏却存着 2 个口) -> 界面上退回 1
  const shownPorts = portOptions.includes(ports) ? ports : (portOptions[0] ?? 1)
  // 口 -> 屏号的分配 (每个口连续几块)
  const portDesc = Array.from({ length: shownPorts }, (_, i) => {
    const per = Math.floor(sorted.length / shownPorts)
    const group = sorted.slice(i * per, (i + 1) * per)
    return `Port${i + 1} = ${group.join('、')} 号屏`
  }).join('; ')

  // 当前曲子的音高落在画布哪一段 —— 超出覆盖范围就看不见
  let songLo = Infinity
  let songHi = -Infinity
  for (const n of song?.notes ?? []) {
    const x = noteCanvasX(n.midiNote, transpose)
    if (x < songLo) songLo = x
    if (x > songHi) songHi = x
  }
  const hasSong = songLo <= songHi
  const outOfRange = hasSong && (songLo < coverX0 || songHi >= coverX1)

  return (
    <>
      <Row label="启用" narrow={compact}>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="点阵屏"
          title="把乐谱画到 HUB75 点阵面板上 (树莓派端口 8081). 跟灯带互不影响, 可以同时开."
        />
      </Row>

      <Row label="设备地址" narrow={compact}>
        <input
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          disabled={!enabled}
          placeholder="树莓派的 IP"
          className="flex-1 min-w-0 h-7 bg-bg border border-border rounded-lg px-2 text-xs text-text placeholder:text-muted disabled:opacity-40 focus:border-accent/60 outline-none transition-colors"
        />
      </Row>

      <Row
        label="渲染哪几块屏"
        wide={compact}
        hint="按块选 —— 一共选几块就渲染几块 (怎么串看下面的「HUB75 口」). 一块屏 = 320x160mm, 覆盖 13.6 个白键."
      >
        <div className="flex items-center gap-1.5">
          {Array.from({ length: MAX_SCREENS }, (_, i) => i + 1).map((n) => {
            const on = screens.includes(n)
            return (
              <button
                key={n}
                type="button"
                onClick={() => toggleScreen(n)}
                disabled={!enabled}
                aria-pressed={on}
                title={`${SCREEN_LABELS[n - 1]} —— 虚拟画布 x ${(n - 1) * SCREEN_W}..${n * SCREEN_W - 1}`}
                className={cx(
                  'size-8 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40',
                  on
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border bg-bg text-muted hover:text-text',
                )}
              >
                {n}
              </button>
            )
          })}
        </div>
      </Row>

      <Row
        label="HUB75 口"
        narrow={compact}
        hint="每个口是一条独立的菊花链 (自己的数据线, 但行地址是共用的). 四块屏 1x4 横排串成一条链就选 1; 2x2 摆法选 2: Port1 接上面一行 (1、2 号屏), Port2 接下面一行 (3、4 号屏). 行地址共用, 所以 2x2 是「一条长画面折成上下两行」, 不是一张 256x128 的画面 —— 上面一行是琴键的低音半段, 下面一行是高音半段."
      >
        <SegmentedControl
          value={shownPorts}
          options={portOptions.map((p) => ({ value: p, label: `${p} 个` }))}
          onChange={setPorts}
          disabled={!enabled}
          className="w-full"
        />
      </Row>

      <Row
        label="自检"
        narrow={compact}
        hint="查屏用: 「纯色轮播」整条链一个颜色每 4 秒换 (红 → 绿 → 蓝 → 白), 查坏点; 「分屏分色」每块屏一个固定颜色 (1 红 / 2 绿 / 3 蓝 / 4 白), 看面板上哪块物理屏是几号屏 (接线顺序对不对). 打开时曲子画面会被盖住, 查完记得关."
      >
        <SegmentedControl
          value={testMode}
          options={[
            { value: 'off', label: '关' },
            { value: 'solid', label: '纯色轮播' },
            { value: 'perScreen', label: '分屏分色' },
          ]}
          onChange={setTestMode}
          disabled={!enabled}
          className="w-full"
        />
      </Row>

      <Row
        label="帧率"
        narrow={compact}
        hint="面板实测能画到 55 帧/秒 (发多少画多少, 不丢帧). 30fps 一帧 24KB, 局域网完全够."
      >
        <SegmentedControl
          value={fps}
          options={FPS_OPTIONS}
          onChange={setFps}
          disabled={!enabled}
          className="w-full"
        />
      </Row>

      <Row
        label="亮度"
        narrow={compact}
        hint="整屏亮度, 拖动即时生效 (树莓派按帧缩放, 不会重连/闪黑). 面板像素电流跟亮度成正比 —— 太高会把树莓派的 5V 拖塌, 表现为随机像素 + 整屏闪, 所以默认 60."
      >
        <div className="flex items-center gap-2 w-full">
          <Slider
            value={brightness}
            min={1}
            max={100}
            step={1}
            onChange={setBrightness}
            disabled={!enabled}
            className="flex-1 min-w-0"
            ariaLabel="点阵屏亮度"
          />
          <span className="text-[11px] text-muted tabular-nums w-14 text-right shrink-0">
            {brightness}%
          </span>
        </div>
      </Row>

      <Row
        label="琴键区"
        narrow={compact}
        hint="底部那排键面占多少行. 拉到 0 就是关掉 —— 音符落到底边, 没有键面当参照."
      >
        <div className="flex items-center gap-2 w-full">
          <Slider
            value={keyboardH}
            min={0}
            max={KEYBOARD_H_MAX}
            step={2}
            onChange={setKeyboardH}
            disabled={!enabled}
            className="flex-1 min-w-0"
            ariaLabel="琴键区高度"
          />
          <span className="text-[11px] text-muted tabular-nums w-14 text-right shrink-0">
            {keyboardH === 0 ? '关闭' : `${keyboardH} 行`}
          </span>
        </div>
      </Row>

      <Row
        label="音符大小"
        narrow={compact}
        hint="音符方块的**长度**比例 (1 = 当前大小). 放大后下沿不动, 往上长 —— 短音更好认. 宽度不变 (不会变胖变瘦)."
      >
        <div className="flex items-center gap-2 w-full">
          <Slider
            value={noteScale}
            min={NOTE_SCALE_MIN}
            max={NOTE_SCALE_MAX}
            step={0.1}
            onChange={setNoteScale}
            disabled={!enabled}
            className="flex-1 min-w-0"
            ariaLabel="音符大小比例"
          />
          <span className="text-[11px] text-muted tabular-nums w-14 text-right shrink-0">
            {Math.round(noteScale * 100)}%
          </span>
        </div>
      </Row>

      <Row
        label="配色"
        wide={compact}
        hint="左手蓝 / 右手红 / 弹对了变绿; 黑键按中央 C 分两半 —— 左边品红、右边粉色. 点色块可以自己改成别的颜色."
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {COLOR_FIELDS.map((f) => (
            <label
              key={f.key}
              className="flex items-center gap-1.5 text-[11px] text-muted cursor-pointer"
            >
              <input
                type="color"
                value={colors[f.key]}
                onChange={(e) => setColors({ [f.key]: e.target.value } as Partial<LedScreenColors>)}
                disabled={!enabled}
                className="size-6 rounded border border-border bg-bg p-0 cursor-pointer disabled:opacity-40"
                aria-label={`点阵屏${f.label}颜色`}
              />
              {f.label}
            </label>
          ))}
          <button
            type="button"
            onClick={() => setColors(DEFAULT_SCREEN_COLORS)}
            disabled={!enabled}
            className="text-[11px] text-muted hover:text-accent transition-colors disabled:opacity-40"
            title="恢复默认配色"
          >
            默认
          </button>
        </div>
      </Row>

      <Row
        label="画面翻转"
        narrow={compact}
        hint="进线 (插头) 在**左边**、从左往右串 → 关; 进线在右边、从右往左串 → 开. 反了的现象: 整条画面左右镜像 (中央 C 跑到第 3 块屏)."
      >
        <Switch
          checked={flip}
          onChange={setFlip}
          label="画面左右翻转"
          title="把整条链**左右镜像**: 屏与屏的顺序换过来, 每块屏内部的两块模组也换过来. 进线在右边时开, 在左边时关."
        />
      </Row>

      <Row
        label="上下翻转"
        narrow={compact}
        hint="面板的行 0 跑到了物理下边时打开 —— 现象是**琴键区跑到屏幕顶上**. 跟左右翻转是两回事, 只改上下."
      >
        <Switch
          checked={vflip}
          onChange={setVFlip}
          label="画面上下翻转"
          title="把画面**上下镜像** (行 0 和行 63 换位). 面板倒装 / 行序反了就开这个."
        />
      </Row>

      {/* 覆盖范围 —— 面板能显示哪些音, 一眼得看出来. */}
      <p className="text-xs text-subtle leading-relaxed border-l-2 border-border/70 pl-2">
        这几块屏覆盖画布 x {coverX0}..{coverX1 - 1}
        {contiguous ? '' : ' (选的屏不连着, 中间有空档)'}
        , 大概是 {midiToName(midiAtX(coverX0))}..{midiToName(midiAtX(coverX1 - 1))} .
        中央 C 在<b className="text-text">第 {MIDDLE_C_SCREEN} 块屏</b>
        (画布 x = {MIDDLE_C_X.toFixed(0)}px)
        {screens.includes(MIDDLE_C_SCREEN) ? ', 当前看得见那条白线.' : ', 当前看不到它.'}
        {shownPorts > 1 ? ` 端口分配: ${portDesc}.` : ''}
      </p>

      {/* 曲子里的音超出覆盖范围 —— 直接点名, 免得对着空屏找原因. */}
      {outOfRange && (
        <p className="text-xs text-miss leading-relaxed border-l-2 border-miss/50 pl-2">
          ⚠ 当前曲子的音高超出这几块屏
          {songLo < coverX0 && ` —— 低于 ${midiToName(midiAtX(coverX0))} 的看不到`}
          {songHi >= coverX1 && ` —— 高于 ${midiToName(midiAtX(coverX1 - 1))} 的看不到`}
          . 加上相邻的屏就能覆盖 (屏幕是横排的, 按顺序加).
        </p>
      )}

      {/* 灯带如果还挂在树莓派上, 就会跟面板抢 GPIO18 —— 必须提醒. */}
      {enabled && ledDevice === 'pi' && (
        <p className="text-xs text-miss leading-relaxed border-l-2 border-miss/50 pl-2">
          ⚠ 灯带设备选的是<b className="text-text">树莓派</b>. 面板要用树莓派的
          GPIO18 (硬件 PWM 的 OE), 灯带再跑在树莓派上会把面板顶掉 (屏幕乱闪或全黑).
          请把灯带切到 <b className="text-text">ESP32</b>
          ({LED_DEVICE_INFO.esp32.defaultHost}).
        </p>
      )}
    </>
  )
}

/** 画布上的 x -> 大概是哪个音 (取离它最近的白键). */
function midiAtX(x: number): number {
  const idx = Math.max(0, Math.round((x - MARGIN_X) / WHITE_KEY_W))
  for (let m = MIDI_MIN; m <= MIDI_MAX; m++) {
    if (!isBlackKey(m) && whiteKeyIndex(m) === idx) return m
  }
  return MIDI_MIN
}
