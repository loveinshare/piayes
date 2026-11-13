---
name: led-strip
description: piano-follow 灯带 (WS2811/WS2812B) 全栈技能树 —— 硬件电气约束、树莓派服务端、ESP32-S3 BLE 固件、前端传输层与播放语义、故障排查手册。任务里出现灯带 / LED / WS2812 / ESP32 / 树莓派 / rpi_ws281x / BLE / 双色带 / 灯不亮 / 乱闪 / 跑马灯 / 提前量 时, 先读这个技能, 再按下面的表进子技能。
---

# 灯带技能树 (piano-follow)

> 项目内技能, **优先于**用户级的 `raspi-led-debug` —— 后者的部分事实已过期
> (它说 LED 服务在 `/tmp/led_remote.py`、默认 60 颗; 实际是 `/opt/bt-gpio/led_remote.py`、
> 176 颗, systemd `led-remote.service` 拉起)。

## 0. 五条硬约束 (违反会烧东西 / 会静默失效)

1. **任何测试都不得超过 30 颗灯同时点亮。**
   固件里写死 `LED_MAX_LIT = 30` (`firmware/esp32s3/src/led_limits.h`)。
   176 颗全亮 = 176 × 60mA ≈ **10.5A** —— 板子/USB 直接被拉垮 (真机已经因此掉过线)。
   超限时固件在 `show()` 前把**下标大的那些**灭掉 (是「颗数」上限, 不是「下标」上限,
   所以跑马灯这种同时只亮 6 颗的不受影响)。
2. **WS2812B 必须独立 5V 供电, 且灯带 GND 必须与树莓派 GND 共地。**
   共地不通 = 数据线没有共同参考电平 = 乱码 / 全黑 / 随机亮。
   树莓派 5V pin 只能供 ~1A, **不能**给整条带供电。
3. **只能有一个 `rpi_ws281x` 实例。** 库持 `/dev/mem`, 第二份会 `WS2811_ERROR_DMA`。
   换引脚重建 strip 前必须先 `self._strip._cleanup()` (释放 DMA 通道 10)。
4. **别重启树莓派。** 改 systemd 前先 `systemctl cat <unit>` 看现有配置;
   改文件前先 `cp` 备份 (`.bak.<日期>`)。
5. **别在树莓派上跑两个 rpi_ws281x 实例** (含用户自己的 `pi_led_test.py`) ——
   除了抢 `/dev/mem`, 还会把 GPIO18 的 pinmux 冲成 input, 导致「灯全黑但服务端一切正常」。

## 1. 链路全景

```
                  ┌────────────────────────────────────────────┐
   浏览器 (前端)  │ src/led/LedController.ts                    │
                  │   ├─ LedFollower  (输入 → 灯)               │
                  │   ├─ scanCursor   (谱 → 灯, 第一排)         │
                  │   └─ dualStrip    (谱 → 上灯带, 第二排)      │
                  └───────────────┬────────────────────────────┘
                                  │ LedTransport.send(op, args)
                       BackendTransport (用户选后端, 不猜不回落)
                     ┌────────────┴────────────┐
                     │                         │
              ┌──────▼───────┐         ┌───────▼────────┐
              │ WsTransport  │         │ BleTransport   │  ← DEVICE_OPS 翻译
              │  ws://Pi:8080│         │ Web Bluetooth   │    帧头 STX + MTU 分片
              └──────┬───────┘         └───────┬────────┘
                     │                         │ BLE GATT (NUS 风格)
        ┌────────────▼─────────────┐   ┌───────▼─────────────────────┐
        │ ws_led_bridge.py :8080   │   │ ESP32-S3 固件 (pianoflow)     │
        │ (systemd, token 鉴权)    │   │  ble_led.cpp + ws2811_bitbang │
        └────────────┬─────────────┘   │  LED_MAX_LIT=30              │
                     │ TCP 127.0.0.1:7777└─────────────────────────────┘
        ┌────────────▼─────────────┐        GPIO14 → DIN
        │ led_remote.py (systemd)  │        WS2811/WS2812B × 176 (GRB, 800kHz)
        │ rpi_ws281x 单例          │
        │ 物理帧长恒 352           │
        └────────────┬─────────────┘
                     │ GPIO18 (PWM0_0)
                   WS2811/WS2812B × 176
```

**两条链路的区别** (决定改代码要改几处):

| | 树莓派 WS | ESP32 BLE |
|---|---|---|
| 设备侧 op | `init/set/set_many/show/off/ping/status` | `led.init/led.set/...` (+ `led.marquee`) |
| `led.set` 像素字段 | `i` | `index` (`set_many` 用 `i`) |
| 跑马灯 | 逐帧发 (前端算帧) | **设备侧一条命令** (`led.marquee`, ~0.47s) |
| 帧长 | **恒 352** (物理链长度) | 跟随 `led.init` 的 count (176/352) |
| 亮度缩放 | 满亮度 255 | `LED_BRIGHTNESS=255` (前端已乘过) |

## 2. 子技能导航

按需读, 不要一次全读:

| 子技能 | 什么时候读 |
|---|---|
| [hardware/SKILL.md](hardware/SKILL.md) | 接线、供电、电流、亮度、颜色、**键 → LED 索引映射**、双色带反接补偿 |
| [protocol/SKILL.md](protocol/SKILL.md) | 改任何 op / 字段 / 分片 / 队列; 「前端发的和设备认的对不上」 |
| [raspberry-pi/SKILL.md](raspberry-pi/SKILL.md) | 部署树莓派、改 `led_remote.py` / `ws_led_bridge.py`、systemd、pinmux、DMA 卡死 |
| [esp32/SKILL.md](esp32/SKILL.md) | 改固件、烧录、BLE 握手、分片重组、跑马灯、自检 env |
| [frontend/SKILL.md](frontend/SKILL.md) | 改前端灯带逻辑: 第一排语义、第二排、提前量、传输层限流 |
| [triage/SKILL.md](triage/SKILL.md) | **症状 → 根因 → 修法** 的对照表 (灯全黑 / 常亮 / 乱闪 / 慢 / timeout) |

配套脚本: `scripts/pi_led_doctor.py` —— paramiko 一键诊断树莓派侧 (进程 / 端口 /
journal / pinmux / ping / status / 温度), 用法见 triage 技能。

> **树莓派是第三台机器** —— 本技能只管树莓派侧。前端/后端怎么上公网、
> 笔记本怎么起 dev —— 那部分在**私有运维文档**里, 公开仓库不放。

## 3. 代码地图

| 层 | 文件 |
|---|---|
| 前端控制 | `src/led/LedController.ts` (影子表 / setMany 80 / resync) |
| 前端跟随 | `src/led/LedFollower.ts` (多源追踪 / 命中脉冲 / off-grace) |
| 前端预扫描 | `src/led/scanCursor.ts` (第一排「组」语义) |
| 双色带映射 | `src/led/dualStrip.ts` (`stripRange` / `upperRange` / `NextNoteIndex`) |
| 传输层 | `src/led/transport/BackendTransport.ts` (选后端)、`BleTransport.ts`、`WsTransport.ts`、`bleDevice.ts` |
| 前端接线 | `src/App.tsx` (建连 / 上灯带提示 effect)、`src/store.ts` (prefs) |
| UI | `src/ui/LedDock.tsx` (💡 首页浮窗)、`src/ui/SettingsDrawer.tsx` (⚙ 抽屉) |
| Pi 服务端 | `scripts/bt_pi/pi/led_remote.py`、`ws_led_bridge.py`、`bt_gpio_daemon.py` |
| Pi 部署 | `scripts/bt_pi/deploy.py` (paramiko 推文件 + 装 systemd) |
| PC 调试 | `scripts/bt_pi/pc/ble_led_client.py`、`check_frontend_protocol.py`、`probe_*.py` |
| 固件 | `firmware/esp32s3/src/ble_led.cpp` (协议)、`ws2811_bitbang.cpp` (驱动)、`led_limits.h` |
| 固件说明 | `firmware/esp32s3/README.md` (最全的一份硬件/协议笔记) |
| 规格 & 排障史 | `docs/spec-2026-10-20-code-audit.md` (R1..R21, 每节一个 bug 的根因) |

## 4. 环境与凭据 (用户已确认)

- 树莓派的地址 / 账号 / 密码在**私有运维文档**里 —— 公开仓库不放凭据
- python: `C:/Users/<用户>/anaconda3/python.exe`; 脚本里加
  `import sys; sys.stdout.reconfigure(encoding='utf-8')`
- ssh: **用 paramiko**, 不用 `ssh` 命令行
- 前端默认: `ledHost=192.168.1.113`, WS 端口 8080, `ledBackend='ws'`, `ledEnabled=false`
- ESP32 广播名: `pianoflow`, GATT service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`

## 5. 改动前的自检清单

- [ ] 这次改动会不会让**同时点亮**的颗数超过 30? (尤其上灯带 N=6 → 4×6=24 颗)
- [ ] 改的是前端 op 还是设备 op? 翻译在 `BleTransport.DEVICE_OPS`, 别绕过它。
- [ ] 改了固件协议 → 前端 `DEVICE_OPS` / `translateArgs()` 要同步; 改完跑
      `python scripts/bt_pi/pc/check_frontend_protocol.py` (连真机验协议)。
- [ ] 改了前端 → `npx vitest run` (41 文件 / 424 用例基线) + `npx tsc -b`。
- [ ] 改了树莓派侧 → 备份 → 推 → `systemctl restart` → `journalctl -u <unit> -n 30` 确认。
- [ ] 改完要不要更新 `docs/spec-2026-10-20-code-audit.md` 的基线用例数?
