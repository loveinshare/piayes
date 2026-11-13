#!/usr/bin/env python3
"""双色带接线标定工具 (2026-10-30 实机标定用).

用法:
  python scripts/bt_pi/pc/calib_dual.py off          # 全灭 (整条物理链)
  python scripts/bt_pi/pc/calib_dual.py grid          # 6 点网格标定
  python scripts/bt_pi/pc/calib_dual.py head-tail     # 两点决定性验证

实测接线 (2026-10-30, 352 颗):
  chain 0..175    主灯带 (下) —— 数据从**左**端进, 往右推
  chain 176..351  上灯带     —— 数据从**右**端进, 往左推 (倒叙)
  两条带在物理**右**端对接 (主带末端 → 上带进数据端).
"""
import base64
import json
import shlex
import sys

sys.stdout.reconfigure(encoding="utf-8")

import paramiko

HOST = "192.168.1.113"
USER = "loveinshare"
PASSWORD = "<脱敏>"
PORT = 7777

GRID = [
    (0, 255, 0, 0, "红   主带 chain 首"),
    (175, 0, 255, 0, "绿   主带 chain 尾"),
    (176, 0, 0, 255, "蓝   上带 chain 首"),
    (220, 0, 255, 255, "青   上带"),
    (264, 255, 0, 255, "品红 上带"),
    (308, 255, 255, 255, "白   上带"),
]

HEAD_TAIL = [
    (176, 0, 0, 255, "蓝   上带 chain 首 (局部第 0 颗)"),
    (350, 255, 255, 0, "黄   上带 chain 尾前一颗 (局部第 174 颗)"),
]

MODES = {
    "off": None,
    "grid": GRID,
    "head-tail": HEAD_TAIL,
}


def send(ops, ssh):
    msgs = [{"id": "i", "op": "init", "args": {"count": 352, "pin": 18}}]
    if ops is None:
        msgs.append({"id": "of", "op": "off"})
    else:
        msgs.append({"id": "m", "op": "set_many",
                     "args": {"pixels": [{"i": i, "r": r, "g": g, "b": b}
                                        for i, r, g, b, _ in ops]}})
        msgs.append({"id": "sh", "op": "show"})
    payload = "".join(json.dumps(m) + "\n" for m in msgs)
    cmd = "printf %s " + shlex.quote(payload) + f" | nc -w 3 127.0.0.1 {PORT}"
    b64 = base64.b64encode(cmd.encode()).decode()
    si, so, se = ssh.exec_command(f"echo {b64} | base64 -d | sh", timeout=30)
    out = so.read().decode(errors="replace").strip()
    err = se.read().decode(errors="replace").strip()
    print(out or "(空)")
    if err:
        print("STDERR:", err)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "grid"
    if mode not in MODES:
        print(__doc__)
        print("可选:", ", ".join(MODES))
        return 2
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(HOST, username=USER, password=PASSWORD, timeout=15)
    try:
        send(MODES[mode], ssh)
    finally:
        ssh.close()
    if MODES[mode]:
        print("--- 亮着的点 ---")
        for i, r, g, b, desc in MODES[mode]:
            print(f"  chain {i:3d}  RGB({r},{g},{b})  {desc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
