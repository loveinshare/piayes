#!/usr/bin/env python3
"""Windows 端蓝牙 GPIO 控制客户端。

用法:
  python bt_gpio_client.py [COM_PORT]
  python bt_gpio_client.py --auto         # 自动扫描含 "Bluetooth" 的 COM 端口
  python bt_gpio_client.py --list         # 只列出可用 COM 端口

无参数且无 --auto 时，会列出端口并交互式选择。
进入 REPL 后支持:
  help                                 显示所有命令
  write <pin> <0|1>                    gpio.write  (数字 GPIO 编号)
  read  <pin>                          gpio.read
  mode  <pin> <in|out> [up|down|none]  gpio.mode
  pwm   <pin> <freq> <duty>            pwm.start
  duty  <pin> <duty>                   pwm.change
  stop  <pin>                          pwm.stop
  ping                                 ping
  status                               status
  cleanup                              cleanup
  raw <json>                           直接发送原始 JSON（debug 用）
  quit                                 退出

安装依赖: pip install pyserial
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Optional

import serial
import serial.tools.list_ports


BAUD = 9600
TIMEOUT = 5.0


# ----------- 传输层 -----------
class BtGpioLink:
    def __init__(self, port: str, baud: int = BAUD, timeout: float = TIMEOUT):
        self.ser = serial.Serial(port, baud, timeout=timeout, write_timeout=timeout)
        # 丢弃可能存在的旧输入
        try:
            self.ser.reset_input_buffer()
            self.ser.reset_output_buffer()
        except Exception:
            pass
        self._buf = b""

    def close(self):
        try:
            self.ser.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def request(self, op: str, args: Optional[dict] = None, *, _id: Optional[str] = None, timeout: Optional[float] = None) -> dict:
        req_id = _id or f"{int(time.time() * 1000)}"
        payload = {"id": req_id, "op": op, "args": args or {}}
        line = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
        self.ser.write(line)
        old_timeout = self.ser.timeout
        if timeout is not None:
            self.ser.timeout = timeout
        try:
            resp_line = self._read_line()
        finally:
            if timeout is not None:
                self.ser.timeout = old_timeout
        if resp_line is None:
            raise TimeoutError(f"等待响应超时 ({timeout or self.ser.timeout}s)")
        try:
            return json.loads(resp_line.decode("utf-8"))
        except json.JSONDecodeError as e:
            raise ValueError(f"响应非 JSON: {resp_line!r} ({e})") from e

    def _read_line(self) -> Optional[bytes]:
        # 从 self._buf 中按 \n 切片，否则阻塞读 1 字节
        while b"\n" not in self._buf:
            chunk = self.ser.read(1)
            if not chunk:
                return None
            self._buf += chunk
        line, _, self._buf = self._buf.partition(b"\n")
        return line.strip()


# ----------- COM 端口发现 -----------
def list_serial_ports():
    return list(serial.tools.list_ports.comports())


def is_bluetooth_port(p) -> bool:
    desc = (p.description or "") + " " + (p.manufacturer or "")
    return ("bluetooth" in desc.lower()) or ("bt" in desc.lower())


def pick_port_interactive() -> str:
    ports = list_serial_ports()
    if not ports:
        print("未检测到任何 COM 端口。", file=sys.stderr)
        sys.exit(1)
    print("可用 COM 端口:")
    for i, p in enumerate(ports):
        flag = " [bluetooth]" if is_bluetooth_port(p) else ""
        print(f"  [{i}] {p.device}  {p.description}{flag}")
    bt = [p for p in ports if is_bluetooth_port(p)]
    if len(bt) == 1:
        print(f"自动选择唯一蓝牙端口: {bt[0].device}")
        return bt[0].device
    while True:
        try:
            raw = input("选择端口编号 [0-{}]: ".format(len(ports) - 1)).strip()
            idx = int(raw)
            if 0 <= idx < len(ports):
                return ports[idx].device
        except (ValueError, EOFError):
            pass
        print("输入无效，重试。")


def auto_pick_port() -> Optional[str]:
    ports = list_serial_ports()
    bt = [p for p in ports if is_bluetooth_port(p)]
    if not bt:
        return None
    if len(bt) == 1:
        return bt[0].device
    # 多个时取编号最大的（通常是最近添加的 outgoing 端口）
    def sort_key(p):
        dev = p.device  # e.g. "COM12"
        digits = "".join(ch for ch in dev if ch.isdigit())
        return int(digits) if digits else -1
    bt.sort(key=sort_key, reverse=True)
    return bt[0].device


# ----------- CLI -----------
HELP_TEXT = """
可用命令:
  help
  ping
  status
  mode  <pin> <in|out> [pull]
  write <pin> <0|1>
  read  <pin>
  pwm   <pin> <freq> <duty>     # pwm.start
  duty  <pin> <duty>             # pwm.change
  stop  <pin>                    # pwm.stop
  cleanup
  raw <json>                     # 直接发送原始 JSON（不带 \\n）
  quit | exit
"""


def repl(link: BtGpioLink):
    print(HELP_TEXT)
    while True:
        try:
            line = input("bt-gpio> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line:
            continue
        parts = line.split()
        cmd = parts[0].lower()
        try:
            if cmd in ("quit", "exit", "q"):
                break
            elif cmd == "help":
                print(HELP_TEXT)
            elif cmd == "ping":
                print(link.request("ping"))
            elif cmd == "status":
                print(link.request("status"))
            elif cmd == "cleanup":
                print(link.request("cleanup"))
            elif cmd == "mode":
                pin = int(parts[1])
                mode = parts[2]
                pull = parts[3] if len(parts) > 3 else "none"
                print(link.request("gpio.mode", {"pin": pin, "mode": mode, "pull": pull}))
            elif cmd == "write":
                pin = int(parts[1])
                val = int(parts[2])
                print(link.request("gpio.write", {"pin": pin, "value": val}))
            elif cmd == "read":
                pin = int(parts[1])
                print(link.request("gpio.read", {"pin": pin}))
            elif cmd == "pwm":
                pin = int(parts[1])
                freq = float(parts[2])
                duty = float(parts[3])
                print(link.request("pwm.start", {"pin": pin, "freq": freq, "duty": duty}))
            elif cmd == "duty":
                pin = int(parts[1])
                duty = float(parts[2])
                print(link.request("pwm.change", {"pin": pin, "duty": duty}))
            elif cmd == "stop":
                pin = int(parts[1])
                print(link.request("pwm.stop", {"pin": pin}))
            elif cmd == "raw":
                raw = " ".join(parts[1:])
                if not raw.endswith("\n"):
                    raw += "\n"
                link.ser.write(raw.encode())
                # 读一行响应
                resp_line = link._read_line()
                if resp_line is None:
                    print("(无响应)")
                else:
                    try:
                        print(json.dumps(json.loads(resp_line.decode()), indent=2))
                    except Exception:
                        print(resp_line)
            else:
                print(f"未知命令: {cmd}。输入 help 查看帮助。")
        except (ValueError, IndexError) as e:
            print(f"参数解析失败: {e}")
        except TimeoutError as e:
            print(f"[超时] {e}")
        except Exception as e:
            print(f"[错误] {type(e).__name__}: {e}")


def main():
    ap = argparse.ArgumentParser(description="通过蓝牙虚拟串口控制树莓派 GPIO")
    ap.add_argument("port", nargs="?", help="蓝牙 COM 端口，如 COM5")
    ap.add_argument("--auto", action="store_true", help="自动扫描蓝牙端口")
    ap.add_argument("--list", action="store_true", help="列出可用 COM 端口后退出")
    ap.add_argument("--op", help="非交互模式：发送一条 op（如 'ping'）")
    ap.add_argument("--args", help="非交互模式：op 的 JSON 参数，如 '{\"pin\":18}'")
    ap.add_argument("--timeout", type=float, default=TIMEOUT, help="读写超时（秒）")
    args = ap.parse_args()

    if args.list:
        for p in list_serial_ports():
            print(f"{p.device}\t{p.description}\t{'[bluetooth]' if is_bluetooth_port(p) else ''}")
        return

    if args.port:
        port = args.port
    elif args.auto:
        port = auto_pick_port()
        if not port:
            print("自动扫描未找到蓝牙端口，请先配对树莓派。", file=sys.stderr)
            sys.exit(2)
        print(f"自动选择端口: {port}")
    else:
        port = pick_port_interactive()

    print(f"连接 {port} @ {BAUD} 8N1 ...")
    try:
        with BtGpioLink(port, timeout=args.timeout) as link:
            # 启动时 ping 一下确认链路通
            try:
                pong = link.request("ping", timeout=3.0)
                print(f"[link ok] {pong}")
            except Exception as e:
                print(f"握手失败（{e}）。守护进程可能未运行，或 COM 端口不对。", file=sys.stderr)
                sys.exit(3)
            if args.op:
                op_args = json.loads(args.args) if args.args else {}
                print(json.dumps(link.request(args.op, op_args), indent=2, ensure_ascii=False))
            else:
                repl(link)
    except serial.SerialException as e:
        print(f"打开 {port} 失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()