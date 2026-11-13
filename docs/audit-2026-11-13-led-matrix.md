# LED 点阵屏链路审计（2026-11-13）

> 用户报障：**像素随机乱丢/乱亮** + **整体有点闪烁**。
> 范围：`src/led/screen/`（渲染 + 传输）、`scripts/bt_pi/pi/matrix_server.py`（树莓派底层帧流服务）、
> `scripts/bt_pi/pi/led-matrix.service`、`install.sh`；顺带对照 `led_anim`（hzeller librgbmatrix，仓库外）。
>
> **最终结论**（想直接看「怎么修、以后怎么查」的，读
> [led-matrix-playbook.md](./led-matrix-playbook.md)；本文是按时间线的完整记录，包含三次误判的复盘）：
> 闪 = 刷新率 94.7Hz → `--led-pwm-lsb-nanoseconds 50` 到 208.9Hz；
> 随机像素 = slowdown 2 + 亮度 100 欠压 → slowdown 3 + 默认亮度 60。

链路只有一条，但跨了四个进程：

```
浏览器 ScreenRenderer/ScreenController
   --ws 二进制帧 RGB888 (128×64×3 = 24KB/帧, 30fps)-->
matrix_server.py  (:8081, 单帧槽 + 写线程)
   --stdin 裸字节流 (8B 帧头 + 每帧 w*h*3)-->
led_anim          (root, /dev/mem, 绑 CPU3)
   --HUB75 / PMW+DMA-->
面板
```

**关键事实：`led_anim` 的 stdin 是一条没有帧边界的裸字节流**，它按 `w*h*3` 一段段切。
所以任何一次「错位」都不是「糊一帧」，而是**后面每一帧都错位** —— 屏幕表现为
「一堆随机像素乱跳」，正好对上用户的第一句描述。

---

## 1. 症状 → 根因

| # | 症状 | 根因（文件 / 位置） | 本次处置 |
|---|---|---|---|
| M1 | 随机像素、花屏 | 帧槽里可能残留**旧尺寸**的帧 → 字节流永久错位（`matrix_server.Panel.stop_proc` 不清 `_pending`；`submit` 不校验帧长） | ✅ 换尺寸清槽 + 入槽校验 + **写前再校验** + `frames_bad` 记账 |
| M2 | 随机像素、花屏 | 两个写线程抢同一个 stdin（`self._stop` 是跨代共用的布尔量，`start()` 把它置 False 会把上一代线程「复活」） | ✅ 每代一个 `Event` + `stop_proc()` join 旧线程 + 先 terminate 再 close 防死锁 |
| M3 | 画面定格/黑屏 | 写线程写失败只 `log` 一句就 break，屏从此不动，直到下次重连 | ✅ 记账 + 下一帧 `ensure_running()` 重拉 `led_anim` |
| M4 | 抖 + 闪 | `MAX_CLIENTS=2`，两个标签页各推一路帧；而前端实现的是**1012 接管**，服务端从没发过 1012 | ✅ 默认接管（旧连接收 `1012`），并只认一个 owner 的帧 |
| M5 | 乱闪/全黑 | **灯带服务 `led_remote.py` 也在跑**：它和面板抢 GPIO18 的 PWM0_0 + DMA（前端设置里早就写了这条警告，但服务端不吭声） | ✅ 启动时扫 `/proc` + `snd_bcm2835`，`log.error` 点名；`status` 里给 `gpio_conflicts` |
| M6 | 整体明暗闪 | 刷新率随系统负载抖动（每 33ms 收一帧 + 写管道 = 典型的网络/IO 干扰） | ✅ 新增 `MATRIX_LIMIT_REFRESH`（service 里默认 120）+ 文档写清 `isolcpus` |
| M7 | 随机像素、局部花屏 | GPIO 写太快，面板收不稳（hzeller README 原话：`randomly showing up pixels` / `parts of the panel showing static`） | ✅ `--slowdown` 默认 2 → **3**（Pi4 建议值），可用 `MATRIX_SLOWDOWN_GPIO` 调 |
| M8 | 满屏音符 1px 抽动 | 音符高度 `round(y-h)` 与 `round(y)` 各自取整，不同步 → 高度在 N/N+1 之间每帧跳 | ✅ 先定高度再反推上沿；回归测试钉住 |
| M9 | 卡顿后猛跳 | `ws.send()` 无背压上限：树莓派一慢，浏览器队列越攒越长，恢复时一口气灌一串过期帧 | ✅ 积压 > 1 帧就丢当前帧（`frameGate.ts`） |
| M10 | 屏更亮/更暗地「呼吸」 | 暂停时画面没变也照样 30fps 推 24KB，树莓派 CPU 一忙刷新率就抖 | ✅ 逐字节比上一帧，一样就跳过；每 500ms 保活补发 |
| M11 | 刷新页面黑一下再亮 | 客户端一走就 `stop_proc()` → `led_anim` 重起 + 重新拿 `/dev/mem` | ✅ 空闲宽限 15s（`MATRIX_IDLE_STOP_S`） |
| M12 | 新机器装不上 | `install.sh` 完全没装 `matrix_server.py` / `led-matrix.service` | ✅ 补上（`-f` 守卫，没有这些文件不影响老机器） |
| M13 | 换系统起不来 | `from websockets.asyncio.server import serve` 需要 websockets ≥ 13 | ✅ `_resolve_serve()` 兼容 ≤ 12 的旧 API + handler 多收一个 `path` |

次要：

- `led-matrix.service` 传的 `--led-hardware-pulse` **不是** hzeller 的标准 flag（标准的是
  `--led-no-hardware-pulse`）。面板既然能亮，说明 `led_anim` 没有对它严格报错；**保持原样没动**，
  但值得在 `~/led` 里确认一句，别在升级库之后突然被当成 unknown option 顶掉。
- `Panel.start()` 的告警文案说「led_anim 会按 contain 缩放」，实际命令行传的是
  `--scale stretch` —— 已顺手改成「缩放/变形」，不再自相矛盾。

---

## 2. 逐条详解（挑四条最容易误判的）

### M1 帧流错位 —— 「随机像素」的头号嫌疑

`led_anim` 的 stdin 没有帧边界：

```
[8 字节帧头][w*h*3][w*h*3][w*h*3]...
```

它每轮 `read(w*h*3)`。只要混进一个长度不对的块，**后面全部错位**，而且不会自愈 ——
只有重启进程才恢复。旧代码有三条路能让它发生：

1. `stop_proc()` 不清 `_pending`：换屏数时（帧宽 128→256）旧帧可能排在新的 `_pending` 里；
2. `submit()` 不校验长度：客户端算错（比如多屏时 `screens` 与 `width` 不一致）也照收；
3. `_run()` 里的 `expect` 用的是 `panel.width*height*3`，而 `panel.width` 在新 init 之前
   还是旧值 —— 窗口期能漏过去。

现在三道全堵：`submit()` 校验 `len == _frame_size`；**写线程再校验一次**（防槽位跨代）；
换尺寸/重启时清槽。判别方法：`status` 里的 `frames_bad` 只要不涨，流就不会错位。

### M4 两个客户端 —— 「抖 + 闪」最像的软件原因

前端 `ScreenController` 早就有这段：

```ts
if (ev.code === REPLACED_CODE) { this.replaced = true; ... 不再重连 }
```

但服务端的 `MAX_CLIENTS` 是 **2**，第三个才拒；也就是说**两个标签页能同时推帧**，
面板在两路画面之间来回切。刷新页面时更隐蔽：旧 WS 还没被判定断开，新 WS 已经连上 →
短时间两路并存。

现在：新客户端连上就按 1012 踢旧的，`_owner` 记「谁在推帧」，旧连接上的在途帧一律不入口。
前端那边的 1012 处理终于有对应的服务端行为了。

### M6/M7 硬件层的两件事（代码改不了，但能配对）

来自 hzeller README（[原文](https://github.com/hzeller/rpi-rgb-led-matrix)）：

- `--led-slowdown-gpio`：*"artifacts like randomly showing up pixels, color fringes, or parts of
  the panel showing 'static'"* → 往上加。Pi4 明确说 *"may need a higher slowdown"*。默认改 3。
- `--led-limit-refresh`：*"a faint flicker, which can happen due to hardware events (network access)"*
  → 固定刷新率。我们这条链路 30fps 收帧，正好是这种负载。service 里默认 120Hz。
- 刷新线程独占 CPU3 只靠 `taskset` 是「尽量」；要真独占得在 `cmdline.txt` 加
  `isolcpus=domain,managed_irq,3 nohz_full=3 rcu_nocbs=3 irqaffinity=0,1,2`（已写进 service 注释）。
- `snd_bcm2835` 必须卸掉（库发现它就退出），`ExecStartPre` 已有；服务里也加了检测。

### M8 渲染的 1px 抖动

下落速度 `hitY/2.2` = 21.8px/s，30fps 下每帧 0.73px。旧代码：

```ts
const yTop = Math.max(0, Math.round(y - h))
const yBottom = Math.min(hitY, Math.round(y))
```

两个 `round` 各自独立 → 高度 = `round(y) - round(y-h)`，在 N / N+1 之间来回跳。
满屏十几条音符同时每秒抽几十次，肉眼就是「整体在闪」。现在：

```ts
const hPx = Math.max(4, Math.round(h))          // 高度先定死
const yTop = Math.max(0, Math.round(y) - hPx)   // 只让下沿动
```

回归测试 `tests/led_screen_render.test.ts` 的「音符下落时高度不抖」在旧实现上**必然失败**
（已逐个回退验证）。

---

## 3. 改动清单

| 文件 | 改了什么 |
|---|---|
| `scripts/bt_pi/pi/matrix_server.py` | 帧通道重写：代际化写线程、帧长双校验、换尺寸清槽、写失败自动重拉、单客户端接管（1012）、owner 判定、空闲宽限停屏、GPIO 冲突检测、诊断计数、`--limit-refresh` / `--pwm-lsb-ns` / `--slowdown` / `--show-refresh` / `--takeover` / `--idle-stop-s`、websockets 新旧 API 兼容 |
| `scripts/bt_pi/pi/led-matrix.service` | 抗闪烁参数（`MATRIX_LIMIT_REFRESH=120`、`MATRIX_SLOWDOWN_GPIO=3`）+ 注释说明每个旋钮对应哪种症状 + `isolcpus` 建议 |
| `scripts/bt_pi/pi/install.sh` | 安装 `matrix_server.py` + `led-matrix.service`，状态输出带上点阵屏 |
| `src/led/screen/frameGate.ts` | **新增**：背压 + 相同帧跳过 + 保活的纯函数 |
| `src/led/screen/ScreenController.ts` | 用上 frameGate；发送成功才更新「上一帧」；`init` 后强制重发一帧；丢帧/跳帧计数 |
| `src/led/screen/ScreenRenderer.ts` | 音符高度不再抖动；`extract()` 内联 quantize + 预排列偏移（每帧少 ~1M 次函数调用）；屏号越界夹取 |
| `tests/led_screen_frame_gate.test.ts` | **新增** 12 例 |
| `tests/led_screen_render.test.ts` | 新增「高度不抖」（1 例） |
| `scripts/bt_pi/tests/test_matrix_server.py` | **新增** 9 例：帧长拒收 / 旧尺寸槽位 / 换尺寸换写者 / 单槽丢帧 / 进程死了重拉 / 诊断字段 / 接管 1012 / owner 唯一 |
| `docs/deployment.md` | 端口表加 8081；新增 §1.7 点阵屏排障（症状 → 旋钮） |

行为兼容性：帧率/协议/画面内容都没变；`status` 只是**多**了几个字段；不对 `--led-hardware-pulse`
做改动；`install.sh` 的所有新增步骤都有 `-f` 守卫。

---

## 4. 验证

```
npx tsc -b --force                       → 0 error
npx vitest run                           → 67 文件 / 718 例 全绿（原 662 例）
python scripts/bt_pi/tests/test_matrix_server.py      → 9 OK（新增）
python scripts/bt_pi/tests/test_led_reliability.py    → 24 OK（1 skip）
python scripts/bt_pi/tests/test_security.py           → 18 OK
python scripts/bt_pi/tests/test_protocol.py           → 13 OK
```

回归有效性：把 `ScreenRenderer` 的 `yTop` 改回 `round(y-h)`，新用例**失败**；改回来**通过**。
Python 的帧长用例同理（旧实现没有 `submit()` 的长度校验）。

**没做**：真机验证（手边没有树莓派/面板）。第 5 节是上机后该怎么确认。

---

## 5. 上机验证步骤

```bash
# 1) 部署
sudo bash scripts/bt_pi/install.sh          # 会装上 matrix_server + led-matrix.service

# 2) 先把会抢 GPIO18 的灯带服务停掉（这是 M5）
sudo systemctl stop led-remote.service
sudo modprobe -r snd_bcm2835

# 3) 起面板, 看启动日志
sudo systemctl restart led-matrix.service
journalctl -u led-matrix.service -n 40 --no-pager
#   期望: "起 led_anim: taskset ..." / "GPIO 检查: 没发现抢 GPIO18 的东西"

# 4) 打开页面, 盯计数
#    status 里 frames_bad 必须一直是 0; frames_drops 缓慢增长是正常 (画不完丢帧),
#    writer_errors / restarts 必须是 0
```

> 页面里要先把「Pi 令牌」填上（跟灯带共用 `/opt/bt-gpio/led_token`）——
> `install.sh` 生成 token 之后，不带 token 的连接会被 `auth failed` 挡掉，
> 表现就是「屏一直不亮，但服务一切正常」。

调参顺序（一次只改一个，每次 `systemctl restart`）：

1. **随机像素** → `MATRIX_SLOWDOWN_GPIO=4`（还不行 5）→ 不行就查排线/电平转换。
2. **整体明暗闪** → `MATRIX_SHOW_REFRESH=1` 看刷新率；抖得厉害就把 `MATRIX_LIMIT_REFRESH`
   往下调（120 → 100），仍抖则加 `isolcpus`。
3. **鬼影像素** → `MATRIX_PWM_LSB_NS=150`。
4. 稳定之后再把 `MATRIX_LIMIT_REFRESH` 调到 0 对比亮度和闪烁，取一个平衡。

---

## 6. 还没解决 / 已知风险

1. **`--led-hardware-pulse` 这个 flag 来源不明**（见 §1 次要）。它要么被 `led_anim` 自己定义，
   要么被静态忽略；建议到 `~/led` 里确认，别在升级 hzeller 库之后被当作 unknown option 打回。
2. **面板的真实参数没核实** —— 见 §7，这是第二轮的主线。
3. **`led_anim` 只喂 30fps，自己按 60 上限跑**。若以后要 60fps 推帧，先确认 Wi-Fi 与树莓派
   CPU 余量，并把 `MATRIX_LIMIT_REFRESH` 一起调。
4. **面板与灯带不能同机**：同一台 Pi 上两条路都碰 GPIO18 的 PWM/DMA，无解；
   要同时用就把灯带挪到 ESP32（前端设置里已有这条提示）。

## 7. 第二轮（2026-11-13 晚）：上面那些都改了，还是闪 + 乱像素 → 上机实测

第一轮改的全是**数据通路**（帧完整性、单写者、单客户端、背压、1px 抖动）。
用户复测「还是闪」，而且**当时并没有部署**（树莓派上跑的还是旧代码）——
所以那一轮等于没测。这一轮直接连上树莓派（SSH + WS）量了一遍。

### 7.1 先纠正一个我自己的误判

我一开始根据 `docs/D-P2/*.rcfgx`（`ModulePixelCols=160` / `Scan_40`）推断面板是
P2 160×80 / 1/40 扫描，**这个推断是错的** —— 用户确认面板是 **P2.5 128×64 / 1/32**。
那批 rcfgx 不是这块屏的配置。教训：**别拿目录里碰巧存在的厂商配置当硬件事实，
先问。**

（`panel_probe.py` 仍然留着：换面板/怀疑几何时它是唯一能一眼看出「四条边齐不齐」的工具。）

### 7.2 实测到的事实

| 项目 | 实测值 | 结论 |
|---|---|---|
| 面板刷新率（原配置：`pwm-bits 7` + **hzeller 默认 `pwm-lsb 130ns`**） | **94.7 Hz**（最低 89.6） | **低于 100Hz —— 这就是「整体有点闪」的根源** |
| `pwm-lsb 50ns` | **208.9 Hz**（最低 197.7） | 翻倍，越过频闪门限 |
| `pwm-lsb 50 + pwm-bits 6` | 220 Hz | 还能再高，但色彩档位变少 |
| `slowdown 2 / 3 / 4` | 94.7 / 99.8 / 98.3 Hz | **slowdown 几乎不花刷新率** → 该加就加（治随机像素） |
| 亮度 | 服务默认被改成了 **100**（`matrix_server.py.bak-20261113-bright100`） | 大面积白色 + 100% 亮度把 5V 拖塌（`throttled=0x50000`，用户日志实测亮度 25 全屏就欠压） |
| `taskset` 绑核 | 当前 Pi 版 `--cpu` 默认 **-1（不绑）** | 用户日志实测：绑核 56fps→15fps、抖动 12%→32.7%，**不绑才对** |
| `isolcpus=3 nohz_full=3 ...` | `/boot/firmware/cmdline.txt` 里有，但 `/proc/cmdline` 里**没有** | 机器 up 1 天 21 小时，cmdline 是之后改的 → **没重启，参数从未生效** |
| GPIO18 冲突 | `snd_bcm2835` 未加载；`led_remote` **没在跑**（8080 桥报 127.0.0.1:7777 连不上） | 不是抢引脚的问题 |
| `--led-hardware-pulse` | 这台机器装的 hzeller 版本里**确实是真 flag**（`options-initialize.cc:208`），语义 = 打开硬件脉冲 | 硬件脉冲本来就是开的，不用改 |

### 7.3 这轮改了什么（都已部署到 192.168.1.113）

| 位置 | 改动 |
|---|---|
| `led-matrix.service` | `MATRIX_PWM_LSB_NS=50`（95→209Hz）、`MATRIX_SLOWDOWN_GPIO=3`、`MATRIX_BRIGHTNESS=60`；把上面那张实测表写进注释，免得以后被「优化」回去 |
| `matrix_server.py` | ① 默认**不绑核**（`--cpu -1`），并写清用户实测数据；② **接管从「连上就踢」改成「发 matrix.init 才踢」**——我这次用脚本查了一次 `status`，就把正在推帧的浏览器踢了，而前端收到 1012 后按设计不再重连，面板直接黑掉。现在查状态不再抢占；③ 非 owner 推的帧直接丢但不断开连接；④ `MATRIX_BRIGHTNESS` / `MATRIX_CPU` 环境变量；⑤ 帧长双校验、换尺寸清槽、`ensure_running` 自动重拉、空闲宽限 15s |
| `tests/test_matrix_server.py` | 接管语义改完后重写：`test_second_init_takes_over_with_1012` / `test_status_probe_does_not_take_over` / `test_frames_from_non_owner_are_ignored` |

部署已验证：`matrix.init` → 20 帧 → `frames_in=20 drawn=20 bad=0 drops=0`，
`led_anim` 命令行带上 `--led-pwm-lsb-nanoseconds 50`，`--led-brightness 60`，无 `taskset`。

### 7.4 还需要用户做的事
1. **刷新一次页面**（我刚查状态时旧版把它踢了，收到 1012 的页面不会自己重连）。
2. 看屏：频闪应该从「一眼能看出来」变成「看不出」。
3. 若能看到轻微鬼影/发暗 → 把 `MATRIX_PWM_LSB_NS` 从 50 调到 80 折中。
4. `isolcpus` 那条参数**要重启才生效**，而用户日志自己写着「不绑核反而更好」——
   所以**不急着重启**；真要试，先记录当前抖动再对比。
5. 供电仍然是隐患（`throttled=0x50000`）：亮度已经压到 60，长期还是建议换 5V/大电流电源
   或给面板单独供电。

## 8. 第三轮：亮度做成可调 + 点阵屏挪到首页右上角（2026-11-13 深夜）

用户要求：「加上 LED 亮度设置」+「把 LED 屏幕从进阶设置里提出来，放到首页右上角」。

### 8.1 亮度为什么要放在树莓派那一层

`--led-brightness` 是 hzeller 的**启动参数**，改一次就得重启 `led_anim`
（重新拿 `/dev/mem`，屏会黑 1 秒左右）—— 而亮度滑块是要能一边拖一边看的。
所以：

- `led_anim` 固定 `--led-brightness 100`（满值）；
- 真正的亮度在 `matrix_server` 按帧缩放：`frame.translate(lut)`，
  256 字节查找表，24KB/帧 一趟 C 循环（~10µs），**不重启进程、不闪黑**；
- 协议加了 `{"op":"matrix.brightness","args":{"brightness":37}}`，
  `matrix.init` 也接受 `brightness`（重连/刷新页面后设置能恢复）；
- `status` 回 `brightness`，前端如需显示真实值可以直接读。

`MATRIX_BRIGHTNESS` 现在只是「页面上还没设置过时的默认值」，之后以 localStorage 为准。

### 8.2 UI

| 文件 | 改动 |
|---|---|
| `src/store.ts` | 新增 `ledScreenBrightness`（1..100，默认 60）+ `clampScreenBrightness` + 持久化 |
| `src/ui/LedScreenSettings.tsx` | 新增「亮度」行（滑块 + 百分比），拖动即时下发 |
| `src/ui/LedScreenDock.tsx` | **新增**：点阵屏的右上角入口（inline 进顶栏 / floating 全屏时浮着），状态牌复用 `LedScreenStatus` |
| `src/ui/TopBar.tsx` | 图标排里加一个格子图标（灯带 💡 旁边） |
| `src/App.tsx` | 全屏时浮窗也挂上；亮度变化 → `screenRef.setBrightness()`（不重连） |
| `src/ui/SettingsDrawer.tsx` | **删掉**「LED 点阵屏」那一栏；宽度 1440 → 1180（三栏正好） |
| `src/led/screen/ScreenController.ts` | `setBrightness()` / `getBrightness()`、init 带 brightness |
| `scripts/bt_pi/pi/matrix_server.py` | `Panel.set_brightness` / `_build_lut` / `matrix.brightness` op |
| `tests/led_screen_dock.test.ts` | **新增** 4 例：浮窗里有亮度滑块且默认 60 / 拖了会落库 / 越界夹回 1..100 / 抽屉里不再有点阵屏 |
| `tests/test_matrix_server.py` | 新增 2 例：亮度按帧缩放（255→128 @50%，帧长不变）、越界夹取 |

部署已验证：`matrix.init(brightness=60)` → 推帧 → `matrix.brightness=25`
→ `status.brightness=25`，`frames_drawn` 继续增长、`led_anim` 命令行仍是
`--led-brightness 100`（说明是软件缩放在起作用，没有重启进程）。



