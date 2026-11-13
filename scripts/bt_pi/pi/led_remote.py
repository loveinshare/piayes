#!/usr/bin/env python3
"""LED strip TCP server (重建版, 2026-10-19).

由 ws_led_bridge.py (WS :8080) 转发前端 LedController 的命令. 持有 rpi_ws281x
单例 strip (rpi_ws281x 库 /dev/mem 单实例, 只能跑一个 led_remote.py).

历史: 原版在 /tmp/led_remote.py (约 3391 字节), 某次进程僵死被清后没恢复.
现在统一装到 /opt/bt-gpio/ (跟 led-remote.service / install.sh 一致, spec P2-7).
这个重建版基于已知的:
- 协议 ops: init/set/set_many/show/off/ping/status
- 协议格式: JSON-line, 响应 {"id": N, "ok": bool, ...}
- 默认参数: count=176, pin=18, WS2811_STRIP_GRB (0x00081000)
- rpi_ws281x 构造: PixelStrip(count, pin, 800000, 10, False, 255, 0, 0x00081000)
- 行为: set 写 buffer, show 一次性推到 strip (匹配前端 rAF batch)

需要 sudo 跑 (rpi_ws281x 拿 /dev/mem).
正式部署走 systemd: systemctl start led-remote.service (ExecStart 指向 /opt/bt-gpio/led_remote.py).
手动跑 (调试): sudo nohup python3 -u /opt/bt-gpio/led_remote.py > /tmp/led_remote.log 2>&1 &

用法:
  启动: sudo python3 -u /opt/bt-gpio/led_remote.py [--auto-init] [--count N] [--pin P]
  调试: (echo '{"id":1,"op":"ping"}'; sleep 0.5) | nc -w 1 127.0.0.1 7777
"""
import argparse
import colorsys
import json
import logging
import os
import select
import socket
import subprocess
import sys
import threading
import time

# 跟前端 LedController 默认对齐 (LedController.ts:23, 109-110)
DEFAULT_COUNT = 176
# DIN 引脚. **只有 12 / 18 / 21 能驱动 WS2812** (rpi_ws281x 实测: 其余引脚一律
# "Gpio N is illegal for LED channel 0"). 12 和 18 复用功能相同 (都是 PWM0_0,
# 不能同时用); 21 走 PWM1_0.
DEFAULT_PIN = 18
DEFAULT_FREQ = 800000
DEFAULT_DMA = 10
DEFAULT_BRIGHTNESS = 255
DEFAULT_STRIP_TYPE = 0x00081000  # WS2811_STRIP_GRB
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 7777
LISTEN_BACKLOG = 8
RECV_BUFSIZE = 65536

# --- 输入白名单 (spec P1-10 / §7.2(4)) ---------------------------------
# init op 的 count/pin 必须白名单化: 不白名单就能把 strip 改成 65535 颗 → 内存爆掉.
# 默认只允许本项目用的 176 颗 (单灯带) / 352 颗 (双色带: 两条串联) /
# 能驱动 WS2812 的引脚 (12/18/21).
DEFAULT_ALLOWED_COUNTS = (176, 352)
DEFAULT_ALLOWED_PINS = (12, 18, 21)
# ★ 物理帧长 (2026-10-30): 物理链上**实际**有多少颗 (两条灯带串联 = 352).
#
# 为什么要有这个概念: WS2812 是**串联**的 —— 服务端发出去的比特流如果比物理链
# 短, 后面的那条带收不到自己的数据, 移位寄存器被空闲高电平填满 →
# **整条带全白** (176 颗全白 ≈ 10 A!). 用户 2026-10-30 插上第二条带就是这个
# 现象: 服务端 count=176, 第二条带 (176..351) 整条刷白.
#
# 所以: **帧长永远按物理链发**, 客户端 init 的 count 只当「逻辑可寻址长度」.
# 发得比物理链**长**是安全的 (多出来的比特没人收), 发得比物理链**短**才危险.
#
# 代价: 单灯带时每帧从 5.3ms 变 10.6ms (352 颗的帧时间) —— 跑马灯还是 ~0.5s.
DEFAULT_PHYSICAL_COUNT = 352
# set_many 的 pixels 数组上限 (前端一次最多 176 个; 双色带时 352)
MAX_SET_MANY_PIXELS = 4096
# 单行消息长度上限 (1MB) —— 防止堆进来的客户端把内存吓满
MAX_LINE_BYTES = 1 << 20
# 跑马灯窗口上限 —— 跟 ESP32 固件的 MARQUEE_WINDOW_MAX 一致.
# window 是客户端给的; 不设上限就是「一条消息让服务端按任意大的窗口算颜色」.
MARQUEE_WINDOW_MAX = 64

# --- 看门狗参数 (2026-10-29) -----------------------------------------------
#
# ① pinmux 后台检查间隔 (秒). 以前是在 show 的关键路径上做的 (每 20 次 show
#    fork 一次 pinctrl), 现在挪到后台线程.
PINMUX_INTERVAL_S = 3.0
# ② 给 systemd 发 WATCHDOG=1 的间隔 (秒). 要明显小于 WatchdogSec.
WATCHDOG_INTERVAL_S = 5.0
# ③ 一次 render 超过这么久还没回来 = 认定 DMA 卡死.
#    (正常一帧 176 颗 ≈ 5.3ms, 352 颗 ≈ 10.6ms —— 3 秒已经是天荒地老)
RENDER_HANG_GRACE_S = 3.0

log = logging.getLogger("led_remote")


def _color_int(r: int, g: int, b: int) -> int:
    """24-bit pack: r << 16 | g << 8 | b (跟 rpi_ws281x Color() 等价)."""
    return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF)


# --- pinmux 看门狗 (2026-10-27) --------------------------------------------
#
# rpi_ws281x 只负责 DMA, **不管引脚复用**. 只要 GPIO 的 pinmux 被别的东西改成
# 普通 input/output, show() 依然返回 ok, 但 DIN 线上根本没有波形 —— 灯全黑,
# 而服务端日志一切正常 ("ready: true, flushed: 176").
#
# 常见元凶:
#   - 别的脚本用 RPi.GPIO.setup(pin, IN/OUT) (通用 GPIO 守护进程)
#   - 另开一个 PixelStrip 实例跑测试 (rpi_ws281x /dev/mem 单实例, 抢完就乱)
#
# 为什么坏一次就永远坏: _init_strip() 在 count/pin 相同时直接 return, 所以前端
# 每次重连发的 init 都不会重新设置 pinmux —— 只能重启服务才恢复.
#
# Pi4 (BCM2711): GPIO12 的 PWM 功能是 **alt0** (PWM0_0); GPIO18 是 **alt5** (PWM0_0)
# Pi3 (BCM2837): GPIO18 的 PWM 功能是 **alt0** (PWM0_0)
_PWM_ALT = {
    12: ('a0', 'PWM0_0'),
    18: ('a5', 'PWM0_0'),   # 本项目默认引脚 (Pi4)
    13: ('a0', 'PWM1_0'),
    19: ('a5', 'PWM1_0'),
    21: ('a0', 'PWM1_0'),
}


def _pinmux_ok(pin: int) -> bool:
    """当前 pinmux 是不是期望的 PWM 复用功能. 查不了就当没问题 (别乱改)."""
    alt, _desc = _PWM_ALT.get(pin, ('a0', 'PWM0_0'))
    try:
        out = subprocess.run(['pinctrl', 'get', str(pin)],
                             capture_output=True, text=True, timeout=5)
    except Exception:
        return True
    line = out.stdout.strip()
    if not line:
        return True
    # 格式: "18: a5    pd | lo // GPIO18 = PWM0_0"
    parts = line.split(':', 1)
    if len(parts) != 2:
        return True
    fields = parts[1].split()
    if not fields:
        return True
    return fields[0] == alt


def ensure_pinmux(pin: int) -> bool:
    """pinmux 不对就改回来. 改成功返回 True."""
    if _pinmux_ok(pin):
        return True
    alt, desc = _PWM_ALT.get(pin, ('a0', 'PWM0_0'))
    log.warning(f"GPIO{pin} pinmux 不是 {alt}({desc}) —— 改回来")
    try:
        subprocess.run(['pinctrl', 'set', str(pin), alt],
                       capture_output=True, text=True, timeout=5)
    except Exception as e:
        log.warning(f"GPIO{pin} pinmux 修复失败: {e}")
        return False
    if _pinmux_ok(pin):
        log.info(f"GPIO{pin} pinmux 已恢复为 {alt}({desc})")
        return True
    log.error(f"GPIO{pin} pinmux 修复后仍不正确")
    return False


# --- systemd 通知 (2026-10-29) ----------------------------------------------
#
# 不用 systemd-python 之类的第三方库 —— sd_notify 就是往 $NOTIFY_SOCKET 发一个
# unix datagram, 自己发更省事 (Pi 上也不一定装了 python3-systemd).
def sd_notify(msg: str) -> bool:
    """给 systemd 发一条通知 (WATCHDOG=1 / STATUS=...). 没在 systemd 下就返回 False."""
    addr = os.environ.get("NOTIFY_SOCKET")
    if not addr:
        return False
    if addr.startswith("@"):          # 抽象命名空间 (Linux 特有)
        addr = "\0" + addr[1:]
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            s.connect(addr)
            s.sendall(msg.encode("utf-8"))
        finally:
            s.close()
        return True
    except Exception as e:
        log.debug(f"sd_notify 失败: {e}")
        return False


class PinmuxWatchdog(threading.Thread):
    """后台线程: 定期查 GPIO pinmux, 不对就改回来.

    ★ 为什么从 show 的关键路径上挪出来 (2026-10-29):
      以前是 `show` 里每 20 次 fork 一次 `pinctrl`. 而 show 是在**持锁**
      (server._lock) 的状态下调用的 —— 那一次 fork + exec 要 10~50ms,
      这段时间里**所有**别的命令 (ping / status / set) 全都堵着.
      灯带每帧都要 show → 每 0.7 秒就有一次 50ms 的全局停顿.

      现在挪到后台线程: 关键路径上一个 fork 都没有, 间隔也从「每 20 帧」
      变成固定 3 秒.

    ★ 为什么这个检查不能干脆删掉:
      rpi_ws281x 只管 DMA, **不管引脚复用**. 只要 GPIO 的 pinmux 被别的
      进程改成普通 input/output, show() 依然返回 ok, 但 DIN 线上根本没有
      波形 —— 灯全黑, 而服务端日志一切正常. (见本文件顶部的说明)
    """

    def __init__(self, get_pin, interval: float = PINMUX_INTERVAL_S):
        super().__init__(name="pinmux-watchdog", daemon=True)
        self._get_pin = get_pin
        self._interval = interval
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                pin = self._get_pin()
                if pin is None:
                    continue
                ensure_pinmux(pin)
            except Exception:
                log.exception("pinmux 看门狗异常")


class LedServer:
    """单 strip + 单 client 模式. rpi_ws281x 库 /dev/mem 单实例, 而且并发调用
    strip.setPixelColor/show 库内非线程安全. 第二个 client 来了会踢掉第一个."""

    def __init__(self, count: int, pin: int,
                 allowed_counts=DEFAULT_ALLOWED_COUNTS,
                 allowed_pins=DEFAULT_ALLOWED_PINS,
                 max_set_many: int = MAX_SET_MANY_PIXELS,
                 physical_count: int = DEFAULT_PHYSICAL_COUNT):
        self._lock = threading.Lock()
        self._allowed_counts = set(allowed_counts)
        self._allowed_pins = set(allowed_pins)
        self._max_set_many = max_set_many
        self._strip = None  # rpi_ws281x.PixelStrip
        self._buf: list = []  # [(r,g,b), ...]
        self._count = count
        # ★ 物理帧长 (2026-10-30): 服务端**永远**按这个数发帧, 跟客户端
        #   init 来的 count 无关. count 只是「逻辑可寻址长度」(能写哪几颗).
        self._phys_count = physical_count
        self._pin = pin
        self._last_show = 0.0
        self._sets_since_show = 0
        self._active_client: socket.socket | None = None
        self._active_client_lock = threading.Lock()
        # --- render 在途标记 (2026-10-29) ---
        #
        # show() → ws2811_render() → ws2811_wait() 是**无限等待**: 它死等
        # DMA 控制寄存器的 ACTIVE 位清掉 (rpi_ws281x 5.0.0 lib/ws2811.c:1107).
        # DMA 引擎要是卡住 (内核 DMA 异常 / 别的进程抢了 DMA 通道), 这一行
        # 永远不返回 —— 而且 SWIG 的绑定**不释放 GIL** (整个包里没有一处
        # Py_BEGIN_ALLOW_THREADS), 于是**整个 Python 进程被冻住**:
        # 别的线程、连心跳都跑不了.
        #
        # 进程内救不了 → 只能靠 systemd 的看门狗 (进程外). 这两个标记是给
        # 心跳线程用的: render 明显卡住了就别再发心跳, 让 systemd 判定服务
        # 卡死并重启它.
        self._render_in_progress = False
        self._render_started_at = 0.0

    @property
    def pin(self) -> int:
        """当前用的 DIN 引脚 (pinmux 看门狗要读)."""
        return self._pin

    def render_stuck(self) -> bool:
        """当前是不是卡在一次 render 里 (超过了宽限期)."""
        if not self._render_in_progress:
            return False
        return (time.time() - self._render_started_at) > RENDER_HANG_GRACE_S

    def _render(self) -> None:
        """刷灯带 (包一层在途标记, 让心跳能看出 DMA 卡死)."""
        self._render_started_at = time.time()
        self._render_in_progress = True
        try:
            self._strip.show()
        finally:
            self._render_in_progress = False

    def _push(self) -> None:
        """把整个 _buf 推给灯带 (一帧 = 物理链长度).

        跟 ESP32 驱动一个语义: **永远推满 physical 颗**, 逻辑范围之外的
        像素也要推 —— 少推会让后面那截保持上一帧的颜色 (幽灵灯).
        """
        for idx, (r, g, b) in enumerate(self._buf):
            self._strip.setPixelColor(idx, _color_int(r, g, b))
        self._render()

    def _push_pixels(self, indices) -> None:
        """只把指定的几颗推给灯带, 再 render 一帧.

        跑马灯每帧只改 6~7 颗 (加掉出窗口的), 没必要把 352 颗全
        setPixelColor 一遍 —— 那是 352 次 Python 调用, 每帧 ~1ms.
        """
        for i in indices:
            r, g, b = self._buf[i]
            self._strip.setPixelColor(i, _color_int(r, g, b))
        self._render()

    @staticmethod
    def _marquee_color(k: int, window: int) -> tuple:
        """窗口内第 k 颗的颜色 —— 跟 ESP32 固件 marqueeColor() 完全一致.

        头最亮蓝 (hue 240°) → 尾最暗紫 (hue 280°, v 0.25).
        """
        t = 0.0 if window <= 1 else k / (window - 1)
        hue = (240.0 + t * 40.0) / 360.0
        v = 1.0 - t * 0.75
        r, g, b = colorsys.hsv_to_rgb(hue, 1.0, v)
        return (int(r * 255.0 + 0.5), int(g * 255.0 + 0.5), int(b * 255.0 + 0.5))

    def _marquee(self, window: int, step: int) -> int:
        """设备侧跑马灯 (一条命令跑完整个动画). 返回画了几帧.

        为什么要有它: 以前树莓派这边只能由前端**逐帧**发 —— 44 帧 × (3 条
        set_many + 1 条 show) ≈ 176 条 TCP 往返. 浏览器 rAF 一抖、网络一
        拥塞, 帧就忽快忽慢, 看起来就是「跑马灯乱闪 / 卡顿」; 而且中间还会
        插进正常弹奏的 set_many (灯带被别的命令改掉).

        现在跟 ESP32 一样: 整段动画在服务端跑, 一条命令、一个回执, 帧间隔
        由 DMA 的物理时间决定 (10.6ms/帧), 中间不会插进别的命令.
        """
        self.ensure_strip()
        count = self._count
        if count <= 0:
            return 0
        window = max(1, min(window, count, MARQUEE_WINDOW_MAX))
        step = max(1, step)
        colors = [self._marquee_color(k, window) for k in range(window)]

        # 起手先清整条物理链 (跟 ESP32 的 g_strip.clear() + show 一致).
        self._buf = [(0, 0, 0)] * self._phys_count
        self._push()

        frames = 0
        for pos in range(0, count, step):
            touched = []
            # 掉出窗口的 step 颗灭掉 (窗口每帧前移 step).
            for i in range(pos - step - window + 1, pos - window + 1):
                if 0 <= i < count:
                    self._buf[i] = (0, 0, 0)
                    touched.append(i)
            for k in range(window):
                i = pos - k
                if 0 <= i < count:
                    self._buf[i] = colors[k]
                    touched.append(i)
            self._push_pixels(touched)
            frames += 1

        # 收尾: 清缓冲 + 刷一次, 不留残影.
        self._buf = [(0, 0, 0)] * self._phys_count
        self._push()
        self._sets_since_show = 0
        self._last_show = time.time()
        return frames

    # ---- strip 管理 ---------------------------------------------------------

    def _init_strip(self, count: int, pin: int) -> None:
        """建 strip (物理帧长 = 物理链长度) + 分配 buffer + 全灭.

        count = **逻辑**可寻址长度 (客户端 init 来的) —— 只决定「能写哪几颗」,
        **不决定帧长**. 帧长永远是 self._phys_count (物理链上有多少颗).

        为什么不能按 count 发帧: WS2812 串联 —— 发得比物理链短, 后面的带收不到
        自己的数据, 移位寄存器被空闲高电平填满 → 整条带全白 (≈10 A).
        详见 DEFAULT_PHYSICAL_COUNT 的注释.
        """
        if self._strip is not None and self._pin == pin:
            # strip 已经在, 但 pinmux 可能被别的进程改掉 —— 每次都要校验!
            # (冷路径: 只在客户端连上时走一次; 平时靠后台的 PinmuxWatchdog)
            ensure_pinmux(pin)
            # 逻辑范围变小 (352 → 176, 双色带 → 单灯带): 超出范围的像素要刷黑,
            # 否则上面那条带会留着上次的颜色 (幽灵灯).
            if count < self._count:
                zero = _color_int(0, 0, 0)
                for i in range(count, self._phys_count):
                    self._buf[i] = (0, 0, 0)
                    self._strip.setPixelColor(i, zero)
                self._render()
            self._count = count
            return
        from rpi_ws281x import PixelStrip  # 延迟 import, 让 --help 不依赖 lib
        # ★ 换引脚时**必须先释放旧的 strip**.
        #
        # 为什么: rpi_ws281x 的 PixelStrip 把清理挂在 atexit 上 —— 只有进程退出
        # 才会 ws2811_fini + delete_ws2811_t. 老的 ws2811_t 还占着 **DMA 通道 10**,
        # 新建 strip 时 ws2811_init 会失败:
        #     ws2811_init failed with code -6 (WS2811_ERROR_DMA)
        # 主动调它自己的 _cleanup() 释放 (幂等: 它把 self._leds 置 None,
        # atexit 再调一次是 no-op).
        if self._strip is not None:
            try:
                # 先用旧 strip 把整条物理链刷黑 —— 换引脚后旧的那条可能还亮着.
                for i in range(self._phys_count):
                    self._strip.setPixelColor(i, 0)
                self._render()
                self._strip._cleanup()
                log.info(f"旧 strip (count={self._phys_count}) 已释放")
            except Exception as e:
                log.warning(f"旧 strip 释放失败: {e}")
            self._strip = None
        strip = PixelStrip(
            self._phys_count, pin, DEFAULT_FREQ, DEFAULT_DMA,
            False, DEFAULT_BRIGHTNESS, 0, DEFAULT_STRIP_TYPE,
        )
        strip.begin()
        # 全灭 (走 _render, 这样 DMA 卡住也能被心跳发现)
        self._strip = strip
        try:
            for i in range(self._phys_count):
                strip.setPixelColor(i, 0)
            self._render()
        except Exception:
            self._strip = None
            raise
        self._count = count
        self._pin = pin
        self._buf = [(0, 0, 0)] * self._phys_count
        self._sets_since_show = 0
        self._last_show = time.time()
        log.info(f"READY led_remote count={count} (逻辑) physical={self._phys_count} pin={pin}")

    def ensure_strip(self) -> None:
        if self._strip is None:
            self._init_strip(self._count, self._pin)

    # ---- ops ----------------------------------------------------------------

    def handle(self, msg: dict) -> dict:
        op = msg.get("op", "")
        args = msg.get("args") or {}
        try:
            if op == "init":
                count = int(args.get("count", DEFAULT_COUNT))
                pin = int(args.get("pin", DEFAULT_PIN))
                if count not in self._allowed_counts:
                    return {"ok": False, "error": f"count {count} not allowed "
                                                  f"(allowed: {sorted(self._allowed_counts)})"}
                if pin not in self._allowed_pins:
                    return {"ok": False, "error": f"pin {pin} not allowed "
                                                  f"(allowed: {sorted(self._allowed_pins)})"}
                self._init_strip(count, pin)
                return {"ok": True, "count": count, "physical": self._phys_count, "pin": pin}

            if op == "set":
                i = int(args.get("i", -1))
                r = int(args.get("r", 0))
                g = int(args.get("g", 0))
                b = int(args.get("b", 0))
                if i < 0 or i >= self._count:
                    return {"ok": False, "error": f"i {i} out of [0, {self._count})"}
                self.ensure_strip()
                self._buf[i] = (r & 0xFF, g & 0xFF, b & 0xFF)
                self._sets_since_show += 1
                return {"ok": True}

            if op == "set_many":
                # 批量写像素 (一次 set_many 内最多 80 个像素, 前端 88 键/2 LED = 176
                # 一次性也只 1 chunk). 所有写都只动 _buf, 真推 strip 等 show.
                # 任何越界返回 error (跟 set 一致 — 前端按 ledController.setMany 一次发一个 chunk).
                pixels = args.get("pixels") or []
                if not isinstance(pixels, list):
                    return {"ok": False, "error": "pixels must be a list"}
                if len(pixels) > self._max_set_many:
                    return {"ok": False, "error": f"too many pixels: {len(pixels)} > {self._max_set_many}"}
                self.ensure_strip()
                # ★ 2026-11-10: 改成**先全校验、后统一写** (原子) ——
                #   以前是「边校验边写」: 一批像素里第 3 个越界就 return error,
                #   但**前面两个已经写进 _buf 了** → 下一次 show 就把它们刷出来
                #   = 灯带上留几个「幽灵像素」. ESP32 固件一直是对的 (先全校验
                #   再写), 两边行为不一致 → 这次对齐成 ESP32 那样.
                pending = []
                for px in pixels:
                    if not isinstance(px, dict):
                        return {"ok": False, "error": "pixel must be an object"}
                    i = int(px.get("i", -1))
                    if i < 0 or i >= self._count:
                        return {"ok": False, "error": f"i {i} out of [0, {self._count})"}
                    pending.append((i, (
                        int(px.get("r", 0)) & 0xFF,
                        int(px.get("g", 0)) & 0xFF,
                        int(px.get("b", 0)) & 0xFF,
                    )))
                # 全都合法了才写 —— 一个像素都不落空.
                for i, rgb in pending:
                    self._buf[i] = rgb
                self._sets_since_show += len(pixels)
                return {"ok": True, "set": len(pixels)}

            if op == "show":
                self.ensure_strip()
                # ★ pinmux 检查**不再在这里做** (2026-10-29): show 是在持锁的
                #   关键路径上, 每 20 次 fork 一次 pinctrl = 每 0.7 秒一次
                #   几十毫秒的全局停顿. 挪到后台线程 (PinmuxWatchdog) 去了.
                self._push()
                flushed = self._sets_since_show
                self._sets_since_show = 0
                self._last_show = time.time()
                return {"ok": True, "flushed": flushed}

            if op == "marquee":
                # 设备侧跑马灯 —— 动画跑完才回执 (跟 ESP32 的 led.marquee 一致).
                window = int(args.get("window", 6))
                step = int(args.get("step", 2))
                if window > MARQUEE_WINDOW_MAX:
                    return {"ok": False, "error": "window too large"}
                if window < 1:
                    window = 1
                frames = self._marquee(window, step)
                return {"ok": True, "frames": frames}

            if op == "off":
                self.ensure_strip()
                zero = _color_int(0, 0, 0)
                # ★ 清**整条物理链** (不是只清逻辑范围) —— 否则上面那条带
                #   收不到「灭」的指令, 会保持上次的颜色 (幽灵灯).
                for i in range(self._phys_count):
                    self._buf[i] = (0, 0, 0)
                    self._strip.setPixelColor(i, zero)
                self._render()
                self._sets_since_show = 0
                return {"ok": True}

            if op == "ping":
                return {"ok": True, "pong": True}

            if op == "status":
                return {
                    "ok": True,
                    "ready": self._strip is not None,
                    "count": self._count,
                    "physical": self._phys_count,
                    "pin": self._pin,
                    "sets_pending": self._sets_since_show,
                    "last_show_age_s": round(time.time() - self._last_show, 3) if self._last_show else None,
                }

            return {"ok": False, "error": f"unknown op: {op!r}"}
        except Exception as e:
            log.exception(f"op {op} failed")
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---- client 接线 -----------------------------------------------------------

def _send(conn: socket.socket, resp: dict) -> None:
    data = (json.dumps(resp) + "\n").encode("utf-8")
    conn.sendall(data)


def _serve_client(conn: socket.socket, addr, server: LedServer) -> None:
    # 单 client 互斥: 第二个 client 来了踢第一个.
    #
    # ★ 2026-10-28: 以前是 shutdown(SHUT_RDWR) + close() —— 那会把旧 client
    #   **正在处理的那条命令的回包**一起销毁 (socket 直接关了, sendall 报错).
    #   前端看到的症状就是「rpc init timeout」: 它等的回包被踢人那一下吃掉了.
    #
    #   现在只 shutdown(SHUT_RD): 读方向关闭 → 旧 client 的 recv() 立刻返回
    #   EOF → 它的循环退出 → 自己 close(). 但**写方向还开着** —— 旧 client
    #   手里那条命令的回包照发不误, 前端能收到.
    with server._active_client_lock:
        if server._active_client is not None:
            old = server._active_client
            try:
                peer = old.getpeername()
            except Exception:
                peer = "?"
            log.warning(f"kicking existing client {peer} for new {addr} (只关读方向, 保住在途回包)")
            try:
                old.shutdown(socket.SHUT_RD)
            except Exception:
                pass
        server._active_client = conn
    log.info(f"client connected {addr}")

    try:
        buf = b""
        while True:
            chunk = conn.recv(RECV_BUFSIZE)
            if not chunk:
                break
            buf += chunk
            # 单行长度上限 —— 防止堆行把内存吓满
            if len(buf) > MAX_LINE_BYTES:
                _send(conn, {"ok": False, "error": "line too long"})
                break
            # 处理所有完整行 (一个 TCP 包可能含多行)
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError as e:
                    _send(conn, {"ok": False, "error": f"bad json: {e}"})
                    continue
                # msg 一定是 dict (json.loads 的结果) —— .get 不会抛, 死代码去掉 (spec P2-8)
                req_id = msg.get("id") if isinstance(msg, dict) else None
                with server._lock:
                    resp = server.handle(msg)
                if req_id is not None:
                    resp["id"] = req_id
                try:
                    _send(conn, resp)
                except (ConnectionResetError, BrokenPipeError):
                    return
    except (ConnectionResetError, BrokenPipeError):
        pass
    except Exception:
        log.exception("client loop error")
    finally:
        with server._active_client_lock:
            if server._active_client is conn:
                server._active_client = None
        try:
            conn.close()
        except Exception:
            pass
        log.info(f"client disconnected {addr}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default=LISTEN_HOST)
    parser.add_argument("--port", type=int, default=LISTEN_PORT)
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT,
                        help=f"default LED count (used if client doesn't send init), default {DEFAULT_COUNT}")
    parser.add_argument("--physical-count", type=int, default=DEFAULT_PHYSICAL_COUNT,
                        help=f"物理链上实际有多少颗 (帧长永远按这个数发), default {DEFAULT_PHYSICAL_COUNT}")
    parser.add_argument("--pin", type=int, default=DEFAULT_PIN,
                        help=f"default GPIO pin, default {DEFAULT_PIN}")
    parser.add_argument("--auto-init", action="store_true",
                        help="init strip at startup (skip lazy init on first set)")
    parser.add_argument("--allow-count", default=",".join(str(c) for c in DEFAULT_ALLOWED_COUNTS),
                        help="comma-separated whitelist of allowed LED counts for the init op")
    parser.add_argument("--allow-pin", default=",".join(str(p) for p in DEFAULT_ALLOWED_PINS),
                        help="comma-separated whitelist of allowed GPIO pins for the init op")
    parser.add_argument("--max-set-many", type=int, default=MAX_SET_MANY_PIXELS,
                        help="max pixels accepted in one set_many op")
    parser.add_argument("--pinmux-interval", type=float, default=PINMUX_INTERVAL_S,
                        help="pinmux 后台检查间隔 (秒), 0 = 关闭")
    parser.add_argument("--watchdog-interval", type=float, default=WATCHDOG_INTERVAL_S,
                        help="给 systemd 发 WATCHDOG=1 的间隔 (秒), 0 = 关闭")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    allowed_counts = {int(x) for x in str(args.allow_count).split(",") if str(x).strip()}
    allowed_pins = {int(x) for x in str(args.allow_pin).split(",") if str(x).strip()}
    server = LedServer(count=args.count, pin=args.pin,
                       allowed_counts=allowed_counts, allowed_pins=allowed_pins,
                       max_set_many=args.max_set_many,
                       physical_count=args.physical_count)
    if args.auto_init:
        try:
            server.ensure_strip()
        except Exception as e:
            log.error(f"auto-init failed: {e}")
            return 1

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((args.host, args.port))
    except OSError as e:
        log.error(f"bind {args.host}:{args.port} failed: {e}")
        return 1
    s.listen(LISTEN_BACKLOG)
    log.info(f"listening on {args.host}:{args.port} (count={args.count} logical / "
             f"physical={args.physical_count} pin={args.pin} auto_init={args.auto_init})")

    # --- pinmux 后台看门狗 (2026-10-29) ---------------------------------
    #
    # 以前是 show 的关键路径上每 20 次 fork 一次 pinctrl —— 而 show 是**持锁**
    # 调用的, 那一次 fork 的几十毫秒里所有别的命令都堵着. 现在挪到后台.
    pm_watchdog = None
    if args.pinmux_interval > 0:
        pm_watchdog = PinmuxWatchdog(lambda: server.pin, args.pinmux_interval)
        pm_watchdog.start()
        log.info(f"pinmux 看门狗已启动 (间隔 {args.pinmux_interval}s)")

    # --- systemd 心跳 (2026-10-29) ---------------------------------------
    #
    # 为什么心跳在**主线程**里发:
    #   systemd 的 NotifyAccess=main 只认主进程发来的通知. 从别的线程发,
    #   内核在 SCM_CREDENTIALS 里报的是**线程 id** (TID) 而不是主进程 pid,
    #   systemd 会当成「不是主进程发的」丢掉. 主线程的 accept 循环本来就闲,
    #   顺手发心跳最合适.
    #
    # 为什么需要心跳 (这是 DMA 挂死的唯一救法):
    #   ws2811_render() → ws2811_wait() 是**无限等待** —— 死等 DMA 控制寄存器
    #   的 ACTIVE 位清掉 (rpi_ws281x 5.0.0 lib/ws2811.c:1107). DMA 引擎一挂,
    #   这一行永远不返回; 而 SWIG 绑定**不释放 GIL** (整个包里没有一处
    #   Py_BEGIN_ALLOW_THREADS) → 整个 Python 进程被冻住, 连别的线程都跑不了.
    #   进程内自救不了 → 只能靠**进程外**的 systemd 看门狗:
    #   心跳一停 → systemd SIGABRT → Restart=on-failure 重新拉起 → 灯带恢复.
    last_ping = 0.0
    stuck_logged = False

    def heartbeat(now: float) -> None:
        nonlocal last_ping, stuck_logged
        if args.watchdog_interval <= 0:
            return
        # 容忍一点点抖动: select 的超时可能比标称值早几毫秒返回,
        # 卡在 "差一毫秒就够一个间隔" 上会让实际心跳周期翻倍.
        if now - last_ping < args.watchdog_interval * 0.9:
            return
        last_ping = now
        if server.render_stuck():
            # DMA 疑似挂死 —— 故意**不**发心跳, 让 systemd 来重启我们.
            if not stuck_logged:
                log.error("render 卡住 (DMA 疑似挂死) —— 停止心跳, 让 systemd 重启本服务")
                stuck_logged = True
            sd_notify("STATUS=LED 服务卡在 render (DMA 疑似挂死)")
            return
        stuck_logged = False
        sd_notify("WATCHDOG=1")

    sd_notify(f"STATUS=LED 灯带服务: count={args.count} (逻辑) physical={args.physical_count} pin={args.pin}")
    select_timeout = args.watchdog_interval if args.watchdog_interval > 0 else 3600.0

    try:
        while True:
            # 用 select 等连接, 顺便当心跳节拍器 (不用 select 的话 accept()
            # 会一直阻塞, 主线程就没机会发心跳了).
            try:
                ready, _, _ = select.select([s], [], [], select_timeout)
            except OSError as e:
                log.error(f"select() failed: {e} —— 退出, 让 systemd 重新拉起")
                return 1
            now = time.time()
            if not ready:
                heartbeat(now)
                continue
            try:
                conn, addr = s.accept()
            except OSError as e:
                # accept() 出错 (比如对端 RST 之后 EMFILE/ECONNABORTED) 就直接
                # break 的话, 进程会**干干净净地退出 (返回码 0)** ——
                # systemd 的 Restart=on-failure 不会把它拉起来, 于是灯带服务
                # 就此静默死掉, 前端只能看到一句「rpc init timeout」.
                # 所以这里记一笔并返回 1, 让 systemd 重新拉起.
                log.error(f"accept() failed: {e} —— 退出, 让 systemd 重新拉起")
                return 1
            heartbeat(now)
            t = threading.Thread(target=_serve_client, args=(conn, addr, server), daemon=True)
            t.start()
    except KeyboardInterrupt:
        log.info("shutting down (KeyboardInterrupt)")
    finally:
        if pm_watchdog is not None:
            pm_watchdog.stop()
        try:
            s.close()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    sys_exit_code = main()
    if sys_exit_code:
        import sys
        sys.exit(sys_exit_code)
