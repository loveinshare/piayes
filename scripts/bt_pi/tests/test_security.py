#!/usr/bin/env python3
"""后端安全加固的回归测试 (spec P1-10 / P1-11 / §7).

覆盖:
- ws_led_bridge: Origin 白名单 / token 鉴权 / 限流 / 连接数上限
- led_remote: init 的 count/pin 白名单 + set_many 数组上限

运行: python scripts/bt_pi/tests/test_security.py
"""
import asyncio
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PI_DIR = os.path.join(os.path.dirname(HERE), "pi")
sys.path.insert(0, PI_DIR)

# 必须在 import 前设好 —— 桥在 import 时读 token
os.environ["LED_TOKEN"] = "s3cr3t-token"
os.environ["LED_REQUIRE_TOKEN"] = "1"

import ws_led_bridge as bridge  # noqa: E402
import led_remote  # noqa: E402


class TestOriginWhitelist(unittest.TestCase):
    def test_localhost_and_file_allowed(self):
        self.assertTrue(bridge.origin_allowed("http://localhost:5173"))
        self.assertTrue(bridge.origin_allowed("http://127.0.0.1:5173"))
        self.assertTrue(bridge.origin_allowed("file://"))
        self.assertTrue(bridge.origin_allowed("null"))

    def test_external_origin_rejected(self):
        self.assertFalse(bridge.origin_allowed("https://evil.example.com"))
        self.assertFalse(bridge.origin_allowed("http://192.168.1.66:5173"))

    def test_extra_allowlist(self):
        old = bridge.ALLOW_ORIGINS
        try:
            bridge.ALLOW_ORIGINS = ["https://ok.example.com"]
            self.assertTrue(bridge.origin_allowed("https://ok.example.com"))
            self.assertFalse(bridge.origin_allowed("https://other.example.com"))
        finally:
            bridge.ALLOW_ORIGINS = old

    def test_no_origin_allowed(self):
        # 非浏览器客户端 (websocat) 没有 Origin 头 —— 仍要过 token
        self.assertTrue(bridge.origin_allowed(None))
        self.assertTrue(bridge.origin_allowed(""))


class TestRateLimiter(unittest.TestCase):
    def test_burst_then_throttle(self):
        rl = bridge.RateLimiter(10, burst=5)
        for _ in range(5):
            self.assertTrue(rl.allow())
        self.assertFalse(rl.allow())

    def test_tokens_refill(self):
        rl = bridge.RateLimiter(1000, burst=1)
        self.assertTrue(rl.allow())
        self.assertFalse(rl.allow())


class TestLedRemoteValidation(unittest.TestCase):
    """init 的 count/pin 必须白名单化 (spec P1-10 §7.2(4))."""

    def make(self):
        s = led_remote.LedServer(count=176, pin=18)
        # 不真拿 strip (Pi 上才有 rpi_ws281x)
        s._init_strip = lambda count, pin: None
        return s

    def test_init_allowed_values(self):
        s = self.make()
        resp = s.handle({"op": "init", "args": {"count": 176, "pin": 18}})
        self.assertTrue(resp["ok"])

    def test_init_rejects_other_count(self):
        s = self.make()
        resp = s.handle({"op": "init", "args": {"count": 65535, "pin": 18}})
        self.assertFalse(resp["ok"])
        self.assertIn("not allowed", resp["error"])

    def test_init_rejects_other_pin(self):
        s = self.make()
        resp = s.handle({"op": "init", "args": {"count": 176, "pin": 4}})
        self.assertFalse(resp["ok"])
        self.assertIn("not allowed", resp["error"])

    def test_set_many_rejects_oversized_batch(self):
        s = self.make()
        pixels = [{"i": i, "r": 0, "g": 0, "b": 0} for i in range(led_remote.MAX_SET_MANY_PIXELS + 1)]
        resp = s.handle({"op": "set_many", "args": {"pixels": pixels}})
        self.assertFalse(resp["ok"])
        self.assertIn("too many pixels", resp["error"])

    def test_set_many_accepts_normal_batch(self):
        s = self.make()
        s.ensure_strip = lambda: None
        s._buf = [(0, 0, 0)] * 176
        pixels = [{"i": i, "r": 1, "g": 2, "b": 3} for i in range(176)]
        resp = s.handle({"op": "set_many", "args": {"pixels": pixels}})
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["set"], 176)


class TestBridgeAuth(unittest.IsolatedAsyncioTestCase):
    """端到端: 真实走 WS 握手 + 伪 TCP 上游."""

    async def asyncSetUp(self):
        # 上游 TCP 连接计数 —— 用来验证"未鉴权不占上游连接"
        self.tcp_conns = 0

        # 伪 TCP 上游: 收到行就回一个 ok
        async def handle(reader, writer):
            self.tcp_conns += 1
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode())
                except Exception:
                    continue
                resp = {"ok": True, "echo": msg.get("op")}
                if msg.get("id") is not None:
                    resp["id"] = msg["id"]
                writer.write((json.dumps(resp) + "\n").encode())
                await writer.drain()

        self.tcp = await asyncio.start_server(handle, "127.0.0.1", 0)
        self.tcp_port = self.tcp.sockets[0].getsockname()[1]
        self._old_port = bridge.TCP_PORT
        bridge.TCP_PORT = self.tcp_port

        import websockets
        self.server = await websockets.serve(bridge.handle_client, "127.0.0.1", 0)
        self.ws_port = list(self.server.sockets)[0].getsockname()[1]

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.tcp.close()
        await self.tcp.wait_closed()
        bridge.TCP_PORT = self._old_port

    async def connect(self):
        import websockets
        return await websockets.connect(f"ws://127.0.0.1:{self.ws_port}")

    async def test_unauthenticated_command_rejected(self):
        ws = await self.connect()
        try:
            await ws.send(json.dumps({"id": 1, "op": "init", "args": {}}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertFalse(resp["ok"])
            self.assertEqual(resp["error"], "auth required")
        finally:
            await ws.close()

    async def test_bad_token_rejected(self):
        ws = await self.connect()
        try:
            await ws.send(json.dumps({"id": 1, "op": "auth", "args": {"token": "wrong"}}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertFalse(resp["ok"])
            self.assertEqual(resp["error"], "bad token")
        finally:
            await ws.close()

    async def test_good_token_allows_commands(self):
        ws = await self.connect()
        try:
            await ws.send(json.dumps({"id": 1, "op": "auth", "args": {"token": "s3cr3t-token"}}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertTrue(resp["ok"])
            await ws.send(json.dumps({"id": 2, "op": "ping", "args": {}}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertTrue(resp["ok"])
            self.assertEqual(resp.get("echo"), "ping")
        finally:
            await ws.close()

    async def test_token_in_top_level_field(self):
        ws = await self.connect()
        try:
            await ws.send(json.dumps({"id": 1, "op": "auth", "token": "s3cr3t-token"}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertTrue(resp["ok"])
        finally:
            await ws.close()

    async def test_unauth_does_not_open_upstream(self):
        """未鉴权的客户端不该占住 LED server 的 TCP 连接.

        否则 4 个不鉴权的假连接 (MAX_CLIENTS 默认 4) 就能把真正的前端挤掉 (DoS).
        """
        before = self.tcp_conns
        ws = await self.connect()
        try:
            await ws.send(json.dumps({"id": 1, "op": "init", "args": {}}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertFalse(resp["ok"])
            self.assertEqual(resp["error"], "auth required")
        finally:
            await ws.close()
        await asyncio.sleep(0.05)
        self.assertEqual(self.tcp_conns, before)

    async def test_authenticated_opens_upstream(self):
        """鉴权通过之后才开上游连接."""
        before = self.tcp_conns
        ws = await self.connect()
        try:
            await ws.send(json.dumps({"id": 1, "op": "auth", "args": {"token": "s3cr3t-token"}}))
            resp = json.loads(await asyncio.wait_for(ws.recv(), 3))
            self.assertTrue(resp["ok"])
            await asyncio.sleep(0.05)
            self.assertEqual(self.tcp_conns, before + 1)
        finally:
            await ws.close()

    async def test_auth_timeout_closes_connection(self):
        """连上但不发 auth 的客户端不能一直占着连接名额."""
        old = bridge.AUTH_TIMEOUT_S
        bridge.AUTH_TIMEOUT_S = 0.2
        try:
            ws = await self.connect()
            try:
                with self.assertRaises(Exception):
                    await asyncio.wait_for(ws.recv(), 3)
            finally:
                await ws.close()
        finally:
            bridge.AUTH_TIMEOUT_S = old


if __name__ == "__main__":
    unittest.main(verbosity=2)
