# HUB75 点阵屏排障与调参手册（2026-11-13 实战沉淀）

> **一句话结论**：这块 128×64 屏「整体闪」的真因是**刷新率只有 94.7Hz**
> （hzeller 默认 `--led-pwm-lsb-nanoseconds=130`）；改成 **50ns → 208.9Hz** 就不闪了。
> 「像素随机乱闪」是两个叠加因素：**GPIO 写太快**（slowdown 2）+ **亮度 100 把 Pi 的 5V 拖塌**（欠压 →
> 逻辑电平塌 → 面板锁存错数据）；slowdown 调 3、默认亮度降到 60 之后消失。
>
> 本文是**可复用的排查套路**，不是流水账。按时间线的完整记录见
> [audit-2026-11-13-led-matrix.md](./audit-2026-11-13-led-matrix.md)。

链路（四个进程，任何一环都能「局部正常、整体不对」）：

```
浏览器 ScreenRenderer/ScreenController
  --ws RGB888 整帧 (128×64×3 = 24KB/帧, 30fps)-->
matrix_server.py (:8081, 单帧槽 + 写线程 + 亮度缩放)
  --stdin 裸字节流 (8B 帧头 + 每帧 w*h*3)-->
led_anim          (root, /dev/mem, hzeller)
  --HUB75-->
面板
```

---

## 0. 先记住四条（这次踩过的）

| # | 教训 | 具体踩法 |
|---|---|---|
| 1 | **改完先确认真的生效** | 第一轮改完根本没部署到 Pi，用户在旧代码上复测「还是闪」，白忙一轮。判据：`/proc/cmdline` vs 文件、进程启动时间、`ps` 里的实际命令行、`md5sum` |
| 2 | **先量，再改** | 「闪」不是玄学：`--led-show-refresh` 直接打出 94.7Hz。没有数字之前所有调参都是猜 |
| 3 | **别用仓库里的厂商配置推断硬件** | 我根据 `docs/D-P2/*.rcfgx`（`ModulePixelCols=160 / Scan_40`）断定面板是 160×80/1/40，问了一句才知道是 128×64/1/32——那批文件不是这块屏的 |
| 4 | **别人的实测结论要当一等公民** | `~/led/docs/pi_run_log.md` 里早就写了「绑核 56fps→15fps、抖动 12%→32.7%」，我却又加了 `taskset -c 3`，正好帮倒忙 |

---

## 1. 症状 → 根因 → 处置（速查）

| 症状 | 先怀疑 | 处置 | 怎么确认 |
|---|---|---|---|
| **整屏明暗闪 / 一眼看出频闪** | 刷新率 < 100Hz | `MATRIX_PWM_LSB_NS=50`（130→50 翻倍多） | `panel_probe --show-refresh` 看 Hz |
| **随机亮错像素、局部花屏** | ① GPIO 太快 ② 5V 被拖塌 | ① `MATRIX_SLOWDOWN_GPIO=3~5` ② 亮度降到 60 以下 / 换电源 | `vcgencmd get_throttled`；降亮度后是否变好 |
| **右侧或下方「一条」永远不对** | 帧宽/帧高跟物理面板不一致 | 核对 `MATRIX_COLS/ROWS/CHAIN_PER_SCREEN`；`panel_probe --pattern border` 看四条边 | 四条边是否都亮 |
| **亮字旁边有鬼影（该灭的微亮）** | LSB 太窄 | `MATRIX_PWM_LSB_NS` 往上调（80/150） | 换纯色图案看边缘 |
| **屏全黑但服务正常** | ① 灯带服务抢 GPIO18 ② `snd_bcm2835` ③ led_anim 死了 | `systemctl stop led-remote`；`modprobe -r snd_bcm2835`；看 `status.writer_alive` | journal 里 `GPIO 检查` / `重启 led_anim` |
| **画面在两个标签页之间来回跳** | 两个客户端都在推帧 | 接管语义（见 §4.4） | journal 里「接管: 踢掉旧的画面来源」 |
| **帧率上不去（只有 15fps）** | 绑核 | `MATRIX_CPU=-1`（默认不绑） | `ps` 里有没有 `taskset` |
| **画面越拖越慢 / 恢复后猛跳** | 浏览器发送队列无上限 | 前端 frameGate（积压 >1 帧就丢） | `droppedFrames` |
| **暂停时屏还在「呼吸」** | 相同帧也在 30fps 重推，树莓派 CPU 被占 | 前端跳过相同帧 + 500ms 保活 | — |

---

## 2. 这次实测到的数据（同型号可直接抄）

### 2.1 刷新率（128×64，`pwm-bits 7`，`--led-show-refresh`）

| lsb-ns | slowdown | 刷新率 | 最低 |
|---|---|---|---|
| **130（hzeller 默认，出事时的配置）** | 2 | **94.7 Hz** | 89.6 |
| 130 | 3 | 99.8 Hz | 96.7 |
| 130 | 4 | 98.3 Hz | 95.7 |
| **50（现在用的）** | 3 | **208.9 Hz** | 197.7 |
| 50 | 4 | 202.5 Hz | 189.8 |
| 50 + `pwm-bits 6` | 3 | 220.0 Hz | 199.5 |

两个反直觉但重要的结论：

1. **`--led-pwm-lsb-nanoseconds` 才是刷新率的主旋钮**（130→50 直接翻倍）；
2. **`slowdown` 几乎不花刷新率**（2/3/4 都在 95~100Hz 一带）—— 所以为了修「随机像素」
   该毫不犹豫地加，不用在「清晰度 vs 刷新率」之间纠结。

> hzeller README 说人眼对频闪的容忍在 100Hz 上下，敏感的人需要 250Hz。
> 94.7Hz 正好落在「大部分人能看出来」的区间。

### 2.2 亮度 / 供电

- `--led-brightness` 单位是 **百分比 1..100**；100 = 颜色不缩放 → 像素持续点亮时间最长 → **平均电流最大**。
- 用户日志实测：亮度 25 + 全屏纯色就能触发 `throttled=0x50000`（欠压/降频）；亮度 10 时 0 次。
- 机制：面板电流大 → Pi 的 5V 塌 → **3.3V 逻辑电平跟着塌** → CLK/DATA 边沿勉强 → 面板锁存错数据
  = 「随机像素」；同时整屏亮度抖。
- 所以**默认亮度定在 60**，并且做成页面可调（见 §4.5）。

### 2.3 绑核（taskset）

| 配置 | 一帧总耗时 | 画一帧 | 帧率 | 抖动 |
|---|---|---|---|---|
| 不绑核 | 17.7ms | 0.9ms | **56 fps** | **12.0%** |
| `taskset -c 3` | 55.0ms | **36.2ms** | 15 fps | 32.7% |

根因：hzeller 的**刷新线程**和 led_anim **主线程**会被绑到同一个核上互相挤。
→ `MATRIX_CPU=-1`（默认不绑）。cmdline 里的 `isolcpus=3` 只有在「只绑刷新线程」时才有意义，
现在这种跑法下它不起作用。

### 2.4 GPIO18 冲突

灯带那条路（`led_remote.py` → rpi_ws281x）和面板（`led_anim` → hzeller）**抢同一块硬件**：
GPIO18 的 PWM0_0 + DMA。两个都开 = 面板随机亮错像素 / 整屏闪 / 全黑。
`matrix_server` 启动时会扫 `/proc` 和 `snd_bcm2835`，命中就 `log.error` 点名；`status` 里也有 `gpio_conflicts`。

---

## 3. 排查顺序（照着走）

```
先看 journal:
  journalctl -u led-matrix -n 50
  ├─ "GPIO 检查: 发现..."        → 停灯带服务 / modprobe -r snd_bcm2835
  ├─ "起 led_anim 失败" / 立刻退出 → 参数不被认识 / 没 root / 音频模块在
  └─ 正常启动 → 进入下一步

再量刷新率（10 秒）:
  sudo systemctl stop led-matrix
  sudo /opt/bt-gpio/panel_probe.py --cols 64 --chain 2 --rows 64 \
       --pattern border --seconds 10 --show-refresh
  sudo systemctl start led-matrix
  ├─ < 150Hz → 调 MATRIX_PWM_LSB_NS（50 起步）
  └─ 够高 → 进入下一步

再分「闪」还是「像素错」:
  全屏纯色 (pattern red/white) 看：
  ├─ 整块一起明暗 → 供电/刷新率
  └─ 个别像素乱 → slowdown 往上加；仍乱 → 排线/电平转换
```

颜色/几何怀疑时用 `panel_probe --pattern border`（四条边）+ `--pattern rows/cols`（数刻度），
一眼就能判断「列数/行数真的覆盖整块屏没有」。

---

## 4. 代码里的六个坑（每个都配了防护）

### 4.1 帧流没有帧边界 → 一个错长的帧永久错位

`led_anim` 的 stdin 是裸字节流，它按 `w*h*3` 一段段切。**只要混进一个长度不对的帧，
后面每一帧都错位** —— 表现为「一堆随机像素乱跳」，而不是「某帧糊了」。
来源：换屏数时帧槽里残留旧尺寸的帧、客户端算错帧长。

防护：`submit()` 校验帧长 + **写线程再校验一次**（防跨代残留）+ 换尺寸时清槽 + `frames_bad` 记账
（这个计数只要不涨，流就没错位）。

### 4.2 两个写者抢同一个 stdin

`stop` 标志如果跨代共用一个布尔量，`start()` 把它置 False 会把**上一代的写线程复活**，
两个线程交错写同一条流。防护：**每代一个 `threading.Event`** + `stop_proc()` join 旧线程 +
先 terminate 再 close（防管道堵死时 close 卡住）。

### 4.3 写线程死了不自愈

写失败只 log 一句就 break → 屏定格到下次重连。防护：记账 + 下一帧 `ensure_running()` 重拉 `led_anim`。

### 4.4 接管语义：**连上就踢** 是错的

原来（以及我第一版）是「新连接就把旧连接踢掉」。结果：任何只来查 `status` 的脚本/调试页
都会把正在推帧的浏览器踢掉，而前端收到 `1012` 后按设计**不再重连** → 面板黑掉。
（这次就是我自己一次 status 查询把用户页面踢了。）

正确语义：**只有发 `matrix.init`（真要驱动这块屏）的客户端才接管**；查状态的连接随便来；
非 owner 推的帧直接丢但不断开连接。

### 4.5 亮度：`--led-brightness` 是启动参数，不能拿来做滑块

改它必须重启 `led_anim`（重拿 `/dev/mem`，屏黑 1 秒）。做法：

- `led_anim` 固定 `--led-brightness 100`；
- `matrix_server` 按帧缩放：`frame.translate(lut)`，256 字节查表，24KB/帧 ~10µs，
  **不重启、不闪黑、帧长不变**；
- 协议：`matrix.brightness` op（实时）+ `matrix.init` 带 `brightness`（重连恢复）；
- `MATRIX_BRIGHTNESS` 只是「页面上还没设置过时的默认值」。

### 4.6 前端：发送队列无上限 + 相同帧白推

- `ws.send()` 是异步的，树莓派一慢，队列只增不减，恢复时一口气灌一串过期帧 → 卡顿/跳帧。
  → 发送缓冲积压 > 1 帧就丢当前帧（`src/led/screen/frameGate.ts`）。
- 暂停时画面没变也 30fps 推 24KB，树莓派 CPU 一忙刷新率就抖 → 逐字节比上一帧，一样就跳过，
  但每 500ms 补发一帧保活（设备重启后能自愈）。

---

## 5. 最终参数清单（可直接抄）

`/etc/systemd/system/led-matrix.service`：

```ini
Environment=MATRIX_BRIGHTNESS=60        # 默认亮度; 页面滑块会覆盖
Environment=MATRIX_SLOWDOWN_GPIO=3      # 随机像素就往上加 (4/5)
Environment=MATRIX_PWM_LSB_NS=50        # ★ 95Hz → 209Hz 的关键
#Environment=MATRIX_LIMIT_REFRESH=120   # 只在「整体亮度跳」明显时开
#Environment=MATRIX_PWM_LSB_NS=80       # 出现鬼影时用它折中
#Environment=MATRIX_CPU=3               # 不要开! 绑核 56→15fps
```

实际拉起的命令行（用来核对）：

```
led_anim --fps 60 --scale stretch --led-rows 64 --led-cols 64 --led-chain 2
         --led-parallel 1 --led-gpio-mapping regular --led-brightness 100
         --led-slowdown-gpio 3 --led-pwm-bits 7 --led-hardware-pulse
         --led-pwm-lsb-nanoseconds 50
```

面板端常备命令：

```bash
systemctl status led-matrix            # 活着吗
journalctl -u led-matrix -n 50         # 说了什么
vcgencmd get_throttled                 # 欠压/降频 (bit0/16/18)
ps -eo pid,args | grep led_anim        # 实际参数 + 有没有 taskset
/opt/bt-gpio/panel_probe.py --cols 64 --chain 2 --rows 64 --pattern border --show-refresh
```

---

## 6. 别做的事

1. 别 `taskset -c 3` 绑单核（56→15fps，抖动 ×2.7）。
2. 别指望改 `--led-brightness` 能实时生效（要重启）；实时亮度用 `matrix.brightness`。
3. 别在「新连接」上做接管（会踢掉查状态的连接，而前端收到 1012 就不再重连）。
4. 别用 `docs/D-P2/*.rcfgx` 推断自己的屏（那是另一批面板的接收卡配置）。
5. 别相信 `/boot/firmware/cmdline.txt` 已生效 —— 用 `cat /proc/cmdline` 对比，不一致就是要重启。
6. 别长期 100% 亮度跑大面积白色（欠压 → 随机像素）。

---

## 7. 几何 / 翻转 / 配色（2026-11-13 补）

### 7.1 尺寸换算（最容易搞错的一处）

| 层 | 单位 | 值 |
|---|---|---|
| 硬件模组 | px | **64×64**，1/32 扫，HUB75E |
| **一块「屏」** | px | **128 = 两块 64 模组菊花链**（320×160mm，2.5mm 点距） |
| 树莓派参数 | — | `MATRIX_COLS=64`、`MATRIX_CHAIN_PER_SCREEN=2` ⇒ 选 n 块屏时 `--led-chain 2n` |
| 前端虚拟画布 | px | **512×64 = 4 块屏**（`CANVAS_W=512` / `SCREEN_W=128` / `MAX_SCREENS=4`） |
| 88 个键（A0..C8） | px | `MARGIN_X=11.6` + 52 个白键 × `WHITE_KEY_W=9.4` ⇒ 键占 x **11.6..500.4**，**左右各留 11.6px** |
| 中央 C | px | x = **227.8**（第 2 块屏内 x=100） |

⇒ **帧宽永远等于物理链宽**：选 n 块屏 → 帧 128n×64 → `--led-chain 2n`。
不存在「多一列/少一列」的系统性误差；日志里 `帧 128x64 -> 屏 128x64` 就是对上了。

### 7.2 画面翻转 = 把整条 64px 模组链倒过来

插头（进线）在**右边** ⇒ 链头那块模组在物理最右边，链是从右往左串的。
要让画面「从左边依次过去」，必须：

- 屏与屏**换位**（输出的第 k 块屏 ← 画布的第 `n-1-k` 块屏），**并且**
- 每块屏**内部的两块 64px 模组也换位**（输出先取右半块，再取左半块）。

只做一半都会错：只翻屏序 → 每块屏内部左右颠倒；只翻模组 → 屏序颠倒。
这是**模组级**镜像，不是像素级镜像 —— 模组自己的左右方向是硬件定死的，它只是换了个位置。

实现只有一处：`src/led/screen/ScreenRenderer.ts` 的 `extract(screens, flip)`。
断言在 `tests/led_screen_render.test.ts`（2 屏 / 4 屏各一组）。

### 7.3 配色（用户可改）

- 左手蓝 `#0000ff` / 右手红 `#ff0000` / 弹对变绿 `#00ff00`；
- 黑键按中央 C 分两半：左边品红 `#ff00ff`、右边粉色 `#ffc0cb`；
- 面板自己的固定色：背景黑、白键白、按住的白键黄 `#ffff00`、按住的黑键青 `#00ffff`、落点白线白。
- 设置里可以逐个改成别的颜色（存 localStorage，`ledScreenColors`）。
- **颜色原样输出**（粉色这种混色必须显示得出来）—— 以前「压成 0/255 两档」是错的，
  见本文件 §1 / §2.1：闪的真因是刷新率 94.7Hz，不是占空比也不是混色。
  所有绘制坐标取整 ⇒ 不会有抗锯齿灰边。

### 7.4 音符大小只改长度，不改胖瘦

比例只乘**高度**（下沿不动，往上长），宽度还是键宽（`WHITE_KEY_W*1.6` 封顶）。

---

## 8. 拼接与「黑边」

- 虚拟画布 512px 够 4 块屏；**加屏要成对加**（一块屏 = 2 块模组 = 128px）。
  选 n 块屏 → 帧 128n → 链 2n 块模组，**多出来的模组没有数据就是全黑**。
- 画布两端各有 11.6px 的黑边（88 个键居中铺 512px 的必然结果，左右对称）。
  链一路拼到第 4 块屏时，最右 11 列 + 最左 11 列是黑的 —— 这是**设计**，不是渲染漏了。
- 怀疑「右边少一条」时，用工具看四条边，别猜：

  ```bash
  sudo systemctl stop led-matrix
  sudo /opt/bt-gpio/panel_probe.py --cols 64 --chain 2 --rows 64 --pattern border --seconds 10
  sudo systemctl start led-matrix
  ```

  四条边都亮 ⇒ 硬件/链路没问题，是画面内容本身那儿是黑的（去看画布那一段）。
  右边那条不亮 ⇒ 硬件侧：模组少接了、链序不对、或者模组边缘本身没灯珠。

---

## 9. 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/bt_pi/pi/matrix_server.py` | 帧流服务（帧长校验 / 单写者 / 接管 / 亮度 / 自动重拉 / 诊断计数） |
| `scripts/bt_pi/pi/panel_probe.py` | 绕开业务链路的点阵屏诊断（图案 / 数刻度 / 量刷新率 / 扫行寻址） |
| `scripts/bt_pi/pi/led-matrix.service` | 实测参数 + 每个旋钮对应哪种症状的注释 |
| `src/led/screen/frameGate.ts` | 前端推帧闸门（背压 + 相同帧跳过 + 保活） |
| `src/led/screen/ScreenController.ts` | WS 传输 + 亮度 + 面板尺寸不一致告警 |
| `docs/deployment.md` §1.7 | 运维视角的排障表 |
| `docs/audit-2026-11-13-led-matrix.md` | 完整时间线（含三次误判的复盘） |
