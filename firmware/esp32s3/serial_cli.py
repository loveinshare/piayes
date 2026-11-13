"""串口跟 ESP32-S3 说话 —— 发命令 + 读输出.

用法:
    python serial_cli.py "wifi scan" 5
    python serial_cli.py "" 3          # 只读 3 秒
    python serial_cli.py "wifi rtt" 8 8   # 等 8 秒 (等 WiFi 连上) 再发命令

开 COM5 会把板子复位一次 (DTR/RTS 自动复位) —— 这是预期行为,
所以每次跑脚本都会先看到一遍开机日志.
"""
import sys
import time

import serial


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    wait = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
    # 发命令前先等这么久 —— 等 WiFi 连上之类的.
    pre = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    port = sys.argv[4] if len(sys.argv) > 4 else "COM5"

    ser = serial.Serial(port, 115200, timeout=0.2)
    start = time.time()
    # 先把开端口时产生的复位跑完, 开机日志也读掉.
    while time.time() - start < 3.0:
        line = ser.readline()
        if line:
            print(line.decode("utf-8", "replace").rstrip())

    if cmd:
        deadline = time.time() + pre
        while time.time() < deadline:
            line = ser.readline()
            if line:
                print(line.decode("utf-8", "replace").rstrip())
        ser.write((cmd + "\n").encode("utf-8"))
        ser.flush()

    end = time.time() + wait
    while time.time() < end:
        line = ser.readline()
        if line:
            print(line.decode("utf-8", "replace").rstrip())
    ser.close()


if __name__ == "__main__":
    main()
