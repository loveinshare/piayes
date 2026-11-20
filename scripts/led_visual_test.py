#!/usr/bin/env python3
"""LED 可视测试。

用法:
  python led_visual_test.py                    # 跑段 1+2+3
  python led_visual_test.py --keep-on          # 跳过 1/2, 只做段 3 (常亮)
  python led_visual_test.py --bt-com COM5      # 走蓝牙

按 Ctrl+C 中断 (段 3 才会触发, 因为段 1/2 自动倒计时)。
"""
import argparse
import sys
import time

sys.path.insert(0, "D:/code/piano-follow/scripts")
import led_control


def _phase1(ctl, hold):
    print()
    print("=" * 60)
    print("段 1: 首位两键 (A0 LEDs 0..1, A#0 LEDs 2..4)")
    print("=" * 60)
    ctl.all_off()
    for n in (21, 22):
        rng = led_control.note_to_led_range(n)
        c = led_control.color_for(n)
        side = "左" if led_control.is_left_hand(n) else "右"
        kind = "黑" if led_control.is_black_key(n) else "白"
        print(f"  MIDI {n} ({side}手 {kind}键) -> LEDs [{rng[0]}..{rng[1]-1}] ({rng[1]-rng[0]} 颗)  RGB{c}")
        ctl.note_on(n)
    ctl.show()
    print(f"\n[段 1] 已亮, 等 {hold} 秒...")
    time.sleep(hold)
    ctl.all_off()
    print("[段 1] 灭")


def _phase2(ctl, hold):
    print()
    print("=" * 60)
    print("段 2: 完整八度 C4..B4 (MIDI 60..71)")
    print("=" * 60)
    ctl.all_off()
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    for n in range(60, 72):
        rng = led_control.note_to_led_range(n)
        c = led_control.color_for(n)
        side = "左" if led_control.is_left_hand(n) else "右"
        kind = "黑" if led_control.is_black_key(n) else "白"
        name = names[n % 12] + str(n // 12 - 1)
        print(f"  {name:>3} (MIDI {n}, {side}{kind}) -> LEDs [{rng[0]:>3}..{rng[1]-1:>3}] ({rng[1]-rng[0]} 颗)  RGB{c}")
        ctl.note_on(n)
    ctl.show()
    print(f"\n[段 2] 已亮, 等 {hold} 秒...")
    time.sleep(hold)
    ctl.all_off()
    print("[段 2] 灭")


def _phase3(ctl):
    """常亮: 首位 1 键 + 末位 1 键 + 中间 12 键。Ctrl+C 退出。"""
    print()
    print("=" * 60)
    print("段 3: 第 1 键 (A0) + 最后 1 键 (G#5) + 中间 12 键 (C4..B4)")
    print("      常亮直到 Ctrl+C")
    print("=" * 60)
    ctl.all_off()
    notes_on = [21, 80] + list(range(60, 72))   # A0, G#5, C4..B4
    for n in notes_on:
        rng = led_control.note_to_led_range(n)
        c = led_control.color_for(n)
        side = "左" if led_control.is_left_hand(n) else "右"
        kind = "黑" if led_control.is_black_key(n) else "白"
        names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        name = names[n % 12] + str(n // 12 - 1) if n >= 60 else "A0"
        print(f"  {name:>4} (MIDI {n}, {side}{kind}) -> LEDs [{rng[0]:>3}..{rng[1]-1:>3}]  RGB{c}")
        ctl.note_on(n)
    ctl.show()
    print(f"\n[段 3] {len(notes_on)} 键已亮, 按 Ctrl+C 退出...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[段 3] 收到 Ctrl+C, 收尾")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bt-com", default=None)
    ap.add_argument("--host", default="192.168.1.113")
    ap.add_argument("--user", default="loveinshare")
    ap.add_argument("--password", default="<脱敏>")
    ap.add_argument("--pin", type=int, default=18)
    ap.add_argument("--hold", type=float, default=8.0, help="段 1/2 亮多久 (秒)")
    ap.add_argument("--keep-on", action="store_true", help="跳过 1/2 段, 直接做段 3 (常亮)")
    args = ap.parse_args()

    print(f"[test] 准备 LED strip: count={led_control.LED_COUNT} pin={args.pin}")
    print(f"[test] 映射: 60 key × ~2.4 LED = {led_control.LED_COUNT} LED")

    # 建 controller
    if args.bt_com:
        from led_control import BtLedController
        ctl = BtLedController(args.bt_com, count=led_control.LED_COUNT, pin=args.pin)
    else:
        from led_control import DirectSshLedController
        ctl = DirectSshLedController(
            args.host, args.user, args.password,
            count=led_control.LED_COUNT, pin=args.pin,
        )
    print(f"[test] 已连接 ({type(ctl).__name__})")

    try:
        if not args.keep_on:
            _phase1(ctl, args.hold)
            _phase2(ctl, args.hold)
        _phase3(ctl)
    finally:
        try:
            ctl.all_off()
        except Exception:
            pass
        try:
            ctl.close()
        except Exception:
            pass
    print("[test] 完成")


if __name__ == "__main__":
    main()
