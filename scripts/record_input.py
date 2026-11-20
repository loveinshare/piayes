#!/usr/bin/env python
"""录制 + 保存。
监听 Roland 输入,记录每个 note_on 的 (relative_time, midi_note, velocity, duration),
写入 recordings/<timestamp>.json 与 .csv。Ctrl+C 退出。
"""
import sys
import os
import json
import csv
import time
import datetime
import mido

IN_NAME = "Roland Digital Piano 0"
DEADLINE_S = 90.0

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

def midi_to_name(m: int) -> str:
    return f"{NOTE_NAMES[m % 12]}{(m // 12) - 1}"

def main():
    os.makedirs("recordings", exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = f"recordings/{stamp}.json"
    csv_path = f"recordings/{stamp}.csv"

    try:
        inp = mido.open_input(IN_NAME)
    except OSError as e:
        print(f"FAIL: 打不开输入端口 -> {e}")
        sys.exit(1)

    print(f"opened {inp.name}", flush=True)
    print(f"弹琴键 (Ctrl+C 结束, 或 {int(DEADLINE_S)}s 自动超时)...", flush=True)
    print(f"会保存到: {json_path} + {csv_path}", flush=True)

    start = time.monotonic()
    pending = {}  # midi -> (rel_on, velocity, channel)
    onsets = []   # (rel_on, midi_num, midi_name, velocity, duration_or_None)

    def on_msg(msg):
        rel = time.monotonic() - start
        if msg.type == "note_on" and msg.velocity > 0:
            pending[msg.note] = (rel, msg.velocity, msg.channel)
        elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
            p = pending.pop(msg.note, None)
            dur = (rel - p[0]) if p else None
            if p:
                onsets.append((p[0], msg.note, midi_to_name(msg.note), p[1], dur))

    inp.callback = on_msg
    try:
        while time.monotonic() - start < DEADLINE_S:
            time.sleep(0.05)
    except KeyboardInterrupt:
        print("\n(interrupted)", flush=True)
    finally:
        inp.close()

    if not onsets:
        print("(没有收到 note_on)", flush=True)
        return

    # 写 JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump([{
            "t": round(t, 3),
            "midi": n,
            "name": nm,
            "vel": v,
            "dur": round(d, 3) if d is not None else None,
        } for t, n, nm, v, d in onsets], f, ensure_ascii=False, indent=2)

    # 写 CSV
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["t_sec", "midi", "name", "velocity", "duration_sec"])
        for t, n, nm, v, d in onsets:
            w.writerow([f"{t:.3f}", n, nm, v, f"{d:.3f}" if d is not None else ""])

    print(f"\n收到 {len(onsets)} 个音。已保存:", flush=True)
    print(f"  {json_path}")
    print(f"  {csv_path}")
    print()
    print(f"{'t':>6}  {'name':>5}  {'midi':>4}  {'vel':>3}  {'dur':>5}")
    print("-" * 36)
    for t, n, nm, v, d in onsets:
        ds = f"{d:.2f}" if d is not None else "  —"
        print(f"  {t:4.2f}  {nm:>5}  {n:>4}  {v:>3}  {ds:>5}")

if __name__ == "__main__":
    main()
