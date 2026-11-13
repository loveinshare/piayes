#!/usr/bin/env python
"""测试链路: 通过 Roland 输出端口发一个 C4,看电钢响不响。
退出时统一发 All Notes Off 避免有音卡住。"""
import sys
import time
import mido

OUT_NAME = "Roland Digital Piano 1"

NOTE_ON  = mido.Message("note_on",  channel=0, note=60, velocity=100)
NOTE_OFF = mido.Message("note_off", channel=0, note=60, velocity=0)
ALL_OFF  = mido.Message("control_change", channel=0, control=123, value=0)

def main():
    print(f"opening output: {OUT_NAME}")
    try:
        out = mido.open_output(OUT_NAME)
    except OSError as e:
        print(f"FAIL: 打不开输出端口 -> {e}")
        print("Available outputs:")
        for n in mido.get_output_names():
            print(f"  - {n}")
        sys.exit(1)

    print(f"opened {out.name}")
    print("sending C4 (note 60) vel=100 持续 0.8s ...")
    try:
        out.send(NOTE_ON)
        time.sleep(0.8)
        out.send(NOTE_OFF)
        out.send(ALL_OFF)  # safety
        print("OK: 发声指令已发出。如果电钢没声音,问题在电钢本身(音色 / 音量 / 本地开关)")
    except Exception as e:
        print(f"FAIL: 发送出错 -> {e}")
        sys.exit(1)
    finally:
        out.close()
        print("closed.")

if __name__ == "__main__":
    main()
