// 主 App: 组合所有 UI + 引擎
//
// 设计:
// - 默认 "钢琴播放" mode: MIDI Out 主输出, 本地合成仅兜底
// - 自动加载乐库第一首
// - HandSelector / Wait / Countdown / Speed 紧凑在一行 (40px)
// - 音量不在这一行里 —— 收成右下角一个可展开的竖向面板 (2026-11-06 用户要求)
// - 主区: 全屏的 FallingNotes (五线谱已隐藏, 觉得不好用)
// - 全屏键: 隐藏 TopBar / 侧栏 / 底部 chrome, 只留 FallingNotes
// - MIDI 弹窗: 一键连接输入 + 输出 (自动挑电钢, 跳过 PC 合成器)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, noteHand, effectiveFollowSource, effectiveLead } from './store'
import { InputBus } from './input/InputBus'
import { KeyboardInput } from './input/KeyboardInput'
import { MidiInput } from './input/MidiInput'
import { Synthesizer } from './engine/Synthesizer'
import { Accompaniment } from './engine/Accompaniment'
import { Metronome } from './engine/Metronome'
import { Countdown } from './engine/Countdown'
import { Player } from './engine/Player'
import { FallingNotes, type PlayerRef } from './render/FallingNotes'
import { renderTime } from './render/timeSource'
import { TopBar } from './ui/TopBar'
import { Library } from './ui/Library'
import { FilePicker } from './ui/FilePicker'
import { Transport } from './ui/Transport'
import { StatusBar } from './ui/StatusBar'
import { SettingsDrawer } from './ui/SettingsDrawer'
import { StatsPopup } from './ui/StatsPopup'
import { MidiModal } from './ui/MidiModal'
import { CountdownOverlay } from './ui/CountdownOverlay'
import { HandSelector } from './ui/HandSelector'
import { LedHandToggles } from './ui/LedHandToggles'
import { WaitToggle } from './ui/WaitToggle'
import { LeadToggle } from './ui/LeadToggle'
import { ToleranceInput } from './ui/ToleranceInput'
import { CountdownToggle } from './ui/CountdownToggle'
import { VolumePanel } from './ui/VolumePanel'
import { SpeedControl } from './ui/SpeedControl'
import { LedDock } from './ui/LedDock'
import { LedScreenDock } from './ui/LedScreenDock'
import { AuthModal } from './ui/AuthModal'
import { Favourites } from './ui/Favourites'
import { NoteInspector } from './ui/NoteInspector'
import { ScoreEditor } from './ui/ScoreEditor'
import {
  IconAlert,
  IconClose,
  IconCollapse,
  IconFolder,
  IconLoader,
  IconMusic,
  IconPlay,
  IconUser,
} from './ui/icons'
import { useAuth, setAuthModalOpener, openAuthModal } from './auth'
import { loadManifest, loadLibrarySong, loadMyScores, findLibraryItemById } from './library'
import { parseShareLink } from './share'
import { autoConnectMidi } from './midi/autoConnect'
import { findAdjacentMeasureTime, findAdjacentNoteTime, notesAt, findAdjacentActiveNoteTime } from './util/navigation'
import { setupWakeLock } from './util/wakeLock'
import { LedController, type LedHint } from './led/LedController'
import { LedFollower } from './led/LedFollower'
import { NextNoteIndex } from './led/dualStrip'
import {
  autoScheme,
  getScheme,
  ledLevelLadder,
  type LedPalette,
} from './led/schemes'
import { WsTransport } from './led/transport/WsTransport'
import {
  LED_COUNT,
  LED_DEVICE_INFO,
  buildLedWsUrl,
  ledProxyPath,
  resolveLedToken,
} from './led/transport/ledConfig'
import { LedScanCursor, quantizeLevel, isRewind } from './led/scanCursor'
import { ScreenController, buildScreenWsUrl, SCREEN_PROXY_PATH } from './led/screen/ScreenController'
import { diffLeadHints, type LeadHint } from './led/leadStrip'
import {
  setLedBus,
  emitLedNoteOn,
  emitLedNoteOff,
  emitLedHit,
  emitLedPlaybackRaw,
  emitLedLead,
  registerTestPattern,
} from './led/emit'
import { midiToName } from './render/colors'
import type { Song, SongNote, NoteHit } from './types'

type Tab = 'library' | 'mine' | 'files'

/**
 * 曲子是不是已经放完了 (当前时间走到了最后一个音的末尾之后).
 *
 * 用途: 曲终时灯带该是空的 —— 暂停时的「当前键位预览」不能把最后一组音点亮.
 *
 * 为什么不用 song.duration: 它取的是 notes 数组**最后一个**元素的时间+时值,
 * 而数组顺序不一定严格按时间排. 这里取所有音里最晚结束的那个.
 */
function songEnded(song: Song | null, t: number): boolean {
  if (!song || song.notes.length === 0) return false
  let end = 0
  for (const n of song.notes) {
    const e = n.time + n.duration
    if (e > end) end = e
  }
  // 留 50ms 余量 —— Player 停下来的那一刻 currentTime 可能还差一点点
  return t >= end - 0.05
}

/**
 * 按「最近弹过」的记录找回曲目.
 * groupId === 'mine' → 当前用户的私有谱子 (走 API); 否则走公共 manifest.
 */
async function findLibraryItem(last: { itemId: string; groupId: string }) {
  if (last.groupId === 'mine') {
    const items = await loadMyScores()
    return items.find((it) => it.id === last.itemId)
  }
  const m = await loadManifest()
  const group = m.groups.find((g) => g.id === last.groupId)
  return group?.items.find((it) => it.id === last.itemId)
}

export default function App() {
  const song = useStore((s) => s.song)
  const handInferVersion = useStore((s) => s.handInferVersion)
  const isPlaying = useStore((s) => s.isPlaying)
  const setIsPlaying = useStore((s) => s.setIsPlaying)
  const volume = useStore((s) => s.volume)
  const transpose = useStore((s) => s.transpose)
  const currentTime = useStore((s) => s.currentTime)
  const hand = useStore((s) => s.hand)
  const setHand = useStore((s) => s.setHand)
  const wait = useStore((s) => s.wait)
  const leadNext = useStore((s) => s.leadNext)
  // 抢先模式 = Wait + 「命中即推进」 (依赖 Wait —— Wait 关掉就失效)
  const leadMode = effectiveLead(hand, wait, leadNext)

  // 单例
  const bus = useMemo(() => new InputBus(), [])
  const synth = useMemo(() => new Synthesizer(), [])
  const acc = useMemo(() => new Accompaniment(), [])
  const midiInput = useMemo(() => new MidiInput(), [])
  const kbInput = useMemo(() => new KeyboardInput(), [])
  const metronome = useMemo(() => new Metronome(synth.getCtx()), [synth])
  const countdown = useMemo(() => new Countdown(), [])

  // 注册 bus 给模块级 LED emit (防 HMR 闭包陷阱)
  useEffect(() => {
    setLedBus(bus)
    return () => setLedBus(null)
  }, [bus])

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [midiOpen, setMidiOpen] = useState(false)
  // 启动后弹一下 MIDI 弹窗 (强提示用户接电钢)
  const [midiHintShown, setMidiHintShown] = useState(false)
  // 乐库 / 文件浏览器 — 悬浮弹窗 (覆盖键盘), 选定后自动关闭
  const [libraryOpen, setLibraryOpen] = useState(false)
  // 登录 / 注册 弹窗
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  // 右键检视到的音符 (显示唯一编码, 点一下复制)
  const [noteHit, setNoteHit] = useState<{ hit: NoteHit; pos: { x: number; y: number } } | null>(null)
  // 谱子编辑器 —— 打开状态 + 要定位到的音符下标 (从下落色块右键跳过来)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorFocus, setEditorFocus] = useState<number | null>(null)
  /**
   * 编辑器开着没 —— applyPreview (暂停时的「当前键位」预览) 要读它.
   * 用 ref 是因为 applyPreview 是 useCallback, 不想因为 editorOpen 变就重建它.
   */
  const editorOpenRef = useRef(editorOpen)
  editorOpenRef.current = editorOpen

  /**
   * 打开谱子编辑器.
   *
 * @param focusIndex 要定位的音符下标 (= 唯一编码). 不传就是从头看.
   *
 * 打开时先把练习暂停 —— 编辑器自己会播, 两边同时发声没法听.
   */
  const openEditor = useCallback((focusIndex?: number | null) => {
    setEditorFocus(focusIndex ?? null)
    setEditorOpen(true)
    setNoteHit(null)
    if (useStore.getState().isPlaying) {
      useStore.getState().setIsPlaying(false)
    }
    playerRef.current?.pause()
  }, [])

  /**
   * 编辑器把改好的音符写回当前曲目.
   *
 * 音符按时间排序后写回 —— Player 的 Scheduler 假设 song.notes 按时间升序.
   * 顺带把 duration 更新成最后一个音的结束时间.
   */
  const applyEditedNotes = useCallback((notes: SongNote[]) => {
    const cur = useStore.getState().song
    if (!cur) return
    let end = 0
    for (const n of notes) end = Math.max(end, n.time + n.duration)
    useStore.getState().setSong({ ...cur, notes, duration: Math.max(end, 0.1) })
  }, [])

  // 登录弹窗只挂一份, 但顶栏 / 乐库 / 文件页好几处都要能弹它 ——
  // 用模块级 opener (跟 led bus 一个套路), 免得层层传 props
  useEffect(() => {
    setAuthModalOpener((mode) => {
      setAuthMode(mode ?? 'login')
      setAuthOpen(true)
    })
    // 启动时查一次登录态 (cookie 里的 session)
    useAuth.getState().check()
    return () => setAuthModalOpener(null)
  }, [])

  // Bug #11/19 fix: global Esc handler that closes only the TOPMOST overlay.
  // Without this, simultaneous LibraryOverlay + SettingsDrawer would both close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // When focus is in an input/select/textarea (e.g. user is typing in the
      // LibraryOverlay search box), the first Esc should clear/leave the field,
      // not blow away the whole panel. Only close overlay when focus is elsewhere.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if ((e.target as HTMLElement | null)?.isContentEditable) return
      // AuthModal (z-50) > LibraryOverlay (z-40) > SettingsDrawer/StatsPopup/MidiModal (z-40).
      // Close highest-priority open overlay.
      if (authOpen) { setAuthOpen(false); e.preventDefault(); return }
      if (editorOpen) { setEditorOpen(false); e.preventDefault(); return }
      if (libraryOpen) { setLibraryOpen(false); e.preventDefault(); return }
      if (settingsOpen) { setSettingsOpen(false); e.preventDefault(); return }
      if (statsOpen) { setStatsOpen(false); e.preventDefault(); return }
      if (midiOpen) { setMidiOpen(false); e.preventDefault(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [libraryOpen, settingsOpen, statsOpen, midiOpen, authOpen, editorOpen])

  const [libraryTab, setLibraryTab] = useState<Tab>('library')
  // 全屏状态
  const [isFs, setIsFs] = useState(false)

  const playerRef = useRef<Player | null>(null)
  const playerApiRef = useRef<PlayerRef | null>(null)
  // autoplay 请求 (ref 而非 state, 避开 StrictMode 二次 invoke 把 state 清掉的问题)
  const pendingAutoplayRef = useRef(false)
  const requestAutoplay = useCallback(() => {
    pendingAutoplayRef.current = true
  }, [])

  // 订阅 fullscreen
  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // song 清空时不再自动弹乐库 — 用户自己来开 (避免每次都被弹窗打断)
  // useEffect(() => {
  //   if (!song) setLibraryOpen(true)
  // }, [song])

  // dev-only: 暴露 store 到 window, 方便 puppeteer / devtools 看实时状态
  useEffect(() => {
    // ★ 2026-11-01 修 (审核报告 §3.2 P1-8): 生产环境别把整个 store 挂到 window 上.
    if (!import.meta.env.DEV) return
    ;(window as any).__store = useStore
  }, [])

  // 自动加载: 优先用 lastPlayedList[0] (静默, 不弹任何弹窗).
  // ★ 2026-11-13: 不再 fallback 到「乐库第一首」(那是肖邦圆舞曲) ——
  //   用户要求「chopin 不要默认打开」. 没有上次记录就空着, 用户自己开乐库.
  // (可用 ?autoload=0 关闭)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('autoload') === '0') return
    const last = useStore.getState().lastPlayedList[0]
    if (last && last.kind === 'library') {
      // 静默恢复上次弹的 — 不弹库
      findLibraryItem(last)
        .then(async (item) => {
          if (!item) throw new Error('lastPlayed 找不到 item')
          // ★ 走 loadLibrarySong: 顺手记下出处 —— 否则编辑器里「存公共」
          //   不知道该覆盖哪一条, 会多存一份 (用户 2026-11-04 报的).
          await loadLibrarySong(item, last.groupId)
        })
        .catch((e) => console.warn('恢复 lastPlayed 失败:', e))
    }
  }, [])

  // ---- 分享链接 (?song=<id>&scope=public|mine) ----
  //
  // 点别人给的链接 → 直接打开那首曲子.
  // 私有谱子 (scope=mine) 要登录 —— 没登录先弹登录框, 登录完接着打开.
  const authChecked = useAuth((s) => s.checked)
  const authUser = useAuth((s) => s.user)
  const shareLinkRef = useRef(parseShareLink())
  /** 已经发起过加载 (成功或失败) —— 别再试第二次 */
  const shareLoadedRef = useRef(false)
  /** 已经弹过一次登录框 —— 别反复弹 */
  const shareLoginAskedRef = useRef(false)
  const [shareError, setShareError] = useState<string | null>(null)

  useEffect(() => {
    const link = shareLinkRef.current
    if (!link || shareLoadedRef.current) return
    // 等登录态查完 —— 私有谱子没登录就打不开
    if (!authChecked) return
    if (link.scope === 'mine' && !authUser) {
      // 没登录 → 弹登录框 (弹一次就够); 登录完这个 effect 会因为 authUser 变化再跑一遍
      if (!shareLoginAskedRef.current) {
        shareLoginAskedRef.current = true
        openAuthModal('login')
      }
      return
    }
    shareLoadedRef.current = true
    findLibraryItemById(link.scope, link.id)
      .then(async (item) => {
        if (!item) throw new Error('乐库里找不到这首曲子')
        const groupId = link.scope === 'mine' ? 'mine' : (item.groupId ?? '')
        await loadLibrarySong(item, groupId)
        useStore.getState().addLastPlayed({
          kind: 'library',
          itemId: item.id,
          groupId,
          title: item.title,
          composer: item.composer,
          at: Date.now(),
        })
      })
      .catch((e) => {
        console.warn('打开分享链接失败:', e)
        setShareError((e as Error).message)
      })
  }, [authChecked, authUser])

  // 倒计时订阅
  useEffect(() => {
    const unsub = countdown.subscribe((step) => {
      useStore.getState().setCountdown(step)
    })
    return unsub
  }, [countdown])

  // 屏幕常亮 —— 练琴时人离得远, 屏幕一黑就看不见瀑布和灯带提示了.
  // (浏览器不支持 / 申请被拒 → 什么都不发生, 不影响别的功能.)
  useEffect(() => setupWakeLock(), [])

  // 重建 player
  useEffect(() => {
    if (!song) {
      playerRef.current?.pause()
      playerRef.current = null
      return
    }

    const player = new Player(
      song,
      synth,
      acc,
      metronome,
      countdown,
      // 播放事件用模块级 emit (防 HMR), 标 source='playback' 跟输入区分
      // 带 note.hand: 让 LED 按"事件级"上色 (同 midi 出现 LH/RH 时用对应手色)
      // hit=true → 命中反馈脉冲 (独立通道, 不被 LED offset 吞掉) —— spec P1-9
      (n, hit) => (hit ? emitLedHit(n.midiNote, n.hand) : emitLedNoteOn(n.midiNote, 'playback', n.hand)),
      (n) => emitLedNoteOff(n.midiNote, 'playback', n.hand),
    )
    playerRef.current = player
    playerApiRef.current = {
      getPressedNotes: () => player.getPressedNotes(),
      getPlayingNotes: () => player.getPlayingNotes(),
      isFrozen: () => player.isFrozen(),
      getWaitTarget: () => player.getWaitTarget(),
      getNoteStates: () => player.getNoteStates(),
      getCurrentTime: () => player.getCurrentTime(),
    }
    bus.setHandler((e) => player.handleInput(e))
    // 按当前 inputSource 走 (而不是 hardcode kbInput) — 之前 hardcode 导致
    // 自动连接 MIDI 后, 切歌 (song 变 → 重建 player) 时 bus.use(kbInput) 把 midiInput 覆盖回键盘,
    // 用户在 wait 模式按 MIDI 琴键无响应, 看起来像 wait 失效.
    const inputSource = useStore.getState().inputSource
    bus.use(inputSource === 'midi' ? midiInput : kbInput)
    player.syncVolume()
    player.syncTranspose()

    // 消费挂起标志: 双击 / 自动加载时, 新 player 就绪后立即开始.
    if (pendingAutoplayRef.current) {
      queueMicrotask(() => {
        pendingAutoplayRef.current = false
      })
      player.play()
      setIsPlaying(true)
    }

    return () => {
      player.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, kbInput])

  // 独立同步 inputSource → bus.use.
  // 之前依赖 player effect 来 setBus 用 kbInput, 切歌时若 inputSource='midi' 会覆盖 MIDI.
  // 现在独立追踪: inputSource 变就重连 (player 不重建, 不会丢 currentTime).
  const inputSource = useStore((s) => s.inputSource)
  useEffect(() => {
    bus.use(inputSource === 'midi' ? midiInput : kbInput)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputSource])

  // 同步 volume / transpose (waitMs 不再需要同步, PlayAlong 内部无此参数)
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.syncVolume()
      playerRef.current.syncTranspose()
    }
  }, [volume, transpose])

  // 页面隐藏兜底
  useEffect(() => {
    const onHide = () => {
      acc.panic()
      synth.stopAll()
    }
    window.addEventListener('pagehide', onHide)
    window.addEventListener('beforeunload', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('beforeunload', onHide)
      onHide()
    }
  }, [acc, synth])

  // LED 灯带跟随: ledEnabled / ledHost / ledDevice 变了就拆/建
  const ledEnabled = useStore((s) => s.ledEnabled)
  const ledBrightness = useStore((s) => s.ledBrightness)
  const ledHost = useStore((s) => s.ledHost)
  const ledToken = useStore((s) => s.ledToken)
  const ledDevice = useStore((s) => s.ledDevice)
  const ledDualStrip = useStore((s) => s.ledDualStrip)
  const ledUpperBrightnessRatio = useStore((s) => s.ledUpperBrightnessRatio)
  /** 左手 / 右手的灯分别开关 (首页的两个勾选框). */
  const ledHandLeft = useStore((s) => s.ledHandLeft)
  const ledHandRight = useStore((s) => s.ledHandRight)
  const ledUpperLevelMax = useStore((s) => s.ledUpperLevelMax)
  const ledUpperLevelMin = useStore((s) => s.ledUpperLevelMin)
  /** 上灯带显示几个音 (每只手各 N 个, 用户可设). */
  const ledUpperNoteCount = useStore((s) => s.ledUpperNoteCount)
  /**
   * 双色带 = 两条灯带串联 352 颗.
   *
   * 树莓派: led_remote.py 的 count 白名单是 (176, 352) —— 直接 init 352.
   * ESP32:  固件的 led.init 现在也认 352 (白名单 LED_ALLOWED_COUNTS),
   *         换灯数会重建像素缓冲 —— 但**必须烧新固件**, 旧固件只认 176.
   */
  const dualOn = ledDualStrip
  const setLedConnected = useStore((s) => s.setLedConnected)
  const setLedActiveDevice = useStore((s) => s.setLedActiveDevice)
  const setLedError = useStore((s) => s.setLedError)

  const ledRef = useRef<LedController | null>(null)
  const transportRef = useRef<WsTransport | null>(null)
  const followerRef = useRef<LedFollower | null>(null)
/**
 * LED pre-scanner 的事件游标 (spec P1-15).
 * 放在 ref 里跨 effect 重建保留 —— offset 变化时游标不能归零, 否则刚亮的灯
 * 会被重新 on 一遍 (闪一下又全亮).
 */
const scanRef = useRef<{ song: unknown; cursor: LedScanCursor; lastT: number } | null>(null)

  /**
   * 抢先模式的**当前**开关值 —— effect 的 cleanup 里要用.
   *
   * cleanup 跑在 commit 阶段 (render 已经算完), 所以 ref 里的是**新**的值:
   * 「是不是刚切到抢先模式了」→ 该把 pre-scanner 点的灯灭掉.
   */
  const leadModeRef = useRef(leadMode)
  leadModeRef.current = leadMode
  /**
   * 抢先模式提示灯的**上一帧状态** —— 差分的基准.
   *
   * 放在 ref 里 (而不是 effect 里的局部变量):
   *  - 灯被外部清空 (跑马灯测试 / 打开编辑器 / 切歌) 时要把它清掉 →
   *    下一帧重新点亮提示灯 (自愈). 不清的话提示灯永远回不来.
   */
  const leadHintRef = useRef<LeadHint | null>(null)
  /**
   * 灭掉 pre-scanner 点的所有灯.
   *
   * 播放层的灯是 pre-scanner (LedScanCursor) 点的 —— Player 的 playback
   * noteOff 被 emit.ts 抑制了, 到不了灯条. 所以清灯必须走这里.
   */
  const flushScanCursor = useCallback(() => {
    const scan = scanRef.current
    if (!scan) return
    const s = scan.song as Song | null
    if (!s) return
    try {
      scan.cursor.flush((idx, on) => {
        const note = s.notes[idx]
        if (!note) return
        if (!on) ledRef.current?.setIntensity(note.midiNote, 1)
        emitLedPlaybackRaw(note.midiNote, on, note.hand)
      })
    } catch {}
  }, [])

  /**
   * 把 pre-scanner 的游标重新对齐到当前时间.
   *
   * 什么时候用: 恢复播放 / 跑完跑马灯测试 —— 这两种情况下灯带被清空了,
   * 但**当前还在画面上的音条**对应的灯应该重新亮起来 (音条在, 灯就该在).
   *
   * 注意: 调用前要先把 follower 的状态清干净 (clearAll), 否则 follower 那边
   * 的计数会跟重新点亮的次数叠上 → 灯灭不掉.
   */
  const reseekScanCursor = useCallback(() => {
    const scan = scanRef.current
    if (!scan) return
    const s = scan.song as Song | null
    if (!s) return
    const st = useStore.getState()
    const t = renderTime(playerRef.current, st.currentTime)
    const offsetMs = 0 // 提前量已跟灯带解耦 (同下面的 pre-scanner effect)
    scan.lastT = t
    scan.cursor.seekTo(t, offsetMs, (idx, on) => {
      const note = s.notes[idx]
      if (!note) return
      emitLedPlaybackRaw(note.midiNote, on, note.hand)
    })
  }, [])

  /**
   * 暂停时的「当前键位」预览 —— 灯带上亮出用户此刻停在的那一组音.
   *
   * 播放中 / 没开灯 / 没有曲子 → 什么都不预览.
   * 曲子放完了 → 也不预览 (灯带该是空的).
   */
  const applyPreview = useCallback(() => {
    const s = useStore.getState()
    const songNow = s.song
    // 编辑器开着 → 不点亮「暂停预览」: 编辑器里要点音定位, 灯带得是干净的,
    // 只亮用户点的那个音. (否则一进编辑器就亮着一组旧键, 看着像没清干净.)
    if (!songNow || !s.ledEnabled || s.isPlaying || editorOpenRef.current) {
      followerRef.current?.clearPreview()
      return
    }
    // 用播放器的连续时间 (store 的 currentTime 被量化到 10Hz, 曲终时会差 ~100ms).
    const t = renderTime(playerRef.current, s.currentTime)
    // 曲子放完了 → 不预览. 灯带该是空的 (用户要求「播完曲子应该清空灯带」).
    if (songEnded(songNow, t)) {
      followerRef.current?.clearPreview()
      return
    }
    // 找 currentTime 之前 (含 ±ε) 最近的一组音 — 同一个 time 的所有 midi 一起亮
    let latestTime = -Infinity
    for (const n of songNow.notes) {
      if (n.time <= t + 0.001 && n.time > latestTime) latestTime = n.time
    }
    if (!isFinite(latestTime)) {
      // 还没走到任何 note (currentTime 在第一组之前)
      followerRef.current?.clearPreview()
      return
    }
    const midis: Array<{ midi: number; hand?: 'left' | 'right' }> = []
    for (const n of songNow.notes) {
      if (Math.abs(n.time - latestTime) < 0.02) {
        midis.push({ midi: n.midiNote, hand: n.hand })
      }
    }
    followerRef.current?.setPreview(midis)
  }, [])
  const unsubBusRef = useRef<(() => void) | null>(null)
  const lastHostRef = useRef<string | null>(null)
  const lastTokenRef = useRef<string | null>(null)
  const lastDeviceRef = useRef<string | null>(null)
  /** 上次建连时用的灯带模式 (单/双色带) —— 变了要重建 (init 的 count 不一样). */
  const lastDualRef = useRef<boolean | null>(null)
  const retryTimerRef = useRef<number | null>(null)
  /** 命令丢失后的重刷防抖 (别让一次断链触发 resync 风暴). */
  const resyncTimerRef = useRef<number | null>(null)
  const lastResyncAtRef = useRef(0)
  /** 「测试」跑马灯正在进行 —— 期间不许重刷 / 重复启动. */
  const testBusyRef = useRef(false)

  // 取消重试 (e.g. 关闭 LED / 切 host)
  const cancelRetry = () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    if (resyncTimerRef.current !== null) {
      window.clearTimeout(resyncTimerRef.current)
      resyncTimerRef.current = null
    }
  }

  useEffect(() => {
    let disposed = false

    // 清理 (拆旧)
    //
    // flushOff = 用户在关灯 / 页面要走了: 先把 off 发出去再断开 (否则灯带
    // 停在最后一帧, 就是「常亮残灯」).
    // flushOff = false 是"要重建连接"（换 host/后端/开关重开）: 立刻断开,
    // 由新连接的握手 led.off 清屏 —— 不能等 250ms 再断, 否则旧连接会把
    // 刚建好的新连接一起断掉 (同一个 BluetoothDevice 只能有一条 GATT).
    const teardown = (flushOff: boolean) => {
      cancelRetry()
      try { followerRef.current?.shutdown() } catch {}
      const oldLed = ledRef.current
      if (oldLed) {
        if (flushOff) {
          void (async () => {
            try {
              await Promise.race([
                oldLed.allOff(),
                new Promise((resolve) => setTimeout(resolve, 250)),
              ])
            } catch {}
            try { oldLed.disconnect() } catch {}
          })()
        } else {
          try { oldLed.disconnect() } catch {}
        }
      }
      try { unsubBusRef.current?.() } catch {}
      testBusyRef.current = false
      ledRef.current = null
      transportRef.current = null
      followerRef.current = null
      unsubBusRef.current = null
      // 拆解时也要注销测试回调, 否则 StatusBar 会调到旧 ref
      registerTestPattern(null)
      setLedConnected(false)
      setLedActiveDevice(null)
    }

    if (!ledEnabled) {
      teardown(true)
      lastHostRef.current = null
      return
    }
    // host / token / 设备 / 灯带模式 变了: 重建
    if (
      ledRef.current &&
      lastHostRef.current === ledHost &&
      lastTokenRef.current === ledToken &&
      lastDeviceRef.current === ledDevice &&
      lastDualRef.current === dualOn
    ) return
    teardown(false)

    // 初始化 mode + split + handMap + calibrate, 避免刚连上时颜色用默认值
    const s0 = useStore.getState()
    // HTTPS 页面里连明文 ws:// 会被浏览器按 mixed content 拦掉 → 走同源反代.
    // 服务端 (scripts/serve-dist.mjs) 把 /led-proxy/<设备> 透明转发到那台设备的
    // ws://:8080 —— 所以 HTTPS 下**填的地址不生效**, 生效的是服务器上配的目标.
    const proxyPath = window.location.protocol === 'https:' ? ledProxyPath(ledDevice) : undefined
    const devInfo = LED_DEVICE_INFO[ledDevice]
    const transport = new WsTransport({
      url: buildLedWsUrl(ledHost, 8080, proxyPath),
      token: resolveLedToken(ledToken),
      // 双色带 = 两条灯带串联 352 颗 (两侧的 count 白名单都是 176/352)
      count: dualOn ? LED_COUNT * 2 : LED_COUNT,
      // 引脚按设备给 —— 树莓派 18 (会真切 GPIO), ESP32 14 (编译期固定).
      pin: devInfo.pin,
      // 设备端跑马灯只有 ESP32 有.
      supportsDeviceMarquee: devInfo.supportsDeviceMarquee,
      label: `WebSocket (${devInfo.label})`,
    })
    transportRef.current = transport
    const led = new LedController({
      transport,
      brightness: ledBrightness,
      count: dualOn ? LED_COUNT * 2 : LED_COUNT,
      dualStrip: dualOn,
      upperBrightnessRatio: s0.ledUpperBrightnessRatio,
    })
    const follower = new LedFollower({
      led,
      isEnabled: () => useStore.getState().ledEnabled,
      followSource: effectiveFollowSource(s0.ledFollowPlayback, s0.ledFollowInput),
    })
    follower.setMode(s0.hand)
    follower.setSplit(s0.song?.pitchSplit ?? 60)
    if (handMap) follower.setHandMap(handMap)
    follower.setCalibrate(s0.ledCalibrate)
    follower.setColors(s0.ledColors)
    // 手别灯开关 (首页的两个勾选框) —— 新建的控制器默认两只手都亮, 这里补上用户的选择.
    follower.setHandEnabled('left', s0.ledHandLeft)
    follower.setHandEnabled('right', s0.ledHandRight)
    led.setUpcomingColors(s0.ledUpcomingColors)
    ledRef.current = led
    followerRef.current = follower
    lastHostRef.current = ledHost
    lastTokenRef.current = ledToken
    lastDeviceRef.current = ledDevice
    lastDualRef.current = dualOn
    // StatusBar 的「测试」按钮走这里 — 不用 prop 传 ref 下去.
    //
    // ★ 2026-10-26: 跑马灯是**独占动画**. 以前测试期间 follower 还在往灯带
    //   写 (按键灯 / 预览灯), 跑马过程中就会突然冒出别的灯 —— 用户报的
    //   「跑的时候其他灯还乱闪/乱删」. 现在先挂起跟随, 跑完再按状态重画.
    registerTestPattern(async () => {
      // 防双击: 测试是独占动画, 两次并发跑会互相清屏.
      if (testBusyRef.current) return
      const ledNow = ledRef.current
      const followerNow = followerRef.current
      if (!ledNow || !followerNow) return
      testBusyRef.current = true
      followerNow.suspend()
      try {
        await ledNow.testPattern()
      } finally {
        testBusyRef.current = false
        // 跑马灯期间 follower 只记状态不写灯带 —— 跑完必须把状态**清干净**,
        // 否则 resume 时会按「记下的状态」把旧灯重新点亮 = 用户报的
        // 「点了测试 跑马灯后还会有灯重新亮起来最终」.
        //
        // 播放层的灯由 pre-scanner 独占 → 播放中要 reseekScanCursor 重新点回来
        // (当前还在画面上的音条, 灯就该亮); 暂停中则重画预览.
        followerNow.clearAll()
        followerNow.resume()
        // 灯带被跑马灯清过 → 抢先模式的提示灯差分基准清掉 → 下一帧重新点回来.
        leadHintRef.current = null
        if (useStore.getState().isPlaying) reseekScanCursor()
        else applyPreview()
      }
    })
    const unsub = bus.addHandler(follower.handleEvent)
    unsubBusRef.current = unsub

    // 连接 + 失败重试
    const tryConnect = () => {
      if (!ledRef.current || lastHostRef.current !== ledHost) return
      led.connect()
        .then(() => {
          cancelRetry()
          setLedConnected(true)
          setLedError(null)
          setLedActiveDevice(ledDevice)
          console.warn('[led] connected via', transport.name)
          // 握手会 off 掉整条灯带 —— 把当前按住的键 / 预览重新点上.
          followerRef.current?.refresh()
          // 问设备「你是谁」—— 树莓派和 ESP32 都实现了 status op,
          // pin 字段能认出连的是哪台 (树莓派 18 / ESP32 14).
          void transport.probeStatus().then((s) => {
            if (s) console.info('[led] device status', s)
          })
        })
        .catch((e: any) => {
          console.warn('[led] connect failed, retry in 3s:', e)
          setLedConnected(false)
          setLedActiveDevice(null)
          setLedError(e?.message ?? String(e))
          retryTimerRef.current = window.setTimeout(tryConnect, 3000)
        })
    }

    // 连接中途掉了 (走远 / 板子重启 / 蓝牙重启): 以前**完全没人管** ——
    // UI 还显示"已连接", 写命令静默失败, 灯带就停在最后一帧 (常亮残灯).
    transport.onDisconnect = (reason) => {
      if (disposed) return
      console.warn('[led] disconnected:', reason)
      setLedConnected(false)
      setLedActiveDevice(null)
      setLedError(`灯条断开: ${reason}`)
      if (retryTimerRef.current === null) {
        retryTimerRef.current = window.setTimeout(tryConnect, 1000)
      }
    }

    // 命令丢了 (回执超时 / 设备报 busy / 坏帧): 按影子表整条重刷, 把物理
    // 灯带拉回逻辑状态. 2 秒内最多刷一次, 避免断链时反复重刷.
    transport.onCommandError = (msg) => {
      if (disposed) return
      // 测试跑马灯期间不重刷: 旧固件回 unknown op / 逐帧发时出点错是预期的,
      // 中途 resync 会把动画打断.
      if (testBusyRef.current) return
      if (resyncTimerRef.current !== null) return
      if (Date.now() - lastResyncAtRef.current < 2000) return
      resyncTimerRef.current = window.setTimeout(() => {
        resyncTimerRef.current = null
        lastResyncAtRef.current = Date.now()
        console.warn('[led] command lost, resync:', msg)
        void ledRef.current?.resync().catch(() => {})
      }, 200)
    }

    tryConnect()

    return () => {
      disposed = true
      cancelRetry()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledEnabled, ledHost, ledToken, ledDevice, ledDualStrip, bus, setLedConnected, setLedActiveDevice, setLedError])

  // 亮度改变: 实时同步
  useEffect(() => {
    followerRef.current?.setBrightness(ledBrightness)
  }, [ledBrightness])

  /* ── LED 点阵屏 (HUB75 面板) ──────────────────────────────────────
     跟灯带是**两条独立的路**: 点阵屏走树莓派端口 8081 (matrix_server),
     推的是整屏 RGB888 图像帧; 灯带走 8080, 推的是「第几颗灯什么颜色」.
     所以这里自己连自己推, 不复用灯带那套 transport. */

  const ledScreenEnabled = useStore((s) => s.ledScreenEnabled)
  const ledScreenHost = useStore((s) => s.ledScreenHost)
  const ledScreenToken = useStore((s) => s.ledToken)
  const ledScreenScreens = useStore((s) => s.ledScreenScreens)
  const ledScreenFps = useStore((s) => s.ledScreenFps)
  const ledScreenBrightness = useStore((s) => s.ledScreenBrightness)
  const ledScreenKeyboardH = useStore((s) => s.ledScreenKeyboardH)
  const ledScreenNoteScale = useStore((s) => s.ledScreenNoteScale)
  const ledScreenFlip = useStore((s) => s.ledScreenFlip)
  const ledScreenColors = useStore((s) => s.ledScreenColors)
  const setLedScreenConnected = useStore((s) => s.setLedScreenConnected)
  const setLedScreenError = useStore((s) => s.setLedScreenError)

  const screenRef = useRef<ScreenController | null>(null)

  useEffect(() => {
    if (!ledScreenEnabled) {
      screenRef.current?.stop()
      screenRef.current = null
      setLedScreenConnected(false)
      setLedScreenError(null)
      return
    }
    const ctrl = new ScreenController({
      // HTTPS 部署走服务器反代 (同源 wss), 否则直连树莓派 8081.
      url: buildScreenWsUrl(
        ledScreenHost,
        8081,
        window.location.protocol === 'https:' ? SCREEN_PROXY_PATH : undefined,
      ),
      token: resolveLedToken(ledScreenToken),
      fps: ledScreenFps,
      screens: ledScreenScreens,
      brightness: ledScreenBrightness,
      // 插头在右边 -> 链从右往左串 -> 画面翻过来
      flip: ledScreenFlip,
      // 每帧现取 —— 播放器的时间是连续的, store 的 currentTime 只到 10Hz.
      getSource: () => {
        const st = useStore.getState()
        return {
          song: st.song,
          t: renderTime(playerRef.current, st.currentTime),
          practiceHand: st.hand,
          pressed: playerRef.current?.getPressedNotes() ?? new Set<number>(),
          transpose: st.transpose,
          noteStates: playerRef.current?.getNoteStates?.() ?? new Map(),
        }
      },
      onStatus: (connected, error) => {
        setLedScreenConnected(connected)
        setLedScreenError(error)
      },
    })
    screenRef.current = ctrl
    // 重连时把当前的版面带上去 (否则会退回默认的 16 行琴键区)
    ctrl.setLayout({
      keyboardH: ledScreenKeyboardH,
      noteScale: ledScreenNoteScale,
    })
    // 配色同理 —— 刷新页面后别退回默认配色
    ctrl.setColors(ledScreenColors)
    ctrl.start()
    return () => {
      ctrl.stop()
      if (screenRef.current === ctrl) screenRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledScreenEnabled, ledScreenHost, ledScreenToken, setLedScreenConnected, setLedScreenError])

  // 屏号变了 -> 重新 init. 屏数变了树莓派要重启 led_anim (菊花链长度变了),
  // 屏数没变只是内容换了个位置, 树莓派那边不用动.
  useEffect(() => {
    screenRef.current?.setScreens(ledScreenScreens)
  }, [ledScreenScreens])

  // 帧率改了不用重连 —— 控制器自己调就行 (重连会让屏幕黑一下).
  useEffect(() => {
    screenRef.current?.setFps(ledScreenFps)
  }, [ledScreenFps])

  // 亮度同理: 树莓派按帧缩放, 拖滑块实时生效, 不会重连也不会黑一下.
  useEffect(() => {
    screenRef.current?.setBrightness(ledScreenBrightness)
  }, [ledScreenBrightness])

  // 版面 (琴键区高度 / 音符大小) 改了同理 —— 渲染器下一帧就换.
  useEffect(() => {
    screenRef.current?.setLayout({
      keyboardH: ledScreenKeyboardH,
      noteScale: ledScreenNoteScale,
    })
  }, [ledScreenKeyboardH, ledScreenNoteScale])

  // 翻转同理 —— 下一帧就换, 不用重连.
  useEffect(() => {
    screenRef.current?.setFlip(ledScreenFlip)
  }, [ledScreenFlip])

  // 配色同理 —— 下一帧就换, 不用重连.
  useEffect(() => {
    screenRef.current?.setColors(ledScreenColors)
  }, [ledScreenColors])

  // 左手 / 右手的灯分别开关 (首页的两个勾选框).
  // 关掉 → 那只手当前亮着的灯立刻全灭 (静默); 开回来 → 还按着的键重新点上.
  useEffect(() => {
    followerRef.current?.setHandEnabled('left', ledHandLeft)
    followerRef.current?.setHandEnabled('right', ledHandRight)
  }, [ledHandLeft, ledHandRight])

  // 上灯带亮度比例 (相对主灯带, 默认 70%) —— 改了要把上灯带重画.
  useEffect(() => {
    ledRef.current?.setUpperBrightnessRatio(ledUpperBrightnessRatio)
  }, [ledUpperBrightnessRatio])

  /**
   * 双色带: 上灯带显示**左右手各自接下来 N 个音** (N 可设, 默认 3).
   *
   * 为什么不能用 pre-scanner (LedScanCursor): 它只在
   * 「播放中 + 跟随乐谱」时才跑, 而下一个音的提示在**暂停时**也必须能显示.
   *
   * 每 50ms 查一次 (用播放器的连续时间, 不是 store 里 10Hz 的 currentTime,
   * 否则提示会滞后 100ms). 每次都**无条件**下发 —— 增量逻辑在 LedController
   * 内部 (没变化就不发包), 这样 allOff / 重连之后能自愈点亮.
   *
   * 亮度: 越往后越暗 —— 用户只设「最亮 / 最暗」两个百分比,
   * 中间按**等比数列**插值 (3 个音时中间那个 = √(最亮×最暗)).
   * 「当前该弹哪个」在主灯带上, 上灯带只管「接下来弹什么」.
   */
  useEffect(() => {
    // 编辑器 / MIDI 面板开着 → 上灯带也熄着. 否则 50ms 一次的 setUpperHints
    // 会把「接下来弹什么」重新点亮 —— 用户看到的就是「进了编辑器灯没清掉」.
    if (!song || !ledEnabled || !dualOn || editorOpen || midiOpen) {
      ledRef.current?.clearUpperHints()
      return
    }
    const index = new NextNoteIndex(song, song.pitchSplit ?? 60)
    const ladder = ledLevelLadder(ledUpperLevelMax, ledUpperLevelMin, ledUpperNoteCount)
    const update = () => {
      const st = useStore.getState()
      const t = renderTime(playerRef.current, st.currentTime)
      // 抢先模式: 上灯带的基准改成**每只手自己的提示音** —— 第一格就是主灯带
      // 那个提示音, 后面依次往下 (spec §R23).
      // 减 0.001s: findNext 用的是严格 `time > t`, 不减一点点就含不住提示音本身.
      //
      // 两只手各用各的基准 —— 右手弹得快时右手的提示已经往前走了,
      // 左手还在原来的位置 (提示是**按手**的, 不是整首曲子一个时间).
      const base: { left: number; right: number } = { left: t, right: t }
      if (effectiveLead(st.hand, st.wait, st.leadNext)) {
        const hint = playerRef.current?.getLeadHint()
        if (hint) {
          for (const h of hint.hands) base[h.hand] = h.time - 0.001
        }
      }
      const pairL = index.at(base.left, ledUpperNoteCount)
      const pairR = index.at(base.right, ledUpperNoteCount)
      const hints: LedHint[] = []
      for (let i = 0; i < pairL.left.length; i++) {
        hints.push({ midi: pairL.left[i].midiNote, hand: 'left', level: ladder[i] ?? 0 })
      }
      for (let i = 0; i < pairR.right.length; i++) {
        hints.push({ midi: pairR.right[i].midiNote, hand: 'right', level: ladder[i] ?? 0 })
      }
      ledRef.current?.setUpperHints(hints)
    }
    update()
    const timer = window.setInterval(update, 50)
    return () => {
      window.clearInterval(timer)
      ledRef.current?.clearUpperHints()
    }
  }, [song, ledEnabled, dualOn, ledUpperNoteCount, ledUpperLevelMax, ledUpperLevelMin, editorOpen, midiOpen])

  // 加载歌曲后: 把 song.pitchSplit 同步到 LED 控制器, 让左右手颜色跟项目划分一致
  const songPitchSplit = song?.pitchSplit
  useEffect(() => {
    followerRef.current?.setSplit(songPitchSplit ?? 60)
  }, [songPitchSplit])

  // 谱子里每个 MIDI 音对应哪只手 (从 note.hand / note.track 推断)
  // 优先级高于 pitchSplit: 比如某首曲右手有低音, 也能正确显示成右手色
  //
  // 同一个 midi 两只手都出现 → 记 'both' (spec P2-2).
  // 旧实现是"首现手胜出" —— 左手低音与右手旋律同音名时, 整个音色的手色都错.
  // 'both' 不猜, 交给 LedController.baseColor 落到 mode/split 兜底.
  const handMap = useMemo(() => {
    if (!song) return null
    const m = new Map<number, 'left' | 'right' | 'both'>()
    for (const n of song.notes) {
      const h = noteHand(n.hand, n.track, song.hands)
      if (!h) continue
      const prev = m.get(n.midiNote)
      if (prev === undefined) m.set(n.midiNote, h)
      else if (prev !== h) m.set(n.midiNote, 'both')
    }
    return m
    // handInferVersion 变了 = note.hand 被就地重算过 (spec P2-6) → 上色要跟着重算
  }, [song, handInferVersion])
  useEffect(() => {
    followerRef.current?.setHandMap(handMap)
  }, [handMap])

  // 跟弹模式切换: 立刻重画当前按住的键 (e.g. left → both 时, 灯色从全蓝/绿变成按 split 划)
  useEffect(() => {
    followerRef.current?.setMode(hand)
  }, [hand])

  // 暂停时: 预览「当前键位」— 与 currentTime 最近且不超过 currentTime 的那一组音.
  // 用户学谱时想知道「我停在哪个键上」, 而不是「下一个是什么」.
  // 挪动进度条 / 暂停 → currentTime 变 → 预览跟着切到新位置的 chord.
  // 播放时: 清除预览 (真在响的 note 会自动覆盖预览).
  //
  // 实际逻辑在 applyPreview (定义在上面) —— 抽成 callback 是因为**跑马灯测试
  // 结束后**要立刻重画一次预览: 测试前是预览状态, 跑完不重画 → 预览灯没了,
  // 用户看到的跟暂停时不一致.
  useEffect(() => {
    applyPreview()
  }, [isPlaying, currentTime, song, ledEnabled, applyPreview])

  // 校准开关: 中央 C 常亮白
  const ledCalibrate = useStore((s) => s.ledCalibrate)
  useEffect(() => {
    followerRef.current?.setCalibrate(ledCalibrate)
  }, [ledCalibrate])

  // 4 色调色板变化
  const ledScheme = useStore((s) => s.ledScheme)
  const ledColors = useStore((s) => s.ledColors)
  const ledUpcomingColors = useStore((s) => s.ledUpcomingColors)

  /**
   * 灯带配色方案的解析.
   *
   * - 'c' / 'd'  → 用 store 里的颜色 (选方案时已经把预设写进去了)
   * - 'auto'    → 按曲速挑 C / D —— **只影响下发到灯带的颜色**,
   *                不动 store 里的手动调色 (用户自己改的色不会被自动方案刷掉)
   * - 'custom'  → 用户手动调过的色
   */
  const songBpm = useMemo(() => {
    const bs = song?.bpms
    if (!bs || bs.length === 0) return 0
    return bs.reduce((sum, b) => sum + b.bpm, 0) / bs.length
  }, [song])
  const autoPicked = useMemo(() => autoScheme(songBpm), [songBpm])
  const resolvedCurrent: LedPalette = useMemo(
    () => (ledScheme === 'auto' ? autoPicked.current : ledColors),
    [ledScheme, autoPicked, ledColors],
  )
  const resolvedUpcoming: LedPalette = useMemo(
    () => (ledScheme === 'auto' ? autoPicked.upcoming : ledUpcomingColors),
    [ledScheme, autoPicked, ledUpcomingColors],
  )

  useEffect(() => {
    followerRef.current?.setColors(resolvedCurrent)
  }, [resolvedCurrent])

  // 预告行 (上灯带) 的配色 —— 降饱和那一套, 跟当前行拉开层次
  useEffect(() => {
    ledRef.current?.setUpcomingColors(resolvedUpcoming)
  }, [resolvedUpcoming])

  // 当前音「呼吸」: 幅度跟着方案走 (自定义不动 —— 保留上一次的值)
  useEffect(() => {
    if (ledScheme === 'custom') return
    const amp =
      ledScheme === 'auto' ? autoPicked.pulse : (getScheme(ledScheme)?.pulse ?? 0)
    ledRef.current?.setPulse(amp)
  }, [ledScheme, autoPicked])

  // 呼吸走帧 —— 每 50ms 一次 (没亮着灯时零流量)
  useEffect(() => {
    if (!ledEnabled) return
    const timer = window.setInterval(() => ledRef.current?.tickPulse(50), 50)
    return () => window.clearInterval(timer)
  }, [ledEnabled])

  // 跟随源切换 — 两个独立开关折叠成 follower 的 followSource
  const ledFollowPlayback = useStore((s) => s.ledFollowPlayback)
  const ledFollowInput = useStore((s) => s.ledFollowInput)
  useEffect(() => {
    followerRef.current?.setFollowSource(effectiveFollowSource(ledFollowPlayback, ledFollowInput))
  }, [ledFollowPlayback, ledFollowInput])

  // 播放层的灯**一律**由 pre-scanner 独占 (emit.ts 抑制 Player 的 playback 直发).
  //
  // ★ 2026-10-31: 提前量已跟灯带**解耦** (用户要求「提前滞后那里可以解耦,
  //   当前应该不需要了」) —— 灯不再提前亮, 也不再渐亮, 固定 offsetMs = 0.
  //   灯的语义现在是: **只亮当前这一组音** (同一时刻的音一起亮), 下一组开始就换.
  //   提前量 (store.ledOffsetUnits) 现在**什么都不影响** —— 「提前按」这个独立
  //   模式已删 (2026-11-05), 判定窗口恒为命中窗口.

  useEffect(() => {
    // 编辑器 / MIDI 面板开着 → 播放层不点灯 (用户要求那两个界面把灯清空).
    // 否则 clearLedNow 刚清完, 下一帧 pre-scanner 又把灯点回来.
    if (!song || !isPlaying || !ledEnabled) return
    if (editorOpen || midiOpen) return

    // ── 抢先模式: 灯带显示「每只手现在该弹的音」 ────────────────
    // 不用 pre-scanner —— 它按**时间**扫事件流, 而抢先的灯是**状态**的投影
    // (弹对了才推进, 不等时钟). spec §R23.
    //
    // 提示是**按手**的: 左手一个待弹组, 右手一个待弹组, 各亮各的.
    //
    // ★ 2026-11-10: 抢先的灯**不受「跟随乐谱」开关**影响 —— 它是「该弹哪个」
    //   的提示, 不是「跟着声音亮」. 以前这个开关关掉时抢先的灯直接不亮.
    if (leadMode) {
      let raf = 0
      const loop = () => {
        const hint = playerRef.current?.getLeadHint() ?? null
        const { on, off } = diffLeadHints(leadHintRef.current, hint)
        for (const n of off) {
          ledRef.current?.setIntensity(n.midi, 1)
          emitLedLead(n.midi, false, n.hand)
        }
        for (const n of on) {
          ledRef.current?.setIntensity(n.midi, 1)
          emitLedLead(n.midi, true, n.hand)
        }
        leadHintRef.current = hint
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      return () => {
        cancelAnimationFrame(raf)
        // 提示的灯只有这里能灭 —— 模式切走 / 暂停时必须灭干净.
        // (灭完把基准清掉: 下次重跑时从头点, 不会跟 follower 的计数叠上)
        const { off } = diffLeadHints(leadHintRef.current, null)
        for (const n of off) emitLedLead(n.midi, false, n.hand)
        leadHintRef.current = null
      }
    }

    // ── 普通模式: 播放层的灯由 pre-scanner 独占 ────────────────
    // 「跟随乐谱」关掉 → 播放层不点灯 (抢先的灯不受影响, 上面就 return 了).
    if (!ledFollowPlayback) return

    const offsetMs = 0 // 提前量已解耦 (见上面的说明)
    let raf = 0
    // 修 #16 + spec P1-15: effect 重建时游标**不清零** ——
    // 游标跨 effect 重建保留 (放在 ref 里), 否则刚亮的灯会被重新 on 一遍,
    // 视觉上看到「闪一下又全亮」. cleanup 只取消 rAF, 不清灯.
    //
    // ★ 2026-10-22: lastT 也跟着游标放进 ref —— 之前它是 effect 内的局部变量,
    // effect 重建 (isPlaying 变了 / offset 变了) 就归零 → "倒退检测"失效:
    // 重播 (restart) 把时间拉回 0, 但 lastT 已经是新的局部值 → 游标**不归零**
    // → 旧曲已经走过的 note 不会再 on/off → 灯的状态跟新进度对不上 (残留).
    if (!scanRef.current || scanRef.current.song !== song) {
      scanRef.current = { song, cursor: new LedScanCursor(song.notes), lastT: -1 }
    }
    const scan = scanRef.current
    const cursor = scan.cursor

    const loop = () => {
      // 时间源: 播放器的连续时间, 不绕 10Hz 量化的 store (spec P1-14).
      // offset 越大, 10Hz 量化误差占比越高 (±900ms 窗口下约 11%) → 灯的亮灭发跳.
      const t = renderTime(playerRef.current, useStore.getState().currentTime)
      const nowMs = t * 1000

      // 组灯 (pre-scanner 的"当前这一组")
      const emitGroup = (idx: number, on: boolean) => {
        const note = song.notes[idx]
        if (!note) return
        if (!on) ledRef.current?.setIntensity(note.midiNote, 1)
        emitLedPlaybackRaw(note.midiNote, on, note.hand)
      }

      // 时间倒退 → 游标归零, 重新评估
      //
      // ★ 2026-10-22: 回退时必须把旧灯灭掉 (reset(emit)) —— 灯是 pre-scanner
      // 点的, 没人灭它 → 旧位置的灯会一直亮着 (灯光残留). reset(emit) 先灭
      // 再重置, 新事件流再点一遍.
      //
      // ★ 2026-11-01: 跟弹模式冻结时歌曲时间会**回退**到「要弹的 note 的
      // 精确时间」, 曲首的 note 在 t=0 → 回退幅度接近半个预览窗. 旧阈值
      // (0.5s) 刚好卡在边界上, 有时漏掉 → 灯停在回退前的那一组上
      // (用户报的「提示要弹 c4 / 灯亮 e4」). 判定规则见 led/scanCursor.ts.
      if (isRewind(t, scan.lastT)) {
        cursor.reset(emitGroup)
      }
      scan.lastT = t

      // 用户弹过没有 —— noteStates 里 'hit' = 已经弹对 (Player 的 hitNoteIndices).
      const states = playerRef.current?.getNoteStates?.()
      const isPlayed = (idx: number) => states?.get(idx) === 'hit'

      cursor.advance(nowMs, offsetMs, (idx, on) => {
        const note = song.notes[idx]
        if (!note) return
        if (on) {
          // 开灯前先把亮度定好 (提前量解耦后 = 100%, 弹过了 = 减半).
          const lv = quantizeLevel(cursor.levelOf(idx, nowMs, offsetMs, isPlayed))
          ledRef.current?.setIntensity(note.midiNote, lv)
        } else {
          // 换组 / 音条消失 → 灯灭, 亮度系数复位 (下一个 note 不该带着上一个的半亮).
          ledRef.current?.setIntensity(note.midiNote, 1)
        }
        emitGroup(idx, on)
      })

      // 亮度: 提前量窗口里渐亮 (已解耦, 现在不走); 落键后用户弹过 → 减半.
      // (LedController.setIntensity 内部自己去重 —— 亮度没变就不重写像素.)
      cursor.forEachLit((midi, idx) => {
        const lv = quantizeLevel(cursor.levelOf(idx, nowMs, offsetMs, isPlayed))
        ledRef.current?.setIntensity(midi, lv)
      })

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      // ★ 2026-10-22: 播放**停下来**时 (暂停 / 曲终), 必须把 pre-scanner 点的
      // 灯全灭 —— 播放层的灯只有 pre-scanner 能灭.
      //
      // 但 effect 也会因为**别的原因**重建 (ledFollowPlayback 变了
      // / ledEnabled 变了) —— 那几种情况灯该继续亮着, 不能乱灭.
      // 判据: 重建时 isPlaying 还是 true 吗? 不是 → 播放停了 → 灭.
      //
      // ★ 切到**抢先模式**时也要灭: 抢先的灯由另一套逻辑 (按状态) 点,
      // pre-scanner 点的旧组还亮着的话, 灯带上会同时亮两组 (spec §R23).
      // leadModeRef 里是**新**的式值 (cleanup 跑在 commit 阶段, render 已完成).
      if (!useStore.getState().isPlaying || leadModeRef.current) {
        flushScanCursor()
        scan.lastT = -1
      }
    }
  }, [song, isPlaying, ledFollowPlayback, ledEnabled, editorOpen, midiOpen, leadMode])

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // 谱子编辑器开着的时候, 快捷键归它 (空格 = 播放, ↑↓ = 改音高…)
      if (editorOpen) return
      if (e.key === ' ') {
        e.preventDefault()
        if (isPlaying) handlePause()
        else handlePlay()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        handleRestart()
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        const seq = ['playback', 'both', 'right', 'left'] as const
        const next = seq[(seq.indexOf(hand) + 1) % seq.length]
        setHand(next)
        // 修 #11 + 同 onPick: 切到 practice 模式自动开 wait
        if (next !== 'playback' && !useStore.getState().wait) {
          useStore.getState().setWaitUserOverride(true)
        }
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        else document.documentElement.requestFullscreen().catch(() => {})
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        setLibraryOpen((v) => !v)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // ← / →: 跳到上/下一个 note.
        // - 没按 Shift: 只跳 active-hand note (跟 practice 模式对齐, 避免跳到 non-active
        //   的 note 后 visual 不动 — 修 #18: wait 模式 ← 跳到 non-active 位置后, 因
        //   required 空不 frozen 但也不显示 wait target, 用户感觉「卡死」)
        // - 按了 Shift: 跳任意 note (用于跳过特殊位置, e.g. 想跳到左手伴奏上的某个音)
        if (!playerRef.current || !song) return
        const curT = playerRef.current.getCurrentTime()
        const dir = e.key === 'ArrowRight' ? 1 : -1
        const t = e.shiftKey
          ? findAdjacentNoteTime(song, curT, dir)
          : findAdjacentActiveNoteTime(song, curT, dir, useStore.getState().hand)
        if (t === null) return
        e.preventDefault()
        const wasPlaying = isPlaying
        playerRef.current.seek(t)
        if (wasPlaying) playerRef.current.play()
        // 暂停时: 短暂预览这个位置的 note, 让用户「听到」自己跳到了哪
        if (!wasPlaying) playerRef.current.previewNotes(notesAt(song, t, 0.05))
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // ↑ / ↓: 跳到上/下一小节 (大跨步)
        if (!playerRef.current || !song) return
        const curT = playerRef.current.getCurrentTime()
        const t = findAdjacentMeasureTime(song, curT, e.key === 'ArrowDown' ? 1 : -1)
        if (t === null) return
        e.preventDefault()
        const wasPlaying = isPlaying
        playerRef.current.seek(t)
        if (wasPlaying) playerRef.current.play()
        if (!wasPlaying) playerRef.current.previewNotes(notesAt(song, t, 0.5))
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        // Backspace / Delete: 强制跳过所有卡住的 required (解冻 + 跳到下一个 note)
        // 用途: 用户不想弹某个 note / 系统卡了 / MIDI 键盘没响应
        if (!playerRef.current || !song) return
        // 抢先模式 (单手): 伴奏 1× 走, 跳播放头会打乱伴奏 → 只把**游标**往前挪
        if (playerRef.current.skipLeadNote()) {
          e.preventDefault()
          return
        }
        if (!playerRef.current.isFrozen()) return // 只在冻住时才有意义
        e.preventDefault()
        const curT = playerRef.current.getCurrentTime()
        const t = findAdjacentNoteTime(song, curT, 1)
        const wasPlaying = isPlaying
        if (t !== null) playerRef.current.seek(t)
        else playerRef.current.seek(curT + 1) // 没下一个就 +1s
        if (wasPlaying) playerRef.current.play()
        if (!wasPlaying && t !== null) playerRef.current.previewNotes(notesAt(song, t, 0.3))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, hand, song, editorOpen])

  // 链接电钢 → 默认开灯 (每会话只一次).
  // 用户主动关掉 LED 后不再开 (ledAutoEnabledRef 防止一直覆盖用户选择).
  // 手动 / 自动 / MIDI Modal 选设备都走这里 (midiOutputId null → 非 null).
  const ledAutoEnabledRef = useRef(false)
  const midiOutputId = useStore((s) => s.midiOutputId)
  useEffect(() => {
    if (midiOutputId === null) return
    if (ledAutoEnabledRef.current) return
    // 从 store 直读, 不订阅 ledEnabled — 我们只想响应 midiOutputId 变化, 不响应用户手动 toggle
    if (useStore.getState().ledEnabled) {
      ledAutoEnabledRef.current = true
      return
    }
    ledAutoEnabledRef.current = true
    useStore.getState().setLedEnabled(true)
  }, [midiOutputId])

  // 关键节点: 加载新歌时强制清灯条 — 旧曲的预扫灯 / calibration / 残留全清.
  // 触发点: Library 选曲 + FilePicker 打开本地文件 (都走 setSong). 第一次进来
  // song 从 null → 也有 ledRef.current === null, allOff 是 no-op, 无副作用.
  // 注意: 这里会顺手清掉 calibration 灯, 但新曲 follower.setCalibrate() 会按 store
  // 的 ledCalibrate 偏好重新点亮 (由 ledEnabled 初始化 effect 在更晚时机跑).
  // song 已在 line 67 定义; 复用.
  //
  // ★ 2026-10-22: 必须同时重置 follower 的内部状态 (clearAll), 不能只清像素.
  // follower.pressed / pendingOff / hitTimers 里存着旧曲的"哪些键还按着".
  // 只 allOff() 只擦了灯条, follower 仍以为旧键还按着 —— 新曲里同一个 midi
  // 再来一个 note 时, follower's down 会被当成"同源多重"累加 count,
  // 之后新曲的 up 只减 1 → 计数永远回不到 0 → 灯**再也灭不掉** (灯光残留).
  useEffect(() => {
    // 顺序要紧: 先 flush 游标点的灯 (发出 noteOff, 让 follower's 计数归零),
    // 再 clearAll (清 follower 内部状态 + 全灭像素).
    // 反过来的话 flush 发的 noteOff 会落到一个已经清空的 follower 上 →
    // 反而多出一个 pendingOff 定时器.
    flushScanCursor()
    try { followerRef.current?.clearAll() } catch {}
    try { ledRef.current?.allOff() } catch {}
    scanRef.current = null
  }, [song])

  // 关键节点: 每次从暂停恢复 / 重新播放时, 先清掉暂停期间的预扫残留灯.
  // isPlaying: false → true 的瞬间触发. 注意: isPlaying 第一次初始化为 false 时
  // 这里不会触发 (song 变化 effect 已经清过一次).
  // isPlaying 已在 line 68 定义; 复用.
  //
  // ★ 2026-10-22: 同样必须 clearAll follower (不只是清像素) —— 暂停时
  // Player.pause() 发的 noteOff 只让 follower 走 60ms grace, follower 的
  // pressed 计数不会归零. 恢复播放时若不重置, 新一轮的 note 会跟暂停前的
  // 计数叠加 → 灯灭不掉 (残留).
  //
  // ★ 2026-10-30: true → false (暂停 / 曲终) 也要处理:
  //   - 暂停: 播放层的灯 (pre-scanner 独占的那层) 灭掉, 换成「当前键位预览」;
  //   - 曲终: 灯带**全清** —— 用户要求「播完曲子应该清空灯带」, 而且不能
  //     再把最后一组音当预览点亮 (那会让曲子放完了灯还亮着).
  const prevPlayingRef = useRef(false)
  useEffect(() => {
    const was = prevPlayingRef.current
    prevPlayingRef.current = isPlaying
    if (isPlaying && !was) {
      try { followerRef.current?.clearAll() } catch {}
      try { ledRef.current?.allOff() } catch {}
      // 恢复播放 → pre-scanner 的游标从当前位置重走, 灯要重新点.
      // flushScanCursor() 已经把灯灭了, 这里只把 lastT 归零.
      if (scanRef.current) scanRef.current.lastT = -1
    } else if (!isPlaying && was) {
      // 播放层的灯只有 pre-scanner 能灭 (Player 的 playback 事件被抑制了).
      flushScanCursor()
      if (scanRef.current) scanRef.current.lastT = -1
      const st = useStore.getState()
      const t = renderTime(playerRef.current, st.currentTime)
      if (songEnded(st.song, t)) {
        // 曲终 → 灯带全清 (连预览都不点亮).
        try { followerRef.current?.clearAll() } catch {}
        try { ledRef.current?.allOff() } catch {}
        // ★ 上灯带 (双色带) 也要熄着 —— 用户报「第二条灯带的清除做得不好有残留」.
        //   allOff() 只是物理清零, 上层每 50ms 一次的 setUpperHints 会把提示点回来.
        //   曲终时曲子已经没下一个音了, 提示本来就是空的, 这里显式清掉 +
        //   熄着 → 第二条带保持黑 (直到 seek 回中间 / 重新播放).
        ledRef.current?.clearUpperHints()
      } else {
        // 暂停 → 预览当前键位.
        applyPreview()
      }
    }
  }, [isPlaying, applyPreview])

  // 关键节点: 用户主动关 LED (右上角 toggle) → 拆 LedController + 断开 WS 前已经 allOff.
  // 这里再补一刀保险: ledEnabled true → false 瞬间清掉, 防止最后一盏 calibration 残留.
  // ledEnabled 已在 line 273 定义; 复用.
  const prevLedEnabledRef = useRef(false)
  useEffect(() => {
    if (!ledEnabled && prevLedEnabledRef.current) {
      try { ledRef.current?.allOff() } catch {}
    }
    prevLedEnabledRef.current = ledEnabled
  }, [ledEnabled])

  // 打开 MIDI 面板 → 把当前的灯全清掉 (用户要求: "进入 midi 界面应该清空当前的灯").
  // 打开谱子编辑器 → 同样清一遍 (编辑器里要点音定位, 旧的灯留着只会看错).
  // 三样都要清 (顺序同换歌时那次):
  //   flushScanCursor → pre-scanner 点的灯 (发出 noteOff, 让 follower 计数归零)
  //   follower.clearAll → follower 内部状态 (哪些键还按着)
  //   led.allOff      → 物理像素
  // 只清像素不清 follower 状态的话, follower 以为旧键还按着 → 之后那个音再也灭不掉.
  const clearLedNow = useCallback(() => {
    flushScanCursor()
    try { followerRef.current?.clearAll() } catch {}
    try { ledRef.current?.allOff() } catch {}
    // 灯被清空了 → 抢先模式的提示灯差分基准也得清掉, 下一帧重新点回来 (自愈).
    leadHintRef.current = null
  }, [flushScanCursor])
  useEffect(() => {
    if (!midiOpen) return
    clearLedNow()
  }, [midiOpen, clearLedNow])
  useEffect(() => {
    if (!editorOpen) return
    clearLedNow()
  }, [editorOpen, clearLedNow])

  // 启动后, 第一次发现 MIDI Out 还没配置, 自动弹出连接弹窗
  // 改进: 监听 acc.onDisconnect —— 设备中途掉了 (USB 松了 / 蓝牙断) 也立刻弹
  useEffect(() => {
    const handler = () => {
      console.warn('[midi] output device disconnected')
      // 断开: 保留用户选的 id (便于自动重连), 只把运行时状态标成断开 (spec P1-12)
      useStore.getState().setMidiOutputConnected(false)
      setMidiOpen(true)
    }
    acc.onDisconnect = handler
    return () => { acc.onDisconnect = null }
  }, [acc])

  // MIDI Out 运行时连接状态 -> store (spec P1-12).
  // acc 是唯一真相: 连上 / send 失败 / 设备 state 变化 都从它出来.
  useEffect(() => {
    acc.onConnectionChange = (c) => useStore.getState().setMidiOutputConnected(c)
    return () => { acc.onConnectionChange = null }
  }, [acc])

  // 启动时: 试一次自动连接. 成功就静默 (不弹窗), 失败再弹出来让用户手动点.
  // Web MIDI 需要 user gesture, 部分浏览器在 DOMContentLoaded 后几百 ms 调
  // navigator.requestMIDIAccess() 仍允许 (同一 page load 内的 microtask 算手势上下文),
  // 失败的话会落到 setMidiOpen(true) 让用户点一下, 之后 acc.onDisconnect / 设备热插
  // 也会自动 re-pick.
  useEffect(() => {
    if (midiHintShown) return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return
      // 已经有 out (老页面热刷 state 没清) 就别再调一次
      if (useStore.getState().midiOutputId !== null) {
        setMidiHintShown(true)
        return
      }
      const result = await autoConnectMidi({ midiInput, acc, bus })
      if (cancelled) return
      if (result.ok) {
        console.warn('[midi] auto-connected:', result)
        setMidiOpen(false)
      } else {
        console.warn('[midi] auto-connect failed:', result.reason)
        setMidiOpen(true)
      }
      setMidiHintShown(true)
    }, 800)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [midiHintShown, midiInput, acc, bus])

  const handlePlay = () => {
    if (!playerRef.current || !song) return
    playerRef.current.play()
    setIsPlaying(true)
  }
  const handlePause = () => {
    playerRef.current?.pause()
    setIsPlaying(false)
  }
  const handleRestart = () => {
    if (!playerRef.current || !song) return
    // 重播 = 强制清灯 (用户要求: "刷新曲目应该强制清除当前的灯光").
    // 四样都要清: 物理像素 (allOff) / follower 的内部状态 (clearAll) /
    // pre-scanner 点的灯 (flushScanCursor) / pre-scanner 的游标
    // (否则旧进度的事件流会跟新进度错位).
    flushScanCursor()
    try { followerRef.current?.clearAll() } catch {}
    try { ledRef.current?.allOff() } catch {}
    scanRef.current = null
    playerRef.current.restart()
    setIsPlaying(true)
  }
  const handleSeek = (t: number) => {
    playerRef.current?.seek(t)
    // 跳转后立刻清掉旧灯 (Player.pause 会发 onNoteOff, 但有 60ms grace, 这里直接 allOff 立即干净)
    followerRef.current?.clearAll()
    // pre-scanner 点的灯也要灭 + 游标归零 —— 跳到别处, 旧位置的事件流不能再发
    flushScanCursor()
    scanRef.current = null
    if (isPlaying && playerRef.current) playerRef.current.play(false)
  }

  const duration = song?.duration ?? 0

  return (
    <div className="h-full flex flex-col bg-bg text-text select-none">
      {!isFs && (
        <TopBar
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenStats={() => setStatsOpen(true)}
          onOpenMidi={() => setMidiOpen(true)}
          onOpenLibrary={() => setLibraryOpen(true)}
        />
      )}

      {/* 练习控制条 (常驻, 全屏时隐藏).
          ★ 分组: 原来每个控件之间夹一根 <div className="w-px bg-border"> 竖线,
            一旦换行, 竖线会孤零零留在上一行末尾 (悬空分隔线), 下一行开头
            又孤零零一根 —— 看着像坏掉了. 现在改成「控件成组 + 组间留白」:
            换行只会整组换, 不会再有悬空的线. */}
      {!isFs && (
        <div className="min-h-10 px-4 py-1.5 border-b border-border bg-bg/60 flex flex-wrap items-center gap-x-6 gap-y-1">
          <HandSelector />
          <LedHandToggles />
          <div className="flex items-center gap-4 shrink-0">
            <WaitToggle />
            <LeadToggle />
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <ToleranceInput />
            <CountdownToggle />
            <SpeedControl />
          </div>
        </div>
      )}

      {/* 主体 */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col min-w-0 bg-bg">
          <div className="flex-1 relative min-h-0">
            <FallingNotes
              playerRef={playerApiRef}
              bus={bus}
              synth={synth}
              onNoteRightClick={(hit, pos) => setNoteHit({ hit, pos })}
            />
            <NoteInspector
              hit={noteHit?.hit ?? null}
              pos={noteHit?.pos ?? null}
              onClose={() => setNoteHit(null)}
              onEdit={(hit) => openEditor(hit.index)}
            />
            <WrongToast />
            {/* 音量 —— 右下角可收起的竖向面板 (2026-11-06 用户要求:
                从顶部练习条挪到右下角, 点圆按钮才展开竖滑块) */}
            <VolumePanel />
            {/* LED 入口平时在顶栏图标排里; 全屏时顶栏没了, 改浮在画面右上角.
                灯带和点阵屏是两个设备, 各占一个图标 (点阵屏那个在左边一点) */}
            {isFs && <LedDock variant="floating" />}
            {isFs && <LedScreenDock variant="floating" />}
            <CountdownOverlay />
            {!song && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="bg-bg/80 backdrop-blur px-4 py-2 rounded-lg text-muted text-sm border border-border">
                  点右上角「乐库」选一首, 或拖入 .mid / .xml 文件
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 乐库浮层 —— 全屏时也挂着.
            以前只在 !isFs 时渲染, 于是全屏里按 B 把状态切了却什么也没出现
            (键盘 handler 一直在跑, 面板就是不显示) —— 白按一下. */}
        <LibraryOverlay
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          tab={libraryTab}
          setTab={setLibraryTab}
          onLoaded={() => setLibraryOpen(false)}
          onPlayNow={requestAutoplay}
          onEditScore={() => openEditor(null)}
          isPlaying={isPlaying}
          onTogglePlay={() => {
            // 从 store 直读, 避免闭包陷阱 — 「播放中」状态在 setIsPlaying 后是新的
            if (useStore.getState().isPlaying) handlePause()
            else handlePlay()
          }}
        />
      </div>

      {/* 底栏 (Transport + StatusBar 同一行) */}
      {!isFs && (
        <div className="h-11 border-t border-border bg-panel/40 backdrop-blur flex items-center gap-2 px-3">
          <div className="flex-1 min-w-0">
            <Transport
              onPlay={handlePlay}
              onPause={handlePause}
              onRestart={handleRestart}
              onSeek={handleSeek}
              duration={duration}
              currentTime={currentTime}
            />
          </div>
          <div className="h-5 w-px bg-border" />
          <StatusBar />
        </div>
      )}

      {/* 全屏时: 浮窗退出按钮 (乐库开着的时候藏起来 —— 俩按钮叠一块儿了) */}
      {isFs && !libraryOpen && (
        <button
          onClick={() => document.exitFullscreen().catch(() => {})}
          className="fixed top-2 right-2 z-50 size-9 grid place-items-center rounded-lg bg-bg/80 border border-border text-text hover:bg-panel backdrop-blur transition-colors"
          title="退出全屏 (Esc / F)"
          aria-label="退出全屏"
        >
          <IconCollapse size={16} />
        </button>
      )}

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <StatsPopup
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        onRetry={() => {
          handleRestart()
          setStatsOpen(false)
        }}
      />
      <MidiModal
        open={midiOpen}
        onClose={() => setMidiOpen(false)}
        midiInput={midiInput}
        acc={acc}
        bus={bus}
        kbInput={kbInput}
      />
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        defaultTab={authMode}
      />
      <ScoreEditor
        open={editorOpen}
        song={song}
        focusIndex={editorFocus}
        synth={synth}
        midiOut={acc}
        ledRef={ledRef}
        onClose={() => setEditorOpen(false)}
        onApply={applyEditedNotes}
      />
      {/* 分享链接打不开时的提示 (比如那首曲子已经不在乐库里了) */}
      {shareError && (
        <div className="fixed bottom-14 left-1/2 -translate-x-1/2 z-[60] px-3 py-2 rounded-lg bg-panel border border-miss/50 text-miss text-xs shadow-xl flex items-center gap-2">
          <IconAlert size={13} />
          分享链接打不开: {shareError}
          <button
            onClick={() => setShareError(null)}
            className="text-muted hover:text-text"
            aria-label="关闭提示"
          >
            <IconClose size={12} />
          </button>
        </div>
      )}
    </div>
  )
}

// 乐库 / 文件浏览器 浮窗
// 设计: 占满整个屏幕顶部, 选定音乐后自动隐藏. 顶部有「上次弹过」快捷入口.
function LibraryOverlay({
  open,
  onClose,
  tab,
  setTab,
  onLoaded,
  onPlayNow,
  onEditScore,
  isPlaying,
  onTogglePlay,
}: {
  open: boolean
  onClose: () => void
  tab: Tab
  setTab: (t: Tab) => void
  onLoaded?: () => void
  onPlayNow?: () => void
  /** 右键曲目 → 打开谱子编辑器 */
  onEditScore?: () => void
  isPlaying?: boolean
  onTogglePlay?: () => void
}) {

  if (!open) return null
  return (
    <>
      {/* 背景遮罩 — 点击关闭 */}
      <div
        className="fixed inset-0 z-30 bg-black/20 animate-in fade-in"
        onClick={onClose}
        aria-hidden
      />
      {/* 浮窗主体 — 顶部 100% 高度, 全屏覆盖 */}
      <div
        className="fixed inset-y-0 right-0 z-40 w-[380px] max-w-[92vw] h-full bg-panel border-l border-border shadow-2xl shadow-black/40 flex flex-col overflow-hidden animate-in slide-in-from-right"
        role="dialog"
        aria-label="乐库"
      >
        <div className="flex items-center border-b border-border bg-panel/60 shrink-0">
          <TabBtn on={tab === 'library'} onClick={() => setTab('library')}>
            <IconMusic size={13} aria-hidden />
            乐库
          </TabBtn>
          <TabBtn on={tab === 'mine'} onClick={() => setTab('mine')}>
            <IconUser size={13} aria-hidden />
            我的
          </TabBtn>
          <TabBtn on={tab === 'files'} onClick={() => setTab('files')}>
            <IconFolder size={13} aria-hidden />
            文件
          </TabBtn>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="size-7 m-1 grid place-items-center rounded-lg text-muted hover:text-text hover:bg-raised transition-colors"
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>
        {/* 上次弹过 — 顶置快捷入口, library kind 可一键跳回去 */}
        <LastPlayedBanner onLoaded={onLoaded} onPlayNow={onPlayNow} />
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {tab === 'files' ? (
            <FilePicker />
          ) : (
            <>
              {/* 收藏夹 —— 紧跟在上面的「最近」下面, 默认收起 */}
              <Favourites onLoaded={onLoaded} onPlayNow={onPlayNow} />
              <Library
                scope={tab === 'mine' ? 'mine' : 'public'}
                onLoaded={onLoaded}
                onPlayNow={onPlayNow}
                isPlaying={isPlaying}
                onEditScore={onEditScore}
                onTogglePlay={onTogglePlay}
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-sm transition-colors border-b-2 inline-flex items-center gap-1.5 ${
        on
          ? 'border-accent text-text font-semibold'
          : 'border-transparent text-muted hover:text-text'
      }`}
    >
      {children}
    </button>
  )
}

// 「最近弹过」顶置 banner — 最多 5 个 library kind. 点击加载, 右侧 ▶ 加载并播放.
// 不渲染 file kind (没法还原). 失败时显示在那一行的右侧.
function LastPlayedBanner({
  onLoaded,
  onPlayNow,
}: {
  onLoaded?: () => void
  onPlayNow?: () => void
}) {
  const list = useStore((s) => s.lastPlayedList)
  const clearLastPlayed = useStore((s) => s.clearLastPlayed)
  if (list.length === 0) return null

  return (
    <div className="border-b border-border bg-accent/5 shrink-0">
      <div className="px-4 py-1.5 flex items-center gap-2">
        <span className="text-muted text-xs uppercase tracking-wider shrink-0">最近</span>
        <span className="text-xs text-muted/60 shrink-0">({list.length}/5)</span>
        <span className="flex-1" />
        <button
          onClick={clearLastPlayed}
          className="size-6 grid place-items-center rounded-md text-muted hover:text-text hover:bg-raised shrink-0 transition-colors"
          title="清空最近"
          aria-label="清空最近弹过的记录"
        >
          <IconClose size={12} />
        </button>
      </div>
      <div className="px-2 pb-2 flex flex-col gap-1 max-h-64 overflow-y-auto">
        {list.filter((lp) => lp.kind === 'library').map((lp) => (
          <LastPlayedRow
            key={`${lp.groupId}/${lp.itemId}`}
            lp={lp}
            onLoaded={onLoaded}
            onPlayNow={onPlayNow}
          />
        ))}
      </div>
    </div>
  )
}

function LastPlayedRow({
  lp,
  onLoaded,
  onPlayNow,
}: {
  lp: { kind: 'library'; itemId: string; groupId: string; title: string; composer: string; at: number }
  onLoaded?: () => void
  onPlayNow?: () => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (autoPlay: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const item = await findLibraryItem(lp)
      if (!item) {
        setError('找不到这首了')
        return
      }
      await loadLibrarySong(item, lp.groupId)
      useStore.getState().addLastPlayed({ ...lp, at: Date.now() }) // 移到最前 + 刷新时间
      if (autoPlay) onPlayNow?.()
      onLoaded?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/10 group">
      <span className="text-accent/70 shrink-0" aria-hidden>
        <IconMusic size={15} />
      </span>
      <button
        onClick={() => load(false)}
        disabled={loading}
        className="min-w-0 flex-1 text-left disabled:opacity-50"
        title={`${lp.composer} · ${formatTimeAgo(lp.at)}`}
      >
        <div className="font-medium text-text truncate text-sm">{lp.title}</div>
        <div className="text-xs text-muted truncate">{lp.composer} · {formatTimeAgo(lp.at)}</div>
      </button>
      {error && (
        <div className="text-xs text-miss shrink-0 inline-flex items-center gap-1">
          <IconAlert size={12} />
          {error}
        </div>
      )}
      <button
        onClick={() => load(true)}
        disabled={loading}
        className="size-7 grid place-items-center rounded text-muted hover:text-accent hover:bg-bg opacity-0 group-hover:opacity-100 disabled:opacity-50 shrink-0"
        title="加载并播放"
        aria-label={`加载并播放 ${lp.title}`}
      >
        {loading ? <IconLoader size={14} className="anim-spin" /> : <IconPlay size={14} />}
      </button>
    </div>
  )
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString()
}

/**
 * Wrong-press toast. Shows when store.lastWrongMidi changes, fades via CSS in 1.5s.
 * Uses key={lastWrongAt} so React unmounts/remounts the element on each press,
 * letting the CSS keyframe play from start to end without a parent re-render storm.
 */
function WrongToast() {
  const lastWrongMidi = useStore((s) => s.lastWrongMidi)
  const lastWrongAt = useStore((s) => s.lastWrongAt)
  const transpose = useStore((s) => s.transpose)
  // Bug #4 fix: no raf/setState. Re-mount the toast on each wrong press via key={lastWrongAt}
  // and let CSS handle the 1.5s fade-out. This keeps the parent FallingNotes/App out
  // of React reconciliation work during the animation.
  if (lastWrongMidi === null) return null
  const midi = lastWrongMidi + transpose
  return (
    <div
      key={lastWrongAt}
      className="anim-wrong-toast absolute bottom-28 left-1/2 -translate-x-1/2 pointer-events-none px-3 py-1.5 rounded-md bg-miss/20 border border-miss/50 text-miss text-sm font-semibold shadow-lg backdrop-blur"
    >
      刚刚按错: {midiToName(midi)}
    </div>
  )
}
