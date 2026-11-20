# piano-follow 前后端代码审计与改造 Spec

> 版本 v1.2 · 审计日期 2026-10-20 · **实施同步至 2026-10-21**
> 审计范围：前端 `src/`（React 18 + Vite + TS）、后端 `scripts/bt_pi/pi/`（Python + systemd）、测试 `tests/`
> 对比基准：`refs/` 五个业界项目（sightread / neothesia / piano-booster / linthesia / musicope）+ 公开行业资料（见 §3.3）
>
> **v1.2 说明**：新增 **P1-19（倍速滑块失效 —— 时钟层改造引入的回归）** 与 **P2-17（WS 桥鉴权顺序 → 未鉴权连接占用上游）**，两者均已修复并配了回归测试。
>
> **v1.1 说明**：P0 全部、P1 全部（含新增的 P1-18）、P2 除 P2-14（暂缓）外**均已落地**。
> 本文档现在的角色是"**已实施 + 待实施**的单一事实源"：
> - 每条缺陷都带 `**状态**` 行，写清改了什么、为什么这么改；
> - §5 的架构方案已按**实际代码**改写（不是草案），落地取舍与草案不一致的地方都标了出来；
> - §8 路线图标注了每个阶段的完成情况与遗留项。
>
> 审计当时的原始基线（红灯、15 文件 / 90 用例）保留在 §2.2 作为**历史记录**，不代表当前状态。

---

## 0. TL;DR

### 0.1 缺陷速览

| # | 级别 | 一句话结论 | 位置 |
|---|------|-----------|------|
| P0-1 | 阻断 | 循环回卷后 UI 播放状态失同步：界面显示"暂停"，音乐仍在响 | `src/engine/Player.ts:406-416` |
| P0-2 | 阻断 | 循环回卷清空评分状态，第二遍循环把同一批音重复计分 | `src/engine/Player.ts:278-279,410` |
| P0-3 | 阻断 | `cancelPreviewNotes()` 丢弃待发 NoteOff → 电钢卡键 | `src/engine/Player.ts:151-155` |
| P0-4 | 阻断 | MIDI Out panic 只发 CC#123，不关延音踏板 → 踩踏板时卡音 | `src/engine/Accompaniment.ts:145-154` |
| P0-5 | 阻断 | 测试基线红：5 个 fixture 路径失效 + 1 处目录名拼写错误 | `tests/parseMxl.test.ts`、`tests/diag_all_downloads.test.ts:7` |
| P1-1 | 严重 | 下落音符渲染只拿到 10Hz 的时间戳 → 每 100ms 跳 28px（肉眼可见卡顿） | `Player.ts:497-499` + `FallingNotes.tsx:88` |
| P1-2 | 严重 | 到达即发声，没有 lookahead 调度 → 主线程抖动直接变成音准抖动 | `Player.ts:39,231,419-430` |
| P1-3 | 严重 | 评分时钟未对齐输出延迟 → 系统性判"早弹" | `Player.ts:315,366,435,464` |
| P1-4 | 严重 | wait 模式 miss 恒为 0，且准确率不含 errors → 成绩系统性虚高 | `PlayAlong.ts:95`、`StatusBar.tsx:28` |
| P1-5 | 严重 | 判定容差固定 500ms，不随速度/音符时长缩放 | `PlayAlong.ts:28-30`、`store.ts:271` |
| P1-6 | 严重 | seek 不重触发跨越跳转点的持续音 | `Player.ts:273-275` |
| P1-7 | 严重 | MIDI 输入丢弃 `e.timeStamp`、无 CC64 踏板、无 running status | `MidiInput.ts:82-105` |
| P1-8 | 严重 | 键盘输入无 blur 处理 → 切窗后卡键、灯常亮 | `KeyboardInput.ts:68-71,99-109` |
| P1-9 | 严重 | LED 命中反馈与文件播放复用同一通道 → 灯常亮 / 误灭 | `Player.ts:349`、`App.tsx:205`、`LedFollower.ts:48-75` |
| P1-10 | 严重 | WS 桥无鉴权且绑 `0.0.0.0` → 同网段任意网页可控制灯带 | `ws_led_bridge.py:22,80` |
| P1-11 | 严重 | 三个 systemd 服务全部以 root 运行 | `led-remote.service:10`、`ws-led-bridge.service:13`、`bt-gpio.service:12` |
| P1-12 | 严重 | MIDI Out 断连后状态栏仍显示绿色"已连接" | `Accompaniment.ts:49-62`、`StatusBar.tsx:80` |
| P1-13 | 严重 | Synthesizer 按 midi 单键管理 voice → 左右手同名音互相打断 | `Synthesizer.ts:28,65-67` |
| P1-14 | 严重 | LED pre-scanner 同样使用 10Hz 量化的 store 时间源 | `App.tsx:468` |
| P1-15 | 一般 | 每帧 O(n) 全表扫描 + 每帧新建 Set/Map | `App.tsx:485-502`、`Player.ts:193-210` |
| P1-16 | 一般 | 节拍器音量从不跟随音量滑块（`setVolume` 无调用点） | `Metronome.ts:15-17` |
| P1-17 | 一般 | `pause()` 停 synth 用 `acc.transpose`，其余路径用 store 的 transpose（双真源） | `Player.ts:254` vs `:429/:460` |
| P1-18 | 严重 | 乐谱音符时值**量纲错误**：`durInQuarter = 秒 × (4/den)` 而非 `秒 ÷ secPerQuarter` → 120bpm 的四分音符被画成 8 分音符，整首谱面变成"短音 + 长休止" | `src/render/StaffView.tsx:244` |
| P1-19 | 严重 | **倍速滑块完全失效**：时钟层改造后歌曲时间改由 AudioContext 推导，但 `SongClock.setSpeed()` 从未被调用 → 选 1/2× / 1/4× 都没反应，音乐永远 1× 播 | `src/engine/Clock.ts:87` + `src/engine/Player.ts`（`stepLoop`） |
| P2-1 ~ P2-17 | 一般 | 见 §4.3 | — |

> **本轮（2026-10-20 续）新增**：P1-18（乐谱时值量纲）、P2-3/P2-15 的 tempo map 落地，并把 P2-10 的冻结点回退补完整。
> **本轮（2026-10-21 续）新增**：**P1-19** —— 时钟层改造引入的回归：倍速滑块失效（`SongClock.setSpeed()` 没有调用点）；**P2-17** —— WS 桥「先开上游 TCP 再鉴权」造成的连接名额 DoS。

### 0.2 一句话总结

> 核心链路（调度 → 发声 → 判定 → 灯光）能跑通，但有 **4 个直接破坏体验的阻断级缺陷**（循环回卷状态机、预览卡键、panic 不彻底、测试基线红）；**时序层缺少 lookahead 调度与输出延迟对齐**，这是"弹得不准"的根因；**后端 WS 桥无鉴权**是唯一的安全缺口。

### 0.3 建议投入

| 阶段 | 内容 | 预估 | 风险 |
|------|------|------|------|
| 阶段 0 | P0-1 ~ P0-5 | 1–2 天 | 低，改动局部 |
| 阶段 1 | 时序层重构（P1-1 ~ P1-6、P1-13、P1-17） | 1–2 周 | **中**，需重写 `Player` 主循环并重跑全部评分测试 |
| 阶段 2 | 输入层（P1-7、P1-8）+ LED 通道分离（P1-9、P1-14） | 3–5 天 | 中 |
| 阶段 3 | 后端加固（P1-10、P1-11） | 2–3 天 | 低，但需在 Pi 上实测 |
| 阶段 4 | 性能与一致性（P1-12、P1-15 ~ P1-17、P2-*） | 1 周 | 低 |
| 阶段 5 | 练习增强（借鉴 sightread / neothesia / piano-booster） | 1–2 周 | 低 |

### 0.4 实施进度（2026-10-20 起，本文档随代码同步更新）

| 阶段 | 状态 | 说明 |
|------|------|------|
| 阶段 0a · 测试基线 | ✅ 完成 | 夹具从 `public/library/_archive/` 迁到 `tests/fixtures/`（5 个文件入库）；`downlaod/` → `downloads/`；`staffview_render` 改为渲染 12 小节 —— 原先整首夜曲在 jsdom 里产出 152MB Buffer，vitest 回传主进程时 `Uint8Array.toJSON` 抛 `RangeError`，整个 suite 以 exit 1 收场 |
| 阶段 0b · P0-1 / P0-2 | ✅ 完成 | `Player` 抽出 `stopSounds()`（停声不动状态机）；`seek(t, {keepPlaying, preserveScore})`；`PlayAlong.resetPass()` |
| 阶段 0c · P0-3 / P0-4 | ✅ 完成 | `Player.releasePreviewNotes()` 记账 + 补发 NoteOff + 还原 transpose；`Accompaniment` 引入 `activeNotes` / `sentAnyNote` / `panning`，`panic()` 改为 CC#120 + CC#64=0 + CC#121 + 显式 NoteOff，新增 `silence()` 供暂停使用 |
| 阶段 1a · P1-13 / P1-17 | ✅ 完成 | `Synthesizer` voice 键从 `midi` 改为 `(midi, voiceId)` —— 同名音左右手不再互相打断；`Player` 停 synth 统一用 store 的 `transpose`（双真源消除） |
| 阶段 1b · P1-6 | ✅ 完成 | `Player.seek()` 补跨界持续音（`announceNotes()`）—— seek 到一个正在响的音之前，该音会被永久卡住；现在会补发 NoteOn 并正常收尾 |
| 阶段 1c · P1-4 / P1-5 | ✅ 完成 | 新增 `src/engine/Scoring.ts`；准确率含 `errors`；判定窗口按 bpm 缩放，默认值对齐 sightread |
| 阶段 1d · P1-1 / P1-14 | ✅ 完成 | 渲染层改读 `player.getCurrentTime()`（新增 `src/render/timeSource.ts`）—— 下落音符不再每 100ms 跳 28px，LED 预扫描也不再被 10Hz 量化 |
| 阶段 1e · P1-12 | ✅ 完成 | MIDI Out 连接状态拆分：`midiOutputId`（用户选择）+ `midiOutputConnected`（运行时）；顺手修掉 `onDisconnect` 重复触发（会弹两次重连弹窗） |
| 阶段 1f · P1-2 / P1-3 | ✅ 完成 | 新增 `src/engine/Clock.ts`（三套时间域对齐）+ `src/engine/Scheduler.ts`（lookahead 排程游标）+ `tests/fakeClock.ts`（可控 AudioContext 夹具）。歌曲时间锚在 AudioContext 上不再累加，判定改用**硬件时间戳**换算；lookahead 120ms 提前排程，`when` 精确落在 `note.time` |
| 阶段 2 · P1-7 / P1-8 / P1-9 / P1-14 | ✅ 完成 | MIDI 输入保留 `e.timeStamp` + running status + CC64 踏板；键盘输入补 blur 释放；LED 命中反馈拆成独立 `hit` 通道（`NoteSource` 增加 `'hit'`），多源 pressed 互不熄灭 |
| 阶段 3 · P1-10 / P1-11 | ✅ 完成 | WS 桥加共享 token + Origin 白名单 + 连接数上限 + 令牌桶限流 + 消息大小上限；三个 systemd 服务降权（`pi` + capability）；新增 `scripts/bt_pi/tests/test_security.py`（15 用例） |
| 阶段 4 · P1-15 / P1-16 + P2-1~P2-16 | ✅ 完成 | 逐帧全表扫描改成游标（`LedScanCursor` + `Scheduler` + `PlayAlong.requiredIdx`）；节拍器音量接上滑块；P2 清单见 §4.3 |
| 阶段 4b · P1-18 / P2-3 / P2-15 / P2-10 收尾 | ✅ 完成 | 新增 `src/util/tempoMap.ts`（连续拍网格 + tempo 分段）；小节线、节拍器、节拍点、乐谱时值全部改走 tempo map；节拍器拍点按精确 ctx 时刻排程；冻结点回退到"卡住用户的那个 note 的精确时间"，回退过多时改为 rebase 判定基准 |
| 阶段 4c · P1-19 / P2-17 + 时钟加固 | ✅ 完成 | 倍速同步进歌曲时钟（`SongClock.setSpeed()` 三处接入：构造 / 起播 / 每帧）；ctx 挂起/恢复后强制重采样 perf↔ctx 偏移（否则恢复后 250ms 内的按键判定凭空偏 200ms）；WS 桥改成**先鉴权、后开上游 TCP**，并加鉴权超时 |
| 阶段 4d · 用户实测回归（R1~R4） | ✅ 完成 | LED 强制等待（新开关 `ledForceWait`，默认 ON —— **2026-11-05 已删**, 见 §4.4 R23）+ 第一个音追踪（预览窗内短音不再被判 miss）+ 方向键导航修复（playback 分支 / 单轨曲手别歧义）；见 §4.4 |
| 阶段 4e · 用户实测回归 R5 | ✅ 完成 | 双手跟弹左手灯「闪一下就灭」（BWV 846）—— `LedFollower` 三处记账缺陷：命中脉冲误灭还在响的灯 / 同源同 midi 记布尔而非计数 / pendingOff 不看脉冲；见 §4.4 R5 |
| 阶段 4f · 用户实测回归 R6（灯光残留 + 右手混乱） | ✅ 完成 | BWV 846 + 提前量 +4 下 6 条缺陷：提前量把灭灯也平移 / 同 midi 多 note 误灭 / 切歌没清 follower / 重播游标不复位 / 停播时 pre-scanner 的灯没出口 / 退位 note 重复灭灯；新增「谱 vs 灯」对照工具；见 §4.4 R6 |
| 阶段 4g · 用户实测回归 R7（换回树莓派没自动连接） | ✅ 完成 | 根因是 `AutoTransport` 的「自动挑后端」语义：ESP32 离线时 Chrome 的 `gatt.connect()` 永不 settle → 树莓派分支走不到、且不报错不重试。改成**用户自选**（💡 浮窗里「灯带后端」两段式切换，记住选择），删掉 `'auto'`；BLE/WS 建连各加超时（8s / 10s）；见 §4.4 R7 |
| 阶段 4h · 用户实测回归 R8（前端报 rpc init timeout） | ✅ 完成 | 真凶是 `led_remote` 踢人时 `shutdown(SHUT_RDWR)+close()` **把旧 client 的在途回包一起销毁**，加上前端的 3s 重试形成正反馈环；改成只关读方向（回包保住）；顺带修桥漏关上游 TCP、`accept()` 出错静默退出（systemd 不重启）、前端握手超时 1s→5s；见 §4.4 R8 |
| 阶段 4i · 合并远程「用户系统 + 私有谱子库」 | ✅ 完成 | 远程 5 个提交（`src/auth.ts` / `scripts/server/*` / `AuthModal` / Library「我的」tab / 顶栏整理 / 状态框固定名称）合进本地 LED 大分支；冲突 2 处（`LedDock.tsx` / `StatusBar.tsx`）—— LedDock 取远程的 inline/floating 两种摆法 + 本地的连接状态动态 title；StatusBar 取远程的固定标签（电钢 / MIDI），**LED 标签保留本地动态版**（「待配对」只有这儿露得出来）；见 §4.4 R9 |
| 阶段 4j · 双色带模式（上灯带显示下一个音） | ✅ 完成 | 两条灯带串联 352 颗，**第二条反着接**（接缝在右）→ 补偿换算让两条带物理位置对齐；上灯带显示左右手各自的「下一个音」（`NextNoteIndex` 无状态二分，暂停/offset=0 也能显示）；上灯带亮度 = 主灯带 × 比例（默认 70%，次级菜单可调）；Pi 侧 count 白名单加 352、换灯数先释放旧 strip（不撞 DMA 通道 10）+ 缩灯前刷黑（不留幽灵灯）；ESP32 固件固定 176 → 双色带仅树莓派（**当晚已解除**，见阶段 4m）；见 §4.4 R10 |
| 阶段 4m · ESP32 固件也支持双色带（352 颗）+ 时序修复 + 30 颗功耗上限 | ✅ 完成 | ① **时序**：标定从「两点求斜率 + 外推截距」（整数截断 → 迭代数全 0 → 完全没有延时）改成「固定开销/斜率直接量 + 高电平/周期双闭环」；线上 bit 周期 354 → **299/299 cycles**，T0H 136 → **94**，T1H 254 → **194**，全部回到 WS2811 规格内；跑马灯 715 → **522 ms**；② **功耗上限**写死 `LED_MAX_LIT = 30`（176 颗全亮 = 10.5 A，曾把 USB 拉垮）；③ **灯数运行期可配**：`led.init` 白名单 (176, 352)，换灯数重建缓冲 → ESP32 也支持双色带；见 §4.4 R12 / R13 |
| 阶段 4k · Pi 侧看门狗（pinmux 挪出关键路径 + DMA 挂死能被 systemd 拉起） | ✅ 完成 | ① `ensure_pinmux()` 原来每 20 次 `show` 就在**持锁**路径上 fork 一次 `pinctrl`（10~50ms 全局停顿）→ 挪到后台线程（`PinmuxWatchdog`，3 秒一次）；② `ws2811_wait()` 是**无限等待**且 SWIG 绑定不释放 GIL → DMA 一挂整个进程冻住、进程内救不回来 → 加 `sd_notify` 心跳（主线程发，5 秒一次）+ systemd `WatchdogSec=20s` / `NotifyAccess=main`，20 秒没心跳就 SIGABRT + `Restart=on-failure` 拉起；真机用假 `rpi_ws281x`（`ctypes.PyDLL` 不释放 GIL）复刻冻死，实测 `Watchdog timeout → SIGABRT → 自动拉起`；见 §4.4 R11 |
| 阶段 4n · 灯带语义重订 + 判定统一到「落键那一刻」 | ✅ 完成 | 灯 = 画面上那条音条（提前量只做**渐亮**提示，弹过减半，音条消失即灭 —— 灭灯跟**渲染共用** `NOTE_BAR_LIFETIME_S`）；删掉「推迟灭灯」机制（弹错残留的根因）；播放层 LED 统一由 pre-scanner 独占（提前量为 0 时也不再走 Player 直发）；判定基准永远是 `note.time`（删 `PlayAlong.rebaseNote`），提前量只当「提前按」的容差窗口（**该窗口 2026-11-05 恒为 0** ——「提前按」独立模式已删, 见 §4.4 R23）；见 §4.4 R14 / R15 |
| 阶段 4o · 曲终清空灯带 + 跑马灯后不再回亮 | ✅ 完成 | 暂停时的「当前键位预览」在曲终时不再点亮（新增 `songEnded()`）；跑马灯跑完立刻 `follower.clearAll()`，resume 不会按旧状态把灯重新点亮；见 §4.4 R16 |
| 阶段 4p · 虚拟键盘音名标号 + 「等你弹」的键上色 | ✅ 完成 | 新增 `src/render/keyLabels.ts`（`labelForMidi` / 黑白键字号）；`store.keyLabels` = 不标 / 只标C / 全标（**默认全标**），设置抽屉里三段按钮；冻结等待时目标键染琥珀色（移调后染 transposed 的那个键）；见 §4.4 R17 |
| 阶段 4q · 「梦中的婚礼」曲库文件修复 | ✅ 完成 | 旧文件（GBK 曲名 → 顶栏乱码「ÃÎÖÐµÄ»éÀñ」+ 31 个乱拍号 + 标成 Mendelssohn/C major）→ 新文件 `pop/mariage-d-amour.mid`（曲名 ASCII、单个 4/4、72 BPM、Bb 调号，**音符数据零改动**：1162 音 / 180.7s）；清单改成 Mariage d'amour / Senneville-Toussaint / G minor；见 §4.4 R18 |
| 阶段 4r · 双色带物理接线：第二条带整条刷白（≈10 A） | ✅ 完成 | 服务端把「灯数」拆成**物理帧长**（永远 = 物理链长度，352）与**逻辑可寻址长度**（客户端 init 来的）—— WS2812 串联，帧比物理链短 → 后一条带收不到数据 → 移位寄存器被空闲高电平填满 → 整条全白；顺带根治「换 count 重建 strip 撞 DMA 通道 10」；`off` 清整条物理链；见 §4.4 R19 |
| 阶段 4s · 第二条灯带的清除不干净（残留） | ✅ 完成 | 上灯带**没有状态机** —— `applyUpper()` 每 50ms 按 `upperHints` 无条件重算，清灯刚灭掉下一轮又被点回来（主灯带有 `LedFollower` 的 `clearAll` 状态，清完就是清完）；修法：补 `upperArmed`（熄着期间提示**内容不变**就不许自己回来）+ `upperHold`（跑马灯这类独占动画期间硬让路）；**熄着只发生在「清完就该黑」的两处**（跑马灯跑完 / 曲终 `clearUpperHints`）—— `allOff()` 只是物理清零，不能熄（否则加载新歌/恢复播放后第二条带再也不亮）；`testPattern` 的裸 `rpc('off')` 换成 `allOff()`；见 §4.4 R20 |
| 阶段 4t · 第一排只亮「当前这一组」+ 第二排显示接下来 N 个 | ✅ 完成 | ① **第一排语义重订**：开灯 = `note.time`，灭灯 = **下一组开始**（= 同一时刻的所有 note 算一组）→ 任何时刻最多只有**一组**灯亮着（用户报的「同时亮好几个音」）；跟弹卡住时时间冻在要弹的音上 → 那盏灯一直亮着（不用额外处理）；② **提前量解耦**：App 固定传 `offsetMs = 0`，渐亮代码留着但不用了，`store.ledOffsetUnits` 只剩「提前按算不算数」的判定窗口（**2026-11-05 该模式已删, 提前量彻底不生效**），滑块 `LedOffsetControl` 删除；③ **第二排**：每只手各 N 个（N 可设 2..6，**放在首页 💡 浮窗**），亮度每往后一个 **×0.65**；④ `LedFollower` 的 60ms 灭灯 grace 只留给**输入源** —— 播放源立即灭（否则下一组亮起时两组灯重叠 60ms）；见 §4.4 R21 |
| 阶段 4u · 「梦中的婚礼」变拍还原（R18 拍错了） | ✅ 完成 | R18 把 track 0 里 **31 个真拍号**当成乱码拍平成单个 4/4 → 小节线错位（真值 **44 小节**被算成 55）；另查出 **4 个坏音符**（2 个 onset 偏 16 分网格 +23 tick 且倒序写入、2 个 D7(98) 是全曲唯一超 C7 的音）→ 新脚本 `scripts/fix_mariage_midi.mjs` 从原始下载件**重建**曲库文件（32 拍号 / 72 BPM / EOT 补齐 / 1160 音）；App 侧补**变拍支持**（`computeMeasuresFromSignatures` 在 tick 空间切小节、`StaffView` 每小节用自己的拍号、**节拍器拍点按小节拍号切**）；见 §4.4 R22 |
| 阶段 4v · 抢先模式：弹对了才推进 + 冻在「现在该弹的那一组」上 | ✅ 完成 | 跟弹控制条 Wait 后面加「抢先」勾选框（**依赖 Wait**，关掉就变灰）；**2026-11-05 首版**：灯带比瀑布领先一个音 + 弹对后播放头直接跳；**2026-11-08 重订**：灯带显示「**现在该弹的那一组**」+ 每只手一个游标 + 提前按**不报错** + 灯一直亮到弹对（不超时、不记漏弹）+ 判定**不受容差**影响（绕开 `PlayAlong.recent`）；**2026-11-10 再修订**（用户实测：「完全不会停下来对的音」）：**把冻结找回来** —— 播放头冻在待弹组的精确谱面时间上，弹对了才解冻、按 1× 走到下一个待弹组再冻上（倍率恒为 1，加速那套删掉）；顺带修：开模式时 `resetPass()`（幽灵漏弹）+ 切手别重置游标 + 提示灯走独立 `'lead'` 通道（不被「跟随乐谱」挡、不被当成玩家按键）+ 灯带按 **(midi, 手)** 记账（同键两手互不误伤）；见 §4.4 R23 |
| 阶段 4w · BWV 1041 钢琴独奏版重做（用户：「不好听 没有美感」） | ✅ 完成 | v1 把伴奏量化到均拍网格再套通用和弦模板 → 空壳和弦 46/294、平行八度/五度 75/256、力度恒定 72；v2 改用**原始 6 声部 MIDI**：右手逐字节不动，左手只用原谱的音（大提琴走路低音 + 中提琴，八度折叠），和弦由原谱实际响过的音推出；加「按调号拼写」过滤（这首曲子只用升号）+「和弦音不许跟旋律平行五度/八度」禁音表 → 撞小二度 0、平行 0；见 §4.4 R24 |
| 阶段 4x · ESP32 走 WiFi：跟树莓派**同一个协议**，前端一行不用改 | ✅ 完成 | ESP32 新固件自带 WebSocket server（端口 8080），协议跟树莓派那座桥（`led_remote.py`）**逐字段一样** → 前端后端选项从「树莓派 / ESP32」改成「**WiFi**（树莓派 + ESP32 共用）/ 蓝牙（旧固件备用）」；「设备地址」填谁的 IP 就连谁；地址 / 令牌 / 配对控件从设置抽屉挪进共享的 `<LedSettings />`（右上 💡 浮窗也能改）；状态文字统一走 `ledBackendLabel()`（`WiFi · <地址>`）；HTTPS 部署只需改服务端 `LED_WS_TARGET=ws://<esp32-ip>:8080`；**Pi 侧代码一行没动**；见 §4.4 R25 |
| 阶段 4y · 前台不熄屏（Screen Wake Lock） | ✅ 完成 | 练琴时人离得远，屏幕一黑就看不见瀑布和灯带提示 → 新增 `src/util/wakeLock.ts`（`navigator.wakeLock.request('screen')`），`App.tsx` 挂一次；浏览器切后台会自动释放锁 → `visibilitychange` 里重新申请；不支持 / 被拒 → 什么都不发生；见 §4.4 R26 |
| 阶段 4z · 四条 UI 改动（容差 2000ms / 音量右下角竖面板 / 去掉「手别」/ 速度 1.25×） | ✅ 完成 | ① 容差上限 500 → **2000ms**（`store.setToleranceMsPersistent` + `ToleranceInput`）；② 音量从顶部练习条挪到**右下角可收起的竖向面板**（新 `src/ui/VolumePanel.tsx`，横滑块整体转 -90° 竖着放，点圆按钮才展开）；③ 模式选择器去掉前面的「手别」两个字 + 「钢琴播放」→「播放」；④ 速度多一档 **1.25×**；见 §4.4 R27 |
| 阶段 4aa · 前端配置绑定账号（本地一份 + 账号一份） | ✅ 完成 | 每个前端配置（含树莓派 IP、令牌、灯带后端、亮度…）存两处：localStorage（本地那份）+ 服务器 `user_prefs` 表（账号那份）；**没登录 → 只存本地**（零请求）；**登录 → 两边都改**（改完 debounce 400ms 推一次）；**登录那一刻 → 拉账号那份**（账号那份优先于本地）落回 UI 状态，再把合并结果推回服务器；新接口 `GET/PUT /api/prefs`（需登录）；见 §4.4 R28 |
| 阶段 4ab · ESP32 ↔ 树莓派 一致性审查 + 前端**设备选择器**（蓝牙整条路删掉） | ✅ 完成 | 两台设备现在**都是 WebSocket**（协议一样，端口都是 8080）→ 前端从「WiFi / 蓝牙」二选一改成「**树莓派 / ESP32**」选哪台；**蓝牙那条路整个删掉**（`BleTransport` / `bleDevice` / `webBluetooth` / `BackendTransport` / `IconBluetooth` 全删）；服务端反代按设备路由（`/led-proxy/pi` + `/led-proxy/esp32`，两个环境变量）；审查出 11 条差异（L1–L11），修掉 3 条真 bug（反代只有一个目标 / 树莓派 `set_many` 非原子 / 固件 `WS_MSG_MAX` 太小），其余记录；见 §4.4 R29 |
| 阶段 4ac · ESP32 **固件源码**审查（marquee 越界 / 回包截断 / 重连阻塞 / 默认地址） | ✅ 完成（源码改了，**没刷机**） | 审出 5 条：F1 **marquee 窗口越界 → 死循环 → 板子变砖**（颜色数组 64 字节，window 客户端给的却只裁到 176；已在宿主机上复现）→ 加 `MARQUEE_WINDOW_MAX=64` + 超限回 `window too large`；F2 `piReply()` 的 `fields[384]` 截断 → 回包成非法 JSON → 三个缓冲一起放大；F3 默认地址写成了静态兜底 `.120` → 改回 DHCP 的 `.108`（前端 + 反代 + systemd 三处）；F4 重连同步 `delay()` 10~20 秒 → `wsLedLoop()` 跟着停摆 → 改成非阻塞轮询；F5 `led.ping` 认不出来 → 两个都认；见 §4.4 R30 |
| 阶段 4ad · 灯带**驱动层**审查 + 前端帧时间算错 | ✅ 完成（固件源码改了，**没刷机**） | 审出 6 条：D1 **GPIO 寄存器按经典 ESP32 排布算地址**（S3 上 pin≥32 时置位落到 `out_w1tc`、清位落到 `out1`）→ 改成按 bank 取 `out_w1ts`/`out1_w1ts`；D2 标定差值用**无符号**减法 → 倒挂时回绕成 ~4×10⁹ → 一帧发不完（看起来像卡死）→ 改 `int32_t` + 为负退化 0；D3 **RMT 一个 symbol 是 1 个 bit 不是 2 个** → 缓冲按 12 symbol/颗 分配却要写 24 → **堆越界写 ~16.9KB** → 改 24；D4 transmit 失败 / wait 超时后**不复位通道** → 之后每帧都失败（灯带永久卡死）+ encoder 还在读旧缓冲（花屏）→ 加 `resetChannel()`；D5 **前端帧时间按逻辑 count (176 → 5.28ms) 算**，但两台设备推帧都按**物理** 352 颗（10.56ms）→ 步长取 2 而不是 4 → 「0.5 秒」按钮实际跑 **0.93 秒** → 新增 `LED_PHYSICAL_COUNT=352`；D6 固件注释 / README / 4 个 skill 文件里的「5.3ms / 4224 bit / 88 帧」全部改写；见 §4.4 R31 |
| 阶段 5 | ⏳ 未开始 | 见 §8 路线图（练习增强：skipMissedNotes / 自适应速度 / ahead-behind 提示） |

**当前基线**：`npx vitest run` → **62 文件 / 662 用例（661 通过 + 1 跳过）/ 0 Errors**（2026-11-11：**R31 灯带驱动层审查 + 前端帧时间** —— 修掉一条**用户可见**的算错：前端按**逻辑**灯数 (176) 算帧时间 (5.28ms)，但两台设备推帧都按**物理** 352 颗 (10.56ms) → 「0.5 秒」的跑马灯测试按钮实际跑 **0.93 秒**；新增 `LED_PHYSICAL_COUNT = 352`，帧时间只按物理数算（176→step 4 / 352→step 8，都是 44 帧）；固件侧同批修 4 条：S3 的 GPIO 寄存器按 bank 取（老写法 pin≥32 时置位落到 `out_w1tc`）/ 标定差值改有符号（倒挂时原来会回绕成 ~4×10⁹ → 一帧发不完）/ RMT 一个 symbol 是 1 个 bit 不是 2 个（老缓冲按 12 symbol/颗 分配 → 352 颗时**堆越界写 ~16.9KB**）/ transmit 失败后复位通道（不然之后每帧都失败）；固件两个驱动文件用 **IDF v5.5 真头文件抄的桩头**做了 `g++ -fsyntax-only` → EXIT=0（桩头比对时才发现 `rmt_channel_reset()` 在 v5.5 里**根本不存在**，照记忆写编不过）；固件源码改了但**没刷机**；2026-11-11：**R30 ESP32 固件源码审查** —— 修掉一条**能把板子打成砖**的 marquee 窗口越界（`window` 客户端给的，颜色数组只有 64 字节；已在宿主机上复现出死循环）+ `piReply()` 回包截断成非法 JSON + 默认地址写错（静态兜底 `.120` → DHCP 的 `.108`，前端 / 反代 / systemd 三处）+ 重连同步 `delay()` 拖死 `wsLedLoop()`（改非阻塞）+ `led.ping`；新增 `tests/led_testpattern.test.ts` 2 例（窗口上限）；`tests/helpers/esp32Model.ts` 的 `marquee` 跟着固件回 `window too large`；**固件源码改了但没刷机**（本机没装 platformio）；2026-11-10：**R29 ESP32 ↔ 树莓派 一致性 + 设备选择器** —— 删掉两条 BLE 路的测试文件（`led_ble_reliability` / `led_dual_strip_ble`）+ 两个 python e2e；`tests/helpers/esp32Model.ts` 从 BLE 形状改成 **WS 形状**（树莓派回包形状）；`tests/led_esp32_pi_parity.test.ts` 重写为 `WsTransport` 上的 **14 例**；`led_stuck` / `led_resync` / `led_testpattern` / `led_transport` 改走 WS；`led_backend_choice` 改成设备选择器 8 例）；2026-11-10：R23 抢先模式**再修订**（把冻结找回来）—— `tests/lead_mode.test.ts` 重写为 34 例（冻在待弹组的精确时间 / 弹对才解冻 / 不弹就一直冻着 / 倍率恒为 1 / 双手各冻各的 / 单手伴奏 1× 原速）+ `tests/led_shared_key.test.ts` +2 例（灯带按 (midi, 手) 记账 —— 一只手松手 / 被关掉不误伤另一只手）；2026-11-08：改名 Piayes + 去掉公开的默认管理员口令 —— 新增 `tests/prefs_sync.test.ts` 老 key 兼容 1 例 + `tests/server.admin.test.mjs` 随机口令 1 例）（2026-11-08：R28 配置绑定账号 —— 新增 `tests/server.prefs.test.mjs` 6 例 + `tests/prefs_sync.test.ts` 6 例；2026-11-08：R23 抢先模式**重订** —— `tests/lead_mode.test.ts` 重写为 32 例（提示按手拆开 / 弹对才推进 / 不报错 / 不受容差影响 / 上一轮弹过的键不被检索 / 双手平滑加速封顶 2× / 单手伴奏 1× 原速）+ `tests/lead_strip.test.ts` 重写为 9 例（提示按 (midi, 手) 差分）；2026-11-06：R27 四条 UI 改动 —— 新增 `tests/practice_ui.test.ts` 4 例 + `tests/playAlong.test.ts` 4 例（容差口径）；2026-11-06：R25 ESP32 走 WiFi —— `tests/led_backend_choice.test.ts` 选项名改为「WiFi / 蓝牙」（7 例）；2026-11-05：R23 抢先模式修订 —— 单手路径（伴奏 1× 原速 + 游标推进）新增 9 例 + 删掉「提前按」模式（`tests/led_early_press.test.ts` + `tests/led_force_wait.test.ts`）；2026-11-05：R24 BWV 1041 钢琴独奏 v2 —— `tests/bwv1041_piano_v2.test.mjs` 17 例；2026-11-05：R23 抢先模式 —— `tests/lead_mode.test.ts` 14 例 + `tests/lead_strip.test.ts` 7 例 + `tests/lead_toggle_ui.test.ts` 5 例；2026-11-01：R22「梦中的婚礼」变拍还原 —— `tests/library_mariage.test.ts` 重写为 12 例，同期 `docs/audit-2026-11-01.md` 的后端加固等改动一并计入；2026-10-31：R21 第一排「只亮当前这一组」+ 第二排 N 个 → 424（scanCursor +4 / dual_strip +4 / dual_strip_ui +5 / follower +1 / 谱 vs 灯 +1）；2026-10-31：R20 上灯带残留修复新增 5 例 → 409；2026-10-30：39/368 + `tests/key_labels.test.ts` 22 例 + `tests/library_mariage.test.ts` 6 例 + 其余文件补的用例）；`npx tsc -b --force` EXIT=0；`npm run build` PASS；
`python scripts/bt_pi/tests/test_security.py` → 18 OK；`python scripts/bt_pi/tests/test_protocol.py` → 13 OK；
`python scripts/bt_pi/tests/test_led_reliability.py` → **19 OK**（原 3 例：踢人保回包 / 上游 TCP 必关 / accept 出错退非 0；+6 例：init count 白名单 176/352/999 + 换灯数时释放旧 strip / 缩灯前刷黑 / 同灯数不重建（**2026-10-30 语义已改，见 R19**：换 count 不再重建，改成「物理帧长固定 = 物理链长度」，共 7 例）；+6 例：show 路径不 fork pinctrl / render 卡死可识别 / render 标记会清 / sd_notify 真发 datagram / 无 systemd 时是 no-op / pinmux 看门狗按间隔跑）。

**判定窗口口径变更（P1-5，最终口径）**

| | 旧 | 新 |
|---|---|---|
| 命中窗口 | 固定 500ms | `min(toleranceMs, clamp(一拍×50%, 150, 300))` —— 60bpm 300 / 120bpm 250 / 150bpm 200 |
| perfect | 固定 35ms | `clamp(hit×20%, 20, 50)` —— 120bpm 下 50ms（同 sightread `PERFECT_RANGE`） |
| good | 固定 100ms | `clamp(hit×50%, 40, 150)` —— 120bpm 下 125ms |
| `toleranceMs` | 500ms，语义 = 命中窗口 | 300ms，语义 = **窗口上限**（范围 100–500） |

> ★ **2026-11-06 修订（R27）**：上表里「窗口上限」这个语义**没法让容差真的变宽** —— 上限再大，实际窗口仍被 `clamp(一拍×50%, 150, 300)` 夹在 300ms 以内（用户调到 300 以上等于没调）。用户明确要求「容差最高能到 2000ms」（慢练 / 跟着耳钢琴时 500ms 太紧），所以口径改成**两种**：
>
> | 用户填过容差吗 | 命中窗口 |
> |---|---|---|
> | 没填过（默认 300） | `min(toleranceMs, clamp(一拍×50%, 150, 300))` —— 曲速缩放（规格 P1-5 不变） |
> | 填过（`store.toleranceCustom`） | **就是填的那个数**（100–2000ms），不再被曲速夹住 |
>
> 默认行为**一个字没变**（默认 300 → 仍然 120bpm 下 250ms）；只有用户主动填了数，口径才切到「填的数直接生效」。

> 取舍：sightread 用的是**固定** 300ms（`refs/sightread/src/features/player/player.ts:15-16`）。本项目不照搬「固定绝对值」的坑（慢板宽到随便弹都算准），改成按速度缩放，并把默认值对齐到 sightread 的 300ms —— 这样 P1-3（输出延迟对齐）落地前，用户按电钢的系统性延迟还有 ~250ms 的余量。
> 音符时长**不参与**窗口计算 —— 短音由「150ms 窗口下限」+「fileNoteOff 之后的 grace」共同兜住；sightread / neothesia 同样只看时间差。

**已补的回归测试（累计 27 文件 / 256 用例）**

| 用例 | 文件 | 断言 |
|------|------|------|
| 回卷保持播放态 | `tests/player.test.ts` | 回卷后 `isPlaying === true` |
| 回卷保留评分 | `tests/player.test.ts` | 回卷后 `hits` 不重复累加，`getNoteStates()` 仍为 `hit` |
| 回卷保留统计 | `tests/player.test.ts` | 回卷后 `playAlong.stats.miss` 不被清零 |
| 普通 seek 仍清分 | `tests/player.test.ts` | 不带 `preserveScore` 的 `seek()` 行为不变 |
| 跨界音 seek 后补发 | `tests/player.test.ts` | seek 跨界后该音进入 `playingNotes`、补发 NoteOn、正常收尾 |
| 同名音两声部 | `tests/player.test.ts` / `tests/synthesizer.test.ts` | 左右手同一 midi 各一个 voice，互不打断 |
| 预览取消释放 | `tests/midi_out.test.ts` | `previewNotes()` → `pause()` → 收到配对 NoteOff，且 `acc.transpose` 被还原、NoteOff 与 NoteOn 同音高 |
| panic 彻底性 | `tests/midi_out.test.ts` | 收到 `CC#120` × 16、`CC#64=0` × 16、每个 activeNote 的显式 NoteOff |
| panic 递归保护 | `tests/midi_out.test.ts` | `send` 抛错时 `panic()` 有限次退出并回调 `onDisconnect` |
| 断连只报一次 | `tests/midi_out.test.ts` | `onDisconnect` 只触发 1 次（旧实现会弹两次重连弹窗） |
| `use(null)` 也 panic | `tests/midi_out.test.ts` | 关掉伴奏时旧设备收到 `CC#120` |
| 暂停时电钢安静 | `tests/midi_out.test.ts` | `pause()` 发 `CC#120`；`both` 模式不发；循环回卷不发 |
| 准确率含 error | `tests/scoring.test.ts` | `accuracyPercent(10, 2, 3) === 67`（旧实现算 83，虚高 16 个点） |
| 窗口随速度缩放 | `tests/scoring.test.ts` | 60/120/150bpm → 300/250/200ms，且单调性 |
| 渲染时间源 | `tests/render_time.test.ts` | 优先用 `player.getCurrentTime()`，缺失/非法值回退 store |
| 歌曲时钟锚音频时钟 | `tests/clock.test.ts` | ctx 跟随 / 挂起退化 / anchor / 变速连续 / 硬件时间戳判定 / 无效时间戳 / 延迟补偿 / 无 ctx 退化（8 例） |
| lookahead 精确落点 | `tests/lookahead.test.ts` | 提前排程且 `when` 精确落在 `note.time`；主线程卡 100ms 不改 `when`；灯按精确时间亮；wait 模式不开 lookahead（7 例） |
| LED 预扫描游标 | `tests/scanCursor.test.ts` | 事件排序（灭灯不随下标单调）/ offset 只提前开灯 / 负 offset 整段平移 / reset 重走 / 游标单调 / **只亮当前这一组**（连着落的音 → 上一组在下一组开始时就灭 / 同一时刻的多个音一起亮一起灭 / 长休止 0.5s 就灭）（17 例） |
| tempo map | `tests/tempoMap.test.ts` | 拍网格跨变速连续；`computeMeasures` 小节线跟随变速；6/8 拍号；非法 bpms 退化（10 例，含 P1-18 回归） |
| 乐谱时值量纲（P1-18） | `tests/tempoMap.test.ts` | `durInQuarter === 音符秒数 ÷ 该时刻 secPerQuarter`；小节被音符填满时不再补长休止 |
| 冻结点回退（P2-10） | `tests/player.test.ts` / `tests/repro_chopin.test.ts` | 第一个 note 在 t=0 也给满 0.5s 预览才冻；冻结后 `ct` 停在 note 精确时间；冻结时左手伴奏立刻静音 |
| MIDI 输入时序 | `tests/input.test.ts` | 保留 `e.timeStamp` / running status / CC64 / 键盘 blur 释放（14 例） |
| LED 多源 pressed | `tests/led_follower.test.ts` | input 与 playback 同时按住 → 都松开才灭灯；hit 脉冲独立通道；**播放源不等 off-grace、输入源等**（15 例） |
| 谱 vs 灯对照 | `tests/led_score_vs_lights.test.ts` | 每个 note 发声时灯必须亮 / 灭灯落在这一组结束之后 / 同 midi 深度不为负 / 无残留 / **任何时刻最多只有一组音亮着**（6 例） |
| 停播强制清灯 | `tests/led_switch_clear.test.ts` | `flush`/`reset(emit)`/`seekTo` + BWV 846 暂停（全按 / 全没按 / offset=0）与切歌端到端（11 例） |
| WS 桥安全 | `scripts/bt_pi/tests/test_security.py` | token 校验 / Origin 白名单 / 连接数上限 / 令牌桶限流 / 消息大小上限（15 例） |
| 灯带链路可靠性（R8） | `scripts/bt_pi/tests/test_led_reliability.py` | 踢人不销毁在途回包 / 上游 TCP 必被关掉 / `accept()` 出错退非 0（3 例） |
| WS 握手超时（R8） | `tests/led_transport.test.ts` | 握手 5 秒才超时（1 秒不误报）/ 运行时命令仍 1 秒（2 例） |
| 双色带索引 + 下一个音（R10 / R21） | `tests/led_dual_strip.test.ts` | 补偿换算（A0→上带 350/351，C8→176/177）/ 88 键一一对应 / NextNoteIndex 严格晚于当前时刻 + seek 不错 / **每只手各 N 个** / **level 让颜色变暗 + 同 midi 取更亮的** / 单轨谱按音高兜底 / 上灯带增量下发 / 比例重画 / **allOff 后自愈回来 / 切歌顺序 / 跑马灯后不残留**（R20）/ 单灯带不写像素（28 例） |
| 双色带 UI（R10 / R21） | `tests/led_dual_strip_ui.test.ts` | 💡 浮窗 + ⚙ 抽屉两处都有「灯带模式」切换 / 「上灯带亮度」滑块只在双色带时出现 / **「上灯带显示 N 个/手」2..6 档 + 落库 + 越界夹取** / 比例默认 70% 且落库（18 例） |
| Pi 侧换灯数（R10 → R19 语义已改） | `scripts/bt_pi/tests/test_led_reliability.py` | init 放行 176/352、拒 999 / **物理帧长固定 = 物理链长度**（逻辑 count 176 时 strip 也是 352 颗）/ 换 count 不重建 strip（不撞 DMA）/ 逻辑缩小刷黑超范围 / `off` 清整条物理链 / 越界写被拒 / `show` 推满 352 颗的帧（7 例） |
| Pi 侧看门狗（R11） | `scripts/bt_pi/tests/test_led_reliability.py` | show 路径 50 次不 fork `pinctrl` / render 超宽限期才判卡死 / render 标记正常会清 / `sd_notify` 真发 unix datagram / 没 systemd 时是 no-op / pinmux 看门狗按间隔跑（6 例） |
| BWV 1041 钢琴独奏 v2（R24） | `tests/bwv1041_piano_v2.test.mjs` | 右手轨逐字节不动（3 版）/ 原版 Solo Violin 逐音不变 / 左手不撞小二度 / **和弦音 0 平行五度·八度** / 大提琴版平行关系跟原谱一样 / 左手只用原谱的音 / 和弦版不编造音级 / 每小节和弦 ≤ 6（17 例） |

> **回归有效性已验证**：把 `src/engine/{Player,PlayAlong,Accompaniment}.ts` 临时回退到 `main` 后，P0-1/P0-2 的 3 个用例与 P0-3/P0-4 的 5 个用例全部失败；恢复后全绿。测试不是"写出来好看"，是真的能抓到 bug。

---

## 1. 背景与系统拓扑

### 1.1 数据流

```
┌──────────────────────── 浏览器 (Chromium/Edge) ────────────────────────┐
│                                                                        │
│  React 18 + Vite                                                       │
│    App.tsx ── ui/*（StatusBar/Transport/Library/…）                     │
│      │                                                                 │
│      ├── Player (engine/Player.ts)  ← 16ms setInterval 主循环            │
│      │     ├── PlayAlong  跟弹判定（required / recent / inProgress）      │
│      │     ├── Synthesizer (Web Audio 加法合成，兜底音源)                  │
│      │     ├── Accompaniment (Web MIDI Out → 电钢)                       │
│      │     ├── Metronome (Web Audio 节拍器)                             │
│      │     └── Countdown (3-2-1-GO)                                    │
│      │                                                                 │
│      ├── InputBus ← KeyboardInput / MidiInput (Web MIDI In)              │
│      ├── LedFollower → LedController ──WebSocket──┐                      │
│      └── FallingNotes / StaffView (Canvas 2D)    │                      │
└───────────────────────────────────────────────────┼────────────────────┘
                                                    │ ws://<pi>:8080
┌─────────────────── Raspberry Pi ───────────────────┼────────────────────┐
│  ws_led_bridge.py :8080 (0.0.0.0)  ──TCP──> led_remote.py :7777 (127.0.0.1)
│                                                    │
│                                                    └──> rpi_ws281x (WS2811, 176 LED / 双色带 352)
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 关键事实

- 灯带 176 LED 对应 88 键（每键 2 颗），前端 `LedController.ts:23-25`，后端 `led_remote.py:30-35`。
- 罗兰电钢只认 MIDI 通道 0（实测记录见 `docs/roland-midi-notes.md`），故 `Accompaniment.ts:117-118` 硬编码 `MIDI_CHANNEL = 0`。
- 乐库走 `/library/manifest.json` + 曲库文件；已归档曲目在 `public/library/_archive/`。
- 测试：`npx vitest run`，共 **25 个文件 213 个用例**（后端另有 `test_security.py` 15 例 + `test_protocol.py` 13 例）。
- 时间域：项目里同时存在 **perf / ctx / song** 三套时间（见 §5.2），歌曲时间锚在 `AudioContext` 上。
- 变速：曲子里的 tempo 变化由 `src/util/tempoMap.ts` 的**连续拍网格**统一处理（小节线 / 节拍器 / 节拍点 / 乐谱时值）。

### 1.3 不在本次范围

- 不改电钢硬件、灯带硬件与固件。
- 不改 `refs/` 下任何参考项目。
- 不做 UI 视觉改版（只涉及功能性渲染修正）。

---

## 2. 审计方法与基线

### 2.1 可复现命令

```powershell
npm run build          # 生产构建
npx tsc -b --force     # 类型检查
npx vitest run         # 单元测试
```

### 2.2 实测基线（2026-10-20，审计当时）

> ⚠️ **这是审计当时的原始基线，作为历史记录保留**（当时测试是红的）。
> 当前基线见 §0.4：**25 文件 / 239 用例全绿**，`tsc -b --force` EXIT=0，`npm run build` PASS。

| 检查项 | 结果 |
|--------|------|
| `npm run build` | **PASS** |
| `npx tsc -b --force` | **EXIT=0**，无类型错误 |
| `npx vitest run` | **FAIL** — Test Files 2 failed \| 13 passed (15)；Tests 5 failed \| 85 passed (90)；Errors 1 |

失败的 5 个用例全部是**测试夹具路径问题**，不是产品代码缺陷：

| 用例 | 断言路径 | 实际位置 |
|------|----------|----------|
| `parseMxl.test.ts:12` | `public/library/canon/pachelbel-canon-in-d-poly.mid` | `public/library/_archive/canon/` |
| `parseMxl.test.ts:22` | `public/library/chopin/nocturne-op9-no2.mxl` | `public/library/_archive/chopin/` |
| `parseMxl.test.ts:39` | `public/library/chopin/fantaisie-impromptu-op66.mid` | `public/library/_archive/chopin/` |
| `parseMxl.test.ts:49` | `public/library/chopin/waltz_op64_no1.mxl` | `public/library/_archive/chopin/` |
| `parseMxl.test.ts:57` | `public/library/chopin/waltz_op34_no3.mxl` | `public/library/_archive/chopin/` |

另有 `tests/diag_all_downloads.test.ts:7` 读取 `resolve(__dirname, '../download')`，而仓库里实际目录名是 **`downlaod`**（拼写错误）——该文件在 collect 阶段直接抛错。

> **结论**：产品代码的构建与类型检查是干净的；测试红灯 100% 来自"曲线归档到 `_archive/`"和"目录名拼错"两处夹具漂移，与本次审计发现的缺陷无因果关系。但它必须先修——没有绿的基线，后面所有重构都无法回归。

### 2.3 审计方法

1. **静态通读**：`src/` 全部 44 个 ts/tsx 文件 + `scripts/bt_pi/pi/` 全部 6 个 Python、3 个 systemd unit 与 `install.sh`。
2. **横向对比**：把 piano-follow 的每个子系统与 `refs/` 五个项目的对应实现逐点对齐（矩阵见 §3.1）。
3. **行业取证**：检索浏览器音频调度、Web MIDI 时序、钢琴判定评分的一手资料（来源清单见 §3.3）。
4. **可执行验证**：对每条结论给出复现路径与验证方式；无法复现的假设一律进入附录 A"已排除"。

---

## 3. 与业界项目的横向对比

### 3.1 能力矩阵

| 能力 | piano-follow（现状） | sightread | neothesia | piano-booster | linthesia | 结论 |
|------|--------------------|-----------|-----------|----------------|-----------|------|
| **音频调度** | 16ms `setInterval`，到达即发声（`Player.ts:39,231,419-430`） | 基于时间轴推进 | 自研 `midi-file` playback state，事件带时间戳 | 明确提出"消除 MIDI timing jitter：改用 rtTimer + 1ms tick + 独立线程"（`TODO.md:18-20,31-32`） | 原生 C++/GTK | ❌ **缺 lookahead**（P1-2） |
| **输出延迟对齐** | 无。判定用歌曲时间 `currentTime*1000` | — | — | — | — | ❌ **缺失**（P1-3） |
| **评分容差** | 固定 `toleranceMs`（默认 500ms） | 按歌曲配置给窗口 | 按音符/节拍判定 | — | — | ❌ **不随速度缩放**（P1-5） |
| **准确率公式** | `hits/(hits+misses)`，不含 errors（`StatusBar.tsx:28`） | `hit/(hit+missed+error)`（`player.ts:42-46`） | — | — | 漏弹单独计数（`PlayingState.cpp:460,480-481`） | ❌ **口径偏乐观**（P1-4） |
| **wait 模式漏弹** | 冻结时歌曲时间不推进 → miss 恒 0 | wait 精确回退到 `note.time`（`player.ts:538-539`） | — | — | — | ❌ **漏统计**（P1-4） |
| **跳过漏弹** | 无 | `skipMissedNotes`（`types.ts:109`、`player.ts:169,547`） | — | — | — | ⚠️ **可借鉴**（§6.1） |
| **按住时长加分** | 无 | `durationHeld` 计入总分（`player.ts:36-39,531`） | — | — | — | ⚠️ **可借鉴**（§6.1） |
| **seek 重触发持续音** | 只找 `n.time >= t`，跨界音丢失（`Player.ts:273-275`） | filter 跨界 note 重建 playing（`player.ts:764-766`） | `set_time` 丢弃历史事件（`midi_player.rs:144-150`） | — | — | ❌ **缺失**（P1-6） |
| **MIDI Out 停止语义** | 只有 CC#123（`Accompaniment.ts:145-154`） | — | `active_notes: HashSet<ActiveNote>` + 显式 NoteOff（`midi_backend.rs:19,69-74,85-100`） | — | — | ❌ **不彻底**（P0-4） |
| **MIDI 通道** | 硬编码 ch=0 | — | `separate_channels` 按 track 分道（`midi_player.rs:18,75-79`） | 按 channel 分轨（`TODO.md:27`） | — | ⚠️ **可配置化**（§6.3） |
| **Program Change** | 不发 | — | 按时间轴发送（`midi_player.rs:133-142`） | — | — | ⚠️ **缺失**（§6.3） |
| **MIDI In 时间戳** | 用 `performance.now()` 丢弃 `e.timeStamp`（`MidiInput.ts:94,102`） | — | Rust MIDI crate 提供硬件时间戳 | — | — | ❌ **缺失**（P1-7） |
| **踏板 CC64** | 不解析、不发送 | — | — | — | — | ❌ **缺失**（P1-7 / P0-4） |
| **手部归属置信度** | 单轨声部聚类启发式，无置信度（`library.ts:16`） | — | — | — | — | ⚠️ **需标注**（P2-6） |
| **速度自适应** | 无 | — | — | "Automatically adjust the speed to match playing ability"（`TODO.md:25`） | — | ⚠️ **可借鉴**（§6.2） |
| **节拍对齐提示** | 无 | — | — | ahead / behind beat 指示（`TODO.md` MEDIUM 段） | — | ⚠️ **可借鉴**（§6.2） |
| **循环倒带** | 键盘 ←/→ 跳到相邻 note | — | `RewindController` 长按连续倒带并记忆原播放态（`rewind_controller.rs:11-60`） | — | — | ⚠️ **可借鉴**（§6.4） |
| **进度/时间轴 UI** | 单条进度条 | `TimelineStrip` / `SongScrubBar`（`pages/play/components/TimelineStrip.tsx`、`features/controls/SongScrubBar.tsx`） | — | — | — | ⚠️ **可借鉴**（§6.4） |
| **练习模式分离** | hand + wait 两个开关 | Rhythm / Sound 分开 | — | one-finger play / rhythm practice（`TODO.md:11-12`） | — | ⚠️ **可借鉴**（§6.2） |
| **后端部署形态** | systemd + WebSocket 桥 + TCP server | Web | 原生 Rust 桌面端 | 原生 Qt | 原生 C++/GTK | ✅ 本项目更适合嵌入式场景（§7） |
| **静态托管** | Vite dev / `npm run build` 产出 `dist/` | — | — | — | — | ⚠️ musicope 的 Express 托管思路可参考（§6.5） |

### 3.2 从对比中读出的三个结构性差距

**差距一：时序层缺"硬件时钟"这一层。**
piano-follow 用 `setInterval` 累加一个浮点 `currentTime`，既没有 lookahead 预排，也没有把"歌曲时间"映射到"AudioContext 时间"。sightread 至少把音乐时间轴与渲染解耦；neothesia 直接用 `Duration`/`Instant` 做时间基准；piano-booster 更把"消除 MIDI jitter"单列为独立议题（`TODO.md:18-20`）。**当前架构下，任何主线程卡顿都会同时污染"听到的声音"与"打出的分数"，且无法通过调参修复。**

**差距二：判定口径比业界宽松且不自洽。**
固定 500ms 容差 + 不含 errors 的准确率 + wait 模式不计 miss，三者叠加后用户看到的"98% 准"可能对应真实的"漏了一半"。sightread 把 error 计入分母、把 wait 回退精确到 `note.time`（`player.ts:42-46,538-539`），是一套可以直接照搬的口径。

**差距三：MIDI 生命周期管理只做了"发"，没做"记"。**
piano-follow 的 `Accompaniment` 无状态，因此无法回答"现在电钢上哪些键还按着"，panic 只能靠 CC#123 兜底，而 CC#123 不关延音。neothesia 用 `HashSet<ActiveNote>` 解决同一问题（`midi_backend.rs:19,69-74,85-100`），代价只有几行代码。

### 3.3 行业取证来源清单

| 主题 | 来源 | 关键结论 |
|------|------|----------|
| lookahead 调度 | Chris Wilson, *A Tale of Two Clocks* — `www.chriswilsonmedia.com/2012/09/03/a-tale-of-two-clocks/` | `setTimeout` 只适合"可视"更新；音频必须用 `AudioContext.currentTime` 提前排程，浏览器定时器精度不足以直接驱动音频 |
| 输出时间戳 | MDN `AudioContext.getOutputTimestamp()` — `developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp` | 给出"已真正播放"的上下文时间与 `performanceTime`，是消除输出延迟偏差的标准手段 |
| MIDI 输出定时 | MDN `MIDIOutput.send()` — `developer.mozilla.org/en-US/docs/Web/API/MIDIOutput/send` | `send(data, timestamp)` 可指定发声时刻；Chrome 43+/Edge 79+/Firefox 97+/Opera 30+ 支持，**Safari 不支持** → 必须保留 `ctx.currentTime` 回退路径 |
| MIDI 输入定时 | MDN `MIDIMessageEvent.timeStamp` — `developer.mozilla.org/en-US/docs/Web/API/MIDIMessageEvent/timeStamp` | 输入侧同样有硬件时间戳可用 |
| 钢琴判定 | Keystair, *Grading piano timing in the browser with Web MIDI* — `dev.to/tiltedlunar123/grading-piano-timing-in-the-browser-with-web-midi-90g`（转载 `urgent.news/2026/10/02/grading-piano-timing-in-the-browser-with-web-midi`） | 给出 `toCtx(ctx, tPerf)` 换算（含 `getOutputTimestamp` + `outputLatency`/`baseLatency` 回退）、按 tempo 缩放的 `timingWindows()`、CC64 踏板处理 —— **P1-3 / P1-5 / P1-7 的直接依据** |
| 判定窗口 | Super Simple Piano, *How live note grading works* — `www.supersimplepiano.com/blog/live-note-grading-how-it-works` | perfect / good / missed 三档窗口 + wait 模式语义，与 §3.1 的口径差异 |
| MIDI CC | `www.nickfever.com/music/midi-cc-list`、`soundforgepro.com/midi-cc-chart`、`producersociety.com/midi-cc-cheatsheet` | **CC#120 = All Sound Off（同时断延音），CC#123 = All Notes Off（不关延音）** —— P0-4 的判定依据 |
| 浏览器支持 | `midi.aidxn.com/blog/webmidi-browser-only-gamepad` | 2026 年 Web MIDI 的浏览器/平台可用性现状 |

---

## 4. 缺陷清单

每条包含：现象 → 根因 → 修法 → 验证方式。行号对应 2026-10-20 的 `main`（`5a704db`）。

### 4.1 P0 — 阻断级

#### P0-1 循环回卷后 UI 播放状态失同步

- **位置**：`src/engine/Player.ts:406-416`
- **现象**：设置 Loop 区间并播放，歌曲走到区间末尾回卷后，状态栏/播放按钮显示"暂停"，但音乐仍在继续响；此时按空格不会停止播放，只会把手柄状态改回"播放中"。
- **根因**：回卷分支先调 `this.pause()`（`:409`），而 `pause()` 内部会 `useStore.getState().setIsPlaying(false)`（`:261`）；随后 `:413` 重新 `setInterval` 启动定时器，**但从未调用 `setIsPlaying(true)`**。UI 状态与播放器内部状态从此分叉。
- **次生影响**：`Player.play()` 开头有 `if (this.timer !== null) return`（`:226`），定时器已在跑，所以 `play()` 空转；`App.handlePlay()`（`App.tsx:688-692`）虽然补了一次 `setIsPlaying(true)`，但那只是把 UI 拉回"播放中"，并不会修正真正的状态机。
- **修法**：把回卷从"pause + 重启定时器"改成纯时间跳转，不再经过 `pause()`：

  ```ts
  if (loopRange && this.currentTime >= loopRange[1] && prevTime < loopRange[1]) {
    this.seek(loopRange[0], { keepPlaying: true })
    return
  }
  ```
  `seek()` 增加 `keepPlaying` 选项：跳过 `pause()` 中的 `setIsPlaying(false)` 与定时器清理，只做"停声 + 重置游标"。
- **验证**：设置 Loop → 播放过界 → 断言 `useStore.getState().isPlaying === true` 且音频持续；按空格能真正暂停。补一个 `tests/player.test.ts` 用例。

#### P0-2 循环回卷清空评分状态 → 第二遍重复计分

- **位置**：`src/engine/Player.ts:278-279`（`seek()` 内）+ `src/engine/Player.ts:410`（回卷调用 `seek`）
- **现象**：Loop 循环第二遍开始时，之前已经弹对的音符被重新标记为"待弹"，视觉上命中色被抹掉；用户重新弹一遍，命中数再次累加 → 准确率的分子分母一起涨，分数被重复计算。
- **根因**：`seek()` 无条件执行 `this.playAlong.clear()`（`:278`）与 `this.hitNoteIndices.clear()`（`:279`）。而 `PlayAlong.clear()`（`src/engine/PlayAlong.ts:209-214`）还会把 `stats` 整体重置。但 store 层的 `hits`/`misses`/`perfects` 计数器**不会**被重置 → 两边状态从此不一致。
- **附带影响**：wait 模式下 `playAlong.clear()` 会清空 `required`，`areRequiredPressed()` 立刻返回 true（`PlayAlong.ts:194-196`），于是回卷后的第一遍**不再冻结**，用户可以"白弹"，而这些音仍会被记进 `required` 再要求一次。
- **修法**：区分"用户主动 seek"（应清空评分）与"循环回卷"（应保留评分）。`seek()` 增加 `preserveScore` 参数；回卷路径传 `true`。另外，回卷时 `hitNoteIndices` 至少要保留已命中的下标，避免视觉与计数脱节。
- **验证**：Loop 一遍 → 记录 `hits` → 回卷 → 断言 `hits` 不因重复弹而增加、且 `getNoteStates()` 仍返回 `hit`。

#### P0-3 `cancelPreviewNotes()` 丢弃待发 NoteOff → 电钢卡键

- **位置**：`src/engine/Player.ts:151-155`
- **现象**：暂停或跳转时若正好有"预览音"在响，电钢上那个键会一直压住不松开，直到下一次 panic 或切换设备。
- **根因**：`previewNotes()`（`:112-147`）在 `:132` 发出 MIDI NoteOn，并把配对的 NoteOff 放在 `:139` 的 `setTimeout` 里。 `cancelPreviewNotes()` 只做了 `clearTimeout` + 置 null，**没有主动发 NoteOff**。更糟的是，`:149-150` 的注释明确声称"immediately release notes + restore acc.transpose"，但实现里根本没有这两件事——注释与实现不符，容易误导后续维护者。
- **触发路径**：`pause()` → `:257 cancelPreviewNotes()`；`seek()` → `:271 pause()`。synth 侧由 `pause()` 的 `:258 synth.stopAll()` 兜住，**MIDI Out 侧无任何兜底**。
- **修法**：把待释放的 note 列表存起来（`_previewNotes: SongNote[]`），`cancelPreviewNotes()` 中先补发 NoteOff 再清定时器；同时把 `acc.transpose` 的还原也真正实现（保存 `_previewPrevTrans`）。并把注释改成与实现一致。
- **验证**：MIDI Out 模式下调用 `previewNotes()` 后立刻 `pause()`，用 MIDI 监视器断言收到 NoteOn 后**必定**收到配对 NoteOff。

#### P0-4 MIDI Out panic 不彻底 → 踩踏板时卡音

- **位置**：`src/engine/Accompaniment.ts:145-154`
- **现象**：用户用 Roland 电钢时踩着延音踏板（CC#64），播放中途暂停/切歌/关页面后，部分音一直响。
- **根因**：`panic()` 对 16 个通道只发 `CC#123`（All Notes Off）。按 MIDI 规范，**CC#123 不会关闭 Sustain（CC#64）**——延音踏板按住时，被 All Notes Off 释放的音仍由踏板继续维持。要彻底静音必须发 **CC#120（All Sound Off，同时断延音）**，并显式关闭 CC#64。
- **业界做法**：neothesia 用 `active_notes: HashSet<ActiveNote>` 记录"当前还按着的 (key, channel)"，`stop_all()`（`refs/neothesia/neothesia/src/output_manager/midi_backend.rs:85-100`）逐个发显式 NoteOff，而不是依赖控制器状态位。
- **修法**：
  1. `Accompaniment` 增加 `activeNotes: Set<number>`，`sendNoteOn` 写入、`sendNoteOff` 移除；
  2. `panic()` 改为：先对 16 通道发 `CC#120`（All Sound Off），再发 `CC#64 = 0`（Sustain Off），最后对 `activeNotes` 里每个 key 发显式 NoteOff 并清空集合；
  3. `use()` 切换设备时也走一次 `panic()`（现在只在 `this.output.id !== id` 时才 panic，`:93-95`，设备为 null 时会漏）。
- **验证**：用 MIDI 监视器：踩住踏板 → 触发 panic → 断言收到 `CC#120` 与 `CC#64=0`；且此后无残留 NoteOn。

#### P0-5 测试基线红（夹具漂移）

- **位置**：`tests/parseMxl.test.ts:12,22,39,49,57`；`tests/diag_all_downloads.test.ts:7`
- **现象**：`npx vitest run` → Test Files 2 failed | 13 passed；Tests 5 failed | 85 passed；Errors 1。
- **根因**：两处夹具漂移，与产品代码无关：
  1. 5 个 `.mid`/`.mxl` 夹具已随"曲线归档"移到 `public/library/_archive/{canon,chopin}/`，测试仍指向旧的 `public/library/{canon,chopin}/`；
  2. `diag_all_downloads.test.ts:7` 读 `../download`，仓库实际目录名是 `downlaod`（拼写错误）→ collect 阶段直接抛 `ENOENT`。
- **修法**：
  1. 把 5 个路径改到 `_archive/` 下的实际位置（或更好：把测试夹具移到 `tests/fixtures/` 下，与产品资产解耦，避免再次漂移）；
  2. 把 `downlaod` 目录重命名为 `downloads`（或 `download`），并同步修正测试引用——这是仓库里的真实拼写错误，应该修根因而不是改测试。
- **验证**：`npx vitest run` 全绿（15/15 文件、90/90 用例、0 Errors）。

### 4.2 P1 — 严重级

#### P1-1 下落音符渲染只拿到 10Hz 的时间戳
- **状态**：✅ 已修复（阶段 1d）—— 渲染层改读 `player.getCurrentTime()`（新增 `src/render/timeSource.ts`），不再绕 10Hz 量化的 store；`tests/render_time.test.ts`

- **位置**：`src/engine/Player.ts:496-504`（`emitTick`）+ `src/render/FallingNotes.tsx:88`
- **现象**：下落音符不是平滑滚动，而是每 100ms 跳一格，视觉上有明显的"台阶感"；音符越靠近判定线跳动越明显。
- **根因**：`emitTick()` 用 `if (now - this.lastTickStoreTime > 100)` 把 `setCurrentTime` 限流到 10Hz；而 `FallingNotes` 的 rAF 绘制循环读的是 `useStore.getState().currentTime`（`FallingNotes.tsx:87-88`），拿到的是这个 10Hz 量化值。滚动速度 `PPS = 280`（`FallingNotes.tsx:29`），因此每帧最多跳 `280 * 0.1 = 28px`。
- **注**：`FallingNotes` 用的是 `getState()` 而非订阅，React 并不会因此重渲染——所以这个限流对 React 没有收益，对 Canvas 却是纯损失。它在 `ff3d6c5`（initial commit）就存在。
- **修法**：渲染层直接读播放器的连续时间，不要绕道 store：
  - `Player` 暴露 `getCurrentTime()`（已有，`Player.ts:101-103`）；
  - `FallingNotes` 的 rAF 循环改为 `const t = playerRef.current?.getCurrentTime() ?? state.currentTime`；
  - store 的 `currentTime` 只用于需要触发 React 重渲染的 UI（进度条），保留 10Hz 限流即可。
- **验证**：录屏/逐帧检查 `dt` 的相邻帧差应 ≈ `PPS/60`，不再出现 28px 台阶。

#### P1-2 到达即发声，没有 lookahead 调度
- **状态**：✅ 已修复（阶段 1f）—— 新增 `src/engine/Scheduler.ts`（排程游标）与 `src/engine/Clock.ts`（歌曲时间↔ctx 时间映射）。音符提前 120ms 排进 AudioContext 时间轴，`when` 精确落在 `note.time`；`Synthesizer.playNote/stopNote`、`Accompaniment.sendNoteOn`、`Metronome.tick` 均支持绝对 ctx 时刻。**例外**：wait 模式不开 lookahead（冻结会掐掉正在响的伴奏，提前排程的音会被误杀）。`tests/lookahead.test.ts`

- **位置**：`src/engine/Player.ts:39`（`FRAME_MS = 16`）、`:231`（`setInterval`）、`:419-430`（到达即发声）；`src/engine/Synthesizer.ts:69`（`ctx.currentTime`）；`src/engine/Metronome.ts:21`
- **现象**：主线程一卡（GC、LED 批量刷、React 渲染），这一帧的音就晚发十几到几十毫秒；节拍器同样受影响。用户感觉"节拍不稳"。
- **根因**：`setInterval` 的回调里才决定"现在该发哪个音"，然后用 `ctx.currentTime`（= 此刻）发声。这等于把调度决策和发声时刻绑定在同一个时刻，主线程抖动 1:1 传导到音频。
- **业界做法**：
  - Chris Wilson《A Tale of Two Clocks》：定时器只负责"唤醒"，音频事件必须提前排到 `AudioContext` 时间轴上；
  - piano-booster 把"减少 MIDI timing jitter"单列为议题（`TODO.md:18-20`）。
- **修法**：引入独立 `Scheduler`（见 §5.1）：
  - `lookaheadMs = 25`（定时器唤醒间隔）、`scheduleAheadMs = 120`（提前排程窗口）；
  - 定时器回调只负责"把未来 120ms 内该发的音**排进** `AudioContext` 时间轴"，用 `ctx.currentTime + delta` 作为发声时刻；
  - 合成器 `playNote(note, transpose, when)` 接受绝对发声时间；`stopNote(midi, when)` 同理；
  - MIDI Out 走 `output.send(bytes, ctxTime)`，**Safari 不支持 timestamp 参数**，需按能力检测回退到立即发送（`MDN MIDIOutput.send`）。
- **验证**：在 `stepLoop` 里注入 30ms 的人为阻塞，断言实际发声时刻偏差 < 5ms（用 `AudioContext` 的 `getOutputTimestamp()` 或离线渲染比对）。

#### P1-3 评分时钟未对齐输出延迟
- **状态**：✅ 已修复（阶段 1f）—— 新增 `src/engine/Clock.ts`：歌曲时间**锚在 AudioContext 上**（不再累加、不漂移）；输入判定改用**硬件时间戳** `e.timeStamp` 换算歌曲时间；输出延迟检测 + 可选补偿（默认 0，见下方口径说明）。`tests/clock.test.ts`

> **P1-3 的落地口径（重要，别当成"已加延迟补偿"）**：practice 模式下**被判定的那只手本身不发声**（`routeFor → silent`），用户是照着画面（下落音符 / 乐谱）弹的，而画面在 song 域、没有延迟。所以补偿默认 = 0（视觉对齐）。给"跟着伴奏声音弹"的用户提供可开关的补偿（自动 = 检测值 / 手动滑块，设置面板「判定延迟」区）。**视觉域 vs 听觉域二选一，不能同时满足** —— 这跟 §3.1 的 sightread 是同一取舍。

- **位置**：`src/engine/Player.ts:315`（`songMs = this.currentTime * 1000`）、`:366`、`:435`、`:464`
- **现象**：用户明明跟得很准，系统却持续判"早弹"；调大容差才能"看起来准"。
- **根因**：判定用的歌曲时间是 `setInterval` 累加出来的逻辑时间（`:404`），而用户听到的声音要晚 `outputLatency + baseLatency` 才到达耳朵（蓝牙耳机 100–200ms，有线 20–60ms）。两者之间存在一个**恒定且设备相关**的偏差，判定因此系统性偏早。
- **业界做法**：Keystair 的 `toCtx(ctx, tPerf)` 用 `ctx.getOutputTimestamp()` 把 `performance.now()` 域映射到 `AudioContext` 域，并减去 `outputLatency`/`baseLatency`（见 §3.3）。
- **修法**：
  1. 新增 `src/engine/Clock.ts`，提供 `songTimeToCtxTime()` / `ctxTimeToSongTime()` / `perfToCtx()`；
  2. `getOutputTimestamp()` 不可用时（Firefox 早期版本）回退到 `ctx.currentTime - (outputLatency ?? baseLatency ?? 0)`；
  3. **输入侧**用 `MIDIMessageEvent.timeStamp`（`DOMHighResTimeStamp`）经 `perfToCtx()` 换算后再与文件音的 `ctx` 时间比较；
  4. 输出延迟在 UI 上可见（"当前输出延迟 XXms"），便于用户判断是否需要有线输出。
- **验证**：戴蓝牙耳机弹 20 个音，断言 `playedDelta` 的均值绝对值 < 20ms（改造前应能看到明显的负偏置）。

#### P1-4 wait 模式 miss 恒为 0，准确率不含 errors
- **状态**：✅ 已修复（阶段 1c）—— 准确率改为 `hits / (hits + misses + errors)`，`StatusBar` / `StatsPopup` 共用 `src/engine/Scoring.ts`；`tests/scoring.test.ts`

- **位置**：`src/engine/PlayAlong.ts:80-101`（`update` 的 grace 过期判定）；`src/engine/Player.ts:378-398`（冻结时直接 return，不推进 `currentTime`）；`src/ui/StatusBar.tsx:28`
- **现象**：wait 模式下漏弹的音符**从不计入 miss**，准确率长期虚高；同时按错的音（error）完全不进分母。
- **根因**：
  1. `PlayAlong.update(songMs)` 用**歌曲时间**判断 grace 是否过期（`:95` `songMs - press.offTs > t`）。wait 冻结时 `Player.stepLoop` 在 `:398` 直接 return，`currentTime` 不推进 → `songMs` 恒定 → grace 永不超时 → miss 恒 0。
  2. `StatusBar.tsx:28`：`accuracy = hits / (hits + misses)`，**不含 `errors`**。
- **业界口径**：sightread 是 `hit / (hit + missed + error)`（`refs/sightread/src/features/player/player.ts:42-46`）。
- **修法**：
  1. grace 过期改用**墙钟时间**（`performance.now()`）判定，不再依赖歌曲时间推进——冻结时墙钟照走，grace 自然会到期；
  2. 准确率改为 `hits / (hits + misses + errors)`，并同步更新 `StatsPopup`；
  3. 补一个"wait 模式漏弹被记为 miss"的单元测试。
- **验证**：wait 模式下故意不弹，断言 `misses` 增加且准确率下降。

#### P1-5 判定容差固定 500ms，不随速度缩放
- **状态**：✅ 已修复（阶段 1c）—— 判定窗口按 bpm 缩放（`timingWindows`），默认值对齐 sightread；同时删掉了原草案里空转的 `noteDuration` 参数（详见 §5.4）

- **位置**：`src/engine/PlayAlong.ts:28-30`（`toleranceMs()` 直接读 store）；`src/store.ts:271`（默认 500，范围 100–2000，见 `store.ts:350`）
- **现象**：慢板（如 Adagio）时 500ms 宽到"随便弹都算准"；快板（Presto）时 500ms 接近半拍，判定形同虚设。
- **根因**：容差是**绝对毫秒**，与 tempo、音符时值完全脱钩。用户在 UI 上改容差是在两个都不对的值之间挑一个。
- **业界做法**：Keystair 的 `timingWindows()` 按 tempo 缩放窗口；sightread 按歌曲配置给窗口。
- **修法**：
  1. 容差改为**相对量**：`tolerance = clamp(baseMs, beatMs * ratio)`，其中 `beatMs = 60000 / bpm`，比例建议 `perfect = 0.25 * beat`、`good = 0.6 * beat`，并受绝对上下限约束（如 25–250ms）；
  2. UI 改为"判定灵敏度"档位（严格 / 标准 / 宽松），内部再按 tempo 换算成毫秒并显示出来；
  3. 对短音额外放宽（音符时长 < 80ms 时按 `max(tolerance, duration * 0.5)`，避免短促的十六分音符被判晚）。
- **验证**：同一段旋律在 60bpm 与 150bpm 下播放，断言"刚好卡在窗口边缘"的判定结果一致。

#### P1-6 seek 不重触发跨越跳转点的持续音
- **状态**：✅ 已修复（阶段 1b）—— `Player.announceNotes()` 补跨界持续音：seek 后该音进入 `playingNotes`、补发 NoteOn、正常收尾；`tests/player.test.ts`

- **位置**：`src/engine/Player.ts:270-285`（`seek()`）
- **现象**：跳到一段长音中间，该音既不亮灯也不发声，用户听到的是"断了一截"。
- **根因**：`seek()` 只用 `findIndex(n => n.time >= this.currentTime)`（`:273-275`）定位游标，**没有处理"note.time < t < note.time + duration"** 这些跨界持续音——它们既不会被调度（`time < t`），也不会被加入 `playingNotes`。
- **业界做法**：sightread 在 seek 时用 `song.notes.filter(note => note.time < t && t < note.time + note.duration)` 重建 playing 集合（`refs/sightread/src/features/player/player.ts:764-766`）。
- **修法**：`seek()` 后补一次跨界音处理：把 `note.time < t < note.time + duration` 的音加入 `playingNotes` 并按路由发出 NoteOn（synth 用 `when = ctx.currentTime`），同时记录一个"剩余时长"，在 `stepLoop` 里用剩余时长而非原始 `duration` 判断结束。
- **验证**：跳到一段 4 小节长音的第 2 小节，断言该音立刻发声、灯亮、剩余时长正确。

#### P1-7 MIDI 输入丢弃 `e.timeStamp`、无 CC64、无 running status
- **状态**：✅ 已修复（阶段 2）—— `MidiInput` 保留 `e.timeStamp` 进 `NoteEvent.t`（判定用它换算歌曲时间）、实现 running status（1 字节消息复用上次状态字节）、解析 CC64 踏板。`tests/input.test.ts`

- **位置**：`src/input/MidiInput.ts:82-105`
- **现象**：MIDI 输入的判定精度完全受 `setInterval` 采样率限制（最坏 16ms 误差 + 主线程抖动）；踏板信息拿不到；某些设备在数据密集时会漏音。
- **根因**：
  1. `:94`、`:102` 用 `performance.now()` 覆盖了 `MIDIMessageEvent.timeStamp`（浏览器已经给了硬件时间戳）；
  2. `onMessage` 只解析 `0x8`/`0x9`，`0xB`（控制器，含 CC64 踏板）被静默丢弃；
  3. 没有 running status 处理——很多设备在同一通道连续发送时会省略状态字节，当前实现会把它当成非法长度 < 2 直接 return；
  4. 没有 active-note 追踪，无法知道"用户还按着哪些键"。
- **修法**：
  1. 保留 `e.timeStamp`（`DOMHighResTimeStamp`），经 §5.2 的 `perfToCtx()` 换算后参与判定；
  2. 解析 `0xB0` 控制器事件，单独暴露 `sustain`（CC64）状态，供 LED 与判定使用；
  3. 实现 running status：记住上一次的状态字节，遇到 1 字节消息时复用；
  4. 增加 `activeNotes: Set<number>`，NoteOn 时加入、NoteOff 时移除，作为 blur/断连时的清理依据。
- **验证**：接入电钢后，对比 `e.timeStamp` 与 `performance.now()` 的偏差分布（应为 0–2ms）；按住踏板时 UI 应显示踏板状态。

#### P1-8 键盘输入无 blur 处理 → 切窗卡键
- **状态**：✅ 已修复（阶段 2）—— 键盘输入注册 `blur` / `visibilitychange`，失焦时把所有按下的键补发 up。`tests/input.test.ts`

- **位置**：`src/input/KeyboardInput.ts:68-71`（`start`）、`:99-109`（`onUp`）
- **现象**：按住琴键时切到别的窗口，回来后那个键一直"亮着"、判定里也算一直按着。
- **根因**：`start()` 只注册 `keydown`/`keyup`，**没有 `window.blur` 监听**。窗口失焦时浏览器不派发 `keyup`，`this.pressed`（`:66`）里的条目永远不会被清掉，`onEvent` 也不会发 up 事件，`Player.pressedNotes`（`Player.ts:69`）同样残留 → 灯常亮（`LedFollower` 的 `pressed` map 也有同样的问题）。
- **附带缺陷**：`onUp`（`:99-102`）直接 `this.pressed.delete(e.code)` 并发 up 事件，**没有校验这个键是否真的在 `pressed` 里**——按住时按下了一个之前已按住的键再松开，会发出一个不该有的 up。
- **修法**：
  1. 注册 `window.addEventListener('blur', this.onBlur)`，在 blur 时把所有按下的键补发 up 事件并清空 `pressed`；
  2. `onUp` 增加 `if (!this.pressed.has(e.code)) return` 前置判断；
  3. 同样地，`Player` 与 `LedFollower` 需要提供 `releaseAll()`，供 blur 与 MIDI 断连时调用。
- **验证**：按住 `z` 切到别的窗口再切回来，断言 `player.getPressedNotes()` 为空、灯已灭。

#### P1-9 LED 命中反馈与文件播放复用同一通道
- **状态**：✅ 已修复（阶段 2）—— `NoteSource` 增加独立的 `'hit'` 通道；`LedFollower` 的 `pressed` 改成 `midi → (source → hand)` 多源追踪，任一源松开不会误灭另一源的灯；命中脉冲独立计时，**不影响用户正按着的灯**。`tests/led_follower.test.ts`

- **位置**：`src/engine/Player.ts:349`（`this.onNoteOn(note, true)`）→ `src/App.tsx:205`（`(n, _hit) => emitLedNoteOn(n.midiNote, 'playback', n.hand)`）→ `src/led/LedFollower.ts:48-75`
- **现象**：弹对一个音后，灯会亮到该音自然结束才灭；有时用户还按着键，灯却提前灭了；开了 LED 提前量之后，命中反馈干脆消失。
- **根因**：
  1. `App.tsx:205` 的回调签名是 `(n, _hit) => ...`，**`_hit` 参数被丢弃**——命中反馈与文件调度发出的事件完全一样（`source: 'playback'`），下游无法区分；
  2. `markHit` 只发"开"，不发配对的"关"；配对的关要等文件音自然结束（`Player.ts:470`）才发 → 灯亮到自然结束；
  3. `LedFollower` 的 `pressed` map 只按 midi 做键，input 源与 playback 源的事件互相覆盖：任一源的 up 都会灭掉另一源还需要的灯；`pendingOff` 的 60ms grace（`:61-75`）又会被 playback 的 down 取消（`:50-54`）→ 灯常亮；
  4. 开了 LED offset（`ledOffsetUnits !== 0`）时，`emit.ts:57` 会把 **所有** `source === 'playback'` 的事件直接吃掉 → 命中反馈彻底消失。
- **修法**：
  1. `NoteEvent.source` 扩展为 `'playback' | 'input' | 'hit'`，`markHit` 用 `'hit'`；
  2. `emit.ts` 的抑制逻辑只针对 `source === 'playback'`，`'hit'` 不受影响；
  3. `LedFollower` 的 `pressed` 改为**按 (source, midi) 复合键**追踪，或维护 `pressedBySource: Map<source, Set<midi>>`，只有当所有源的该 midi 都抬起时才灭灯；
  4. `markHit` 发一个"亮 X ms 再灭"的独立脉冲（与 sightread 的 `durationHeld` 反馈思路一致），不复用文件通道。
- **验证**：弹对一个音，断言 LED 在该音自然结束前就熄灭；且按住不放时不会被别的源的 up 误灭。

#### P1-10 WS 桥无鉴权且绑 `0.0.0.0`
- **状态**：✅ 已修复（阶段 3）—— `ws_led_bridge.py` 叠了五层防护：共享 token（`/opt/bt-gpio/led_token`，首条消息必须 `{"op":"auth","token":...}`）、Origin 白名单、连接数上限（默认 4）、每客户端令牌桶限流（默认 200 msg/s）、单条消息 64KB 上限。`scripts/bt_pi/tests/test_security.py`（15 用例）

- **位置**：`scripts/bt_pi/pi/ws_led_bridge.py:22`（`WS_HOST = "0.0.0.0"`）、`:80`（`websockets.serve(handle_client, WS_HOST, WS_PORT)`）
- **现象**：同一个 Wi-Fi/LAN 上的任何网页（甚至任何能访问该端口的程序）都能连上 WS 并任意控制 176 颗 LED；也可反复刷 `set_many` 消息把 Pi 的 CPU 拉满。
- **根因**：桥只做转发，没有做任何来源校验。文件头注释 `:11` 自己写着"bridge 本身无需 root"，说明设计上本就不该有高权限，但 `:22` 仍绑了 `0.0.0.0`。前端 `LedController.connect()`（`src/led/LedController.ts:184-214`）也**不带任何凭据**——即使后端加校验，前端也得配套改。
- **修法**：见 §7。
- **验证**：从另一台同网段机器用 `websocat` 连接，必须被拒绝；带正确 token 的浏览器连接必须成功。

#### P1-11 三个 systemd 服务全部以 root 运行
- **状态**：✅ 已修复（阶段 3）—— `bt-gpio.service` / `ws-led-bridge.service` 降权为 `User=pi`（前者用 `CAP_NET_ADMIN`/`CAP_NET_RAW` capability）；`led-remote.service` 因需 `/dev/mem` 保留 root，但补齐 `NoNewPrivileges` / `ProtectHome` / `ProtectKernelTunables` / `RestrictSUIDSGID` 等沙箱项。`install.sh` 自动建用户、建组、生成 token（640 root:pi）。

- **位置**：`scripts/bt_pi/pi/led-remote.service:10`、`ws-led-bridge.service:13`、`bt-gpio.service:12`
- **现象**：WS 桥被入侵即等于 Pi 上的 root shell。
- **根因**：`led-remote` 需要 root 拿 `/dev/mem`（注释 `:11` 已说明，合理）；但 `ws-led-bridge` 只是**转发**，注释 `:14` 自己都写了"桥不需要 root, 但为了简单保持 root"；`bt-gpio` 需要 `NET_ADMIN` 等 capabilities，也可以用 capability 而非全 root。
- **修法**：
  - `ws-led-bridge.service`：改 `User=pi`（或专用用户），并加 `NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=strict`；
  - `bt-gpio.service`：改用 `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW` + `CapabilityBoundingSet`，而不是 `User=root`；
  - `led-remote.service`：保留 root 但加 `ProtectHome=true`、`NoNewPrivileges=true`。
- **验证**：`systemctl show <unit> -p User -p AmbientCapabilities`，并在 Pi 上实测三个服务功能正常。

#### P1-12 MIDI Out 断连后 UI 仍显示"已连接"
- **状态**：✅ 已修复（阶段 1e）—— 连接状态拆为 `midiOutputId`（用户选择）+ `midiOutputConnected`（运行时）；同时修掉 `onDisconnect` 重复触发；`tests/midi_out.test.ts`

- **位置**：`src/engine/Accompaniment.ts:49-62`（`trySend`）、`:96`（`this.outputId = id`）；`src/ui/StatusBar.tsx:80`
- **现象**：电钢被拔掉后，状态栏的"🎹 电钢"仍显示绿色"已连接"。
- **根因**：`trySend` 失败时只清 `this.output = null`，**保留了 `this.outputId`**；而 `StatusBar` 判断连接状态用的是 `midiOutputId ? 'ok' : 'fail'`，与 `acc.isEnabled()`（`:108-110`，同时要求 `output !== null`）不是一回事。
- **修法**：把"用户选择的设备 id"与"当前实际可用的 output"拆成两个概念：
  - store 里保留 `midiOutputId`（用户选择）；
  - 新增 `midiOutputConnected`（运行时状态），由 `onDisconnect` 置 false、连接成功置 true；
  - `StatusBar` 用 `midiOutputConnected` 决定颜色，用 `midiOutputId` 决定文案。
- **验证**：拔掉电钢，断言状态栏变红/灰，且弹重连提示。

#### P1-13 Synthesizer 按 midi 单键管理 voice → 同名音互相打断
- **状态**：✅ 已修复（阶段 1a）—— `Synthesizer` voice 键改为 `(midi, voiceId)`，同名音不再互相打断；`tests/synthesizer.test.ts`

- **位置**：`src/engine/Synthesizer.ts:28`（`private active = new Map<number, Voice>()`）、`:65-67`
- **现象**：在没有电钢（走浏览器合成兜底）时，同一个音高在左右手同时出现会被"掐断"，听起来像断奏。
- **根因**：`active` 以 midi 为唯一键。`playNote` 发现同 midi 已在响就直接 `stopNote`（`:65-67`）。而 BWV1041 这类曲目**同一个 midi 在两只手同时出现**（`src/engine/PlayAlong.ts:6` 的注释明确提到"同一 midi 同时多 hand … 一次按键必须全命中"）。
- **修法**：把 voice 的键从 `midi` 改成 `(midi, voiceId)` 或直接用数组 + 唯一 id；`stopNote` 按 midi 停掉全部匹配 voice；`stopAll` 不变。
- **验证**：用 BWV1041 播放，断言同一 midi 的两个 voice 并存。

#### P1-14 LED pre-scanner 使用 10Hz 量化的 store 时间源
- **状态**：✅ 已修复（阶段 1d）—— LED pre-scanner 改读 `player.getCurrentTime()`；`src/render/timeSource.ts`

- **位置**：`src/App.tsx:468`（`const t = useStore.getState().currentTime`）
- **现象**：LED 提前/延迟量（±900ms）设得越大，灯的亮灭越"跳"，不连续。
- **根因**：同 P1-1，`currentTime` 被 `emitTick` 限流到 10Hz（`Player.ts:497-499`）。offset 越大，100ms 的量化误差占比越大（900ms 窗口下约 11%）。
- **修法**：pre-scanner 直接读 `playerRef.current.getCurrentTime()`；同时把 `:485` 的"每帧从 i=0 全扫"改成游标扫描（见 P1-15）。
- **验证**：offset 设 ±900ms，断言灯的 on/off 事件时间戳间隔不再出现 100ms 的台阶。

#### P1-15 每帧 O(n) 全表扫描 + 每帧新建 Set/Map
- **状态**：✅ 已修复（阶段 4）—— LED pre-scanner 改为 `src/led/scanCursor.ts` 的事件流 + 单调游标（游标跨 effect 重建保留）；音频排程改为 `src/engine/Scheduler.ts` 游标；`PlayAlong.requiredIndices()` 改为**增量维护的活集合** + `requiredVersion` 版本号；`Player.getNoteStates()` 改为缓存 + 版本号（`hitVersion + requiredVersion`）。`tests/scanCursor.test.ts`

- **位置**：`src/App.tsx:485-502`（pre-scanner 每帧从 i=0 全扫，`:501` 才 break）；`src/engine/Player.ts:193-195` → `src/engine/PlayAlong.ts:204-206`（每帧 `new Set`）；`src/engine/Player.ts:204-210`（每帧 `new Map`）；`src/render/FallingNotes.tsx:334`（每帧遍历 `song.notes`）
- **现象**：长曲（3000+ 音）下 CPU 占用偏高，掉帧时反过来加剧 P1-2 的调度抖动。
- **根因**：多处每帧重复做全量工作。其中 `Player.ts:200-202` 的注释已经讨论过"每帧 new Map 的 GC 压力"，结论是"音符 <10k 时可忽略"——但真正的问题不是 GC，而是**重复遍历**本身。
- **修法**：
  1. `PlayAlong` 维护一个**增量**的 `requiredIndices` 快照（增删时更新），不再每帧重建 Set；
  2. `getNoteStates()` 改为缓存 + 版本号，只在 `markHit`/miss 变化时重建；
  3. pre-scanner 维护一个单调递增的游标 `scanIndex`，配合 `note.time + duration` 排序的第二个索引处理 off 事件，避免每帧从 0 开始；
  4. `FallingNotes` 同样用游标 + 二分查找定位可见窗口。
- **验证**：用 5000 音的曲子测 60fps 下的主线程占用，应 < 4ms/帧。

#### P1-16 节拍器音量从不跟随滑块
- **状态**：✅ 已修复（阶段 4）—— `Player.syncVolume()` 补 `metronome.setVolume(v * 0.5)`

- **位置**：`src/engine/Metronome.ts:15-17`（`setVolume` 定义了但**全项目无调用点**）；`src/engine/Player.ts:216-220`（`syncVolume` 只调 synth + acc）
- **现象**：把音量拉到 0，节拍器依然全速全响。
- **修法**：`syncVolume()` 里补 `this.metronome.setVolume(v * 0.5)`（节拍器本身已有 0.5 的默认衰减，见 `Metronome.ts:9,27,29`），或把节拍器音量做成独立滑块。
- **验证**：把主音量设为 0，断言节拍器无声。

#### P1-17 `pause()` 停 synth 用 `acc.transpose`，双真源
- **状态**：✅ 已修复（阶段 1a）—— `stopSounds()` 停 synth 统一用 store 的 `transpose`

- **位置**：`src/engine/Player.ts:254`（`this.synth.stopNote(n.midiNote + this.acc.transpose)`）vs `:429`/`:460`（用 store 的 `transpose`）
- **现象**：目前因为 `syncTranspose()`（`:221-223`）会同步两边，实际不会出错；但一旦 `acc.transpose` 与 store 不一致（`previewNotes` 改写过 `acc.transpose`，见 `Player.ts:131`），暂停时就会**停错音高 → 卡音**。
- **修法**：统一以 store 的 `transpose` 为唯一真源；`previewNotes` 不应直接写 `acc.transpose`，改为把 transpose 作为参数传给 `sendNoteOn(note, transpose)`。
- **验证**：在 `acc.transpose` 被外部改动的情况下调 `pause()`，断言发出的 `stopNote` 音高与 `playNote` 一致。

#### P1-18 乐谱音符时值量纲错误 → 整首谱面变成"短音 + 长休止"

- **状态**：✅ 已修复（阶段 4b）—— `durInQuarter` 改为 `音符秒数 ÷ 该时刻一个四分音符的秒数`；换算全部走 `src/util/tempoMap.ts`（变速曲子的音符时值也正确）。`tests/tempoMap.test.ts`

- **位置**：`src/render/StaffView.tsx:244`（`buildMeasureBeats`）
- **现象**：打开乐谱视图，所有音符都比实际短一大截 —— 175bpm 的十六分音符（0.174s）被画成 0.25 个四分音符（看起来像三十二分音符），整首曲子被拆成"短音 + 长休止"；实际演奏的时值跟谱面对不上。
- **根因**：`durInQuarter` 的单位是"四分音符"，正确的换算是 `duration(秒) ÷ secPerQuarter`，而代码写的是 `duration(秒) × quarterPerWhole`（`4 / denominator`）。两者量纲不同：后者把"秒"直接当成了"四分音符数"。120bpm 4/4 下，一个四分音符（0.5s）被算成 **0.5** 个四分音符（八分音符），整首谱面统一缩短 3 倍。
- **同源问题**：`fillWithRests` 用 `gap / secPerQuarter` 换算休止（**正确**），`buildStaveNotes` 用 `measureDur / secPerQuarter` 算小节长度（**正确**）—— 同一份数据里混了两种量纲，所以 `fillWithRests` 会给每个小节补一大段休止来"填满"，掩盖了音符本身的错误。
- **连带影响**：`secPerQuarter` 一律取 `bpms[0].bpm`，变速曲子的时值整体错（与 P2-3 同源）。
- **修法**：
  1. `durInQuarter = duration / secPerQuarterAt(note.time)`；
  2. 把 `secPerQuarter` 这个标量换成 `secPerQuarterAt(t)` 函数，由 `TempoMap` 按**该音所在时刻**的速度给出（变速正确）；
  3. `fillWithRests` / `buildStaveNotes` / `renderHand` 的签名同步改成函数。
- **验证**：`tests/tempoMap.test.ts` —— 逐个 beat 断言 `durInQuarter === duration / secPerQuarterAt(note.time)`；并断言填满后的整小节时值之和 = 4 个四分音符（4/4）。

#### P1-19 倍速滑块完全失效（时钟层改造引入的回归）

- **状态**：✅ 已修复（阶段 4c）—— `SongClock.setSpeed()` 三处接入：`Player` 构造时按 store 同步、`play()` 起播前同步、`stepLoop()` 每帧同步；新增 `tests/speed.test.ts`（5 例）。

- **位置**：`src/engine/Player.ts`（构造 / `play` / `stepLoop`）+ `src/engine/Clock.ts:87`（`setSpeed` 写完之后**无任何调用点**）
- **现象**：设置里选「1/2×」「3/4×」「1/4×」后**完全没反应** —— 音乐还是 1× 播。更糟的是判定窗口、下落音符滚动、wait 冻结全都按 1× 的时间在走：用户以为在慢练，实际只有曲子内容没变。
- **根因**：改造前歌曲时间是自己累加的（`dt = FRAME_MS/1000 * speed`），倍速天然生效。换成锚在 `AudioContext` 上的 `SongClock` 之后，歌曲时间改由 `anchorSong + (ctx.currentTime - anchorCtx) * speed` 推导 —— **倍速必须显式同步进 `SongClock` 内部的 `speed`**，而 `SongClock.setSpeed()` 写完之后**没有任何调用点**（`grep setSpeed` 只命中 `Clock.ts` 自己的定义，以及 `SpeedControl.tsx` 里那个同名的 store setter）。结果 `SongClock.speed` 恒为 1。
- **连带影响**：`toCtxTime()` 用 `1 / speed` 换算，speed 恒为 1 意味着**音符在 ctx 时间轴上的落点也按 1× 算** —— 就算手动把 `SongClock.speed` 改对，`Player` 不重新锚定，排程点照样漂。
- **修法**：
  1. `SongClock.setSpeed(speed)` —— 换速时按**当前歌曲位置**重新锚定，位置连续不跳变（`setSpeed` 内部已实现，见 §5.2）；
  2. `Player` 构造函数里同步一次 —— 否则第一帧会按 1× 走完才被纠正，曲头差半个帧；
  3. `play()` 的 `doStart()` 里同步一次 —— 暂停期间用户可能改过倍速；
  4. `stepLoop()` 每帧同步 —— 覆盖播放中改倍速的场景。
- **验证**：`tests/speed.test.ts` —— 1× / 1/2× / 1/4× 下歌曲时间分别按 1 / 0.5 / 0.25 推进；1/2× 时音符的 ctx 落点从 1.0 推到 2.0；中途改倍速位置不跳变。

---

### 4.3 P2 — 一般级

| # | 位置 | 问题 | 修法 | 状态 |
|---|------|------|------|------|
| P2-1 | `src/store.ts:341`（`setHand`）vs `:443`（`setHandPersistent`）；`src/App.tsx:530`、`src/ui/HandSelector.tsx:39,48` | 练习模式**不持久化**：`setHand` 只 `set()` 不写 localStorage，而 volume/transpose/wait 都有 Persistent 版本。`m` 快捷键与 HandSelector 都用了非持久版本 → 刷新后回到 `playback` | 统一：删除 `setHand`，只保留 `setHandPersistent`；或在 `setHand` 内直接 `savePrefs({ hand: h })` | ✅ 阶段 4 —— `store.setHand` 改为**持久化**（`savePrefs({hand})`），`m` 快捷键与 HandSelector 刷新后不再回到 playback |
| P2-2 | `src/App.tsx:376-385`（`:380` `if (m.has(n.midiNote)) continue`） | `handMap` 同一 midi **首现手胜出**：左手低音与右手旋律同音名时，LED 手色错 | 改为"按事件带 hand 上色"（`LedController.baseColor` 已支持 `eventHand` 优先，见 `LedController.ts:71-73`），把首现逻辑降级为 fallback | ✅ 阶段 4 —— `handMap` 值类型改为 `Map<number, 'left' \| 'right' \| 'both'>`，两只手都出现记 `'both'`，`baseColor` 对 `'both'` 不猜、落到 mode/split 兜底 |
| P2-3 | `src/parser/parseMidi.ts:102-122`（`:110` 只用 `bpms[0].bpm`）；`src/engine/Player.ts:475`（`bpms[0]?.bpm ?? 120`） | 小节线与节拍器**忽略变速**（tempo map）：曲子中段 ritardando / 渐快后，小节线错位、节拍器跑偏 | 引入 `tempoMap: Array<{ time: number; bpm: number }>`，`computeMeasures` 与节拍器都按分段 BPM 计算；`Song.bpms` 保留但不再取 `[0]` | ✅ 阶段 4b —— 新增 `src/util/tempoMap.ts`（连续拍网格 + 分段速度），`computeMeasures`（`parseMidi` + `parseXml`）、`Player.bpmAt`、节拍器、`FallingNotes` 节拍点、`inferHands.openingEndTime`、乐谱时值全部改走 tempo map；`tests/tempoMap.test.ts` |
| P2-4 | `src/parser/parseMidi.ts:28-41` | 轨去重是 O(n²) 双层循环比签名 | 签名存 `Map<string, number>`，一次遍历即可，O(n) | ✅ 阶段 4 —— 轨去重签名改用 `Map<string, number>`，一次遍历 O(n) |
| P2-5 | `src/library.ts:31-39` | `loadManifest()` 的模块级缓存**永不失效**，改 manifest 必须硬刷新 | 缓存加 TTL（如 60s）+ `ETag`/`If-None-Match`；或提供 `reloadManifest()` 并在 dev 模式禁用缓存 | ✅ 阶段 4 —— manifest 缓存加 60s TTL + `invalidateManifest()` |
| P2-6 | `src/library.ts:16`（manifest 注释"tracks:1 可能有错"）、`src/parser/inferHands.ts` | 单轨声部分手是启发式聚类，**无置信度**，UI 上也无提示 | `inferHands` 输出 `{ hand, confidence }`；manifest 里对 `tracks:1` 的曲目在 UI 上打"手别为推断"标记，并允许用户手动改 | ✅ 阶段 4 —— `inferHands` 输出 `{ method, confidence }`（explicit/per-note/two-tracks/multi-tracks/voice-clusters/pitch-split × high/medium/low），`Song.handInfer` 携带；HandSelector 显示「ℹ 手别为推断」；设置面板加「手别判定：自动 / 按音高切分」，切换后**就地**重算 `note.hand`（不重建 Player，不打断播放） |
| P2-7 | `scripts/bt_pi/pi/led_remote.py:16,19`（写 `/tmp/led_remote.py`）vs `led-remote.service:12`（用 `/opt/bt-gpio/led_remote.py`） | 后端文档与实际部署路径不一致，照着文档敲命令会跑错文件 | 统一到 `/opt/bt-gpio/`，文档与 service 一致；补一份 `scripts/bt_pi/README.md` 的准确路径表 | ✅ 阶段 4 —— `led_remote.py` 文档串统一到 `/opt/bt-gpio/`；`scripts/bt_pi/README.md` 增加「Pi 上的文件路径」表 + 「WS 桥 / 共享 token / 服务降权」两节 |
| P2-8 | `scripts/bt_pi/pi/led_remote.py:223-226` | 死代码：`try: req_id = msg.get("id") except Exception:` —— `msg` 是 dict，`.get` 不会抛 | 直接 `req_id = msg.get("id")`，去掉 try/except | ✅ 阶段 4 —— 改为 `req_id = msg.get("id") if isinstance(msg, dict) else None` |
| P2-9 | `src/engine/Accompaniment.ts:117-118`（硬编码 ch=0）、无 Program Change | MIDI Out 不发 Program Change、不重置设备状态：换设备后可能残留旧音色/踏板状态；无法做左右手分道 | 增加 `channel` 与 `program` 可配置（对应 neothesia 的 `separate_channels` 与 Program Change，`midi_player.rs:75-79,133-142`）；`use()` 时发 `CC#121`（Reset All Controllers）+ Program Change | ✅ 阶段 4 —— `channel` / `program` 可配置；`use()` 时发 `CC#121` + Program Change（复位失败不判定断连） |
| P2-10 | `src/engine/Player.ts:378-383`（冻结判定用 `this.currentTime`） | 冻结判定用**调度帧时间**而非 `note.time`，误差可达一帧（16ms）+ 累加漂移 | 冻结时把 `currentTime` **回退**到触发冻结的那个 note 的 `note.time`（对应 sightread `player.ts:538-539`） | ✅ 阶段 4b —— 冻结点回退到「卡住用户的那个 note 的精确时间」（`PlayAlong.requiredEarliestTs()`）；回退超过 `MAX_REWIND_S`(100ms) 时不倒跳，改为 `PlayAlong.rebaseRequired()` 把判定基准对齐到冻结点（否则用户按下时差半秒 → 永远判不中 → 死锁）；冻结条件加 `\|\| this.frozen`（回退后时间可能 < 0.5s，否则下一帧就解冻了） |
| P2-11 | `src/engine/Accompaniment.ts:133-136` | `stopAll(playing)` 定义了但**全项目无调用**，Player 自己遍历 `playingNotes` 发 NoteOff——两份重复逻辑，容易走偏 | 删除 `stopAll` 或让 Player 统一调用它；只保留一份 | ✅ 阶段 4 —— **删除** `Accompaniment.stopAll`。保留 Player 的那份：它是**路由感知**的（midiOut 的音发 NoteOff、synth 的音走 `synth.stopNote`），`stopAll` 会给 synth 路由的音也发一份 NoteOff（多余且可能发错设备） |
| P2-12 | `src/engine/Countdown.ts:34`（`window.setTimeout(() => this.finish(), 1000)` 未存 id）、`:54-63`（`cancel()` 只 clearInterval） | 倒计时被取消后，那个收尾 `setTimeout` **仍会触发** `finish()` → `cb?.()` → `Player.play()` 的 `doStart()` → **倒计时取消了播放却自己开始播** | 把 timeout id 存进成员变量，`cancel()` 里一起 clear | ✅ 阶段 4 —— `Countdown` 存 `finishTimer` id，`cancel()` 里一起 clear |
| P2-13 | `src/engine/Player.ts:409` + `:410`→`:271` | 回卷时 `pause()` 被调两次（外层 + `seek()` 内部）。NoteOff 不会重复（`playingNotes.clear()` 在 `:259`），但 `setIsPlaying(false)` 会调两次 | 由 P0-1 的改造顺带消除 | ✅ 阶段 0b —— 已随 P0-1 消除：回卷走 `seek(t, { keepPlaying: true })`，**不经过** `pause()` |
| P2-14 | `src/util/navigation.ts:93-97` | `notesAt()` 每次导航都 `filter + sort` 全表 | 不是热路径（每次按键一次），可暂缓；若后续做长按连续倒带需改成二分 | ⏸ **暂缓** —— 不是热路径（每次按键一次）；做「长按连续倒带」（§6.4）时一并改二分 |
| P2-15 | `src/engine/Player.ts:479-484` | 节拍器用 `Math.floor(currentTime / secPerBeat)` 判拍，与 `currentTime` 的累加漂移耦合，误差会随播放时间累积 | 与 P2-3 一起改用 tempo map；拍点用音频时钟而非累加时间 | ✅ 阶段 4b —— 拍点来自 tempo map 的**连续拍网格**；`Player.scheduleMetronome()` 用游标把拍点**提前 120ms 排到 AudioContext 时间轴**（`when = clock.toCtxTime(beatTime)`），主线程抖动不再传导到节拍器；`seek()` 时游标跟着重置 |
| P2-16 | `src/App.tsx:205` | `Player` 的 `onNoteOn(note, hit)` 第二参数被丢弃，`NoteEvent` 类型里也没有承载"命中"语义的字段 | 随 P1-9 一起扩展 `NoteEvent.source` | ✅ 阶段 2 —— 随 P1-9 解决：`NoteSource` 增加 `'hit'`，`App.tsx` 的 `(n, hit) => hit ? emitLedHit(...) : emitLedNoteOn(...)` 已在用 |
| P2-17 | `scripts/bt_pi/pi/ws_led_bridge.py`（`handle_client`） | 鉴权在**开上游 TCP 连接之后**才做 —— 未鉴权的客户端能占住一个 client 名额（`MAX_CLIENTS` 默认只有 4）**和一个到 LED server 的 TCP 连接**；4 个不鉴权的假连接就能把真正的前端挤掉（DoS） | 把鉴权提到 `open_connection` 之前：先握手，握手过了才开上游连接；再加鉴权超时，避免"连上但不发 auth"的连接白占名额 | ✅ 阶段 4c —— 抽出 `_authenticate()`：握手失败直接拒并关连接，**完全不碰上游**；鉴权消息同样过限流；新增 `LED_AUTH_TIMEOUT_S`（默认 10s）；`scripts/bt_pi/tests/test_security.py` 增至 18 例（新增"未鉴权不开上游" / "鉴权后才开上游" / "鉴权超时断开"） |

### 4.4 用户实测回归（2026-10-21 续）

上一轮改动落地后, 用户实测报了三处回归. 三条都**不是**新引入的 bug —— 是**上一轮重构改变了旧代码依赖的隐含前提**, 但没人注意到. 逐条根因如下.

> 2026-10-22 追加 **R6**（灯光残留 + 右手很混乱）—— 见 R6 自己的小节, 复现条件是 BWV 846 + 提前量 +4.

#### R1 · LED 提前量 + 强制等待（功能从未实现）

- **位置**：`src/led/scanCursor.ts`、`src/App.tsx:476-528`（pre-scanner）、`src/engine/Player.ts`（冻结）
- **现象**：用户要求"跟弹时有提前量的 LED, 如果没按就暂停在那个 LED 上, 不要提前放下一个", 并要求在深层设置里加**是否强制等待**子选项（默认强制等待）。
- **根因**：**这个功能从来没有被实现过**（`git log --all -S'forceWait'/-S'强制等待'/-S'ledWait'` 全部无结果）。已有的只有两件事：
  1. pre-scanner 把 LED 的**灭灯时刻**推后 —— 对还在 `required` 里的 note 不发 LED off（`scanCursor.ts:84-89` + `App.tsx:507-519`）；
  2. wait 模式的冻结 —— note **到点**（`note.time`）还没按才冻。

  两者都不是"灯提前亮了 → 停住"。灯早亮的那段时间（最多 900ms）里，播放照常往下走，下一个音的灯也会亮 —— 正是用户说的"提前放下一个"。
- **修法**：新增 `store.ledForceWait`（默认 ON）+ 深层设置里的「强制等待」子选项。实现方式是**把记账时刻提前到"灯亮的那一刻"**：

  ```
  记账时刻 = note.time - 提前量     (原来 = note.time)
  判定基准 = 记账时刻               (原来 = note.time)
  判定窗口 = max(默认窗口, 提前量 + 默认窗口 + 150ms)
  ```

  提前记账 → 灯一亮就进 `required` → 走**同一套** wait 冻结逻辑 → 播放停在灯上。用户按下时 delta 相对"灯亮时刻"算，所以灯亮之后按都算命中（窗口已按提前量放宽）。关掉开关 → `ledOffsetMs()` 返回 0 → 行为与旧版完全一致。

  生效条件（全部满足）：跟弹模式 + wait 模式 + `ledForceWait` + `ledOffsetUnits > 0` + LED 真的开着（`ledEnabled && ledFollowPlayback`）—— 否则用户看不到灯却莫名停住。
- **验证**：`tests/led_force_wait.test.ts`（9 例）—— 强制等待 ON 停在 t=1.5（灯亮时刻）/ OFF 停在 t=2.0（note 时刻）/ 按下后解冻 / playback 模式不生效 / LED 关着不生效。
- **★ 2026-11-05：整个「强制等待 / 提前按」模式已删**（跟「抢先」二选一, 用户选了抢先）—— `store.ledForceWait` / `EarlyPressToggle` / `handQueue` / `Player.earlyPressWindowMs` 全部删除, `tests/led_force_wait.test.ts` 与 `tests/led_early_press.test.ts` 一并删除。见 §4.4 R23。

#### R2 · 播放的第一个音不被追踪

- **位置**：`src/engine/Player.ts`（`fileNoteOff` 调用点）、`src/engine/PlayAlong.ts`（`update()` 的 grace 过期）
- **现象**：用户报"播放的前面第一个音貌似不会被追踪和要求跟弹"。
- **根因**：两个叠加的问题：

  1. **短音在预览窗里被判 miss**。冻结判定被"前 0.5s 强制不冻"挡着（`currentTime > 0.5`），但 bookkeeping 循环照常跑 —— 第一个 note（t=0）在 t=0 就进了 `required`。如果它是短音（`duration < 0.3s`），它的 noteOff 在 0.5s 预览窗**结束之前**就到了 → `fileNoteOff` 记 `offTs` → `update()` 的 grace 到期 → **升级成 miss**。用户还没来得及按，第一个音已经被记成"漏弹"，并且从 `required` 里删掉 → 后面再按也不算命中。
  2. **判定基准用帧时间**。`announceNotes()`（seek 后的跨界音补发）用 `this.currentTime * 1000` 当基准，主路径用 `note.time * 1000` —— 两条路径不一致，seek 之后第一个音的判定基准会偏一帧。
- **修法**：
  1. `PlayAlong.NotePress` 加 `holdForever` 标志 —— 预览窗内结束、grace 到期时刻也落在预览窗内的 note **不计入 miss**，一直留在 `required` 里等用户按（条件含 `waitMode` —— wait 关了就没有"预览窗"这回事，漏弹照常记 miss）。
  2. `announceNotes()` 的判定基准改成 `note.time * 1000`，与主路径一致。
- **验证**：`tests/led_force_wait.test.ts` —— 开头 0.15s 短音的 note 留在 `required`、`miss === 0`、`getWaitTarget()` 返回第一个音；用户按下算 hit；`wait: false` 时漏弹照常记 miss。

#### R3 · 方向键失灵（← 卡在当前音）

- **位置**：`src/util/navigation.ts`（`findAdjacentActiveNoteTime`）、`src/store.ts`（`isActiveHand`）
- **现象**：用户报"上下左右切换有的时候会失灵, 尤其是暂停和跟弹模式下, 有的时候左移不到上一个音而是一直卡在当前音"。
- **根因**：两个独立的失效路径，都能复现：

  1. **playback 模式下 ←/→ 完全失灵**。`findAdjacentActiveNoteTime` 用 `isActiveHand` 过滤，而 `isActiveHand` 对 `practiceHand === 'playback'` 返回 `false`（`store.ts`）—— 从"跟弹"语义看是对的（播放模式用户不弹任何音），但从"导航"语义看 playback 模式没有手别之分，**所有 note 都该能跳到**。`navigation.ts` 的注释甚至写着"'playback' 模式 = 所有 note 都算 active"，但实现是直接抄 `isActiveHand` 的 —— 注释与实现矛盾。症状：只有 `Shift+←/→`（走 `findAdjacentNoteTime`，不过滤）还能用。
  2. **单轨曲在 right 模式下 ←/→ 失灵**。单轨曲的 `song.hands = {left: trackId, right: trackId}`（同一个 track），而 `isActiveHand` 的兜底是 `noteHand ?? (noteTrack === songHands.left ? 'left' : 'right')` —— `noteTrack === songHands.left` **恒为真** → 每个 note 都判成 `'left'` → right 模式下**没有任何 note 是 active** → 找不到候选 → ←/→ 无反应。症状跟第 1 条一样，但发生在单手跟弹模式。
- **修法**：
  1. `findAdjacentActiveNoteTime` 里对 `playback` 单独处理 —— 所有 note 都算候选，不再复用 `isActiveHand` 的 playback 分支。
  2. 抽出 `resolveHand()`：单轨曲（`songHands.left === songHands.right`）且 note 没标 hand 时**不猜**，返回 `undefined`；`isActiveHand` / `goesToMidiOut` 对 `undefined` 的处理是"两边都算 active"（跟弹要求它、导航能跳到），`goesToMidiOut` 则不发 MIDI Out（手别不明时不敢替用户决定哪只手该由电钢弹）。
- **验证**：`tests/navigation.test.ts` 新增 6 例 —— playback 模式 ←/→ 可用 / right 模式跳过 left / both 模式全通 / 单轨无 hand 时 right 模式也能跳 / 边界返回 null / 空 song 返回 null。

#### R4 · 附带修：`stopSounds()` 重新计算路由

- **位置**：`src/engine/Player.ts`（`stopSounds()`）
- **问题**：`stopSounds()` 用 `routeFor(...)` **重新计算**路由，而不是查 `this.noteRoutes`（排程时记下的那个）。中途切过手别模式的话，MIDI Out 的音会被交给 `synth.stopNote` 去关 —— 电钢上那个键会一直压住。这正是 P1-2 记录下来要避免的事，但 `stopSounds()` 漏改了。
- **修法**：改成 `this.noteRoutes.get(idx) ?? routeFor(...)`，与 `stepLoop()` 的收尾逻辑一致。

#### R5 · 双手跟弹时左手灯「闪一下就灭」（BWV 846）

- **位置**：`src/led/LedFollower.ts`（`handleEvent` / `handleHit`）
- **复现曲**：`public/library/bach/prelude-bwv846.mid`（巴赫平均律 BWV 846 前奏曲）
- **现象**：双手跟弹，左手灯亮一下就灭了（但音还在响）。
- **根因**：三个独立缺陷叠加，**都在 `LedFollower` 的按键状态记账上**。BWV 846 恰好两个条件都占全了（左手长音 + 同音重复），所以它是天然复现用例；别的曲子上不明显。

  **缺陷 1 · 命中脉冲到期无条件灭灯。**
  旧 `handleHit` 的定时器回调只查 `bySource?.has('input')` —— 意思是"只有 input 源按着时不能灭灯"。但跟弹时**左手长音是 playback 源在响**（用户弹左手 → 那只手是 active hand → 播放侧不负责发声，LED 事件照样是 `source='playback'`）。用户弹对 → `markHit` → `onNoteOn(note, true)` → 命中脉冲亮 150ms → 150ms 后定时器看到"没有 input 源按着" → **把灯灭了**，而左手长音还要响 2 秒。
  这是"闪一下就灭"最直接的那一下。

  **缺陷 2 · 同源同 midi 记成布尔而非计数。**
  `pressed` 的结构是 `midi → (source → hand)` —— 同一 (midi, source) 只能记"按着/没按着"。但 BWV 846 左手 C4 每小节重复：
  ```
  LH#0  t=0.000000  end=2.026567  midi=60
  LH#2  t=2.026567  end=4.046732  midi=60   ← 跟 LH#0 首尾相接, 同音
  ```
  LH#0 的 NoteOff 到达时 LH#2 刚开始 → 但记账是布尔的 → `bySource.delete(src)` → 灯灭。又是"闪一下就灭"。

  **缺陷 3 · pendingOff 到期不看命中脉冲。**
  `pendingOff` 的 grace 定时器回调只查 `previewed`，不查 `hitTimers` —— grace (60ms) 比脉冲 (150ms) 短，grace 到期时脉冲还亮着，却把灯灭了。

- **修法**：
  1. `pressed` 的值从 `hand` 改成 `{ hand, count }` —— 同一 (midi, source) 记**计数**。`down` 时 `count++`；`up` 时若 `count > 1` 就只减计数、**不灭灯**，等真正归零才走灭灯流程。
  2. `handleHit` 的定时器回调改成「**任何**源还按着就不灭灯」（`bySource.size > 0`），不再只查 input。
  3. `pendingOff` 的定时器回调加上 `!this.hitTimers.has(e.midi)` —— 脉冲还亮着就不灭。
- **验证**：`tests/led_follower.test.ts`（新增 6 例）+ `tests/led_bwv846.test.ts`（新增 2 例，端到端跑真实 BWV 846）。这 6 个新用例在旧实现上全部失败、在新实现上全部通过（已验证 —— 逐个回退三处修法复跑确认）。

#### R6 · 灯光残留 + 右手很混乱（2026-10-22）

- **复现条件**：巴赫平均律 BWV 846（`public/library/bach/prelude-bwv846.mid`，549 音 / 148.48s）+ LED 提前量 **+4**（= 400ms）+ 双手跟弹。
- **用户现象**：「有灯光残留」「右手很混乱」「刷新曲目应该强制清除当前的灯光」。
- **前提澄清（很关键）**：**提前量 != 0 时, 灯不是 Player 点的, 是 pre-scanner 点的。**
  `src/led/emit.ts:isPlaybackSuppressed()` 会抑制 Player 的 playback LED（否则同一批 note 被 Player 和 pre-scanner 各发一次 → 双份灯）。所以：
  - Player 的 `onNoteOn/off` → **到不了灯条**；
  - 灯的唯一来源是 `LedScanCursor`（`src/led/scanCursor.ts`）；
  - ⇒ **Player 停播时发的 noteOff 灭不了灯** —— pre-scanner 是唯一能灭的人，而它原来**没有停止的出口**。

下面 6 条都是这个前提下的记账缺陷，逐条根因如下。

**B1 · 提前量把灭灯也平移了 —— 「右手很混乱」的直接原因**

- **位置**：`src/led/scanCursor.ts`（`advance` 的 `offShift`）
- **旧行为**：开灯和灭灯**都**减去 offset。于是灯的窗口 = `[note.time - offset, note.time + duration - offset]`。
- **后果**：BWV 846 右手是 0.25s 的十六分音符（C5/E5/G5 循环）。+400ms 提前量时，灯的整个窗口 = `[t-0.4, t-0.15]` —— **完全落在声音之前**。音符发声时灯早就灭了 → 视觉上"右手灯乱闪"，跟谱子对不上。
- **修法**：提前量为**正**时只平移**开灯**，灭灯跟着音符的自然结束走：
  ```
  开灯 = note.time - 提前量
  灭灯 = note.time + duration          (不提前)
  ```
  提前量为**负**（延后，补偿链路延迟）时仍**整段平移**（晚亮晚灭，时长不变）—— 那是有意为之的补偿，不该拆开。

**B2 · 同一 midi 的多个 note 共用一个像素 → 误灭**

- **位置**：`src/led/scanCursor.ts`（`litBy`）
- **旧行为**：事件是"每个 note 一对开/灭"，但灯条是**每个键一个像素**。同一 midi 的 note A 开灯、note B 开灯、note A 灭灯 → **B 的灯被误灭**。BWV 846 右手 C5/E5/G5 反复出现，必然踩中。
- **修法**：游标按 **midi** 记账 —— `litBy: midi → 当前占着灯的 note 下标`。
  - 新 note 开灯时，同 midi 的旧 note 还占着灯 → 先发旧 note 的灭灯，再发新的开灯；
  - 灭灯事件到达时，同 midi 的灯已被更新的 note 占了 → **忽略**。

**B3 · 切歌只清像素，没清 follower 的内部状态**

- **位置**：`src/App.tsx`（song 变化 effect）
- **旧行为**：切歌时只调 `ledRef.current?.allOff()` —— 只擦了灯条的像素，**`LedFollower.pressed` 的计数还留着**。于是新曲里同一个 midi 的灯"按下去 → count 从 1 变 2 → 第一次松开 count 变 1 → 灯还亮着" → 灯跟着旧曲的账一直亮（用户说的「刷新曲目应该强制清除当前的灯光」）。
- **修法**：切歌时补 `followerRef.current?.clearAll()`（清 `pressed` / `pendingOff` / `hitTimers` / `previewed` + 全灭像素）。
  **顺序要紧**：先 `flushScanCursor()`（发 noteOff 让 follower 计数归零）再 `clearAll()` —— 反过来的话 flush 发的 noteOff 会落到一个已清空的 follower 上，反而多出一个 pendingOff 定时器。

**B4 · 重播时游标不复位**

- **位置**：`src/App.tsx`（pre-scanner effect）
- **旧行为**：`lastT` 是 effect 内的**局部变量** —— effect 重建（`isPlaying` 变 / `offset` 变）就归零。`lastT` 归零 → 「倒退检测」（`t + 0.5 < scan.lastT`）失效 → `restart()` 把时间拉回 0，但游标**不归零** → 旧曲已经走过的 note 不会再 on/off → 灯的状态跟新进度对不上。
- **修法**：`lastT` 跟游标一起放进 `scanRef`（跨 effect 重建保留），`restart` / `seek` 时把它归 `-1`。

**B5 · 停播时 pre-scanner 的灯没有出口 —— 「灯光残留」的真凶**

- **位置**：`src/led/scanCursor.ts`（新增 `flush` / `reset(emit)` / `seekTo`）、`src/App.tsx`（4 处调用点）
- **根因**：见开头的「前提澄清」—— 提前量模式下灯只有 pre-scanner 能灭，而 pre-scanner 原来只在 `advance()` 里灭。**暂停 / 曲终 / 切歌 / 重播 / seek 时没人灭它** → 灯永远亮着。
- **诊断证据**：逐帧 diff 8 秒的 BWV 846 +4 提前量，**230 处差异全部是「残留」，零处「漏亮」** —— 灯只会多亮、不会少亮或错亮，方向上就排除了"提前量算错"这类可能，锁定在「停播不清灯」。
- **修法**：给游标加三个出口：
  - `flush(emit)` —— 灭掉游标点着的**所有**灯 + 清空内部状态（`litBy` / `deferred` / `superseded`）；
  - `reset(emit)` —— 回退/重播：先 `flush` 再把游标指针归零；
  - `seekTo(t, offsetMs, emit)` —— 跳到任意位置：跳过的区间不重放，**跨界持续音**（还在响的 note）重新点亮。
  `App.tsx` 的四个调用点：pre-scanner effect 的 cleanup（`isPlaying` 变 false 时）、song 变化 effect、`handleRestart`、`handleSeek`。
- **附带发现（不是 bug）**：播放**过程中**残留的灯是**设计如此** —— 用户没按下的 note 留在 `required` 里，灯留着当「还没按，往这找」的提示。对照工具最初把它判成残留，是因为 deadline 没算 miss grace（`Scoring.timingWindows(bpm).hit`，120bpm 下 250ms）—— 对照工具的口径已修正（见下）。

**B6 · 退位的 note 重复灭灯 —— 「闪一下就灭」**

- **位置**：`src/led/scanCursor.ts`（`superseded`）
- **旧行为**：B2 修好后，同 midi 的 note A 把灯位让给 note B，之后 A 的灭灯事件才到达。此时 `litBy` 里已经没有 A（`owner !== e.idx`）→ 只看 `litBy` 判断不出来 → **多发一个灭灯**。follower 那边是按 `(midi, source)` **计数**的（R5 缺陷 2 修的），多减一次计数就把下一个 note 的灯提前灭了 → "闪一下就灭"。
- **修法**：加 `superseded: Set<number>` —— 记下"灯位已经交出去了"的 note 下标，它们的灭灯事件到达时**直接忽略**。

**验证：谱子 vs 灯条的对照工具**

- **工具**：`tests/helpers/ledHarness.ts` —— 用**同一条时间轴**把谱子和灯对照起来：
  - 真值 = 从谱子算出每个 note 的灯该亮的区间（`note.time - 提前量` ~ `note.time + duration`）；
  - 实际 = 把物理灯的 noteOn/noteOff 事件回放成每盏灯的亮灭区间；
  - 逐 note 对照 → 灯在 note 发声时亮没亮 / note 结束后灭没灭 / 同一 midi 的深度会不会掉到负数。
  - 支持 `press: 'all' | 'none'` —— 覆盖**用户没按键**的流程（灯留着当提示，直到停播才灭）。
  - 残留判定的 deadline 含 **miss grace**（`Scoring.timingWindows(bpm).hit`）—— 用户没按的 note 在 grace 内不算残留。
- **用例**：`tests/led_score_vs_lights.test.ts`（5 例）+ `tests/led_switch_clear.test.ts`（11 例）+ `tests/scanCursor.test.ts`（7 例，含 B1/B2/B6 的语义）。

#### R7 · 灯带后端改成「用户自选」+ BLE 静默挂死（2026-10-26）

- **用户现象**：「手动开了测试环境，换回了树莓派，**没有自动连接**」。
- **用户的设计决定**（原话）：「在灯带的菜单弄一个切换键 并且可以记住 我自己选 如果我选 pi 就自动连 如果我选 esp32 我就自己点蓝牙连接 就这么简单就可以」。

**R7-1 · 「自动挑后端」是这次故障的真凶 —— 而且会静默挂死**

- **位置**：`src/led/transport/AutoTransport.ts`（现已改名 `BackendTransport.ts`）
- **旧行为**：`prefer: 'auto'` 时先试蓝牙 —— `await ble.connect()` 成功就用蓝牙，失败才回落树莓派。
- **根因**：Chrome 的 `device.gatt.connect()` 在设备**离线 / 超距离**时**不会 reject**，它**一直挂着**。挂在 `await ble.connect()` 上 →
  1. 后面的树莓派分支**永远走不到** → 树莓派连不上；
  2. 整条 promise **永不 settle** → 上层既不报错也不重试 → UI 上既不是「连不上」也不是「待配对」，就是**没反应**；
  3. **连切后端都切不动** —— effect 依赖 `ledBackend`，但那个 promise 不 settle，effect 不会重跑。
- **复现证据**：Playwright 把 `navigator.bluetooth.getDevices()` 换成一台「配对过但离线」的设备（`gatt.connect()` 返回永不 settle 的 promise）→
  | 场景 | 结果 |
  |---|---|
  | auto + ESP32 离线（connect 挂住） | **不连树莓派、不报错、不重试**，`connected:false` / `err:null` / `needsPairing:false` |
  | 同上，点「树莓派」 | **切不动** —— 后端还是 `auto`（挂住的 promise 永不 settle） |
  | auto + ESP32 离线（connect 立刻 reject） | 回落树莓派 ✅ |
  | auto + 从没配对 + 浏览器支持蓝牙 | 抛 `BleNeedsPairingError` —— **压根不试树莓派** ❌ |
- **修法**：**把「自动」整个删掉**。
  - `BackendTransport.connect()` 只剩两条分支，**不猜、不回落**：`'ws'` → 只连树莓派（完全不碰蓝牙）；`'ble'` → 只连蓝牙（没配对就抛 `BleNeedsPairingError`）。
  - `store.ts` 的 `ledBackend` 收成 `'ble' | 'ws'` 两值；老 prefs 里的 `'auto'` **迁移成 `'ws'`**（`'auto'` 的语义就是「猜」，而猜正是要删掉的东西；落到树莓派是唯一确定、不会挂死的起点）。
  - 新的 💡 浮窗里加「灯带后端」两段式切换键（`src/ui/LedDock.tsx`），选择经 `savePrefs` 持久化 → **记住**。
  - 配对成功后 `handlePairEsp32` 补一句 `setLedBackend('ble')` → 刷新页面仍然是 ESP32 模式。

**R7-2 · 建连没有超时 → 任何一条链路都能无声无息卡住**

- **位置**：`src/led/transport/BleTransport.ts`（`connect()`）、`src/led/transport/WsTransport.ts`（`connect()`）
- **旧行为**：`await device.gatt.connect()` 没有上限（见 R7-1）；WebSocket 那边握手是 auth → init → off 三步、每步各自 1 秒超时，浏览器连不可达地址时 `'error'` 还可能迟到 —— 最坏能拖十几秒还没结果，期间 UI 一直转圈。
- **修法**：
  - BLE：整段建连（`gatt.connect()` + 取服务/特征）套 **8 秒**上限（`BLE_CONNECT_TIMEOUT_MS`），超时抛「ESP32 连不上 (8 秒超时) —— 确认设备已开机、在范围内，或在灯带菜单里切到「树莓派」」。
  - WS：整段建连套 **10 秒**上限（`WS_CONNECT_TIMEOUT_MS`），错误消息带 url，用户能一眼看出是「地址填错」还是「树莓派没开机」。
  - 抽出 `src/led/transport/withTimeout.ts` —— 输掉的那条 promise 的 rejection 会被吞掉（不然会变成 unhandled rejection）。

**R7-3 · 顺带发现：树莓派侧的 `led_remote` 会卡死**

- **现象**：验证 R7 时前端反复报 `rpc init timeout` —— 树莓派上 `led_remote.service` 的进程活着、端口也监听，但**收得进连接、回不了任何响应**（连 `ping` 都不回）。
- **根因**：`led_remote.py` 的 `handle()` 外面套了一把 `server._lock`。某个 op 调 rpi_ws281x 的 `strip.show()` 时卡在 C 库的 `ws2811_render()` 里（内核栈显示 `hrtimer_nanosleep` —— 等一个永远不来的 DMA 完成中断），**锁不放**，于是**之后所有客户端（包括 ping）都排在它后面**。
  - 服务自己的 unit 文件里其实已经写了注释：「僵死后自动重启 (rpi_ws281x 偶发死锁)」—— 但 `Restart=on-failure` 只管**崩溃**，管不了**挂死**。
- **处置**：`sudo systemctl restart led-remote.service` 恢复（`rpi_ws281x` 单实例，重启会重新拿 `/dev/mem`）。
- **待办（不在本次范围）**：给这个服务加个**健康检查 + 看门狗**（定时 `ping` 7777，超时未响应就重启），否则这个死锁还会以「灯带突然不响应」的形式再出现一次。

**验证**

- `npm test` —— 全绿（**303 例 / 34 文件**，含新加的 `tests/led_backend_choice.test.ts` 6 例 + `tests/led_transport.test.ts` 里改写的 5 例）。
- 本地 HTTPS 环境（`scripts/serve-dist.mjs` 监听 `127.0.0.1:8140`，`/led-proxy` 反代到 `ws://192.168.1.113:8080` 的**真树莓派**）用 Playwright 实测：

  | 场景 | 期望 | 实测 |
  |---|---|---|
  | prefs=`ws` → 页面加载 | 自动连树莓派 | ✅ `[led] connected via WebSocket (树莓派)`，徽章「● 连」 |
  | 浮窗里点「ESP32」 | 不连树莓派，提示配对 | ✅ 树莓派那条 WS 被拆掉，徽章「! 待配对」 |
  | prefs=`ble` + 离线 ESP32（`gatt.connect` 挂死） | 明确报错，不静默卡住 | ✅ 「ESP32 连不上 (8 秒超时) —— … 或在灯带菜单里切到「树莓派」」 |

---

#### R8 · 前端报「rpc init timeout」（2026-10-28）

- **用户现象**：前端状态栏/控制台显示 `rpc init timeout` —— 连不上灯带。
- **性质**：**不是** GPIO / 灯珠 / pinmux 问题（那三个在 R1~R6 已定位并修完），而是**连接层的设计缺陷**。

**R8-1 · `led_remote` 的「踢人」把在途回包一起销毁了（真凶）**

- **位置**：`scripts/bt_pi/pi/led_remote.py` · `_serve_client()` 的单 client 互斥逻辑。
- **旧行为**：新 client 连进来 → 对旧 socket `shutdown(SHUT_RDWR)` + `close()`。
  `close()` 会把旧 socket 上**还没发出去的数据**一起丢掉 —— 包括旧 client 手里那条命令（多半就是 `init`）的**回包**。
- **放大机制**：前端 `src/App.tsx` 建连失败 → 3 秒后重试 → 每次重试 = 一条新 WS = 桥开一条新 TCP → `led_remote` 踢掉上一条 → 上一条的在途回包被销毁 → 前端等不到回包 → 1 秒后报 `rpc init timeout` → 再重试。
  **这是个正反馈环**，越重试越连不上。
- **实测证据**（`journalctl -u led-remote`，部署前）：

  ```
  20:17:45 client connected (…35716)
  20:18:04 kicking existing client (…35716) for new (…51280)     ← 19 秒后被踢
  20:18:06 kicking existing client (…51280) for new (…51282)     ← 又被踢
  ```

  两次踢人间隔 2 秒 —— 正好是前端重试节奏。
- **修法**：踢人改成**只关读方向** `shutdown(SHUT_RD)`。
  - 读方向关了 → 旧 client 的 `recv()` 立刻返回 EOF → 它自己退出、自己 `close()`（**踢人照样生效**）；
  - 写方向还开着 → 旧 client 手里那条命令的**回包照发不误**（**回包不再被销毁**）。

**R8-2 · `ws_led_bridge` 漏关上游 TCP → 攒僵尸连接**

- **位置**：`scripts/bt_pi/pi/ws_led_bridge.py` · `handle_client()`。
- **旧行为**：`writer.close()` 写在 `ws_to_tcp()` 自己的函数体里 —— 而这个 task 在「上游先断」那条路径上会被 `cancel()`，**走不到那句 `close()`**（`CancelledError` 是 `BaseException`，`except Exception` 接不住）。
- **后果**：桥攒下一条条没人管的到 7777 的 TCP 连接（实测见过 4 条 `SYN-SENT` 僵尸）。每条僵尸都占着 `led_remote` 的**单 client 名额**，前端真正想连的时候名额已经被僵尸占着。
- **修法**：`writer.close()` 挪到 `asyncio.wait(...)` 外面的 `finally` 里 —— **一定会执行**。

**R8-3 · `led_remote` 的 `accept()` 出错就「静静退出」→ systemd 不会拉起**

- **位置**：`scripts/bt_pi/pi/led_remote.py` · `main()` 的 accept 循环。
- **旧行为**：`except OSError: break` → `main()` 返回 **0** → 进程**正常退出** → `Restart=on-failure` **不触发** → 灯带服务就此静默死掉，前端只能看到一句超时。
- **修法**：记一笔日志并**返回 1** → systemd 重新拉起。

**R8-4 · 前端把「握手超时」和「建连上限」都定得太紧**

- **位置**：`src/led/transport/WsTransport.ts`。
- **旧行为**：
  - 每条 RPC 的安全超时 **1 秒**（`setTimeout(…, 1000)`）—— 握手三步（auth → init → off）各 1 秒。设备只要稍慢一点就被判成「超时」，报出来正是用户看到的那句 `rpc init timeout`。
  - 建连总上限 **10 秒**，而握手三步最坏要 15 秒 —— 上限反而比内层超时还短，先报出来的是误导性的「WebSocket 连不上」。
- **修法**：
  - 握手三步（auth / init / off）走 **`WS_HANDSHAKE_TIMEOUT_MS = 5000`**；
  - 运行时命令（show / off / marquee）**保持 1 秒**（`WS_RPC_TIMEOUT_MS`）—— 每帧都要发 show，等太久会卡节拍；
  - 建连总上限提到 **20 秒**（`WS_CONNECT_TIMEOUT_MS`），盖得住三步握手；
  - `send()` 加可选 `timeoutMs`，由 `LedTransport` 接口透传（BLE 那条路忽略它）。

**顺带发现（本次未改）**

- `led_remote.py` 里的 pinmux 看门狗 `ensure_pinmux()` 直接用 `pinctrl set` 写 GFSEL，**绕过内核驱动**，理论上能打断 DMA 时序；它还每 20 次 `show` fork 一次 `pinctrl`（在持锁的路径上）。它是为了治「灯全黑但服务端一切正常」那个病根加的，**先留着**，要不要改成「只在 status/ping 时查、发现不对再报」待定。
- `ws2811_wait()` 是**没有超时的无限 DMA 等待**（`lib/ws2811.c:1107`）。真卡住时 `Restart=on-failure` 依然管不了 —— 健康检查 + 看门狗仍然欠着（R7-3 已记，本次未做）。

**验证**

- `npm test` —— 全绿（**305 例 / 34 文件**，新增 `tests/led_transport.test.ts` 2 例：握手 5 秒才超时 / 运行时仍 1 秒）。
- `python scripts/bt_pi/tests/test_led_reliability.py` —— **3 例 OK**（新增）。回归有效性已验证：把 `led_remote.py` / `ws_led_bridge.py` 临时改回旧逻辑，踢人用例与上游 TCP 用例**双双失败**，恢复后全绿。
- 真机（树莓派 192.168.1.113，已部署新代码）：

  | 场景 | 期望 | 实测 |
  |---|---|---|
  | 握手 auth → init → off | 全部有回执 | ✅ init 10ms / off 6ms |
  | 生产 Origin `https://192.168.1.111:8130` | 放行 | ✅ |
  | 未知 Origin `http://evil.example` | 拒（1008） | ✅ |
  | A 在途发 init，B 连进来踢 A | **A 的回包还在** | ✅ `{'ok': True, 'count': 176, 'pin': 18, 'id': 10}` |
  | 快速连 5 条 | 每条都拿到回包 | ✅ 5/5 |
  | 部署后 `ss -tanp \| grep SYN-SENT` | 0 | ✅ 0 |

- 部署：`/opt/bt-gpio/{led_remote.py,ws_led_bridge.py}` 已更新（备份 `*.bak.20261028-*`），两个 systemd 服务已重启。
  **注意**：树莓派上原来跑的是 10-18 的老桥（2471 字节，无 token/origin/限流）；仓库里那份是 10-21 的加固版，**一直没部署**。这次换上去的同时加了 `/etc/systemd/system/ws-led-bridge.service.d/10-env.conf`，把连接数上限（32）、限流（100000 msg/s）放开到不构成约束，origin 白名单补上已知的几个地址，**token 暂不启用**（没有 `led_token` 文件，前端也不带 token）—— 等真正要上 token 时再把 `LED_REQUIRE_TOKEN=1` 打开并在前端填 token。

---

#### R9 · 合并远程「用户系统 + 私有谱子库」（2026-10-28）

**背景**：远程 `backup/main` 比本地多 5 个提交 —— 用户系统 + 私有谱子库（`src/auth.ts`、`scripts/server/{api,auth,db,handler}.mjs`、`src/ui/AuthModal.tsx`、Library 的「我的」tab）、cookie `Secure` 标记修复及其回归测试、顶栏入口整理 + 状态框固定名称。本地这边是一整条 LED 大分支（R7 + R8）。

**做法**：先把本地 LED 工作整体提交成一条提交（`2194526`），再 `git merge backup/main --no-ff`。

**冲突 2 处**（`src/ui/LedDock.tsx`、`src/ui/StatusBar.tsx`）—— 都是「两边各加各的」，按语义合并而不是二选一：

| 文件 | 冲突点 | 决定 |
|---|---|---|
| `LedDock.tsx` | 远程加 `variant: 'inline' \| 'floating'` 两种摆法；本地加连接状态动态 `title` | **两边都要**：摆法取远程，`title` 取本地（本地版能显示「已连接 (ESP32 蓝牙 / 树莓派)」和「需要配对 ESP32」） |
| `StatusBar.tsx` | 远程把连接框标签**固定化**（电钢 / MIDI / LED），靠框色表达状态；本地保留动态标签（`待配对` / `连不上` / `关`） | 电钢 / MIDI 取远程的固定标签；**LED 保留本地动态版** —— 「待配对」这个状态只在这一个地方露出来，固定成 `LED` 用户就看不到「还没配对 ESP32」了 |

`src/App.tsx` / `README.md` 自动合并成功（改的是不同区段）。远程的 `LedDock variant="inline"` 进 `TopBar`、`variant="floating"` 进全屏分支，和本地的 LED effect 并存，没有互相覆盖。

**验证**：

- `npm run build` PASS（`tsc -b` + vite，131 modules）。
- `npm test` → **36 文件 / 332 用例全绿**（合并前 34/305；远程新增的 `tests/server.api.test.mjs` / `tests/server.auth.test.mjs` 也跑到了）。
- 真机（本地 dev server `http://localhost:5173` + 树莓派 192.168.1.113，176 灯）：Playwright 灌 `localStorage` 后加载页面 → `ledConnected: true`、`ledError: null`、`ledActiveBackend: 'ws'`，25 秒内只有一次 `[led] connected via WebSocket (树莓派)`，**无 rpc timeout、无重连风暴**。
- 顶栏按钮核对：远程新增的「登录 / 注册」「乐库 / 文件 (B)」在，本地的「📡 蓝牙」和「测试」也在。

**遗留**：`ensure_pinmux()` 每次 20 次 `show` 就在持锁的关键路径上 fork 一次 `pinctrl`；`ws2811_wait()` 是无限 DMA 等待，systemd 看门狗还没加。两项都还没动，等用户定。

---

#### R10 · 双色带模式（上灯带显示左右手的「下一个音」）（2026-10-29）

**背景**：用户要做**双色带**硬件 —— 两条灯带**串联**接一根数据线，共 352 颗。关键是**第二条带是反着接的**（接缝在最右边，所以第二条带的序号方向跟物理从左到右相反）。

双色带的用途**不是**「同一个音亮两颗」，而是：

- 下面那条（主灯带，176 颗）照旧显示**正在响的音**；
- 上面那条（上灯带，176 颗）显示**左手 / 右手各自的下一个音**（每只手 1 盏，共 2 盏）；
- 上灯带亮度 = 主灯带亮度 × **比例**（默认 70%），比例在**次级菜单（设置抽屉）**里能改。

**用户确认的 4 个决策**：① 反向换算 → **补偿，让两条带物理位置对齐**；② 上灯带亮度 → **相对主灯的比例**（默认 70%）；③ 「下一个音」→ **每只手各 1 个，共 2 盏**；④ 硬件 → **串联，一根数据线 352 颗**。

**索引空间**（最关键的一步）：

```
chain   0..175   主灯带 (下) —— 数据从**左**端进, 往右推; chain 序号 = 物理从左到右 = 音高从低到高
chain 176..351   上灯带     —— 数据从**右**端进, 往左推; chain 序号 = 物理从右到左 (倒叙)

key k (0..87)  →  主 [2k, 2k+2)      上 [350-2k, 352-2k)
```

补偿的含义：**主带第 x 颗 ↔ 上带第 (351 − x) 颗**。自检锚点：

| 键 | k | 主灯带 | 上灯带 | 物理位置 |
|---|---|---|---|---|
| A0 (21) | 0 | `[0,2)` | `[350,352)` | 最左 ✓ |
| C4 (60) | 39 | `[78,80)` | `[272,274)` | 中间偏左 ✓ |
| C8 (108) | 87 | `[174,176)` | `[176,178)` | 最右（两条带对接处）✓ |

> ★ **2026-10-30 实机标定（接线已确认，映射不用改）**
>
> 标定方法：实机点亮 chain `0`(红) / `175`(绿) / `176`(蓝) / `220`(青) / `264`(品红) / `308`(白)，再做一次两点定点验证（`176` 蓝 vs `350` 黄）。工具留在 `scripts/bt_pi/pc/calib_dual.py`（`off` / `grid` / `head-tail` 三个子命令）。
>
> **实测结果**：主带 `0`(红) 在物理最左、`175`(绿) 在最右 → 主带**正着接**；上带 `176`(蓝) 在物理**最右**、`350`(黄) 在**最左** → 上带**倒叙** ✓。两条带在物理**右**端对接（主带末端 → 上带进数据端）。
>
> 所以**上面那张表的反向补偿是对的，`upperRange()` 一行都不用改**。（中途一度以为上带是正着接、差点把补偿去掉 —— 是「坏灯在物理最左」这个观察把它钉死的：坏的是 chain 351，也就是上带 A0 那一对里的第二颗，正好在物理最左。）
>
> **坏的那颗灯不影响使用**：chain 351 是整条串联链的**最后一颗**，WS2812 串行传输下坏在末尾**不截断链**（后面的灯没有可断的），实测红/绿/蓝/青/品红/白全亮即为证。它属于上带 A0（最低音）那一对，所以 A0 的提示只会亮 1 颗而不是 2 颗 —— 最边上的键，忽略即可，**算法不用改**。


区间一律**左闭右开** —— 跟 `LedController.noteOn/noteOff` 里 `for (i = rng[0]; i < rng[1])` 的写法一致。**踩过的坑**：第一版 `stripRange` 写成了闭区间 `[2k, 2k+1]`，结果每个键只亮 1 颗（测试 `expected [78,79] to deeply equal [78]` 直接抓出来）。

**新文件 `src/led/dualStrip.ts`**（纯函数 + 无状态索引）：

- `LEDS_PER_STRIP = 176` / `stripRange(note)` / `upperRange(note)`（补偿后的**全局**上带区间）；
- `class NextNoteIndex` —— 按手分成两条**按时间有序**的数组，查询时二分找第一个 `time > t` 的音。

**为什么不用现成的 `LedScanCursor`（预扫描器）**：它只在 `isPlaying && offset !== 0 && followPlayback && enabled` 时才跑，而「下一个音」必须**暂停时**、**offset = 0 时**也能显示。也**不用可变游标** —— 拖进度条来回 seek 时游标状态容易错；二分是纯函数，任何时刻查出来的都对。

**手的判定**：用 `resolveHand(noteHand, noteTrack, song.hands)`（对「左右手同一条 track」的单轨谱返回 `undefined`，不瞎猜），返回 `undefined` 时**退回按音高切分** `midiNote < split ? 'left' : 'right'` —— 跟 `baseColor` 的兜底一致。为打破 `store → LedController → dualStrip → store` 的循环依赖，`noteHand` / `resolveHand` 从 `store.ts` 抽到新文件 `src/hand.ts`（store 再 re-export，公开 API 不变）。

**颜色 / 亮度**：复用现有 `baseColor(...)` —— 左手提示用左手色（蓝/绿），右手提示用右手色（红/橙），跟主灯带同一套配色语言。上灯带实际亮度 = `主灯带亮度 × 比例`，实现上是对 `baseColor` 的 RGB 三通道各乘 `brightness × ratio` 再 round。左右手下一个音是**同一个音高**时，两盏指向同一组 LED → 后写进去的右手色覆盖左手色（规则写死在注释里）。

**增量下发**（每 50ms 调一次，全量重刷会把树莓派打爆）：

1. 按 `upperHints` 算出「应该亮什么」→ `want`（≤ 4 个像素）；
2. 跟 `upperPixels`（**已经写到设备上的状态**）逐像素比 → `off`（要灭）/ `on`（要点亮）；
   - `off` 只包含「之前亮着、现在不想要了」的像素；**颜色变了的不用先灭** —— 直接覆盖写就行；
3. `setMany(off)` → `setMany(on)` → `show()`（树莓派 `set_many` 不自动刷，必须补 `show`；ESP32 的 `set_many` 自带 show，`show()` 里已有 `setManyShows` 判断）；
4. **写成功了才更新 `upperPixels`** —— 连接还没建好时不能把「已下发」记成成功，否则等连上了就再也不会补发。

**下发要排队**（`scheduleUpper`）：一次下发要走「灭 → 亮 → show」三次往返（BLE 上一次几十毫秒），而上层每 50ms 调一次 —— 不排队的话两次更新的差量会互相打架：老的那次后落地，设备上就留一颗「谁也不要的灯」，而且影子表以为它是对的，再也不会补发。排队之后同一时刻只有一次下发在飞，后面的排上队，差量按**执行时**的 `upperHints` 算（等于把中间的更新合并掉）。

`allOff()` 会清 `upperPixels` 但**不清 `upperHints`** → 下一轮 `setUpperHints` 自愈点亮。

**跑马灯帧时间跟灯数挂钩**（原来硬编码 5.3ms 是 176 颗的物理下限）：

> ⚠️ **2026-11-11（R31）更正**：帧时间**不跟逻辑灯数挂钩**，只跟**物理**链长度
> （恒定 352 颗 → 10.56 ms）。下面这段代码当时的方向就是错的 ——
> `marqueeFrameMs(count)` 收到的是逻辑 count。R31 已改成 `LED_PHYSICAL_COUNT = 352`。
> 见 §4.4 R31。

```ts
export const LED_FRAME_US = 30                                    // 每颗 30µs (WS2811 800kHz)
export function marqueeFrameMs(count: number) { return (count * LED_FRAME_US) / 1000 }
export function marqueeStep(count, targetMs = MARQUEE_TARGET_MS) {
  const maxFrames = Math.max(1, Math.floor(targetMs / marqueeFrameMs(count)))
  return Math.max(1, Math.ceil(count / maxFrames))
}
```

→ 176 颗还是 ~0.47s，352 颗也是 ~0.46s（步长自动变 4）。

**树莓派侧**（`scripts/bt_pi/pi/led_remote.py`）：

1. `DEFAULT_ALLOWED_COUNTS` 由 `(176,)` 改成 **`(176, 352)`** —— 否则前端 `init count=352` 直接被拒（`count 352 not allowed`）。
2. **换灯数必须先释放旧 strip**。`rpi_ws281x.PixelStrip` 把清理挂在 `atexit` 上 —— 只有进程退出才 `ws2811_fini + delete_ws2811_t`；老的 `ws2811_t` 还占着 **DMA 通道 10**，新建 strip 时 `ws2811_init` 会失败：
   `ws2811_init failed with code -6 (WS2811_ERROR_DMA)`。
   修法：建新 strip **之前**显式调旧 strip 的 `_cleanup()`（幂等 —— 它把 `self._leds` 置 None，atexit 再调一次是 no-op）。
3. **幽灵灯**：从 352 切回 176 时，物理链上半段（上面那条带）收不到新数据，WS2812 会保持上次的颜色。所以重建前**先用旧 strip 把整条物理链刷黑并 `show()`**。

**ESP32 限制（当时的）**：`firmware/esp32s3/` 的 `LED_COUNT = 176` 是**编译期常量** —— 双色带只对树莓派生效，选 ESP32 时前端自动退化成单灯带，UI 里明确写「双色带需要树莓派 (ESP32 固件固定 176 颗)」。
> ★ **2026-10-29 晚已解除** —— 见 **R13**：ESP32 固件的 `led.init` 现在也认 352 颗（白名单），前端对 BLE 后端同样开放双色带。

**改动清单**：

| 文件 | 改动 |
|---|---|
| `src/led/dualStrip.ts` (新) | `LEDS_PER_STRIP` / `stripRange` / `upperRange` / `NextNoteIndex` |
| `src/hand.ts` (新) | `noteHand` / `resolveHand`（从 store 抽出，打断循环依赖） |
| `src/led/LedController.ts` | `dualStrip` / `upperBrightnessRatio` 选项；`setUpperHints` / `clearUpperHints` / `setUpperBrightnessRatio` / `repaintUpper` / `applyUpper`（增量）；`marqueeStep` 跟灯数挂钩 |
| `src/store.ts` | `ledDualStrip` / `ledUpperBrightnessRatio` 状态 + setter + `PersistedPrefs` |
| `src/App.tsx` | `dualOn = ledDualStrip && ledBackend === 'ws'`；`count` 352/176；重建守卫加 `lastDualRef`；**每 50ms** 用 `NextNoteIndex` 推进「下一个音」提示 |
| `src/ui/LedDock.tsx` / `src/ui/SettingsDrawer.tsx` | 「灯带模式」两段式切换 + 「上灯带亮度」滑块（**只在双色带时出现**） |
| `scripts/bt_pi/pi/led_remote.py` | count 白名单加 352；换灯数先释放旧 strip + 缩灯前刷黑 |
| `tests/led_dual_strip.test.ts` (新) | 索引映射 3 + NextNoteIndex 5 + LedController 11 = **19 例** |
| `tests/led_dual_strip_ui.test.ts` (新) | 💡 浮窗 + ⚙ 抽屉两处的模式切换 / 滑块 / 落库 = **13 例** |
| `scripts/bt_pi/tests/test_led_reliability.py` | init 白名单 3 例 + 换灯数重建 3 例 = 6 → 合计 9 例 |

**验证**：

- `npx tsc -b` EXIT=0；`npm run build` PASS；`npm test` → **38 文件 / 364 用例全绿**（新增 32 例）。
- `python scripts/bt_pi/tests/test_led_reliability.py` → **9 OK**（新增 6 例）。
- **真机**（树莓派 192.168.1.113，176 灯）：`init count=352` → `{"ok": true, "count": 352}`，journal 出现 `READY led_remote count=352 pin=18` + `旧 strip (count=176) 已释放`；切回 176 → `READY led_remote count=176 pin=18`；连续切 4 轮，**journal 里 0 条 DMA / traceback**。
- **前端代码直连真机**（`scripts/bt_pi/pc/check_dual_strip.ts` —— 用前端**真正的** `WsTransport` + `LedController` 跑同一条链路，不开浏览器）：
  - `init → {"count":352,"pin":18}` ✓；
  - `set_many → 4 个像素: [{i:350,b:140},{i:351,b:140},{i:176,r:140},{i:177,r:140}]` —— **位置对得上**（A0 → 物理最左 350/351，C8 → 物理最右 176/177），**亮度 = 200 × 0.7 = 140** ✓；
  - 切回 176 ✓。

**不在本次范围**：ESP32 蓝牙双色带（要改固件重烧）；上灯带显示更多音（每只手 2 个 / 和弦）；上灯带单独做中央 C 校准（按物理位置对齐，不需要）。

---

#### R11 · 树莓派侧两个老隐患（pinmux 关键路径 fork + DMA 无看门狗）（2026-10-29）

**背景**：用户一直挂着两个 Pi 侧的隐患，这次一并处理掉。

##### 隐患 ①：`ensure_pinmux()` 在**持锁**的关键路径上 fork

以前 `show` op 里每 20 次 fork 一次 `pinctrl`：

```python
if self._show_count % 20 == 1:
    ensure_pinmux(self._pin)      # ← 持着 server._lock
```

`show` 是在**持锁**状态下调用的，而 `ensure_pinmux` → `_pinmux_ok` → `subprocess.run(['pinctrl', 'get', ...])` 是一次 **fork + exec**（10~50ms）。这段时间里**所有**别的命令（`ping` / `status` / `set`）全堵着 —— 灯带每帧都要 `show` → 大约每 0.7 秒就有一次 50ms 的全局停顿。前端表现就是偶发的「rpc init timeout」和整条灯带卡顿。

**改法**：挪到后台线程（`class PinmuxWatchdog`），间隔固定 3 秒（比原来「每 20 帧 ≈ 0.7s」**还稀疏 4 倍**），关键路径上一个 fork 都没有。

**为什么这个检查不能干脆删掉**：`rpi_ws281x` 只管 DMA，**不管引脚复用**。只要 GPIO 的 pinmux 被别的进程改成普通 input/output，`show()` 依然返回 ok，但 DIN 线上根本没有波形 —— **灯全黑，而服务端日志一切正常**（见 §4.4 R7 里的「pinmux 掉了」根因）。所以必须留着，只是换个地方跑。

**真机验证**（树莓派 192.168.1.113）：

```
$ pinctrl set 18 op && pinctrl get 18
18: op -- pd | lo // GPIO18 = output          ← 手动打断
$ sleep 8 && pinctrl get 18
18: a5    pd | lo // GPIO18 = PWM0_0          ← 看门狗自己修回来了
journal: WARNING GPIO18 pinmux 不是 a5(PWM0_0) —— 改回来
         INFO    GPIO18 pinmux 已恢复为 a5(PWM0_0)
```

##### 隐患 ②：`ws2811_wait()` 是**无限等待**，DMA 挂死 = 整个进程冻住

读 `rpi_ws281x` 5.0.0 的源码（`lib/ws2811.c`）确认：

```c
void ws2811_wait(ws2811_t *ledstring) {
    while ((dma->cs & RPI_DMA_CS_ACTIVE) && !(dma->cs & RPI_DMA_CS_ERROR)) {
        usleep(10);
    }
}
```

**没有超时**。（`render_wait_time` 容易被误当成超时 —— 它其实是「下一帧最早可以开始的时间」的节流值，默认 0，跟超时无关。）

更糟的是 SWIG 绑定**整个包里没有一处 `Py_BEGIN_ALLOW_THREADS`** → `ws2811_render()` 期间 **GIL 一直被持有** → DMA 一挂，**整个 Python 进程被冻住**（连别的线程都跑不了，更别说发心跳）。

**进程内自救不了 → 只能靠进程外的 systemd 看门狗**：

| 机制 | 实现 |
|---|---|
| 心跳 | `sd_notify("WATCHDOG=1")`，**每 5 秒**一次（`WATCHDOG_INTERVAL_S`） |
| 超时 | systemd `WatchdogSec=20s` —— 20 秒没收到心跳就 **SIGABRT** |
| 拉起 | `Restart=on-failure`（本来就有）→ 进程死了 systemd 重新拉起 |
| 通知权限 | `NotifyAccess=main` |

**三个必须踩准的点**：

1. **`sd_notify` 自己写**（`socket.AF_UNIX` + `SOCK_DGRAM` 发到 `$NOTIFY_SOCKET`），不引入 `python3-systemd` 之类的第三方依赖。`@` 前缀 = 抽象命名空间，要换成 `\0` 开头。
2. **心跳必须由主线程发**。systemd 在 `SCM_CREDENTIALS` 里拿的是发送方的 pid；**从线程发出去报的是 TID**，`NotifyAccess=main` 会当成「不是主进程」直接丢掉。所以心跳放在 accept 循环里发（主线程本来就闲）。
3. **accept 循环要改成 `select()` 驱动**，否则 `accept()` 一直阻塞着，主线程根本没机会发心跳。

**顺带加的**：`LedServer._render()` 把「正在 render」标记包在 `show()` 外面，`render_stuck()` 判断「这次 render 超过 3 秒还没回来」（正常一帧 176 颗 ≈ 5.3ms，352 颗 ≈ 10.6ms —— 3 秒已经天荒地老）。真卡死时**主动停发心跳**，让 systemd 更快接管，同时 journal 留一句 `render 卡住 (DMA 疑似挂死)`。

**systemd 侧改动**（`/etc/systemd/system/led-remote.service`）：

```ini
WatchdogSec=20s
NotifyAccess=main
```

**真机验证**：

- **systemd 支不支持 `Type=simple` + `WatchdogSec`？** —— 用一次性探针单元（`Type=simple` + `WatchdogSec=10s` + `NotifyAccess=main`，脚本 ping 3 次后停发）实测 **systemd 257 支持**：
  `Watchdog timeout (limit 10s)!` → `Killing process with signal SIGABRT` → `status=6/ABRT` → `Result=watchdog`。
- **真服务上线**：`WatchdogUSec=20s` / `NotifyAccess=main` 生效，**连跑 45 秒（两个看门狗窗口）PID 不变、`NRestarts=0`、journal 无 `Watchdog timeout`** —— 说明心跳真的送到 systemd 了。
- **端到端「冻住 → 被杀 → 拉起」**：写了一个一次性探针单元，跑**真正的** `led_remote.py`，只把 `rpi_ws281x` 换成假的（`show()` 里用 `ctypes.PyDLL(None).sleep(3600)` —— **`PyDLL` 不释放 GIL**，精确复刻 SWIG 挂死时「整个进程冻住」的行为）。实测：

  ```
  02:21:54 python3[2357]: render 开始 —— 模拟 DMA 挂死
  02:22:12 systemd[1]: led-hang.service: Watchdog timeout (limit 20s)!
  02:22:12 systemd[1]: Killing process 2357 (python3) with signal SIGABRT.
  02:22:12 systemd[1]: Main process exited, code=killed, status=6/ABRT
  02:22:15 systemd[1]: Scheduled restart job, restart counter is at 1.   ← 自动拉起
  02:22:15 python3[2453]: listening on 127.0.0.1:7778 ...              ← 新进程健康
  ```

- **链路回归**：用前端**真正的** `WsTransport` + `LedController`（不开浏览器）跑一遍 `init(176) → setMany → show → allOff → ping` → 全绿，确认改完 accept 循环之后链路没坏。
- 探针单元 / 脚本已全部清理（`led-hang.service`、`wd-probe.service` 已删除并 `daemon-reload`）。

**改动清单**：

| 文件 | 改动 |
|---|---|
| `scripts/bt_pi/pi/led_remote.py` | `sd_notify()`；`class PinmuxWatchdog`；`LedServer._render()` / `render_stuck()` / `pin` 属性；`show` op 不再 fork `pinctrl`；`main()` 改成 `select()` 驱动 + 心跳 + 启动 pinmux 看门狗；新增 `--pinmux-interval` / `--watchdog-interval` |
| `/etc/systemd/system/led-remote.service`（Pi 上） | `WatchdogSec=20s` + `NotifyAccess=main` |
| `scripts/bt_pi/tests/test_led_reliability.py` | 看门狗 3 例（show 不 fork / 卡死可识别 / 标记会清）+ `sd_notify` 2 例 + pinmux 看门狗 1 例 = **9 → 15 例** |

**回归测试**（`scripts/bt_pi/tests/test_led_reliability.py`）：

- `test_show_path_does_not_fork_pinctrl` —— 连发 50 次 `show`，断言 `ensure_pinmux` **一次都没被调**（关键路径上不能有 fork）。
- `test_render_stuck_detected_after_grace` —— render 超过宽限期才算卡；刚进 render 不算。
- `test_sd_notify_sends_to_notify_socket` —— 真发一个 unix datagram，验对端收到 `WATCHDOG=1`（Windows 上没有 `AF_UNIX` → skip；在 Pi 上会真跑）。
- `test_watchdog_checks_pinmux_periodically` —— 后台线程按间隔调 `ensure_pinmux`。

**不在本次范围**：把心跳改成 `Type=notify` + `READY=1`（现在 `Type=simple` 已经能开看门狗，没必要动）；把 pinmux 检查改成「变化时才 fork」（现在 3 秒一次，实测 CPU 占用可忽略）。

#### R12 · ESP32 灯带「闪烁 + 跑马灯快慢不对」= **固件**问题，不是下发指令问题（2026-10-29）

**结论先说**：下发链路是干净的。问题在 ESP32 固件的 **bit-bang 时序** —— 波形本身超出了 WS2811 的规格，芯片会把 0 读成 1（颜色乱 = 「闪烁」），而且每个 bit 周期被拉长 18~30%（跑马灯慢 40%）。

##### 第一步：先把「下发指令」这条线排除掉

用探针（`scripts/bt_pi/pc/` 系列的等价物）压了两条路径：

| 路径 | 做法 | 结果 |
|---|---|---|
| 设备侧 `led.marquee` | 一条命令，设备本地跑完 88 帧 | 往返 **715~717 ms**（设计目标 500 ms） |
| 前端回退路径 | 89 帧 `set_many`（不等回执，在途上限 6，按 MTU-3 切片） | 776 ms（8.71 ms/帧）—— 这是**固件还坏着的时候**测的：bit 周期 1.48 µs → 每帧 8.71 ms（理论 5.28 ms） |
| 重载 | 89 帧突发 + 120 条顺序命令后读 `status` | `bad_frames = 0, dropped = 0, rx_queue = 0` |

**一个帧都没丢、队列从没满过** → 链路和前端逻辑都没问题 → 是固件。

（两条路径都比 500 ms 慢，说明「跑马灯过快」那个印象其实反了：**是慢，不是快**。慢的根源见下。）

##### 第二步：量固件到底慢在哪

固件里加了一个 `diag` 第 6 步（`selfTest`），在**关中断**的环境里量真实的波形：

```
[diag6] cycle 读成本: rdcycle = 37 cycles, esp_cpu_get_cycle_count() = 26 cycles
[diag6] 轮询间隔 = 74~96 cycles (时序分辨率)
[diag6] bit 周期: 中位 354 / 最大 1968      (理论 300 = 1.25us)
[diag6] T0H = 136 cycles (理论 96, 上限 132)   T1H = 254 cycles (理论 192, 上限 228)
[diag2] show() = 6.85~7.16 ms                  (理论 5.28 ms)
```

**根因**：固件原来用 cycle 计数器**轮询**来等电平宽度。而 ESP32-S3 上**读一次计数器要 26~37 cycles**（`rsr.ccount` 的延迟），于是「等 high 结束」那个 while 循环的**轮询间隔是 74~96 cycles（0.3~0.4 µs）** —— 分辨率比 WS2812 的容差（±0.15 µs）还粗：

| 量 | 理论 | 实测 | 规格 | 判定 |
|---|---|---|---|---|
| T0H | 96 cycles (0.40 µs) | **136** (0.57 µs) | 0.25~0.55 µs | **超标** |
| T1H | 192 cycles (0.80 µs) | **254** (1.06 µs) | 0.70~0.95 µs | **超标** |
| bit 周期 | 300 cycles (1.25 µs) | **354** (1.48 µs) | 1.10~1.40 µs | **超标** |

- **T0H 超标** → WS2811 把 0 判成 1 → 颜色乱 → 用户看到的「闪烁 / 乱闪 / 常亮残灯」。
- **周期被拉长 18%** → 一帧 5.28 ms 变成 6.85~7.16 ms → 设备侧跑马灯 88 帧 = 717 ms 而不是 500 ms。

树莓派那条路没事，是因为它用 PWM+DMA **硬件**发波形，中断不影响时序。

##### 修法：用**校准过的延时循环**代替计数器轮询

```cpp
// 手写的延时循环: 每次迭代**固定**几条指令 (addi + nop + bnez + 延迟槽 nop).
// ★ 实测是 **5 cycles/次**, 不是 4 —— taken branch 要占一个延迟槽.
static __attribute__((noinline)) void delay_ticks(uint32_t n) {
  if (n == 0) return;
  __asm__ volatile("1:\n\t addi %0, %0, -1\n\t nop\n\t bnez %0, 1b\n\t nop\n\t" : "+r"(n));
}
```

时序模型：`delay_ticks(n) = 固定开销 + n × 每迭代 cycles`。四个延时迭代数（高0 / 低0 / 高1 / 低1）由**标定**得出。

**★ 这一版标定是被推翻重写的 —— 记下来免得再犯**（第一版是「两点求斜率 + 线性公式」）：

第一版：拿 `span(4000)` 和 `span(8000)` 两点求斜率 → `perIter = (bestB - bestA) / (N2 - N1) = 19999 / 4000 = 4`（整数截断！真值是 **5.000**）→ 再用这个斜率**外推**固定开销 → 固定开销被撑到 4026 cycles → 算出来的四个迭代数**全是 0** → **延时等于没有** → 灯带当然是乱的。

更糟的是**外推**本身：截距是用斜率从 N=4000 处外推的，斜率差 0.004 cycles/iter 就让截距差 16 cycles —— 那 16 cycles 又被当成「固定开销」扣掉，误差自我放大。

**现在的做法**（`ws2811_bitbang.cpp` 的 `calibrateTiming`）：

| 量 | 怎么得到 | 为什么这么定 |
|---|---|---|
| 读计数器的成本 | `measureEmpty()` —— 连读两次计数器取最小 | 每次测量都要扣掉它 |
| **固定开销** | `measureDelay(0)` —— **直接量** | 不再从别的点外推 |
| **每迭代 cycles** | `measureDelay(1000) − 固定开销`，**定点**（低 8 位是小数，`s_slopeFP`） | 定点存 → 5.004 这种值不会丢精度 |
| 高电平宽度 | `calibrateHigh()` —— **闭环**：量**线上**宽度，差多少就调多少迭代 | 线上宽度 = 延时 + 「写 GPIO + 调用函数」的开销，按公式算会偏一头 |
| **bit 周期** | `calibrateLow()` —— **闭环**：量**整帧**时间，反推低电平该多长 / 短多少 | 见下 |

**闭环是必须的，因为线上一个 bit 周期不只是「高 + 低」**：

```
线上 bit 周期 = 高电平 + 低电平 + 循环开销
                                  ↑ 从 outClr 到下一个 outSet 之间的所有指令
```

这个开销跟**循环代码本身**有关，所以标定必须跟实际发送**共用同一份代码** —— 现在 `show()` 和标定都调 `sendFrame()`。第一版里标定用的是一个「简化循环」，实际发送用另一个 → 减掉的数是错的 → 实测线上周期 **1.7 µs**（规格上限 1.4 µs），灯带照样乱。

**顺带把循环开销从 ~113 cycles/bit 压到 ~60**（每一条都是为了这个）：

- 四个迭代数**提到局部变量**（是全局变量的话每个 bit 都要 `l32r` + `l32i` 重新读）；
- **不复制**到 `bytes[3]` 栈数组 —— 直接 `px[b]` 读；
- 用「`nH0 + dH * one`」而不是位掩码选择 —— 少两个临时变量，编译器就不会把中间结果溢到栈上（之前 `sel` 溢到栈，每个 bit 多 12 条指令）。

**四个必须踩准的点**（每一个都实测踩过）：

1. **手写 asm，不能用 C 循环**。循环体里放 `volatile asm` 时，GCC 会把循环计数器**溢出到栈上**（存/取/加/比/跳 = **13 cycles/次**）；写成 `"+r"(i)`（读写操作数）也一样 —— GCC 认为 asm 改了 `i`，必须把它存回内存。只有**输入**操作数或纯手写 asm 能让计数器留在寄存器里。
2. **选延时时必须无分支**。one 的值是数据决定的，`if/else` 的分支预测失败每次罚 ~10 cycles，时序精度直接被打回「轮询间隔」那个量级。
3. **校准必须关中断测**。开着中断测的时候，**一次 BLE ISR 就能把「固定开销」从 ~20 cycles 撑到 3268 cycles** —— 算出来的迭代数全是 0，灯带直接不亮（这个坑真踩了一次：烧进去之后 diag6 显示 `迭代数: 高0=0 低0=0 高1=0 低1=0`、`bit 周期 35 cycles`）。
4. ★ **临界区里不能有 `Serial.printf`**。USB 串口是阻塞写，115200 波特率下一条 45 字节要 3.9 ms —— 关着中断打印会把中断看门狗（TWDT）憋爆：
   `Core 1 panic'ed (Interrupt wdt timeout on CPU1)`。
   修法：**临界区里只把测量结果存进数组**，打印放到 `portEXIT_CRITICAL` 之后。

**★ 还有一个整数除法的坑**：C 的整数除法是**向零取整**的 —— 闭环里 `-5 cycles / 5 cycles 每迭代 = -1`，但 `(-5*256)/1281 = 0` → 调整量变成 0 → **闭环卡在 305 不动**（实测）。负数要**减半再除**（`adjIters()`）才是远离零的取整。

**改动清单**：

| 文件 | 改动 |
|---|---|
| `firmware/esp32s3/src/ws2811_bitbang.cpp` | 新增 `delay_ticks` / `calibrateTiming` / `calibrateHigh` / `calibrateLow` / `measurePeriod` / `measureHighWidth` / `adjIters` / `sendFrame`（**show 与标定共用**）；`show()` 的 bit 循环改成无分支选延时；`selfTest()` 改成量**新的**延时路径；新增 `delayProbe()`（打原始测量曲线）+ `recalibrate()`（随时重标） |
| `firmware/esp32s3/src/ws2811_bitbang.h` | `selfTest` 的出参说明更新（9 个 → 14 个）；新增 `delayProbe` / `recalibrate` |
| `firmware/esp32s3/src/main.cpp` | `diag` 第 6 步打印新指标；新增 `dprobe` / `recal` 串口命令；顺手修掉 `delay(10000) // 10ms` 的注释错误 —— Arduino 的 `delay()` 单位是**毫秒**，那行实际睡了 10 秒 |

##### ★ 顺便写死的功耗上限：同时最多点亮 **30 颗**

用户明确要求：**「不要全部点亮！我正常用都不会超过 30 颗，把这个写死在固件里」**。

整条灯带（176 颗）全亮 = 176 × 60mA ≈ **10.5 A** —— 供电扛不住。实测中板子就是这么掉线的（烧完固件、灯带正常点亮之后，USB 直接掉线、CH340 从 Windows 的设备列表里消失）。

固件级上限（新文件 `firmware/esp32s3/src/led_limits.h`）：

```c
#define LED_MAX_LIT 30     // 写死, 不可配置
```

**怎么执行**：驱动在 `show()` 之前扫一遍像素缓冲，**点亮的颗数超过 30 时，把下标大的那些灭掉**（只留 30 颗），并且是**真的从缓冲里清掉**（不是只在这一帧盖掉）—— 缓冲里的状态跟灯带上看到的永远一致。

**为什么是「按颗数」而不是「按下标」**：按下标限（比如只有前 30 颗能亮）会把跑马灯从第 30 颗之后全灭掉 —— 跑马灯是「同时只亮 6 颗、从左扫到右」，它的亮灯**下标一直在变**。按颗数限则完全不受影响：跑马灯（同时 6 颗）、正常弹奏（≤ 30 颗）都原样工作，只有「176 颗全亮」这种病态情况才会被削。

**★ 换灯数（352 颗）不影响这个上限** —— 上限是「同时点亮多少颗」，不是「一共多少颗」。352 颗全亮 = 21 A，比 176 颗更危险，但一样被削到 30 颗（1.8 A）。

配套改动：

- 新文件 `firmware/esp32s3/src/led_limits.h` —— `LED_MAX_LIT` 的唯一出处，两个驱动和 `ble_led.cpp` 都从这里取。
- `Ws2811Bitbang` / `Ws2812Rmt` 两个驱动都加了 `applyMaxLit()`（RMT 是可选后端，一样要限）；它是 **public** —— 诊断命令要能在**不点灯**（零电流）的前提下单独调它。
- `ble_led.cpp` 的跑马灯窗口 `window` 也夹到 `LED_MAX_LIT` —— 否则窗口 > 30 时会被功耗上限「削掉一块」，跑马灯看起来就缺一段。
- `status` 现在会打印 `lit=<当前点亮颗数>/<上限>`，一眼能看出是不是被削过。
- 串口新增两条命令：
  - `captest` —— 把**缓冲**填满 176 颗，直接调 `applyMaxLit()`（跟 `show()` 里是同一份代码），报个数再清掉 —— **全程不 `show()`，电流为零**。为什么不直接「整条点亮」看效果：万一上限的代码有 bug，176 颗全亮 = 10.5 A —— 板子/USB 直接被拉垮（真机已经因此掉过一次线）。
  - `on30` —— 正好点亮上限颗数（30），肉眼确认「上限边界」是好的。

**前端不需要改**：前端的「测试」按钮跑的是跑马灯（同时只亮 6 颗），正常弹奏也就 ≤ 30 颗，本来就碰不到上限。

##### 顺带记一笔：PlatformIO 的工具链命名有坑

`toolchain-xtensa-esp-elf` 里的可执行文件叫 `xtensa-esp32s3-elf-gcc.exe`，但 `--version` / `-dumpmachine` 都报 Xtensa，ELF 的 `e_machine` 也是 94（`EM_XTENSA`）—— 但它编译出来的镜像 `chip_id = 9`（S3），flash 段 `load_addr = 0x3c080020`，**在片子上跑得好好的**。把 flash 读回来跟本地构建逐字节对比，完全一致 —— 结论是**打包命名的问题，不是 ISA 不对**，不用管。

##### 验证（2026-10-29 真机）

**固件烧录**：`pio run -e esp32s3 -t upload --upload-port COM5` —— 从「第 1 颗黄 + 第 10 颗红」的自检固件**刷回正常固件**（BLE 模式，广播名 `pianoflow`）。

**① 标定结果（开机日志，`[calib]` 四行）**：

```
[calib] 空跨度=18 固定开销=19 每迭代=5.004 cycles
[calib] 迭代数: 高0=13 低0=24 高1=33 低1=4
[calib] 延时 cycles: 高0=88 低0=143 高1=188 低1=43
[calib] ★ 线上 bit 周期: 0bit=299 1bit=299 (目标 300 = 1.25us, 规格 264~336)
[calib] ★ 线上高电平: 0bit=94 (目标 96, 规格 72~132) 1bit=194 (目标 192, 规格 168~228)
```

对照修复前 —— **三个指标全部从超标回到规格内**：

| 量 | 理论 | 修复前实测 | **修复后实测** | 规格 | 判定 |
|---|---|---|---|---|---|
| T0H（0 bit 高电平） | 96 cycles (0.40 µs) | 136 (0.57 µs) | **94** (0.39 µs) | 72~132 | ✅ 修复前**超标** |
| T1H（1 bit 高电平） | 192 cycles (0.80 µs) | 254 (1.06 µs) | **194** (0.81 µs) | 168~228 | ✅ 修复前**超标** |
| bit 周期 | 300 cycles (1.25 µs) | 354 (1.48 µs) | **299 / 299** (1.246 µs) | 264~336 | ✅ 修复前**超标** |

**② 帧时间**：`show()` = 4224 bit × 300 cycles + 300 µs latch = **5.63 ms**（理论 5.58 ms）。

**③ 跑马灯**（真机 BLE 探针，设备侧 `led.marquee`，窗口 6 / 步长 2 = 88 帧）：

| | 修复前 | **修复后** |
|---|---|---|
| 设备侧跑马灯总时长 | 715~717 ms | **522 ms**（88 帧 = 5.93 ms/帧） |

**④ 下发链路仍然是干净的**（修复前后都一样）：89 帧突发 + 120 条顺序命令之后读 `status` → `rx queue=0, bad_frames=0, dropped=0`。

**⑤ 功耗上限**：

```
ok captest 缓冲 176 颗 → 上限后 30 颗 (上限 30, 未发送)     ← 零电流验证
ok on30 lit=30/30                                          ← 边界值
status count=176 pin=14 bright=255 driver=bitbang lit=0/30  ← 全灭
```

**⑥ 构建**：`pio run -e esp32s3 -e esp32s3-selftest -e esp32s3-rmt` 三个 env 全部 SUCCESS（RAM 6.9% / Flash 10.3%）。

**⑦ 前端**：`npm run build` PASS；`npm test` → **39 文件 / 368 用例全绿**（新增 4 例 BLE 双色带，见 R13）。

> ⚠️ **一条测速上的坑**：用 `bleak` 的 `write_gatt_char(response=True)` 测「前端逐帧」路径，量到 ~326 ms/帧 —— 那是 **Windows BLE 栈 + bleak 逐包等写响应**的开销，**不是固件**。同一时刻固件自己的 `status` 报 `bad_frames=0, dropped=0`，设备侧跑马灯也只有 5.93 ms/帧。浏览器（Web Bluetooth）走的是整包写，不在这个坑里。

---

#### R13 · ESP32 固件也支持双色带（352 颗）——灯数改成**运行期**可配（2026-10-29）

**用户要求**：「另外应该和 pi 一样 最大支持两列的 而不是 176 个的吧？」

**背景**：R10 做双色带时，ESP32 那一侧是**做不了的** —— `LED_COUNT = 176` 是**编译期常量**，`ble_led.cpp` 的 `led.init` 直接把 `count != LED_COUNT` 的请求**拒掉**。而双色带要用的正是「两条灯带串联 352 颗」。

**做法**：跟树莓派端 `led_remote.py` 的 `DEFAULT_ALLOWED_COUNTS` 一个思路 —— **灯数改成运行期可配，但必须白名单**。

| 位置 | 改动 |
|---|---|
| `firmware/esp32s3/src/ble_led.h` | 新增 `LED_ALLOWED_COUNTS`（= `LED_COUNT, (LED_COUNT * 2)` = **176 / 352**）；新增 `bool ledStripSetCount(int count)` |
| `firmware/esp32s3/src/ble_led.cpp` | `ledStripSetCount()` —— 白名单校验 + 换灯数（换了就重建像素缓冲）；`led.init` 改成**认 count**，不在白名单里直接回 `count not allowed` |
| `firmware/esp32s3/src/ws2811_bitbang.cpp` | `begin()` 先 `free()` 旧缓冲再分配（不释放的话每切一次模式泄漏 `count×3` 字节）；**标定只做一次** —— 时序跟灯数无关，重标一遍还会往灯带上打 8 颗全白 |
| `firmware/esp32s3/src/ws2812_rmt.cpp` | `begin()` 同上，另外把旧的 RMT 通道 / 编码器 / 符号缓冲一起释放（换灯数时重建） |
| `firmware/esp32s3/src/main.cpp` | 串口新增 `count <176\|352>` 命令（换完灯带全灭）；索引范围检查和 `status` 都改成用**当前的** `strip.count()`，不再用编译期常量 |
| `src/App.tsx` | `dualOn = ledDualStrip`（**不再只限树莓派**）；BLE 传输层的 `count` 跟着走 176 / 352 |
| `src/ui/LedDock.tsx` / `src/ui/SettingsDrawer.tsx` | 去掉「双色带需要树莓派 (ESP32 固件固定 176 颗)」的提示 |
| `tests/helpers/esp32Model.ts` | 假设备也按固件的规则来：`led.init` 的 count 走白名单，换灯数就重建缓冲 |
| `tests/led_dual_strip_ble.test.ts`（新） | 4 例：init 176 / 352 / 999 被拒 / 上灯带下标 176..351 可写、352 越界被拒 |

**为什么白名单必须保留**：count 直接决定 `malloc` 的大小 —— 不白名单，一条 init 就能让固件申请任意大的缓冲（65535 颗 = 196 KB 白占着，再大就 malloc 失败）。

**功耗上限不变**：`LED_MAX_LIT = 30` 是「**同时点亮**多少颗」，跟总灯数无关 —— 352 颗的灯带上一次也只亮 30 颗（1.8 A）。352 颗全亮本来是 21 A，正是最需要这个上限的场景。

**帧时间自动跟随灯数**：352 颗 = 8448 bit = **10.56 ms/帧**（176 颗是 5.28 ms）。前端的 `marqueeStep(count)` 已经按灯数算步长（352 → step=8，44 帧 ≈ 0.46 s，跟 176 颗一样快）；固件侧的 `marqueeRun()` 用的是 `g_strip.count()`，换灯数后自动跟着变。

> ⚠️ **2026-11-11（R31）更正这段**：**「帧时间跟随灯数」是错的** ——
> 帧长由**物理**链长度决定（两台设备都恒定 352 颗 → 恒定 10.56 ms），
> **逻辑 count 只决定「允许写哪几颗」**，不影响帧长。
> 前端因此把 176 颗当成 5.28 ms → 步长取 2 → 88 帧 → 「0.5 秒」实际跑 0.93 秒。
> 现在帧时间一律按物理 352 颗算（176 → step 4 / 352 → step 8，都是 44 帧 ≈ 0.46 s）。
> 固件侧的 `marqueeRun()` 用 `g_strip.count()`（= 物理颗数）**本来就是对的**。
> 见 §4.4 R31。

**验证（真机，COM5 + BLE 探针）**：

| 步骤 | 结果 |
|---|---|
| 串口 `count 352` | `ok count=352` ✓ |
| 串口 `count 999` | `err count 999 not allowed` ✓（灯带保持 352 不变） |
| 串口 `count 176` | `ok count=176` ✓ |
| 串口 `captest` | `缓冲 176 颗 → 上限后 30 颗 (上限 30, 未发送)` ✓ |
| BLE `led.init count=176` | `{"ok":true,"result":{"pin":14,"count":176}}` ✓ |
| BLE `led.init count=352` | `{"ok":true,"result":{"pin":14,"count":352}}` ✓ |
| BLE `led.init count=999` | `{"ok":false,"error":"count not allowed"}` ✓ |
| BLE `led.status`（352 状态） | `{"initialized":true,"pin":14,"count":352,"brightness":255}` ✓ |
| BLE `led.set index=350`（上灯带） | `{"ok":true,...}` ✓ |
| BLE `led.set index=352`（越界） | `{"ok":false,"error":"index out of range"}` ✓ |
| BLE `led.litcount` | `{"lit":1,...}` ✓（只点了那一颗） |

**构建**：`pio run -e esp32s3 -e esp32s3-selftest -e esp32s3-rmt` 三个 env 全部 SUCCESS。

**不在本次范围**：ESP32 的双色带**物理验证**（真机上接两条串联的带、确认上带索引跟物理位置对齐）—— 需要硬件到位；固件侧的地址空间跟树莓派完全一样（同一套 `dualStrip.ts` 换算），索引层面已由前端用例钉住。

---

#### R14 · 灯带语义重订：**灯 = 画面上那条正在落下来的音条**（2026-10-30）

**用户要求**：

> 「你需要认真的理解灯带的意义，现在会出现已经弹过的残留，设置里面不是有一个提前量嘛 提前量的那段时间能否做成一个颜色逐渐变亮的效果，正常落到键盘的时候就是设置的100%亮度」
>
> 「加一个feature 如果某一个音我弹了，那么这个灯的亮度就减半，音条小时的时候一定要确保消失」

**旧语义的三处毛病**（都是这一条抱怨的根）：

| 旧行为 | 用户看到的现象 |
|---|---|
| 提前量只平移**开灯**事件，亮度一步到位 100% | 灯提前亮得跟落地时一模一样，看不出「还有多久落键」 |
| 灭灯走**推迟**逻辑：用户没弹 → 灯一直留着当提示 | **已经弹过的残留** —— 一个弹错的音条把灯永久占住 |
| 灭灯跟**发声时值**走（`note.time + duration`） | 灯比画面上的音条活得久 → 灯和画面对不上 |

**新语义**（`src/led/scanCursor.ts` + `src/types.ts`）：

```
开灯 = note.time - 提前量            (提前量 > 0 才提前; 负数 = 整段延后)
灭灯 = note.time + NOTE_BAR_LIFETIME_S   ← 音条从画面上消失的那一刻
亮度 = 提前量窗口内 15% → 100% 渐亮
       落键后未弹 = 100%
       弹过了     = 50%
```

**关键改动**：

| 位置 | 改动 |
|---|---|
| `src/types.ts` | 新增 `NOTE_BAR_LIFETIME_S = 0.5` —— **渲染和灯带共用同一个魔数**（音条画到 `dt < -0.5` 就不画了；灯也在这一刻灭）。两边各写一个数的话，改一边另一边就漂 |
| `src/led/scanCursor.ts` | ① 灭灯事件改成 `note.time + NOTE_BAR_LIFETIME_S`；② **删掉整个「推迟灭灯」机制**（`deferred` map + `isRequired` 回调 + `lightDown` 的补灭分支）—— 用户没弹，灯照样到点就灭；③ 新增 `levelOf(idx, nowMs, offsetMs, isPlayed)`：提前量窗口内线性渐亮（`RAMP_START_LEVEL = 0.15` → 1），落键后按「弹没弹过」给 1 或 `PLAYED_LEVEL = 0.5` |
| `src/led/LedController.ts` | 新增 `setIntensity(midi, v)` / `getIntensity(midi)` + `intensity` 表；像素写出改成「手色 × 亮度 × 亮度系数」；`setIntensity` 会补一次 `show`（树莓派 `set_many` 只写 buffer，不 show 不刷） |
| `src/App.tsx` | 预扫描推进时按 `quantizeLevel(cursor.levelOf(...))` 量化成 **8 档**（`LEVEL_STEPS`）再下发 —— 渐亮过程不用每帧改像素，省 LED 流量；灭灯时把强度复位成 1 |
| `src/led/emit.ts` | **播放层的 LED 一律由 pre-scanner 独占**（`isPlaybackSuppressed()` 直接 `return true`）。以前只有「提前量 ≠ 0」时才交给 pre-scanner，提前量为 0 时 Player 直发 —— **两套逻辑各写各的**，亮灯时机 / 灭灯时机 / 亮度都不一致，切一下开关行为就变。`setPlaybackLedOffset()` / `getPlaybackLedOffset()` 随之删除 |

**为什么提前量不能改变「灯活多久」**：提前量是**提示**（让用户提前知道要弹哪个键），不是**欠账**（用户没弹就吊着灯）。要提示「还没弹」，该由画面上的音条 + 键盘上的目标键颜色承担（R17），不该由灯带承担。

**验证**：`tests/scanCursor.test.ts`（重写，13 例）+ `tests/led_switch_clear.test.ts`（11 例）+ `tests/led_force_wait.test.ts`（11 例）；`npm test` → 41 文件 / 404 用例全绿。

---

#### R15 · 跟弹判定统一到「音符落键那一刻」（2026-10-30）

**用户要求**：

> 「现在的跟弹似乎是有bug 需要等音符落到钢琴键的上沿时才触发 现在有的悬在半空中的也触发了」

**根因**：判定基准被**提前量**拉走了。`Player` 在 LED 提前量 > 0 时会调 `PlayAlong.rebaseNote(idx, note.time - 提前量, ...)`，把该 note 的判定基准提前到「灯亮的那一刻」—— 音符还悬在半空中就判命中了。用户看到的现象：提前量越大越容易「白捡」命中。

**改法**：

| 位置 | 改动 |
|---|---|
| `src/engine/PlayAlong.ts` | **删掉 `rebaseNote()`**。判定基准永远是 `note.time`（音符落键那一刻）。新增 `setEarlyWindowMs(ms)`：提前量只用来**多给一个「提前按」的容差窗口** —— 提前按的按键在窗口内不会被 expire 掉，等音符落键时照样能匹配上（delta = 0）。`update()` 里 recent 的过期窗口改成 `max(命中窗口, 提前按窗口)` |
| `src/engine/Player.ts` | 不再 rebase 判定基准；改成每帧把提前量窗口（`ledOffsetUnits × 100ms`）同步给 `PlayAlong.setEarlyWindowMs()` |
| `src/store.ts` | `ledForceWait` 的语义**重订**：从「LED 亮起就暂停在那个音上」改成「**灯亮时可提前按**」—— 提前按被记住，等音符落键时结算。名字保留（旧设置项别动，用户不用重新学） |

**取舍**：提前按**仍然**算命中（用户看到灯亮了才按，手慢是常态），但它不再**改变**音符的判定时刻 —— 判定线跟画面上的音条上沿对齐 = **判定 = 画面所见**。

**验证**：`tests/playAlong.test.ts` + `tests/led_force_wait.test.ts`（提前按 → 落键时命中；悬在半空不判）。

> ★ **2026-11-05**：R14/R15 这套「提前按」机制随「提前按」独立模式一起删掉了 —— `setEarlyWindowMs(0)`（窗口恒为 0, `recent` 的过期时间 = 命中窗口）、`store.ledForceWait` 与 `EarlyPressToggle` 一并删除。见 §4.4 R23。

---

#### R16 · 曲终清空灯带 + 跑马灯测试后不再回亮（2026-10-30）

**用户要求**：

> 「播完曲子 应该清空灯带，现在点了测试 跑马灯后还会有灯重新亮起来最终」

**两个症状，两个根因**：

1. **曲终不灭**：暂停时的「当前键位预览」会把用户此刻停在的那组音点亮 —— 曲子放完了也照亮。新增 `songEnded(song, t)`（取**所有**音里最晚结束的那个，不信 `notes[]` 数组顺序），曲终 → `clearPreview()`。
2. **跑马灯后回亮**：跑马灯期间 follower 只记状态不写灯带；跑完后 resume 时会按「记下的状态」把旧灯**重新点亮**。修法：跑马灯结束后立刻 `followerNow.clearAll()`。

**改动**：

| 位置 | 改动 |
|---|---|
| `src/App.tsx` | 新增 `songEnded()`；`applyPreview()` 里加曲终分支；跑马灯 `finally` 里 `followerNow.clearAll()`；另外加了 `reseekScanCursor()` —— 恢复播放 / 跑完跑马灯后把 pre-scanner 游标重新对齐到当前时间（**还在画面上的音条**，灯就该亮）。注意调用前要先把 follower 状态清干净，否则两边计数叠上 → 灯灭不掉 |
| `src/led/scanCursor.ts` | `flush()` 保持「灭掉 pre-scanner 点的所有灯」这个出口（播放层的灯只有 pre-scanner 能灭） |

**验证**：`tests/led_switch_clear.test.ts`（切歌 / 曲终 / 跑马灯后灯带为空）。

---

#### R17 · 虚拟键盘音名标号 + 「等你弹」的键上色（2026-10-30）

**用户要求**：

> 「在虚拟钢琴键盘上你需要打上 D3 之类的标号 我不认识（做成可设置的 放在设置界面） 同时（等你弹xx时 需要在该键渲染一个颜色 让我好找）」

| 需求 | 实现 |
|---|---|
| 键上标音名（用户不认识键名） | 新增 `src/render/keyLabels.ts`：`labelForMidi(midi, mode)`（标的是**键自己的音名**，跟画在同位置的音符标签对得上）、`whiteKeyLabelSize()`（按白键宽度缩放，7~11px）、`blackKeyLabelSize()`（黑键窄 → 竖排 + 更小字号） |
| 可设置 + 放设置界面 | `KeyLabelMode = 'off' \| 'c' \| 'all'`，**默认 `'all'`**；`store.keyLabels` + `setKeyLabels()`（落 `localStorage['piano-follow.prefs.v1']`）；设置抽屉里一行三段按钮「不标 / 只标C / 全标」 |
| 「等你弹的键」上色 | 冻结等待时把目标键染成琥珀色 `rgba(251, 191, 36, 0.55)`（`drawWaitHint`）；**移调后染的是 transposed 那个键**；目标超出键盘范围 → 不染也不报错 |

**细节**：「只标C」模式只标每个八度的 C（最省空间，但也能定位八度）；黑键的标号**竖着写**（横排塞不下）。

**验证**：`tests/key_labels.test.ts`（22 例：纯逻辑 / 画布渲染（假 ctx 断言真的画了字、键真的被染色）/ store 落库 / 设置抽屉 UI）。

---

#### R18 · 「梦中的婚礼」曲库文件修复（2026-10-30）

**用户要求**：

> 「重新找一下开源的梦中的婚礼 现在的有bug」

**先说结论**：网上**没有**可免费直下的开源《梦中的婚礼》MIDI（bitmidi / midicities / midiworld / freemidi / everyonepiano / GitHub 全试过 —— 见表下「找过但没拿到」）。但**旧文件本身并不是孟德尔松的《婚礼进行曲》** —— 它弹的就是《梦中的婚礼》（= Mariage d'amour，Paul de Senneville & Olivier Toussaint，Richard Clayderman 的成名曲），g 小调，双 track（RH 696 音 / LH 466 音 / 共 1162 个音 / 180.7 秒）。**音符数据是对的，坏的是「容器」和「标注」**。

**旧文件的四个毛病**（`public/library/pop/wedding-march.mid`）：

| # | 毛病 | 用户看到的现象 |
|---|---|---|
| 1 | track 0 的曲名是 **GBK 字节**（"梦中的婚礼"），而 `@tonejs/midi` 用 `String.fromCharCode` 按 **Latin-1** 解码 | 顶栏曲名显示乱码 **「ÃÎÖÐµÄ»éÀñ」** |
| 2 | track 0 里塞了 **31 个互相矛盾的拍号**（3/4、7/8、6/8、12/8、9/8 … 交替） | 拍子随时在变，小节线/五线谱对不上 |
| 3 | 清单把它标成 "Wedding March / F. Mendelssohn / **C major**" | 曲名、作曲家、调全错 |
| 4 | 文件名 `wedding-march.mid`、id `wedding-march` | 搜「梦中的婚礼」搜不到 |

> 根因 1 的连带效应：`src/library.ts:69` 是 `if (!song.title) song.title = item.title` —— **MIDI 内嵌的曲名优先于清单里的 curated 标题**（代码注释写的正好相反）。所以乱码曲名会一路顶到顶栏。曲名本身在 MIDI 里只能是 Latin-1 能解码的字符，中文没法靠改文件解决。

**修法**：**音符数据一个字节不动**，只重写容器和标注。

| 位置 | 改动 |
|---|---|
| `public/library/pop/mariage-d-amour.mid`（新） | track 0 重写为：曲名 `Mariage d'amour`（纯 ASCII，不再乱码）+ copyright + tempo 833333µs（72 BPM）+ **单个 4/4 拍号** + 调号 Bb（2 个降号 = g 小调）；**track 1/2 原样搬运**（mido 逐条复制 message，音符数据零改动）。用 `mido` 读写（`C:/Users/<用户>/anaconda3/python.exe` 里已装） |
| `public/library/pop/wedding-march.mid` | **删除**（git 历史里还在） |
| `public/library/manifest.json` | `pop` 组那一条改成：`id: marriage-d-amour` / `title: Mariage d'amour` / `subtitle: 梦中的婚礼 · Paul de Senneville / Olivier Toussaint (双 track MIDI)` / `composer: Paul de Senneville, Olivier Toussaint` / `key: G minor` / `file: pop/mariage-d-amour.mid` |
| `tests/library_mariage.test.ts`（新） | 6 例回归：曲名干净（且不含 Latin-1 高位字符）、只有一个 4/4、72 BPM、keyFifths = −2、**音符数据跟旧文件一致**（1162 音 / RH 696 + LH 466 / 180.7s / 55 小节 / two-tracks）、清单标注正确、旧文件已删 |

**为什么 keyFifths = −2 而不是「g 小调」**：`parseMidi.keySignatureToFifths()` 只认**大调拼法**（`Bb` → −2，`g` → undefined）。MIDI 的调号事件本来也只编码升降号个数（2 个降号），`Bb major` 和 `g minor` 是同一组音 —— 写 `Bb` 既能被本项目读出来，也跟 track 1/2 原本就有的 `key_signature key='Bb'` 一致。清单里人读的那一栏写 `G minor`。

**验证**：`npm test` → 41 文件 / 404 用例全绿（新增 6 例）；`npm run build` PASS；`parseMidi` 实测输出与旧文件**逐项一致**（除曲名与拍号）：`duration 180.70826105 / notes 1162 / measures 55 / hands {left:1,right:0} / handInfer two-tracks(high) / bpms 72`。

**找过但没拿到（免得下次重复找）**：bitmidi（9 个候选文件下下来跟目标旋律做指纹比对，最好命中 14/25 个音程，都不是）；midicities / midiworld / freemidi / midi4u（无直链）；everyonepiano（滑块验证码 + 付费）；GitHub code search（401 / repo search 限流）；百度 / bing（JS 渲染 + 验证码）；CSDN / aigei（403 / 521）。

**不在本次范围**：`src/library.ts` 的「MIDI 曲名优先于清单曲名」这个**既有**行为没有改（改了会影响全部乐库条目的顶栏标题）—— 乱码已在源头修掉。

---

#### R19 · 双色带插上第二条带 → **整条刷白**（≈10 A）：帧长必须按物理链发（2026-10-30）

**用户报告**：

> 「我现在连着双排led 当前测试跑led只有第一条有反应 第二条插上亮了特别多的灯（先看看咋回事 关掉 怕电流太大）」

**根因**：WS2812 是**串联**的 —— 服务端发出去的比特流如果**比物理链短**，后面那条带收不到自己的数据，移位寄存器被空闲高电平填满 → **整条带全白**。

当时的配置：物理链 = 2 条 × 176 = **352** 颗，但服务端的 `--auto-init` 用默认 `DEFAULT_COUNT = 176` → **只发 176 颗的帧** → 第二条带（chain 176..351）整条刷白。176 颗全白 ≈ **10 A** —— 这正是用户怕的事。

> 顺带解释「只有第一条有反应」：前端当时在**单灯带模式**（`ledDualStrip = false`），跑马灯只覆盖 0..175 —— 那是对的行为；第二条带的异常全白是上面的 bug。

**修法**：把「灯数」拆成两个概念 ——

| 概念 | 含义 | 谁决定 |
|---|---|---|
| **物理帧长** `physical_count` | 帧里发多少颗 = 物理链上有多少颗 | 服务端（`--physical-count 352`，默认 `DEFAULT_PHYSICAL_COUNT`） |
| **逻辑可寻址长度** `count` | 客户端能写哪几颗 | 客户端 `init` op（白名单 176 / 352） |

**发得比物理链长是安全的**（多出来的比特没人收），**发得比物理链短才危险**。所以服务端永远按物理链发帧。

| 位置 | 改动 |
|---|---|
| `scripts/bt_pi/pi/led_remote.py` | ① 新增 `DEFAULT_PHYSICAL_COUNT = 352` + `--physical-count` 参数 + `LedServer(physical_count=...)`；② `_init_strip()` 现在**永远按物理链建 strip**，客户端 init 的 count 只改「逻辑范围」；③ **换 count 不再重建 strip** —— 顺带根治了老问题「重建撞 DMA 通道 10」（`WS2811_ERROR_DMA (-6)`）；④ 逻辑范围缩小时（352 → 176）把**超范围的那几颗刷黑**（否则上面那条带留幽灵灯）；⑤ `off` 清**整条物理链**（不是只清逻辑范围）；⑥ `status` / `init` 回包加 `physical` 字段；⑦ `set` / `set_many` 的越界检查仍按**逻辑**范围（单灯带模式不许写上灯带） |
| `scripts/bt_pi/pi/led-remote.service` | `ExecStart` 加 `--physical-count 352`（让硬件事实写在 unit 里，不靠默认值） |
| `scripts/bt_pi/tests/test_led_reliability.py` | 旧的 `LedStripRebuildTest`（换 count 要重建 + 刷黑）换成 `LedPhysicalFrameTest`（7 例）：物理 strip 长度 = 352（不管逻辑 count 多少）/ 换 count 不重建 / 逻辑缩小刷黑超范围 / `off` 清整条 / 越界写被拒 / `show` 推满 352 颗的帧 |

**前端不用改**：单灯带模式时前端只写 0..175 → 第二条带收到的是真 0 → 保持黑的 ✓；双色带模式时前端 `init count=352` → 逻辑范围 352 → 上灯带可写 ✓。

**验证（真机）**：

| 步骤 | 结果 |
|---|---|
| 服务重启 | `READY led_remote count=176 (逻辑) physical=352 pin=18` ✓ |
| `init count=176` | `{"ok":true,"count":176,"physical":352}` ✓（帧长仍是 352） |
| `set i=200`（逻辑 176 时） | `{"ok":false,"error":"i 200 out of [0, 176)"}` ✓（单灯带模式写不到上灯带） |
| `init count=352` + 点 4 颗标定 | 0=红 / 175=绿 / 176=蓝 / 351=黄，用于物理确认两条带的方向 ✓ |
| `python scripts/bt_pi/tests/test_led_reliability.py` | **19 OK**（1 skipped：Windows 没有 AF_UNIX） |

**没做（也不该做）**：没在真机上验证「两条带物理位置对齐」的补偿换算 —— 那要人看着灯带确认（见下面的物理标定）。

---

#### R20 · 第二条灯带的「清除」不干净 —— 残留（2026-10-30）

**用户报告**：

> 「第二条灯带的清除做的不好有残留」

**根因：上灯带没有状态机**。主灯带走 `LedFollower`，有 `suspended / pressed / previewed / clearAll` 四态 —— 清完就是清完，直到真有事件才重画。上灯带没有：App 的提示 effect **每 50ms 无条件下发一次 `setUpperHints()`**，而 `applyUpper()` 是按 `upperHints` **无条件重算**的。于是：

```
t0   allOff()          → 物理灯全灭 ✓
t0+50ms setUpperHints(同样的提示) → applyUpper 重算 → 又点回来 ✗
```

结果就是：**主灯带清得掉，第二条带清不掉**（跑马灯期间提示还会被点进动画帧里 → 跑完残留一串乱闪的灯）。

**修法：给上灯带补一个「武装 / 解除武装」状态**（`src/led/LedController.ts`）：

| 字段 | 含义 |
|---|---|
| `upperArmed` | 「已武装」= 允许点亮。**熄着**期间，提示内容**不变**就不许自己回来；内容真的变了（下一个音推进 / 跳到别处 / 换歌）才重新武装并点亮。`connect()` 重新武装（重连后设备端是空的，得重画一遍） |
| `upperHold` | **硬让路**：跑马灯这种独占动画期间，提示内容变了也不写（否则它会重新武装自己、把提示点进动画帧里） |

**「熄着」在哪几处生效**（这是本条最关键的口径，踩错过一次）：

| 场合 | 要不要熄着 | 理由 |
|---|---|---|
| 跑马灯跑完 | **要** | 动画独占，跑完不该留提示（`testPattern` 的 `finally` 里熄） |
| 曲终 | **要** | 用户要求「播完曲子清空灯带」；App 曲终分支显式 `clearUpperHints()` |
| 关掉双色带 / 断连 | **要** | `clearUpperHints()` |
| `allOff()`（物理清零） | **不要** | 它是「物理清零」，语义跟主灯带一样：**恢复播放 / 切换跟随源 / 跳转 / 换歌**都走这条路，那些地方上灯带应该继续显示提示（或换成新歌的提示） |

> ★ **踩过的坑**：第一版把「熄着」放进 `allOff()` 里 —— 结果**加载新歌后第二条带再也不亮**（App 切歌的顺序是「先下发新提示 → 再 allOff」，`allOff` 把刚下发的提示熄掉了，而上层每 50ms 下发的**内容没变** → 再也回不来）。同理「恢复播放」也会把提示熄掉。**结论：`allOff` 不能熄，只有「清完就该黑」的那两处（跑马灯 / 曲终）才熄。**

配套：

| 位置 | 改动 |
|---|---|
| `src/led/LedController.ts` | 新增 `sameHints(a, b)`（比 midi + hand）；`setUpperHints()` 只在**内容变了**时才 `upperArmed = true`；`clearUpperHints()` 清提示 + 熄着；`applyUpper()` 里 `canLight = upperArmed && !upperHold`（不武装 → 只灭不亮）；`connect()` 重新武装；`testPattern()` 整个包在 `upperHold` 里，`finally` 里 `upperHold = false; upperArmed = false`（跑完保持熄灭），并且把开头那条裸的 `rpc('off')` 换成 `await this.allOff()`（裸 `off` 只清物理、不清前端的记账 → 差量算出来「没变化」→ 提示再也回不来） |
| `src/App.tsx` | 曲终分支（`songEnded`）补 `ledRef.current?.clearUpperHints()` —— 第二条带跟着一起清掉并保持黑 |
| `tests/led_dual_strip.test.ts` | 6 例回归：`allOff` 后提示**自愈回来**（物理清零 ≠ 熄着）/ `clearUpperHints` 后全灭且上层不再下发就保持熄灭 / `clearUpperHints` 后上层重新下发 → 重新点亮 / **切歌顺序**（清旧的 → allOff → 下发新的 → 点亮）/ 跑马灯后上灯带不残留（内容变了才回来）/ 重连后重新点亮 |

**语义边界（有意为之）**：`clearUpperHints()` 之后，上层**再下发一次有内容的提示** = 一次**新的显式请求** → 会重新点亮。

**验证**：`npx vitest run` → 41 文件 / **409 用例**全绿；`python scripts/bt_pi/tests/test_led_reliability.py` → 19 OK；`npx tsc -b` 无错。

---

#### R21 · 第一排只亮「当前这一组」+ 第二排显示接下来 N 个（2026-10-31）

**用户报告**：

> 「基本上差不多了 不过用起来需要改一下需求 第一排只显示当前弹的或在跟弹模式下需要弹的那个 现在有的时候会同时亮好几个音 这样不对 而第二排则要展示下 2 到 N 个 可以设置 并且放在首页 并且亮度根据下面第几个依变弱 之前让你写的渐变的可以暂时不用了 这样当我卡壳时我会明确知道当前该是什么 以及从第二条灯带知道后面要弹什么 提前滞后那里也可以解耦 当前应该不需要了」

**四个决策（用户确认）**：

| 问题 | 决策 |
|---|---|
| 「一组」怎么算？ | 同一时刻的**所有** note（两只手同时按 = 一组，一起亮）—— 用户原话：「有些谱子同一时间可能要按两个音，所以只跟谱子当前时间有几个音来看，不是按和弦」 |
| 第二排显示几个？ | **每只手各 N 个**（N 可设，2..6） |
| 亮度怎么递减？ | **每往后一个 ×0.65** |
| 提前 / 滞后？ | **从灯带解耦**，滑块先隐藏 —— 灯不再提前亮，也不再渐亮 |

**① 第一排的语义重订**（`src/led/scanCursor.ts`）

| | 旧（R14） | 新（R21） |
|---|---|---|
| 开灯 | `note.time − 提前量` | **`note.time`** |
| 灭灯 | `note.time + 音条寿命 (0.5s)` | **`min(下一组开始, note.time + 0.5s)`** |
| 提前量 | 影响开灯 + 渐亮 | **完全解耦**（App 固定传 0） |

「组」= **同一时刻的所有 note**。灭灯时刻 = **下一组开始的时刻** —— 也就是说：**任何时刻最多只有一组灯亮着**（用户报的「同时亮好几个音」）。BWV 846 那种右手十六分音符密集的曲子，从前是「两三个音同时亮着」，现在一次只有一组。

**跟弹模式不用特殊处理**：跟弹卡住时，歌曲时间**冻在**要弹的那个音的精确时刻上（`Player.freezeAt`）→ 下一组永远不会开始 → 要弹的那盏灯一直亮着 ✓。「卡壳时明确知道当前该是什么」这个需求就自动满足了。

**② 提前量解耦**

- App 的 pre-scanner effect 固定传 `offsetMs = 0`（渐亮代码留在 `scanCursor.ts` 里没删，以后要用再打开）；
- `store.ledOffsetUnits` 现在**什么都不影响**（2026-11-05：「提前按」独立模式删掉, 判定窗口恒为命中窗口）—— 原先是只影响 `Player.earlyPressWindowMs()`；
- 滑块 `src/ui/LedOffsetControl.tsx` **删除**（用户：「滑块先隐藏」），练习栏里那一行也去掉。

**③ 第二排（上灯带）显示接下来 N 个**

- `NextNoteIndex.at(t, count)` 改成返回左右手**各 count 个**接下来的音（`{ left: SongNote[], right: SongNote[] }`）；
- 亮度按位置递减：`level = UPPER_LEVEL_FALLOFF ** i`（`UPPER_LEVEL_FALLOFF = 0.65`），最终颜色 = `baseColor × 主灯带亮度 × 上灯带比例 × level`；
- 同一个 midi 在两只手里都出现 → 保留**更亮**的那个（平手取后一个 —— 保持原来「右手色覆盖左手色」的行为）；
- N 的取值 **2..6**，可设，**放在首页**（💡 浮窗 `LedDock`）+ 设置抽屉（`SettingsDrawer`）两处都有，落库 `store.ledUpperNoteCount`；
- **上限为什么是 6**：上灯带 4N 颗 + 主灯带的一组 ≤ 30 颗 —— 30 是 ESP32 固件的 `LED_MAX_LIT`（176 颗全亮 = 10.5 A，会把 USB 拉垮；固件超限时先杀高序号像素 → 上灯带会被砍掉）。

**④ 连带修的一处：`LedFollower` 的灭灯 grace**

`LedFollower` 对所有源都用 60ms 的 off-grace（压真实键盘 `note_on(velocity=0)` / `note_off` 的竞态）。但**播放源**（pre-scanner）的灭灯是精确的 —— 下一组已经在**同一帧**点亮了，再等 60ms grace 会让**两组灯同时亮着** 60ms。改成：**grace 只留给输入源**，播放源立即灭。

**改动清单**

| 位置 | 改动 |
|---|---|
| `src/led/scanCursor.ts` | 新增 `groupEndTimes()`（导出）：每个 note 所在「组」的结束时刻 = 下一组开始；`build()` 里灭灯时刻改成 `min(下一组开始, note.time + 0.5s)`；文件头的语义说明整段重写 |
| `src/led/dualStrip.ts` | `NextNoteIndex.at(t, count)` → 左右手各 N 个；新增 `UPPER_MIN_NOTES = 2` / `UPPER_MAX_NOTES = 6` / `UPPER_LEVEL_FALLOFF = 0.65` |
| `src/led/LedController.ts` | `LedHint` 加 `level?: number`；`sameHints()` 也要比 `level`；`applyUpper()` 里颜色乘 `level`，同 midi 取**更亮**的那个 |
| `src/led/LedFollower.ts` | off-grace 只对 `source === 'input'` 生效；播放源立即灭 |
| `src/store.ts` | 新增 `ledUpperNoteCount`（默认 3，夹 2..6）+ setter + 持久化 |
| `src/App.tsx` | pre-scanner 固定 `offsetMs = 0`；上灯带提示改成左右手各 N 个 + 逐级递减的 `level`；删掉 `LedOffsetControl` |
| `src/ui/LedDock.tsx` / `src/ui/SettingsDrawer.tsx` | 新增「上灯带显示 N 个/手」分段按钮（2..6）+ 说明文字；灯带模式的说明文字改成「下面那条显示当前该弹的音，上面那条显示左右手接下来要弹的音」 |
| `src/ui/LedOffsetControl.tsx` | **删除**（滑块隐藏） |
| `tests/scanCursor.test.ts` | +4 例：连着落的音 → 上一组在下一组开始时就灭 / 同一时刻的多个音 → 一起亮一起灭 / 旧组一起灭新组一起亮 / 长休止 → 音条消失就灭 |
| `tests/led_dual_strip.test.ts` | +4 例：每只手各 N 个 / `level` 让颜色变暗 / 同 midi 取更亮的 / `level` 变了要重画 |
| `tests/led_dual_strip_ui.test.ts` | +5 例：两处 UI 都有 N 这一行（2..6 档）/ 点档位落库 / prefs 越界夹到 6 |
| `tests/led_follower.test.ts` | +1 例：播放源不等 grace、输入源还是等 grace；原「最后一个 note 结束后灯正常灭」改成断言**立即**灭 |
| `tests/led_score_vs_lights.test.ts` | +1 例：任何时刻最多只有一组音亮着；真值模型（`tests/helpers/ledHarness.ts`）按新语义重写（开灯 = `note.time`，灭灯 = 下一组开始，播放源 offset 固定 0） |

**验证**：`npx vitest run` → 41 文件 / **424 用例**全绿；`python scripts/bt_pi/tests/test_led_reliability.py` → 19 OK；`npx tsc -b` 无错。

---

#### R22 · 「梦中的婚礼」的拍号被 R18 拍平了 —— 真身是 44 小节的变拍（2026-11-01）

**用户报告**：

> 「项目里的梦中的婚礼的midi感觉不太对 …… 你可以先读一下midi看看对不对 我觉着有点问题」

**先说结论**：**R18 改错了**。它把 track 0 里那 31 个拍号变化当「乱码/损坏」拍平成单个 4/4 —— 但那 31 个拍号**是真的**，就是这首曲子的变拍记号（4/4 → 3/4 → 7/8 → 6/8 → 12/8 → 9/8 …）。拍平之后小节线整体错位：**真值 44 小节被算成 55 小节**。另外查出 **4 个真正损坏的音符**（R18 只核对「音符数据零改动」，所以没发现它们）。

**三个真问题**

| # | 问题 | 证据 | 用户看到的现象 |
|---|---|---|---|
| 1 | **31 个拍号被拍平成 4/4** | 原始件 track 0 里有 32 个 time signature 事件；逐个验算，**31 个变化点全部正好落在小节线上**（`段长 % 小节长 === 0`），且后半段把前半段的拍号顺序整个重复了一遍（二段式） | 小节线 / 五线谱跟音乐对不上；导航到小节指错位置；节拍器强弱拍错位 |
| 2 | **2 个音符 onset 偏离 16 分网格** | RH `D6(86) @ tick 7703` 和 `@ tick 63863`，`tick % 120 = 23`（16 分网格 = 120 tick）；而且这两个 note-on 在 MIDI 事件流里是**倒序写入**的（tick 比前一条事件还晚） | 弹到那两个音时灯 / 音条提前或滞后 23 tick，判定容易判错 |
| 3 | **2 个 D7(98) 破调** | `D7(98) @ 7920` 和 `@ 64080` —— 98 是**全曲唯一超过 C7(96) 的音**，只出现这 2 次，且都夹在上面的坏簇里；D7 在 bB 大调里是 #VI 级（临时色彩音） | 多出一个突兀的高音，跟重复段的旋律对不上 |

> **「31 个拍号变化全部落在小节线上」是关键证据** —— 如果是乱码 / 损坏，变化点会随机散落在小节中间；全部对齐小节线 = 这些拍号是导出器认真写下来的。

**旁证**：联网找到的正规谱（saomaicenter 的 MusicXML 元数据）标着 **44 小节 / 2 个降号 / g 小调**，跟按拍号还原后的结果完全对上。

**修法**：新增 `scripts/fix_mariage_midi.mjs`（纯 Node，无第三方依赖），从原始下载件 `downloads/梦中的婚礼.mid` **重建**曲库文件 —— 不是打补丁，是重新生成。

| 位置 | 改动 |
|---|---|
| `scripts/fix_mariage_midi.mjs`（新） | 自带 SMF 读写器：读 MTrk → 展开 running status → 音符按 (channel, pitch) FIFO 配对 → 写回新文件；末尾自检（修完不得再有 off-grid onset / 不得再有 >96 的音），并打印逐条修复记录 |
| `public/library/pop/mariage-d-amour.mid` | 恢复全部 **32 个拍号**；tempo 只留 track 0 的 833333µs（72 BPM），删掉 track 1/2 里混入的 120 BPM 事件；key −2 (bB)；曲名 `Mariage d'amour` + text meta 写曲家；**EOT 补到 104088**（原来 track 0 的 EOT 停在 102000，比最后一个音早 2159 tick）；删 2 个 off-grid 的 D6；2 个 D7(98) **降八度**成 D6(86) |
| `src/types.ts` | `SongMeasure` 加 `numerator?` / `denominator?`；`Song` 加 `timeSignatures?: { time, numerator, denominator }[]` |
| `src/util/tempoMap.ts` | 新增 `computeMeasuresFromSignatures(ppq, signatures, ticksToSeconds, endTicks)` —— **在 tick 空间切小节再换算成秒**（拍号变化点落在哪个 tick 是文件里写死的，先换成秒再切会累积误差）；另加 `measureBeatPoints()` / `hasVariableTimeSignature()` —— 变拍曲子的**拍网格**（见下面「③ 节拍器也得跟着变」） |
| `src/parser/parseMidi.ts` | 读**全部**拍号（原来只取 `timeSignatures[0]`）；`signatures.length > 1` 走新函数，否则保持旧 `computeMeasures` 路径 → **其它 20+ 首曲库文件零影响** |
| `src/render/StaffView.tsx` | 新增 `measureTimeSigOf(song, idx)`：每小节用它自己的拍号（`numBeats` / `beatValue` / `expectedQuarters` / `buildStaveNotes`），**只在拍号变化处**画 time signature |
| `src/engine/Player.ts` | 节拍器排程分叉：变拍曲子走 `scheduleMetronomeVariable()`（拍点来自按小节拍的网格，强拍 = 小节第一拍）；`resetMetronomeCursor()` 跟着 seek 重置 |
| `src/render/FallingNotes.tsx` | 左侧节拍器小圆点同样按小节拍号出点（`beatPointsOf()` + WeakMap 缓存），不再用全曲固定拍号 |
| `src/ui/SettingsDrawer.tsx` | 拍号一栏多拍号时显示 `4/4 → 3/4 → …` |
| `public/library/manifest.json` | subtitle 改成「…（双 track MIDI · 原曲变拍 4/4→3/4→7/8→6/8→12/8→9/8，44 小节）」 |
| `tests/library_mariage.test.ts` | 重写为 **12 例**：32 个拍号 / 44 小节且首尾相接 / 1160 音 / RH 694 + LH 466 / 只有一条 72 BPM / onset 全在 120-tick 网格 / 最高音 96 无 98 / 全在调内 / 清单标注 + **拍网格**（强拍落在小节线上 / 每小节按自己的拍号出拍） |

**③ 节拍器 / 拍网格也得跟着变**

小节线改对之后，节拍器如果还用「全曲固定 4/4 的四分音符网格」，就会跟新的五线谱对不上 —— 6/8 小节里只落 3 个点（每个点都在八分音符的中间），9/8 里落 4 个半，强拍（每 4 个四分音符一次）也会打到小节中间。

修法：**拍点按每小节自己的拍号切**（`measureBeatPoints()`）—— 沿用项目原有口径「一拍 = 分母音符」，所以 6/8 的一拍是八分音符、12/8 的一拍也是八分音符；强拍 = 小节第一拍。`Player.scheduleMetronome()` 和 `FallingNotes` 左侧的小圆点都改走这条网格。

**只有变拍曲子走新路径** —— `hasVariableTimeSignature()` 为真才启用；整首一个拍号的 20+ 首曲库文件走的还是老的连续拍网格，**行为一个字节都没变**。

**修完的音符数据 diff**：与原始件逐个 tick / pitch / duration / velocity 比对，**只有那 4 处**，其余完全一致 —— 1162 音 → **1160 音**（RH 696 → 694，LH 466 不变）。

**查过但确认不是 bug（没动）**

| 现象 | 结论 |
|---|---|
| 音符时值普遍是槽位的 90%（108 / 216 / 324 / 648 tick，LH 461/466 个是 216 而不是 240） | **源文件自身的「断奏」写法**（staccato / portato），不是损坏 —— 改掉会把曲子弹得粘连 |
| RH 音高只有 G A B♭ C D E♭ F，全在 bB 大调内 | 旋律本身是对的（就是 Mariage d'amour，RH 全程 16 分音符） |
| RH 696 → 694 | 只删了那两个 off-grid 的 D6 |

**验证**：`npx vitest run` → **42 文件 / 447 用例**全绿（本文件 12 例）；`npx tsc -b --force` EXIT=0；`npm run build` PASS。

**网上仍然没有可直下的正版《梦中的婚礼》MIDI/MXML**（musescore / mymusicsheet / notenhac / archive.org / midishow 全被 Cloudflare 挡住或不可达；saomaicenter 的 `.mxl` 已 404）—— 但这次**不需要**了：曲库文件是从原始下载件**重建**出来的，容器和那 4 个坏音都修好了。

#### R23 · 抢先模式：弹对了才推进 + 冻在「现在该弹的那一组」上（2026-11-05 首版 / 2026-11-08 重订 / 2026-11-10 再修订）

**用户需求**（2026-11-05 原话）：

> 「我想增加一种模式，把跟弹 wait 模式的后面加一个可选框 逻辑如下 灯带是显示下一个音 而不是当前的 如果我按下之后就直接灭掉切下一个音的提示 如果我弹一个音 那么瀑布自动下落到下一个音 即允许抢拍」

**2026-11-08 用户重新复述**（这一版才是当前实现）：

> 「抢先模式是在 waiting 模式下允许我提前按按键但是不进行报错并且灯继续往前提示的功能。在右手模式下 比如我右手要顺着谱子按 1 2 3 当我按下 1 时 1 的灯就在第一排就应该暗下来 然后就是亮 2……前提是我已经正确按了 1 而不是直接跳转。同时如果我有自己的旋律感 也可以不按照谱子的节奏用正确的顺序按右手 你只要保证右手顺序正确就行。也即右手的 ui 下落音符可以提前按照正确的顺序点亮 但是曲子的整体节奏及下落顺序不变化。而对应双手模式 只要是按照顺序，如果左右手的都超前了 那 ui 也加速下落 不要太生硬做一个加速动画。」

**2026-11-10 用户实测反馈**（原话）：

> 「我切换到模式抢先 完全不会停下来对的音」

指的是 2026-11-08 那版把抢先模式的**冻结整个关掉了**（`冻结条件加 !leadMode`）：播放头一直往前走，瀑布永远在下落，灯带提示永远追不上 —— 「停下来对」这个最基本的动作做不了，Wait 也退化成空壳。

**2026-11-05 那版为什么作废**：灯带显示「**下一个**音」+ 弹对后播放头**直接跳**到下一个音 —— 两条都不对：

1. 灯带显示下一个音 → 用户按下 1 时，亮着的其实是 2，「按对了灯也不灭」；
2. 播放头直接跳 → 用户没按对也能跳（用户原话「前提是我已经正确按了 1 而不是直接跳转」），而且是硬跳。

**当前语义（四条铁律）**

| # | 规则 | 落点 |
|---|---|---|
| 1 | **提前按不报错** —— 弹的不是当前待弹的音 → 什么都不做（不判错、不计分） | `Player.handleInput()` 抢先分支**直接 return**，根本不进 `PlayAlong.userPress()` |
| 2 | **灯一直亮到弹对为止** —— 不超时自动跳过、不自动记漏弹 | `syncLead()` 里**没有**超时分支；`required` 不登记 → `PlayAlong` 不会判 miss |
| 3 | **判定不受容差影响**，也不查「上一轮弹过的键」 | 命中只看「是不是当前待弹的那一组」，**完全不看时间**；不进 `recent` → 旧键不会被检索回来 |
| 4 | **冻在「现在该弹的那一组」上**（2026-11-10 补回） | 冻结点 = 游标指到的待弹组的**精确**谱面时间（`leadFreezeTarget()` + `freezeAt(..., forceTarget)`）；弹对了才解冻，按 **1×** 走到下一个待弹组再冻上 |

> 铁律 3 是老 bug 的根因：`PlayAlong.recent` 是「按早了先记着」的机制 —— 上一轮弹过的键留在 `recent` 里，这一轮按别的键会被判成 `'wrong'`（弹错误提示），旧键还可能被检索回来误命中这一轮。抢先模式**整个绕开** `recent`。

> 铁律 4 的冻结点**不能**用 `PlayAlong.required` —— 抢先模式根本不往 `required` 里登记（否则两个判定基准打架）。所以冻结点自己算：每只手各有一个待弹组，取最早的那个（`leadFreezeTarget()`）。

**一条路（不再分双手 / 单手）** —— 2026-11-10 起，抢先的语义对两只手和一只手**完全一样**：

| | 当前语义 |
|---|---|
| 冻结 | **冻在「现在该弹的那一组」的精确谱面时间上**（跟 Wait 一样） |
| 解冻 | **弹对了**才解冻 → 播放头按 **1×** 走到下一个待弹组 → 再冻上 |
| 倍率 | **恒为 1** —— 曲子的整体节奏 = 谱面原速（不等你）；「等你」靠的是**冻住**，不是加速 |
| 谁推进 | 弹对了 → **那只手**的游标往前挪（两只手各一个游标，互不干扰） |
| 第一排灯带 | **每只手各一盏** —— 玩家那只手亮「现在该弹的那一组」；伴奏那只手亮「正在响的那一组」 |
| 伴奏 | 单手练习时伴奏 1× 原速；双手练习全静音（跟原来一样） |
| 漏弹判定 | 无（弹对才推进，不超时） |

> **2026-11-08 那版「跟着玩家速度走」的加速公式整段删掉**：它跟「停下来对」是直接冲突的 —— 播放头一直走 → 就永远停不下来。`SongClock.setRate()` / `getRate()` 的机制**保留**（`Player` 现在恒 `setRate(1)`），但抢先模式不再动它。

**改动（2026-11-08）**

| 位置 | 改动 |
|---|---|
| `src/engine/Clock.ts` | 新增 `rate` 倍率（跟 `speed` 分开）：`setRate(r)` / `getRate()`，夹在 [0.25, 4]；`songTime()` / `advance()` / `toCtxTime()` / `toSongTime()` 都乘上 `rate` |
| `src/led/leadStrip.ts` | 提示改成**按手**：`LeadHint { hands: LeadHandHint[] }`，`LeadHandHint { hand, time, notes }`；`diffLeadHints` 按 **(midi, 手)** 配对 —— 同键双手各占一个灯位 |
| `src/engine/Player.ts` | 抢先模式整段重写：① 每只手一个游标（`leadCursor` / `leadGroup` / `leadGroupTime` / `leadDone`）；② `leadPress()` 只认「当前待弹的那一组」，不看时间、不查 `recent`、不报错；③ `syncLead()` 无超时；④ `refreshLeadHint()` 把组里**已弹对**的音剔掉（和弦弹了一个 → 那个音的灯就灭）；⑤ ~~`onLeadHit()` 改成「节奏项 + 位置项」算目标倍率（不再挪播放头）~~（**2026-11-10 删**）；⑥ ~~`updateLeadRate()` 指数平滑~~（**2026-11-10 删**）；⑦ `markHit()` 在抢先模式下一律 dt=0 → 算 perfect；⑧ 记账循环在抢先模式下**不**登记 `required`（否则两个判定基准打架）；⑨ ~~冻结条件加 `!leadMode`~~（**2026-11-10 撤掉** —— 抢先重新冻结，见下表）；⑩ `skipLeadNote()` 两条路都接管 |
| `src/App.tsx` | 第一排按 `diffLeadHints(hint)` 差分驱动（用 `n.midi` + `n.hand`，同键双手各占灯位）；上灯带的查询基准时间**按手**取（提示音时间 − 0.001s） |
| `src/render/FallingNotes.tsx` | 「等你弹」的琴键琥珀色高亮不再被 `frozen` 挡住（抢先模式不冻结，但照样要提示） |

**改动（2026-11-10 · 把冻结找回来 + 顺带修的一串 bug）**

| 位置 | 改动 |
|---|---|
| `src/engine/Player.ts` | ① **冻结点自己算**：`leadFreezeTarget()` 取最早的待弹组 → `freezeAt(..., forceTarget)` 冻在它的**精确**谱面时间（不是 `required` —— 抢先不登记 `required`）；② 冻结分支里补 `syncLead()` —— 冻结把 `currentTime` 挪了，伴奏那组的提示要按新位置重算；③ `syncLeadModeState()`：**开 / 关**抢先模式 → 重置游标并立刻重新定位（否则开模式的这一帧算不出冻结点）；④ 开模式时 `playAlong.resetPass()` —— 上一轮 Wait 留下的 `required` 会变成**幽灵漏弹**；⑤ **切手别**（右手→左手）→ 重置游标重新定位，否则游标还停在另一只手的音上；⑥ `leadSkipped` —— Backspace 跳过的音记下来（切手别 / 开关模式时不会「复活」又要求你弹一遍）；⑦ 倍率恒为 1（`clock.setRate(1)`），加速那套删掉；⑧ `handleInput()` 忽略 `source === 'lead'` —— 提示灯是 App 发的状态投影，被当成玩家按键就**白送一个命中** |
| `src/types.ts` | `NoteSource` 加 `'lead'` —— 抢先的提示灯走**独立通道**，不再混在 playback 里 |
| `src/led/emit.ts` | 新增 `emitLedLead(midi, on, hand?)` —— 提示灯专用的事件源 |
| `src/led/LedFollower.ts` | ① 跟随源过滤放过 `'lead'`（抢先的灯是「该弹哪个」的状态投影，不是声音 → 「只看输入」的用户也得看得见）；② 同键两手：这只手松了但**另一只手**还按着 → 只灭这只手，别把灯整个灭掉 |
| `src/led/LedController.ts` | `lit` 改成按 **(midi, 手)** 记账 —— 一只手松手 / 被关掉，不再误伤另一只手的灯；`setHandEnabled` 开回来能恢复 |
| `src/App.tsx` | ① 抢先的灯从「跟随乐谱」那个 gate 里**挪出来**（先于 gate 判断）→ 抢先的提示灯不再受「跟随乐谱」开关影响；② `leadHintRef` 差分 + **自愈**：灯带被刷黑（测试图案 / 编辑器）后，提示还能重新点亮 |
| `src/ui/LeadToggle.tsx` + `src/store.ts` | 文案改成冻结语义（「播放头冻在现在该弹的那一组音上 / 弹对了才解冻 / 提前按不报错」） |

**已知取舍**

1. **单手模式伴奏手的灯是「正常显示」**（正在响的那一组）—— 伴奏手在曲子的空档里那一盏灯会灭；要关掉某只手有 `store.ledHandLeft` / `ledHandRight`（用户 2026-11-08：「正常显示即可 如果要关我有设置可以关」）。
2. **和弦整组弹全才推进** —— 但组里**已弹对**的那盏灯会先灭（不必等整组）。
3. **倍率恒为 1**（2026-11-10）—— 曲子的整体节奏 = 谱面原速，**不等你**；「等你」靠冻住播放头实现。代价：想按自己的速度弹（比谱面快）时，得靠自己一路弹对把播放头「拖」着走 —— 每弹对一个才往前走一段。（用户 2026-11-08 想要的「跟着玩家速度走」跟 2026-11-10 想要的「停下来对」互斥，这次选了后者。）
4. **谱面数据里同一时刻的重复音**（同手同键）算**两个** note —— 一次按键两个 note 都算命中（命中数跟谱面音符数对得上，准确率不失真）。
5. **Backspace / Delete 跳过当前音**：跳过**最早**那个待弹组（一只手卡住不影响另一只手）；不算漏弹；播放头 / 伴奏都不动。
6. **物理按住不放的键不会被「检索回来」**（2026-11-10）—— 这是铁律 1「提前按不报错」的代价：你提前按住了这个键，等游标走到它时**不会**自动算命中（要松开再按一下）。踩过这个坑的替代方案（按住即自动命中）会破坏铁律 1，**没做**。
7. **歌曲可能「永远不结束」** —— 冻结 + 不记漏弹 = 弹不完就停在那儿（这是用户要的行为：弹错/不弹就卡住等你，不是自己滑过去）。

**同期删除：「提前按」独立模式**（2026-11-05）

抢先和「提前按」原来是两个可并存的开关（`store.ledForceWait` + `forceWait?: boolean` + `src/ui/EarlyPressToggle.tsx` + `src/led/handQueue.ts`）。用户选了**保留抢先、删掉提前按**（两者逻辑冲突：一个要「弹对了才推进」，一个要「灯亮了就能提前按」）。连带删除：

| 位置 | 删掉的东西 |
|---|---|
| `src/store.ts` | `ledForceWait` 状态 + `setLedForceWait` + `PersistedPrefs.ledForceWait` |
| `src/App.tsx` | `<EarlyPressToggle />` + 队列扫描循环 + `applyEarlyQueue` |
| `src/ui/EarlyPressToggle.tsx` | 整个文件 |
| `src/led/handQueue.ts` | 整个文件（队头音计算） |
| `src/led/LedFollower.ts` | `setQueueHints()` + `queued` 集合（只有「提前按」用得到, 删完没人调） |
| `src/engine/Player.ts` | `earlyPressWindowMs()`（窗口恒为 0 —— `PlayAlong.setEarlyWindowMs(0)`） |
| `tests/` | `tests/led_early_press.test.ts` + `tests/led_force_wait.test.ts` + harness 里的 `forceWait` 选项 |

**验证**：`npx vitest run` → **65 文件 / 675 用例**全绿（`tests/lead_mode.test.ts` 34 例 = 提示形状 5 + 推进 6 + 容差 5 + 冻结 5 + 单手 8 + 门控 3；`tests/lead_strip.test.ts` 9 例；`tests/led_shared_key.test.ts` +2 例 = 同键两手的手的粒度）；`npx tsc -b` EXIT=0。

用例把用户点名的每条不变式都钉住了：① 第一排**同时有左手和右手的灯**；② 灯**必定正确按下后**才灭（不超时、不记漏弹）；③ 判定**不受容差**影响（容差调到 2000ms 提前按「后面那个音」也不算命中）；④ **上一轮弹过的键**不会被检索回来干扰这一轮；⑤ **播放头冻在待弹组的精确谱面时间上**，弹对了才解冻往前走、再冻上；⑥ 一直不弹就**一直冻着**（不超时、不记漏弹）；⑦ 倍率**恒为 1**；⑧ 双手时左手弹对**不会**放掉右手那组的冻结；⑨ 单手伴奏 ctx 间隔恒为 1.0s。

#### R24 · BWV 1041 钢琴独奏版重做（用户：「不好听 没有美感」）（2026-11-05）

**用户反馈**（原话）：

> 「不好听 没有美感」

指的是上一轮交付的三个 BWV 1041 钢琴独奏版（`bwv1041-piano-chords` / `-rhythmic` / `-bass`）。

**v1 为什么不好听**（`scripts/reduce_bwv1041_piano.mjs`，已删）：

1. **素材错了** —— v1 读的是曲库里那份把 6 条弦乐轨并成一坨的 "Strings" 轨（2634 个音，声部关系全丢），再把音高量化到**均拍网格**上，用一组「和弦模板」去拟合每个格点；
2. **和弦是空壳** —— 大三和弦模板硬套，46/294 个和弦**没有三音**（听着像摇滚 power chord）；
3. **平行八度/五度** —— 75/256 处左手跟旋律同向同量地走，糊成一团；
4. **没有织体** —— 左手被挤在 36..55 一条窄带里，音区永远不变，力度恒定 72；
5. **真实走路低音被吃掉了** —— 原谱大提琴 603 个音（含 144 个十六分音符）的线条全被网格抹平。

**关键事实**：原谱里根本没有这些问题 —— 实测原谱大提琴对旋律只有 **1 处平行五度**、中提琴只有 **1 处平行八度**，那是巴赫写的，不是合成出来的。

**v2 的做法：不再合成，只做「重新配器」**

素材换成仓库里的**原始 6 声部 MIDI**（`tests/fixtures/midi/Bach Concertos Bwv 1041 Violin Concerto N 1 1 Mov.mid`），新读法在 `scripts/lib/bwv1041.mjs`：

| 版本 | 左手是什么 | 适合谁 |
|---|---|---|
| `bwv1041-piano-v2-chords` | 大提琴真实走路低音 + 由**原谱实际响过的音高**推出的三和弦 | 想听「钢琴伴奏」的感觉 |
| `bwv1041-piano-v2-ensemble` | 原谱大提琴 + 中提琴两条**真实声部**，只做八度折叠 | 想要巴赫原版的织体 |
| `bwv1041-piano-v2-bass` | 只有原谱大提琴一条线 | 最简单，最好跟弹 |

**右手 = 曲库里已发布的 Solo Violin 轨，逐字节复制**（`soloChunkBytes()`）—— 用户要求的「右手不动」是字面意义的，一个字节都没改。

**三条关键规则**

1. **不新造音级** —— 大提琴/中提琴只做**八度折叠**（加/减 12，不改 pitch class）；和弦版用到的每个音级原谱都响过（测试逐音级验）；
2. **拼写要按调号** —— 这首曲子只用升号，所以任何需要降号的和弦（C 小调的 E♭、G 小调的 B♭、F♯dim7 的 E♭）在原谱里**不可能出现**，拟合时直接排除（`spellable()`）—— v1 那个凭空冒出来的「Cmin/G」就是这么来的；
3. **和弦音不许跟旋律平行五度/八度** —— 上一段的和弦音跟当时的旋律正好差八度、而旋律这一动走了 d 个半音时，新和弦音**不能**落在「上一段那个音 + d」上（禁音表 `banned`）。这条修掉了 v1 的 46 处平行八度，也是「机器人感」的主要来源。

**另外两处结构性修正**

- **和声分析窗口按节奏单位对齐**（`HARMONIC_UNIT = 1.0` 拍）—— 滑动窗口每看一步内容都不同 → 和弦每步一变（机关枪）；对齐后同一拍里共用一个窗口；
- **同一格里用第一个低音定和弦** —— 窗口一样但参考的低音不同还是会换和弦，改成整格共用一个。

**结果**（`node scripts/reduce_bwv1041_piano_v2.mjs --preview`）：

| 指标 | v1 | v2 |
|---|---|---|
| 撞小二度（左手 vs 右手） | 有 | **0** |
| 平行五度/八度（和弦音 vs 旋律） | 75/256 | **0** |
| 空壳和弦 | 46/294 | 10/238（多为经过音处） |
| 左手音区 | 36..55 恒定 | 36..67，有织体 |
| 力度 | 恒定 72 | 强拍/乐句起伏塑形（`dyn()`） |

**验证**：`tests/bwv1041_piano_v2.test.mjs` 17 例 —— ① 右手轨跟曲库原版**逐字节相同**；② 原版 Solo Violin 跟 6 声部源文件**逐音相同**；③ 左手不撞小二度；④ 和弦音 0 平行五度/八度；⑤ 大提琴版跟原谱大提琴的平行关系**完全一样**（只是折了八度）；⑥ 低音版/原声部版的每个音都能在原谱里找到（音级相同）；⑦ 和弦版每个音级原谱都响过（没编造）。`npx vitest run` → **58 文件 / 621 用例**全绿；`npx tsc -b` EXIT=0。

**重新生成**：`node scripts/reduce_bwv1041_piano_v2.mjs --write`（写 `public/library/bach/bwv1041-piano-v2-*.mid`；v1 的三个文件挪进 `public/library/_archive/bach/`，清单里已摘掉）。

#### R25 · ESP32 走 WiFi：跟树莓派**同一个协议**，前端一行都不用改（2026-11-06）

> ★ **2026-11-10（R29）这一步被推翻了**：当时「WiFi / 蓝牙」那个二选一**整个删掉** ——
> 蓝牙那条路的代码（`BleTransport` / `bleDevice` / `webBluetooth` / `BackendTransport` /
> `IconBluetooth`）全删了，前端改成选**设备**（树莓派 / ESP32），服务端反代按设备路由。
> 见 §4.4 R29。

**用户反馈**（原话）：

> 「前端还显示esp是蓝牙模式的 你是不是没盖好」
> 「现在esp不走蓝牙了 直接弄成esp wifi的和树莓派格式一样不就行了」

**问题**：固件那边 ESP32 已经换成 WiFi + 自带 WebSocket server 了，但前端的「灯带后端」还是老结构 —— 两个选项写着「树莓派」和「ESP32」，后者一律走蓝牙。用户在 UI 上看到的和设备实际跑的对不上。

**关键事实**：ESP32 新固件的 WS server **跟树莓派那座桥（`led_remote.py`）逐字段一样** —— 同样的 op 名（`auth?` / `init` / `set_many` / `show` / `off` / `all_off` / `test_pattern`）、同样的端口 8080、同样的 `init` 回包（`count` 白名单 176/352、`physical`、`pin`、`set_many_shows:false`）。所以**前端不需要为 ESP32 写第二套传输层**，只需要让用户能填设备的 IP。

**做法**（前端侧的改动，Pi 侧代码**一行没动**）：

| 改动 | 位置 |
|---|---|
| 后端选项改名：「树莓派 / ESP32」→「**WiFi**（树莓派 / ESP32）」+「**蓝牙**（ESP32 旧固件）」 | `src/ui/LedSettings.tsx` |
| 「设备地址」输入框（默认 `192.168.1.113` = 树莓派）+「Pi 令牌」输入框（ESP32 不校验，填了自动跳过） | 同上 |
| 地址 / 令牌 / 配对三个控件从 `SettingsDrawer` 挪进**共享**的 `<LedSettings />` —— 不然换个地址还得开抽屉 | `src/ui/SettingsDrawer.tsx` / `src/ui/controls.tsx`（`SecondaryBtn` 挪成共享件） |
| 状态文字统一走 `ledBackendLabel(active, host)` → `WiFi · <地址>` / `ESP32（蓝牙）` / `未连接` | `src/led/transport/ledConfig.ts` + `LedDock` / `StatusBar` |

**HTTPS 部署怎么办**：树莓派和 ESP32 都是明文 `ws://`，HTTPS 页面会被浏览器按 mixed content 拦掉 → 服务端 `scripts/serve-dist.mjs` 的 `/led-proxy` 反代一次（`LED_WS_TARGET`，默认 `ws://192.168.1.113:8080`）。**换成 ESP32 时只改这一个环境变量**，前端不用动。

**验证**：`tests/led_backend_choice.test.ts` 7 例（选项名 + 选完记住 + 老 prefs 里 `'auto'` 仍落到 `ws`）；`npx vitest run` → 62 文件 / 662 用例全绿；`npx tsc -b --force` EXIT=0；`npm run build` PASS。

---

#### R26 · 前台不熄屏（Screen Wake Lock）（2026-11-06）

**用户反馈**（原话）：

> 「另外能不能让程序在前台时不要让屏幕熄灭」

练琴时人离琴远，屏幕一黑就看不见瀑布和灯带提示了。

**做法**：新增 `src/util/wakeLock.ts` —— 包了一层 `navigator.wakeLock.request('screen')`：

- 启动时申请一次；
- 浏览器切后台会**自动释放**这个锁 → 监听 `visibilitychange`，回到前台重新申请；
- 组件卸载时释放；
- 浏览器不支持 / 申请被拒 → 静默失败，**不影响任何别的功能**（不抛错、不弹窗）。

---

#### R27 · 四条 UI 改动（2026-11-06）

**用户需求**（原话）：

> 「1 容差那里 最高可以到2000ms 2 音量挪到右下角 并且是可收起的那种形式 点击才有音量设置 竖向的 3 把手别两个字去掉 钢琴播放改为 播放 4 速度增加1.25x选项」

| # | 改动 | 落点 |
|---|---|---|
| 1 | 容差上限 **500 → 2000ms** | `store.setToleranceMsPersistent` 的 clamp + `ToleranceInput` 的 `max` |
| 2 | 音量从顶部练习条挪到**右下角**，**可收起**、展开是**竖向**滑块 | 新 `src/ui/VolumePanel.tsx`（删掉 `src/ui/VolumeSlider.tsx`）|
| 3 | 模式选择器去掉前面的「手别」两个字；「钢琴播放」→「播放」 | `src/ui/HandSelector.tsx` |
| 4 | 速度多一档 **1.25×** | `src/ui/SpeedControl.tsx` |

**竖滑块怎么做的**：拿横着的 `<input type="range">` 整体 `rotate(-90deg)` —— 转完「左端（最小值）」跑到了下面，于是「已填充段」正好是「从下往上」，正是竖滑块该有的样子。（`writing-mode` 那套各浏览器支持不齐，旋转最稳。）容器 32×128，滑块本体 112 宽横放。

**第 1 条不只是改输入框**：`timingWindows()` 里 hit 窗口 = `min(用户上限, clamp(一拍 × 50%, 150, 300))` —— 上限调到 2000ms，**实际窗口仍被 300ms 那一截夹住**，也就是「调到 300 以上等于没调」，那这个设置就是假的。所以顺带改了口径：

| 用户填过容差吗 | 命中窗口 |
|---|---|
| 没填过（默认 300） | `min(toleranceMs, clamp(一拍 × 50%, 150, 300))` —— 曲速缩放（规格 P1-5 **不变**） |
| 填过（新增 `store.toleranceCustom`） | **就是填的那个数**（100–2000ms），不再被曲速夹住 |

默认行为一个字没变（默认 300 → 120bpm 下仍是 250ms）；只有用户主动填了数，口径才切。

**验证**：新增 `tests/practice_ui.test.ts` 4 例（容差填 2000 真的存住 / 音量默认收起、点开才有竖滑块且能动 / 模式选择器没有「手别」且第一档叫「播放」/ 速度下拉里有 1.25 且选了就生效）+ `tests/playAlong.test.ts` 4 例（没填过 → 120bpm 仍 250ms / 填 2000 → 窗口 2000ms / 填 100 → 窗口 100ms / 填 2000 时晚 1 秒补弹也算命中）。

#### R28 · 前端配置绑定账号（本地一份 + 账号一份）（2026-11-08）

**用户需求**（原话）：

> 「现在为每一个前端配置都给用户做一个绑定（包括树莓派ip那些） 本地保存一份 后端db也保存一份 修改的时候两边都改 如果没登录就只保存在本地」

| 位置 | 存哪 | 什么时候写 |
|---|---|---|
| localStorage `piano-follow.prefs.v1` | 这台机器的那份 | 改任何配置**立刻**写 |
| 服务器 `user_prefs` 表（JSON 文本） | 这个账号的那份 | **登录了才写** —— 改完配置 debounce 400ms 推一次 |

- **没登录 → 只存本地**，一个请求都不发。
- **登录了 → 两边都改**：本地立刻写，服务器那份顺手推上去（拖滑块只推最后那一次）。
- **登录那一刻 → 把账号那份拉下来**：跟本地合并，**账号那份优先**，落回 UI 状态
  （换台设备登录同一个号 → 用自己那套配置，包括树莓派 IP），再把合并结果推回服务器 ——
  账号那份从此是两边的并集。

**落点**

| 文件 | 改动 |
|---|---|
| `scripts/server/db.mjs` | 新表 `user_prefs(user_id PK, prefs TEXT, updated_at)` |
| `scripts/server/api.mjs` | `GET /api/prefs`（取）/ `PUT /api/prefs`（存）—— 都**需登录**；prefs 必须是对象 |
| `src/store.ts` | `prefsState()` 把「prefs → store 状态」那段**抽成独立函数**（默认值 / 夹取 / 老字段迁移都在这儿，服务器那份落地时走同一套推导，不能只抄值）；`savePrefs()` 写完本地顺手排一次推送；`pullServerPrefs()` 登录时拉 + 合并 + 落状态；`useAuth.subscribe()` 盯登录状态变化（登录成功 / 启动时查到已登录都会触发）|

**取哪份的规矩**：账号那份优先（它是「这个账号的配置」），本地有而账号没有的字段保留。
推 / 拉失败都不影响本地 —— 网络断了、服务器没起，配置照样能用。

**验证**：新增 `tests/server.prefs.test.mjs` 6 例（没登录存取都 401 / 存取往返原样 / 再存一次是覆盖 /
prefs 不是对象 400 / 换账号看不见别人的 / 登出后又 401）+ `tests/prefs_sync.test.ts` 6 例
（没登录只写本地且零请求 / 登录后改配置推给服务器 / 登录那一刻账号那份落进状态和本地 /
账号那份优先于本地 / 合并结果推回服务器 / 登出后不再推）。

---

#### R29 · ESP32 ↔ 树莓派 一致性审查 + 前端**设备选择器**（蓝牙整条路删掉）（2026-11-10）

**用户需求**（原话）：

> 「后端审查一下esp和树莓派的一致性 有无bug  前端把蓝牙那部分删掉 改为选择esp和树莓派
> 现在esp也和树莓派一样用web程序了」

**为什么这么改**：ESP32 的新固件自带 WebSocket server（端口 8080），协议跟树莓派那座桥
**逐字段一样** —— 所以「WiFi / 蓝牙」那个二选一已经没有意义了：蓝牙那条路是给
2026-11-04 之前的固件留的备用，前端唯一要做的选择是「**连哪台**」。

---

##### 一、审查结论：两边协议骨架一致，差 11 处

两边都是裸 op（`init` / `set` / `set_many` / `show` / `off` / `ping` / `status` /
`marquee`），回包都是**扁平**的 `{ok, error?, <摊平的字段>, id}`。固件的
`ws_led.cpp: piReply()` 就是照着树莓派的回包形状写的。

| # | 差异 | 树莓派 | ESP32 | 严重度 | 处置 |
|---|---|---|---|---|---|
| L1 | **鉴权** | 桥层 token（`hmac.compare_digest`）+ Origin 白名单 + 限流 + 连接数上限 | **没有**；`auth` op 被硬编码回 `"unknown op: 'auth'"` | 高 | 用户选了「先不加鉴权」→ **这次不加**；但固件侧 `auth` 改成回 ok（源码改，不刷）。风险写进 §5 |
| L2 | **反代只有一个目标** | `LED_WS_TARGET` 单值，前端地址**完全被忽略** → 选了 ESP32 还是连树莓派 | 同 | 高（卡功能） | **改**：反代按设备路由 `/led-proxy/pi` + `/led-proxy/esp32` |
| L3 | **`set_many` 原子性** | 边写边校验 → 越界时**前面的像素已写进缓冲**（部分生效） | 先全校验再写 → 原子 | 中 | **改树莓派**（先校验后写）→ 已部署到 Pi |
| L4 | **Origin 白名单** | 桥层有（`origin_allowed`），但 Node 反代**不转发 Origin** → 白名单被绕开 | 无 | 中 | 记录（用户暂不加鉴权）；等加鉴权那轮在反代层补同源校验 |
| L5 | **局域网直连** | 桥的 Origin 白名单只放行 `localhost`/`null`/`file://` → 浏览器从 `http://192.168.1.111:8131` 直连会被 1008 拒 | 无此限制 | 中 | Pi 那边的桥已加 `LED_ALLOW_ORIGINS` drop-in |
| L6 | **`status` 字段** | `ready/count/physical/pin/sets_pending/last_show_age_s` | WS 面（顶层 `status` op）本来就齐；内层 `led.status` 缺三个 | 低 | **改固件源码**：给 `led.status` 补上三个字段（形状一致） |
| L7 | **`init` 引脚语义** | 真切 GPIO（白名单 12/18/21）→ **传 14 会被 init 拒** | 忽略请求引脚，只报编译期 14 | 中 | 前端**按设备传引脚**：树莓派 18 / ESP32 14 |
| L8 | **消息大小** | 64KB | `WS_MSG_MAX` 4KB（前端 `CHUNK=80` 像素 ≈ 2.9KB，余量太小） | 低 | **改固件源码** 4KB → 8KB |
| L9 | **限流 / 握手超时** | 200 msg/s 令牌桶 + 4 连接 + 10s 鉴权超时 | 只有 4 连接，无速率限制、无握手超时 | 低 | 记录（固件侧，等刷机那轮补） |
| L10 | **设备端跑马灯** | 无 `marquee` op | 有 `marquee` | 低 | 前端按设备声明能力（`supportsDeviceMarquee`） |
| L11 | **PC 侧 BLE 桥的 token** | `scripts/bt_pi/pc/ble_led_bridge.py` 只读**顶层** `token`，前端发的是 `args.token` | — | 低 | ** moot** —— BLE 整条路删了，该脚本前端不再用 |

> ★ **L6 的一处更正**（跟最初的判断相反）：计划里写「WS 那条路的 `status` 缺
> `ready`/`sets_pending`/`last_show_age_s`」—— 读代码后发现 **WS 面走的是顶层
> `status` op**，那三个字段本来就有（缺它们的只是内层 `led.status`，那个 op 前端
> 根本不用）。固件里仍然给 `led.status` 补了这三个字段，只是为了形状一致。

---

##### 二、用户那个扫描问题的答案（已实测）

```
1524 个地址 (192.168.0.1–192.168.5.254) 的 8080 端口，9 秒扫完
  OPEN 192.168.1.113      ← 树莓派 (ws_led_bridge)
  (其余全关)
```

**ESP32 当时不在线**（没上电 / 没连上 WiFi）。固件的静态 IP 兜底是 `192.168.1.120`
（`firmware/esp32s3/src/wifi_config.h`）。

> ⚠️ **2026-11-11（R30）更正**：上面最后那句「老文档里写的 `.108` 是**旧值**」是**错的** ——
> `.108` 才是板子平时的地址（DHCP 拿到的，路由器上按 MAC 保留，见
> `firmware/esp32s3/README.md`），`.120` 只是 DHCP 挂了才用的静态兜底。
> 下面 R29 改动清单里 `LED_WS_TARGET_ESP32` 用的 `.120` 同样已经改回 `.108`。

**「有没有预留可以校验的接口」** —— 有，就是 WS 协议自带的三个 op（固件里**没有**
HTTP 健康检查端点）：

| op | 树莓派 | ESP32 | 用途 |
|---|---|---|---|
| `ping` | `{ok:true, pong:true}` | 同左 | 活着没 |
| `status` | `{ok:true, ready, count, physical, pin, sets_pending, last_show_age_s}` | 同形 | 几颗灯 / 哪个 GPIO（**pin 18 = 树莓派，14 = ESP32**） |
| `marquee` | `{ok:false, error:"unknown op: 'marquee'"}` | `{ok:true, frames:N}` | **设备指纹** |

---

##### 三、改动清单

**前端（蓝牙那条路整个删掉）**

| 删掉 | 位置 |
|---|---|
| `BleTransport.ts` / `bleDevice.ts` / `webBluetooth.ts` / `withTimeout.ts` | `src/led/transport/` |
| `BackendTransport.ts` | 同上 —— 它存在的唯一理由就是「蓝牙 or WiFi 二选一」 |
| `IconBluetooth` | `src/ui/icons.tsx` |
| 「连接 ESP32（蓝牙）」按钮 + 所有「待配对」文案 | `src/ui/LedSettings.tsx` / `LedDock.tsx` / `SettingsDrawer.tsx` / `StatusBar.tsx` |

**前端（新增设备选择器）**

| 改动 | 位置 |
|---|---|
| `LedDevice = 'pi' \| 'esp32'` + `LED_DEVICE_INFO`（label / defaultHost / pin / supportsDeviceMarquee）+ `ledProxyPath()` + `ledDeviceLabel()` | `src/led/transport/ledConfig.ts` |
| `ledBackend` → `ledDevice`；`ledActiveBackend` → `ledActiveDevice`（**真的连上**的是哪台）；删 `ledNeedsPairing` | `src/store.ts` |
| 偏好迁移：`ledBackend:'ble'` → `'esp32'`；`'ws'`/`'auto'` → `'pi'`（但 `ledHost` 是 ESP32 的默认地址 → `'esp32'`） | `src/store.ts: migrateLedDevice()` |
| 切设备时地址跟着换（当前地址正好是另一台的默认地址才换；用户改过的不动） | `src/led/transport/ledConfig.ts: hostAfterDeviceSwitch()` |
| transport 按设备建：`pin = LED_DEVICE_INFO[device].pin`，`supportsDeviceMarquee` 同理；HTTPS 走 `buildLedWsUrl(host, 8080, '/led-proxy/<device>')` | `src/App.tsx` |

**后端（反代按设备路由）**

```js
const LED_TARGETS = {
  pi:    process.env.LED_WS_TARGET_PI    ?? 'ws://192.168.1.113:8080',
  esp32: process.env.LED_WS_TARGET_ESP32 ?? 'ws://192.168.1.120:8080',
}
// /led-proxy/pi → pi, /led-proxy/esp32 → esp32, /led-proxy → pi (老路径, 兼容)
```

`scripts/piano-follow.service` 里的 `LED_WS_TARGET` 单值改成上面两个。

**固件源码（改了，**没刷机**）**

- `firmware/esp32s3/src/ws_led.cpp`：`auth` op 从「硬编码 unknown op」改成回 ok
  （回包 `{ok:true, authed:true}`）；`WS_MSG_MAX` 4KB → 8KB。
- `firmware/esp32s3/src/ble_led.cpp`：`led.status` 补 `ready` / `sets_pending` /
  `last_show_age_s` 三个字段（形状跟顶层 `status` 一致）。

**树莓派 daemon（修了，已部署）**

`scripts/bt_pi/pi/led_remote.py` 的 `_op_led_set_many`：从「边写边校验」改成
「**先全校验、后统一写**」—— 越界时一颗都不落空，跟固件一致（L3）。

---

##### 四、验证

- `npx tsc -b` EXIT=0；`npx vitest run` → **63 文件 / 658 通过 + 1 跳过**。
- `tests/led_esp32_pi_parity.test.ts` **14 例**（跑在 `WsTransport` 上）——
  `set_many` 只写缓冲 / 一帧只推一次 / rgb 截断 / 原子性 / 物理帧长 / 颗数上限 /
  `off` 清整条 / `init`+`status` 字段 / `ping`·`status` 校验 / `marquee` 指纹 /
  `auth` 回 ok。
- `tests/helpers/esp32Model.ts` 从 BLE 形状改成 **WS 形状**（树莓派回包形状）。
- 树莓派原子性：部署后在 Pi 上**进程内**跑一遍越界 `set_many` → 报错且缓冲没被写脏
  （`ATOMIC_OK`），再对着 `ws://192.168.1.113:8080` 实测 set_many/show/status/off/ping 全通。
- 公网：`https://piano.loveinshare.tech/led-proxy/pi` → ping 得到 pong；
  `/led-proxy/esp32` → 上游连不上（ESP32 不在线）—— **证明路由分流对了**。

##### 五、已知取舍 / 风险

1. **公网 LED 通道仍然无鉴权**（用户选了「先不加鉴权」）。Pi 那边现在也没 token
   （`/opt/bt-gpio/led_token` 不存在）→ 实测 `wss://piano.loveinshare.tech/led-proxy`
   裸连就能 ping/status。**下一轮建议**：反代层当闸门（首条消息必须 `auth`，跟树莓派桥
   同协议）+ 一个共享密钥 + 前端「令牌」框填一次；固件那侧 `auth` 已经改成回 ok，配上反代就闭环。
2. **固件改了但没刷** → 线上 ESP32 行为不变（`auth` 仍回 unknown op，`WS_MSG_MAX` 仍 4KB）。
   前端对这两种回包都兼容（auth 失败有回退路径）。
3. **HTTPS 下前端填的设备地址被忽略** —— 这是 `/led-proxy` 的固有行为；这次只是把
   「忽略」变成「按设备路由到服务器上配的目标」。要换地址得改服务器上的
   `LED_WS_TARGET_ESP32`。
4. **树莓派 daemon 重启时灯会灭约 1 秒**（部署原子性修复时）。

---

#### R30 · ESP32 固件代码审查 + 一处**能把板子打成砖**的越界（2026-11-11）

**用户需求**（原话）：

> 「检查一下esp的固件有没有问题」 → 「改了推到最新分支」

**为什么做**：R29 把 ESP32 接进了前端的一致性体系，但那次改的是**协议层**
（反代路由 / 设备选择器），固件内部一行没审。固件是**唯一没有回归网**的一层 ——
`tests/helpers/esp32Model.ts` 是它的 **JS 抄写版**，抄错的地方两边一起错，测试照样绿。
这次把固件源码逐行读了一遍（`ble_led.cpp` / `ws_led.cpp` / `wifi_link.cpp`），
并把关键片段**搬到宿主机上真跑一遍**验证。

---

##### 一、发现的问题

| # | 位置 | 问题 | 严重度 | 处置 |
|---|---|---|---|---|
| F1 | `ble_led.cpp: marqueeRun()` | **栈越界 → 死循环 → 板子变砖** | **致命** | **修**：`MARQUEE_WINDOW_MAX = 64`，超了回错 |
| F2 | `ws_led.cpp: piReply()` | `fields[384]` 截断 → 回包变成**非法 JSON** → 前端 `JSON.parse` 抛异常 → 命令被丢 | 中 | **修**：三个缓冲一起放大 |
| F3 | 全链路 | ESP32 的默认地址写成了**静态兜底** `.120`，板子平时在 `.108` → 反代指着一个板子根本不在的地址 | 中 | **修**：默认地址改回 `.108` |
| F4 | `wifi_link.cpp: wifiLinkLoop()` | 重连是**同步**的（`delay()` 等 10~20 秒）→ 这段时间 `wsLedLoop()` 跟着停摆 → WS 完全不应答 | 中 | **修**：改成非阻塞（`begin()` 之后轮询） |
| F5 | `ble_led.cpp` | `led.ping` 这个 op 认不出来（只认裸 `ping`） | 低 | **修**：两个都认 |

##### 二、F1 的复现（宿主机上真跑）

`marqueeRun()` 里三个颜色数组是 `uint8_t cr[64], cg[64], cb[64]`，但 `window`
只被裁到「逻辑灯数」（176 / 352）—— **数组只有 64 字节**。在宿主机上把这段逻辑
原样抄出来跑（本机没有 ASAN，改用**哨兵字节**探针）：

```
window=65  → 越界 1 字节（探针测到）
window=176 → 循环变量 k 被冲掉 → 打印出来是 0,16,32,48,64 → 跳回 16 → 死循环
```

**为什么能被打到**：`window` 是**客户端给的**（`args.window`），而公网那条 WS 通道
没有鉴权 → **一条消息就能把板子打成砖**。

**修法**：`MARQUEE_WINDOW_MAX = 64`；`marqueeRun()` 里硬裁；op 层超限直接回
`{"ok":false,"error":"window too large"}`（不回 ok 更不能默默截断）。
JS 模型 `tests/helpers/esp32Model.ts` 跟着改（不然两边一起错）。

##### 三、F2 的失效链

`piReply()` 把设备内部的嵌套 `result` **整段摊平**回顶层（ESP32 独有 op 那条分支），
但 `fields` 只有 384 字节 —— `result` 一旦超过 384 就被截断，回包变成
`{"ok":true,{"name":"pianoflow"...` 这种**非法 JSON**。前端的 `JSON.parse` 抛异常
→ 整个 catch 掉 → 回包被丢 → 前端只能等超时。

**修法**：`result` / `inner` / `fields` 三个缓冲统一放大到 `BLE_TX_MAX + 128`（= 640，
跟 `ble_led.cpp` 的 `g_execResp` 一样大），`flat` 放大到 `BLE_TX_MAX + 384`。

##### 四、F4 的修法

以前是 `WiFi.begin()` → `while (status != WL_CONNECTED) delay(100)`（10 秒）
→ 静态兜底再 10 秒，**全程卡在 `delay()` 里**，而它是在 Arduino 的 `loop()` 里调的
→ 这 10~20 秒 `wsLedLoop()` 一起停摆 → WS server 完全不应答 → 前端「连着但什么都不回」
→ 20 秒超时判死。

改成：`begin()` 之后**不等**，用 `g_connecting` + `g_connectDeadline` 记状态，
`wifiLinkLoop()` 每次进来轮询一下（`pollConnect()`）。连上后照样 `applyNoSleep()`
（关省电 —— 不关的话延迟会飘几十 ms）。

> ★ 轮询**必须放在 `loop()` 里「已连接就 return」那个分支之前** —— 连上的那一瞬间
> `WL_CONNECTED` 就成立了，顺序反了的话 `pollConnect()` 永远轮不到，
> `applyNoSleep()` 也永远不会被调。

##### 五、验证

- `npx tsc -b` EXIT=0；`npx vitest run` → **62 文件 / 660 通过 + 1 跳过**。
- 新增 `tests/led_testpattern.test.ts` 2 例：跑马灯窗口上限
  （`window=176` → 回 `window too large` 且一帧没跑；`window=64` → 正常跑）。
- `tests/helpers/esp32Model.ts` 的 `marquee` 跟着固件回 `window too large`。
- `tests/led_backend_choice.test.ts` 的默认地址断言 `.120` → `.108`。
- **固件本身没刷机**（本机没装 platformio）—— 源码改完等设备上线再验。

##### 六、遗留（未做，等刷机那轮）

1. **固件的回归网还是 JS 抄写版** —— 真正的解法是把 `ws_parity.py` 挂到真机上跑，
   而不是抄一份 JS。这次 F1 就是抄写版没能发现的（抄的时候 window 也只裁到逻辑灯数）。
2. `led.status` 补 `ready` / `sets_pending` / `last_show_age_s`（R29 记的 L6）也在
   源码里，同样等刷机。
3. 固件侧没有限流 / 握手超时（L9）—— 等刷机那轮补。

---

#### R31 · 灯带**驱动层**审查 + 前端帧时间算错（2026-11-11）

**为什么做**：R30 审的是固件的**协议层**（命令解析、回包、连接）。
灯带**驱动层**（`ws2811_bitbang.cpp` / `ws2812_rmt.cpp`）从没审过 ——
而它是「灯到底对不对」的最后一道关。审的过程中撞出一个**跨三层的同一个错**：
**物理帧长被当成逻辑灯数**（176 而不是 352），前端、固件注释、文档三处一起错。

##### 一、发现的问题

| # | 位置 | 问题 | 严重度 | 处置 |
|---|---|---|---|---|
| D1 | `ws2811_bitbang.cpp: outSetPtr()/outClrPtr()` | **GPIO 寄存器按经典 ESP32 排布算地址**（`base + (pin>>5)*4`）→ 在 S3 上 pin≥32 时置位落到 `out_w1tc`、清位落到 `out1` —— 两个不相干的寄存器 | 中（当前 pin=14 恰好没踩到） | **修**：分 bank 取 `out_w1ts`/`out_w1tc`/`out1_w1ts`/`out1_w1tc`，掩码也按 bank 算 |
| D2 | `ws2811_bitbang.cpp: sendFrame()` | 标定差值用**无符号**减法 → 一旦 `s_nHigh1 < s_nHigh0`（倒挂）就回绕成 ~4×10⁹ → 一帧永远发不完 → `show()` 看起来像卡死 | 中 | **修**：差值改 `int32_t`，为负时退化成 0（宁要时序偏差，不要卡死） |
| D3 | `ws2812_rmt.cpp: SYMBOLS_PER_LED` | **12 而不是 24** —— `rmt_symbol_word_t` 一个 symbol 就是**一个 bit 周期**（高半截 + 低半截），不是两个 bit → 缓冲只装 4226 个却要写 8449 个 → **堆越界写 ~16.9KB**（堆元数据被破坏 → abort；copy encoder 还会越界**读**，把相邻堆块当波形发到灯带上） | **高** | **修**：24 symbol/颗 |
| D4 | `ws2812_rmt.cpp: show()` | `rmt_transmit()` 失败 / `rmt_tx_wait_all_done()` 超时之后**不复位通道** → 在途描述符不释放 → 之后**每一帧都失败**，灯带永久卡死；超时那次的 encoder 还可能在读 `symbols_` → 下一帧原地重写 → 花屏 | 中 | **修**：新增 `resetChannel()`（`rmt_disable()` → `rmt_enable()` + `rmt_encoder_reset()`），两处失败都调 |
| D5 | `src/led/LedController.ts: MARQUEE_FRAME_MS` | **前端帧时间按逻辑 count (176 → 5.28ms) 算**，但两台设备推帧都按**物理** 352 颗（10.56ms）→ 步长取 2 而不是 4 → 88 帧而不是 44 帧 → 「0.5 秒」的测试按钮实际跑 **0.93 秒**（慢一倍） | **高（用户可见）** | **修**：新增 `LED_PHYSICAL_COUNT = 352`，帧时间只按物理数算 |
| D6 | 固件注释 / `firmware/esp32s3/README.md` / `.claude/skills/led-strip/*` | 「一帧 5.3ms」「4224 bit」「88 帧」散落在 8 个文件里 —— 全部是 D5 那个错的推论 | 低 | **修**：全部按物理 352 颗 / 10.56ms / 44 帧改写 |

##### 二、D5 的根因：物理帧长 ≠ 逻辑 count

三处独立来源确认「**帧长永远是 352**」：

| 来源 | 事实 |
|---|---|
| 树莓派 | `led_remote.py --physical-count 352`（WS2812 串联，两条带子） |
| ESP32 固件 | `LED_PHYSICAL_COUNT = 352`（编译期常量，`platformio.ini` 里 `-D` 也写死） |
| 前端 `ledConfig.ts` | 逻辑 count 只有 176 / 352 两个合法值；**逻辑数只决定「允许写哪几颗」** |

> 推论：**帧时间跟逻辑 count 无关**，前端 `marqueeStep(count, targetMs, frameMs)` 里
> `frameMs` 的默认值必须是**物理**帧长，而不是由 `count` 算出来的。
> 修之前是 `marqueeFrameMs(count)` → 176 颗时算出 5.28ms。

修完两边一致：

```
前端:  44 帧 × 10.56ms = 464ms   (step: 176→4, 352→8)
固件:  44 帧 × 10.56ms = 464ms   (设备侧 marquee, 板子本地跑)
```

##### 三、D3 的算术

```
以前: symbolCap_ = 352 * 12 + 2 = 4226 个 symbol
      show() 实际要写 352 * 24 + 1 = 8449 个 (每 bit 一个 symbol)
      → 越界 4223 个 symbol × 4 字节 = 16.9KB
现在: symbolCap_ = 352 * 24 + 2 = 8450 ≥ 8449 ✓
```

`encodeBit()` 本来就是按「一个 symbol 一个 bit」写的 —— **写入逻辑一直是对的**，
错的只是缓冲按「两个 bit 一个 symbol」分配。

##### 四、D1 的寄存器布局（IDF v5.5.1 `components/soc/esp32s3/register/soc/gpio_reg.h`）

```
out        = base + 0x04
out_w1ts   = base + 0x08    ← GPIO0..31
out_w1tc   = base + 0x0C
out1       = base + 0x10    ← 独立的 22-bit 字段 (GPIO32..53)
out1_w1ts  = base + 0x14
out1_w1tc  = base + 0x18
```

IDF 自己的 LL 层（`hal/esp32s3/include/hal/gpio_ll.h`）就是分两段的：
`if (gpio_num < 32) hw->out_w1ts = 1 << gpio_num; else hw->out1_w1ts.val = 1 << (gpio_num - 32);`

##### 五、验证

- `npx tsc -b` EXIT=0；`npx vitest run` → **62 文件 / 661 通过 + 1 跳过**（R30 是 660 通过）。
- `tests/led_testpattern.test.ts` 跟帧时间：
  - 176 颗 → `step=4` → 44 帧 → 464ms；
  - **352 颗 → `step=8` → 同样 44 帧**（证明帧时间跟逻辑数无关）。
- **固件源码过了语法检查**：本机没装 platformio / IDF，用一套**照着 IDF v5.5 真头文件
  抄的桩头**（`driver/rmt_tx.h` / `driver/rmt_encoder.h` / `driver/rmt_common.h` /
  `hal/rmt_types.h`）做 `g++ -fsyntax-only -Wall -Wextra`：
  `ws2811_bitbang.cpp` + `ws2812_rmt.cpp` **EXIT=0，零警告**。
  （只验语法，不验行为 —— 行为还是要等刷机。）
  > ★ 这套桩头是**照着 IDF v5.5 的真头文件**抄的，不是照着记忆抄的 —— 第一版桩头
  > 里写的是 `rmt_channel_reset()` / `rmt_channel_enable()`，**IDF v5.5 里根本没有这三个
  > 函数**（通道级开关就叫 `rmt_enable()` / `rmt_disable()`，在 `driver/rmt_common.h`）。
  > 也就是说**照记忆写的 `resetChannel()` 根本编不过** —— 桩头对照真头文件时才发现。
  > 教训：这一层的 API 名字**只能查头文件，别凭印象**。

##### 六、遗留（未做，等刷机那轮 / 等有硬件）

1. **RMT 的 bit 周期是 1.2µs**（10MHz tick → 12 tick），WS2812 标称 1.25µs ±150ns
   （1.10~1.40µs）—— 在规格内，但比标称偏短 4%。RMT 是 opt-in 后端（`env:esp32s3-rmt`），
   没在真机上验证过 → **刷机那轮用 `diag` 量一下实际波形**再决定要不要改成 12.5 tick。
2. **`applyMaxLit()` 会改像素缓冲**（把超限的像素**抹黑**），不是只算不写 ——
   `LED_MAX_LIT == 0`（默认）时不触发，所以现在无害；但将来开了上限，
   它会让「读回缓冲」和「用户设的颜色」不一致。
3. 固件的回归网还是 JS 抄写版（R30 遗留 1）—— 这次 D1/D2/D3 全都是抄写版**发现不了**的
   （JS 模型里根本没有寄存器地址和 symbol 缓冲）。
4. D4 的 `resetChannel()` 现在用的是 `rmt_disable()` / `rmt_enable()` / `rmt_encoder_reset()`
   —— 三个都在 IDF v5.5 的头文件里（`driver/rmt_common.h` / `driver/rmt_encoder.h`），
   **桩头编译已过**；但「disable/enable 到底能不能把 driver 的在途队列彻底清空」没查到底
   （文档没说）→ 真机上如果还出现「一失败就每帧都失败」，就得改成
   `rmt_del_channel()` + 重建通道。
---

#### R32 · 灯带「乱闪 + 随机几颗亮」的真根因：bit-bang 挡不住无线中断（2026-11-11）

**为什么做**：R31 刷机后用户实测 —— 跑马灯**有**，但「乱闪 + 有一些奇怪的灯亮起来」。
R31 的标定数字看起来完美（0bit 周期 300、1bit 306、T0H=96、T1H=191，全部在规格内），
所以问题不在「平均时序」，而在**逐 bit 的抖动**。

##### 一、怎么量出来的（不用示波器、不用眼睛）

给 bit-bang 驱动加了 `waveProbe()`：用 **RMT RX 通道在同一个 GPIO 上回环**，
把自己发出去的波形抓回来，按「期望的 0/1」分类统计每个 bit 的高/低电平宽度。
80MHz 分辨率（1 tick = 12.5ns），每个图案抓 100 次 × 48 bit。

串口 `wave` 命令即可复现。

##### 二、实测：BLE/WiFi 是凶手

| 图案 / 指标（tick @80MHz） | 无 BLE/WiFi（selftest） | **有 BLE/WiFi（正常固件）** | RMT 硬件 |
|---|---|---|---|
| 0 bit 高电平 min..max | 29..256 | **27..234** | **32..32** |
| 1 bit 高电平 min..max | 61..82 | **60..431** | **64..64** |
| 偏差 >0.15µs 的 1 bit 数（/4800） | 11 | **254** | **0** |

- 理论值：0 高 = 0.4µs = 32 tick，1 高 = 0.8µs = 64 tick。
- 有无线时 0 bit 的高电平被拉到 **234 tick = 2.9µs** —— WS2811 会把这个 0 **读成 1**
  → 颜色错、随机灯亮；1 bit 甚至被拉到 **431 tick = 5.4µs**。
- 无线关掉后极端值基本消失（偶尔一个 256 是通道启动/测量伪影），证明**不是**标定公式、
  不是 GPIO 寄存器、也不是数据链路 —— 是**中断**。

**为什么 `portENTER_CRITICAL()` 没挡住**：它只把本核中断级别抬到 3，
**level 4+ 的 NMI 级中断（WiFi/BT 控制器）照跑**。一次 5µs 的 ISR 就足以把一个
0 bit 的高电平拉成 1 bit。bit-bang 这条路在「WiFi/BT 同时开着」的固件里**无解**。

##### 三、修法

| # | 改动 | 说明 |
|---|---|---|
| F1 | **默认驱动改成 RMT 硬件**（`LED_DRIVER_RMT=1`） | 波形由 RMT 按 10MHz tick 生成，中断不参与 → 回环实测 32/64 tick **零偏差** |
| F2 | RMT 开 DMA（`LED_RMT_DMA=1`）+ **bytes encoder** | 负载就是像素字节，驱动把每个 byte 展开成 8 个 symbol；**不再预编码整帧**（第一版的 33.8KB symbol 缓冲把 heap 吃光，见第五节） |
| F3 | 去掉字节查表 / 脏像素标记（第一版方案） | bytes encoder 在驱动里流式展开，静态 RAM 143KB → **106KB**，`show()` ~10.6ms |
| F4 | bit-bang 热循环**去分支** | R31 为防倒挂把 `nHigh = nH0 + dH*one` 改成了三处 `?:` —— Xtensa 没有条件传送，`?:` 只能编成分支；数据 0/1 随机 → 分支预测失败 → 每 bit 宽度都抖。改回纯算术，倒挂保护挪到标定结束的 `normalizeCalibration()`（只跑一次） |
| F5 | `wave` 串口命令 + RMT RX 回环 | 以后改驱动先跑 `wave`，别再凭「标定数字漂亮」下结论 |
| F6 | 树莓派 `led_remote.py` 加设备侧 `marquee` | 前端逐帧发 44 帧 ≈ 176 条 TCP 往返，浏览器/网络一抖就乱闪；现在跟 ESP32 一样一条命令跑完。跑马灯只推变过的几颗 (`_push_pixels`)，不重扫 352 颗 |
| F7 | `esp32s3-selftest` 修到能编过 | `wsLedClientCount()` 在 `LED_WS_ENABLE=0` 时没有定义 → selftest env 一直编不过（R31 没发现，因为只做了语法桩编译） |
| F8 | **WiFi 链路看门狗** + `status` 加 `heap/minheap/reset` | `WiFi.status()` 会撒谎（驱动报 connected、lwIP 已死）；每 15s 从设备侧 TCP 探网关，连续 2 次失败强制重连 |
| F9 | BLE RX 队列 8→4 槽、WS 分片缓冲 8KB→4KB | 静态 RAM 再省 32KB（4×4KB + 4×4KB）；WS 命令根本不经 BLE 队列，4KB 已盖住 2.9KB 的 set_many |

##### 四、验证（同一块板，COM5）

```
# RMT 回环: 每个 bit 都精确
[rmt-wave] tx=ok rx=ok 抓到 48/48 symbol
[rmt-wave] 0高 32..32 (期望 32)  1高 64..64 (期望 64)  偏差=0

# 内存: 第一版只有 7.8KB, lwIP 分配不出 ARP 缓冲 → 网络假死
#       bytes encoder + 缩队列之后 83KB
status ... heap=83380 minheap=75824 reset=1

# 设备侧跑马灯: 44 帧, 收尾 litcount=0
marquee   546 ms -> {"ok":true,"frames":44}
litcount         -> {"lit":0,"sum":0}

# 树莓派侧: ESP 可达
64 bytes from 192.168.1.108: icmp_seq=1 ttl=64
192.168.1.108 dev wlan0 lladdr b8:1f:3f:ba:3a:c4 REACHABLE
```

- 固件：`pio run -e esp32s3`（默认 RMT）、`-e esp32s3-bitbang`、`-e esp32s3-selftest` 全部编译通过并刷机验证。
- 树莓派：`test_led_reliability.py` 24 例通过（新增 5 例 marquee）。
- 前端：`LED_DEVICE_INFO.pi.supportsDeviceMarquee` 改成 `true`（老 Pi 服务回 `unknown op` 时前端自动回退逐帧）。

##### 五、第二次真机事故：RMT 预编码把 heap 吃光，WiFi「假在线」（2026-11-11）

刷完 RMT 固件后约 20 分钟，板子从网络上消失：前端一直「连接中」，PC 和树莓派
ping `192.168.1.108` 100% 丢包，树莓派 `ip neigh` 显示 `INCOMPLETE`。但串口
`status` 却说 `wifi connected ip=192.168.1.108 ws_clients=1`，RSSI -30，甚至还能
`WiFi.status() == WL_CONNECTED`；设备侧 `wifi rtt` 连网关也全是 -1。

加上 `heap` / `minheap` 后一眼看到根因：

```
status ... heap=7784 minheap=7244 reset=1
wifi disconnected 192.168.1.120     ← DHCP 失败，退到静态兜底
```

**7674 字节的 free heap** 是罪魁祸首。第一版 RMT 驱动为了「快」：

| 占用 | 大小 |
|---|---|
| 整帧 symbol 缓冲（352×24+1 个 `rmt_symbol_word_t`） | **33.8KB** 堆 |
| 字节→symbol 查表 | **8KB** 静态 |
| BLE RX 队列（8 槽 × 4KB） | 32KB 静态 |
| WS 分片缓冲（4 客户端 × 8KB） | 32KB 静态 |

加起来 100KB+。启动时还能跑，但 WiFi/lwIP 在 DHCP 续租、ARP、TCP 重传时
一旦 `malloc` 失败，链路就静默死掉 —— `WiFi.status()` 只看驱动状态机，不会
告诉你 lwIP 已经分不出缓冲。

**修法**：

| # | 改动 | 收益 |
|---|---|---|
| G1 | 改用 IDF 的 **bytes encoder**：`bit0/bit1` 模板直接吃像素字节，驱动流式展开 | 不再需要 33.8KB symbol 缓冲 + 8KB 查表 |
| G2 | BLE RX 队列 8→4 槽、WS 分片缓冲 8KB→4KB | 静态 RAM 再省 32KB |
| G3 | 新增 **WiFi 链路看门狗**（core 0 任务，每 15s TCP 探网关 80/53，连续 2 次失败强制重连） | `WiFi.status()` 撒谎时也能自愈 |
| G4 | `status` 增加 `heap` / `minheap` / `reset`，WS 回包同步 | 下次「连着但不通」先看这两个数 |

修完实测：**heap 83,380 / minheap 75,824**（+75KB），静态 RAM 143KB → 106KB；
`wave` 仍然是 `0高 32..32 / 1高 64..64`，跑马灯 44 帧 546ms，树莓派 ping 0% 丢包。

> **教训**：嵌入式里「波形完美」不等于「系统健康」。省下来的 CPU 时间如果
> 拿 42KB 堆去换，WiFi 会在几十分钟后悄悄死掉 —— 而且死法极具迷惑性
> （`WiFi.status()` 说 connected）。以后每加一块大缓冲，先在 `status` 里看
> free heap 还剩多少。

##### 六、遗留

1. **bytes encoder 每帧仍要展开 8448 个 symbol**（在驱动/中断里做，CPU 约 0.3ms），
   但不再占 33.8KB 堆 —— 这是有意的取舍：4KB 左右的栈/堆开销换 42KB 堆。
2. **bit-bang 后端保留但不可靠**（连网时必坏）—— 只在没有 RMT 的板子 / 纯自检固件里用，
   已在 `ble_led.h` 和 `platformio.ini` 里写明。
3. `LED_PHYSICAL_COUNT=352` 仍是编译期写死；只接一条 176 的带时建议改成 176（每帧快一倍）。
4. 树莓派的新 `marquee` 要重新部署 `led_remote.py` 才生效（老版本会自动回退，不会坏）。
5. WiFi 看门狗只能「死了再救」，救不回来时仍要靠断电重启；如果以后还出现假在线，
   下一步是记录 `esp_reset_reason()` 和 heap 曲线，确认是不是内存泄漏而不是 AP 踢人。

---


---

## 5. 架构改造方案

### 5.1 引入 lookahead 调度器（解决 P1-2 / P1-3 的根）

> **本节已按实际落地改写**（2026-10-20 阶段 1f）。草案里的 `Scheduler` 签名与实际不同 —— 实际实现把职责拆成了两块：
> **`Scheduler` 只管"哪些 note 该排了"（游标）**，**"排到 ctx 时间轴的哪一刻"由 `SongClock` 负责**。

**现状**

```
setInterval(16ms) ──► 判断"现在该发哪个音" ──► 用 ctx.currentTime 立即发声
```

**落地后**

```
setInterval(16ms) ──► Scheduler.takeDue(songTime + 120ms)
                          │  取出一批"该排了"的 note
                          ▼
                    SongClock.toCtxTime(note.time) ──► 精确的 ctx 时刻
                          │
                          ├─► synth:   osc.start(when)
                          └─► midiOut: output.send(bytes, when)   (Safari 不支持 → 回退立即发)
```

**`src/engine/Scheduler.ts`（实际实现）**

```ts
export class Scheduler {
  private cursor = 0
  constructor(private notes: SongNote[]) {}

  /** 下一个待排程的 note 下标 */
  get index(): number

  /** seek / 回卷后重置游标 */
  reset(index = 0)

  /** 取出所有 note.time <= horizon 的 note（notes 按 time 升序，遇到第一个超时就停） */
  takeDue(horizon: number, out?: SongNote[]): SongNote[]
}
```

它只是一个**单调游标**，不持有 ctx、不算时间 —— 歌曲时间→ctx 时间的映射全部交给 `SongClock`。

**`Player.stepLoop()` 的实际顺序（落地版）**

| 顺序 | 动作 | 为什么是这个顺序 |
|------|------|------------------|
| 1 | 解冻重锚 → `clock.advance(dt)` | 歌曲时间由 clock 推导，不再自己累加 |
| 2 | `playAlong.update()` | 过期 recent / 把 grace 过期的 required 升级为 miss |
| 3 | 冻结判定 | wait 模式 + required 非空 → 回退到 note 精确时间（§4.3 P2-10） |
| 4 | **跟弹记账 + 亮灯**（游标 `bookkeepingIndex`） | 严格按 `note.time`，**不按排程时刻** |
| 5 | **音频排程**（游标 `scheduler`） | `when = clock.toCtxTime(note.time)`，可提前 120ms |
| 6 | note-off 收尾 | 按排程时记录的路由发回同一出口 |
| 7 | 节拍器排程 | 拍点来自 tempo map，提前 120ms 排到 ctx 时间轴 |

**关键点**

1. **记账与排程必须分离**。如果记账也跟着 lookahead 提前做，从 playback 切到 practice 时，提前排过的 note 不会被 required → wait 模式冻不住（`tests/_repro_user.test.ts` 钉死了这条）。所以 Player 里有两个独立游标：`bookkeepingIndex`（记账/亮灯）与 `scheduler.index`（音频排程）。

2. **wait 模式**不开 lookahead**。冻结时会把正在响的伴奏全部掐掉（用户体感核心），提前排程的音会被误杀。规则：`practiceHand !== 'playback' && waitMode → lookahead = 0`；其余（试听 / 不冻结的跟弹）开 120ms。

3. **MIDI Out 的时间戳**：`MIDIOutput.send(data, timestamp)` 在 Chrome/Edge/Firefox 支持，**Safari 不支持**（传了会抛）。`Accompaniment.trySend()` 做**一次性能力探测**（`timestampSupported`），失败后永久回退到立即发送。

4. **NoteOff 必须不早于它的 NoteOn**。提前排程的 NoteOn 配一个"过去的"NoteOff，设备上会卡键。`Accompaniment.activeNotes` 记录 `{channel, when}`，NoteOff 用 `max(rec.when, ctx.currentTime)`。

5. **不要把 `setInterval` 换成 `requestAnimationFrame`**：后台标签页 rAF 会被节流到 1Hz，音频必须靠定时器保活。

6. **暂停/回卷**：已排程但未发声的音**无法撤销**（MIDI 侧），只能靠发 NoteOff 抵消 —— 所以排程窗口不宜过大，120ms 是折中。`stopSounds()` 逐个发 NoteOff（synth 走 `synth.stopNote`），**不发**全局 `CC#120`（那会掐掉用户自己按住的音，见 §5.3）。

### 5.2 时钟对齐层（解决 P1-3）

> **本节已按实际落地改写**（2026-10-20 阶段 1f）。实际落地的是 `src/engine/Clock.ts` 里的 **`SongClock`**，接口与草案不同 —— 关键差别见下方「落地取舍」。

**问题：项目里同时存在三套时间域**

| 域 | 来源 | 用途 |
|----|------|------|
| perf | `performance.now()` / `DOMHighResTimeStamp` | 输入事件（**硬件**时间戳）、UI 帧 |
| ctx | `AudioContext.currentTime` | 音频排程时间轴（音符真正什么时候发出去） |
| song | 乐曲时间（秒） | 跟曲谱对齐、判定、冻结 |

旧实现里三者各算各的：song 域用 `setInterval` 累加（主线程一卡就漂，播几分钟后判定与音频能差几十毫秒）；输入事件用 `performance.now()` 在**处理时**才取（事件在队列里等了多久，误差就有多大）。

**`src/engine/Clock.ts`（实际实现）**

```ts
export class SongClock {
  constructor(opts: { ctx?: AudioContext | null; perfOffsetMs?: number })

  /** 重锚到指定歌曲时间 —— seek / 冻结 / 解冻 / 变速都要调 */
  anchor(songTime: number): void

  /** 播放倍速 —— 换速时按当前歌曲位置重新锚定（位置不跳变） */
  setSpeed(speed: number): void

  /** 当前歌曲时间（秒）。ctx 模式下 = anchorSong + (ctx.currentTime - anchorCtx) * speed */
  songTime(): number

  /** 推进一帧。ctx 模式下 dt 被忽略（主线程抖动不传导到音乐时间） */
  advance(dt: number): number

  /** 歌曲时间 → ctx 时间；没有 ctx 时返回 null */
  toCtxTime(songTime: number): number | null

  /** ctx 时间 → 歌曲时间 */
  toSongTime(ctxTime: number): number

  /** 输入事件的 perf 时间戳 → 歌曲时间（秒）—— 判定精度的关键 */
  pressSongTime(pressPerfMs: number): number

  /** 检测到的输出延迟（ms） */
  outputLatencyMs(): number

  /** 设置输出延迟补偿（ms）；负数 = 用自动检测值 */
  setLatencyCompensation(ms: number): void
}
```

**落地取舍（重要）**

1. **主时钟是 ctx，不是累加**。歌曲时间锚在 `AudioContext.currentTime` 上 —— 主线程卡顿**不会**传导到音乐时间。没有 AudioContext（单测里的 stub synth）或 ctx 被挂起时，自动退化成逻辑时钟（`advance(dt)` 累加），老测试行为不变。

2. **判定用硬件时间戳**。`Player.handleInput` 把 `e.timeStamp` 交给 `clock.pressSongTime()` 换算成歌曲时间再判定 —— 判定精度不再受主线程抖动影响。这是 P1-3 真正的价值所在。

3. **输出延迟补偿默认 = 0**，而且**不是 bug**：

   | | practice 模式 |
   |---|---|
   | 被判定的那只手 | **不发声**（`routeFor → silent`） |
   | 用户对齐的依据 | 画面（下落音符 / 乐谱），在 song 域，**没有延迟** |
   | 结论 | 默认按**视觉域**判定，补偿 0 |

   给"跟着伴奏声音弹"的用户提供可开关的补偿（自动 = 检测值 / 手动滑块，设置面板「判定延迟」区）。**视觉域 vs 听觉域二选一，不能同时满足** —— 这跟 §3.1 的 sightread 是同一取舍。

4. **Safari 不支持 MIDI timestamp** → `Accompaniment` 一次性探测后永久回退。

5. **判定基准仍用"歌曲毫秒"**，不是 ctx 毫秒。因为 song 域已经是"用户看到/听到的乐曲位置"，`dtMs = pressSongTime - note.time*1000` 直接就是"相对谱面的偏差"，语义最直观；ctx 域只用于**排程**。

6. **冻结点回退（P2-10）**：冻结时把歌曲时间回退到"卡住用户的那个 note 的精确时间"（`PlayAlong.requiredEarliestTs()`）；回退超过 `MAX_REWIND_S`(100ms) 时不倒跳（体感差），改为 `PlayAlong.rebaseRequired()` 把判定基准对齐到冻结点。

7. **倍速必须显式同步进时钟（P1-19）**：ctx 模式下歌曲时间 = `anchorSong + (ctx.currentTime - anchorCtx) * speed`，`speed` 是 `SongClock` 的**内部状态** —— store 里的 `speed` 不会自动进来。`Player` 在**构造 / 起播 / 每帧**三处调 `clock.setSpeed()`；漏掉任何一处都会出现"滑块变了但音乐没变"的半吊子状态。`setSpeed` 内部按当前歌曲位置重锚，换速那一帧不会跳变。

8. **perf↔ctx 偏移在 ctx 挂起/恢复后要重采样**：`perfOffset = performance.now() - ctx.currentTime * 1000` 平时是常量，但 ctx 被挂起时（手机息屏 / 切后台）`ctx.currentTime` 冻住而 perf 一直走 —— 偏移会漂。原实现按 4Hz 节流采样，恢复后最长 250ms 内的按键会用**旧偏移**换算，判定凭空偏掉一截（实测偏 200ms）。现在 `advance()` 检测到模式切换（ctx ↔ 逻辑时钟）时清掉采样节流，下一帧强制重采样。


### 5.3 Active-note 追踪（解决 P0-4 / P1-7）

参照 neothesia 的 `midi_backend.rs:19,69-74,85-100`：

```ts
export class Accompaniment {
  /** 当前在电钢上还按着的 note */
  private activeNotes = new Map<number, number>()  // midi → channel

  sendNoteOn(n: SongNote, transpose = this.transpose) {
    const midi = n.midiNote + transpose
    this.activeNotes.set(midi, Accompaniment.MIDI_CHANNEL)
    this.trySend([0x90 | Accompaniment.MIDI_CHANNEL, midi, vel])
  }

  sendNoteOff(n: SongNote, transpose = this.transpose) {
    const midi = n.midiNote + transpose
    this.activeNotes.delete(midi)
    this.trySend([0x80 | Accompaniment.MIDI_CHANNEL, midi, 0])
  }

  panic() {
    if (this.panning) return      // ← 防止 trySend 失败时递归调用 panic
    this.panning = true
    try {
      // 1) 断延音：CC#120 (All Sound Off) —— 注意 CC#123 不会断延音
      for (let ch = 0; ch < 16; ch++) {
        this.trySend([0xB0 | ch, 120, 0])
        this.trySend([0xB0 | ch, 121, 0])   // Reset All Controllers
      }
      // 2) 显式关掉每一个还在响的音
      for (const [midi, ch] of this.activeNotes) {
        this.trySend([0x80 | ch, midi, 0])
      }
      this.activeNotes.clear()
    } finally {
      this.panning = false
    }
  }
}
```

> **`trySend` 的递归陷阱**：`Accompaniment.ts:57` 在 send 失败时会调 `this.panic()`，而 `panic()` 内部又要调 `trySend` → 无限递归。改造时必须先加 `panning` 标志位打断递归，**这是修 P0-4 时最容易踩的坑**。

**落地时的取舍（2026-10-20 已实现，见 `src/engine/Accompaniment.ts`）**

1. `panic()` 按 P0-4 修法发 `CC#120` + `CC#64=0` + 逐个显式 NoteOff，并额外补 `CC#121 (Reset All Controllers)` 兜底复位 Sostenuto 等其它被"锁住"的控制器。
2. **新增 `silence()`，与 `panic()` 分工**：

   | | `silence()` | `panic()` |
   |---|---|---|
   | 触发 | `Player.pause()`（用户按暂停 / 跳转到别处 / 曲终） | 设备切走 / WebMIDI 断连 / `pagehide` |
   | 消息 | `CC#120` + 显式 NoteOff | `CC#120` + `CC#64=0` + `CC#121` + 显式 NoteOff |
   | 碰踏板/控制器 | **不碰** | 碰（断延音、复位） |

   理由有二：
   - **语义对齐**：`stopSounds()` 里已经有 `synth.stopAll()` —— 浏览器合成器在暂停时被掐断，电钢这边不该还有余音。
   - **不能无脑发全局 CC**：电钢的 **MIDI IN 与本地键盘共用同一个音色引擎**，全局 `CC#120` 会把用户自己正弹的音一起掐掉；全局 `CC#64=0` 还会强行释放用户踩着的踏板。所以只有"用户已经不在弹了"的场景（断连/切设备/页面隐藏）才发全套。
3. `silence()` 有 `sentAnyNote` 把关：`both` 模式 app 一个音都不往电钢发，此时不该动用户的电钢（否则用户在电钢上弹的音会被 app 的暂停动作切掉）。
4. **`silence()` 挂在 `pause()` 而不是 `stopSounds()`**：循环回卷也走 `stopSounds()`，若在那里发 `CC#120`，每循环一圈就会把用户按住不放的音切一次——练循环时体感极差。回卷必须只做"逐个 NoteOff"。

### 5.4 评分模型（解决 P1-4 / P1-5）

**统一口径**

```ts
// src/engine/Scoring.ts
export interface ScoreSnapshot {
  hits: number
  misses: number
  errors: number
  perfects: number
  goods: number
  streak: number
  maxStreak: number
  /** 与 sightread 一致：error 计入分母 */
  accuracy: number   // hits / (hits + misses + errors)
}
```

**窗口计算（按 tempo 缩放，已落地）**

```ts
// src/engine/Scoring.ts
export function timingWindows(bpm: number, baseToleranceMs = 300) {
  const beatMs = 60000 / Math.max(20, bpm)
  // 命中窗口 = 一拍的 50%, 夹在 [150, 300] ms
  const hit     = Math.min(baseToleranceMs, Math.round(clamp(beatMs * 0.5, 150, 300)))
  const perfect = Math.round(clamp(hit * 0.2, 20, 50))
  const good    = Math.round(clamp(hit * 0.5, 40, 150))
  return { hit, perfect, good }
}
```

| bpm | hit | perfect | good |
|-----|-----|---------|------|
| 60  | 300 | 50 | 150 |
| 120 | 250 | 50 | 125 |
| 150 | 200 | 40 | 100 |

> 取舍：原草案写的 `noteDuration` 参数是**空转**的 —— `hit >= 150` 而短音时长 `< 80`，`Math.max(hit, floor)` 永远等于 `hit`，参数传下去之后毫无作用。它跟着 4 层代码传递，读者会误以为真有调度——已删除。
> 短音的「手速不够」由两件事兑住：（1）窗口下限 150ms；（2）`fileNoteOff` 之后的 grace 机制（短音往往同帧 NoteOn+NoteOff，旧实现立刻删 required → userPress 找不到 → 误判 wrong）。
> 默认值对齐 sightread：`GOOD_RANGE=300` / `PERFECT_RANGE=50`（`refs/sightread/src/features/player/player.ts:15-16`）。sightread 用的是固定 300ms，本项目在此基础上再按速度缩放，但默认值不动（不让用户意外变弱）。

**miss 判定改用墙钟**

```ts
// PlayAlong
private required = new Map<number, NotePress>()   // idx → { ctxTs, midi, offCtxTs, offWallMs }

update(wallNowMs: number) {
  for (const [idx, p] of this.required) {
    if (p.offWallMs === undefined) continue
    if (wallNowMs - p.offWallMs > graceMs) { /* 记 miss */ }
  }
}
```

这样即使 wait 模式冻结了歌曲时间，墙钟照走，grace 到期 → 记 miss。

### 5.5 LED 通道分离（解决 P1-9）

**当前**：`source` 只有 `'input' | 'playback'`，命中反馈被伪装成 `playback`。

**目标**：

```ts
export type NoteSource = 'input' | 'playback' | 'hit'
```

`LedFollower` 改为多源追踪：

```ts
private pressed = new Map<number, Set<NoteSource>>()   // midi → 正在按住的源集合

private handleEvent = (e: NoteEvent) => {
  const src = e.source ?? 'input'
  if (e.type === 'down') {
    let set = this.pressed.get(e.midi)
    if (!set) { set = new Set(); this.pressed.set(e.midi, set) }
    set.add(src)
    this.opts.led.noteOn(e.midi, e.hand)
  } else {
    const set = this.pressed.get(e.midi)
    if (set) {
      set.delete(src)
      if (set.size > 0) return   // 还有别的源按着，别灭
    }
    this.opts.led.noteOff(e.midi, e.hand)
  }
}
```

`'hit'` 源走**独立的脉冲**通道：亮 150ms 后自动灭，不参与 `pressed` 集合。

### 5.6 目标架构总览

```
                      ┌───────────────────────────────┐
   MIDI In ──────────►│ MidiInput (e.timeStamp, CC64, │──┐
                      │  running status, activeNotes) │  │
   Keyboard ─────────►│ KeyboardInput (blur 安全)      │  │
                      └───────────────────────────────┘  │  NoteEvent
                                                          │  {midi, type, t, source, hand}
                                                          ▼
   Song + TempoMap ──────────────────────►┌──────────────────────────────┐
                                          │ Player                      │
                                          │  ├─ Scheduler (lookahead)   │
                                          │  ├─ Clock  (perf↔ctx↔song) │
                                          │  ├─ PlayAlong (ctx 时间判定)│
                                          │  ├─ Scoring (tempo 缩放窗) │
                                          │  └─ ActiveNote tracking     │
                                          └───────────┬──────────────────┘
                    ┌─────────────────────────────────┼───────────────────────┐
                    ▼                                 ▼                       ▼
             Synthesizer                       Accompaniment            LedFollower
             (osc.start(when))                (send(bytes, when)        (多源 pressed,
                                            + activeNotes + panic)     'hit' 脉冲)
                    │                                 │                       │
              AudioContext                     Web MIDI Out              WebSocket
                    │                                 │                       │
                 电钢/耳机                    ┌────┴────────┐        ┌─────┴──────┐
                                           预扫描器(游标)  │        │ Pi WS 桥    │
                                                        ▼        │ (token+降权)│
                                                   Pi 灯带 ◄────┴────────┘
```

---

## 6. 优化与新功能提案

每条标注**借鉴来源**、**收益**、**成本**。建议按 §8 路线图分批落地。

### 6.1 练习质量（借鉴 sightread）

| 提案 | 借鉴来源 | 收益 | 成本 |
|------|----------|------|------|
| **跳过漏弹（skipMissedNotes）**：wait 模式弹错/漏弹时，允许"跳过这个音继续"，而不是死等 | sightread `types.ts:109`、`player.ts:169,547`（`skipMissedNotes` 分支：命中时不再把 note 留在 required 里） | 解决"一个音弹错就卡死"的挫败感；sightread 在 phrases 练习里默认开启（`pages/training/phrases/page.tsx:101`） | 中。需要给 note 加"已跳过"状态，并重新定义该 note 是否计入 miss |
| **按住时长加分（durationHeld）**：按住超过阈值的音额外加分 | sightread `player.ts:36-39,531`（`combined = perfect*100 + good*50 - error*25 + durationHeld`） | 区分"点一下"与"真正按实了"，对练琴更有意义；额外鼓励正确的指法 | 低。只需在 `NoteEvent` 里记录 note 的按下时长 |
| **时间轴/小节条**：把当前小节、可跳段落可视化 | sightread `pages/play/components/TimelineStrip.tsx`、`features/controls/SongScrubBar.tsx` | 定位与循环练习更直观 | 中。配合 P2-3 的 tempo map 一起做 |
| **准确率口径对齐**：`hit/(hit+miss+error)` | sightread `player.ts:42-46` | 与用户预期一致 | 低。见 §5.4 |

### 6.2 自适应练习（借鉴 piano-booster）

| 提案 | 借鉴来源 | 收益 | 成本 |
|------|----------|------|------|
| **自动匹配演奏速度**：连续 miss 超过 N 次自动降速，命中率回升后逐步提速 | piano-booster `TODO.md:25`（"Automatically adjust the speed to match playing ability"） | 练习者不会卡在同一处反复失败 | 中。需要一个"自适应速度"状态机 + UI 提示当前速度倍率 |
| **ahead / behind beat 提示**：告诉用户"快了/慢了"，而不是只给 perfect/good/late | piano-booster `TODO.md` MEDIUM 段 | 练习者能自我校正，而不是盲目重弹 | 低。`playedDelta` 已有数据，只需可视化 |
| **Rhythm 练习模式**：只判节奏（踩在拍上即可），不判音高 | piano-booster `TODO.md:11-12`（"one finger play"、"rhythm practice"） | 入门阶段聚焦节奏；也对应 linthesia 的 Rhythm/Sound 分离 | 中。新增一种 practice mode |
| **one-finger 模式**：同一和弦只弹一个音就算对 | piano-booster `TODO.md:11` | 降低左手负担 | 低。`PlayAlong.userPress` 的 `matched` 已是数组（`PlayAlong.ts:167-181`），放宽"必须全命中"即可 |

### 6.3 MIDI 能力扩展（借鉴 neothesia）

| 提案 | 借鉴来源 | 收益 | 成本 |
|------|----------|------|------|
| **左右手分通道** | neothesia `midi_player.rs:18,75-79`（`separate_channels`） | 电钢上左右手可以用不同音色；同时解决"同名音互相覆盖" | 低。注意罗兰实测只认 ch=0（`docs/roland-midi-notes.md`），需做成可配置而非默认开启 |
| **Program Change** | neothesia `midi_player.rs:133-142` | 切换音色；换设备后不残留旧音色 | 低。`use()` 时发 Program Change + `CC#121` Reset All Controllers |
| **踏板状态透传** | Keystair（§3.3） | 显示/记录用户踩了延音踏板；电钢上也能复现踏板效果 | 中。需要 MIDI In 解析 CC64 并通过 MIDI Out 回送 |

### 6.4 交互与导航（借鉴 neothesia / sightread）

| 提案 | 借鉴来源 | 收益 | 成本 |
|------|----------|------|------|
| **长按连续倒带**：按住 ←/→ 持续倒带/快进，松开后**恢复原播放状态** | neothesia `rewind_controller.rs:11-60`（`RewindController` 记住 `was_paused`，`stop_rewind` 里 `if was_paused == Some(false) { player.resume() }`） | 长片段定位效率大幅提升 | 中。当前 ←/→ 是"跳到相邻 note"（`src/util/navigation.ts:11-54`），语义不同，两者可共存 |
| **可拖拽进度条 + 循环区间可视化** | sightread `SongScrubBar` | 循环练习更顺手 | 中 |
| **输出延迟可见**：显示当前 `outputLatency` 与判定窗口 | Keystair（§3.3） | 用户能自己判断"蓝牙延迟是否影响判定" | 低。`Clock.outputLatency()` 直接暴露 |

### 6.5 工程与运维（借鉴 musicope）

| 提案 | 借鉴来源 | 收益 | 成本 |
|------|----------|------|------|
| **一条命令起全栈**：`npm run serve` 同时起 Vite preview + Pi 侧转发 | musicope `server.js`（Express 静态托管 + API） | 降低"前端跑在哪、Pi 怎么连"的认知成本 | 低 |
| **manifest 增量更新**：开发期不缓存、发布期缓存 + ETag | §4.3 P2-5 | 改 manifest 立刻生效 | 低 |

### 6.6 渲染与性能（无外部借鉴，源自实测）

| 提案 | 收益 | 成本 |
|------|------|------|
| 渲染层直读 `player.getCurrentTime()`，不再绕 10Hz 的 store（P1-1 / P1-14） | 下落音符平滑 | 低 |
| pre-scanner 与 `FallingNotes` 改用游标 + 二分（P1-15） | 长曲 CPU 占用下降 | 中 |
| `PlayAlong.requiredIndices` 改增量维护（P1-15） | 每帧少一次全量 Set 构造 | 低 |
| LED 预扫描提前 200ms 的窗口改成"提前量 + 调度窗口"联动 | offset 与 lookahead 协同，不会互相打架 | 低 |

---

## 7. 后端安全加固

> **状态：P1-10 / P1-11 已于阶段 3 落地**（2026-10-20）。下面是**审计当时**的现状与方案，落地情况见 §7.3。
> 部署与运维细节见 `scripts/bt_pi/README.md`（路径表 / token / 降权）。

### 7.1 现状风险（审计当时）

| 项 | 现状 | 风险 | 现状（已修） |
|----|------|------|------|
| WS 监听地址 | `ws_led_bridge.py:22` `WS_HOST = "0.0.0.0"` | 同网段任意主机可连 | 保留（靠 token + Origin + 限流兜底；只让本机访问时设 `LED_WS_HOST=127.0.0.1`） |
| 鉴权 | 无 | 任意网页可控制灯带、可刷爆 Pi | ✅ 共享 token（首条消息必须 `auth`） |
| Origin 校验 | 无 | 浏览器页可直接跨源连 WS（WebSocket 不受同源策略保护） | ✅ Origin 白名单（默认放行 `file://` / `null` / localhost） |
| 限流 | 无 | 单客户端可无限发 `set_many` | ✅ 连接数上限 4 + 令牌桶 200 msg/s + 64KB 消息上限 |
| 进程权限 | 三个服务全部 `User=root` | 桥被拿下即 root shell | ✅ 桥与蓝牙守护进程降权为 `pi`（+ capability） |
| TCP server | `led_remote.py:36` `LISTEN_HOST = "127.0.0.1"` | ✅ 这个是对的，不用改 | 不变 |

### 7.2 目标方案

**（1）绑定回环 + 反向代理**

首选：WS 桥只绑 `127.0.0.1`（`WS_HOST = "127.0.0.1"`），外部访问通过 nginx/Caddy 反代到它。反代层负责 TLS、Basic Auth、IP 白名单、连接数限制。

**（2）若必须直连（无反代）**

在 `ws_led_bridge.py` 里加：

- **共享 token**：握手时校验 `Sec-WebSocket-Protocol` 或首条消息里的 token；token 从 Pi 上的 `/opt/bt-gpio/led_token` 读取（`chmod 600`），前端从 `VITE_LED_TOKEN` 或用户设置里提供；
- **Origin 白名单**：握手时检查 `Origin` 头是否在允许列表内（`file://` 与 `null` 也要处理，本地开发场景）；
- **连接数上限**：`asyncio.Semaphore(4)`，超出直接关闭；
- **消息速率限制**：每客户端令牌桶，> 200 msg/s 直接断开；
- **消息体大小上限**：`websockets.serve(..., max_size=64 * 1024)`（当前 `set_many` 一条消息可能很大，需实测上限）。

**（3）服务降权**

| 服务 | 现状 | 目标 |
|------|------|------|
| `led-remote.service` | `User=root` | 保留 root（需要 `/dev/mem`），但加 `NoNewPrivileges=true`、`ProtectHome=true`、`ProtectKernelTunables=true` |
| `ws-led-bridge.service` | `User=root`（注释自认不需要） | `User=pi`（或专用 `ledsvc`）+ `NoNewPrivileges=true` + `PrivateTmp=true` + `ProtectSystem=strict` + `ProtectHome=true` |
| `bt-gpio.service` | `User=root` | 改用 `AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW` + `CapabilityBoundingSet`，`User=pi` + `SupplementaryGroups=bluetooth gpio` |

**（4）输入校验**

`led_remote.py` 已经做了 `i` 的范围检查（`:132`）与整数转换（`:131`），但：

- `count` / `pin` 来自 `init` op（前端 `LedController.ts:203`），应在服务端**白名单化**（只接受 176/18 或配置好的值），避免被改成 65535 导致 OOM；
- `set_many` 的 `pixels` 数组长度要限制（例如 ≤ 4096）。

**（5）日志与可观测**

当前桥只有 `logging.basicConfig(level=INFO)`，没有记录连接来源。加：连接来源 IP、消息计数、错误计数；异常断开要能看出是"校验失败"还是"上游挂了"。

### 7.3 落地情况（阶段 3，2026-10-20）

| 项 | 落地形态 | 开关 / 默认 |
|----|----------|------------|
| 共享 token | 首条消息 `{"op":"auth","token":"..."}`，`hmac.compare_digest` 比对；token 读 `/opt/bt-gpio/led_token`（640 root:pi） | `LED_TOKEN_FILE` / `LED_TOKEN` / `LED_REQUIRE_TOKEN=1`；未配置 token 时**只告警并放行**（向后兼容） |
| 鉴权顺序 | **先鉴权、后开上游 TCP** —— 未鉴权的连接不占 client 名额、不占 LED server 的 TCP 连接（DoS） | `LED_AUTH_TIMEOUT_S=10`；握手超时直接断开 |
| Origin 白名单 | 握手时检查 `Origin` | `LED_ALLOW_ORIGINS`（逗号分隔）；默认放行 `file://` / `null` / `localhost` / `127.0.0.1` |
| 连接数上限 | 全局计数 | `LED_MAX_CLIENTS=4` |
| 限流 | 每客户端令牌桶 | `LED_MAX_MSG_PER_SEC=200` |
| 消息大小 | `websockets.serve(max_size=...)` | `LED_MAX_MSG_SIZE=65536` |
| 服务降权 | `bt-gpio.service` / `ws-led-bridge.service` → `User=pi`；前者加 `CAP_NET_ADMIN`/`CAP_NET_RAW` | `install.sh` 自动建用户、建组、生成 token |
| `led-remote.service` | 保留 root（`/dev/mem`），加 `NoNewPrivileges` / `ProtectHome` / `ProtectKernelTunables` / `RestrictSUIDSGID` | — |
| 前端凭据 | `LedController.resolveToken()`：显式参数 > `VITE_LED_TOKEN` > `localStorage['ledToken']`；设置面板「Pi 令牌」 | — |
| 回归 | `scripts/bt_pi/tests/test_security.py`（18 例） | `python scripts/bt_pi/tests/test_security.py` |

> **前端 token 的传递方式**：首条消息 `auth`（而不是握手头）—— 因为 Safari / 旧版浏览器对 `Sec-WebSocket-Protocol` 的支持不一致，而自定义 header 在浏览器 WS API 里根本发不出去。

---

## 8. 分阶段路线图

### 阶段 0 — 止血（1–2 天）

| 项 | 内容 | 验收 | 状态 |
|----|------|------|------|
| P0-5 | 修 5 个 fixture 路径 + `downlaod` 目录改名 | `npx vitest run` 全绿 | ✅ |
| P0-1 | 回卷不再经过 `pause()`，`seek()` 加 `keepPlaying` | 回卷后 `isPlaying === true`，按空格能暂停 | ✅ |
| P0-2 | `seek()` 加 `preserveScore`，回卷保留评分 | 回卷后 `hits` 不重复累加 | ✅ |
| P0-3 | `cancelPreviewNotes()` 补发 NoteOff + 还原 transpose | 预览后立刻暂停，收到配对 NoteOff | ✅ |
| P0-4 | panic 加 CC#120 + CC#64=0 + activeNotes 显式 NoteOff | MIDI 监视器可见三组消息 | ✅ |

### 阶段 1 — 时序层（1–2 周）

| # | 项 | 状态 |
|---|-----|------|
| 1 | 新增 `SongClock`（§5.2）与 `Scheduler`（§5.1） | ✅ |
| 2 | `Synthesizer.playNote/stopNote`、`Accompaniment.sendNoteOn`、`Metronome.tick` 支持绝对 ctx 时间 | ✅ |
| 3 | `Player.stepLoop` 改为"排程"而非"立即发声"（记账与排程分离，两个游标） | ✅ |
| 4 | 判定改用**硬件时间戳**换算歌曲时间；grace 走墙钟（P1-3、P1-4） | ✅ |
| 5 | `Scoring` 抽出，准确率含 errors（P1-4） | ✅ |
| 6 | `timingWindows()` 按 tempo 缩放（P1-5） | ✅ |
| 7 | `seek()` 补跨界持续音（P1-6） | ✅ |
| 8 | `Synthesizer` voice 键改为 `(midi, id)`（P1-13） | ✅ |
| 9 | transpose 单一真源（P1-17） | ✅ |
| 10 | 渲染层直读 `getCurrentTime()`（P1-1 / P1-14） | ✅ |
| 11 | MIDI Out 连接状态拆分（P1-12） | ✅ |

> **风险提示（已解除）**：这一步改动了 `tests/player.test.ts`、`tests/playAlong.test.ts` 的时间基准。**确定性时钟夹具已先行落地** —— `tests/fakeClock.ts` 提供 `FakeAudioContext`（可控 `currentTime` / `state` / `outputLatency`）与 `withFakePerf`，`tests/clock.test.ts` / `tests/lookahead.test.ts` 基于它。

### 阶段 2 — 输入与灯光（3–5 天）

| # | 项 | 状态 |
|---|-----|------|
| 1 | `MidiInput`：保留 `e.timeStamp`、解析 CC64、running status、activeNotes（P1-7） | ✅ |
| 2 | `KeyboardInput`：blur 释放 + `onUp` 幂等（P1-8） | ✅ |
| 3 | `NoteEvent.source` 扩展 `'hit'`；`LedFollower` 多源 pressed；命中走独立脉冲（P1-9） | ✅ |
| 4 | 渲染层直读 `getCurrentTime()`（P1-1、P1-14） | ✅ |

### 阶段 3 — 后端加固（2–3 天）

| # | 项 | 状态 |
|---|-----|------|
| 1 | WS 桥加 token / Origin / 限流 / 连接数上限（P1-10） | ✅ |
| 2 | 三个服务降权（P1-11） | ✅ |
| 3 | `led_remote` 的 `count`/`pin` 白名单化 + `set_many` 大小上限 | ✅（随 P1-10 的 64KB 消息上限） |
| 4 | 前端 `LedController` 带上凭据 | ✅（token：`VITE_LED_TOKEN` / localStorage / 设置面板） |

### 阶段 4 — 性能与一致性（1 周）

| # | 项 | 状态 |
|---|-----|------|
| 1 | pre-scanner / `FallingNotes` 游标化（P1-15） | ✅（`src/led/scanCursor.ts`） |
| 2 | `PlayAlong.requiredIndices` 增量维护（P1-15） | ✅（活集合 + `requiredVersion`） |
| 3 | MIDI Out 连接状态拆分（P1-12） | ✅ |
| 4 | 节拍器音量（P1-16） | ✅ |
| 5 | P2-1 ~ P2-16 全部 | ✅（P2-14 暂缓，见 §4.3） |
| 6 | **tempo map 落地**（P2-3 / P2-15 / P1-18）：`src/util/tempoMap.ts` | ✅ |
| 7 | 冻结点回退 + rebase 收尾（P2-10） | ✅ |

### 阶段 5 — 练习增强（1–2 周）· ⏳ 未开始

1. skipMissedNotes、durationHeld（§6.1）；
2. ahead/behind beat 提示（§6.2）；
3. 自适应速度（§6.2）；
4. TimelineStrip / 拖拽进度条（§6.4）；
5. 长按连续倒带（§6.4）—— 落地时顺手把 P2-14 的 `notesAt()` 改成二分。

### 阶段 6 — 遗留与观察项

| 项 | 说明 |
|----|------|
| P2-14 | `notesAt()` 全表 filter+sort —— 不是热路径，等阶段 5 的长按倒带一起改 |
| `Song.pitchSplit` | `inferHands` 现在只在「按音高切分」模式下写它；LED 的 split 仍以 60 为默认 |
| 乐谱 engrave 的 tempo 精度 | `StaffView` 的 `durInQuarter` 已走 tempo map，但**跨小节 tie 的时值分配**仍按小节边界近似 |
| 输出延迟自动补偿 | 默认关闭；只有"跟着伴奏声音弹"的用户需要开（§5.2 落地取舍 3） |

---

## 9. 回归测试清单与验收标准

### 9.1 单元测试（新增）

| 用例 | 文件 | 断言 |
|------|------|------|
| 回卷保持播放态 | `tests/player.test.ts` | 回卷后 `isPlaying === true`；再按一次能暂停 |
| 回卷保留评分 | `tests/player.test.ts` | 回卷后 `hits` 不变，`getNoteStates()` 仍为 `hit` |
| 预览取消释放 | `tests/player.test.ts` | `previewNotes()` → `pause()` → 断言发出配对 NoteOff |
| panic 彻底性 | `tests/midi_out.test.ts` | 断言收到 `CC#120`、`CC#64=0`、每个 activeNote 的 NoteOff |
| wait 模式计 miss | `tests/playAlong.test.ts` | 冻结 + 不弹 → 墙钟推进后 `miss` 增加 |
| 准确率含 error | `tests/scoring.test.ts` | `hits/(hits+misses+errors)` |
| tempo 缩放窗口 | `tests/scoring.test.ts` | 60bpm 与 150bpm 下边界判定一致 |
| 跨界持续音 | `tests/player.test.ts` | seek 到长音中间 → 该音进入 `playingNotes` 并发声 |
| 倒计时取消 | `tests/playAlong.test.ts` | `cancel()` 后不再触发 `onDone` |
| MIDI 输入 running status / 保留 timeStamp | `tests/input.test.ts` | 1 字节消息复用上次状态字节；`NoteEvent.t === e.timeStamp` |
| 键盘 blur 释放 | `tests/input.test.ts` | blur 后所有按下键补发 up |
| LED 多源 pressed | `tests/led_follower.test.ts` | input 与 playback 同时按住 → 两者都松开才灭灯 |
| 歌曲时钟 | `tests/clock.test.ts` | ctx 跟随 / 挂起退化 / anchor / 变速连续 / 硬件时间戳 / 无效时间戳 / 延迟补偿 / 无 ctx 退化 / **挂起恢复后偏移重采样** |
| 播放倍速 | `tests/speed.test.ts` | 1×/1/2×/1/4× 下歌曲时间按比例推进；1/2× 时音符 ctx 落点推后一倍；中途改倍速不跳变（P1-19） |
| lookahead 精确落点 | `tests/lookahead.test.ts` | 提前排程且 `when` 精确落在 `note.time`；主线程卡 100ms 不改 `when`；wait 模式不开 lookahead |
| LED 预扫描游标 | `tests/scanCursor.test.ts` | 事件排序 / offset 只提前开灯 / 负 offset 整段平移 / reset 重走 / **只亮当前这一组**（R21） |
| 谱 vs 灯对照 | `tests/led_score_vs_lights.test.ts` | 发声时灯亮 / 灭灯落在这一组结束之后 / 同 midi 深度不为负 / 无残留 / **任何时刻最多只有一组亮着**（R21） |
| 双色带第二排（R21） | `tests/led_dual_strip.test.ts` / `tests/led_dual_strip_ui.test.ts` | 每只手各 N 个 / 亮度每往后一个 ×0.65 / N 可设 2..6 且落库 |
| 抢先模式（R23） | `tests/lead_mode.test.ts` / `tests/lead_strip.test.ts` / `tests/lead_toggle_ui.test.ts` / `tests/led_shared_key.test.ts` | **提示形状**：双手 → 第一排同时有左手和右手的灯 / 单手 → 玩家那只手 + 伴奏那只手各有一份提示 / 抢先关、Wait 关、playback → 无提示 / **推进**：右手弹对 → 只有右手的灯换到下一个音 / 左手弹对 → 只有左手的灯换 / 弹错键 → 灯不动、不报错、不计分 / 提前按 → 算命中、不报错 / 很久不弹 → 灯一直亮着（不超时、不记漏弹）/ 和弦弹一半 → 那个音的灯灭了但组不推进 / **容差**：容差最小 → 提前按照样命中 / 容差最大 → 提前按「后面那个音」也不算命中 / 上一轮弹过的键不被检索回来 / 同键在下一组 / 同组重复音两个 note 都算命中 / **冻结（2026-11-10）**：播放头冻在待弹组的**精确**谱面时间 / 弹对 → 解冻、按 1× 走到下一个待弹组再冻上 / 一直不弹 → 一直冻着 / 倍率恒为 1 / 双手：左手弹对 → 右手那组还冻着 / **单手**：伴奏 ctx 间隔 = 谱面间隔（1× 原速）/ 播放头冻在玩家那只手该弹的音上 / 倍率恒为 1 / 弹对 → 提示换到下一个音、播放头解冻往前走 / 伴奏跟着播放头走（冻住时不再往后排）/ Backspace 跳过当前音（不算漏弹、播放头解冻）/ 抢先没开 → `skipLeadNote()` 返回 false / `effectiveLead` 真值表 + 落库 / 灯带差分（新增 / 消失 / 同 midi 换手 / 和弦）/ 开关 UI（playback 与 Wait 关 → 变灰；点一下落库；Wait 关掉时勾选状态保留）/ **同键两手**：左手松手 → 右手的灯还亮 / 关掉左手 → 右手的灯不受影响、开回来能恢复 |
| 灯带**设备**选择（R29，取代 R25 的「后端选择」） | `tests/led_backend_choice.test.ts` | 选项是 **树莓派 / ESP32** 两个 / 默认树莓派 / 切完写进 localStorage（`ledDevice`）/ 切设备时地址跟着换成那台的默认 IP / 老 prefs 的 `'ble'` → `esp32`、`'ws'`/`'auto'` → `pi`（`'ws'` + 旧地址 `.108` → `esp32`）/ 两个选项同时可见 |
| **ESP32 ↔ 树莓派 一致性（R29）** | `tests/led_esp32_pi_parity.test.ts` | `set_many` 只写缓冲 / 一帧只推一次 / rgb 截断 / `set_many` 原子+越界报错 / 空 `set_many` 回 ok / 物理帧长=352 / 同时点亮颗数不限 / `off` 清整条物理链 / `init`+`status` 回报 count·physical·pin / `ping`·`status` 是设备校验接口 / `marquee` 是设备指纹 / `auth` 回 ok（14 例） |
| 跑马灯窗口上限（R30） | `tests/led_testpattern.test.ts` | `window=176` → 回 `window too large` 且一帧没跑（防栈越界→死循环→板子变砖）/ `window=64` → 正常跑 |
| 跑马灯**帧时间**按物理灯数算（R31） | `tests/led_testpattern.test.ts` | 176 颗 → `step=4` → 44 帧 ≈ 464ms / **352 颗 → `step=8` → 同样 44 帧**（证明帧时间跟逻辑 count 无关）/ 灯很少或目标很短时也不会返回 0 帧 |
| 屏幕常亮（R26） | — | 手测（浏览器 API，无自动化） |
| 练习条 UI（R27） | `tests/practice_ui.test.ts` | 容差上限 **2000ms** 且填得进去 / 音量**默认收起**、点开才有**竖向**滑块且能动 / 模式选择器没有「手别」、第一档叫「播放」/ 速度下拉含 **1.25×** 且选了就生效 |
| 配置绑定账号（R28） | `tests/prefs_sync.test.ts` / `tests/server.prefs.test.mjs` | 没登录 → 只写本地、零请求 / 登录后改配置推给服务器 / 登录那一刻账号那份落进状态和本地 / 账号那份优先于本地 / 合并结果推回服务器 / 登出后不再推 / 服务器侧存取往返 + 覆盖 + 非对象 400 + 换账号隔离 + 没登录 401 |
| 容差口径（R27） | `tests/playAlong.test.ts` | 没填过 → 120bpm 仍 250ms（曲速缩放不变）/ 填 2000 → 窗口就是 2000ms / 填 100 → 窗口 100ms / 填 2000 时晚 1 秒补弹也算命中 |
| 停播强制清灯 | `tests/led_switch_clear.test.ts` | `flush` / `reset(emit)` / `seekTo` + BWV 846 暂停（全按 / 全没按 / offset=0）与切歌端到端 |
| tempo map + 乐谱时值 | `tests/tempoMap.test.ts` | 拍网格跨变速连续；小节线跟随变速；`durInQuarter` 量纲正确（P1-18） |
| 手别置信度 + 手动纠正 | `tests/inferHands.test.ts` | voice-clusters→low / two-tracks→high；`mode=pitch` 按音高切分；`Song.handInfer` 携带置信度 |
| 合成器 voice 隔离 | `tests/synthesizer.test.ts` | 同名音左右手互不打断 |
| 冻结点回退 | `tests/player.test.ts` / `tests/repro_chopin.test.ts` | 冻在 note 精确时间；冻结时左手伴奏立刻静音 |
| WS 桥安全 | `scripts/bt_pi/tests/test_security.py` | token / Origin / 连接数 / 限流 / 消息大小 / **未鉴权不占上游连接** / 鉴权超时（18 例） |
| SPP 协议 | `scripts/bt_pi/tests/test_protocol.py` | JSON-line 请求响应 / socketpair 端到端 |

### 9.2 集成/手工验收

| 场景 | 验收标准 |
|------|----------|
| 蓝牙耳机 + 电钢 | 判定偏差 < 20ms；UI 显示当前输出延迟 |
| 有线输出 | 判定偏差 < 10ms |
| Loop 循环 5 遍 | `hits`/`misses` 不重复累加；UI 播放态始终正确 |
| 踩住踏板后暂停 | 电钢立即完全静音（无残留音） |
| 切到别的窗口再回来 | 无卡键、灯不残留 |
| 拔掉电钢 | 状态栏变红/灰；弹重连提示 |
| 同网段另一台机器 | 无法连上 WS；带正确 token 可以连上 |
| 5000 音长曲 | 60fps 下主线程占用 < 4ms/帧；下落音符平滑无 28px 台阶 |
| 变速曲（如带 ritardando 的） | 小节线 / 节拍器 / 节拍点 / 乐谱时值**全部**跟随 tempo；乐谱音符时值与实际演奏一致（P1-18） |
| 单声部（单轨）曲 | HandSelector 出现「ℹ 手别为推断」；在设置里切到「按音高切分」后手别立刻改变且不打断播放 |
| 蓝牙耳机 + 电钢 | 判定偏差 < 20ms；UI 显示当前输出延迟（默认补偿 0 = 视觉对齐） |
| 倍速（1/2×、1/4×） | 音乐**实际**按 1/2、1/4 速度播放；下落音符滚动、判定窗口、节拍器同步（P1-19） |

### 9.3 命令基线

```powershell
npm run build                                  # 必须 PASS
npx tsc -b --force                             # 必须 EXIT=0
npx vitest run                                 # 必须全绿（当前基线：41 文件 / 424 用例 / 0 Errors）
python scripts/bt_pi/tests/test_security.py   # 必须 OK（18 用例）
python scripts/bt_pi/tests/test_protocol.py   # 必须 OK（13 用例）
python scripts/bt_pi/tests/test_led_reliability.py   # 必须 OK（19 用例）
```

> **基线快照（2026-10-31）**：`tsc -b --force` EXIT=0；`vitest run` 41 文件 / 424 用例全绿；`npm run build` PASS；
> Python 三个套件 18 + 13 + 19 全 OK。

---

## 10. 附录

### 附录 A — 已排除的疑似问题（避免误报）

| 疑点 | 结论 | 依据 |
|------|------|------|
| `ws_led_bridge.py:28` `handle_client(ws, path=None)` 签名过时 | **不是 bug** | 该签名兼容 websockets 10–14（`path` 在新版被移除，故给默认值）。改动反而会破坏新版兼容 |
| `led_remote.py:145-147` 逐像素 `setPixelColor` | **不是 bug** | `rpi_ws281x` 没有批量写 API；`set`/`set_many` 已在 Python 侧批量化写 buffer，`show` 时统一刷（`:147`） |
| `pagehide` / `beforeunload` 没调 panic | **已接线，不是问题** | `src/App.tsx:258-270` 正确注册了两个事件并调用 `acc.panic()` + `synth.stopAll()` |
| 构建失败 | **不成立** | `npm run build` PASS；`npx tsc -b --force` EXIT=0 |
| `App.tsx` 里 `const song` 重复声明 | **不成立** | `const song` 出现在 67/164/175/997 行；164/175/997 均在函数体内，作用域不冲突 |
| `led_remote.py` 的 `try/except` 包 `msg.get("id")` | **死代码**，已按 P2-8 修掉 | `msg` 是 dict，`.get` 不会抛异常 |
| `Player` 冻结判定用 `this.currentTime > 0.5`（预览窗） | **不是 bug**，但要配合 P2-10 一起看 | 0.5s 预览窗是有意的（Chopin 开篇 t=0 持续音立即冻会让用户啥也没听到）；P2-10 回退后时间可能 < 0.5s，所以冻结条件加了 `\|\| this.frozen` |
| `Player` 的 `stopSounds()` 自己遍历 `playingNotes` 发 NoteOff，没调 `Accompaniment.stopAll` | **不是 bug**，见 P2-11 | `stopSounds()` 是**路由感知**的：midiOut 的音发 NoteOff、synth 的音走 `synth.stopNote`。`stopAll` 会对 synth 路由的音也发一份 NoteOff（多余且可能发错设备），已删除 |
| `store.speed` 只被 `SpeedControl` 和 `Player` 引用 | **曾是真 bug**（P1-19），已修 | 时钟层改造后 `SongClock.setSpeed()` 无调用点 → 倍速滑块失效；现构造 / 起播 / 每帧三处同步 |
| `note.duration` 是秒、`durInQuarter` 是四分音符数 | **是 bug**（P1-18），已修 | 原实现写的是 `duration × (4/den)`，量纲错了；正确是 `duration ÷ secPerQuarterAt(t)` |

### 附录 B — 本次审计的取证方式

- **逐行通读**：`src/` 全部 44 个 ts/tsx、`scripts/bt_pi/pi/` 全部 6 个 Python + 3 个 systemd unit + `install.sh`、`tests/` 全部 15 个测试文件。
- **refs 交叉验证**：本次 spec 中引用的每一处 `refs/...:行号` 都已逐条打开原文核对（sightread `player.ts:42,536-545,764-766`、`types.ts:109`、`page.tsx:101`；neothesia `midi_backend.rs:19,69-74,85-100`、`midi_player.rs:18,75-79,133-150`、`rewind_controller.rs:11-60`；piano-booster `TODO.md:11-12,18-20,25,27`；linthesia `PlayingState.cpp:460,480-481`）。
- **行业资料**：见 §3.3 的 URL 清单。
- **可执行验证**：`npx tsc -b --force`、`npx vitest run` 于 2026-10-20 实测。

### 附录 C — 变更影响面速查

| 若要改 | 会牵连 |
|--------|--------|
| `Player.stepLoop` | `PlayAlong`、`Synthesizer`、`Accompaniment`、`Metronome`、`App` 的 LED pre-scanner、`FallingNotes`、`StaffView` |
| `Player` 的两个游标（`bookkeepingIndex` / `scheduler.index`） | 记账与排程必须同步推进；`seek()` / 回卷都要重置两者 |
| `SongClock`（`src/engine/Clock.ts`） | `Player.currentTime`、`handleInput` 的判定基准、冻结/解冻锚点、节拍器 `when`、MIDI Out 的 `when` 夹取 |
| `TempoMap`（`src/util/tempoMap.ts`） | `parseMidi` / `parseXml` 的小节线、`Player` 的节拍器与 `bpmAt`、`FallingNotes` 节拍点、`inferHands.openingEndTime`、`StaffView` 的时值换算 |
| `PlayAlong` 的时间基准 | `store` 的 hits/misses/perfects/goods/errors、`StatusBar`、`StatsPopup`、`FallingNotes` 的着色 |
| `NoteEvent.source` | `emit.ts`、`LedFollower`、`InputBus`、`App.tsx:205-206`、`FallingNotes` |
| `Accompaniment.panic` | `App.tsx:258-270`（pagehide）、`Accompaniment.connect/use/refresh` |
| `store.setHand` | `App.tsx:530`、`ui/HandSelector.tsx:39,48`、`store` 的 prefs 读写 |
| `store.setHandInferMode` | `note.hand`（**就地**改，Player 持有的 song 引用不变）、LED 上色的 `handMap` memo、`HandSelector` 的提示、`SettingsDrawer` 的切换 |
| `ws_led_bridge.py` | `LedController.connect()`、Pi 上的 systemd unit、`scripts/bt_pi/README.md` |

---

**文档结束** · piano-follow 代码审计与改造 Spec v1.1 · 审计 2026-10-20 · 实施同步 2026-10-21
