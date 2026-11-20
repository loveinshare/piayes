"""★ 真机实测前端的跑马灯 —— 完整模拟前端的传输层行为.

要模拟准三件事 (前端 src/led/transport/BleTransport.ts):

  1. **分片写**: 一条命令超过 ATT 载荷 (MTU-3 = 244 字节) 就切成多片.
     ⚠️ Windows 的 write-without-response 单包上限就是 244 字节 ——
        5 像素 (241 字节) 通过, 6 像素 (276 字节) 直接报 "参数错误".
        前端的 writeChunked() 已经处理了这个, 这里是照抄.

  2. **在途上限** (MAX_OUTSTANDING): 同时最多 N 条已发未回.

  3. **不等回执**: set/set_many 是 fire-and-forget.

跑完打印: 总时长 / ms/条 / 对比旧实现.

用法: python probe_ble_marquee.py [设备地址]
"""

import asyncio
import json
import sys
import time

from bleak import BleakClient, BleakScanner

RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "pianoflow"

# 前端 BleTransport.MAX_OUTSTANDING (2026-10-26 从 2 改成 6)
MAX_OUTSTANDING = 6
TOTAL = 176
WINDOW = 6


class Resp:
    def __init__(self):
        self.buf = ""
        self.ids = set()

    def feed(self, data: str):
        self.buf += data
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            self.ids.add(str(obj.get("id")))


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


def build_frames():
    """照抄前端 LedController.testPattern() 的帧序列."""
    frames = []
    for pos in range(TOTAL):
        px = []
        if pos >= WINDOW:
            px.append({"i": pos - WINDOW, "r": 0, "g": 0, "b": 0})
        for k in range(WINDOW):
            i = pos - k
            if 0 <= i < TOTAL:
                px.append({"i": i, "r": 50, "g": 0, "b": 200})
        frames.append(("led.set_many", {"pixels": px}))
    # 尾清
    frames.append(("led.set_many",
                   {"pixels": [{"i": k, "r": 0, "g": 0, "b": 0}
                               for k in range(TOTAL - WINDOW, TOTAL)]}))
    # 最后一条 off
    frames.append(("led.off", {}))
    return frames


async def main():
    addr = await find_device()
    print(f"连 {addr}")
    resp = Resp()
    async with BleakClient(addr) as client:
        await client.start_notify(TX_UUID, lambda _c, d: resp.feed(d.decode("utf-8", "replace")))
        chunk_max = client.mtu_size - 3
        print(f"ATT MTU = {client.mtu_size} (载荷 {chunk_max} 字节), "
              f"在途上限 = {MAX_OUTSTANDING}\n")

        frames = build_frames()
        payload_max = max(
            len((json.dumps({"id": "f0", "op": op, "args": args}) + "\n").encode())
            for op, args in frames)
        print(f"共 {len(frames)} 条命令, 最长 {payload_max} 字节 "
              f"(要 {payload_max // chunk_max + 1} 片)\n")

        resp.ids.clear()
        sent = 0
        inflight = set()
        t0 = time.perf_counter()
        while sent < len(frames) or inflight:
            # --- 发 (照抄 writeChunked: 超长就切片) ---
            while len(inflight) < MAX_OUTSTANDING and sent < len(frames):
                op, args = frames[sent]
                cid = f"f{sent}"
                payload = (json.dumps({"id": cid, "op": op, "args": args}) + "\n").encode()
                for off in range(0, len(payload), chunk_max):
                    part = payload[off:off + chunk_max]
                    await client.write_gatt_char(RX_UUID, part, response=False)
                inflight.add(cid)
                sent += 1
            # --- 等回执 ---
            if inflight:
                deadline = time.perf_counter() + 3.0
                while inflight and time.perf_counter() < deadline:
                    done = inflight & resp.ids
                    if done:
                        inflight -= done
                        break
                    await asyncio.sleep(0.001)
                else:
                    print(f"⚠️ 超时, 还有 {len(inflight)} 条没回")
                    break
        elapsed = time.perf_counter() - t0

        # 等迟到的响应
        deadline = time.perf_counter() + 2.0
        while len([i for i in resp.ids if i.startswith("f")]) < len(frames) and time.perf_counter() < deadline:
            await asyncio.sleep(0.05)
        got = len([i for i in resp.ids if i.startswith("f")])

        print(f"★ 跑马灯: {got}/{len(frames)} 条")
        print(f"  总耗时 {elapsed:.2f} s = {elapsed / len(frames) * 1000:.1f} ms/条")
        print()
        print("  对比:")
        print("    旧实现 (深度2 + 逐帧await + 每帧2条命令): 11.2 s  ← 用户报的「十多秒」")
        print(f"    硬件地板 (44 帧 × 10.6ms bit-bang):      0.46 s   ← 物理 352 颗/帧")
        print(f"    ★ 现在:                                  {elapsed:.2f} s")

        await client.write_gatt_char(
            RX_UUID, (json.dumps({"id": "off", "op": "led.off", "args": {}}) + "\n").encode(),
            response=False)

    print("\n诊断结束")


if __name__ == "__main__":
    asyncio.run(main())
