"""测「在途深度」对吞吐的影响 —— 决定 MAX_OUTSTANDING 该设几.

固件的 RX 队列只有 4 个槽, 满了**静默丢弃**. 前端的 MAX_OUTSTANDING 是
防丢的安全阀, 但设太小 (现在=2) 会让吞吐被「等回执」的往返延迟卡住.

安全边界推导:
  设备: 弹出 → 执行 → 回执. 所以「已发未回」的数量 == 设备队列里的数量 (上界).
  主机: outstanding < MAX 才发下一条.
  → outstanding ≤ 4 时, 设备队列 ≤ 4, 刚好不溢出. 5 就会开始丢.

本脚本对每个深度:
  * 连发 N 条 (不等回执, 靠 outstanding 窗口控制)
  * 统计: 收到几个响应 (丢没丢) / 总耗时 / 有效 ms/条

用法: python probe_ble_depth.py [设备地址]
"""

import asyncio
import json
import sys
import time

from bleak import BleakClient, BleakScanner

RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "pianoflow"


class Resp:
    def __init__(self):
        self.buf = ""
        self.ids = set()
        self.t0 = time.perf_counter()
        self.arrive = []

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
            cid = str(obj.get("id"))
            self.ids.add(cid)
            self.arrive.append((cid, time.perf_counter() - self.t0))


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


def cmd(cid, op, args):
    return (json.dumps({"id": cid, "op": op, "args": args}) + "\n").encode()


async def run_depth(client, resp, depth, npx=3, n=60):
    """按 depth 窗口发 n 条, 返回 (收到数, 耗时).

    ⚠️ npx 不能太大: Windows 的 write-without-response 单包上限实测 ~200 字节
       (bleak 直接报 "参数错误"), 超了整条命令根本没发出去.
       3 个像素 ≈ 150 字节, 安全. 前端跑马灯最多 7 个像素 ≈ 220 字节 ——
       前端是**自己分片**的 (chunkSize=244), 所以不受这个限制.
    """
    resp.ids.clear()
    px = [{"i": i, "r": 50, "g": 0, "b": 200} for i in range(npx)]
    sent = 0
    got = 0
    inflight = set()
    t0 = time.perf_counter()
    while sent < n or inflight:
        while len(inflight) < depth and sent < n:
            cid = f"k{depth}_{sent}"
            await client.write_gatt_char(
                RX_UUID, cmd(cid, "led.set_many", {"pixels": px}), response=False)
            inflight.add(cid)
            sent += 1
        if inflight:
            # 等一个响应 (轮询集合, 简单可靠)
            deadline = time.perf_counter() + 3.0
            while inflight and time.perf_counter() < deadline:
                done = inflight & resp.ids
                if done:
                    got += len(done)
                    inflight -= done
                    break
                await asyncio.sleep(0.002)
            else:
                break
    el = time.perf_counter() - t0
    # 再等一会儿, 收集迟到的响应 (算丢没丢)
    deadline = time.perf_counter() + 1.5
    while len([i for i in resp.ids if i.startswith(f"k{depth}_")]) < got and time.perf_counter() < deadline:
        await asyncio.sleep(0.05)
    got = len([i for i in resp.ids if i.startswith(f"k{depth}_")])
    return got, el


async def main():
    addr = await find_device()
    print(f"连 {addr}")
    resp = Resp()
    async with BleakClient(addr) as client:
        await client.start_notify(TX_UUID, lambda _c, d: resp.feed(d.decode("utf-8", "replace")))
        print(f"ATT MTU = {client.mtu_size}\n")

        print("深度 | 收到/发出 |   耗时   |  ms/条  |  条/秒 |  丢?")
        print("-" * 62)
        for depth in (1, 2, 3, 4, 5, 6, 8):
            got, el = await run_depth(client, resp, depth)
            dropped = 60 - got
            flag = f"⚠️ 丢 {dropped}" if dropped else "✓"
            print(f"  {depth:2d}  |  {got:3d}/60   | {el:6.2f}s  | {el / max(got, 1) * 1000:6.1f}  "
                  f"| {got / el:6.0f}  | {flag}")
            await asyncio.sleep(0.8)

        # 固件单条执行成本 (串行, 无并发) —— 硬件地板
        print("\n[固件执行成本] 串行 ping, 无并发")
        t0 = time.perf_counter()
        N = 30
        for i in range(N):
            await client.write_gatt_char(RX_UUID, cmd(f"p{i}", "ping", {}), response=False)
            while f"p{i}" not in resp.ids:
                await asyncio.sleep(0.002)
        el = time.perf_counter() - t0
        print(f"  ping  {N} 条 / {el * 1000:.0f} ms = {el / N * 1000:.1f} ms/条")

        resp.ids.clear()
        t0 = time.perf_counter()
        N = 30
        px = [{"i": i, "r": 50, "g": 0, "b": 200} for i in range(6)]
        for i in range(N):
            await client.write_gatt_char(RX_UUID, cmd(f"q{i}", "led.set_many", {"pixels": px}),
                                         response=False)
            while f"q{i}" not in resp.ids:
                await asyncio.sleep(0.002)
        el = time.perf_counter() - t0
        print(f"  set_many(6px, 含 show) {N} 条 / {el * 1000:.0f} ms = {el / N * 1000:.1f} ms/条"
              f"  (固件 show() ≈ 10.6ms, 物理 352 颗)")

        await client.write_gatt_char(RX_UUID, cmd("off", "led.off", {}), response=False)

    print("\n诊断结束")


if __name__ == "__main__":
    asyncio.run(main())
