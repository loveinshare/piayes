#!/usr/bin/env python3
"""led_control 单元测试（pure functions）"""
import sys
import unittest

sys.path.insert(0, "D:/code/piano-follow/scripts")
from led_control import (
    note_to_led_range, note_to_led, is_black_key, is_left_hand, color_for,
    LED_COUNT, LOWEST_MIDI, HIGHEST_MIDI, NUM_KEYS, LEDS_PER_KEY_F,
    COLOR_LEFT_WHITE, COLOR_LEFT_BLACK, COLOR_RIGHT_WHITE, COLOR_RIGHT_BLACK,
)


class TestNoteToLedRange(unittest.TestCase):
    def test_endpoints(self):
        # A0 (21) 起始, C8 (108) 结束
        self.assertEqual(note_to_led_range(21), (0, 2))  # 第 1 个 key 起始 LED 0
        rng = note_to_led_range(108)
        self.assertIsNotNone(rng)
        self.assertEqual(rng[1], LED_COUNT)  # 最末必须用满 144 颗

    def test_out_of_range(self):
        self.assertIsNone(note_to_led_range(20))
        self.assertIsNone(note_to_led_range(109))
        self.assertIsNone(note_to_led_range(0))
        self.assertIsNone(note_to_led_range(127))

    def test_full_coverage(self):
        # 88 个 key 的 range 拼起来必须严格覆盖 [0, LED_COUNT)
        ranges = [note_to_led_range(n) for n in range(LOWEST_MIDI, HIGHEST_MIDI + 1)]
        for i in range(len(ranges) - 1):
            self.assertEqual(ranges[i][1], ranges[i + 1][0],
                             f"gap/overlap between key {LOWEST_MIDI+i} and {LOWEST_MIDI+i+1}")
        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], LED_COUNT)

    def test_exactly_2_per_key(self):
        # 88 key × 2 LED = 176, 每 key 正好 2 颗
        for n in range(LOWEST_MIDI, HIGHEST_MIDI + 1):
            rng = note_to_led_range(n)
            self.assertEqual(rng[1] - rng[0], 2, f"key {n} has {rng[1]-rng[0]} LEDs")

    def test_total_leds(self):
        total = sum(note_to_led_range(n)[1] - note_to_led_range(n)[0]
                    for n in range(LOWEST_MIDI, HIGHEST_MIDI + 1))
        self.assertEqual(total, LED_COUNT)

    def test_legacy_note_to_led(self):
        self.assertEqual(note_to_led(21), 0)
        rng = note_to_led_range(60)
        self.assertEqual(note_to_led(60), rng[0])
        self.assertIsNone(note_to_led(20))
        self.assertIsNone(note_to_led(109))

    def test_one_octave_span(self):
        # C4 (60) 到 C5 (72) 正好 12 keys × 2 LED = 24 颗 LED
        a = note_to_led_range(60)[0]
        b = note_to_led_range(72)[0]
        self.assertEqual(b - a, 24)


class TestBlackKey(unittest.TestCase):
    def test_black_keys(self):
        for pc in (1, 3, 6, 8, 10):
            self.assertTrue(is_black_key(60 + pc), f"pc={pc}")
        for pc in (0, 2, 4, 5, 7, 9, 11):
            self.assertFalse(is_black_key(60 + pc), f"pc={pc}")

    def test_black_keys_around_strip(self):
        for n in (25, 27, 30, 32, 34, 37, 61, 66, 70, 73, 75, 78, 85, 90, 102, 106):
            self.assertTrue(is_black_key(n), f"note {n} should be black")
        for n in (21, 24, 26, 29, 31, 36, 48, 60, 72, 84, 100, 108):
            self.assertFalse(is_black_key(n), f"note {n} should be white")


class TestLeftHand(unittest.TestCase):
    def test_boundary(self):
        self.assertTrue(is_left_hand(59))    # B3 左手
        self.assertFalse(is_left_hand(60))   # C4 右手
        self.assertTrue(is_left_hand(0))
        self.assertTrue(is_left_hand(21))
        self.assertFalse(is_left_hand(108))


class TestColors(unittest.TestCase):
    def test_right_white(self):
        self.assertEqual(color_for(60), COLOR_RIGHT_WHITE)
        self.assertEqual(color_for(72), COLOR_RIGHT_WHITE)
        self.assertEqual(color_for(108), COLOR_RIGHT_WHITE)

    def test_right_black(self):
        self.assertEqual(color_for(61), COLOR_RIGHT_BLACK)   # C#4
        self.assertEqual(color_for(73), COLOR_RIGHT_BLACK)   # C#5
        self.assertEqual(color_for(85), COLOR_RIGHT_BLACK)   # C#6
        self.assertEqual(color_for(102), COLOR_RIGHT_BLACK)  # F#6

    def test_left_hand(self):
        self.assertEqual(color_for(48), COLOR_LEFT_WHITE)
        self.assertEqual(color_for(49), COLOR_LEFT_BLACK)
        self.assertEqual(color_for(21), COLOR_LEFT_WHITE)

    def test_distinct(self):
        colors = {color_for(60), color_for(61), color_for(48), color_for(49)}
        self.assertEqual(len(colors), 4)


class TestMappingProperties(unittest.TestCase):
    def test_black_keys_count(self):
        for base in [21, 33, 45, 57, 69, 81, 93]:
            blacks = [n for n in range(base, base + 12) if is_black_key(n)]
            self.assertEqual(len(blacks), 5)

    def test_in_strip(self):
        for n in range(21, 109):
            rng = note_to_led_range(n)
            if rng is not None:
                self.assertGreaterEqual(rng[0], 0)
                self.assertLess(rng[1], LED_COUNT + 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
