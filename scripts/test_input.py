#!/usr/bin/env python
"""监听 Roland 输入端口,记录每个事件距开始的相对秒数。
Ctrl+C 提前退出。退出时打印:
  - 每个 note_on 的时刻 + 音名 + 力度
  - 每个音的按下时长 (note_on -> note_off)
  - 整体音高序列
"""
import sys
import time
import mido

IN_NAME = "Roland Digital Piano 0"
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

def midi_to_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{(m // 12) - 1}"

def main():
    try:
        inp = mido.open_input(IN_NAME)
    except OSError as e:
        print(f"FAIL: 打不开输入端口 -> {e}")
        sys.exit(1)

    print(f"opened {inp.name}. 弹琴键 (Ctrl+C 结束, 或等 60s 超时)...", flush=True)

    start = time.monotonic()
    DEADLINE_S = 60.0
    # pending: midi_note -> (on_time, velocity)
    pending = {}
    # events: list of (rel_time, kind, midi, vel)
    events = []
    onsets = []  # (rel_time, midi_name, midi_num, vel, dur_s_or_None)

    def on_msg(msg):
        rel = time.monotonic() - start
        if msg.type == "note_on" and msg.velocity > 0:
            pending[msg.note] = (rel, msg.velocity, msg.channel)
            events.append((rel, "on ", msg.note, msg.velocity))
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            p = pending.pop(msg.note, None)
            dur = (rel - p[0]) if p else None
            events.append((rel, "off", msg.note, msg.velocity))
            if p:
                onsets.append((p[0], msg.note, p[1], dur))

    inp.callback = on_msg

    try:
        while time.monotonic() - start < DEADLINE_S:
            time.sleep(0.05)
    except KeyboardInterrupt:
        print("\n(interrupted)", flush=True)
    finally:
        inp.close()

    if not onsets:
        print("没有收到 note_on。")
        return

    print(f"\n收到 {len(onsets)} 个音:")
    print(f"{'t (s)':>7}  {'name':>4}  {'midi':>4}  {'vel':>3}  {'dur (s)':>7}")
    print("-" * 40)
    for t, m, v, dur in onsets:
        dur_s = f"{dur:.2f}" if dur is not None else "  —"
        print(f"  {t:5.2f}  {midi_to_name(m):>4}  {m:>4}  {v:>3}  {dur_s:>7}")

    print()
    seq = [midi_to_name(m) for _, m, _, _ in onsets]
    nums = [str(m) for _, m, _, _ in onsets]
    print(f"音高序列 ({len(seq)}): {' '.join(seq)}")
    print(f"MIDI 数字: {' '.join(nums)}")

if __name__ == "__main__":
    main()
