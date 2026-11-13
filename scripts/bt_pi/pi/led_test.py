#!/usr/bin/env python3
"""临时测试脚本：点亮 LED 0 (红色) 用于验证接线。

用法: sudo python3 led_test.py [count] [r] [g] [b]
默认 count=60 (用户常见灯带长度), r=255 g=0 b=0 (红色)
"""
import sys
from rpi_ws281x import PixelStrip, Color


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    r = int(sys.argv[2]) if len(sys.argv) > 2 else 255
    g = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    b = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    pin = 18  # GPIO 18 / board pin 12

    strip = PixelStrip(count, pin, 800000, 10, False, 255, 0, 0x00081000)  # WS2811_STRIP_GRB
    strip.begin()

    strip.setPixelColor(0, Color(r, g, b))
    strip.show()
    print(f"OK: pin={pin} count={count} LED[0] set to RGB({r},{g},{b})")


if __name__ == "__main__":
    main()