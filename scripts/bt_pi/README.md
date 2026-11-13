# bt-gpio：蓝牙 SPP + GPIO 控制

> Windows PC 通过蓝牙（SPP / RFCOMM 虚拟串口）控制树莓派 GPIO。
> 主项目其余部分不动，本目录自成体系。

## 架构

```
┌──────────────┐   RFCOMM/SPP (JSON 行协议)   ┌──────────────────┐
│  Windows PC  │ <───────────────────────────>│ Raspberry Pi     │
│ bt_gpio_client│   虚拟 COM 端口 (COMx)      │ bt_gpio_daemon   │
│ (pyserial)   │                              │ (dbus + GLib)    │
└──────────────┘                              │      ↓           │
                                              │   RPi.GPIO       │
                                              └──────────────────┘
```

- 树莓派：Python 守护进程，用 **DBus + bluez ProfileManager1** 注册 SPP profile（`00001101-0000-1000-8000-00805F9B34FB`），bluez 自动做 SDP 注册 + RFCOMM 监听
- PC：配对后 Windows 创建 outgoing COM 端口，用 `pyserial` 当串口
- 协议：JSON over RFCOMM，每行 `{"id": ..., "op": ..., "args": {...}}`

## Pi 上的文件路径（spec P2-7）

所有东西都装在 **`/opt/bt-gpio/`**，systemd 单元的 `ExecStart` / `WorkingDirectory`
以及 `install.sh` 三者一致。以前文档里写 `/tmp/led_remote.py`、服务里写
`/opt/bt-gpio/led_remote.py`，照着敲命令会跑错文件 —— 现在统一了。

| 路径 | 说明 | 权限 |
|------|------|------|
| `/opt/bt-gpio/bt_gpio_daemon.py` | 蓝牙 SPP 守护进程（DBus + RPi.GPIO） | 755 root |
| `/opt/bt-gpio/ws_led_bridge.py` | WebSocket→TCP 桥（前端 → 灯带） | 755 root |
| `/opt/bt-gpio/led_remote.py` | 灯带 TCP server（rpi_ws281x，:7777） | 755 root |
| `/opt/bt-gpio/led_token` | LED 共享 token（前端要填的那串） | 640 root:pi |
| `/etc/systemd/system/bt-gpio.service` | 蓝牙守护进程单元 | 644 root |
| `/etc/systemd/system/ws-led-bridge.service` | WS 桥单元 | 644 root |
| `/etc/systemd/system/led-remote.service` | 灯带 TCP server 单元 | 644 root |

```bash
# 常用运维命令
systemctl status bt-gpio.service ws-led-bridge.service led-remote.service
journalctl -u ws-led-bridge.service -n 50 --no-pager
sudo cat /opt/bt-gpio/led_token        # 看 token
sudo systemctl restart led-remote.service
```

## 协议（v1）

请求：`{"id": "x", "op": "gpio.write", "args": {"pin": 18, "value": 1}}\n`
响应：`{"id": "x", "ok": true, "value": 1}\n` 或 `{"id": "x", "ok": false, "error": "..."}\n`

| op | args | 说明 |
|----|------|------|
| `ping` | — | 健康检查 |
| `status` | — | 系统状态（uptime, active_pwm, LED 状态） |
| `gpio.mode` | `pin, mode ("in"\|"out"), pull? ("up"\|"down"\|"none")` | 配置 pin 方向 |
| `gpio.write` | `pin, value (0\|1)` | 数字输出 |
| `gpio.read` | `pin` | 数字输入 |
| `pwm.start` | `pin, freq, duty (0..100)` | 启动 PWM |
| `pwm.change` | `pin, duty` | 修改占空比 |
| `pwm.stop` | `pin` | 停止 PWM |
| `cleanup` | — | 清理 GPIO + LED strip |
| `led.init` | `pin, count` | 初始化 WS2812B strip（800kHz, GRB） |
| `led.set` | `index, r, g, b` | 设置指定 LED 颜色（0..255） |
| `led.all` | `r, g, b` | 设置所有 LED 同一颜色 |
| `led.show` | — | 推送缓冲（颜色更改不会自动生效） |
| `led.off` | — | 全部熄灭 |
| `led.status` | — | LED strip 初始化状态 |

## 一次性点亮验证（无需配对）

把 `pi/led_test.py` 拷贝到 Pi 上：

```bash
sudo python3 led_test.py 60 255 0 0
# 默认 pin=18, count=60, RGB(255,0,0)=红 → 第 0 颗 LED 亮红
```

成功输出：`OK: pin=18 count=60 LED[0] set to RGB(255,0,0)`。
如果第一颗 LED 亮红 → 接线 OK；如果不亮，检查：
- 5V/GND 供电
- 数据线是 DIN 端（不是 DOUT）
- 你的灯带规格（数量、协议族）

## 一次性安装（树莓派）

把 `bt_pi/pi/` 目录内容拷贝到树莓派上，然后：

```bash
cd bt_pi/pi
sudo bash install.sh
```

脚本会：
1. `apt install python3-bluez python3-rpi.gpio python3-serial python3-dbus python3-gi bluez`
2. **解开 Pi 4 Bookworm 上的两个常见坑**：
   - 关掉 `serial-getty@ttyS0.service`（它会抢 ttyS0 UART，BT 起不来）
   - `rfkill unblock bluetooth`（BT 经常被默认软屏蔽）
3. 把 `bt_gpio_daemon.py` 装到 `/opt/bt-gpio/`
4. 注册并启动 `bt-gpio.service`（systemd，开机自启）

或者用 `deploy.py`（一次性 SSH 部署，PC 端跑）：
```bash
python deploy.py
```

之后 `systemctl status bt-gpio.service` 应当显示 `active`，`journalctl -u bt-gpio.service` 应当看到：

```
[bt-gpio] registered SPP profile at /org/bt/gpio/spp ch=4
[bt-gpio] GLib main loop running
```

并且 `bluetoothctl show` 里应当有 `Serial Port (00001101-...)`。

## Windows 配对（GUI 步骤）

> 这里没法用脚本完成，WinRT 自动化配对成本太高。手动 GUI 一次就好。

1. **设置** → **蓝牙和设备** → **添加设备**
2. 等扫描列表出现 **"pie"**（即树莓派，蓝牙名称）→ 点 **添加**
3. 如果要求 PIN：**输入 `0000`**（Pi 端默认在 `/etc/bluetooth/main.conf` 的 `Passkey`，未配置时常用 `0000`）
4. 配对成功后，**设置 → 蓝牙和设备 → 更多设备** → 点 "pie" → **属性** → 找到 **"COM 端口"** 之类的标签，记下 **传出 COM 号**（如 `COM5`）
   - 也可在 **设备管理器 → 端口 (COM 和 LPT)** 找 **"Standard Serial over Bluetooth link"**
5. 如果 "COM 端口"标签不可见：
   - 打开 **控制面板 → 设备和打印机**（旧式视图）→ 双击 "pie"
   - 切到 **服务** 选项卡 → 勾 **"Serial Port"**（应为 Pi 端已注册的 SPP UUID）→ 确定
   - 设备管理器会刷新出 COM 端口

## PC 客户端

```bash
pip install pyserial    # 已经装好可跳过
```

```bash
# 自动找蓝牙端口
python bt_gpio_client.py --auto

# 指定端口
python bt_gpio_client.py COM5

# 列端口
python bt_gpio_client.py --list

# 非交互式发一条
python bt_gpio_client.py COM5 --op ping
python bt_gpio_client.py COM5 --op gpio.write --args '{"pin":18,"value":1}'

# 批量示例：让 GPIO18 输出 1 秒高电平
python bt_gpio_client.py COM5 --op gpio.mode --args '{"pin":18,"mode":"out"}'
python bt_gpio_client.py COM5 --op gpio.write --args '{"pin":18,"value":1}'
```

交互式 REPL：

```
bt-gpio> help
bt-gpio> ping
bt-gpio> mode 18 out
bt-gpio> write 18 1
bt-gpio> read 17
bt-gpio> pwm 18 1000 50     # start PWM
bt-gpio> duty 18 25         # 改占空比
bt-gpio> stop 18
bt-gpio> cleanup
bt-gpio> quit
```

## LED 灯带（WS 桥 + 共享 token）

前端（浏览器）不直接碰 GPIO，走 `ws_led_bridge.py`（WS :8080）转发到
`led_remote.py`（TCP 127.0.0.1:7777，持有 rpi_ws281x 单例 strip）。

**共享 token（spec P1-10）**

WS 不受同源策略保护 —— 任何同网段的网页都能连上来刷灯。所以连接后
**第一条消息必须是** `{"op":"auth","token":"<token>"}`，token 在
`/opt/bt-gpio/led_token`（640 root:pi，`install.sh` 自动生成）。

```bash
sudo cat /opt/bt-gpio/led_token
# → 前端「设置 → 蓝灯条 → Pi 令牌」填这一串
```

桥上还有五层防护（任一层失败时其他层仍然生效）：

| 层 | 开关 | 默认 |
|----|------|------|
| 共享 token | `LED_REQUIRE_TOKEN=1` / `LED_TOKEN_FILE` | 读文件；未配置则只告警放行 |
| 鉴权顺序 | `LED_AUTH_TIMEOUT_S` | **先鉴权、后开上游 TCP**；握手超时 10s 直接断开 |
| Origin 白名单 | `LED_ALLOW_ORIGINS`（逗号分隔） | 放行 `file://` / `null` / `localhost` / `127.0.0.1` |
| 连接数上限 | `LED_MAX_CLIENTS` | 4 |
| 每客户端限流 | `LED_MAX_MSG_PER_SEC` | 200 msg/s（令牌桶） |
| 单条消息大小 | `LED_MAX_MSG_SIZE` | 64KB |

> **为什么鉴权要在开上游 TCP 之前**（spec P2-17）：`MAX_CLIENTS` 默认只有 4。
> 如果先连上游再鉴权，4 个不鉴权的假连接就能占满名额 + 占住 4 条到
> `led_remote.py` 的 TCP 连接，真正的前端连都连不上（DoS）。
> 现在握手没过就直接拒，**完全不碰上游**。

**服务降权（spec P1-11）**

三个服务不再全部以 root 运行：

| 服务 | 运行身份 | 理由 |
|------|----------|------|
| `bt-gpio.service` | `pi` + `CAP_NET_ADMIN`/`CAP_NET_RAW` | 蓝牙/RPi.GPIO 只要这几个 capability |
| `ws-led-bridge.service` | `pi` | 只是转发，不需要特权 |
| `led-remote.service` | `root` | rpi_ws281x 要 `/dev/mem`；但已加 `NoNewPrivileges` / `ProtectHome` / `ProtectKernelTunables` 等沙箱项 |

**只让本机访问**：在 `ws-led-bridge.service` 里加 `Environment=LED_WS_HOST=127.0.0.1`，
再用 nginx / Caddy 反向代理承担 TLS + 白名单 + 连接数限制。

## 自测（不依赖硬件）

```bash
cd bt_pi/tests
python test_protocol.py    # 13 个用例 —— SPP 协议 / socketpair 端到端
python test_security.py    # 18 个用例 —— token / Origin / 限流 / 连接数 / 鉴权顺序
```

13 个用例，含端到端 socketpair 协议测试；安全相关的另有 18 个用例
（含「未鉴权不占上游连接」「鉴权后才开上游」「鉴权超时断开」）。

## 故障排查

| 现象 | 排查 |
|------|------|
| `hci0: DOWN` | `sudo rfkill unblock bluetooth && sudo systemctl disable --now serial-getty@ttyS0.service && sudo systemctl restart bluetooth` |
| `bluetoothctl show` 没有 `Serial Port` UUID | 看 `journalctl -u bt-gpio.service`，八成是 DBus signature 错了 |
| Windows 配对成功但没 COM 端口 | 控制面板 → 设备打印机 → pie → 服务 → 勾 Serial Port |
| 客户端握手失败 | Pi 上 `systemctl status bt-gpio`；`journalctl -u bt-gpio.service -n 50` |
| GPIO 报错 `not configured as OUT` | 先发 `mode <pin> out` 或 `write` 时会自动配置 |
| 守护进程重复重启 | `sudo systemctl reset-failed bt-gpio.service && sudo systemctl restart bt-gpio.service` |

## 接下来

- 把 WS2812B 灯带控制加进来：在 `bt_gpio_daemon.py` 加 `led.*` op，复用 RPi.GPIO 的 PWM 或换 `rpi_ws281x`
- 与 `piano-follow` 主项目的播放同步：通过蓝牙发送 LED 状态帧
- 把控制指令做时间序列映射：MIDI 事件 → LED 颜色 / 亮度变化
