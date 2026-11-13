#!/usr/bin/env python3
"""bt-gpio 守护进程 + 客户端协议层单元测试。

不依赖蓝牙 / RPi.GPIO：用 socket.socketpair() 在内存里跑一遍请求-响应，
配合 FakeGPIO 模拟树莓派侧。
运行: python test_protocol.py
"""
import json
import socket
import sys
import threading
import unittest
from typing import Optional

# 让 test 能找到 bt_gpio_daemon
sys.path.insert(0, "D:/code/piano-follow/scripts/bt_pi/pi")

import bt_gpio_daemon as daemon  # noqa: E402


# --------------- 测试用 FakeGPIO ---------------
class FakeGPIO:
    BCM = "BCM"
    OUT = "OUT"
    IN = "IN"
    PUD_UP = "PUD_UP"
    PUD_DOWN = "PUD_DOWN"

    def __init__(self):
        self.mode = None
        self.pins = {}

    def setmode(self, m):
        self.mode = m

    def setwarnings(self, _):
        pass

    def setup(self, pin, mode, pull_up_down=None):
        self.pins.setdefault(pin, {"value": 0, "pwm": None})
        self.pins[pin]["mode"] = mode
        self.pins[pin]["pud"] = pull_up_down

    def output(self, pin, value):
        self.pins.setdefault(pin, {"value": 0, "pwm": None})
        if self.pins[pin].get("mode") not in ("OUT", None):
            raise RuntimeError("pin not configured as OUT")
        self.pins[pin]["value"] = int(value)

    def input(self, pin):
        self.pins.setdefault(pin, {"value": 0, "pwm": None})
        return self.pins[pin]["value"]

    def cleanup(self):
        for p in self.pins.values():
            if p.get("pwm"):
                try:
                    p["pwm"].stop()
                except Exception:
                    pass
            p["pwm"] = None
        self.pins.clear()

    class PWM:
        def __init__(self, pin, freq):
            self.pin = pin
            self.freq = freq
            self.duty = 0
            self.running = False

        def start(self, duty):
            self.duty = duty
            self.running = True

        def ChangeDutyCycle(self, duty):
            self.duty = duty

        def ChangeFrequency(self, freq):
            self.freq = freq

        def stop(self):
            self.running = False
            self.duty = 0


# --------------- 测试用 FakeLED (rpi_ws281x) ---------------
class FakePixelStrip:
    """Memory-backed mock of rpi_ws281x.PixelStrip."""

    def __init__(self, count, pin, freq_hz, dma, invert, brightness, channel, strip_type):
        self.count = count
        self.pin = pin
        self.pixels = [(0, 0, 0)] * count
        self.show_count = 0

    def begin(self):
        pass

    def setPixelColor(self, index, color):
        # 统一存 int (与真实 PixelStrip 内部行为一致)
        self.pixels[index] = int(color) & 0xFFFFFF

    def getPixelColor(self, index):
        return self.pixels[index]

    def show(self):
        self.show_count += 1

    def numPixels(self):
        return self.count


def install_fake_led(monkeypatch_module=None):
    """把 rpi_ws281x.PixelStrip/Color 替换成 fake。"""
    import sys as _sys
    fake_mod = type(_sys)("rpi_ws281x_fake")
    fake_mod.PixelStrip = FakePixelStrip

    def fake_color(r, g, b):
        # 简单打包成 32-bit 整数
        return ((g & 0xFF) << 16) | ((r & 0xFF) << 8) | (b & 0xFF)

    fake_mod.Color = fake_color
    _sys.modules["rpi_ws281x"] = fake_mod
    # 清理 daemon 状态
    daemon._LED_STRIP = None
    daemon._LED_PIN = None
    daemon._LED_COUNT = None


def install_fake_gpio():
    fake = FakeGPIO()
    daemon.GPIO = fake
    daemon.BCM_MODE = "BCM"
    return fake


# --------------- 模拟守护进程的 _serve_client 行为 ---------------
def daemon_serve_loop(sock: socket.socket):
    """简化版 _serve_client：按行读 JSON 请求，回 JSON 响应。"""
    buf = b""
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, _, buf = buf.partition(b"\n")
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line.decode("utf-8"))
                    resp = daemon.handle_command(req)
                except json.JSONDecodeError as e:
                    resp = {"ok": False, "error": f"bad json: {e}"}
                except Exception as e:
                    resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
                sock.sendall((json.dumps(resp, separators=(",", ":")) + "\n").encode())
    except OSError:
        return


class FakeClientLink:
    """模仿 BtGpioLink.request 的语义，但用裸 socket。"""

    def __init__(self, sock: socket.socket):
        self.sock = sock
        self._buf = b""

    def _read_line(self) -> Optional[bytes]:
        while b"\n" not in self._buf:
            chunk = self.sock.recv(1)
            if not chunk:
                return None
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        return line.strip()

    def request(self, op: str, args: Optional[dict] = None) -> dict:
        req = {"id": "t", "op": op, "args": args or {}}
        self.sock.sendall((json.dumps(req, separators=(",", ":")) + "\n").encode())
        line = self._read_line()
        assert line is not None, "no response"
        return json.loads(line.decode())


# --------------- 测试用例 ---------------
class ProtocolTest(unittest.TestCase):
    def setUp(self):
        install_fake_gpio()
        install_fake_led()

    def test_ping(self):
        r = daemon.handle_command({"id": "1", "op": "ping"})
        self.assertTrue(r["ok"])
        self.assertTrue(r["pong"])

    def test_unknown_op(self):
        r = daemon.handle_command({"op": "nope"})
        self.assertFalse(r["ok"])
        self.assertIn("unknown op", r["error"])

    def test_gpio_write_and_read(self):
        daemon.handle_command({"op": "gpio.mode", "args": {"pin": 17, "mode": "out"}})
        r1 = daemon.handle_command({"op": "gpio.write", "args": {"pin": 17, "value": 1}})
        self.assertTrue(r1["ok"])
        self.assertEqual(r1["value"], 1)
        r2 = daemon.handle_command({"op": "gpio.read", "args": {"pin": 17}})
        self.assertTrue(r2["ok"])
        self.assertEqual(r2["value"], 1)

    def test_pwm_start_change_stop(self):
        r1 = daemon.handle_command({"op": "pwm.start", "args": {"pin": 18, "freq": 1000, "duty": 25}})
        self.assertTrue(r1["ok"])
        r2 = daemon.handle_command({"op": "pwm.change", "args": {"pin": 18, "duty": 75}})
        self.assertTrue(r2["ok"])
        r3 = daemon.handle_command({"op": "pwm.stop", "args": {"pin": 18}})
        self.assertTrue(r3["ok"])

    def test_id_echo(self):
        r = daemon.handle_command({"id": "abc-123", "op": "ping"})
        self.assertEqual(r.get("id"), "abc-123")

    def test_status(self):
        r = daemon.handle_command({"op": "status"})
        self.assertTrue(r["ok"])
        self.assertIn("uptime", r)
        self.assertIn("active_pwm", r)
        self.assertIn("led_initialized", r)

    def test_cleanup(self):
        daemon.handle_command({"op": "pwm.start", "args": {"pin": 18, "freq": 1000, "duty": 50}})
        r = daemon.handle_command({"op": "cleanup"})
        self.assertTrue(r["ok"])

    def test_led_init(self):
        r = daemon.handle_command({"op": "led.init", "args": {"pin": 18, "count": 60}})
        self.assertTrue(r["ok"])
        self.assertEqual(r["count"], 60)
        self.assertEqual(r["pin"], 18)

    def test_led_set_first_pixel(self):
        daemon.handle_command({"op": "led.init", "args": {"pin": 18, "count": 10}})
        r = daemon.handle_command({"op": "led.set", "args": {"index": 0, "r": 255, "g": 0, "b": 0}})
        self.assertTrue(r["ok"])
        strip = daemon._LED_STRIP
        expected = (0 << 16) | (255 << 8) | 0  # Color(255,0,0)
        self.assertEqual(strip.pixels[0], expected)

    def test_led_all_and_off(self):
        daemon.handle_command({"op": "led.init", "args": {"pin": 18, "count": 10}})
        r1 = daemon.handle_command({"op": "led.all", "args": {"r": 0, "g": 255, "b": 0}})
        self.assertTrue(r1["ok"])
        strip = daemon._LED_STRIP
        expected = (255 << 16) | (0 << 8) | 0
        for px in strip.pixels:
            self.assertEqual(px, expected)

        r2 = daemon.handle_command({"op": "led.show"})
        self.assertTrue(r2["ok"])
        self.assertEqual(strip.show_count, 1)

        r3 = daemon.handle_command({"op": "led.off"})
        self.assertTrue(r3["ok"])
        self.assertEqual(strip.show_count, 2)
        for px in strip.pixels:
            self.assertEqual(px, 0)

    def test_led_set_without_init(self):
        r = daemon.handle_command({"op": "led.set", "args": {"index": 0, "r": 255, "g": 0, "b": 0}})
        self.assertFalse(r["ok"])
        self.assertIn("未初始化", r["error"])

    def test_led_status(self):
        s1 = daemon.handle_command({"op": "led.status"})
        self.assertFalse(s1["initialized"])
        daemon.handle_command({"op": "led.init", "args": {"pin": 18, "count": 30}})
        s2 = daemon.handle_command({"op": "led.status"})
        self.assertTrue(s2["initialized"])
        self.assertEqual(s2["pin"], 18)
        self.assertEqual(s2["count"], 30)

    def test_e2e_socketpair(self):
        """端到端: 通过 socket.socketpair() 在两个线程里跑 daemon ↔ client。"""
        client_sock, daemon_sock = socket.socketpair()
        client = FakeClientLink(client_sock)
        t = threading.Thread(target=daemon_serve_loop, args=(daemon_sock,), daemon=True)
        t.start()
        try:
            # ping
            r = client.request("ping")
            self.assertTrue(r["ok"])
            self.assertTrue(r["pong"])

            # mode + write + read
            r = client.request("gpio.mode", {"pin": 17, "mode": "out"})
            self.assertTrue(r["ok"])
            r = client.request("gpio.write", {"pin": 17, "value": 1})
            self.assertTrue(r["ok"])
            r = client.request("gpio.read", {"pin": 17})
            self.assertTrue(r["ok"])
            self.assertEqual(r["value"], 1)

            # pwm start/change/stop
            r = client.request("pwm.start", {"pin": 18, "freq": 1000, "duty": 30})
            self.assertTrue(r["ok"])
            r = client.request("pwm.change", {"pin": 18, "duty": 70})
            self.assertTrue(r["ok"])
            r = client.request("pwm.stop", {"pin": 18})
            self.assertTrue(r["ok"])

            # LED 流程
            r = client.request("led.init", {"pin": 18, "count": 10})
            self.assertTrue(r["ok"])
            r = client.request("led.set", {"index": 0, "r": 255, "g": 0, "b": 0})
            self.assertTrue(r["ok"])
            r = client.request("led.show")
            self.assertTrue(r["ok"])
            r = client.request("led.status")
            self.assertTrue(r["initialized"])

            # 未知 op 应该返回 ok:false
            r = client.request("bogus")
            self.assertFalse(r["ok"])

            # status
            r = client.request("status")
            self.assertTrue(r["ok"])
            self.assertIn("active_pwm", r)
            self.assertTrue(r["led_initialized"])
        finally:
            client_sock.close()
            daemon_sock.close()
            t.join(timeout=2)


if __name__ == "__main__":
    unittest.main(verbosity=2)