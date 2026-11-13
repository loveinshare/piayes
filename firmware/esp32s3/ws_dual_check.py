"""按**前端的路径**验证双色带链路 (ESP32 版): WS → 设备 → 物理帧.

照抄 scripts/bt_pi/pc/ws_dual_check.py 的顺序 (那个是树莓派版的):
    auth → init(count) → off, 之后 set_many / show

多一步: 用设备自己的 getpix op **回读**缓冲 —— 没人盯着灯带, 也能确认
「写进去的像素 == 设备缓冲里的像素」, 以及上灯带那一截 (176..351) 也在链上.

用法: python ws_dual_check.py [host] [count]
"""
import asyncio
import json
import sys

import websockets

HOST = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.108"
COUNT = int(sys.argv[2]) if len(sys.argv) > 2 else 352
URL = f"ws://{HOST}:8080"


async def main() -> None:
    async with websockets.connect(URL, open_timeout=10) as ws:
        async def rpc(op, args=None, mid="1"):
            await ws.send(json.dumps({"id": mid, "op": op, "args": args or {}}))
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            print(f"  {op:9s} -> {raw}")
            return json.loads(raw)

        init_resp = await rpc("init", {"count": COUNT, "pin": 14}, "i")
        # 上带放两颗 (chain 176 / 264), 下带放一颗 (chain 78) —— 位置好核对.
        # 只点 3 颗 —— 灯带亮度调高时 3 颗就够看了.
        await rpc("set_many", {"pixels": [
            {"i": 78, "r": 255, "g": 0, "b": 0},
            {"i": 176, "r": 0, "g": 0, "b": 255},
            {"i": 264, "r": 255, "g": 0, "b": 255},
        ]}, "m")
        resp = await rpc("show", {}, "sh")
        del resp

        print()
        ok = True
        for idx, want in ((78, (255, 0, 0)), (176, (0, 0, 255)), (264, (255, 0, 255))):
            px = await rpc("getpix", {"index": idx}, f"g{idx}")
            got = (px.get("r", -1), px.get("g", -1), px.get("b", -1))
            mark = "✅" if got == want else "❌"
            if got != want:
                ok = False
            print(f"  {mark} 缓冲回读 [{idx}] = {got} (期望 {want})")

        if init_resp.get("ok") and init_resp.get("physical") == 352:
            print("✅ init count=352 通过, 服务端物理帧长 = 352")
        else:
            ok = False
            print(f"⚠️  init 回包不对: {resp}")

        await rpc("off", {}, "of")
        print("\n" + ("✅ 全过" if ok else "⚠️  有问题"))


if __name__ == "__main__":
    asyncio.run(main())
