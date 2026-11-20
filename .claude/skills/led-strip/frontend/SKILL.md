---
name: led-strip-frontend
description: 前端灯带逻辑 —— LedController (影子表 / setMany 80 / resync)、LedFollower (多源追踪 / 命中脉冲 / off-grace)、scanCursor 的「组」语义 (第一排只亮当前这一组)、dualStrip (第二排接下来 N 个 + 亮度 0.65^i)、提前量解耦、设备选择器 (树莓派 / ESP32, 蓝牙那条路 2026-11-10 已删)。改前端灯带行为、显示语义、连接策略时读这个技能。
---

# 前端灯带逻辑

## 1. 分层

```
App.tsx
 ├─ LedFollower ──(输入事件)──────────► LedController.noteOn/Off
 ├─ LedScanCursor ─(谱子预扫描)───────► LedController.noteOn/Off
 └─ NextNoteIndex ─(谱子索引)─────────► LedController.setUpperHints
                                            │
                                            ▼
                              WsTransport (用户选树莓派 / ESP32)
```

- **主灯带 (第一排)** = 真实按键 + 谱子预扫描的灯, 走 `LedController` 的影子表。
- **上灯带 (第二排)** = 只由 `setUpperHints` 驱动, 走独立的上灯带增量通道。

## 2. 播放语义 (2026-10-31 起, 规格 R21)

### 第一排: 只亮「当前这一组」

```
开灯 = note.time
灭灯 = min(下一组开始, note.time + NOTE_BAR_LIFETIME_S)   // NOTE_BAR_LIFETIME_S = 0.5
```

- **「组」= 同一时刻的所有 note**。有些谱子同一时间要按两个音 (双手同时),
  所以「组」不是「和弦」而是**按时间戳分组**。
- **任何时刻最多只有一组亮着** —— 同一时刻边界上, 新组的 ON 排在旧组的 OFF 之前
  (`takeOn = onT <= offT`)。
- **跟弹 / 等待模式不需要特判**: `Player.freezeAt()` 把 `currentTime` 冻结在需要的音的
  准确时间点上 → 时钟不走 → 下一组不开始 → 该音的组一直亮着。
  「卡壳时明确知道当前该是什么」就是这么实现的。
- 实现: `src/led/scanCursor.ts` 的 `groupEndTimes()` + `build()`。

### 第二排: 左右手各自接下来 N 个

- `NextNoteIndex.at(t, count)` 返回 `{ left: SongNote[], right: SongNote[] }`,
  每只手各取 count 个 (按时间排序的第一个 `time > t`)。
- **亮度每往后一个 ×0.65** (`UPPER_LEVEL_FALLOFF`): 第 i 个 (0-based) = `0.65 ** i`。
- N ∈ 2..6 (`ledUpperNoteCount`, 默认 3), 在**首页 💡 浮窗** (`LedDock`) 和 ⚙ 抽屉都能设。
  上限 6 的原因: 4N 颗上灯带 + 第一排的一组 ≤ 30 颗 (硬件上限)。
- 同一个 midi 出现两次 (左右手同一音高) → **取更亮的那个** (平手取后面的, 保留「右手色覆盖」)。
- 实现: `src/led/dualStrip.ts` + `LedController.applyUpper()`。

### 抢先模式: 弹对了才推进 + 冻在「现在该弹的那一组」上 (2026-11-10 再修订, 规格 R23)

跟弹控制条上 Wait 后面有个「抢先」勾选框 (`store.leadNext`, 依赖 Wait)。开着的时候:

- **第一排**: 停掉 `LedScanCursor` 的扫描循环, 改由 App 的 rAF 循环按 `Player.getLeadHint()`
  驱动 —— 亮的是「**现在该弹的那一组**」(每只手各一个游标, 两手各一盏灯)。
  差分逻辑在 `src/led/leadStrip.ts` 的 `diffLeadHints()` —— 按 **(midi, 手)** 配对,
  同键双手各占一个灯位 (同 midi 换手 → 灭旧的 + 点新的; 同 midi 同手 → 不动)。
- **第二排**: 查询基准时间**按手**取 (提示音时间 − 0.001s)
  (`NextNoteIndex.findNext` 是严格 `time > t`, 减一点点才能含住提示音本身)。
- **灯一直亮到弹对为止** —— 不超时自动跳过, 不自动记漏弹。
- **提前按不报错** —— 弹的不是当前待弹的那一组 → 什么都不做 (不进 `PlayAlong.userPress()`,
  所以既不判 `'wrong'`, 也不会让上一轮弹过的键从 `recent` 里被检索回来)。
- **判定不受容差影响** —— 命中只看「是不是当前待弹的那一组」, 完全不看时间。
- **提示灯走独立通道** (`NoteSource = 'lead'`, `src/led/emit.ts` 的 `emitLedLead()`):
  ① 不受「跟随乐谱」(followSource) 过滤影响 —— 那是「该弹哪个」的状态投影, 不是声音;
  ② `Player.handleInput()` 忽略 `'lead'` —— 提示灯一亮就被当成玩家按键 → 白送一个命中。

抢先模式关掉时, 两排灯带**完全回到上面那套语义** (第一排 = 当前这一组)。

> ★ **一条路 (2026-11-10 再修订)**: 抢先 = **Wait 的冻结** + 提前按不报错 + 灯常亮。
> - 播放头**冻在「现在该弹的那一组」的精确谱面时间上** (冻结点 = `leadFreezeTarget()`,
>   自己算 —— 抢先不往 `PlayAlong.required` 里登记, 所以不能用 `required`)。
> - **弹对了才解冻**, 按 **1×** 走到下一个待弹组 → 再冻上。
> - **倍率恒为 1** —— 曲子的整体节奏 = 谱面原速 (不等你); 「等你」靠冻住, 不靠加速。
>   (2026-11-08 那套「跟着玩家速度走、封顶 2×」的加速公式**已删** ——
>   `SongClock.setRate()` 机制保留但 `Player` 恒 `setRate(1)`。)
> - 双手和单手**完全一样**; 单手时伴奏 1× 原速, 伴奏那只手在第一排的灯**正常显示**
>   (正在响的那一组), 玩家那只手按游标走。
>
> 实现见 `Player` 的抢先模式段: `leadPress()` / `syncLead()` / `refreshLeadHint()` /
> `leadFreezeTarget()` / `syncLeadModeState()`。

### 提前量已解耦 (2026-10-31)

- App 一律传 `offsetMs = 0`, **不再依赖 `ledOffsetUnits`**; 滑块组件 `LedOffsetControl.tsx` 已删。
- `scanCursor.advance(nowMs, offsetMs, emit)` / `levelOf(...)` 的签名保留 (渐亮代码休眠但可用)。
- `store.ledOffsetUnits` 现在**什么都不影响** —— 「提前按」这个独立模式 2026-11-05 已删
  (`Player.earlyPressWindowMs()` / `store.ledForceWait` / `EarlyPressToggle` / `handQueue` 全删),
  判定窗口恒为命中窗口。

### `LedFollower` 的 off-grace 只留给输入源 (2026-10-31)

```ts
const graceMs = src === 'input' ? (this.opts.offGraceMs ?? 0) : 0
```

- grace 的用途是压真实键盘的 `note_on(velocity=0)` / `note_off` 竞态闪烁 → 只对 `input` 有意义。
- 播放源的灭灯必须**立即**: 下一组已经在同一帧点亮了, 再等 60ms grace 会让
  「两组灯」同时亮着 (用户明确要求过)。

## 3. `LedFollower` 的状态机

| 概念 | 说明 |
|---|---|
| `pressed: Map<midi, Map<source, {hand, count}>>` | **按源 + 计数**。同一个 midi 在同一源下可以先后出现多个 note (巴赫 BWV 846 左手 C4 每小节重复) —— 必须记计数, 否则前一个的 NoteOff 会把后一个的灯灭掉 |
| `hitTimers` | 命中反馈脉冲 (150ms)。不参与 pressed; 到期时若还有源按着 / 是预览目标 → 不灭灯 |
| `pendingOff` | 延迟灭灯的定时器 |
| `previewed` | 暂停时的「下一组」预览, 与 pressed 互不冲突, 真在响的优先级更高 |
| `suspended` | 跑马灯期间挂起: 只记状态不写灯带, `resume()` 时 `repaint()` 一次 |

多源规则 (spec P1-9): 同一个 midi 被 input / playback 同时点亮时, **任一源的 up 都不熄灯**;
所有源都松手才熄。

## 4. `LedController`

- **影子表**: 记录「应该亮什么」, 超时/报错时 `resync()` 整条重刷, 清掉幽灵像素。
- `setMany` 一批最多 **80** 个像素 (`CHUNK = 80`), 超过自动切块。
- `expectReply` 只对 `show` / `off` / `init` / `marquee` 为 true。
- 上灯带的状态机 (2026-10-2x 修的「熄着」bug):
  - `clearUpperHints()` → **熄着** (上层说「没有了」); 内容不变就不许自己回来。
  - `upperHold` → 跑马灯期间**硬让路**, 跑完才松。
  - `allOff()` → **不**熄着 (它是物理清零, 语义跟主灯带一样: 恢复播放/换歌后提示该继续显示)。
  - `upperPixels` **写成功了才更新** —— 连接没建好时不能记成成功, 否则连上后永远补不回来。

## 5. 传输层: 一条 WebSocket 路, 设备由**用户**选

★ **2026-11-10: 蓝牙那条路整个删了**。ESP32 的新固件自带 WebSocket server
(端口 8080), 协议跟树莓派那座桥 (`led_remote.py`) **逐字段一样** —— 所以现在
**只剩一个传输层** (`WsTransport`), 前端唯一的区别是「连哪台 + 引脚多少」。

| 删除的东西 | 为什么 |
|---|---|
| `src/led/transport/BleTransport.ts` | Web Bluetooth 那条路没人用了 |
| `src/led/transport/bleDevice.ts` / `webBluetooth.ts` / `withTimeout.ts` | 只被 BleTransport 用 |
| `src/led/transport/BackendTransport.ts` | 它存在的唯一理由是「蓝牙 or WiFi 二选一」 |
| `src/ui/icons.tsx` 的 `IconBluetooth` | UI 里没有蓝牙入口了 |

### 设备选择器 (取代「后端」选择器)

`src/led/transport/ledConfig.ts`:

```ts
export const LED_DEVICE_INFO = {
  pi:    { label: '树莓派', defaultHost: '192.168.1.113', pin: 18, supportsDeviceMarquee: false },
  esp32: { label: 'ESP32',  defaultHost: '192.168.1.108', pin: 14, supportsDeviceMarquee: true  },
}
```

- `ledDevice` (store) = 选哪台; `ledActiveDevice` = **真的连上**的是哪台 (连上才写, 断开置 null)。
- **引脚按设备走** —— 树莓派 18 (白名单 12/18/21, 会真切 GPIO), ESP32 14 (编译期固定,
  传别的树莓派会拒)。前端 `init` 时按设备发对的值。
- **设备端跑马灯只有 ESP32 有** (`marquee` op) → `supportsDeviceMarquee` 按设备声明。
  树莓派那边回 `unknown op: 'marquee'` → 前端自动回退到逐帧发。
- 切设备时, 地址正好是「另一台的默认地址」→ 跟着换; 用户自己改过的地址**不动**。

### 怎么确认连的是哪台 (设备校验接口)

固件里**没有** HTTP 健康检查端点 —— 校验只能走 WS 的三个 op:

| op | 树莓派 | ESP32 | 用途 |
|---|---|---|---|
| `ping` | `{ok:true, pong:true}` | 同左 | 活着没 |
| `status` | `{ready, count, physical, pin, sets_pending, last_show_age_s}` | 同形 | 几颗灯 / 哪个 GPIO |
| `marquee` | `{ok:false, error:"unknown op: 'marquee'"}` | `{ok:true, frames:N}` | **设备指纹** |

`pin` 字段 (树莓派 18 / ESP32 14) 能认出连的是哪台; `marquee` 的回包是第二个指纹。

### HTTPS 部署

树莓派/ESP32 都是明文 `ws://`, 会被浏览器按 mixed content 拦掉 → 服务端
`scripts/serve-dist.mjs` 的反代按**设备**路由:

| 路径 | 上游 | 环境变量 |
|---|---|---|
| `/led-proxy/pi` | 树莓派那座桥 | `LED_WS_TARGET_PI` (默认 `ws://192.168.1.113:8080`) |
| `/led-proxy/esp32` | ESP32 固件的 WS server | `LED_WS_TARGET_ESP32` (默认 `ws://192.168.1.108:8080`) |
| `/led-proxy` | 树莓派 (老路径, 兼容) | 同 `LED_WS_TARGET_PI` |

⚠️ HTTPS 下前端填的「设备地址」**不生效** —— 生效的是服务器上配的那两个环境变量。
局域网直连 (HTTP 部署 / 本地调试) 时才用那个地址栏。

### 建连超时

WS 建连总上限 **20 秒** (`WS_CONNECT_TIMEOUT_MS`), 握手每步 **5 秒**, 运行时命令
**1 秒** → 不存在「无声无息卡住」; 报错的消息里带 url, 一眼看出是地址填错还是设备没开机。

## 6. 前端可调项 (`store.ts` 的 prefs, 落在 localStorage `piano-follow.prefs.v1`)

| 字段 | 默认 | 说明 |
|---|---|---|
| `ledEnabled` | `false` | 灯带总开关 (要用户在 UI 里开) |
| `ledBrightness` | `0.5` | 主灯带亮度 (主机侧乘) |
| `ledHost` | `192.168.1.113` | **设备地址** —— 树莓派或 ESP32 的 IP |
| `ledDevice` | `'pi'` | `'pi'` (树莓派) \| `'esp32'` (ESP32)。老 prefs 的 `ledBackend` (`'ble'`/`'ws'`/`'auto'`) 只用来迁移 |
| `ledToken` | `''` | 树莓派 WS 桥的共享 token (ESP32 不校验, 填了自动跳过) |
| `ledDualStrip` | `false` | 双色带 (352 颗) |
| `ledUpperBrightnessRatio` | `0.7` | 上灯带 = 主灯带 × 这个比例 |
| `ledUpperNoteCount` | `3` | 上灯带每只手显示几个 (夹到 2..6) |

### ★ 2026-11-08: 配置同时存**账号**里 (R28)

- prefs 存两处: localStorage (本地那份) + 服务器 `user_prefs` 表 (账号那份).
- **没登录 → 只存本地**; 登录了 → 改配置**两边都改** (本地立刻写, 服务器 debounce 400ms 推一次).
- 登录那一刻 → 拉账号那份下来, **账号那份优先**于本地, 落回 UI 状态 (换设备登录 → 用自己那套
  `ledHost` / `ledToken` 等), 再把合并结果推回服务器.
- `store.prefsState()` 是「prefs → store 状态」的唯一推导入口 —— 服务器那份落地时走同一条路
  (默认值 / 夹取 / 老字段迁移). 别在别处另写一份映射.
- 接口: `GET /api/prefs` / `PUT /api/prefs` (需登录). 见 `docs/spec-2026-10-20-code-audit.md` §4.4 R28.

## 7. 测试

- `npx vitest run` —— 基线 **63 文件 / 658 用例 + 1 跳过** (2026-11-10 删掉两条 BLE 路之后)。
- 灯带的对照测试 harness: `tests/helpers/ledHarness.ts` —— 把谱子算成「每个 note 的灯该亮的区间」
  当真值, 把物理灯的 noteOn/noteOff 回放成区间, 逐 note 对照。
  真值模型 = **组语义** (`expectOffOf(i) = min(groupEndMs[i]/1000, note.time + 0.5)`),
  显示 offset 固定 0。
- ESP32 ↔ 树莓派的一致性回归网: `tests/led_esp32_pi_parity.test.ts` (14 例, 跑在
  `WsTransport` 上) + `tests/helpers/esp32Model.ts` (固件的 **WS 形状** 模拟器)。
- 关键用例: `tests/led_score_vs_lights.test.ts`
  (含「任何时刻最多只有一组音亮着」) 、`tests/led_follower.test.ts`
  (含「播放源不等 grace, 输入源还是等 grace」) 、`tests/led_dual_strip*.test.ts`。
- 改完前端务必跑 `npx tsc -b` + `npx vitest run`, 并把 `docs/spec-2026-10-20-code-audit.md`
  里的基线用例数同步更新。
