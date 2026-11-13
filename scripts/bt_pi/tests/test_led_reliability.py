#!/usr/bin/env python3
"""灯带链路可靠性回归测试 (2026-10-28).

钉住用户报的「前端显示 rpc init timeout」的三条根因:

1. **led_remote 踢人时销毁在途回包** —— 以前新 client 来了就把旧 socket
   `shutdown(SHUT_RDWR)` + `close()`, 旧 client 手里那条命令的回包一起没了,
   前端等不到回包 → 「rpc init timeout」.
   现在只 `shutdown(SHUT_RD)`: 旧 client 的回包照发, 但它自己会退出.

2. **ws_led_bridge 漏关上游 TCP** —— 上游先断时 `ws_to_tcp` 被 cancel,
   写在它里面的 `writer.close()` 走不到 → 桥攒僵尸连接, 占着 led_remote 的
   单 client 名额. 现在 `writer.close()` 放在 finally 里, 一定会执行.

3. **led_remote accept() 出错就静静退出 (返回码 0)** —— systemd 的
   `Restart=on-failure` 不会拉起它 → 灯带服务就此死掉, 前端只看到一句超时.
   现在返回 1, 让 systemd 重新拉起.

运行: python scripts/bt_pi/tests/test_led_reliability.py
"""
import asyncio
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pi"))

import led_remote  # noqa: E402
import ws_led_bridge  # noqa: E402


# ---------------------------------------------------------------------------
# 1. led_remote: 踢人不能销毁在途回包
# ---------------------------------------------------------------------------
class LedRemoteKickTest(unittest.TestCase):
    def setUp(self):
        self.server = led_remote.LedServer(count=8, pin=18)
        self.accepted = []
        self.stop = threading.Event()

    def _start_server(self):
        """起一个真的 listening socket, 每个连接一个线程跑 _serve_client."""
        lsock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        lsock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        lsock.bind(("127.0.0.1", 0))
        lsock.listen(8)
        port = lsock.getsockname()[1]

        def accept_loop():
            lsock.settimeout(0.2)
            while not self.stop.is_set():
                try:
                    conn, addr = lsock.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                self.accepted.append(conn)
                t = threading.Thread(target=led_remote._serve_client,
                                     args=(conn, addr, self.server), daemon=True)
                t.start()

        threading.Thread(target=accept_loop, daemon=True).start()
        return lsock, port

    def _wait_for(self, pred, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if pred():
                return True
            time.sleep(0.02)
        return False

    def test_kick_keeps_inflight_reply(self):
        lsock, port = self._start_server()
        gate = threading.Event()
        orig_handle = self.server.handle

        def slow_handle(msg):
            # 卡住 —— 模拟「命令正在处理中」, 这时新 client 连进来踢人
            gate.wait(5)
            return orig_handle(msg)

        self.server.handle = slow_handle
        try:
            a = socket.create_connection(("127.0.0.1", port), timeout=5)
            a.sendall(b'{"id":"a1","op":"ping"}\n')
            # 等 A 真的进了 handle (卡在 gate 上)
            self.assertTrue(self._wait_for(lambda: gate.is_set() is False and self.accepted),
                            "A 没连上")
            time.sleep(0.3)

            # B 连进来 → 触发踢人
            b = socket.create_connection(("127.0.0.1", port), timeout=5)
            self.assertTrue(self._wait_for(lambda: len(self.accepted) >= 2), "B 没连上")
            # 等踢人真的发生 (active_client 换成 B 的 socket 了)
            self.assertTrue(
                self._wait_for(lambda: self.server._active_client is self.accepted[1]),
                "踢人没发生")

            # 放行 A 的命令
            gate.set()

            # ★ A 的在途回包必须还能收到 —— 这就是「rpc init timeout」的根因
            a.settimeout(5)
            data = a.recv(4096)
            self.assertTrue(data, "A 的在途回包被踢人销毁了 (前端看到的就是 rpc init timeout)")
            resp = json.loads(data.decode("utf-8").strip())
            self.assertTrue(resp["ok"])
            self.assertEqual(resp["id"], "a1")

            # 旧 client 确实被踢走了 —— 服务端随后关掉连接, A 读到 EOF
            rest = a.recv(4096)
            self.assertEqual(rest, b"", "旧 client 没被踢掉")

            b.close()
            a.close()
        finally:
            gate.set()
            self.stop.set()
            lsock.close()


# ---------------------------------------------------------------------------
# 2. led_remote: accept() 出错不能静静退出
# ---------------------------------------------------------------------------
class _FakeListenSocket:
    """bind/listen 都成功, accept() 抛 OSError —— 模拟内核层面的 accept 失败.

    main() 现在用 select() 等连接, 所以这个假 socket 还得有 fileno(),
    并且要**可读** —— 否则 select 会一直超时, 走不到 accept()。
    """

    def __init__(self, *args, **kwargs):
        self.closed = False
        # socketpair 必须在 patch socket.socket **之前** 建好 ——
        # socketpair 的 fallback 实现自己也会调 socket.socket.
        self._pair = kwargs.pop("_pair", None) or socket.socketpair()
        self._pair[1].sendall(b"x")   # 让 select 立刻返回「有连接」

    def setsockopt(self, *args):
        pass

    def bind(self, *args):
        pass

    def listen(self, *args):
        pass

    def fileno(self):
        return self._pair[0].fileno()

    def accept(self):
        raise OSError("simulated accept failure")

    def close(self):
        self.closed = True
        for s in self._pair:
            try:
                s.close()
            except OSError:
                pass


class LedRemoteAcceptTest(unittest.TestCase):
    def test_accept_error_exits_nonzero(self):
        """accept() 出错 → 返回 1 → systemd (Restart=on-failure) 会重新拉起.

        返回 0 的话进程是「正常退出」, systemd 不会重启 —— 灯带服务就此静默死掉.
        """
        argv = ["led_remote.py", "--port", "0", "--count", "8", "--pin", "18"]
        pair = socket.socketpair()          # 先建好, 再 patch socket.socket
        with mock.patch.object(sys, "argv", argv), \
                mock.patch("socket.socket",
                           lambda *a, **k: _FakeListenSocket(_pair=pair)):
            rc = led_remote.main()
        for s in pair:
            s.close()
        self.assertEqual(rc, 1, "accept() 出错必须返回非 0, 否则 systemd 不会重启")


# ---------------------------------------------------------------------------
# 3. ws_led_bridge: 上游 TCP 必须被关掉
# ---------------------------------------------------------------------------
class _BlockingWs:
    """一个「连着但什么都不发」的 WS 客户端 (async 迭代永远不结束)."""

    request_headers = {}
    remote_address = ("127.0.0.1", 55555)

    def __init__(self):
        self.sent = []
        self.closed = False

    async def recv(self):
        return ""

    async def send(self, data):
        self.sent.append(data)

    async def close(self, code=1000, reason=""):
        self.closed = True

    def __aiter__(self):
        async def gen():
            await asyncio.Event().wait()   # 永远挂着
            yield ""                       # 让它是个 async generator
        return gen()


class WsBridgeTest(unittest.IsolatedAsyncioTestCase):
    async def test_upstream_tcp_closed_when_upstream_dies_first(self):
        async def upstream(reader, writer):
            # 模拟「上游先断」: 连上就关
            writer.close()

        srv = await asyncio.start_server(upstream, "127.0.0.1", 0)
        port = srv.sockets[0].getsockname()[1]

        captured = []
        real_open = asyncio.open_connection

        async def fake_open(host, p):
            reader, writer = await real_open(host, p)
            captured.append(writer)
            return reader, writer

        ws = _BlockingWs()
        try:
            with mock.patch.object(ws_led_bridge, "TOKEN", None), \
                    mock.patch.object(ws_led_bridge, "TCP_PORT", port), \
                    mock.patch("asyncio.open_connection", fake_open):
                await asyncio.wait_for(ws_led_bridge.handle_client(ws), timeout=5)

            self.assertEqual(len(captured), 1, "桥没连上游")
            self.assertTrue(captured[0].is_closing(),
                            "上游 TCP 没被关掉 —— 桥会攒僵尸连接, 占着 led_remote 的名额")
        finally:
            srv.close()
            await srv.wait_closed()


# ---------------------------------------------------------------------------
# 4. 双色带模式: init 的 count 白名单 + 换灯数时安全重建 strip
# ---------------------------------------------------------------------------
class LedInitCountWhitelistTest(unittest.TestCase):
    """双色带 = 两条灯带串联 352 颗 → count=352 必须放行; 别的一律拒."""

    def setUp(self):
        # 建 strip 要真硬件 —— 这里只测白名单, 把建 strip 的动作 mock 掉
        self.server = led_remote.LedServer(count=176, pin=18)
        self.init_calls = []
        patcher = mock.patch.object(
            led_remote.LedServer, "_init_strip",
            side_effect=lambda count, pin: self.init_calls.append((count, pin)))
        self.addCleanup(patcher.stop)
        patcher.start()

    def _init(self, count, pin=18):
        return self.server.handle({"op": "init", "args": {"count": count, "pin": pin}})

    def test_count_176_ok(self):
        resp = self._init(176)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["count"], 176)

    def test_count_352_ok(self):
        """双色带 —— 两条带串联 352 颗."""
        resp = self._init(352)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["count"], 352)
        self.assertEqual(self.init_calls, [(352, 18)])

    def test_count_999_rejected(self):
        resp = self._init(999)
        self.assertFalse(resp["ok"])
        self.assertIn("not allowed", resp["error"])
        self.assertIn("999", resp["error"])
        self.assertEqual(self.init_calls, [], "被拒的 count 不该真的去建 strip")


class _FakeStrip:
    """假 rpi_ws281x.PixelStrip —— 只记录被调了啥."""

    instances = []

    def __init__(self, num, pin, freq, dma, invert, brightness, strip_type, channel=0):
        self.num = num
        self.pin = pin
        self.pixels = {}
        self.show_count = 0
        self.cleanup_count = 0
        self.begun = False
        _FakeStrip.instances.append(self)

    def begin(self):
        self.begun = True

    def setPixelColor(self, i, color):
        self.pixels[i] = color

    def show(self):
        self.show_count += 1

    def _cleanup(self):
        self.cleanup_count += 1


class LedPhysicalFrameTest(unittest.TestCase):
    """物理帧长 = 物理链长度, 跟客户端 init 的 count 无关 (2026-10-30).

    WS2812 是**串联**的 —— 帧比物理链短的话, 后面的那条带收不到自己的数据,
    移位寄存器被空闲高电平填满 → **整条带全白** (176 颗全白 ≈ 10 A!).

    用户 2026-10-30 插上第二条带就是这个现象: 服务端 count=176 发帧,
    第二条带 (chain 176..351) 整条刷白.

    所以:
      - 物理 strip 永远按 physical_count (352) 建, **换 count 不重建**
        (顺带根治了「重建撞 DMA 通道 10」的老问题);
      - 客户端 init 的 count 只是「逻辑可寻址长度」(能写哪几颗);
      - off / show 都按物理链长度走 (不留幽灵灯).
    """

    def setUp(self):
        _FakeStrip.instances = []
        fake_mod = mock.MagicMock()
        fake_mod.PixelStrip = _FakeStrip
        patcher = mock.patch.dict(sys.modules, {"rpi_ws281x": fake_mod})
        self.addCleanup(patcher.stop)
        patcher.start()
        self.server = led_remote.LedServer(count=176, pin=18, physical_count=352)

    def test_strip_length_is_physical_not_logical(self):
        """逻辑 count=176 时, 物理 strip 也必须是 352 —— 否则第二条带全白."""
        self.server._init_strip(176, 18)
        self.assertEqual(len(_FakeStrip.instances), 1)
        self.assertEqual(_FakeStrip.instances[0].num, 352)

    def test_count_change_does_not_rebuild_strip(self):
        """换 count 不重建 —— 重建会撞 DMA 通道 10, 而且会扔掉在途像素状态."""
        self.server._init_strip(176, 18)
        self.server._init_strip(352, 18)
        self.assertEqual(len(_FakeStrip.instances), 1,
                         "换 count 不该重建物理 strip")
        self.assertEqual(_FakeStrip.instances[0].cleanup_count, 0)

    def test_same_count_does_not_rebuild(self):
        self.server._init_strip(176, 18)
        self.server._init_strip(176, 18)
        self.assertEqual(len(_FakeStrip.instances), 1)

    def test_logical_shrink_blackens_out_of_range(self):
        """从双色带切回单灯带: 上半段 (176..351) 要刷黑 —— 否则留幽灵灯."""
        self.server._init_strip(352, 18)
        strip = _FakeStrip.instances[0]
        strip.setPixelColor(350, 0x00FF00)
        strip.setPixelColor(351, 0x00FF00)
        strip.show_count = 0

        self.server._init_strip(176, 18)
        self.assertEqual(strip.pixels.get(350), 0, "上半段没刷黑 —— 会留幽灵灯")
        self.assertEqual(strip.pixels.get(351), 0)
        self.assertGreaterEqual(strip.show_count, 1, "刷黑之后必须 show 一次")

    def test_off_clears_whole_physical_chain(self):
        """off 必须清整条物理链, 不只是逻辑范围."""
        self.server._init_strip(352, 18)
        strip = _FakeStrip.instances[0]
        self.server.handle({"op": "set", "args": {"i": 350, "r": 0, "g": 255, "b": 0}})
        self.server.handle({"op": "show"})
        self.assertNotEqual(strip.pixels.get(350), 0)

        self.server.handle({"op": "off"})
        self.assertTrue(all(v == 0 for v in strip.pixels.values()),
                        "off 没清干净 —— 第二条带会留幽灵灯")

    def test_set_beyond_logical_count_rejected(self):
        """单灯带模式 (逻辑 176) 不许写上灯带 (176..351)."""
        self.server._init_strip(176, 18)
        resp = self.server.handle({"op": "set", "args": {"i": 200, "r": 255}})
        self.assertFalse(resp["ok"])
        self.assertIn("out of", resp["error"])

    def test_show_pushes_full_physical_frame(self):
        """show 必须推满物理帧长 —— 短帧 = 第二条带全白."""
        self.server._init_strip(176, 18)
        strip = _FakeStrip.instances[0]
        self.server.handle({"op": "show"})
        self.assertEqual(len(strip.pixels), 352,
                         "帧不够长 —— 串联在后面的带会全白")


# ---------------------------------------------------------------------------
# 4b. 设备侧跑马灯 (2026-11-11): 树莓派也支持 marquee, 跟 ESP32 语义一致
# ---------------------------------------------------------------------------
class LedMarqueeTest(unittest.TestCase):
    """一条 `marquee` 命令在**设备上**跑完动画, 不再由前端逐帧发.

    前端逐帧 (44 帧 × 4 条 TCP 命令) 时, 浏览器 rAF / 网络一抖就「乱闪」;
    设备侧跑, 帧间隔由 DMA 的物理时间决定, 中间也插不进别的 set_many.
    """

    def setUp(self):
        _FakeStrip.instances = []
        fake_mod = mock.MagicMock()
        fake_mod.PixelStrip = _FakeStrip
        patcher = mock.patch.dict(sys.modules, {"rpi_ws281x": fake_mod})
        self.addCleanup(patcher.stop)
        patcher.start()
        self.server = led_remote.LedServer(count=176, pin=18, physical_count=352)
        self.server._init_strip(176, 18)
        self.strip = _FakeStrip.instances[0]
        # _init_strip 自己会 show 一次 (全灭) —— 从 0 开始数 marquee 的帧.
        self.strip.show_count = 0

    def test_frames_and_clean_end(self):
        r = self.server.handle({"op": "marquee", "args": {"window": 6, "step": 4}})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["frames"], 44, "176 颗 / step 4 应该是 44 帧")
        # 起手清 + 44 帧 + 收尾清
        self.assertEqual(self.strip.show_count, 46)
        for i in range(352):
            self.assertEqual(self.strip.pixels.get(i, 0), 0,
                             f"第 {i} 颗收尾没灭 —— 会留残影")

    def test_window_too_large_rejected(self):
        r = self.server.handle({"op": "marquee", "args": {"window": 65, "step": 3}})
        self.assertFalse(r["ok"])
        self.assertIn("window too large", r["error"])
        self.assertEqual(self.strip.show_count, 0, "被拒的 window 不该碰灯带")

    def test_step_and_window_defaults(self):
        r = self.server.handle({"op": "marquee", "args": {}})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["frames"], 88, "默认窗口 6 / 步长 2 → 88 帧")

    def test_color_gradient_matches_esp32(self):
        head = led_remote.LedServer._marquee_color(0, 6)
        tail = led_remote.LedServer._marquee_color(5, 6)
        self.assertEqual(head, (0, 0, 255), "头应该是最亮的蓝")
        self.assertEqual(tail[1], 0, "尾部没有绿色分量")
        self.assertGreater(tail[0], 0, "尾部偏紫 (红分量 > 0)")
        self.assertLess(tail[2], 128, "尾部亮度应该降下来")

    def test_marquee_does_not_touch_upper_strip(self):
        """单灯带模式 (逻辑 176): 跑马灯不能点亮上灯带 (176..351)."""
        self.server.handle({"op": "marquee", "args": {"window": 6, "step": 4}})
        # 跑到一半时检查? 收尾已全灭. 这里检查最终帧: 全灭.
        for i in range(176, 352):
            self.assertEqual(self.strip.pixels.get(i, 0), 0)



# ---------------------------------------------------------------------------
# 5. Pi 侧看门狗 (2026-10-29): pinmux 不在关键路径上 + DMA 卡死能被 systemd 发现
# ---------------------------------------------------------------------------
class LedWatchdogTest(unittest.TestCase):
    def setUp(self):
        _FakeStrip.instances = []
        fake_mod = mock.MagicMock()
        fake_mod.PixelStrip = _FakeStrip
        patcher = mock.patch.dict(sys.modules, {"rpi_ws281x": fake_mod})
        self.addCleanup(patcher.stop)
        patcher.start()
        self.server = led_remote.LedServer(count=176, pin=18)
        self.pinmux_calls = []
        p = mock.patch.object(led_remote, "ensure_pinmux",
                              side_effect=lambda pin: self.pinmux_calls.append(pin) or True)
        self.addCleanup(p.stop)
        p.start()

    def test_show_path_does_not_fork_pinctrl(self):
        """show 是**持锁**的关键路径 —— 以前每 20 次 show fork 一次 pinctrl.

        那一次 fork (10~50ms) 会把 ping/status/set 全堵住. 现在挪到后台线程,
        关键路径上一个 fork 都不能有.
        """
        self.server.handle({"op": "show"})     # 第一次: 建 strip
        self.pinmux_calls.clear()
        for _ in range(50):
            self.server.handle({"op": "show"})
        self.assertEqual(self.pinmux_calls, [],
                         "show 的关键路径上又出现 fork 了 (持锁时几十毫秒的停顿)")

    def test_render_stuck_detected_after_grace(self):
        """DMA 挂死 → render 一直不回来 → 心跳要能发现."""
        self.assertFalse(self.server.render_stuck())
        self.server._render_in_progress = True
        self.server._render_started_at = time.time() - led_remote.RENDER_HANG_GRACE_S - 1
        self.assertTrue(self.server.render_stuck())
        # 刚进 render 不算卡 (正常一帧才 5~10ms)
        self.server._render_started_at = time.time()
        self.assertFalse(self.server.render_stuck())

    def test_render_flag_cleared_after_show(self):
        self.server.handle({"op": "show"})
        self.assertFalse(self.server._render_in_progress)


class SdNotifyTest(unittest.TestCase):
    def test_sd_notify_sends_to_notify_socket(self):
        """心跳靠 sd_notify —— 自己发 unix datagram, 不用第三方库."""
        if not hasattr(socket, "AF_UNIX"):
            self.skipTest("这个平台没有 AF_UNIX")
        path = os.path.join(tempfile.gettempdir(), f"led_notify_test_{os.getpid()}.sock")
        if os.path.exists(path):
            os.unlink(path)
        try:
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            srv.bind(path)
        except OSError as e:
            self.skipTest(f"这个平台不支持 unix datagram: {e}")
        srv.settimeout(2)
        patcher = mock.patch.dict(os.environ, {"NOTIFY_SOCKET": path})
        self.addCleanup(patcher.stop)
        patcher.start()
        try:
            self.assertTrue(led_remote.sd_notify("WATCHDOG=1"))
            self.assertEqual(srv.recv(256).decode(), "WATCHDOG=1")
        finally:
            srv.close()
            if os.path.exists(path):
                os.unlink(path)

    def test_sd_notify_without_systemd_is_noop(self):
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        self.addCleanup(patcher.stop)
        patcher.start()
        os.environ.pop("NOTIFY_SOCKET", None)
        self.assertFalse(led_remote.sd_notify("WATCHDOG=1"))


class PinmuxWatchdogTest(unittest.TestCase):
    def test_watchdog_checks_pinmux_periodically(self):
        """后台线程定期查 pinmux —— 灯全黑但日志正常的老毛病就靠它."""
        calls = []
        wd = led_remote.PinmuxWatchdog(lambda: 18, interval=0.05)
        with mock.patch.object(led_remote, "ensure_pinmux",
                               side_effect=lambda pin: calls.append(pin) or True):
            wd.start()
            deadline = time.time() + 3
            while len(calls) < 3 and time.time() < deadline:
                time.sleep(0.02)
            wd.stop()
        self.assertGreaterEqual(len(calls), 3, "pinmux 看门狗没在跑")
        self.assertTrue(all(c == 18 for c in calls))


if __name__ == "__main__":
    unittest.main(verbosity=2)
