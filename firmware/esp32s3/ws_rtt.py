"""RTT 分布 —— 看是不是「双峰」(一部分被路由器缓存到下一个 beacon 才发).

用法: python ws_rtt.py [ws://host:8080] [次数]
"""
import asyncio
import json
import statistics
import sys
import time

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://192.168.1.108:8080"
N = int(sys.argv[2]) if len(sys.argv) > 2 else 50


async def main() -> None:
    async with websockets.connect(URL, max_size=None) as ws:
        nid = 0
        pending: dict[int, asyncio.Event] = {}

        async def recv_loop() -> None:
            async for raw in ws:
                try:
                    resp = json.loads(raw)
                except Exception:
                    continue
                ev = pending.pop(int(resp.get("id", -1)), None)
                if ev is not None:
                    ev.set()

        task = asyncio.create_task(recv_loop())

        async def send(op, args):
            nonlocal nid
            cid = nid
            nid += 1
            ev = asyncio.Event()
            pending[cid] = ev
            await ws.send(json.dumps({"id": cid, "op": op, "args": args}))
            await asyncio.wait_for(ev.wait(), 5.0)
            return cid

        await send("auth", {"token": ""})
        await send("init", {"count": 176, "pin": 14})
        await send("off", {})
        await asyncio.sleep(0.5)

        ts = []
        for _ in range(N):
            t0 = time.perf_counter()
            await send("ping", {})
            ts.append(1000 * (time.perf_counter() - t0))
        await asyncio.sleep(0.2)

        s = sorted(ts)
        print(f"{URL}  n={N}")
        print(
            f"  中位 {statistics.median(s):6.2f}  均值 {statistics.mean(s):6.2f}  "
            f"最小 {s[0]:6.2f}  最大 {s[-1]:6.2f}"
        )
        # 直方图, 1ms 一格 —— 双峰一眼就能看出来.
        buckets: dict[int, int] = {}
        for v in ts:
            buckets[int(v)] = buckets.get(int(v), 0) + 1
        print("  分布 (ms: 次数):")
        for k in sorted(buckets):
            print(f"    {k:4d}: {'#' * buckets[k]} ({buckets[k]})")

        await send("off", {})
        task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
