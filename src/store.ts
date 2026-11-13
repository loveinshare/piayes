// Zustand UI 状态
// 引擎内部状态（playingNotes / hitNotes / lateNotes）走 Player class field，不进 store
// 避免 60fps setState 触发整树重渲染

import { create } from 'zustand'
import { useAuth } from './auth'
import type { Song, Hand, KeyLabelMode } from './types'
import {
  type LedColors,
  type LedUpcomingColors,
} from './led/LedController'
import { UPPER_MIN_NOTES, UPPER_MAX_NOTES } from './led/dualStrip'
import {
  LED_DEVICE_INFO,
  hostAfterDeviceSwitch,
  isDefaultHostOf,
  type LedDevice,
} from './led/transport/ledConfig'
import {
  DEFAULT_UPCOMING_COLORS,
  DEFAULT_UPPER_LEVEL_MAX,
  DEFAULT_UPPER_LEVEL_MIN,
  SCHEME_C,
  SCHEME_COLOR_VERSION,
  SCHEME_D,
  type LedSchemeId,
} from './led/schemes'
import { inferHands } from './parser/inferHands'
import { noteHand, resolveHand } from './hand'
import {
  KEYBOARD_H,
  KEYBOARD_H_MAX,
  NOTE_SCALE_MAX,
  NOTE_SCALE_MIN,
  DEFAULT_SCREEN_COLORS,
  sanitizeScreenColors,
  type LedScreenColors,
} from './led/screen/screenConfig'

// 手别判定搬到 ./hand 了 (避免 store → LedController → dualStrip → store 的循环依赖),
// 这里原样再导出 —— 外部的 import 路径不变.
export { noteHand, resolveHand }

/**
 * 4 种 mode:
 * - 'playback'    钢琴播放整曲 (电钢走 MIDI Out), 不打分不冻结
 * - 'both'        双手练
 * - 'right'       只练右手 → 左手自动伴奏走 MIDI Out
 * - 'left'        只练左手 → 右手自动伴奏走 MIDI Out
 */
export type PracticeHand = 'playback' | 'both' | 'right' | 'left'

/** 上灯带显示几个音 (每只手各 N 个) —— 夹到 1..6 (上限是功耗, 见 dualStrip.ts). */
function clampUpperNoteCount(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.max(UPPER_MIN_NOTES, Math.min(UPPER_MAX_NOTES, Math.round(n)))
}

/** 预告行亮度系数 —— 夹到 0..1. */
function clampLevel(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.max(0, Math.min(1, v))
}

/** 配色方案 id —— 非法值一律当 'c'. */
function clampSchemeId(v: unknown): LedSchemeId {
  return v === 'c' || v === 'd' || v === 'auto' || v === 'custom' ? v : 'c'
}

/** 点阵屏帧率 —— 夹到 5..60 (再高带宽也吃不住, 再低会看出卡顿). */
function clampScreenFps(n: number): number {
  if (!Number.isFinite(n)) return 30
  return Math.max(5, Math.min(60, Math.round(n)))
}

/** 点阵屏亮度 —— 1..100 (0 会让屏全黑, 等于关掉, 所以留 1 起步). */
function clampScreenBrightness(n: number): number {
  if (!Number.isFinite(n)) return 60
  return Math.max(1, Math.min(100, Math.round(n)))
}

/**
 * 点阵屏的屏号列表 —— 只保留 1..4 里合法的, 去重、升序.
 *
 * 空列表不行 (一块屏都不亮等于白折腾) -> 至少留一块.
 */
function sanitizeScreenList(list: unknown): number[] {
  const src = Array.isArray(list) ? list : []
  const out = Array.from(
    new Set(src.filter((n) => Number.isFinite(n) && n >= 1 && n <= 4).map((n) => Math.round(n))),
  ).sort((a, b) => a - b)
  return out.length ? out : [3]
}

/** 琴键区高度 (行) —— 0 = 关闭, 最多 KEYBOARD_H_MAX. */
function clampKeyboardH(n: number): number {
  if (!Number.isFinite(n)) return KEYBOARD_H
  return Math.max(0, Math.min(KEYBOARD_H_MAX, Math.round(n)))
}

/** 音符方块大小比例 —— 0.5x .. 2x. */
function clampNoteScale(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(NOTE_SCALE_MIN, Math.min(NOTE_SCALE_MAX, Math.round(n * 100) / 100))
}

/**
 * 当前曲目是从哪儿来的.
 *
 * 编辑器「保存到乐库」要靠它判断:
 *  - scope='public' 且带 itemId → 覆盖公共乐库里那一条 (管理员)
 *  - scope='mine'  → 存自己的私有库
 *  - null (本地拖进来的文件) → 没有出处, 只能当新曲子存
 */
export interface LibrarySource {
  /** 乐库条目 id (公共乐库 = manifest 里的 id; 我的谱子 = `u-<scoreId>`) */
  id: string
  /** 公共乐库的分组 id (我的谱子没有分组, 空串) */
  groupId: string
  scope: 'public' | 'mine'
  /** 服务端路径 (公共乐库 = manifest 里的 file; 我的谱子 = /api/scores/:id/file) */
  file: string
  /** 「我的谱子」的服务端记录 id (删除/覆盖用) */
  scoreId?: number
  title: string
}

interface UIState {
  song: Song | null
  /** 当前曲目的出处 (见 LibrarySource). 从本地文件加载时是 null. */
  librarySource: LibrarySource | null
  /**
   * 乐库列表刷新计数 —— 存完 (公共/私有) 自增, 乐库面板看到变了就重新拉列表.
   *
   * 以前存完没人通知乐库面板, 面板手里还是旧 manifest → 存了也看不见.
   */
  libraryVersion: number
  /** 刷新后要展开/定位的条目 id (刚存的那一条). */
  libraryFocusId: string | null
  hand: PracticeHand
  /**
   * 手别判定方式 (spec P2-6):
   *  - 'auto'  —— 启发式 (声部聚类 / track 比较), 单 track 曲子是**猜**的
   *  - 'pitch' —— 用户手动指定"按音高切分"
   * 猜错了可以在设置里改 —— 改完立刻重算当前曲子的 note.hand.
   */
  handInferMode: 'auto' | 'pitch'
  /**
   * 手别重算版本号 —— note.hand 是就地改的 (Player 持有同一个 song 引用),
   * 所以靠这个计数器让 UI (LED 上色 / 提示) 重新计算.
   */
  handInferVersion: number
  /**
   * Wait 模式开关 — 直接对应 UI 勾选状态.
   * effectiveWait = wait && hand !== 'playback'. 老 LS 字段兼容.
   * 默认 ON, 用户取消勾选 = 不冻结 (体验练).
   */
  wait: boolean
  /**
   * 抢先模式 (Lead mode) 开关 — 直接对应 UI 勾选状态.
   *
   * 抢先 = Wait + 「弹对了才推进」: 播放头**冻**在现在该弹的那一组音上,
   * 弹对了才解冻, 按 1× 走到下一个待弹组再冻上; 提前按不报错, 灯一直亮到弹对.
   *
   * 依赖 wait —— Wait 关掉时抢先自动失效 (见 effectiveLead).
   */
  leadNext: boolean
  /**
   * 老的 waitMs 字段保留 — PlayAlong 不再使用 (冻结是二值),
   * 但 LS 里可能保存, 不要破坏老用户的设置.
   */
  waitMs: number
  /**
   * 跟弹判定窗口 (ms) —— 「按早/按晚多少还算命中」.
   * - 用户**没填过** → 按乐曲速度自动缩放 (规格 P1-5):
   *   hit = min(toleranceMs, clamp(一拍 * 50%, 150, 300)) —— 120bpm → 250ms.
   * - 用户**填过** (见 `toleranceCustom`) → 填的那个数**就是**窗口本身.
   * - 用户提前按 (early): 文件 NoteOn 到达时 dt < 窗口 → early hit
   * - 用户晚按 (late rescue): fileNoteOn 后窗口内补弹 → late hit
   * - 超出窗口不算 hit, 走 recent-only / wrong
   * 默认 300ms (同 sightread 的 GOOD_RANGE), 范围 100-2000.
   *
   * ★ 2026-11-06: 上限从 500 放宽到 2000 —— 500ms 对「跟着耳钢琴/慢练」
   *   太紧 (一首慢板本来就弹不准), 用户明确要求容差最大能到 2000ms.
   *   同时改了口径: 以前这个数只是「上限」(永远被曲速缩放夹在 300ms 以内),
   *   调到 300 以上等于没调 —— 现在用户填过的数**直接生效**.
   */
  toleranceMs: number
  /**
   * 用户自己填过容差吗 —— 见上面 `toleranceMs` 的两种口径.
   * 旧 prefs 里没这个字段 → false → 保持原来的「按曲速缩放」行为.
   */
  toleranceCustom: boolean
  /** 播放时是否走 3-2-1-GO 倒计时 */
  useCountdown: boolean
  /**
   * 输出延迟补偿 (spec P1-3).
   *
   * latencyAuto = true → 用 AudioContext 检测到的输出延迟 (蓝牙耳机 100~200ms);
   * 否则用 latencyOffsetMs 手动值.
   *
   * 默认 0 = 视觉对齐 —— practice 模式下被判定的那只手**不发声**, 用户是照着
   * 下落音符/乐谱弹的, 画面在 song 域没有延迟. 习惯"听伴奏对齐"的用户才需要开.
   */
  latencyAuto: boolean
  latencyOffsetMs: number
  /**
   * 检测到的输出延迟 (ms) —— 由 Player 每帧从 AudioContext 采样 (spec P1-3).
   * 只在数值变化时才 set, 所以不会引起额外重渲染.
   */
  outputLatencyMs: number
  metronome: boolean
  volume: number
  transpose: number
  loopRange: [number, number] | null
  countdown: number | null
  isPlaying: boolean
  currentTime: number
  speed: number
  midiOutputId: string | null
  /** 用户选的输出设备名 (仅用于文案) */
  midiOutputName: string | null
  /**
   * 输出端口**运行时**是否真的连着.
   * 与 midiOutputId (用户的选择) 是两个概念 —— 设备被拔掉时 id 还在,
   * 但 connected 变 false, 状态栏据此变红 (spec P1-12).
   */
  midiOutputConnected: boolean
  inputSource: 'keyboard' | 'midi'
  midiInputId: string | null
  hits: number
  misses: number
  perfects: number
  goods: number
  errors: number
  streak: number
  maxStreak: number
  /** 最近一次错按 (Wrong) — Fallback render toast 用, 1.5s 后 UI 自隐. */
  lastWrongMidi: number | null
  lastWrongAt: number
  /** Wait 模式正在冻结 → 等你弹对. StatusBar 显示标识用. */
  frozenWaiting: boolean
  /** LED 灯带跟随: 启用 / 亮度 / Pi host / 当前连接状态 */
  ledEnabled: boolean
  ledBrightness: number // 0..1
  ledHost: string
  /**
   * 灯带设备选择 —— **用户自己选**, 没有 'auto'.
   *
   * - 'pi' —— 树莓派 (ws_led_bridge.py), 默认
   * - 'esp32' —— ESP32 (新固件自带 WS server, 端口 8080)
   *
   * ★ 2026-11-10: 原来是 'ble' | 'ws' (蓝牙 or WiFi). 蓝牙那条路删了 ——
   *   ESP32 现在跟树莓派一样跑 WebSocket 程序, 协议一样, 不用配对.
   *
   * 为什么没有 'auto' (2026-10-26): 「自动挑一个」正是用户报
   * 「换回树莓派但没自动连接」的根因 —— 配对过但离线的 ESP32 会让
   * gatt.connect() 挂死, 树莓派那条分支永远走不到, 而且**不报错、不重试**,
   * 连切后端都切不动. 现在选哪个就只连哪个, 连不上就明说.
   */
  ledDevice: LedDevice
  /** 实际连上的设备 (null = 没连上) —— UI 显示用. */
  ledActiveDevice: LedDevice | null
  /** 最近一次连接失败的提示 (null = 没错误). */
  ledError: string | null
  /**
   * 设备令牌 (spec P1-10) —— 与 /opt/bt-gpio/led_token 里的值一致.
   * 空字符串 = 不带令牌 (旧版本行为).
   */
  ledToken: string
  ledConnected: boolean
  /** 中央 C 校准: 开启后灯带对应位置一直亮白色, 用于校准灯带跟琴键对应 */
  ledCalibrate: boolean
  /** LED 是否跟随软件 MIDI 乐谱播放 (LED 的主要功能 — 用于学习时看键位).
   *  默认 ON, 跟 ledEnabled 互相独立: 关掉这个就只看按键 (或不亮). */
  ledFollowPlayback: boolean
  /** LED 是否跟随按键 (电钢或键盘). 这是个「单独模式」, 默认 OFF.
   *  开着的用户多半是想看自己弹了什么; 关着的就是只看乐谱. */
  ledFollowInput: boolean
  /**
   * 左手 / 右手的灯分别开关 (首页的两个勾选框). 默认都开着.
   *
   * 关掉一只手 → 那只手当前亮着的灯立刻全灭 (静默), 之后也不点亮.
   */
  ledHandLeft: boolean
  ledHandRight: boolean
  /** 4 色调色板 (用户自定义) */
  ledColors: LedColors
  /**
   * 上灯带 (预告行) 的 4 色调色板 —— 降饱和 + 轻微色彩漂移,
   * 跟主灯带 (当前行) 拉开层次, 两排不会混.
   */
  ledUpcomingColors: LedUpcomingColors
  /**
   * 灯带配色方案.
   *
   * - 'c'      方案 C (默认, 耐看) —— 左手正蓝/品蓝, 右手统一深红
   * - 'd'      方案 D (快速, 高辨识) —— 右手黑键更偏品红
   * - 'auto'   按曲速自动选 (>= 120 BPM → D, 否则 C)
   * - 'custom' 用户手动调过色 —— 不再被方案覆盖
   */
  ledScheme: LedSchemeId
  /**
   * Playback LED 提前/延迟: 单位 100ms, 范围 -9..+9.
   * 正数 = LED 早于声音亮 (给用户反应时间); 负数 = LED 晚于声音亮.
   * 0 = 不调整 (Player 直发, 默认).
   * 只对 playback LED 生效; 输入 LED 不参与.
   */
  ledOffsetUnits: number
  /**
   * 双色带模式: 两条灯带串联 (352 颗).
   *  - 下面那条 (主灯带, 176 颗) 照旧显示正在响的音;
   *  - 上面那条 (上灯带, 176 颗) 显示左手 / 右手各自的**下一个音**.
   *
   * 第二条带是**反着接**的 (接缝在最右边) —— 映射已做补偿, 两条带物理位置对齐.
   * 树莓派和 ESP32 都支持 (两边的 init count 白名单都是 176 / 352).
   */
  ledDualStrip: boolean
  /** 上灯带亮度 = 主灯带亮度 × 这个比例 (0..1). 默认 0.7. */
  ledUpperBrightnessRatio: number
  /**
   * 预告行的**最亮**那个音的相对亮度 (0..1). 默认 0.88.
   * 预告行的**最暗** (第 N 个音) 是 ledUpperLevelMin, 中间按等比数列插值.
   */
  ledUpperLevelMax: number
  /** 预告行的**最暗**那个音的相对亮度 (0..1). 默认 0.46. */
  ledUpperLevelMin: number
  /**
   * 上灯带显示「接下来几个音」—— **每只手各 N 个** (用户 2026-10-31 定的).
   *
   * 越往后越暗 (按 ledUpperLevelMax → ledUpperLevelMin 的等比阶梯),
   * 所以一眼能看出「马上要弹哪个」.
   * 范围 1..6 (上限是功耗: 4N + 主灯带几颗 ≤ 固件的 30 颗上限).
   */
  ledUpperNoteCount: number
  /**
   * 虚拟键盘上的音名标号模式 (用户 2026-10-30: "D3 之类的标号, 我不认识").
   *  - 'off' 不标
   *  - 'c'   只标每个八度的 C
   *  - 'all' 全标 (默认)
   */
  keyLabels: KeyLabelMode

  /* ── LED 点阵屏 (HUB75 面板, 走树莓派的 matrix_server) ────────────── */

  /** 点阵屏是否启用 */
  ledScreenEnabled: boolean
  /** 点阵屏设备地址 (树莓派, 端口 8081) */
  ledScreenHost: string
  /**
   * 渲染哪几块屏 (1..4, 升序).
   *
   * 一块屏 = 128x64 像素 (320x160mm @2.5mm 点距); 四块 1x4 横排 = 菊花链.
   * 选几块 -> 树莓派那边菊花链就串几块, 前端把虚拟画布按屏号切开发过去.
   */
  ledScreenScreens: number[]
  /** 点阵屏帧率 (fps) —— 30 是默认 (24KB/帧, 局域网够用). */
  ledScreenFps: number
  /**
   * 点阵屏亮度 (0..100).
   *
   * 跟灯带的 `ledBrightness` (0..1) 是两回事: 面板是整屏图像, 亮度由树莓派
   * 按帧缩放 (matrix.brightness), 改它**不会重连**、也不会闪黑.
   * 默认 60 —— 实测 100% + 大面积白色会把 Pi 的 5V 拖塌 (欠压 = 随机像素).
   */
  ledScreenBrightness: number
  /**
   * 点阵屏底部琴键区高度 (行, 0 = 关闭).
   *
   * 关掉的话音符区就是整屏 64 行 —— 音符落到底边, 没有键面当参照.
   */
  ledScreenKeyboardH: number
  /** 点阵屏音符方块大小比例 (1 = 当前大小, 0.5 .. 2). */
  ledScreenNoteScale: number
  /**
   * 点阵屏画面左右翻转.
   *
   * 菊花链上模组的顺序由接线决定: 插头 (进线) 在右边时链是从右往左串的,
   * 不翻的话画面整个是反的 (中央 C 跑到另一头去).
   */
  ledScreenFlip: boolean
  /**
   * 点阵屏配色 (左手 / 右手 / 命中 / 左黑键 / 右黑键).
   *
   * 默认: 左蓝右红、弹对变绿、左黑键品红、右黑键粉色.
   * 用户可以在点阵屏设置里逐个改.
   */
  ledScreenColors: LedScreenColors
  /** 运行时连接状态 (断连 -> false) */
  ledScreenConnected: boolean
  /** 运行时错误信息 */
  ledScreenError: string | null
  /** 最近弹过的曲目 (最多 5, library kind only). 启动时优先加载 [0] 静默恢复. */
  lastPlayedList: LastPlayed[]
  /** 收藏夹 (用户收藏的曲目). 见 Favourite. */
  favorites: Favourite[]

  setSong: (s: Song | null) => void
  /** 记下当前曲目的出处 (从乐库加载时记, 从本地文件加载时清空) */
  setLibrarySource: (s: LibrarySource | null) => void
  /**
   * 乐库变了 (存完 / 删完) —— 让乐库面板重新拉列表.
   * focusId: 刚存的那一条 (面板会展开它所在的分组).
   */
  bumpLibrary: (focusId?: string) => void
  /** 改手别判定方式 —— 立刻重算当前曲子的 note.hand (spec P2-6) */
  setHandInferMode: (m: 'auto' | 'pitch') => void
  setHand: (h: PracticeHand) => void
  setWait: (b: boolean) => void
  /** UI 切 toggle 时调用, 同时存 LS. */
  setWaitUserOverride: (b: boolean) => void
  /** 抢先模式开关 (灯带显示下一个音 + 允许抢拍), 同时存 LS. */
  setLeadUserOverride: (b: boolean) => void
  setWaitMs: (n: number) => void
  /** 容差: 100-2000 ms, clamp, 写 LS (同时标记「用户填过」→ 填的值直接当判定窗口) */
  setToleranceMsPersistent: (n: number) => void
  setUseCountdown: (b: boolean) => void
  setLatencyAuto: (b: boolean) => void
  setLatencyOffsetMs: (n: number) => void
  setOutputLatencyMs: (n: number) => void
  setMetronome: (b: boolean) => void
  setVolume: (n: number) => void
  setTranspose: (n: number) => void
  setLoopRange: (r: [number, number] | null) => void
  clearLoopRange: () => void
  setCountdown: (n: number | null) => void
  setIsPlaying: (b: boolean) => void
  setCurrentTime: (t: number) => void
  setSpeed: (n: number) => void
  setMidiOutputId: (id: string | null) => void
  setMidiOutputName: (name: string | null) => void
  /** 运行时连接状态 (断连 → false, 连接成功 → true) */
  setMidiOutputConnected: (b: boolean) => void
  setInputSource: (s: 'keyboard' | 'midi') => void
  setMidiInputId: (id: string | null) => void
  setHandPersistent: (h: PracticeHand) => void
  setWaitMsPersistent: (n: number) => void
  setUseCountdownPersistent: (b: boolean) => void
  setMetronomePersistent: (b: boolean) => void
  setVolumePersistent: (n: number) => void
  setTransposePersistent: (n: number) => void
  setLedEnabled: (b: boolean) => void
  setLedBrightness: (n: number) => void
  setLedHost: (s: string) => void
  /** 选设备 (树莓派 / ESP32) —— 会顺手把地址换成那台的默认地址 (见 hostAfterDeviceSwitch). */
  setLedDevice: (d: LedDevice) => void
  /** 当前**真的连上**的是哪台 (连上时才写; 断开时置 null). */
  setLedActiveDevice: (d: LedDevice | null) => void
  setLedError: (s: string | null) => void
  setLedToken: (s: string) => void
  setLedConnected: (b: boolean) => void
  setLedCalibrate: (b: boolean) => void
  setLedFollowPlayback: (b: boolean) => void
  setLedFollowInput: (b: boolean) => void
  /** 左手/右手的灯开关 (首页的两个勾选框). */
  setLedHandLeft: (b: boolean) => void
  setLedHandRight: (b: boolean) => void
  setLedColors: (patch: Partial<LedColors>) => void
  resetLedColors: () => void
  /** 预告行 (上灯带) 的 4 色. 手动改了就变成「自定义」方案. */
  setLedUpcomingColors: (patch: Partial<LedUpcomingColors>) => void
  /** 切配色方案 —— 'c' / 'd' 会把 8 个色一起覆盖; 'auto' 由上层按曲速决定. */
  setLedScheme: (id: LedSchemeId) => void
  /** 把某个方案的 8 个色写进当前配色 (方案 id 原样保留). */
  applyLedSchemeColors: (id: 'c' | 'd') => void
  setLedOffsetUnits: (units: number) => void
  /** 双色带开关 (两条灯带串联 352 颗). */
  setLedDualStrip: (b: boolean) => void
  /** 上灯带亮度比例 (相对主灯带, 0..1). */
  setLedUpperBrightnessRatio: (n: number) => void
  /** 预告行最亮 (第 1 个音) 的相对亮度 0..1. */
  setLedUpperLevelMax: (n: number) => void
  /** 预告行最暗 (第 N 个音) 的相对亮度 0..1. */
  setLedUpperLevelMin: (n: number) => void
  /** 上灯带显示几个音 (每只手各 N 个, 1..6). */
  setLedUpperNoteCount: (n: number) => void
  /** 虚拟键盘音名标号模式 (不标 / 只标C / 全标). */
  setKeyLabels: (m: KeyLabelMode) => void
  /** 点阵屏开关. */
  setLedScreenEnabled: (b: boolean) => void
  /** 点阵屏设备地址. */
  setLedScreenHost: (s: string) => void
  /** 点阵屏渲染哪几块屏 (1..4, 升序). */
  setLedScreenScreens: (v: number[]) => void
  /** 点阵屏帧率. */
  setLedScreenFps: (n: number) => void
  /** 点阵屏亮度 (0..100). */
  setLedScreenBrightness: (n: number) => void
  /** 设置琴键区高度 (行, 0 = 关闭) */
  setLedScreenKeyboardH: (n: number) => void
  /** 设置音符方块大小比例 */
  setLedScreenNoteScale: (n: number) => void
  /** 设置画面左右翻转 (插头在右边时开) */
  setLedScreenFlip: (b: boolean) => void
  /** 改点阵屏配色 (只改传进来的那几个颜色) */
  setLedScreenColors: (c: Partial<LedScreenColors>) => void
  /** 点阵屏连接状态 (运行时, 不持久化). */
  setLedScreenConnected: (b: boolean) => void
  /** 点阵屏错误信息 (运行时, 不持久化). */
  setLedScreenError: (s: string | null) => void
  /** 加一个新最近弹过的 (library kind only). 自动去重 + 移到头部 + cap 5. file kind 忽略. */
  addLastPlayed: (lp: LastPlayed) => void
  /** 清空最近列表 (e.g. 用户主动清除) */
  clearLastPlayed: () => void
  /** 收藏 / 取消收藏 (按 scope+id 去重). 存 LS + 账号那份 prefs. */
  toggleFavorite: (f: Omit<Favourite, 'at'>) => void
  addHit: () => void
  addMiss: () => void
  addPerfect: () => void
  addGood: () => void
  addError: () => void
  bumpStreak: () => void
  resetStreak: () => void
  resetScore: () => void
  setLastWrong: (midi: number | null) => void
  setFrozenWaiting: (b: boolean) => void
}

/** localStorage 持久化 MIDI Out / MIDI In 选择 + hand / volume / transpose / wait
 *  key: 'piayes.prefs.v1'
 *
 *  老版本用的是 'piano-follow.prefs.v1' —— 读的时候两个都试 (新的优先),
 *  写只写新的. 这样改名不会让老用户丢配置.
 */
const LS_KEY = 'piayes.prefs.v1'
const LS_KEY_LEGACY = 'piano-follow.prefs.v1'

export interface PersistedPrefs {
  hand: PracticeHand
  volume: number
  transpose: number
  /** 历史字段: 如果老用户存了显式偏好, 启动时尊重; 新用户没存过 → 默认 ON for practice */
  wait?: boolean
  waitMs?: number
  /** 抢先模式 (灯带显示下一个音 + 允许抢拍). 没存 → 默认关. */
  leadNext?: boolean
  /** 跟弹容差 ms. 没存 → 默认 300. */
  toleranceMs?: number
  /**
   * 用户**自己填过**容差吗 (2026-11-06).
   *
   * false = 没用过 → 判定窗口按乐曲速度自动缩放 (规格 P1-5: 120bpm → 250ms).
   * true  = 填过 → **填的那个数就是判定窗口本身** (想多宽松就多宽松).
   */
  toleranceCustom?: boolean
  /** 输出延迟补偿: 自动检测 / 手动值 (spec P1-3) */
  latencyAuto?: boolean
  latencyOffsetMs?: number
  useCountdown: boolean
  metronome: boolean
  midiOutputName: string | null
  midiInputName: string | null
  ledEnabled?: boolean
  ledBrightness?: number
  ledHost?: string
  /**
   * 灯带设备: 'pi' | 'esp32'. 没存 → 'pi' (树莓派).
   *
   * ★ 2026-11-10: 新字段. 老字段是 ledBackend ('ble' | 'ws' | 'auto') ——
   *   读的时候迁过来 (见下面的 prefsState).
   */
  ledDevice?: LedDevice
  /**
   * 老字段: 灯带后端 'ble' | 'ws' | 'auto' (蓝牙那条路已删).
   * 只用来迁移 —— ledDevice 一旦存在就以它为准 (老 key 留在 LS 里无害).
   */
  ledBackend?: 'ble' | 'ws' | 'auto'
  /** Pi 侪共令牌 (spec P1-10) */
  ledToken?: string
  ledCalibrate?: boolean
  /** 老字段: 老用户存的 3 选 1. 新用户没存 → 用 ledFollowPlayback/ledFollowInput 默认值. */
  ledFollowSource?: 'both' | 'input' | 'playback'
  /** 新字段: 两个独立开关. 老用户迁自 ledFollowSource. */
  ledFollowPlayback?: boolean
  ledFollowInput?: boolean
  /** 左手/右手的灯开关. 没存 → 都开着. */
  ledHandLeft?: boolean
  ledHandRight?: boolean
  /** Playback LED 提前/延迟: 单位 100ms, 范围 -9..+9. */
  ledOffsetUnits?: number
  /** 双色带模式: 没存 → 单灯带. */
  ledDualStrip?: boolean
  /** 上灯带亮度比例 (相对主灯带). 没存 → 0.7. */
  ledUpperBrightnessRatio?: number
  /** 预告行最亮那个音的相对亮度. 没存 → 0.88. */
  ledUpperLevelMax?: number
  /** 预告行最暗那个音的相对亮度. 没存 → 0.46. */
  ledUpperLevelMin?: number
  /** 上灯带显示几个音 (每只手各 N 个). 没存 → 3. */
  ledUpperNoteCount?: number
  /** 虚拟键盘音名标号模式. 没存 → 'all' (全标). */
  keyLabels?: KeyLabelMode
  /** 点阵屏开关. 没存 → 关. */
  ledScreenEnabled?: boolean
  /** 点阵屏设备地址 (树莓派, 端口 8081). 没存 → 树莓派默认地址. */
  ledScreenHost?: string
  /** 点阵屏渲染哪几块屏 (1..4). 没存 → 只渲染 3 号屏. */
  ledScreenScreens?: number[]
  /** 点阵屏帧率. 没存 → 30. */
  ledScreenFps?: number
  /** 点阵屏亮度 (0..100). 没存 → 60. */
  ledScreenBrightness?: number
  /** 点阵屏底部琴键区高度 (行, 0 = 关闭). 没存 → 16. */
  ledScreenKeyboardH?: number
  /** 点阵屏音符方块大小比例 (1 = 当前大小). 没存 → 1. */
  ledScreenNoteScale?: number
  /** 点阵屏画面左右翻转. 没存 → 开 (用户当前的接线是插头在右边). */
  ledScreenFlip?: boolean
  /** 点阵屏配色. 没存 → 默认 (左蓝右红/命中绿/左黑品红/右黑粉). */
  ledScreenColors?: Partial<LedScreenColors>
  /** 4 色 RGB 数组 ([r,g,b] 0..255). 没存就用默认 */
  ledColors?: { leftWhite?: number[]; leftBlack?: number[]; rightWhite?: number[]; rightBlack?: number[] }
  /** 预告行 4 色 RGB 数组. 没存就用默认 (方案 C 的预告行). */
  ledUpcomingColors?: {
    leftWhite?: number[]
    leftBlack?: number[]
    rightWhite?: number[]
    rightBlack?: number[]
  }
  /** 灯带配色方案 id. 没存 → 'c'. */
  ledScheme?: LedSchemeId
  /** 写入这组颜色时的预设配色版本 (见 SCHEME_COLOR_VERSION). */
  ledSchemeVersion?: number
  /** 老字段: 单条 lastPlayed. 启动时迁到 lastPlayedList[0] (新格式数组). */
  lastPlayed?: LastPlayed | null
  /** 新字段: 最多 5 条, 启动时优先用 [0]. */
  lastPlayedList?: LastPlayed[]
  /** 收藏夹 (最多 FAVORITES_MAX 条). 跟账号那份 prefs 一起同步. */
  favorites?: Favourite[]
}

/**
 * 「上次弹的」快照, 用于页面刷新后恢复上下文.
 * - library: 记录 groupId + itemId, 启动时重新 fetch + loadFromLibrary
 * - file:    没法可靠还原文件内容 (浏览器无权限记 File), 只记 name + 大小作展示;
 *            重启后用户得自己再拖一次文件
 */
export type LastPlayed =
  | { kind: 'library'; itemId: string; groupId: string; title: string; composer: string; at: number }
  | { kind: 'file'; name: string; size: number; at: number }

/**
 * 收藏夹里的一条 —— 指向乐库里的一首曲子.
 *
 * 曲名/作曲家是**快照** (收藏那一刻的样子): 乐库里那条被改名或删了,
 * 收藏夹里仍然显示原来的名字, 点开时才去乐库找现在的那条.
 *
 * 存在 prefs 里 (localStorage + 账号那份 user_prefs) —— 所以换台设备登录
 * 同一个账号, 收藏夹跟着走.
 */
export type Favourite = {
  /** 'public' = 公共乐库 (manifest), 'mine' = 当前用户自己的私有谱子 */
  scope: 'public' | 'mine'
  /** 乐库条目 id (公共 = manifest 里的 id; 私有 = `u-<scoreId>`) */
  id: string
  /** 公共乐库的分组 id (私有恒为 'mine') */
  groupId: string
  title: string
  composer: string
  /** 私有谱子的服务端记录 id (公共乐库没有) */
  scoreId?: number
  at: number
}

const LAST_PLAYED_MAX = 5
/** 收藏夹上限 —— 多了没人翻, 也别把 prefs 撑爆. */
const FAVORITES_MAX = 50

/** 收藏夹条目清洗 —— 旧数据/手改的数据别把界面搞崩. */
function sanitizeFavorites(list: unknown): Favourite[] {
  if (!Array.isArray(list)) return []
  const out: Favourite[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const f = raw as Partial<Favourite>
    if (f.scope !== 'public' && f.scope !== 'mine') continue
    if (!f.id || typeof f.id !== 'string') continue
    out.push({
      scope: f.scope,
      id: f.id,
      groupId: typeof f.groupId === 'string' ? f.groupId : f.scope === 'mine' ? 'mine' : '',
      title: typeof f.title === 'string' ? f.title : '',
      composer: typeof f.composer === 'string' ? f.composer : '',
      scoreId: typeof f.scoreId === 'number' ? f.scoreId : undefined,
      at: typeof f.at === 'number' ? f.at : 0,
    })
    if (out.length >= FAVORITES_MAX) break
  }
  return out
}

function loadPrefs(): Partial<PersistedPrefs> {
  for (const key of [LS_KEY, LS_KEY_LEGACY]) {
    try {
      const raw = localStorage.getItem(key)
      if (raw) return JSON.parse(raw) as Partial<PersistedPrefs>
    } catch {
      // 坏 JSON —— 换下一个 key 试
    }
  }
  return {}
}

let _prefsCache: Partial<PersistedPrefs> | null = null
function getPrefs(): Partial<PersistedPrefs> {
  if (!_prefsCache) _prefsCache = loadPrefs()
  return _prefsCache
}

/** 把 prefs 写进 localStorage (本地那份). */
function writePrefs(prefs: Partial<PersistedPrefs>) {
  _prefsCache = prefs
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(prefs))
  } catch {}
}

export function savePrefs(patch: Partial<PersistedPrefs>) {
  writePrefs({ ...getPrefs(), ...patch })
  schedulePushPrefs()
}

// ---- 配置绑定账号 (本地一份 + 账号一份) ----
//
// 前端配置存两处: localStorage (这台机器的那份) + 服务器 user_prefs 表 (账号的那份).
// - 登录了 → 改任何配置都顺手推到服务器 (debounce 一下, 别拖滑块时狂发)
// - 没登录 → 只存本地
// - 登录那一刻 → 把账号那份拉下来跟本地合并 (账号那份优先), 再落回状态
//
// 推/拉失败都不影响本地 —— 网络断了、服务器没起, 配置照样能用.

/** 改完配置到推送之间的间隔 (ms) —— 拖滑块时只推最后那一次. */
const PREFS_PUSH_DELAY_MS = 400

let pushTimer: ReturnType<typeof setTimeout> | null = null

/** 推一份 prefs 到服务器. 失败就算了 —— 本地那份已经存好了. */
async function pushPrefs(prefs: Partial<PersistedPrefs>) {
  try {
    await fetch('/api/prefs', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs }),
    })
  } catch {
    // 网络断了 —— 下次改配置再推
  }
}

/** 改完配置 → 排队推服务器 (没登录就只留本地). */
function schedulePushPrefs() {
  if (!useAuth.getState().user) return
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void pushPrefs(getPrefs())
  }, PREFS_PUSH_DELAY_MS)
}

/**
 * 登录那一刻: 把账号那份配置拉下来.
 *
 * 合并规则: **账号那份优先** (它是「这个账号的配置」), 本地有而账号没有的字段保留.
 * 合并完推回去 —— 账号那份从此就是两边的并集 (第一次登录 = 把本机的配置存上账号).
 */
export async function pullServerPrefs(): Promise<void> {
  if (!useAuth.getState().user) return
  let serverPrefs: Partial<PersistedPrefs> = {}
  try {
    const resp = await fetch('/api/prefs', { credentials: 'same-origin' })
    if (!resp.ok) return
    const data = (await resp.json()) as { prefs?: unknown }
    if (data?.prefs && typeof data.prefs === 'object' && !Array.isArray(data.prefs)) {
      serverPrefs = data.prefs as Partial<PersistedPrefs>
    }
  } catch {
    return
  }
  const merged = { ...getPrefs(), ...serverPrefs }
  writePrefs(merged)
  useStore.setState(prefsState(merged))
  void pushPrefs(merged)
}

// 登录状态一变 (登录成功 / 启动时查到已登录) → 拉一次账号那份配置
useAuth.subscribe((state, prev) => {
  if (state.user && !prev.user) void pullServerPrefs()
})

export function getRememberedMidiOutputName(): string | null {
  return getPrefs().midiOutputName ?? null
}
export function getRememberedMidiInputName(): string | null {
  return getPrefs().midiInputName ?? null
}
export function rememberMidiOutputName(name: string | null) {
  savePrefs({ midiOutputName: name })
}
export function rememberMidiInputName(name: string | null) {
  savePrefs({ midiInputName: name })
}

/**
 * 把两个独立开关折叠成 LedFollower 接受的 followSource.
 * - 两个都开 → 'both'
 * - 只播放 → 'playback'
 * - 只按键 → 'input'
 * - 都关 → 'playback' (follower 会因为 isEnabled()=false 直接 no-op, 这里返回什么都行;
 *   取 playback 是为了「关掉按键跟随」时不至于顺手把播放跟了)
 */
export function effectiveFollowSource(
  playback: boolean,
  input: boolean,
): 'both' | 'input' | 'playback' {
  if (playback && input) return 'both'
  if (input) return 'input'
  return 'playback'
}

/**
 * 实际冻结门控 — Player 用这个决定是否冻结.
 *
 * 简化: 直接跟 wait 字段挂钩. 新老用户行为一致, 没有"自动 ON"魔法.
 * - playback 模式 → 永远 false (钢琴自弹, 不冻结)
 * - practice + wait=true → 冻结
 * - practice + wait=false → 不冻结 (体验练)
 */
export function effectiveWait(
  hand: PracticeHand,
  wait: boolean,
): boolean {
  if (hand === 'playback') return false
  return wait
}

/**
 * 抢先模式实际门控 — Player / 灯带用这个.
 *
 * 抢先 = Wait + 「命中即推进」, 所以**依赖 wait**:
 * - playback 模式 → false
 * - Wait 关着 → false (没有冻结就没有「播放头钉在你要弹的音上」可言)
 * - Wait + 抢先都开 → true
 */
export function effectiveLead(
  hand: PracticeHand,
  wait: boolean,
  lead: boolean,
): boolean {
  if (hand === 'playback') return false
  if (!wait) return false
  return lead
}

/**
 * 配色方案相关的那几个推导值.
 *
 * 拆出来是因为「启动时的迁移」和「服务器那份配置落地」都要用同一套推导.
 */
function schemeFromPrefs(initPrefs: Partial<PersistedPrefs>) {
  // 内置方案的颜色改过版 (SCHEME_COLOR_VERSION) 时, 老用户 localStorage 里
  // 存的还是**旧版**方案色 → 启动时自动换成新配色, 免得「代码改了但看着没变」.
  // 自己手动调过色的 ('custom') 一律不动.
  const scheme: LedSchemeId =
    initPrefs.ledScheme != null
      ? clampSchemeId(initPrefs.ledScheme)
      : initPrefs.ledColors
        ? 'custom'
        : 'c'
  // 'auto' 运行时按曲速挑 C/D, 不读存的颜色 —— 但存的色也要刷成新版,
  // 否则设置里的调色板会显示旧配色.
  const preset =
    scheme === 'd' ? SCHEME_D : scheme === 'c' || scheme === 'auto' ? SCHEME_C : null
  const stale = preset !== null && initPrefs.ledSchemeVersion !== SCHEME_COLOR_VERSION
  return { scheme, preset, stale }
}

/**
 * store 里由 prefs 决定的那部分字段.
 *
 * 单独列出来是为了让 prefsState() 的返回值是「全都有」的类型 ——
 * 少一个字段编译就报错, 不会静默漏掉.
 */
type PrefsState = Pick<
  UIState,
  | 'hand'
  | 'wait'
  | 'waitMs'
  | 'leadNext'
  | 'toleranceMs'
  | 'toleranceCustom'
  | 'useCountdown'
  | 'latencyAuto'
  | 'latencyOffsetMs'
  | 'metronome'
  | 'volume'
  | 'transpose'
  | 'ledEnabled'
  | 'ledBrightness'
  | 'ledHost'
  | 'ledDevice'
  | 'ledToken'
  | 'ledCalibrate'
  | 'ledFollowPlayback'
  | 'ledFollowInput'
  | 'ledHandLeft'
  | 'ledHandRight'
  | 'ledColors'
  | 'ledUpcomingColors'
  | 'ledScheme'
  | 'ledOffsetUnits'
  | 'ledDualStrip'
  | 'ledUpperBrightnessRatio'
  | 'ledUpperLevelMax'
  | 'ledUpperLevelMin'
  | 'ledUpperNoteCount'
  | 'keyLabels'
  | 'ledScreenEnabled'
  | 'ledScreenHost'
  | 'ledScreenScreens'
  | 'ledScreenFps'
  | 'ledScreenBrightness'
  | 'ledScreenKeyboardH'
  | 'ledScreenNoteScale'
  | 'ledScreenFlip'
  | 'ledScreenColors'
  | 'lastPlayedList'
  | 'favorites'
>

/**
 * 老 prefs 的 ledBackend ('ble' | 'ws' | 'auto') → 新的 ledDevice.
 *
 * - 'ble' → 'esp32'  (当年选蓝牙就是想用 ESP32)
 * - 'ws'  → 'pi'     (默认是树莓派)
 * - 'auto' → 'pi'    ('auto' 就是「猜」, 落到树莓派是唯一不会挂死的起点)
 *
 * 例外: 当年走 WiFi 连的其实是 ESP32 —— 那时地址填的是 ESP32 的 IP,
 * 认这个特征迁到 'esp32' (否则迁过去连的是树莓派, 白改一次).
 */
function migrateLedDevice(initPrefs: Partial<PersistedPrefs>): LedDevice {
  if (initPrefs.ledDevice === 'pi' || initPrefs.ledDevice === 'esp32') return initPrefs.ledDevice
  const old = initPrefs.ledBackend
  if (old === 'ble') return 'esp32'
  if (old === 'ws' || old === 'auto') {
    const host = initPrefs.ledHost
    if (host && isDefaultHostOf('esp32', host)) return 'esp32'
    return 'pi'
  }
  return 'pi'
}

/**
 * prefs → store 里那部分**持久化**的状态.
 *
 * 单独拎出来是因为「服务器上那份配置」落地时也得走同一套推导
 * (默认值 / 夹取 / 老字段迁移都在这儿) —— 不能只把值抄过去.
 */
function prefsState(initPrefs: Partial<PersistedPrefs>): PrefsState {
  const { scheme: initScheme, preset: initPreset, stale: presetStale } = schemeFromPrefs(initPrefs)
  return {
  // 默认走 piano playback — 用户主要和电钢交互, 不是练琴
  hand: initPrefs.hand ?? 'playback',
  // wait 默认 ON, 兼容老 LS: 直接用存的偏好 (老用户可能存 false)
  wait: initPrefs.wait ?? true,
  waitMs: initPrefs.waitMs ?? 400,
  // 抢先模式默认关 —— 改变跟弹手感的东西不该偷偷打开
  leadNext: initPrefs.leadNext ?? false,
  // 命中窗口 (ms). 用户没填过 → 按乐曲速度缩放 (src/engine/Scoring.ts timingWindows),
  // 规格 P1-5; 用户填过 → 填的数就是窗口本身 (见 toleranceCustom).
  toleranceMs: initPrefs.toleranceMs ?? 300,
  toleranceCustom: initPrefs.toleranceCustom ?? false,
  useCountdown: initPrefs.useCountdown ?? false,
  // 输出延迟补偿 (spec P1-3) —— 默认关闭 (视觉对齐)
  latencyAuto: initPrefs.latencyAuto ?? false,
  latencyOffsetMs: initPrefs.latencyOffsetMs ?? 0,
  metronome: initPrefs.metronome ?? false,
  volume: initPrefs.volume ?? 0.6,
  transpose: initPrefs.transpose ?? 0,
  ledEnabled: initPrefs.ledEnabled ?? false,
  ledBrightness: initPrefs.ledBrightness ?? 0.5,
  ledHost: initPrefs.ledHost ?? LED_DEVICE_INFO.pi.defaultHost,
  // ★ 2026-11-10 设备选择器: 老 prefs 存的是 ledBackend ('ble' | 'ws' | 'auto').
  //   - 'ble' → 'esp32'   (当年选蓝牙就是想用 ESP32)
  //   - 'ws'  → 'pi'      (默认是树莓派)
  //   - 'auto' → 'pi'     ('auto' 的语义就是「猜」, 落到树莓派是唯一确定、不会挂死的起点)
  //   例外: 当年走 WiFi 连的其实是 ESP32 —— 地址会填成 ESP32 的 IP, 认这个.
  ledDevice: migrateLedDevice(initPrefs),
  ledToken: initPrefs.ledToken ?? '',
  ledCalibrate: initPrefs.ledCalibrate ?? false,
  // 跟随源: 两个独立开关.
  // - 新用户 (LS 里没存): 默认 跟乐谱 ON, 按键 OFF (按用户要求)
  // - 老用户存了 ledFollowSource (旧字段): 迁过来
  // - 老用户存了新字段 (升级到中间状态): 直接用
  ledFollowPlayback:
    initPrefs.ledFollowPlayback ??
    (initPrefs.ledFollowSource === undefined
      ? true
      : initPrefs.ledFollowSource === 'both' || initPrefs.ledFollowSource === 'playback'),
  ledFollowInput:
    initPrefs.ledFollowInput ??
    (initPrefs.ledFollowSource === undefined
      ? false
      : initPrefs.ledFollowSource === 'both' || initPrefs.ledFollowSource === 'input'),
  // 手别灯开关: 默认两只手都亮.
  ledHandLeft: initPrefs.ledHandLeft ?? true,
  ledHandRight: initPrefs.ledHandRight ?? true,
  ledColors: {
    leftWhite: (presetStale ? initPreset!.current.leftWhite : (initPrefs.ledColors?.leftWhite as [number, number, number] | undefined)) ?? SCHEME_C.current.leftWhite,
    leftBlack: (presetStale ? initPreset!.current.leftBlack : (initPrefs.ledColors?.leftBlack as [number, number, number] | undefined)) ?? SCHEME_C.current.leftBlack,
    rightWhite: (presetStale ? initPreset!.current.rightWhite : (initPrefs.ledColors?.rightWhite as [number, number, number] | undefined)) ?? SCHEME_C.current.rightWhite,
    rightBlack: (presetStale ? initPreset!.current.rightBlack : (initPrefs.ledColors?.rightBlack as [number, number, number] | undefined)) ?? SCHEME_C.current.rightBlack,
  },
  ledUpcomingColors: {
    leftWhite: (presetStale ? initPreset!.upcoming.leftWhite : (initPrefs.ledUpcomingColors?.leftWhite as [number, number, number] | undefined)) ?? DEFAULT_UPCOMING_COLORS.leftWhite,
    leftBlack: (presetStale ? initPreset!.upcoming.leftBlack : (initPrefs.ledUpcomingColors?.leftBlack as [number, number, number] | undefined)) ?? DEFAULT_UPCOMING_COLORS.leftBlack,
    rightWhite: (presetStale ? initPreset!.upcoming.rightWhite : (initPrefs.ledUpcomingColors?.rightWhite as [number, number, number] | undefined)) ?? DEFAULT_UPCOMING_COLORS.rightWhite,
    rightBlack: (presetStale ? initPreset!.upcoming.rightBlack : (initPrefs.ledUpcomingColors?.rightBlack as [number, number, number] | undefined)) ?? DEFAULT_UPCOMING_COLORS.rightBlack,
  },
  // 老用户存过颜色但没存方案 → 当「自定义」, 别把他的老配色覆盖掉
  ledScheme: initScheme,
  ledOffsetUnits: initPrefs.ledOffsetUnits ?? 0,
  // 双色带默认关 (大部分用户只有一条带); 上灯带亮度默认是主灯的 70%
  ledDualStrip: initPrefs.ledDualStrip ?? false,
  ledUpperBrightnessRatio: initPrefs.ledUpperBrightnessRatio ?? 0.7,
  ledUpperLevelMax: clampLevel(
    initPrefs.ledUpperLevelMax ?? DEFAULT_UPPER_LEVEL_MAX,
    DEFAULT_UPPER_LEVEL_MAX,
  ),
  ledUpperLevelMin: clampLevel(
    initPrefs.ledUpperLevelMin ?? DEFAULT_UPPER_LEVEL_MIN,
    DEFAULT_UPPER_LEVEL_MIN,
  ),
  // 上灯带显示几个音 (每只手各 N 个) —— 默认 3
  ledUpperNoteCount: clampUpperNoteCount(initPrefs.ledUpperNoteCount ?? 3),
  // 键盘音名标号: 默认全标 (用户不认识键名)
  keyLabels: initPrefs.keyLabels ?? 'all',
  // 点阵屏: 默认开. 默认只渲染 3 号屏 (用户当前只买到一块屏, 摆在 3 号位).
  ledScreenEnabled: initPrefs.ledScreenEnabled ?? true,
  ledScreenHost: initPrefs.ledScreenHost ?? LED_DEVICE_INFO.pi.defaultHost,
  ledScreenScreens: sanitizeScreenList(initPrefs.ledScreenScreens ?? [3]),
  ledScreenFps: clampScreenFps(initPrefs.ledScreenFps ?? 30),
  // 亮度默认 60 —— 实测 100% + 大面积白色会把 Pi 的 5V 拖塌 (欠压 -> 随机像素).
  ledScreenBrightness: clampScreenBrightness(initPrefs.ledScreenBrightness ?? 60),
  ledScreenKeyboardH: clampKeyboardH(initPrefs.ledScreenKeyboardH ?? KEYBOARD_H),
  ledScreenNoteScale: clampNoteScale(initPrefs.ledScreenNoteScale ?? 1),
  // 默认翻转 —— 用户现在的接线是插头在右边 (链从右往左串).
  ledScreenFlip: initPrefs.ledScreenFlip ?? true,
  // 配色默认: 左蓝右红 / 弹对变绿 / 左黑键品红 / 右黑键粉色.
  ledScreenColors: sanitizeScreenColors(initPrefs.ledScreenColors ?? DEFAULT_SCREEN_COLORS),
  // 启动时迁移: 新字段 lastPlayedList 优先, 没有则从老 lastPlayed 单条迁过来 (变 [0]).
  // file kind 不入列表, 直接过滤掉
  lastPlayedList: (initPrefs.lastPlayedList ?? (
    initPrefs.lastPlayed && initPrefs.lastPlayed.kind === 'library'
      ? [initPrefs.lastPlayed]
      : []
  )).filter((lp) => lp.kind === 'library').slice(0, LAST_PLAYED_MAX),
  // 收藏夹: 存了就有, 没存 = 空
  favorites: sanitizeFavorites(initPrefs.favorites),
  }
}

export const useStore = create<UIState>((set, get) => {
  const initPrefs = getPrefs()

  // ── 预设配色升级 ──────────────────────────────────────────────────────
  // 老用户 localStorage 里存的还是**旧版**方案色 → 启动时自动换成新配色.
  const { preset: initPreset, stale: presetStale } = schemeFromPrefs(initPrefs)
  if (initPreset && presetStale) {
    savePrefs({
      ledSchemeVersion: SCHEME_COLOR_VERSION,
      ledColors: {
        leftWhite: Array.from(initPreset.current.leftWhite),
        leftBlack: Array.from(initPreset.current.leftBlack),
        rightWhite: Array.from(initPreset.current.rightWhite),
        rightBlack: Array.from(initPreset.current.rightBlack),
      },
      ledUpcomingColors: {
        leftWhite: Array.from(initPreset.upcoming.leftWhite),
        leftBlack: Array.from(initPreset.upcoming.leftBlack),
        rightWhite: Array.from(initPreset.upcoming.rightWhite),
        rightBlack: Array.from(initPreset.upcoming.rightBlack),
      },
    })
  }

  return {
  ...prefsState(initPrefs),
  song: null,
  // 点阵屏的运行时状态 (不持久化)
  ledScreenConnected: false,
  ledScreenError: null,
  librarySource: null,
  libraryVersion: 0,
  libraryFocusId: null,
  handInferMode: 'auto',
  handInferVersion: 0,
  outputLatencyMs: 0,
  loopRange: null,
  countdown: null,
  isPlaying: false,
  currentTime: 0,
  speed: 1.0,
  midiOutputId: null,
  midiOutputName: null,
  midiOutputConnected: false,
  inputSource: 'keyboard',
  midiInputId: null,
  hits: 0,
  misses: 0,
  perfects: 0,
  goods: 0,
  errors: 0,
  streak: 0,
  maxStreak: 0,
  lastWrongMidi: null,
  lastWrongAt: 0,
  frozenWaiting: false,
  ledActiveDevice: null,
  ledError: null,
  ledConnected: false,

  setSong: (s) =>

    set({
      song: s,
      currentTime: 0,
      isPlaying: false,
      hits: 0,
      misses: 0,
      perfects: 0,
      goods: 0,
      errors: 0,
      streak: 0,
      maxStreak: 0,
    }),

  // 出处单独记 —— setSong 在很多地方被调 (换手别、重载曲目…),
  // 只有「从乐库/文件加载」那几处才该改它.
  setLibrarySource: (s) => set({ librarySource: s }),
  // 乐库变了 → 面板重新拉列表 (focusId = 刚存的那条, 面板会展开它所在的分组)
  bumpLibrary: (focusId) =>
    set((st) => ({ libraryVersion: st.libraryVersion + 1, libraryFocusId: focusId ?? null })),
  /**
   * 改手别判定方式 (spec P2-6).
   *
   * 启发式 (声部聚类) 猜错时, 用户可以改成"按音高切分" —— 这是最直接的纠正入口.
   * note.hand 是**就地**改的: Player 持有同一个 song 引用, 改了立刻生效,
   * 不用重建 player (重建会打断正在播的曲子). UI 靠 handInferVersion 重算.
   */
  setHandInferMode: (m) => {
    const s = get().song
    if (!s) {
      set({ handInferMode: m })
      return
    }
    // 显式/随文件带的手别 (MusicXML / 已解析的 hand 字段) 不该被覆盖
    const method = s.handInfer?.method
    const heuristic =
      method === undefined ||
      method === 'voice-clusters' ||
      method === 'multi-tracks' ||
      method === 'two-tracks' ||
      method === 'pitch-split'
    if (heuristic) {
      for (const n of s.notes) n.hand = undefined
    }
    const res = inferHands(s.notes, null, s.bpms, s.timeSignature, {
      mode: m,
      pitchSplit: s.pitchSplit ?? 60,
    })
    s.hands = res.hands
    if (res.pitchSplit !== undefined) s.pitchSplit = res.pitchSplit
    s.handInfer = { method: res.method, confidence: res.confidence }
    set({ handInferMode: m, handInferVersion: get().handInferVersion + 1 })
  },
  // 练习模式也要持久化 (spec P2-1) —— 以前只有 setHandPersistent 写 LS,
  // 而快捷键 m 和 HandSelector 用的是 setHand → 刷新后回到 playback.
  setHand: (h) => {
    savePrefs({ hand: h })
    set({ hand: h })
  },
  setWait: (b) => set({ wait: b }),
  /** UI 切 toggle 时调用 (兼容老 LS 字段 waitUserOverride) */
  setWaitUserOverride: (b) => {
    savePrefs({ wait: b })
    set({ wait: b })
  },
  /** 抢先模式开关 (UI 切 toggle 时调用) */
  setLeadUserOverride: (b) => {
    savePrefs({ leadNext: b })
    set({ leadNext: b })
  },
  setWaitMs: (n) => set({ waitMs: n }),
  setToleranceMsPersistent: (n) => {
    const v = Math.max(100, Math.min(2000, Math.round(n)))
    savePrefs({ toleranceMs: v, toleranceCustom: true })
    set({ toleranceMs: v, toleranceCustom: true })
  },
  setUseCountdown: (b) => set({ useCountdown: b }),
  setLatencyAuto: (b) => {
    savePrefs({ latencyAuto: b })
    set({ latencyAuto: b })
  },
  setLatencyOffsetMs: (n) => {
    const v = Math.max(0, Math.min(1000, Math.round(n)))
    savePrefs({ latencyOffsetMs: v })
    set({ latencyOffsetMs: v })
  },
  // 每帧都会喂一次 —— 值没变就什么都不做, 免得白白触发重渲染
  setOutputLatencyMs: (n) => {
    if (get().outputLatencyMs === n) return
    set({ outputLatencyMs: n })
  },
  setMetronome: (b) => set({ metronome: b }),
  setVolume: (n) => set({ volume: Math.max(0, Math.min(1, n)) }),
  setTranspose: (n) => set({ transpose: Math.max(-12, Math.min(12, n)) }),
  setLoopRange: (r) => set({ loopRange: r }),
  clearLoopRange: () => set({ loopRange: null }),
  setCountdown: (n) => set({ countdown: n }),
  setIsPlaying: (b) => set({ isPlaying: b }),
  setCurrentTime: (t) => set({ currentTime: t }),
  setSpeed: (n) => set({ speed: n }),
  setMidiOutputId: (id) => set({ midiOutputId: id }),
  setMidiOutputName: (name) => set({ midiOutputName: name }),
  setMidiOutputConnected: (b) => set({ midiOutputConnected: b }),
  setInputSource: (s) => set({ inputSource: s }),
  setMidiInputId: (id) => set({ midiInputId: id }),
  setLedEnabled: (b) => { savePrefs({ ledEnabled: b }); set({ ledEnabled: b }) },
  setLedBrightness: (n) => {
    const v = Math.max(0, Math.min(1, n))
    savePrefs({ ledBrightness: v })
    set({ ledBrightness: v })
  },
  setLedHost: (s) => { savePrefs({ ledHost: s }); set({ ledHost: s }) },
  /**
   * 切设备 —— 顺便把地址带到新设备的默认地址 (只在当前地址正好是**旧设备**的
   * 默认地址时换; 用户自己改过的地址不动).
   */
  setLedDevice: (d: LedDevice) => {
    const from = get().ledDevice
    const host = hostAfterDeviceSwitch(get().ledHost, from, d)
    savePrefs({ ledDevice: d, ledHost: host })
    set({ ledDevice: d, ledHost: host })
  },
  setLedActiveDevice: (d: LedDevice | null) => set({ ledActiveDevice: d }),
  setLedError: (s) => set({ ledError: s }),
  setLedToken: (s) => { savePrefs({ ledToken: s }); set({ ledToken: s }) },
  setLedConnected: (b) => set({ ledConnected: b }),
  setLedCalibrate: (b) => { savePrefs({ ledCalibrate: b }); set({ ledCalibrate: b }) },
  setLedFollowPlayback: (b) => { savePrefs({ ledFollowPlayback: b }); set({ ledFollowPlayback: b }) },
  setLedFollowInput: (b) => { savePrefs({ ledFollowInput: b }); set({ ledFollowInput: b }) },
  setLedHandLeft: (b) => { savePrefs({ ledHandLeft: b }); set({ ledHandLeft: b }) },
  setLedHandRight: (b) => { savePrefs({ ledHandRight: b }); set({ ledHandRight: b }) },
  setLedColors: (patch) => {
    set((s) => {
      const next = { ...s.ledColors, ...patch }
      savePrefs({ ledColors: {
        leftWhite: Array.from(next.leftWhite),
        leftBlack: Array.from(next.leftBlack),
        rightWhite: Array.from(next.rightWhite),
        rightBlack: Array.from(next.rightBlack),
      }, ledScheme: 'custom' })
      // 手动调过色 → 不再被方案覆盖
      return { ledColors: next, ledScheme: 'custom' }
    })
  },
  resetLedColors: () => {
    savePrefs({ ledColors: {}, ledUpcomingColors: {}, ledSchemeVersion: SCHEME_COLOR_VERSION })
    set({
      ledColors: { ...SCHEME_C.current },
      ledUpcomingColors: { ...SCHEME_C.upcoming },
      ledScheme: 'c',
    })
  },
  setLedUpcomingColors: (patch) => {
    set((s) => {
      const next = { ...s.ledUpcomingColors, ...patch }
      savePrefs({ ledUpcomingColors: {
        leftWhite: Array.from(next.leftWhite),
        leftBlack: Array.from(next.leftBlack),
        rightWhite: Array.from(next.rightWhite),
        rightBlack: Array.from(next.rightBlack),
      }, ledScheme: 'custom' })
      return { ledUpcomingColors: next, ledScheme: 'custom' }
    })
  },
  setLedScheme: (id) => {
    const v = clampSchemeId(id)
    savePrefs({ ledScheme: v })
    if (v === 'c' || v === 'd') {
      // 选方案 = 把 8 个色一起换掉
      get().applyLedSchemeColors(v)
    }
    // ★ 一定要同时更新 id —— 否则选择器不会高亮 (颜色变了但方案还是老的)
    set({ ledScheme: v })
  },
  applyLedSchemeColors: (id) => {
    const scheme = id === 'd' ? SCHEME_D : SCHEME_C
    savePrefs({
      // 记下这组色是哪个版本的预设 —— 下次预设改版好自动升级
      ledSchemeVersion: SCHEME_COLOR_VERSION,
      ledColors: {
        leftWhite: Array.from(scheme.current.leftWhite),
        leftBlack: Array.from(scheme.current.leftBlack),
        rightWhite: Array.from(scheme.current.rightWhite),
        rightBlack: Array.from(scheme.current.rightBlack),
      },
      ledUpcomingColors: {
        leftWhite: Array.from(scheme.upcoming.leftWhite),
        leftBlack: Array.from(scheme.upcoming.leftBlack),
        rightWhite: Array.from(scheme.upcoming.rightWhite),
        rightBlack: Array.from(scheme.upcoming.rightBlack),
      },
    })
    set({
      ledColors: { ...scheme.current },
      ledUpcomingColors: { ...scheme.upcoming },
    })
  },
  setLedOffsetUnits: (units) => {
    const v = Math.max(-9, Math.min(9, units | 0))
    savePrefs({ ledOffsetUnits: v })
    set({ ledOffsetUnits: v })
  },
  setLedDualStrip: (b) => {
    savePrefs({ ledDualStrip: b })
    set({ ledDualStrip: b })
  },
  setLedUpperBrightnessRatio: (n) => {
    const v = Math.max(0, Math.min(1, n))
    savePrefs({ ledUpperBrightnessRatio: v })
    set({ ledUpperBrightnessRatio: v })
  },
  setLedUpperLevelMax: (n) => {
    const v = clampLevel(n, DEFAULT_UPPER_LEVEL_MAX)
    savePrefs({ ledUpperLevelMax: v })
    set({ ledUpperLevelMax: v })
  },
  setLedUpperLevelMin: (n) => {
    const v = clampLevel(n, DEFAULT_UPPER_LEVEL_MIN)
    savePrefs({ ledUpperLevelMin: v })
    set({ ledUpperLevelMin: v })
  },
  setLedUpperNoteCount: (n) => {
    const v = clampUpperNoteCount(n)
    savePrefs({ ledUpperNoteCount: v })
    set({ ledUpperNoteCount: v })
  },
  setKeyLabels: (m) => {
    savePrefs({ keyLabels: m })
    set({ keyLabels: m })
  },
  setLedScreenEnabled: (b) => { savePrefs({ ledScreenEnabled: b }); set({ ledScreenEnabled: b }) },
  setLedScreenHost: (s) => { savePrefs({ ledScreenHost: s }); set({ ledScreenHost: s }) },
  setLedScreenScreens: (v) => {
    const list = sanitizeScreenList(v)
    savePrefs({ ledScreenScreens: list })
    set({ ledScreenScreens: list })
  },
  setLedScreenFps: (n) => {
    const v = clampScreenFps(n)
    savePrefs({ ledScreenFps: v })
    set({ ledScreenFps: v })
  },
  setLedScreenBrightness: (n) => {
    const v = clampScreenBrightness(n)
    savePrefs({ ledScreenBrightness: v })
    set({ ledScreenBrightness: v })
  },
  setLedScreenKeyboardH: (n) => {
    const v = clampKeyboardH(n)
    savePrefs({ ledScreenKeyboardH: v })
    set({ ledScreenKeyboardH: v })
  },
  setLedScreenNoteScale: (n) => {
    const v = clampNoteScale(n)
    savePrefs({ ledScreenNoteScale: v })
    set({ ledScreenNoteScale: v })
  },
  setLedScreenFlip: (b) => { savePrefs({ ledScreenFlip: b }); set({ ledScreenFlip: b }) },
  setLedScreenColors: (c) => {
    const next = sanitizeScreenColors({ ...get().ledScreenColors, ...c })
    savePrefs({ ledScreenColors: next })
    set({ ledScreenColors: next })
  },
  setLedScreenConnected: (b) => set({ ledScreenConnected: b }),
  setLedScreenError: (s) => set({ ledScreenError: s }),
  addLastPlayed: (lp) => {
    if (lp.kind !== 'library') return // file kind 不入最近
    set((s) => {
      // 去重 (按 itemId+groupId): 已在列表里的先删, 再 unshift 到头部
      const filtered = s.lastPlayedList.filter(
        (x) => !(x.kind === 'library' && x.itemId === lp.itemId && x.groupId === lp.groupId),
      )
      const next = [lp, ...filtered].slice(0, LAST_PLAYED_MAX)
      savePrefs({ lastPlayedList: next, lastPlayed: lp }) // 同时写老字段 (老代码兼容)
      return { lastPlayedList: next }
    })
  },
  clearLastPlayed: () => {
    savePrefs({ lastPlayedList: [], lastPlayed: null })
    set({ lastPlayedList: [] })
  },
  toggleFavorite: (f) => {
    const cur = get().favorites
    const exists = cur.some((x) => x.scope === f.scope && x.id === f.id)
    // 取消收藏 = 去掉; 收藏 = 插到最前 (新收藏的排上面)
    const next = exists
      ? cur.filter((x) => !(x.scope === f.scope && x.id === f.id))
      : [{ ...f, at: Date.now() }, ...cur].slice(0, FAVORITES_MAX)
    savePrefs({ favorites: next })
    set({ favorites: next })
  },
  addHit: () => set((s) => ({ hits: s.hits + 1 })),
  addMiss: () => set((s) => ({ misses: s.misses + 1 })),
  addPerfect: () => set((s) => ({ perfects: s.perfects + 1 })),
  addGood: () => set((s) => ({ goods: s.goods + 1 })),
  addError: () => set((s) => ({ errors: s.errors + 1 })),
  bumpStreak: () =>
    set((s) => ({
      streak: s.streak + 1,
      maxStreak: Math.max(s.maxStreak, s.streak + 1),
    })),
  resetStreak: () => set({ streak: 0 }),
  resetScore: () =>
    set({
      hits: 0,
      misses: 0,
      perfects: 0,
      goods: 0,
      errors: 0,
      streak: 0,
      maxStreak: 0,
      lastWrongMidi: null,
      lastWrongAt: 0,
    }),
  setLastWrong: (midi) =>
    set({ lastWrongMidi: midi, lastWrongAt: midi === null ? 0 : performance.now() }),
  setFrozenWaiting: (b) => set({ frozenWaiting: b }),

  // 持久化 setter 包装 — 同步写 LS
  setHandPersistent: (h) => { savePrefs({ hand: h }); set({ hand: h }) },
  setWaitMsPersistent: (n) => { savePrefs({ waitMs: n }); set({ waitMs: n }) },
  setUseCountdownPersistent: (b) => { savePrefs({ useCountdown: b }); set({ useCountdown: b }) },
  setMetronomePersistent: (b) => { savePrefs({ metronome: b }); set({ metronome: b }) },
  setVolumePersistent: (n) => { savePrefs({ volume: n }); set({ volume: n }) },
  setTransposePersistent: (n) => { savePrefs({ transpose: n }); set({ transpose: n }) },
  }
})

/**
 * 给定 (note, practiceHand) 判定它是否"用户要弹的"
 * - playback: 都不算 (钢琴全弹)
 * - both: 全是
 * - left/right: 只算匹配手
 *
 * 手别判不出来 (单轨 + 没标 hand) 时, **两边都算 active** ——
 * 否则该 note 在任何单手模式下都不可达 (键盘导航会跳过它, 跟弹也不会要求它).
 */
export function isActiveHand(
  noteHand: Hand | undefined,
  noteTrack: number,
  songHands: { left: number; right: number },
  practiceHand: PracticeHand,
): boolean {
  if (practiceHand === 'playback') return false
  if (practiceHand === 'both') return true
  const h = resolveHand(noteHand, noteTrack, songHands)
  if (h === undefined) return true
  return h === practiceHand
}

/**
 * 给定 (note, practiceHand) 判定它是否要发给电钢走 MIDI Out
 * - playback: 全发
 * - both: 不发 (用户自己弹)
 * - left: 右手的音发 (左手用户弹)
 * - right: 左手发
 */
export function goesToMidiOut(
  noteHand: Hand | undefined,
  noteTrack: number,
  songHands: { left: number; right: number },
  practiceHand: PracticeHand,
): boolean {
  if (practiceHand === 'playback') return true
  if (practiceHand === 'both') return false
  const h = resolveHand(noteHand, noteTrack, songHands)
  if (h === undefined) return false
  return h !== practiceHand
}
