#!/usr/bin/env python
"""用 mido.MidiFile.play() 拿到 tempo-aware delta-in-seconds,累加成绝对时间,
按真实时间表发送到 Roland 输出端口。

用法:
    python play_midi.py [path/to/file.mid] [speed]

加 LED 跟随（默认关闭）:
    python play_midi.py --led
    python play_midi.py --led --led-bt-com COM5
    python play_midi.py --led --led-host 192.168.1.113 --led-user loveinshare --led-password .
"""
import argparse
import sys
import time
import mido

OUT_NAME = "Roland Digital Piano 1"


def list_outputs():
    print("Available outputs:")
    for n in mido.get_output_names():
        print(f"  - {n}")


def build_led_controller(args):
    """按 --led-* 参数构造 LED controller，失败返回 None。"""
    try:
        import led_control
    except ImportError:
        print("[led] 无法 import led_control (确保 scripts/ 在 sys.path)", flush=True)
        return None
    try:
        if args.led_bt_com:
            return led_control.BtLedController(args.led_bt_com, count=args.led_count, pin=args.led_pin)
        if args.led_host:
            return led_control.DirectSshLedController(
                args.led_host, args.led_user, args.led_password,
                count=args.led_count, pin=args.led_pin,
            )
    except Exception as e:
        print(f"[led] 初始化失败: {e}", flush=True)
    return None


def main():
    ap = argparse.ArgumentParser(description="Play MIDI to Roland with optional LED follow")
    ap.add_argument("path", nargs="?", default="public/sample.mid", help="MIDI 文件路径")
    ap.add_argument("speed_pos", nargs="?", type=float, default=None, help="(兼容旧用法) 速度倍率")
    ap.add_argument("--speed", type=float, default=None, help="速度倍率 (覆盖位置参数)")

    # LED 选项
    ap.add_argument("--led", action="store_true", help="同步 LED 灯带（默认关闭）")
    ap.add_argument("--led-bt-com", default=None, help="蓝牙 COM 端口（如 COM5）")
    ap.add_argument("--led-host", default=None, help="SSH 主机（与 --led-user/--led-password 配合）")
    ap.add_argument("--led-user", default="loveinshare", help="SSH 用户名")
    ap.add_argument("--led-password", default="<脱敏>", help="SSH 密码（默认 '<脱敏>'）")
    ap.add_argument("--led-count", type=int, default=60, help="LED 数量")
    ap.add_argument("--led-pin", type=int, default=18, help="WS2812B data pin (BCM)")
    args = ap.parse_args()

    # 兼容旧用法: 第二位位置参数当 speed
    speed = args.speed if args.speed is not None else (args.speed_pos if args.speed_pos is not None else 1.0)
    if speed <= 0:
        print("speed must be > 0")
        sys.exit(1)

    path = args.path
    print(f"loading: {path}", flush=True)
    try:
        mid = mido.MidiFile(path)
    except (OSError, ValueError) as e:
        print(f"FAIL: 读 MIDI 失败 -> {e}", flush=True)
        sys.exit(1)

    duration = mid.length
    print(f"  type={mid.type} tracks={len(mid.tracks)} ppq={mid.ticks_per_beat} "
          f"duration={duration:.2f}s @ 1.0x  /  {duration/speed:.2f}s @ {speed}x",
          flush=True)

    try:
        out = mido.open_output(OUT_NAME)
    except OSError:
        print(f"FAIL: 打不开 {OUT_NAME}", flush=True)
        list_outputs()
        sys.exit(1)

    # LED
    led = None
    if args.led:
        led = build_led_controller(args)
        if led is not None:
            print(f"[led] 已连接 ({led.__class__.__name__})", flush=True)
        else:
            print("[led] 未连接, 仅 MIDI 输出", flush=True)

    print(f"opened {out.name}, playing in 1s... (Ctrl+C to stop)", flush=True)
    time.sleep(1.0)

    wall_start = time.monotonic()
    abs_sec = 0.0
    sent = 0
    try:
        for msg in mid.play():
            abs_sec += msg.time * speed
            target = wall_start + abs_sec
            sleep_for = target - time.monotonic()
            if sleep_for > 0:
                time.sleep(sleep_for)
            out.send(msg)
            sent += 1

            # LED 跟随: 处理 note_on / note_off
            if led is not None:
                if msg.type == "note_on" and msg.velocity > 0:
                    led.note_on(msg.note)
                    led.show()
                elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                    led.note_off(msg.note)
                    led.show()
    except KeyboardInterrupt:
        print("\n(interrupted)", flush=True)
    finally:
        # 安全收尾:全通道 All Notes Off + 关端口
        for ch in range(16):
            out.send(mido.Message("control_change", channel=ch, control=123, value=0))
        out.close()
        if led is not None:
            try:
                led.all_off()
            except Exception:
                pass
            try:
                led.close()
            except Exception:
                pass

    print(f"done. sent {sent} msgs over {abs_sec:.2f}s.", flush=True)


if __name__ == "__main__":
    main()
