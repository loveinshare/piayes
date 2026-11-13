#!/usr/bin/env python3
"""点阵屏帧通道的回归测试 (2026-11-13).

钉住用户报的「像素随机乱删 + 整体闪烁」在**树莓派底层**那几条根因:

1. **帧长不对的帧绝不能进 led_anim 的 stdin** —— 它的 stdin 是一条裸字节流,
   里面没有帧边界 (按 width*height*3 一段一段切). 只要错一个字节, 后面
   **每一帧**都错位 → 屏幕上一堆随机像素乱跳.
   (换屏数时残留的旧尺寸帧 / 客户端算错帧长, 都会造成这个.)

2. **换尺寸时旧槽位必须清掉** —— 以前 stop_proc() 不清 _pending,
   新进程可能先吃到一个旧尺寸的帧.

3. **同一个 stdin 只能有一个写者** —— 以前 self._stop 是跨代共用的布尔量,
   start() 里把它置 False 会把上一代的写线程「复活」, 两个线程交错写.

4. **led_anim 挂了要自己拉起来** —— 以前写失败只 log 一句, 屏从此定格.

5. **两个客户端不能同时推帧** —— 否则面板在两路画面之间来回跳 (抖 + 闪).
   现在是「新客户端接管, 旧的回 1012」—— 前端认这个码, 收到就不再重连.

运行: python scripts/bt_pi/tests/test_matrix_server.py
"""
import asyncio
import json
import os
import struct
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pi"))

import matrix_server  # noqa: E402


# ---------------------------------------------------------------------------
# 假 led_anim 进程 —— 只实现 Panel 用到的那一小撮接口.
# ---------------------------------------------------------------------------
class FakeStdin:
    def __init__(self, sink, gen):
        self.sink = sink
        self.gen = gen
        self.closed = False

    def write(self, data):
        if self.closed:
            raise ValueError("write to closed file")
        self.sink.append((self.gen, bytes(data)))
        return len(data)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class FakeProc:
    def __init__(self, sink, gen):
        self.sink = sink
        self.gen = gen
        self.stdin = FakeStdin(sink, gen)
        # Panel._drain_stdout 看到 None 就直接返回 (不派线程)
        self.stdout = None
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0
        return 0

    def terminate(self):
        self.returncode = -15

    def kill(self):
        self.returncode = -9


def make_args(**over):
    base = dict(
        led_anim="/fake/led_anim",
        fps=60,
        rows=64,
        cols=64,
        chain_per_screen=2,
        mapping="regular",
        # 亮度 100 = 不做帧缩放. 绝大多数用例要比**原始字节**, 所以默认关掉缩放;
        # 缩放本身单独有用例 (test_brightness_scales_frames).
        brightness=100,
        slowdown=3,
        pwm_bits=7,
        limit_refresh=0,
        pwm_lsb_ns=0,
        show_refresh=False,
        cpu=3,
        takeover=True,
        idle_stop_s=0,
        max_clients=1,
        # 面板适配参数 (默认 -1/None = 不传给 led_anim)
        row_addr_type=-1,
        multiplexing=-1,
        scan_mode=-1,
        panel_type=None,
        pixel_mapper=None,
        rgb_sequence=None,
        inverse=False,
        no_hardware_pulse=False,
        chip=None,
    )
    base.update(over)
    return type("Args", (), base)()


def wait_for(pred, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


class PanelFrameChannelTest(unittest.TestCase):
    def setUp(self):
        self.writes = []          # [(gen, bytes)]
        self.procs = []
        sink = self.writes

        def fake_popen(cmd, **kwargs):
            proc = FakeProc(sink, len(self.procs) + 1)
            self.procs.append(proc)
            return proc

        self._patch = mock.patch.object(matrix_server.subprocess, "Popen", side_effect=fake_popen)
        self._patch.start()
        self.panel = matrix_server.Panel(make_args())

    def tearDown(self):
        self.panel.stop_proc()
        self._patch.stop()

    def frame_records(self, gen, size):
        return [w for (g, w) in self.writes if g == gen and len(w) == size]

    # -- 1. 正常路径: 帧头一次 + 每帧原样写进去 ------------------------------
    def test_header_written_once_then_frames(self):
        self.panel.start(128, 64, [3])
        # chain_per_screen(2) * 1 屏 = 2
        self.assertEqual(self.panel.chain, 2)
        size = 128 * 64 * 3
        self.assertEqual(self.panel._frame_size, size)
        self.assertTrue(wait_for(lambda: len(self.writes) == 1))
        self.assertEqual(self.writes[0], (1, struct.pack("<II", 128, 64)))

        frame = bytes(range(256)) * (size // 256)
        self.assertTrue(self.panel.submit(frame))
        self.assertTrue(wait_for(lambda: self.panel.frames_drawn == 1))
        self.assertEqual(self.frame_records(1, size), [frame])
        # 帧头只写一次
        self.assertEqual(len([w for (g, w) in self.writes if g == 1 and len(w) == 8]), 1)

    # -- 2. 帧长不对: 直接拒, 一个字节都不许流进管道 --------------------------
    def test_wrong_size_frame_is_rejected(self):
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        self.assertFalse(self.panel.submit(b"\x00" * 100))
        self.assertEqual(self.panel.frames_bad, 1)
        self.assertEqual(self.panel.frames_drawn, 0)
        # 只有帧头, 没有别的东西
        self.assertEqual(len(self.writes), 1)

    # -- 3. 槽位里混进旧尺寸的帧: 写线程也要再校验一次 ------------------------
    def test_stale_slot_frame_is_dropped_by_writer(self):
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        # 直接塞一个旧尺寸的帧进槽位 (模拟换尺寸残留)
        with self.panel._lock:
            self.panel._pending = b"\x00" * 176 * 64 * 3
            self.panel._wake.notify()
        self.assertTrue(wait_for(lambda: self.panel.frames_bad == 1))
        self.assertFalse([w for (g, w) in self.writes if g == 1 and len(w) == 176 * 64 * 3])

    # -- 4. 换尺寸: 清槽位 + 换写者, 旧尺寸的帧再也不会出现 -------------------
    def test_resize_swaps_writer_and_clears_queue(self):
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        small = bytes(128 * 64 * 3)
        self.panel.submit(small)
        self.assertTrue(wait_for(lambda: self.panel.frames_drawn == 1))

        # 换 2 块屏 -> 帧宽 256
        old_writer = self.panel._writer
        self.panel.start(256, 64, [3, 4])
        self.assertEqual(self.panel._frame_size, 256 * 64 * 3)
        self.assertEqual(len(self.procs), 2)
        # ★ 旧写线程必须已经退出 + 旧 stdin 已关 (不然两个线程抢同一个 stdin)
        self.assertFalse(old_writer.is_alive())
        self.assertTrue(self.procs[0].stdin.closed)
        big = bytes(256 * 64 * 3)
        self.panel.submit(big)
        self.assertTrue(wait_for(lambda: self.frame_records(2, len(big)) == [big]))
        # 第二个进程只收到 8 字节帧头 + 新尺寸的帧
        self.assertEqual([len(w) for (g, w) in self.writes if g == 2][:1], [8])
        self.assertEqual(self.frame_records(2, len(small)), [])

    # -- 5. 槽位只有一个: 第二帧盖掉第一帧, 记一笔丢帧 ------------------------
    def test_single_slot_drops_previous(self):
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        size = 128 * 64 * 3
        a = bytes([1]) * size
        b = bytes([2]) * size
        with self.panel._lock:
            self.panel._pending = a
        self.assertTrue(self.panel.submit(b))
        self.assertEqual(self.panel.frames_drops, 1)
        self.assertEqual(self.panel._pending, b)
        self.assertTrue(wait_for(lambda: self.frame_records(1, size) == [b]))

    # -- 6. 亮度: 在服务端按帧缩放, 不用重启 led_anim ------------------------
    def test_brightness_scales_frames(self):
        size = 128 * 64 * 3
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        self.assertEqual(self.panel.set_brightness(50), 50)
        frame = bytes([255, 0, 0] * (128 * 64))
        self.panel.submit(frame)
        self.assertTrue(wait_for(lambda: self.panel.frames_drawn == 1))
        got = self.frame_records(1, size)[0]
        self.assertEqual(list(got[:6]), [128, 0, 0, 128, 0, 0])
        self.assertEqual(len(got), size)          # 缩放不改帧长
        # 100% 时完全不动 (零开销路径)
        self.panel.set_brightness(100)
        self.assertIsNone(self.panel._lut)
        self.panel.submit(frame)
        self.assertTrue(wait_for(lambda: self.panel.frames_drawn == 2))
        self.assertEqual(self.frame_records(1, size)[1], frame)

    def test_brightness_is_clamped(self):
        self.assertEqual(self.panel.set_brightness(0), 1)
        self.assertEqual(self.panel.set_brightness(999), 100)
        self.assertEqual(self.panel.set_brightness("nope"), 100)

    # -- 7. led_anim 挂了 -> 下一帧自己拉起来 --------------------------------
    def test_ensure_running_after_death(self):
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        self.panel.proc.returncode = 1          # 假装 led_anim 崩了
        self.assertTrue(self.panel.ensure_running())
        self.assertEqual(self.panel.restarts, 1)
        self.assertEqual(len(self.procs), 2)
        self.assertIs(self.panel.proc, self.procs[1])
        # 新进程读到自己的帧头
        self.assertTrue(wait_for(lambda: any(g == 2 and len(w) == 8 for (g, w) in self.writes)))

    # -- 7. status 里能看到这些诊断计数 --------------------------------------
    def test_status_reports_diagnostics(self):
        self.panel.start(128, 64, [3])
        wait_for(lambda: len(self.writes) == 1)
        st = self.panel.status()
        self.assertEqual(st["width"], 128)
        self.assertEqual(st["frame_size"], 128 * 64 * 3)
        for key in ("frames_in", "frames_drops", "frames_bad", "frames_drawn",
                    "writer_errors", "restarts", "writer_alive", "queue"):
            self.assertIn(key, st)
        self.assertTrue(st["running"])


# ---------------------------------------------------------------------------
# 接管: 两个客户端不能同时推帧
# ---------------------------------------------------------------------------
def _server_available():
    try:
        import websockets  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(_server_available(), "没有 websockets")
class TakeoverTest(unittest.IsolatedAsyncioTestCase):
    """接管语义 (2026-11-13 改过一版, 踩坑记录见 matrix_server.handler 的注释):

    - 只有**发 matrix.init** (要驱动这块屏) 的客户端才接管, 才踢旧的画面来源;
    - 只是来查 status / ping 的连接**不接管**, 也不该被踢 —— 否则一个调试探针
      就能把真正的前端挤掉, 而前端收到 1012 之后按设计不再重连, 面板就黑了.
    """

    async def asyncSetUp(self):
        import websockets
        self.websockets = websockets
        # max_clients=2: 允许「推帧的 + 查状态的」并存
        self.srv = matrix_server.Server(make_args(idle_stop_s=0, max_clients=2))
        self.serve = matrix_server._resolve_serve()
        # 不真的 spawn led_anim (测试机上没有那个二进制)
        self._patch = mock.patch.object(matrix_server.Panel, "start", autospec=True,
                                        return_value=None)
        self._patch.start()

    async def asyncTearDown(self):
        self._patch.stop()

    async def _start(self):
        cm = self.serve(self.srv.handler, "127.0.0.1", 0,
                        max_size=matrix_server.MAX_FRAME_BYTES + 4096)
        server = await cm
        port = server.sockets[0].getsockname()[1]
        return cm, port

    async def _init(self, ws, mid=1):
        await ws.send(json.dumps({"id": mid, "op": "matrix.init",
                                  "args": {"width": 128, "height": 64, "screens": [3]}}))
        return json.loads(await asyncio.wait_for(ws.recv(), 3))

    async def test_second_init_takes_over_with_1012(self):
        cm, port = await self._start()
        url = f"ws://127.0.0.1:{port}"
        try:
            c1 = await self.websockets.connect(url)
            self.assertTrue((await self._init(c1))["ok"])
            c2 = await self.websockets.connect(url)
            self.assertTrue((await self._init(c2, 2))["ok"])
            # c1 应该被 1012 请走
            with self.assertRaises(self.websockets.exceptions.ConnectionClosed) as ctx:
                await asyncio.wait_for(c1.recv(), 3)
            self.assertEqual(ctx.exception.rcvd.code, matrix_server.REPLACED_CODE)
            # c2 成了新 owner
            for _ in range(200):
                if self.srv._owner is not None:
                    break
                await asyncio.sleep(0.01)
            self.assertIsNotNone(self.srv._owner)
            await c2.send(json.dumps({"id": 3, "op": "status"}))
            resp = json.loads(await asyncio.wait_for(c2.recv(), 3))
            self.assertTrue(resp["ok"])
            await c2.close()
        finally:
            await cm.__aexit__(None, None, None)

    async def test_status_probe_does_not_take_over(self):
        """只查状态的连接**不能**把正在推帧的前端挤掉 (今天踩过的坑)."""
        cm, port = await self._start()
        url = f"ws://127.0.0.1:{port}"
        try:
            c1 = await self.websockets.connect(url)
            self.assertTrue((await self._init(c1))["ok"])
            owner_before = self.srv._owner

            probe = await self.websockets.connect(url)
            await probe.send(json.dumps({"id": 9, "op": "status"}))
            resp = json.loads(await asyncio.wait_for(probe.recv(), 3))
            self.assertTrue(resp["ok"])
            await probe.close()

            # c1 没被踢, owner 也没变
            await c1.send(json.dumps({"id": 10, "op": "ping"}))
            self.assertIn("pong", await asyncio.wait_for(c1.recv(), 3))
            self.assertIs(self.srv._owner, owner_before)
            await c1.close()
        finally:
            await cm.__aexit__(None, None, None)

    async def test_frames_from_non_owner_are_ignored(self):
        """非 owner 推的帧不能进面板 (否则两路画面会打架)."""
        cm, port = await self._start()
        url = f"ws://127.0.0.1:{port}"
        try:
            c1 = await self.websockets.connect(url)
            self.assertTrue((await self._init(c1))["ok"])
            probe = await self.websockets.connect(url)   # 没 init, 不是 owner
            await probe.send(b"\x00" * (128 * 64 * 3))
            await asyncio.sleep(0.2)
            self.assertEqual(self.srv.panel.frames_in, 0)
            # probe 还活着 (不被断开)
            await probe.send(json.dumps({"id": 11, "op": "ping"}))
            self.assertIn("pong", await asyncio.wait_for(probe.recv(), 3))
            await probe.close()
            await c1.close()
        finally:
            await cm.__aexit__(None, None, None)


if __name__ == "__main__":
    unittest.main(verbosity=2)