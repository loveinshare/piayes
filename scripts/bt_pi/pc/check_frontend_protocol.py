"""模拟前端 BleTransport 的行为, 验证固件能正确理解前端发的字节.

验证几件事:
  1. led.init / led.off 握手能过 (op 名必须是 led.* 前缀)
  2. led.set 的 index 字段被认 (不是 i)
  3. 80 像素的 led.set_many 按 244 字节分片写, 设备能重组出一条完整命令
  4. 前端那套不带前缀的 op 名 (init) 固件确实不认 —— 证明 DEVICE_OPS 映射是必需的

用法: python scripts/bt_pi/pc/check_frontend_protocol.py [地址]

不带地址参数就扫描一遍找名为 pianoflow 的设备。
"""

import asyncio
import json
import sys

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

DEVICE_NAME = "pianoflow"
CHUNK = 244  # MTU 247 - 3


class Resp:
    """按行收集设备的响应."""

    def __init__(self):
        self.buf = ""
        self.lines = []

    def feed(self, data: str):
        self.buf += data
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                self.lines.append(json.loads(line))

    def take(self, cmd_id):
        for i, l in enumerate(self.lines):
            if str(l.get("id")) == str(cmd_id):
                return self.lines.pop(i)
        return None


async def find_device() -> str:
    """扫一遍找 pianoflow —— 按名字连在 Windows 上经常失败, 只能按地址连."""
    if len(sys.argv) > 1:
        return sys.argv[1]
    print(f"扫描 {DEVICE_NAME} ...")
    devices = await BleakScanner.discover(timeout=8.0, return_adv=True)
    for d, _adv in devices.values():
        if d.name == DEVICE_NAME:
            return d.address
    print(f"没扫到 {DEVICE_NAME}")
    sys.exit(1)


async def main() -> int:
    resp = Resp()
    addr = await find_device()
    async with BleakClient(addr) as client:
        print(f"已连接 {client.address}  MTU={client.mtu_size}")

        def on_notify(_, data: bytearray):
            resp.feed(data.decode("utf-8", "replace"))

        await client.start_notify(TX_UUID, on_notify)

        rx = client.services.get_service(SERVICE_UUID).get_characteristic(RX_UUID)

        async def send(cmd_id, op, args):
            """按 MTU 分片写一条命令, 跟 BleTransport.writeChunked 一致."""
            payload = (json.dumps({"id": cmd_id, "op": op, "args": args}) + "\n").encode()
            for off in range(0, len(payload), CHUNK):
                await client.write_gatt_char(rx, payload[off:off + CHUNK])
            return payload

        # 1. init —— op 名必须是 led.init
        await send("b1", "led.init", {"count": 176, "pin": 14})
        await asyncio.sleep(0.4)
        r = resp.take("b1")
        print("led.init  →", r)
        if not r or not r.get("ok"):
            print("FAIL: led.init 没被认 (op 名必须是 led.init)")
            return 1

        # 2. off
        await send("b2", "led.off", {})
        await asyncio.sleep(0.4)
        r = resp.take("b2")
        print("led.off   →", r)
        if not r or not r.get("ok"):
            print("FAIL: led.off 没被认")
            return 1

        # 3. 单个 set —— 字段是 index
        await send("b3", "led.set", {"index": 0, "r": 0, "g": 0, "b": 40})
        await asyncio.sleep(0.4)
        r = resp.take("b3")
        print("led.set   →", r)
        if not r or not r.get("ok"):
            print("FAIL: led.set 的 index 字段没被认")
            return 1

        # 4. 80 像素的 set_many —— 分片写, 设备要能重组
        pixels = [{"i": i, "r": 0, "g": 0, "b": 30} for i in range(80)]
        payload = await send("b4", "led.set_many", {"pixels": pixels})
        print(f"led.set_many → 写了 {len(payload)} 字节, {len(range(0, len(payload), CHUNK))} 片")
        await asyncio.sleep(1.0)
        r = resp.take("b4")
        print("           →", r)
        if not r or not r.get("ok"):
            print("FAIL: 分片的 set_many 没被重组成功")
            return 1
        if r.get("result", {}).get("set") != 80:
            print("FAIL: 设备只认了部分像素")
            return 1

        # 5. 用前端 op 名 (不带 led. 前缀) —— 固件应该回 unknown op
        await send("b5", "init", {"count": 176, "pin": 14})
        await asyncio.sleep(0.4)
        r = resp.take("b5")
        print("op=init   →", r)
        if r and r.get("ok"):
            print("FAIL: 固件居然认了前端 op 名, DEVICE_OPS 映射可能没必要了")
            return 1

        # 清理
        await send("b6", "led.off", {})
        await asyncio.sleep(0.3)

    print("\n全部通过 OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
