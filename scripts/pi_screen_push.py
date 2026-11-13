#!/usr/bin/env python3
"""把一帧 RGB888 推给树莓派的点阵屏服务, 顺便量一下丢帧情况.

用法: python3 pi_screen_push.py <rgb文件> [帧数] [fps]

跑在树莓派上 (连 127.0.0.1:8081), 或者任何能访问树莓派的地方.
"""
import asyncio
import json
import sys
import time

from websockets.asyncio.client import connect

HOST = "127.0.0.1"
PORT = 8081


async def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/screen3.rgb"
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 90
    fps = float(sys.argv[3]) if len(sys.argv) > 3 else 30.0
    width, height = 128, 64
    frame = open(path, "rb").read()
    assert len(frame) == width * height * 3, "帧长不对: %d" % len(frame)

    async with connect("ws://%s:%d" % (HOST, PORT)) as ws:
        await ws.send(json.dumps({
            "id": 1, "op": "matrix.init",
            "args": {"width": width, "height": height, "screens": [3]},
        }))
        print("init:", await ws.recv())

        t0 = time.time()
        for _ in range(n):
            await ws.send(frame)
            await asyncio.sleep(1.0 / fps)
        dt = time.time() - t0

        await ws.send(json.dumps({"id": 2, "op": "status"}))
        print("status:", await ws.recv())
        print("推了 %d 帧, 用了 %.2fs (%.1f fps)" % (n, dt, n / dt))


if __name__ == "__main__":
    asyncio.run(main())
