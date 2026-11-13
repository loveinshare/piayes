"""帧率基准 —— 照抄前端一帧真正发的东西, 看 WS 这条链路能跑多快.

前端 LedController 每帧 (双色带 352 颗):
    set_many × 5 (每块最多 80 颗) + show × 1
等 show 的回执 = 这一帧推完了.

量三件事:
    每帧墙钟时间 (均值 / 中位数 / p95 / 最大)
    每帧的字节数 (上行)
    算出来的最大帧率

灯用的是**很暗**的颜色 (v=3) —— 只是为了量网络, 不是给人看的.
最后一定发 off.

用法: python ws_frame_bench.py [url] [帧数]
"""
import asyncio
import json
import statistics
import sys
import time

import websockets

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://192.168.1.108:8080"
FRAMES = int(sys.argv[2]) if len(sys.argv) > 2 else 60

CHUNK = 80
PIXELS = 352
VALUE = 3  # 很暗 —— 只为量网络


async def main() -> None:
    async with websockets.connect(URL, max_size=None) as ws:
        nid = 0
        pending: dict[int, asyncio.Event] = {}
        raw_by_id: dict[int, str] = {}

        async def recv_loop() -> None:
            async for raw in ws:
                try:
                    cid = int(json.loads(raw).get("id", -1))
                except Exception:
                    continue
                raw_by_id[cid] = raw
                ev = pending.pop(cid, None)
                if ev is not None:
                    ev.set()

        task = asyncio.create_task(recv_loop())

        async def rpc(op: str, args: dict) -> str:
            nonlocal nid
            cid = nid
            nid += 1
            ev = asyncio.Event()
            pending[cid] = ev
            await ws.send(json.dumps({"id": cid, "op": op, "args": args}))
            await asyncio.wait_for(ev.wait(), 5.0)
            return raw_by_id.get(cid, "")

        async def fire(op: str, args: dict) -> None:
            """发出去**不等回执** —— 前端 set_many 就是这么发的
            (WsTransport.send 默认 expectReply=false)."""
            nonlocal nid
            cid = nid
            nid += 1
            await ws.send(json.dumps({"id": cid, "op": op, "args": args}))

        await rpc("init", {"count": PIXELS, "pin": 18})
        await rpc("off", {})

        # 一帧的负载: 5 块 × 80 颗 (最后一块 32 颗)
        chunks = []
        left = PIXELS
        while left > 0:
            n = min(CHUNK, left)
            chunks.append([{"i": i, "r": VALUE, "g": 0, "b": 0} for i in range(n)])
            left -= n

        bytes_per_frame = sum(len(json.dumps({"id": 0, "op": "set_many", "args": {"pixels": c}})) for c in chunks)
        bytes_per_frame += len(json.dumps({"id": 0, "op": "show", "args": {}}))

        times: list[float] = []
        for f in range(FRAMES):
            t0 = time.perf_counter()
            # ★ 照前端的样子: set_many 连发不等回执, 只等 show 的回执.
            for c in chunks:
                await fire("set_many", {"pixels": c})
            await rpc("show", {})
            times.append((time.perf_counter() - t0) * 1000)

        await rpc("off", {})
        task.cancel()

    times.sort()
    avg = statistics.mean(times)
    med = statistics.median(times)
    p95 = times[min(len(times) - 1, int(len(times) * 0.95))]
    worst = times[-1]
    print(f"URL {URL}")
    print(f"帧数 {len(times)}  每帧 {len(chunks)}×set_many + 1×show  ≈ {bytes_per_frame} 字节上行")
    print(f"每帧耗时: 均值 {avg:.1f} ms  中位 {med:.1f} ms  p95 {p95:.1f} ms  最大 {worst:.1f} ms")
    print(f"折算帧率: 均值 {1000/avg:.1f} fps  最好 {1000/med:.1f} fps  最差 {1000/worst:.1f} fps")


if __name__ == "__main__":
    asyncio.run(main())
