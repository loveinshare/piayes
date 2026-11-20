#!/usr/bin/env python
"""从 stdin 或文件读取 mido.Message 字符串,提取 note_on 序列,转音名 + 时间间隔。
格式: 'note_on channel=0 note=57 velocity=11 time=0'
输出:
  +0.00s  A3 (57)
  +0.42s  B3 (59)
  ...
"""
import sys
import re

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

def midi_to_name(m: int) -> str:
    n = NOTE_NAMES[m % 12]
    octv = (m // 12) - 1
    return f"{n}{octv}"

NOTE_RE = re.compile(r"note_on channel=(\d+) note=(\d+) velocity=(\d+)")

def main():
    src = sys.stdin if not sys.argv[1:] else open(sys.argv[1], encoding="utf-8")
    last_t = 0.0
    events = []
    last_msg_t = 0
    cur_time = 0.0
    for line in src:
        line = line.strip()
        if not line:
            continue
        # mido 默认 time 是相对上一条 — 这里记录的都是 0(因为 callback 内的 msg.time = 0)
        # 真实时间差要从收到时间推算 — 简化:用 callback 内的 monotonic
        # 这里只能识别 note_on
        m = NOTE_RE.search(line)
        if not m:
            continue
        ch = int(m.group(1))
        note = int(m.group(2))
        vel = int(m.group(3))
        # 我们从「相邻两条消息的间隔」粗略估算时间
        events.append((cur_time, ch, note, vel))
        cur_time += 0.05  # 默认 50ms 步进,真实应从 callback 内 monotonic 拿
    if not events:
        print("(没有 note_on 消息)")
        return
    print(f"{'t (rel)':>8}  {'name':>5}  {'midi':>4}  ch  vel")
    print("-" * 32)
    base_t = events[0][0]
    for t, ch, note, vel in events:
        rel = t - base_t
        print(f"  {rel:6.2f}s  {midi_to_name(note):>5}  {note:>4}  {ch:>2}  {vel:>3}")

    # 提取音高序列
    seq = [midi_to_name(n) for _, _, n, _ in events]
    print()
    print(f"音高序列 ({len(seq)}): {' '.join(seq)}")
    print(f"MIDI 数列:        {' '.join(str(n) for _, _, n, _ in events)}")

if __name__ == "__main__":
    main()
