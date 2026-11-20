"""LED 控制模块：把 MIDI 事件映射到灯带像素。

设计目标：
- 与 piano-follow 主项目解耦：纯函数 + 两个 transport 类
- 默认映射: 176 颗 LED (≈1.22m, 144 LED/m) = 88 键 (A0..C8, MIDI 21-108)
- 按真实钢琴键盘长度 (88 键 ≈ 1.22m) 算, 每键正好 2 颗 LED
- 2m 灯带的多余部分 (~1m) 由用户物理裁掉
- 左手 (<60) 蓝, 右手 (>=60) 红; 黑键轻微变色调

用法:
  # 当模块使用 (调 pure functions):
  from led_control import note_to_led_range, color_for, is_left_hand, is_black_key

  # 当 transport 使用:
  from led_control import DirectSshLedController, BtLedController
  ctl = DirectSshLedController(host="192.168.1.113", user="loveinshare", password="<脱敏>")
  ctl.note_on(60)
  ctl.show()
  ctl.note_off(60)
  ctl.close()
"""
from __future__ import annotations
import json
import time
from dataclasses import dataclass
from typing import Optional, Tuple


# ---------------- 常量 ----------------
LED_PIN = 18
LED_COUNT = 176       # 1.222m × 144 LED/m: 88 键真实钢琴宽度
LOWEST_MIDI = 21      # A0
HIGHEST_MIDI = 108    # C8 (88 键钢琴最高音)
NUM_KEYS = HIGHEST_MIDI - LOWEST_MIDI + 1  # 88
LEDS_PER_KEY_F = LED_COUNT / NUM_KEYS      # 2.0 — 每键正好 2 颗 LED

# 配色
COLOR_LEFT_WHITE  = (  0,   0, 200)   # 纯蓝
COLOR_LEFT_BLACK  = (  0, 200,  50)   # 绿
COLOR_RIGHT_WHITE = (200,   0,   0)   # 纯红
COLOR_RIGHT_BLACK = (255,  30,   0)   # 橙

# 一个八度内 12 个半音: C(0) C#(1) D(2) D#(3) E(4) F(5) F#(6) G(7) G#(8) A(9) A#(10) B(11)
_BLACK_KEY_PCS = frozenset({1, 3, 6, 8, 10})
_MIDI_MIDDLE_C = 60  # 中央 C


# ---------------- Pure mapping ----------------
def note_to_led_range(midi_note: int) -> Optional[Tuple[int, int]]:
    """MIDI → (start, end_exclusive) LED 区间。 越界返回 None。

    88 键 × ~1.636 LED/key = 144 LED, 每 key 1 或 2 颗。
    """
    if not (LOWEST_MIDI <= midi_note <= HIGHEST_MIDI):
        return None
    k = midi_note - LOWEST_MIDI  # 0..87
    start = round(k * LEDS_PER_KEY_F)
    end = round((k + 1) * LEDS_PER_KEY_F)
    return (start, end)


def note_to_led(midi_note: int) -> Optional[int]:
    """MIDI → 起始 LED 索引 (兼容老 API)。 越界返回 None。"""
    rng = note_to_led_range(midi_note)
    return None if rng is None else rng[0]


def is_black_key(midi_note: int) -> bool:
    """按半音位置判断是否是黑键 (C# D# F# G# A#)。"""
    return (midi_note % 12) in _BLACK_KEY_PCS


def is_left_hand(midi_note: int) -> bool:
    """中音 C 以下算左手。"""
    return midi_note < _MIDI_MIDDLE_C


def color_for(midi_note: int) -> Tuple[int, int, int]:
    """根据音高决定颜色: 左手/右手 × 白/黑 → 4 种颜色。"""
    if is_left_hand(midi_note):
        return COLOR_LEFT_BLACK if is_black_key(midi_note) else COLOR_LEFT_WHITE
    return COLOR_RIGHT_BLACK if is_black_key(midi_note) else COLOR_RIGHT_WHITE


# ---------------- LED server (runs on Pi) ----------------
# This string is uploaded to /tmp/led_remote.py on the Pi.
# Keep it pure ASCII so the file decodes cleanly on the Pi.
LED_REMOTE_PY = r'''#!/usr/bin/env python3
"""Persistent LED server. Listens on 127.0.0.1:7777, JSON-line protocol.

Request: {"id": "...", "op": "init|set|show|off|ping", "args": {...}}\n
Response: {"id": "...", "ok": true|false, ...}\n
"""
import json
import socket
import sys
import traceback
from rpi_ws281x import PixelStrip, Color

_STRIP = None
_COUNT = 0
_PIN = 18

def init(args):
    global _STRIP, _COUNT, _PIN
    _COUNT = int(args.get("count", 60))
    _PIN = int(args.get("pin", 18))
    _STRIP = PixelStrip(_COUNT, _PIN, 800000, 10, False, 255, 0, 0x00081000)
    _STRIP.begin()
    return {"count": _COUNT, "pin": _PIN}

def set_pixel(args):
    if _STRIP is None:
        return {"error": "not init"}
    i = int(args["i"])
    if not (0 <= i < _COUNT):
        return {"error": f"index {i} out of range"}
    _STRIP.setPixelColor(i, Color(int(args["r"]), int(args["g"]), int(args["b"])))
    return {"i": i}

def show(args=None):
    if _STRIP is None:
        return {"error": "not init"}
    _STRIP.show()
    return {"shown": True}

def off(args=None):
    if _STRIP is None:
        return {"error": "not init"}
    for i in range(_COUNT):
        _STRIP.setPixelColor(i, 0)
    _STRIP.show()
    return {"off": True}


def set_many(args=None):
    if _STRIP is None:
        return {"error": "not init"}
    pixels = (args or {}).get("pixels") or []
    n = 0
    for px in pixels:
        i = int(px["i"])
        if not (0 <= i < _COUNT):
            return {"error": "index " + str(i) + " out of range"}
        _STRIP.setPixelColor(i, Color(int(px.get("r", 0)), int(px.get("g", 0)), int(px.get("b", 0))))
        n += 1
    return {"set": n}

def status(args=None):
    return {"init": _STRIP is not None, "count": _COUNT, "pin": _PIN}

OPS = {"init": init, "set": set_pixel, "set_many": set_many, "show": show, "off": off, "status": status, "ping": lambda a: {"pong": True}}

def serve(host="127.0.0.1", port=7777):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port))
    s.listen(1)
    print(f"READY led_remote count={_COUNT} pin={_PIN}", flush=True)
    while True:
        try:
            c, addr = s.accept()
        except OSError:
            return
        buf = b""
        try:
            while True:
                data = c.recv(4096)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, _, buf = buf.partition(b"\n")
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        req = json.loads(line.decode("utf-8"))
                        op = req.get("op")
                        args = req.get("args") or {}
                        req_id = req.get("id")
                        resp = {"id": req_id, "ok": True}
                        handler = OPS.get(op)
                        if handler is None:
                            resp = {"id": req_id, "ok": False, "error": f"unknown op: {op}"}
                        else:
                            try:
                                result = handler(args)
                                resp.update(result)
                            except Exception as e:
                                resp["ok"] = False
                                resp["error"] = f"{type(e).__name__}: {e}"
                    except Exception as e:
                        resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                    try:
                        c.sendall((json.dumps(resp, separators=(",", ":")) + "\n").encode())
                    except OSError:
                        break
        finally:
            try: c.close()
            except Exception: pass

if __name__ == "__main__":
    serve()
'''


# ---------------- Transport: Direct SSH + TCP tunnel ----------------
class DirectSshLedController:
    """通过 SSH 把 Pi 上的 led_remote.py (TCP server) 暴露给 PC。

    PC 端的 self.s 直连 Pi 的 127.0.0.1:7777 (经 SSH 端口转发到本地 17777)。
    命令响应 < 5ms, 适合实时跟随 MIDI 事件。
    """

    def __init__(self, host: str, user: str, password: str,
                 count: int = LED_COUNT, pin: int = LED_PIN,
                 server_port: int = 7777,
                 brightness: float = 1.0,
                 timeout: float = 10.0):
        import paramiko
        self.cli = paramiko.SSHClient()
        self.cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.cli.connect(host, username=user, password=password, timeout=timeout)
        self.password = password
        self.count = count
        self.pin = pin
        self._server_port = server_port
        self._brightness = 1.0

        # 1. 上传 led_remote.py
        sftp = self.cli.open_sftp()
        try:
            with sftp.open('/tmp/led_remote.py', 'w') as f:
                f.write(LED_REMOTE_PY)
        finally:
            sftp.close()

        # 2. 关掉旧实例 (sudo 杀掉之前以 root 跑的进程)
        self._sudo_exec("pkill -9 -f /tmp/led_remote.py 2>/dev/null; sleep 0.3; true")

        # 3. 后台启 led_remote (用 sudo 因为 rpi_ws281x 需要 /dev/mem)
        self._sudo_exec(
            "nohup python3 -u /tmp/led_remote.py > /tmp/led_remote.log 2>&1 & disown; sleep 0.6"
        )

        # 4. 在 SSH transport 上开 direct-tcpip 通道直连 Pi 的 LED server
        transport = self.cli.get_transport()
        self.s = transport.open_channel(
            "direct-tcpip", ("127.0.0.1", server_port), ("127.0.0.1", 0)
        )
        self.s.settimeout(5)
        self._buf = b""

        # 5. 初始化 strip
        resp = self._rpc("init", {"count": count, "pin": pin})
        if not resp or not resp.get("ok"):
            tail = self._ssh_capture("tail -20 /tmp/led_remote.log 2>/dev/null")
            raise RuntimeError(f"init failed: {resp}\n--- remote log ---\n{tail}")
        # 6. 清空旧 LED 状态
        self._rpc("off")
        self.set_brightness(brightness)

    def _ssh_exec(self, cmd):
        i, o, e = self.cli.exec_command(cmd, timeout=10)
        return o.read().decode(errors="replace"), e.read().decode(errors="replace")

    def _ssh_capture(self, cmd):
        """Run cmd, return stdout (decoded)."""
        i, o, e = self.cli.exec_command(cmd, timeout=5)
        return o.read().decode(errors="replace")

    def _sudo_exec(self, cmd, timeout: float = 10.0):
        """用 sudo -S 跑 cmd, 通过 stdin 喂密码。"""
        full = f"sudo -S -p '' bash -c {self._shell_quote(cmd)}"
        stdin, stdout, stderr = self.cli.exec_command(full, timeout=timeout)
        stdin.write(self.password + "\n")
        stdin.flush()
        stdin.channel.shutdown_write()
        # 等到结束 (避免 race)
        return stdout.read().decode(errors="replace"), stderr.read().decode(errors="replace")

    @staticmethod
    def _shell_quote(s: str) -> str:
        return "'" + s.replace("'", "'\\''") + "'"

    def _sendall(self, data: bytes):
        view = memoryview(data)
        while view:
            n = self.s.send(bytes(view))
            view = view[n:]

    def _rpc(self, op: str, args: Optional[dict] = None, _id: Optional[str] = None):
        req = {"id": _id or op, "op": op, "args": args or {}}
        line = (json.dumps(req, separators=(",", ":")) + "\n").encode()
        self._sendall(line)
        while b"\n" not in self._buf:
            chunk = self.s.recv(4096)
            if not chunk:
                return None
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        try:
            return json.loads(line.decode())
        except Exception:
            return None

    # ---- public API ----
    def set_brightness(self, b: float):
        """设置全局亮度 0.0-1.0, 缩放后续 note_on 的 RGB。"""
        self._brightness = max(0.0, min(1.0, float(b)))

    def _scale(self, r, g, b):
        f = self._brightness
        return int(r * f), int(g * f), int(b * f)

    def note_on(self, midi_note: int):
        rng = note_to_led_range(midi_note)
        if rng is None:
            return
        r, g, b = self._scale(*color_for(midi_note))
        self._set_many_pixels([(i, r, g, b) for i in range(rng[0], rng[1])])

    def note_off(self, midi_note: int):
        rng = note_to_led_range(midi_note)
        if rng is None:
            return
        self._set_many_pixels([(i, 0, 0, 0) for i in range(rng[0], rng[1])])

    def _set_many_pixels(self, pixels):
        # Batch pixel writes into one set_many RPC per 80 pixels.
        if not pixels:
            return
        CHUNK = 80
        for k in range(0, len(pixels), CHUNK):
            chunk = pixels[k:k + CHUNK]
            args = {"pixels": [{"i": i, "r": r, "g": g, "b": b} for (i, r, g, b) in chunk]}
            self._rpc("set_many", args)

    def show(self):
        self._rpc("show")

    def all_off(self):
        self._rpc("off")

    def status(self):
        return self._rpc("status")

    def close(self):
        try:
            self.all_off()
        except Exception:
            pass
        for obj in (getattr(self, "s", None), getattr(self, "cli", None)):
            try:
                if obj is not None:
                    obj.close()
            except Exception:
                pass


# ---------------- Transport: BT (pyserial) ----------------
class BtLedController:
    """通过蓝牙虚拟 COM 端口走 bt-gpio 守护进程。

    需要先在 Windows 配对 (GUI 一次), 然后传 COM 号。
    """

    def __init__(self, com_port: str, count: int = LED_COUNT, pin: int = LED_PIN,
                 baud: int = 9600, timeout: float = 5.0, brightness: float = 1.0):
        import serial
        self.ser = serial.Serial(com_port, baud, timeout=timeout, write_timeout=timeout)
        try:
            self.ser.reset_input_buffer(); self.ser.reset_output_buffer()
        except Exception:
            pass
        self.count = count
        self.pin = pin
        self._buf = b""
        self._brightness = 1.0
        # 确认链路 (ping)
        pong = self._rpc("ping", timeout=3.0)
        if not pong or not pong.get("ok"):
            raise RuntimeError(f"BT handshake failed: {pong}")
        # init strip
        resp = self._rpc("led.init", {"pin": pin, "count": count})
        if not resp or not resp.get("ok"):
            raise RuntimeError(f"led.init failed: {resp}")
        # 清空旧状态 + 设亮度
        self._rpc("led.off")
        self.set_brightness(brightness)

    def _rpc(self, op: str, args: Optional[dict] = None, timeout: Optional[float] = None) -> Optional[dict]:
        req = {"id": "c", "op": op, "args": args or {}}
        old = self.ser.timeout
        if timeout is not None:
            self.ser.timeout = timeout
        try:
            self.ser.write((json.dumps(req, separators=(",", ":")) + "\n").encode())
            while b"\n" not in self._buf:
                chunk = self.ser.read(1)
                if not chunk:
                    return None
                self._buf += chunk
            line, _, self._buf = self._buf.partition(b"\n")
            return json.loads(line.decode())
        finally:
            if timeout is not None:
                self.ser.timeout = old

    def note_on(self, midi_note: int):
        rng = note_to_led_range(midi_note)
        if rng is None:
            return
        r, g, b = self._scale(*color_for(midi_note))
        self._set_many_pixels([(i, r, g, b) for i in range(rng[0], rng[1])])

    def note_off(self, midi_note: int):
        rng = note_to_led_range(midi_note)
        if rng is None:
            return
        self._set_many_pixels([(i, 0, 0, 0) for i in range(rng[0], rng[1])])

    def _set_many_pixels(self, pixels):
        # Batch pixel writes into one led.set_many RPC per 80 pixels.
        if not pixels:
            return
        CHUNK = 80
        for k in range(0, len(pixels), CHUNK):
            chunk = pixels[k:k + CHUNK]
            args = {"pixels": [{"index": i, "r": r, "g": g, "b": b} for (i, r, g, b) in chunk]}
            self._rpc("led.set_many", args)

    def set_brightness(self, b: float):
        """设置全局亮度 0.0-1.0, 缩放后续 note_on 的 RGB。"""
        self._brightness = max(0.0, min(1.0, float(b)))

    def _scale(self, r, g, b):
        f = self._brightness
        return int(r * f), int(g * f), int(b * f)

    def show(self):
        self._rpc("led.show")

    def all_off(self):
        self._rpc("led.off")

    def status(self):
        return self._rpc("status")

    def close(self):
        try:
            self.all_off()
        except Exception:
            pass
        try:
            self.ser.close()
        except Exception:
            pass


# ---------------- Auto (try BT, fall back to SSH) ----------------
def make_controller(bt_com: Optional[str] = None,
                    ssh_host: Optional[str] = None,
                    ssh_user: Optional[str] = None,
                    ssh_password: Optional[str] = None,
                    count: int = LED_COUNT,
                    pin: int = LED_PIN):
    """优先 BT, 不通则 SSH。返回 controller。"""
    if bt_com:
        try:
            return BtLedController(bt_com, count=count, pin=pin)
        except Exception as e:
            print(f"[led] BT unavailable ({e}), falling back to SSH")
    if ssh_host and ssh_user:
        return DirectSshLedController(ssh_host, ssh_user, ssh_password or "", count=count, pin=pin)
    raise RuntimeError("Neither bt_com nor ssh_host/user provided")


if __name__ == "__main__":
    # 自检: 打印映射表
    print(f"Mapping: {LED_COUNT} LEDs / {NUM_KEYS} keys = {LEDS_PER_KEY_F:.4f} LEDs/key (每键正好 2 颗)")
    print(f"MIDI {LOWEST_MIDI}-{HIGHEST_MIDI} (A0-C8, 88 keys, 按真实钢琴宽度 ~1.22m)")
    print()
    print("Sample ranges:")
    for n in [21, 22, 23, 24, 36, 48, 59, 60, 61, 72, 84, 95, 107, 108]:
        rng = note_to_led_range(n)
        c = color_for(n)
        side = "L" if is_left_hand(n) else "R"
        kind = "black" if is_black_key(n) else "white"
        print(f"  MIDI {n:3d} ({side} {kind:5s}) -> LEDs [{rng[0]:>3}..{rng[1]-1:>3}] ({rng[1]-rng[0]} 颗)  RGB{c}")