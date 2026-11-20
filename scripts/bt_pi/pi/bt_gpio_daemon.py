#!/usr/bin/env python3
"""Bluetooth RFCOMM GPIO control daemon for Raspberry Pi (DBus Profile1 版)。

用 DBus + bluez ProfileManager1 注册 SPP profile，bluez 自动完成 SDP 注册 +
RFCOMM 监听，新连接通过 Profile1.NewConnection 回调传给我们。

协议：JSON-over-TCP-style，按行分隔，请求-响应。

请求: {"id": "...", "op": "...", "args": {...}}\\n
响应: {"id": "...", "ok": true|false, "result"|"error": ...}\\n

支持的 op (v1):
  ping / status / gpio.mode / gpio.write / gpio.read /
  pwm.start / pwm.change / pwm.stop / cleanup

Requires: python3-bluez, python3-rpi.gpio, python3-dbus, python3-gi (apt install)
运行: sudo python3 bt_gpio_daemon.py
"""
import json
import os
import signal
import socket
import sys
import threading
import time
from typing import Any, Dict, Optional

# --- GPIO 懒加载 ---
GPIO = None
BCM_MODE = None


def _ensure_gpio():
    global GPIO, BCM_MODE
    if GPIO is not None:
        return
    try:
        import RPi.GPIO as _GPIO  # type: ignore
    except (ImportError, RuntimeError) as e:
        raise RuntimeError(f"RPi.GPIO 不可用: {e}") from e
    _GPIO.setmode(_GPIO.BCM)
    _GPIO.setwarnings(False)
    GPIO = _GPIO
    BCM_MODE = "BCM"


_pwm: Dict[int, Any] = {}


# --- 命令处理 (与 v1 完全一致) ---
def _op_ping(args):
    return {"pong": True, "ts": time.time()}


def _op_status(args):
    info = {
        "uptime": time.time() - START_TIME,
        "rpi_gpio_available": _gpio_available(),
        "mode": BCM_MODE,
        "active_pwm": sorted(_pwm.keys()),
        "led_initialized": _LED_STRIP is not None,
        "led_pin": _LED_PIN,
        "led_count": _LED_COUNT,
    }
    try:
        import dbus  # noqa: F401
        bus = dbus.SystemBus()
        obj = bus.get_object("org.bluez", "/")
        info["bt_addr"] = None
    except Exception:
        info["bt_addr"] = None
    return info


def _op_gpio_mode(args):
    _ensure_gpio()
    pin = _require(args, "pin")
    mode = args.get("mode", "out").lower()
    pull = (args.get("pull") or "none").lower()
    pud = None
    if mode == "in":
        if pull == "up":
            pud = GPIO.PUD_UP
        elif pull == "down":
            pud = GPIO.PUD_DOWN
        if pud is not None:
            GPIO.setup(pin, GPIO.IN, pull_up_down=pud)
        else:
            GPIO.setup(pin, GPIO.IN)
    elif mode == "out":
        GPIO.setup(pin, GPIO.OUT)
    else:
        raise ValueError(f"未知 mode: {mode}")
    if pin in _pwm:
        try:
            _pwm[pin].stop()
        except Exception:
            pass
        del _pwm[pin]
    return {"pin": pin, "mode": mode, "pull": pull}


def _op_gpio_write(args):
    _ensure_gpio()
    pin = _require(args, "pin")
    value = int(args["value"])
    if value not in (0, 1):
        raise ValueError("value 必须是 0 或 1")
    try:
        GPIO.output(pin, value)
    except RuntimeError:
        GPIO.setup(pin, GPIO.OUT)
        GPIO.output(pin, value)
    return {"pin": pin, "value": value}


def _op_gpio_read(args):
    _ensure_gpio()
    pin = _require(args, "pin")
    try:
        v = GPIO.input(pin)
    except RuntimeError:
        GPIO.setup(pin, GPIO.IN)
        v = GPIO.input(pin)
    return {"pin": pin, "value": int(v)}


def _op_pwm_start(args):
    _ensure_gpio()
    pin = _require(args, "pin")
    freq = float(args.get("freq", 1000))
    duty = float(args.get("duty", 0))
    if duty < 0 or duty > 100:
        raise ValueError("duty 必须在 0..100 之间")
    GPIO.setup(pin, GPIO.OUT)
    if pin in _pwm:
        p = _pwm[pin]
        p.ChangeFrequency(freq)
        p.ChangeDutyCycle(duty)
    else:
        p = GPIO.PWM(pin, freq)
        p.start(duty)
        _pwm[pin] = p
    return {"pin": pin, "freq": freq, "duty": duty}


def _op_pwm_change(args):
    _ensure_gpio()
    pin = _require(args, "pin")
    duty = float(args["duty"])
    if duty < 0 or duty > 100:
        raise ValueError("duty 必须在 0..100 之间")
    if pin not in _pwm:
        raise RuntimeError(f"pin {pin} 未启动 PWM，请先 pwm.start")
    _pwm[pin].ChangeDutyCycle(duty)
    return {"pin": pin, "duty": duty}


def _op_pwm_stop(args):
    _ensure_gpio()
    pin = _require(args, "pin")
    if pin in _pwm:
        _pwm[pin].stop()
        del _pwm[pin]
        return {"pin": pin, "stopped": True}
    return {"pin": pin, "stopped": False}


def _op_cleanup(args):
    _ensure_gpio()
    for p in list(_pwm.values()):
        try:
            p.stop()
        except Exception:
            pass
    _pwm.clear()
    GPIO.cleanup()
    # 也关掉 LED strip
    _led_off_internal()
    return {"cleaned": True}


# --- WS2812B LED strip ---
_LED_STRIP = None  # rpi_ws281x PixelStrip 对象
_LED_PIN = None
_LED_COUNT = None


def _ensure_led():
    global _LED_STRIP, _LED_PIN, _LED_COUNT
    if _LED_STRIP is not None:
        return _LED_STRIP
    try:
        from rpi_ws281x import PixelStrip  # type: ignore
    except (ImportError, RuntimeError) as e:
        raise RuntimeError(f"rpi_ws281x 不可用: {e}") from e
    raise RuntimeError("LED strip 未初始化，请先 led.init")


def _op_led_init(args):
    global _LED_STRIP, _LED_PIN, _LED_COUNT
    pin = _require(args, "pin")
    count = int(_require(args, "count"))
    if count <= 0 or count > 1000:
        raise ValueError("count 必须在 1..1000 之间")

    from rpi_ws281x import PixelStrip, Color  # type: ignore

    # 标准 WS2812B 配置: 800kHz, GRB 编码 (strip_type=0x00081000 = WS2811_STRIP_GRB)
    strip = PixelStrip(count, pin, 800000, 10, False, 255, 0, 0x00081000)
    strip.begin()

    _LED_STRIP = strip
    _LED_PIN = pin
    _LED_COUNT = count
    return {"pin": pin, "count": count}


def _op_led_set(args):
    strip = _ensure_led()
    index = int(_require(args, "index"))
    r = int(args.get("r", 0))
    g = int(args.get("g", 0))
    b = int(args.get("b", 0))
    if index < 0 or index >= _LED_COUNT:
        raise ValueError(f"index 必须在 0..{_LED_COUNT-1}")
    for v, name in ((r, "r"), (g, "g"), (b, "b")):
        if not 0 <= v <= 255:
            raise ValueError(f"{name} 必须在 0..255")

    from rpi_ws281x import Color  # type: ignore
    strip.setPixelColor(index, Color(r, g, b))
    return {"index": index, "r": r, "g": g, "b": b}


def _op_led_all(args):
    strip = _ensure_led()
    r = int(args.get("r", 0))
    g = int(args.get("g", 0))
    b = int(args.get("b", 0))
    for v, name in ((r, "r"), (g, "g"), (b, "b")):
        if not 0 <= v <= 255:
            raise ValueError(f"{name} 必须在 0..255")

    from rpi_ws281x import Color  # type: ignore
    c = Color(r, g, b)
    for i in range(_LED_COUNT):
        strip.setPixelColor(i, c)
    return {"count": _LED_COUNT, "r": r, "g": g, "b": b}


def _op_led_show(args):
    strip = _ensure_led()
    strip.show()
    return {"shown": True}


def _op_led_off(args):
    strip = _ensure_led()
    for i in range(_LED_COUNT):
        strip.setPixelColor(i, 0)
    strip.show()
    return {"off": True}


def _op_led_set_many(args):
    """批量设置像素. 一次 RPC 搞定, 大幅降低 latency.
    args.pixels: [{"i": int, "r": int, "g": int, "b": int}, ...]
    重复 index 取最后一次. 范围越界抛错.
    """
    strip = _ensure_led()
    pixels = _require(args, "pixels")
    if not isinstance(pixels, list):
        raise ValueError("pixels 必须是列表")
    if len(pixels) > _LED_COUNT * 4:
        raise ValueError("单次批量像素数过大 (" + str(len(pixels)) + " > " + str(_LED_COUNT * 4) + ")")
    from rpi_ws281x import Color  # type: ignore
    n = 0
    for px in pixels:
        if not isinstance(px, dict):
            raise ValueError("每个像素必须是 {i, r, g, b} 对象")
        idx = int(px["i"])
        r = int(px.get("r", 0))
        g = int(px.get("g", 0))
        b = int(px.get("b", 0))
        if idx < 0 or idx >= _LED_COUNT:
            raise ValueError("index " + str(idx) + " 必须在 0.." + str(_LED_COUNT - 1))
        for v, name in ((r, "r"), (g, "g"), (b, "b")):
            if not 0 <= v <= 255:
                raise ValueError(name + " 必须在 0..255")
        strip.setPixelColor(idx, Color(r, g, b))
        n += 1
    return {"set": n}


def _op_led_status(args):
    return {
        "initialized": _LED_STRIP is not None,
        "pin": _LED_PIN,
        "count": _LED_COUNT,
    }


def _led_off_internal():
    global _LED_STRIP
    if _LED_STRIP is None:
        return
    try:
        for i in range(_LED_COUNT):
            _LED_STRIP.setPixelColor(i, 0)
        _LED_STRIP.show()
    except Exception:
        pass


OPS = {
    "ping": _op_ping,
    "status": _op_status,
    "gpio.mode": _op_gpio_mode,
    "gpio.write": _op_gpio_write,
    "gpio.read": _op_gpio_read,
    "pwm.start": _op_pwm_start,
    "pwm.change": _op_pwm_change,
    "pwm.stop": _op_pwm_stop,
    "cleanup": _op_cleanup,
    # LED
    "led.init": _op_led_init,
    "led.set": _op_led_set,
    "led.all": _op_led_all,
    "led.show": _op_led_show,
    "led.off": _op_led_off,
    "led.status": _op_led_status,
    "led.set_many": _op_led_set_many,
}


def _require(args, key):
    if key not in args:
        raise ValueError(f"缺少参数: {key}")
    return args[key]


def _gpio_available():
    try:
        import RPi.GPIO  # noqa: F401
        return True
    except Exception:
        return False


START_TIME = time.time()


def handle_command(req: dict) -> Dict[str, Any]:
    req_id = req.get("id")
    op = req.get("op")
    args = req.get("args") or {}
    resp: Dict[str, Any] = {"id": req_id} if req_id is not None else {}
    if not isinstance(op, str):
        resp["ok"] = False
        resp["error"] = "missing or invalid 'op'"
        return resp
    handler = OPS.get(op)
    if handler is None:
        resp["ok"] = False
        resp["error"] = f"unknown op: {op}"
        return resp
    try:
        result = handler(args)
        resp["ok"] = True
        resp.update(result)
        return resp
    except Exception as e:
        resp["ok"] = False
        resp["error"] = f"{type(e).__name__}: {e}"
        return resp


def _serve_client_thread(sock, peer):
    """为单个连接跑协议，结束后清理。"""
    try:
        print(f"[bt-gpio] serve {peer}", flush=True)
        _serve_client(sock)
    except Exception as e:
        print(f"[bt-gpio] serve error {peer}: {e}", flush=True)
    finally:
        try:
            sock.close()
        except Exception:
            pass
        print(f"[bt-gpio] closed {peer}", flush=True)


def _serve_client(sock):
    buf = b""
    sock.settimeout(120.0)
    while True:
        try:
            chunk = sock.recv(4096)
        except (OSError, TimeoutError):
            return
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
                resp = handle_command(req)
            except (UnicodeDecodeError, json.JSONDecodeError) as e:
                resp = {"ok": False, "error": f"bad json: {e}"}
            except Exception as e:
                resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
            try:
                _send(sock, resp)
            except OSError:
                return


def _send(sock, obj):
    payload = (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")
    sock.sendall(payload)


# --- DBus Profile1 实现 ---
PROFILE_PATH = "/org/bt/gpio/spp"
PROFILE_UUID = "00001101-0000-1000-8000-00805F9B34FB"  # 标准 SPP UUID
PROFILE_CHANNEL = 4
PROFILE_NAME = "BtGpioService"


class SPPProfile:
    """不需要继承 dbus.service.Object，用 dbus.service.method 装饰方法即可。

    DBus 入口靠 _dbus_class_info 告诉 dbus-python 我们的接口名。
    """

    def __init__(self, bus, path):
        self.bus = bus
        self.path = path
        self._obj = None

    def register(self):
        import dbus
        import dbus.service

        class _Inner(dbus.service.Object):
            @dbus.service.method("org.bluez.Profile1", in_signature="", out_signature="")
            def Release(self_inner):
                print("[bt-gpio] Profile1.Release", flush=True)

            @dbus.service.method("org.bluez.Profile1", in_signature="oha{sv}", out_signature="")
            def NewConnection(self_inner, device, fd, properties):
                # fd 是 DBus 传来的 unix fd，先 dup 出来
                fd = int(fd)
                sock = socket.fromfd(fd, socket.AF_UNIX, socket.SOCK_STREAM)
                os.close(fd)
                peer = str(device)
                t = threading.Thread(target=_serve_client_thread, args=(sock, peer), daemon=True)
                t.start()

            @dbus.service.method("org.bluez.Profile1", in_signature="o", out_signature="")
            def RequestDisconnection(self_inner, device):
                print(f"[bt-gpio] Profile1.RequestDisconnection {device}", flush=True)

        self._obj = _Inner(self.bus, self.path)
        manager_iface = dbus.Interface(
            self.bus.get_object("org.bluez", "/org/bluez"),
            "org.bluez.ProfileManager1",
        )
        opts = dbus.Dictionary({
            "AutoConnect": dbus.Boolean(True),
            "Name": dbus.String(PROFILE_NAME),
            "Channel": dbus.UInt16(PROFILE_CHANNEL),
            "Role": dbus.String("server"),
        }, signature="sv")
        manager_iface.RegisterProfile(
            dbus.ObjectPath(self.path), PROFILE_UUID, opts
        )
        print(f"[bt-gpio] registered SPP profile at {self.path} ch={PROFILE_CHANNEL}", flush=True)

    def unregister(self):
        if self._obj is None:
            return
        try:
            import dbus
            manager_iface = dbus.Interface(
                self.bus.get_object("org.bluez", "/org/bluez"),
                "org.bluez.ProfileManager1",
            )
            manager_iface.UnregisterProfile(self.path)
            print("[bt-gpio] unregistered SPP profile", flush=True)
        except Exception as e:
            print(f"[bt-gpio] unregister error: {e}", flush=True)
        try:
            self._obj.remove_from_connection()
        except Exception:
            pass


def serve_dbus():
    try:
        import dbus
        import dbus.mainloop.glib
        from gi.repository import GLib
    except ImportError as e:
        print(f"FATAL: 缺少 DBus/GI 依赖 ({e})", file=sys.stderr, flush=True)
        sys.exit(2)

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    profile = SPPProfile(bus, PROFILE_PATH)
    profile.register()

    loop = GLib.MainLoop()

    def shutdown(*_):
        print("[bt-gpio] shutting down", flush=True)
        try:
            profile.unregister()
        except Exception:
            pass
        loop.quit()
        # 给守护线程一点时间退出
        threading.Timer(1.0, lambda: os._exit(0)).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print("[bt-gpio] GLib main loop running", flush=True)
    try:
        loop.run()
    finally:
        for p in list(_pwm.values()):
            try:
                p.stop()
            except Exception:
                pass
        _pwm.clear()
        if GPIO is not None:
            try:
                GPIO.cleanup()
            except Exception:
                pass


def main():
    if os.geteuid() != 0:
        print("WARNING: 非 root 运行，bluetooth/RPi.GPIO 可能受限", file=sys.stderr, flush=True)
    serve_dbus()


if __name__ == "__main__":
    main()