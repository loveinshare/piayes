#!/usr/bin/env python3
"""ESP32-S3 BLE LED 外设客户端 (Windows)。

外设广播名 "pianoflow", 用 BLE GATT (Nordic UART 风格 UUID) 通信。
命令格式跟树莓派端 bt_gpio_daemon.py 一致 —— JSON 行。

用法:
  python ble_led_client.py                 # 扫描并连接 "pianoflow"
  python ble_led_client.py --name pianoflow
  python ble_led_client.py --scan         # 只扫描, 不连接
  python ble_led_client.py --raw '{"id":"1","op":"ping"}'

REPL 命令:
  help                  显示所有命令
  ping                  ping
  status                status
  led <i> <r> <g> <b>    点亮第 i 颗 (0-based)
  ledall <r> <g> <b>    全部点亮
  off                   全灭
  ledstatus             灯带状态
  raw <json>            直接发送原始 JSON
  quit                  退出

安装依赖: pip install bleak
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from typing import Optional

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # 主机写
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # 设备通知

DEFAULT_NAME = "pianoflow"


class BleLedLink:
    """一条 BLE 连接 —— 收发 JSON 行。"""

    def __init__(self, client: BleakClient):
        self.client = client
        self._buf = bytearray()
        self._lines: list[str] = []
        self._notify_started = False

    async def start(self) -> None:
        async def on_notify(_sender, data) -> None:
            self._buf.extend(data)
            while b"\n" in self._buf:
                line, _, self._buf = self._buf.partition(b"\n")
                if line.strip():
                    self._lines.append(line.decode("utf-8", "replace"))

        await self.client.start_notify(TX_UUID, on_notify)
        self._notify_started = True

    async def close(self) -> None:
        if self._notify_started:
            try:
                await self.client.stop_notify(TX_UUID)
            except Exception:
                pass
            self._notify_started = False

    async def _write_line(self, text: str) -> None:
        """发一条以 \\n 结尾的命令。

        BLE 单次写受 MTU 限制 (默认 MTU 247 → 244 字节有效载荷),
        前端一批 80 个像素的 led.set_many 有 ~2.7KB, 必须分片发。
        固件按行重组, 所以这里按 MTU 切就行。
        """
        data = (text + "\n").encode("utf-8")
        mtu = getattr(self.client, "mtu_size", 0) or 20
        chunk = max(20, mtu - 3)
        for off in range(0, len(data), chunk):
            await self.client.write_gatt_char(RX_UUID, data[off:off + chunk])

    async def request(self, op: str, args: Optional[dict] = None,
                      timeout: float = 5.0) -> Optional[dict]:
        """发一条命令, 等一条响应。返回解析后的 JSON, 超时返回 None。"""
        req = {"id": uuid.uuid4().hex[:8], "op": op}
        if args is not None:
            req["args"] = args
        await self._write_line(json.dumps(req, separators=(",", ":")))

        deadline = asyncio.get_event_loop().time() + timeout
        while not self._lines:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                return None
            await asyncio.sleep(0.05)
        line = self._lines.pop(0)
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            return {"id": req["id"], "ok": False, "error": f"bad response: {line!r}"}

    async def send_raw(self, text: str) -> None:
        await self._write_line(text)


async def scan(name: str, timeout: float) -> list:
    res = await BleakScanner.discover(timeout=timeout, return_adv=True)
    out = []
    for dev, adv in res.items():
        # bleak 3.x 的返回值可能是 (BLEDevice, AdvertisementData) 或只一个对象
        a = adv[1] if isinstance(adv, tuple) else adv
        local = getattr(a, "local_name", None)
        if local and name.lower() in local.lower():
            out.append((dev, local, getattr(a, "rssi", None)))
    return out


async def connect(name: str, timeout: float) -> Optional[BleLedLink]:
    print(f"扫描 BLE 设备 {name!r} ...")
    device = await BleakScanner.find_device_by_name(name, timeout=timeout)
    if device is None:
        return None
    print(f"连接 {device} ...")
    client = BleakClient(device)
    await client.connect()
    link = BleLedLink(client)
    await link.start()
    return link


async def repl(link: BleLedLink) -> None:
    help_text = """可用命令:
  help                  显示此帮助
  ping                  ping
  status                status
  led <i> <r> <g> <b>    点亮第 i 颗 (0-based)
  ledall <r> <g> <b>    全部点亮
  off                   全灭
  ledstatus             灯带状态
  raw <json>            直接发送原始 JSON
  quit                  退出"""
    print(help_text)
    loop = asyncio.get_event_loop()
    while True:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
        except (KeyboardInterrupt, EOFError):
            break
        if not line:
            break
        parts = line.strip().split()
        if not parts:
            continue
        cmd = parts[0].lower()

        if cmd in ("quit", "exit", "q"):
            break
        if cmd == "help":
            print(help_text)
            continue
        if cmd == "raw":
            await link.send_raw(" ".join(parts[1:]))
            await asyncio.sleep(0.3)
            continue

        op, args = None, None
        if cmd == "ping":
            op = "ping"
        elif cmd == "status":
            op = "status"
        elif cmd == "ledstatus":
            op = "led.status"
        elif cmd == "off":
            op = "led.off"
        elif cmd == "led" and len(parts) == 5:
            op = "led.set"
            args = {"index": int(parts[1]), "r": int(parts[2]),
                    "g": int(parts[3]), "b": int(parts[4])}
        elif cmd == "ledall" and len(parts) == 4:
            op = "led.all"
            args = {"r": int(parts[1]), "g": int(parts[2]), "b": int(parts[3])}
        else:
            print("命令格式不对, 输入 help 看用法")
            continue

        resp = await link.request(op, args)
        print(json.dumps(resp, ensure_ascii=False))


async def main() -> int:
    ap = argparse.ArgumentParser(description="ESP32-S3 BLE LED 外设客户端")
    ap.add_argument("--name", default=DEFAULT_NAME, help="外设广播名 (默认 pianoflow)")
    ap.add_argument("--scan", action="store_true", help="只扫描不连接")
    ap.add_argument("--scan-timeout", type=float, default=10.0, help="扫描秒数")
    ap.add_argument("--raw", help="连接后发一条原始 JSON 然后退出")
    args = ap.parse_args()

    if args.scan:
        found = await scan(args.name, args.scan_timeout)
        if not found:
            print(f"没找到名字里含 {args.name!r} 的 BLE 设备")
            return 1
        for dev, local, rssi in found:
            print(f"{dev}  name={local!r}  rssi={rssi}")
        return 0

    link = await connect(args.name, args.scan_timeout)
    if link is None:
        print(f"没找到名字里含 {args.name!r} 的 BLE 设备 —— "
              f"确认外设有电并在广播")
        return 1

    try:
        if args.raw:
            await link.send_raw(args.raw)
            await asyncio.sleep(1.0)
            print(link._lines.pop(0) if link._lines else "(无响应)")
        else:
            await repl(link)
    finally:
        await link.close()
        await link.client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
