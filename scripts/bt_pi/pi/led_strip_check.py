#!/usr/bin/env python3
"""独立灯带硬件验证：直接用 rpi_ws281x 驱动 GPIO18 上的 WS2812 灯带。

不经过 /opt/bt-gpio/led_remote.py 服务，也不碰任何 systemd 单元 ——
纯硬件体检脚本，用来回答"灯带到底是坏了还是接线/服务的问题"。

WS2812 收到 show() 后会自己锁存颜色，所以脚本退出后灯仍然亮着；
--hold 期间会周期性重刷，防止被别的实例覆盖。

用法 (必须 sudo, rpi_ws281x 要 /dev/mem):
  sudo python3 led_strip_check.py                    # 第1和第10颗亮红, 常亮 30s
  sudo python3 led_strip_check.py --hold 0           # 点亮后立刻退出 (灯保持常亮)
  sudo python3 led_strip_check.py --pixels 0,9,20    # 指定索引
  sudo python3 led_strip_check.py --rgb 0,255,0     # 换颜色
  sudo python3 led_strip_check.py --sweep            # 逐颗扫描, 看断在哪
  sudo python3 led_strip_check.py --all              # 全亮
  sudo python3 led_strip_check.py --off              # 全灭
"""
import argparse
import sys
import time

from rpi_ws281x import PixelStrip

# WS2811_STRIP_GRB
STRIP_TYPE = 0x00081000
FREQ_HZ = 800000
DMA_CHANNEL = 10
BRIGHTNESS = 255

# Pi4 (BCM2711): GPIO12 的 PWM 功能是 alt0 (PWM0_0), GPIO18 是 alt5;
# Pi3 (BCM2837): GPIO18 是 alt0. 能驱动 WS2812 的只有 12 / 18 / 21.
# 这个脚本自己开了 PixelStrip 实例, 退出后必须把 pinmux 还回去 ——
# 否则 led_remote 的 show() 照样返回 ok, 但 DIN 线上没波形, 灯全黑
# (2026-10-27 实测踩过: led_remote 的 init 因为"已初始化"短路, 永远不会修).
_PWM_ALT = {12: 'a0', 18: 'a5', 13: 'a0', 19: 'a5', 21: 'a0'}


def restore_pinmux(pin: int) -> None:
    """把引脚还回 PWM 复用 —— 让 led_remote 能继续驱动."""
    import subprocess
    alt = _PWM_ALT.get(pin, 'a0')
    try:
        subprocess.run(['pinctrl', 'set', str(pin), alt],
                       capture_output=True, text=True, timeout=5)
        print(f"GPIO{pin} pinmux 已还回 {alt}(PWM) —— led_remote 可以继续驱动了", flush=True)
    except Exception as e:
        print(f"警告: GPIO{pin} pinmux 没还回去 ({e}); "
              f"灯带可能不亮 —— 重启 led-remote.service 可恢复", flush=True)


def build_strip(count: int, pin: int) -> PixelStrip:
    strip = PixelStrip(count, pin, FREQ_HZ, DMA_CHANNEL, False, BRIGHTNESS, 0, STRIP_TYPE)
    strip.begin()
    return strip


def clear(strip: PixelStrip, count: int) -> None:
    for i in range(count):
        strip.setPixelColor(i, 0)


def pack(r: int, g: int, b: int) -> int:
    return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF)


def hold_pattern(strip: PixelStrip, count: int, pixels: list, rgb, hold: float, pin: int = 18) -> None:
    """点亮指定像素并保持。hold<=0 时只 show 一次 (WS2812 自行锁存, 退出仍亮)."""
    color = pack(*rgb)
    clear(strip, count)
    for i in pixels:
        strip.setPixelColor(i, color)
    strip.show()
    label = ", ".join(f"LED[{i + 1}]" for i in pixels)
    print(f"ON: {label} = RGB{rgb} (GPIO{pin}, {count} LEDs)", flush=True)
    if hold <= 0:
        print("hold=0, 脚本退出; WS2812 已锁存, 灯会一直亮", flush=True)
        return
    end = time.time() + hold
    while time.time() < end:
        time.sleep(0.5)
        # 重刷一遍, 防止被服务端的实例覆盖掉
        for i in pixels:
            strip.setPixelColor(i, color)
        strip.show()
    print(f"hold {hold}s 结束", flush=True)


def sweep(strip: PixelStrip, count: int, rgb, step: float) -> None:
    """逐颗扫描: 每次只亮一颗, 用来找灯带断点/坏段."""
    color = pack(*rgb)
    print(f"SWEEP: 0..{count - 1}, 每颗 {step:.2f}s, 看到哪颗不亮就是断点", flush=True)
    for i in range(count):
        clear(strip, count)
        strip.setPixelColor(i, color)
        strip.show()
        time.sleep(step)
    clear(strip, count)
    strip.show()
    print("SWEEP done", flush=True)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--count", type=int, default=176, help="灯带颗数 (默认 176)")
    p.add_argument("--pin", type=int, default=18, help="DIN GPIO (默认 18)")
    p.add_argument("--pixels", default="0,9",
                   help="要点亮的索引 (0-based, 逗号分隔). 默认 0,9 = 第1和第10颗")
    p.add_argument("--rgb", default="255,0,0", help="颜色 R,G,B (默认 255,0,0 红)")
    p.add_argument("--hold", type=float, default=30.0,
                   help="保持秒数; <=0 表示点一下就退出 (灯仍常亮)")
    p.add_argument("--sweep", action="store_true", help="逐颗扫描模式")
    p.add_argument("--all", action="store_true", help="全亮")
    p.add_argument("--off", action="store_true", help="全灭")
    p.add_argument("--step", type=float, default=0.06, help="扫描每颗停留秒数")
    args = p.parse_args()

    rgb = tuple(int(x) for x in args.rgb.split(","))
    if len(rgb) != 3:
        p.error("--rgb 需要三个值 R,G,B")

    try:
        strip = build_strip(args.count, args.pin)
    except Exception as e:
        print(f"FAIL: 无法初始化 strip: {type(e).__name__}: {e}", flush=True)
        return 2

    print(f"READY pin={args.pin} count={args.count}", flush=True)

    # 退出前一定要把 pinmux 还回去 (见 restore_pinmux 的注释) —— 走所有 return 路径.
    try:
        return _run(args, strip, rgb)
    finally:
        restore_pinmux(args.pin)


def _run(args, strip, rgb) -> int:
    if args.off:
        clear(strip, args.count)
        strip.show()
        print(f"OFF: {args.count} LEDs cleared", flush=True)
        return 0

    if args.sweep:
        sweep(strip, args.count, rgb, args.step)
        return 0

    if args.all:
        color = pack(*rgb)
        for i in range(args.count):
            strip.setPixelColor(i, color)
        strip.show()
        print(f"ON: all {args.count} LEDs = RGB{rgb}", flush=True)
        if args.hold > 0:
            end = time.time() + args.hold
            while time.time() < end:
                time.sleep(0.5)
                for i in range(args.count):
                    strip.setPixelColor(i, color)
                strip.show()
        return 0

    pixels = []
    for tok in args.pixels.split(","):
        tok = tok.strip()
        if not tok:
            continue
        i = int(tok)
        if i < 0 or i >= args.count:
            print(f"ERR: 像素 {i} 越界 (0..{args.count - 1})", flush=True)
            return 1
        pixels.append(i)

    hold_pattern(strip, args.count, pixels, rgb, args.hold, args.pin)
    return 0


if __name__ == "__main__":
    sys.exit(main())
