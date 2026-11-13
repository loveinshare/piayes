"""负载曲线 —— 看延迟是「每条命令的固定成本」还是「随 payload 变大」.

1) 连发 N 条 ping (不等回执) → 看回执**之间**的间隔.
   间隔小 (比如 1ms) → 设备处理很快, 慢的是每条命令的网络往返 (RTT).
   间隔大 (比如 8ms) → 设备每条命令都要花 8ms, 是设备侧的锅.
2) set_many 送不同数量的像素 → 看是不是每多一个 TCP 分段就多一个台阶.

最后一定发 off.
"""
import asyncio
import json
import statistics
import sys
import time

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://192.168.1.108:8080"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 20


async def main() -> None:
    async with websockets.connect(URL, max_size=None) as ws:
        nid = 0
        pending: dict[int, asyncio.Event] = {}
        arrivals: list[tuple[int, float]] = []

        async def recv_loop() -> None:
            async for raw in ws:
                try:
                    resp = json.loads(raw)
                except Exception:
                    continue
                cid = int(resp.get("id", -1))
                ev = pending.pop(cid, None)
                if ev is not None:
                    arrivals.append((cid, time.perf_counter()))
                    ev.set()

        task = asyncio.create_task(recv_loop())

        async def send(op, args, wait=False):
            nonlocal nid
            cid = nid
            nid += 1
            ev = asyncio.Event()
            pending[cid] = ev
            await ws.send(json.dumps({"id": cid, "op": op, "args": args}))
            if wait:
                await asyncio.wait_for(ev.wait(), 5.0)
            return ev

        await send("auth", {"token": ""}, wait=True)
        await send("init", {"count": 176, "pin": 14}, wait=True)
        await send("off", {}, wait=True)
        await asyncio.sleep(0.3)

        # --- 1) 连发 N 条 ping, 看回执间隔 ---
        print(f"--- 连发 {N} 条 ping (不等回执) ---")
        arrivals.clear()
        t0 = time.perf_counter()
        for _ in range(N):
            await send("ping", {})
        deadline = time.perf_counter() + 10
        while len(arrivals) < N and time.perf_counter() < deadline:
            await asyncio.sleep(0.002)
        arrivals.sort(key=lambda a: a[1])
        if len(arrivals) >= 2:
            gaps = [1000 * (arrivals[i + 1][1] - arrivals[i][1]) for i in range(len(arrivals) - 1)]
            print(
                f"回执间隔: 中位 {statistics.median(gaps):.2f} ms  最小 {min(gaps):.2f}  "
                f"最大 {max(gaps):.2f}"
            )
            print(f"全部收齐耗时 {1000 * (arrivals[-1][1] - t0):.1f} ms")
        else:
            print("回执太少")

        # --- 2) payload 曲线 ---
        print("--- set_many 像素数 vs 延迟 ---")
        prev = None
        for count in (1, 20, 55, 56, 80, 120, 160, 320):
            px = [{"i": i, "r": 0, "g": 0, "b": 0} for i in range(count)]
            ts = []
            for _ in range(8):
                t = time.perf_counter()
                await send("set_many", {"pixels": px}, wait=True)
                ts.append(1000 * (time.perf_counter() - t))
            ts.sort()
            med = statistics.median(ts)
            delta = "" if prev is None else f"  (+{med - prev:.1f})"
            print(f"  {count:4d} 颗  中位 {med:7.2f} ms{delta}")
            prev = med

        await send("off", {}, wait=True)
        print("已关灯")
        task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
