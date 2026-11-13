#!/usr/bin/env python3
"""全部 LED 熄灭"""
import sys
from rpi_ws281x import PixelStrip


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    pin = 18
    strip = PixelStrip(count, pin, 800000, 10, False, 255, 0, 0x00081000)
    strip.begin()
    for i in range(count):
        strip.setPixelColor(i, 0)
    strip.show()
    print(f"OFF: {count} LEDs cleared on pin={pin}")


if __name__ == "__main__":
    main()