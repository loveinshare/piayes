---
name: led-strip-triage
description: 灯带故障排查手册 —— 症状 → 判据 → 根因 → 修法。灯不亮 / 全黑 / 常亮 / 乱闪 / 亮三颗 / 跑马灯慢 / rpc init timeout / 连不上 ESP32 / 第二条带全白 / 换灯数报 WS2811_ERROR_DMA 时读这个技能, 并用 scripts/pi_led_doctor.py 一键诊断树莓派侧。
---

# 故障排查手册

> 先跑 `python .claude/skills/led-strip/scripts/pi_led_doctor.py` (树莓派侧一键体检),
> 再按下面的表定位。

## 0. 通用诊断顺序

1. **电与线**: 5V 独立供电? 灯带 GND 与树莓派/ESP32 GND 共地? 数据线接的是 DIN 不是 DOUT?
2. **数灯**: `pinctrl get 18` (pinmux 对不对) / ESP32 `status` 看 count。
3. **服务端**: `journalctl -u led-remote.service -n 30` 有没有 `READY ...` / 有没有 `WS2811_ERROR_DMA`。
4. **链路**: `nc 127.0.0.1 7777` 发 `ping` / `status`; WS 桥 `journalctl -u ws-led-bridge.service`。
5. **协议**: 固件 `status` 看 `queue` / `bad_frames` / `dropped`。
6. **前端**: `ledBackend` 选对了吗? `ledToken` 填了吗? 控制台有没有 `rpc init timeout`?

## 1. 症状对照表

### 灯全黑, 但服务端一切正常 (`ready:true, flushed:176`)

**根因: GPIO pinmux 被冲掉了。** `rpi_ws281x` 只管 DMA, **完全不管引脚复用** ——
GPIO18 被别的进程 (通用 GPIO 守护进程、另开的 `PixelStrip` 测试实例) 改成 input 时,
`show()` 照样返回 ok, 但 DIN 线上没有波形。

- 查: `pinctrl get 18` → 期望 Pi4 = `a5`, Pi3 = `a0`。显示 `ip` 就是它了。
- 修: `sudo pinctrl set 18 a5`; 服务端已有 `ensure_pinmux()` + 后台 `PinmuxWatchdog` (3s)。
- **坏一次会永远坏**: `_init_strip()` 在 count/pin 相同时直接 return, 前端每次重连发的
  `init` 永远不会重新设置 pinmux → 只能 `sudo systemctl restart led-remote.service`。
- 顺手查 `ps aux | grep -i led` —— 用户自己的 `pi_led_test.py` 也会干这事。

### 灯全黑, 前端也连不上

按链路分段: 浏览器 → WS 桥 (8080) → TCP (7777) → strip。

- `LED_REQUIRE_TOKEN=1` (install.sh 装完默认) 但前端没填 token → 桥直接拒。
  查 `sudo cat /opt/bt-gpio/led_token` 填进「设置 → 蓝灯条 → Pi 令牌」。
- 桥的 `MAX_CLIENTS` 默认只有 4, 且**先鉴权后开上游 TCP** —— 不鉴权的假连接占满名额
  就会让真前端连不上 (DoS)。
- `journalctl -u ws-led-bridge.service` 看有没有「TCP connect 失败」。

### 几颗灯莫名常亮 (especially 奇数颗)

- **偶数颗、成对** → 可能是真实按键 / 暂停时的预览 (正常)。
- **奇数颗 (比如 3 绿 + 1 红 + 1 蓝)** → 一定发生了「半条命令生效」或「整帧只刷了一半」:
  - 清屏帧被中断打断 → 截断点之后的灯保持旧颜色 (灯集中在灯带**某一端**基本就是它);
  - 分片丢包 + 旧固件半解析 → 错误下标被写进有效颜色 (灯**散落在不同音区**)。
- 查固件 `status`: `bad_frames > 0` 或 `dropped > 0` = 通信侧真的丢过帧。
- 固件侧 `show()` 已经用 `portENTER_CRITICAL` 关中断 (2026-10-26 修) —— 如果还是出现,
  确认烧的是新版固件。

### 跑马灯跑了十多秒

**根因: 回执延迟卡住在途窗口**, 不是设备算得慢 (bit-bang `show()` 只要 10.6ms)。

| 在途深度 | ms/条 | 179 条耗时 |
|---|---|---|
| 2 (旧值) | 62.6 | 11.2 秒 |
| **6 (现值)** | 8.6 | **1.66 秒** |
| 12 | 36.9 | 开始丢命令 |

三处改动缺一不可: 固件 `RX_QUEUE_SLOTS` 4→**8**; 前端 `MAX_OUTSTANDING` 2→**6**;
前端跑马灯**不再逐帧 await**。设备侧还有 `led.marquee` 一条命令跑完整个动画 (~0.47s)。

### `rpc init timeout`

- **旧 client 被踢时回包被销毁** → 前端等的回包被吃掉了。
  修法已在服务端: 踢人时只 `shutdown(SHUT_RD)`, **保住在途回包**。
- **服务静默死掉**: `accept()` 出错直接 break → 返回码 0 → `Restart=on-failure` 不拉起。
  修法已在服务端: 记一笔并 `return 1`。
- **DMA 卡死**: `ws2811_wait()` 无限等待 + SWIG 不释放 GIL → 整个进程冻住。
  修法已在服务端: render 超过 3s 就**停止发 systemd 心跳**, 让 systemd 拉起。

### 连不上 ESP32 / 一直显示「连中」

- `requestDevice()` **只能在用户手势里同步调用** —— 自动连接流程弹不出系统选择器。
  配对入口必须在主界面 (💡 `LedDock`)。用 `ledNeedsPairing` 单独表达这个状态,
  别跟 `ledError` 混着。
- `getDevices()` 在 Chrome/Edge **默认关闭** → 刷新页面后用户得再点一次「连接 ESP32」。
- 固件侧: `advertiseOnDisconnect` 默认 false → 主机断开后设备停止广播, PC 再也扫不到。
  必须显式开 `advertiseOnDisconnect(true)`。
- 固件侧: `device.gatt.connect()` 在设备离线时**不会 reject** —— 一直挂着。
  前端有 8 秒建连超时兜底。

### 第二条带整条全白

**根因: 帧长比物理链短。** WS2812 串联, 发出去的比特流比物理链短 → 后面的带收不到自己的数据,
移位寄存器被空闲高电平填满 → **整条带全白** (176 颗全白 ≈ 10 A!)。

- 修: 服务端**帧长恒按物理链 352** (`DEFAULT_PHYSICAL_COUNT`), 客户端 `init` 的 count
  只当「逻辑可寻址长度」。
- 前端: `ws.count = dualOn ? 352 : 176`; 固件: `led.init` 的 count 白名单 `(176, 352)`。

### 换灯数时报 `ws2811_init failed with code -6 (WS2811_ERROR_DMA)`

**根因: 旧的 `PixelStrip` 还占着 DMA 通道 10。** `rpi_ws281x` 把清理挂在 atexit 上,
只有进程退出才 `ws2811_fini` + `delete_ws2811_t`。换引脚重建前必须先
`self._strip._cleanup()` (幂等)。若还报错, 说明**还有别的进程**开着 strip
(`ps aux | grep -i led`) —— **不要重启树莓派**, 找到那个进程杀掉。

### 亮度比树莓派暗一倍

前端已经在主机侧乘过 brightness, 树莓派 `rpi_ws281x` 是满亮度 (255),
所以固件 `LED_BRIGHTNESS` 必须保持 **255**。设备端再乘一次 = 暗一倍。

### 灯带后半段不亮 / 只亮一半

- 逻辑 count (客户端 `init`) 与物理帧长 (恒 352) 是两回事 —— `set`/`set_many` 的下标
  越界会返回 `i N out of [0, M)`。
- 逻辑范围从 352 缩到 176 时, 服务端会把超出的像素刷黑 (否则上灯带留幽灵灯)。

### BLE 协议不匹配 (`unknown op`)

设备只认 `led.init` / `led.set` / `led.set_many` / `led.show` / `led.off` / `led.marquee`
(以及无前缀的 `ping` / `status`)。前端内部说的是 `init` / `set` / ...
**发任何命令都要先过 `BleTransport.DEVICE_OPS`**, 且 `led.set` 的像素字段是 `index`
(不是 `i`)。连真机验一遍:

```bash
python scripts/bt_pi/pc/check_frontend_protocol.py
```

## 2. 快速命令

```bash
# 树莓派一键体检
python .claude/skills/led-strip/scripts/pi_led_doctor.py

# 手动 (ssh 到 Pi 之后)
pinctrl get 18                                  # pinmux
systemctl status led-remote.service ws-led-bridge.service
journalctl -u led-remote.service -n 30 --no-pager
(printf '{"id":1,"op":"ping"}\n'; sleep 1) | nc -w 2 127.0.0.1 7777
(printf '{"id":2,"op":"status"}\n'; sleep 1) | nc -w 2 127.0.0.1 7777
sudo cat /opt/bt-gpio/led_token
vcgencmd measure_temp
```

## 3. 历史 bug 档案

`docs/spec-2026-10-20-code-audit.md` 里的 **R1..R21** 每一节都是一个 bug 的根因记录
(现象 → 根因 → 修法 → 验证)。**改灯带之前先翻一遍相关的那节** —— 大概率已经有答案,
不要重新踩坑。
