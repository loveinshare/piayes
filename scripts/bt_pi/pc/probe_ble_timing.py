"""量一下 ESP32 各种 op 的真实耗时 —— 定位「跑马灯走了十多秒」.

对每个 op 连发 N 条, 从写第一条到收到第 N 条响应, 测墙钟时间.
延迟主要来自三处:
  1. 固件 bit-bang show() —— 物理 352 颗 = 10.6ms (硬件极限)
  2. 固件 bleSend() 的 delay(5)/20字节 分片 —— 每条响应 10~15ms
  3. 固件 Serial.println() —— USB 阻塞写
"""

import asyncio
import json
import sys
import time

from bleak import BleakClient, BleakScanner

SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "pianoflow"


class Resp:
    def __init__(self):
        self.buf = ""
        self.lines = []

    def feed(self, data: str):
        self.buf += data
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                try:
                    self.lines.append(json.loads(line))
                except Exception:
                    pass

    async def wait_for(self, cmd_id, timeout=20.0):
        t0 = time.perf_counter()
        while time.perf_counter() - t0 < timeout:
            for i, l in enumerate(self.lines):
                if str(l.get("id")) == str(cmd_id):
                    self.lines.pop(i)
                    return time.perf_counter() - t0
            await asyncio.sleep(0.002)
        raise TimeoutError(f"没等到 {cmd_id} 的响应")


async def find_device():
    if len(sys.argv) > 1:
        return sys.argv[1]
    print(f"扫描 {DEVICE_NAME} ...")
    devices = await BleakScanner.discover(timeout=8.0, return_adv=True)
    for d, _adv in devices.values():
        if d.name == DEVICE_NAME:
            return d.address
    print(f"没扫到 {DEVICE_NAME}")
    sys.exit(1)


async def main():
    addr = await find_device()
    print(f"连 {addr}")
    resp = Resp()
    async with BleakClient(addr) as client:
        await client.start_notify(TX_UUID, lambda _c, data: resp.feed(data.decode("utf-8", "replace")))

        async def probe(op, args, n=20, label=None):
            times = []
            t0 = time.perf_counter()
            for i in range(n):
                cid = f"p{i}"
                payload = json.dumps({"id": cid, "op": op, "args": args}) + "\n"
                await client.write_gatt_char(RX_UUID, payload.encode())
                await resp.wait_for(cid)
                times.append(time.perf_counter() - t0)
                t0 = time.perf_counter()
            total = sum(times) / len(times) * 1000
            print(f"  {label or op:28s} 平均 {total:7.2f} ms/条  (n={n})")
            return total

        print("\n=== 单条 op 的耗时 ===")
        await probe("led.init", {"count": 176, "pin": 14}, n=5, label="led.init (无 show)")
        await probe("led.show", {}, n=20, label="led.show (只有 show)")
        await probe("led.set", {"index": 5, "r": 10, "g": 20, "b": 30}, n=20,
                    label="led.set (含 show)")
        px = [{"i": i, "r": 1, "g": 2, "b": 3} for i in range(7)]
        await probe("led.set_many", {"pixels": px}, n=20, label="led.set_many (7px, 含 show)")
        await probe("ping", {}, n=20, label="ping (纯回包, 无 show)")
        await probe("status", {}, n=20, label="status (纯回包)")

        print("\n=== 一次跑马灯 (旧实现: 每帧 set_many + show, 逐条等回执) ===")
        print("    ⚠️ 这是**旧实现**的形态 —— 新实现是每帧 1 条命令 + 在途深度 6,")
        print("       见 probe_ble_marquee.py (实测 1.66 秒).")
        t0 = time.perf_counter()
        for i in range(176):
            for op, args in (
                ("led.set_many", {"pixels": [{"i": i, "r": 200, "g": 0, "b": 0}]}),
                ("led.show", {}),
            ):
                cid = f"c{i}{op[-1]}"
                payload = json.dumps({"id": cid, "op": op, "args": args}) + "\n"
                await client.write_gatt_char(RX_UUID, payload.encode())
                await resp.wait_for(cid)
        el = time.perf_counter() - t0
        print(f"  352 条命令耗时 {el:.2f} s  ({el/352*1000:.1f} ms/条)")
        print(f"  → 这就是用户报的「走了十多秒」")

        await client.write_gatt_char(RX_UUID, (json.dumps({"id": "off", "op": "led.off", "args": {}}) + "\n").encode())
        await resp.wait_for("off")

    print("\n探测结束")


if __name__ == "__main__":
    asyncio.run(main())
