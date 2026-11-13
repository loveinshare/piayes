---
name: led-strip-raspberry-pi
description: 树莓派侧的灯带服务端 —— /opt/bt-gpio 下的 led_remote.py (rpi_ws281x) 与 ws_led_bridge.py (WS→TCP)、systemd 单元、共享 token 鉴权、pinmux 看门狗、DMA 卡死与 systemd 心跳、物理帧长 352。部署树莓派、改服务端、排查「灯全黑但服务端正常」时读这个技能。
---

# 树莓派侧

## 1. 装在哪 (权威路径, spec P2-7)

| 路径 | 说明 | 权限 |
|---|---|---|
| `/opt/bt-gpio/led_remote.py` | 灯带 TCP server (rpi_ws281x), 监听 `127.0.0.1:7777` | 755 root |
| `/opt/bt-gpio/ws_led_bridge.py` | WS→TCP 桥, 监听 `0.0.0.0:8080` | 755 root |
| `/opt/bt-gpio/bt_gpio_daemon.py` | 蓝牙 SPP 守护进程 (老方案) | 755 root |
| `/opt/bt-gpio/led_token` | LED 共享 token | 640 root:pi |
| `/etc/systemd/system/led-remote.service` | 灯带 server 单元 (**root** —— rpi_ws281x 要 `/dev/mem`) | 644 root |
| `/etc/systemd/system/ws-led-bridge.service` | WS 桥单元 (`pi` 用户, 只需转发) | 644 root |
| `/etc/systemd/system/bt-gpio.service` | 蓝牙守护进程单元 (`pi` 用户) | 644 root |

> 仓库里只有 `scripts/bt_pi/pi/bt-gpio.service`; 两个 LED 单元文件是装到 Pi 上的。
> 文档里老写的 `/tmp/led_remote.py` **已经不用了** —— 照着敲会跑错文件。

常用运维:

```bash
systemctl status bt-gpio.service ws-led-bridge.service led-remote.service
journalctl -u ws-led-bridge.service -n 50 --no-pager
journalctl -u led-remote.service -n 30 --no-pager
sudo cat /opt/bt-gpio/led_token          # 前端「设置 → 蓝灯条 → Pi 令牌」填这串
sudo systemctl restart led-remote.service
```

## 2. `led_remote.py` 的六个关键设计

### ① 物理帧长恒定 352, `count` 只是「逻辑可寻址长度」

WS2812 串联: 发出去的比特流比物理链**短** → 后面的带收不到自己的数据,
移位寄存器被空闲高电平填满 → **整条带全白** (176 颗全白 ≈ 10 A!)。

- `DEFAULT_PHYSICAL_COUNT = 352` —— 帧长永远按这个数发。
- 客户端 `init` 的 count 只决定「能写哪几颗」, 白名单 `(176, 352)`。
- 逻辑范围变小时 (352→176) 要把超出的像素刷黑, 否则上灯带留幽灵灯。
- `off` 清**整条物理链** (不是只清逻辑范围)。
- 代价: 逻辑只有 176 颗时**也照样按 352 颗发帧** —— 每帧恒定 10.6ms, 不能按逻辑数缩短。

### ② `init` 的 count / pin 必须白名单

```python
DEFAULT_ALLOWED_COUNTS = (176, 352)
DEFAULT_ALLOWED_PINS = (12, 18, 21)   # 只有这三个能驱动 WS2812
```
不白名单就能让 strip 申请任意大的缓冲 (65535 颗 = 196KB 白占着)。

### ③ pinmux 看门狗 —— 「灯全黑但服务端一切正常」的根因

`rpi_ws281x` 只管 DMA, **不管引脚复用**。GPIO18 被别的进程 (通用 GPIO 守护进程、
另开的 `PixelStrip` 测试实例) 改成 input 时, `show()` 照样返回 ok, 但 DIN 线上没有波形。

- `_PWM_ALT`: Pi4 GPIO18 = **alt5**, Pi3 = **alt0** (别搞反)。
- 以前在 `show()` 的关键路径上每 20 次 fork 一次 `pinctrl` —— `show` 是**持锁**调用的,
  那一次 fork+exec 的 10~50ms 里**所有**别的命令 (ping/status/set) 全堵着。
  现在挪到后台线程 `PinmuxWatchdog` (间隔 3s), 关键路径上一个 fork 都没有。
- `_init_strip()` 在 count/pin 相同时**直接 return** (避免重建破坏前端的 in-flight 状态),
  所以那条短路分支里也必须调 `ensure_pinmux(pin)` —— 否则前端每次重连发的 `init`
  永远不会重新设置 pinmux, 只能重启服务才恢复。

### ④ DMA 卡死 → 靠 systemd 心跳救

`show()` → `ws2811_render()` → `ws2811_wait()` 是**无限等待** (死等 DMA 的 ACTIVE 位清掉,
`rpi_ws281x 5.0.0 lib/ws2811.c:1107`)。DMA 引擎一挂, 这一行永远不返回; 而 SWIG 绑定
**不释放 GIL** (整个包里没有一处 `Py_BEGIN_ALLOW_THREADS`) → **整个 Python 进程被冻住**,
连别的线程都跑不了。

进程内救不了 → 只能靠**进程外**的 systemd 看门狗:

- `_render_in_progress` / `_render_started_at` 标记「正在 render」。
- 心跳线程发现 render 超过 `RENDER_HANG_GRACE_S = 3s` → **故意不发** `WATCHDOG=1`
  → systemd 判定服务卡死 → `Restart=on-failure` 拉起。
- **`sd_notify` 必须在主线程发**: `NotifyAccess=main` 只认主进程发来的通知;
  从别的线程发, 内核在 SCM_CREDENTIALS 里报的是 **TID** 而不是 pid, systemd 会丢掉。

### ⑤ 单 client 互斥: 只关读方向, 保住在途回包

第二个 client 来了会踢掉第一个。以前是 `shutdown(SHUT_RDWR) + close()` ——
那会把旧 client **正在处理的那条命令的回包**一起销毁 (socket 直接关了, sendall 报错)。
前端症状就是「rpc init timeout」: 它等的回包被踢人那一下吃掉了。

现在只 `shutdown(socket.SHUT_RD)`: 读方向关闭 → 旧 client 的 `recv()` 立刻 EOF →
自己 `close()`; 但**写方向还开着** → 在途回包照发不误。

### ⑥ `accept()` 出错必须返回 1

`accept()` 出错 (对端 RST 之后的 EMFILE/ECONNABORTED) 直接 break 的话, 进程会
**干干净净地退出 (返回码 0)** —— `Restart=on-failure` 不会把它拉起来, 灯带服务就此
静默死掉, 前端只看到一句「rpc init timeout」。所以现在记一笔并 `return 1`。

## 3. WS 桥的五层防护

WS 不受同源策略保护 —— 同网段任何网页都能连上来刷灯。

| 层 | 开关 | 默认 |
|---|---|---|
| 共享 token | `LED_REQUIRE_TOKEN=1` / `LED_TOKEN_FILE` | 读文件; 未配置则只告警放行 |
| 鉴权顺序 | `LED_AUTH_TIMEOUT_S` | **先鉴权、后开上游 TCP**; 超时 10s 直接断开 |
| Origin 白名单 | `LED_ALLOW_ORIGINS` | 放行 `file://` / `null` / `localhost` / `127.0.0.1` |
| 连接数上限 | `LED_MAX_CLIENTS` | 4 |
| 每客户端限流 | `LED_MAX_MSG_PER_SEC` | 200 msg/s (令牌桶) |
| 单条消息大小 | `LED_MAX_MSG_SIZE` | 64 KB |

**为什么鉴权必须在开上游 TCP 之前** (spec P2-17): `MAX_CLIENTS` 只有 4。先连上游再鉴权的话,
4 个不鉴权的假连接就能占满名额 + 占住 4 条到 `led_remote.py` 的 TCP 连接,
真正的前端连都连不上 (DoS)。现在握手没过就直接拒, **完全不碰上游**。

`install.sh` 装完是 **fail-closed**: drop-in
`/etc/systemd/system/ws-led-bridge.service.d/10-security.conf` 里写死
`LED_REQUIRE_TOKEN=1` —— token 文件万一丢了/被删了, 直接拒绝**所有**连接,
而不是「只告警然后放行」。

## 4. 部署流程 (paramiko, 不重启树莓派)

```bash
# 一键装全套 (会 apt install、改 systemd、重启 bt-gpio / ws-led-bridge / led-remote)
python scripts/bt_pi/deploy.py
```

手工改服务端的标准流程 (**必须按顺序**):

1. `cp /opt/bt-gpio/led_remote.py /opt/bt-gpio/led_remote.py.bak.$(date +%Y%m%d)`
2. `systemctl cat led-remote.service` —— **改 systemd 前先看现有配置** (别覆盖掉
   别人加的沙箱项 / 环境变量)
3. SFTP 推新文件到 `/opt/bt-gpio/` (临时名 + `install -m 755` 原子替换)
4. `sudo systemctl restart led-remote.service`
5. `journalctl -u led-remote.service -n 30` —— 期望
   `READY led_remote count=176 (逻辑) physical=352 pin=18`
6. **换灯数真机验证** (别只信代码):
   ```bash
   (printf '{"id":1,"op":"init","args":{"count":352,"pin":18}}\n'; sleep 1) | nc -w 2 127.0.0.1 7777
   (printf '{"id":2,"op":"status"}\n'; sleep 1) | nc -w 2 127.0.0.1 7777
   ```
   看 journal 有没有 `WS2811_ERROR_DMA` / `READY ... count=352`。
7. 用完记得切回 `count=176`。

**如果撞 `WS2811_ERROR_DMA` (code -6)**: 说明还有别的 `PixelStrip` 活着占着 DMA 通道 10。
查 `ps aux | grep -i led`。**不要**直接重启树莓派 —— 找到那个进程 (常见是用户自己的
`pi_led_test.py`) 杀掉它。

## 5. 树莓派侧自检 (一键)

```bash
python .claude/skills/led-strip/scripts/pi_led_doctor.py
```

paramiko 连上去, 一次跑完: 进程 / 端口 / 两个服务的 journal / `pinctrl get 18` /
`nc` 发 ping+status / 温度 / `ws2811` 依赖。脚本只用 `C:/Users/<用户>/anaconda3/python.exe` 能跑的
标准库 + paramiko, 输出 UTF-8。
