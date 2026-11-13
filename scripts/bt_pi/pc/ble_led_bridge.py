#!/usr/bin/env python3
"""WebSocket <-> BLE bridge for the ESP32-S3 LED peripheral.

Serves the same WebSocket protocol the frontend already speaks
(src/led/LedController.ts), but the far side is the ESP32's BLE GATT link
instead of the Pi's TCP LED server.

Protocol (identical to the Pi's ws_led_bridge.py):
  browser -> {"id":N,"op":"auth","token":"..."}   (first message, if token set)
  browser -> {"id":N,"op":"set","args":{"i":0,"r":0,"g":0,"b":200}}
  browser -> {"id":N,"op":"set_many","args":{"pixels":[{"i":0,"r":..,"g":..,"b":..}]}}
  browser -> {"id":N,"op":"show"|"off"|"init"|"ping"|"status"}
  device  -> {"id":N,"ok":true,"result":{...}}

The ESP32 speaks the Pi daemon's op vocabulary (led.set / led.set_many / ...),
so this bridge translates between the two.

Usage:
  python ble_led_bridge.py                        # listen on 0.0.0.0:8080
  python ble_led_bridge.py --port 8080
  python ble_led_bridge.py --name pianoflow

Dependencies: pip install bleak websockets
"""
from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import logging
import os
from typing import Any, Optional

from bleak import BleakClient, BleakScanner
import websockets

log = logging.getLogger("ble_led_bridge")

DEFAULT_NAME = "pianoflow"
DEFAULT_WS_PORT = 8080
MAX_MSG_SIZE = 64 * 1024
AUTH_TIMEOUT_S = 10.0

# 设备端 (ESP32) 的 op 名字
DEV_OPS = {
    "ping": ("ping", None),
    "status": ("status", None),
    "init": ("led.init", None),
    "set": ("led.set", None),
    "set_many": ("led.set_many", None),
    "show": ("led.show", None),
    "off": ("led.off", None),
    "ledstatus": ("led.status", None),
}


class BleDevice:
    """一条 ESP32 BLE 连接 —— 把 JSON 命令转成设备 op。"""

    def __init__(self, client: BleakClient, rx_uuid: str, tx_uuid: str):
        self.client = client
        self.rx_uuid = rx_uuid
        self.tx_uuid = tx_uuid
        self._buf = bytearray()
        self._lines: list[str] = []

    async def start(self) -> None:
        async def on_notify(_sender, data) -> None:
            self._buf.extend(data)
            while b"\n" in self._buf:
                line, _, self._buf = self._buf.partition(b"\n")
                if line.strip():
                    self._lines.append(line.decode("utf-8", "replace"))

        await self.client.start_notify(self.tx_uuid, on_notify)

    async def close(self) -> None:
        try:
            await self.client.stop_notify(self.tx_uuid)
        except Exception:
            pass

    async def send(self, op: str, args: Optional[dict]) -> Optional[dict]:
        req: dict[str, Any] = {"id": "1", "op": op}
        if args is not None:
            req["args"] = args
        payload = (json.dumps(req, separators=(",", ":")) + "\n").encode("utf-8")

        # BLE 单次写受 MTU 限制 (MTU 247 -> 244 字节), 长命令要分片。
        mtu = getattr(self.client, "mtu_size", 0) or 20
        chunk = max(20, mtu - 3)
        for off in range(0, len(payload), chunk):
            await self.client.write_gatt_char(self.rx_uuid, payload[off:off + chunk])

        # 等响应
        deadline = asyncio.get_event_loop().time() + 5.0
        while not self._lines:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return None
            await asyncio.sleep(0.02)
        line = self._lines.pop(0)
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            return {"ok": False, "error": f"bad device response: {line!r}"}


def translate(op: str, args: dict) -> tuple[str, Optional[dict]]:
    """前端 op -> 设备 op + 参数改名。

    前端 set 用 {"i":..,"r":..,"g":..,"b":..}, 设备 led.set 用 {"index":..,..}。
    """
    if op == "set":
        args = dict(args or {})
        if "i" in args and "index" not in args:
            args["index"] = args.pop("i")
        return "led.set", args
    if op == "init":
        args = dict(args or {})
        # 设备固件的 pin/count 是编译期固定的, 传一样的值即可
        return "led.init", args
    if op in ("set_many", "show", "off", "ping", "status"):
        return DEV_OPS[op][0], args
    return op, args


async def connect_device(name: str, timeout: float) -> Optional[BleDevice]:
    log.info("扫描 BLE 设备 %r ...", name)
    device = await BleakScanner.find_device_by_name(name, timeout=timeout)
    if device is None:
        log.warning("没找到 BLE 设备 %r", name)
        return None
    log.info("连接 %s ...", device)
    client = BleakClient(device)
    try:
        await client.connect()
    except Exception as e:
        log.warning("连接失败: %s", e)
        return None
    dev = BleDevice(client,
                   "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
                   "6e400003-b5a3-f393-e0a9-e50e24dcca9e")
    await dev.start()
    log.info("已连接")
    return dev


class Bridge:
    """一个浏览器 WS 客户端 —— 复用一个设备连接。"""

    def __init__(self, name: str, token: Optional[str]):
        self.name = name
        self.token = token
        self.dev: Optional[BleDevice] = None
        self.lock = asyncio.Lock()

    async def ensure_device(self) -> Optional[BleDevice]:
        async with self.lock:
            if self.dev is not None:
                return self.dev
            self.dev = await connect_device(self.name, timeout=10.0)
            return self.dev

    async def drop_device(self) -> None:
        async with self.lock:
            if self.dev is not None:
                await self.dev.close()
                try:
                    await self.dev.client.disconnect()
                except Exception:
                    pass
                self.dev = None


async def handle_client(ws, bridge: Bridge) -> None:
    """一个 WS 客户端的生命周期。"""
    authed = bridge.token is None
    first = True

    try:
        async for raw in ws:
            if len(raw) > MAX_MSG_SIZE:
                await ws.close(1008, "message too large")
                return
            try:
                req = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send(json.dumps({"ok": False, "error": "bad json"}))
                await ws.close(1008, "bad json")
                return

            # 配了 token 的话, 第一条必须是 auth
            if not authed:
                if not first:
                    await ws.close(1008, "auth required")
                    return
                if req.get("op") != "auth" or not hmac.compare_digest(
                        str(req.get("token", "")), bridge.token or ""):
                    await ws.send(json.dumps({"ok": False, "error": "auth required"}))
                    await ws.close(1008, "auth required")
                    return
                authed = True
                first = False
                await ws.send(json.dumps({"ok": True, "authed": True}))
                continue
            first = False

            op = req.get("op", "")
            req_id = req.get("id")
            args = req.get("args") or {}

            dev = await bridge.ensure_device()
            if dev is None:
                await ws.send(json.dumps({"id": req_id, "ok": False,
                                          "error": "device not connected"}))
                continue

            dev_op, dev_args = translate(op, args)
            resp = await dev.send(dev_op, dev_args)
            if resp is None:
                await bridge.drop_device()
                await ws.send(json.dumps({"id": req_id, "ok": False,
                                          "error": "device timeout"}))
                continue

            # 设备回的是 {"id":..,"ok":..,"result":..}; 前端只要 ok/error
            out: dict[str, Any] = {"id": req_id, "ok": bool(resp.get("ok"))}
            if resp.get("ok") is False:
                out["error"] = resp.get("error", "device error")
            elif "result" in resp:
                out["result"] = resp["result"]
            await ws.send(json.dumps(out))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        await bridge.drop_device()


async def main() -> None:
    ap = argparse.ArgumentParser(description="WebSocket <-> BLE bridge for ESP32 LED")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=DEFAULT_WS_PORT)
    ap.add_argument("--name", default=DEFAULT_NAME, help="ESP32 广播名")
    ap.add_argument("--token", default=os.environ.get("LED_TOKEN", ""),
                    help="共享 token (与树莓派端一致)")
    ap.add_argument("--log", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(level=getattr(logging, args.log.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(message)s")

    bridge = Bridge(args.name, args.token or None)
    async with websockets.serve(
            lambda ws: handle_client(ws, bridge),
            args.host, args.port, max_size=MAX_MSG_SIZE):
        log.info("WS bridge 监听 ws://%s:%d  ->  BLE %s", args.host, args.port, args.name)
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
