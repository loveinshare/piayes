#!/usr/bin/env python3
"""panel_probe.py 的纯函数测试 (2026-11-13).

面板点不亮的时候, 唯一能信的就是「喂进去的那一帧到底长什么样」——
所以图案生成和参数自检这两块必须自己能测 (不需要真面板).

运行: python scripts/bt_pi/tests/test_panel_probe.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pi"))

import panel_probe  # noqa: E402


def pixels(frame, w, h):
    return [[tuple(frame[(y * w + x) * 3:(y * w + x) * 3 + 3]) for x in range(w)] for y in range(h)]


class BuildPatternTest(unittest.TestCase):
    def test_size_matches_panel(self):
        for w, h in ((160, 80), (128, 64), (1, 1), (64, 80)):
            self.assertEqual(len(panel_probe.build_pattern("border", w, h)), w * h * 3)

    def test_border_lights_all_four_edges_only(self):
        w, h = 160, 80
        px = pixels(panel_probe.build_pattern("border", w, h), w, h)
        white = (255, 255, 255)
        # 四条边
        for x in range(w):
            self.assertEqual(px[0][x], white, f"上边 x={x}")
            self.assertEqual(px[h - 1][x], white, f"下边 x={x}")
        for y in range(h):
            self.assertEqual(px[y][0], white, f"左边 y={y}")
            self.assertEqual(px[y][w - 1], white, f"右边 y={y}")
        # 内部全黑 —— 有亮的就是渲染越界
        for y in range(1, h - 1):
            for x in range(1, w - 1):
                self.assertEqual(px[y][x], (0, 0, 0), f"内部 ({x},{y}) 不该亮")

    def test_rows_pattern_counts_scan_lines(self):
        # rows=80, 每 5 行一条 -> 16 条 (0,5,...,75) + 上下两条边框.
        # 这是「数行」用的图案: 屏上数不齐 16 条, 就说明行寻址不对
        # (1/40 被当成 1/32 时, 底部那 16 行永远收不到数据).
        w, h = 160, 80
        px = pixels(panel_probe.build_pattern("rows", w, h), w, h)
        lit_rows = [y for y in range(h) if px[y][10] == (255, 255, 255)]
        self.assertEqual(lit_rows, list(range(0, h, 5)) + [h - 1])
        # 刻度线只画左边 20px
        self.assertEqual(px[5][19], (255, 255, 255))
        self.assertEqual(px[5][20], (0, 0, 0))

    def test_cols_pattern_counts_columns(self):
        w, h = 160, 80
        px = pixels(panel_probe.build_pattern("cols", w, h), w, h)
        lit_cols = [x for x in range(w) if px[10][x] == (255, 255, 255)]
        self.assertEqual(lit_cols, list(range(0, w, 5)) + [w - 1])
        # 160 列 / 每 5 列一条 = 32 条刻度 (+ 边框 = 33)
        self.assertEqual(len([x for x in lit_cols if x % 5 == 0]), 32)

    def test_solid_patterns(self):
        f = panel_probe.build_pattern("red", 8, 4)
        self.assertEqual(len(f), 8 * 4 * 3)
        self.assertEqual(f[0:3], b"\xff\x00\x00")
        self.assertEqual(f[3:6], b"\xff\x00\x00")
        self.assertEqual(set(panel_probe.build_pattern("black", 8, 4)), {0})
        self.assertEqual(set(panel_probe.build_pattern("white", 4, 2)), {255})

    def test_bad_input(self):
        with self.assertRaises(ValueError):
            panel_probe.build_pattern("nope", 8, 4)
        with self.assertRaises(ValueError):
            panel_probe.build_pattern("border", 0, 4)


class CheckGeometryTest(unittest.TestCase):
    def test_1_32_panel_is_clean(self):
        self.assertEqual(panel_probe.check_geometry(64, 64, 2), [])

    def test_1_40_panel_warns_about_scan_limit(self):
        warns = panel_probe.check_geometry(80, 160, 1)
        self.assertTrue(any("扫描 40 位" in w for w in warns), warns)
        # 用 ABC 移位寄存器 (type=3) 就不该再警告「底部永远不亮」——
        # 那是 panel_probe 扫参数时唯一有机会的组合.
        # (check_geometry 不接 row-addr-type, 由调用方决定; 这里只钉住提示文本)
        self.assertTrue(any("row-addr-type=3" in w for w in warns), warns)

    def test_odd_rows(self):
        warns = panel_probe.check_geometry(65, 64, 1)
        self.assertTrue(any("不是偶数" in w for w in warns), warns)

    def test_spwm_chip_warns(self):
        for chip in ("FM6373", "DP32020A", "ICND1065L", "dp3265s"):
            warns = panel_probe.check_geometry(80, 160, 1, chip)
            self.assertTrue(any("S-PWM" in w for w in warns), (chip, warns))
        # 标准驱动芯片不该被误报
        warns = panel_probe.check_geometry(64, 64, 2, "ICN2038")
        self.assertFalse(any("S-PWM" in w for w in warns), warns)


if __name__ == "__main__":
    unittest.main(verbosity=2)
