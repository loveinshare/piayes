#!/usr/bin/env python3
"""点亮 LED 区间，用于电源耐受测试。

用法: sudo python3 led_test_range.py [count_total] [start] [n] [r] [g] [b]
默认: count_total=60, start=0, n=30, RGB(255,0,0)=红
"""
import sys
from rpi_ws281x import PixelStrip, Color


def main():
    total = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    start = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    r = int(sys.argv[4]) if len(sys.argv) > 4 else 255
    g = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    b = int(sys.argv[6]) if len(sys.argv) > 6 else 0
    pin = 18

    if start < 0 or start >= total:
        print(f"ERR: start {start} 越界 (0..{total-1})")
        sys.exit(1)
    if n < 1 or start + n > total:
        print(f"ERR: 范围 [{start}, {start+n}) 越界")
        sys.exit(1)

    strip = PixelStrip(total, pin, 800000, 10, False, 255, 0, 0x00081000)
    strip.begin()

    # 先全部熄灭再点亮指定区间
    for i in range(total):
        strip.setPixelColor(i, 0)
    for i in range(start, start + n):
        strip.setPixelColor(i, Color(r, g, b))
    strip.show()

    est_ma = n * 20 * (r + g + b) // (255 * 3)  # 粗估电流（全白 ~20mA/颗 归一化）
    print(f"OK: pin={pin} total={total} LED[{start}..{start+n-1}] set to RGB({r},{g},{b})")
    print(f"    估电流 ~{est_ma} mA (假设每颗满亮 ~60mA, 这里按比例)")


if __name__ == "__main__":
    main()