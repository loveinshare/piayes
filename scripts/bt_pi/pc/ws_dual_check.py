#!/usr/bin/env python3
"""按**前端的路径**验证双色带链路: WS 桥 → led_remote → 物理帧.

前端 BackendTransport 的 WS 握手顺序是 auth → init(count) → off, 之后
set_many / show. 这个脚本照抄这个顺序, 走 ws://<host>:8080.

看两件事:
  1. init count=352 有没有被拒 (白名单 176/352)
  2. show 的回包 flushed 是不是 352 —— 帧比物理链短的话, 第二条带会整条刷白

用法: python scripts/bt_pi/pc/ws_dual_check.py [count]
"""
import asyncio
import json
import sys

sys.stdout.reconfigure(encoding="utf-8")

import paramiko
import websockets

HOST = "192.168.1.113"
WS_PORT = 8080
USER = "loveinshare"
PASSWORD = "<脱敏>"


def get_token():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASSWORD, timeout=15)
    si, so, se = ssh.exec_command("cat /opt/bt-gpio/led_token 2>/dev/null", timeout=15)
    tok = so.read().decode(errors="replace").strip()
    ssh.close()
    return tok


async def main(count: int):
    token = get_token()
    print(f"token: {'有' if token else '无 (桥放行)'}")

    url = f"ws://{HOST}:{WS_PORT}"
    async with websockets.connect(url, open_timeout=10) as ws:
        async def rpc(op, args=None, mid="1"):
            msg = {"id": mid, "op": op, "args": args or {}}
            await ws.send(json.dumps(msg))
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            resp = json.loads(raw)
            print(f"  {op:9s} -> {raw}")
            return resp

        await rpc("auth", {"token": token}, "a")
        resp = await rpc("init", {"count": count, "pin": 18}, "i")
        # 上带放两颗 (chain 176 / 264), 下带放一颗 (chain 78) —— 位置好核对
        await rpc("set_many", {"pixels": [
            {"i": 78, "r": 255, "g": 0, "b": 0},
            {"i": 176, "r": 0, "g": 0, "b": 255},
            {"i": 264, "r": 255, "g": 0, "b": 255},
        ]}, "m")
        await rpc("show", {}, "sh")
        print()
        # 注意: show 的 "flushed" 数的是「距上次 show 以来 set 了几次」,
        # **不是帧长** —— 帧长是服务端按物理链 (352) 发的, 由
        # scripts/bt_pi/tests/test_led_reliability.py 的 LedPhysicalFrameTest 钉住.
        if resp.get("ok") and resp.get("physical") == 352:
            print("✅ init count=352 通过, 服务端物理帧长 = 352")
            print("   → 上面的 set_many 只点了 3 颗, 目视应该**只有 3 颗**亮;")
            print("     第二条带整条刷白 = 帧长还是不够 (旧 bug)")
        else:
            print(f"⚠️  init 回包不对: {resp}")
        await rpc("off", {}, "of")


if __name__ == "__main__":
    c = int(sys.argv[1]) if len(sys.argv) > 1 else 352
    asyncio.run(main(c))
