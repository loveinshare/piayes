#!/usr/bin/env python3
"""一次性部署脚本：通过 paramiko 把 bt-gpio 守护进程推到树莓派上并安装。

需要密码为单字符 '。'，sudo 也用同一个密码（通过 stdin pipe -S）。
"""
import os
import sys
import time

import paramiko

HOST = "192.168.1.113"
USER = "loveinshare"
PASSWORD = "<脱敏>"
PI_DAEMON_DIR = "/opt/bt-gpio"
LOCAL_PI_DIR = r"D:\code\piano-follow\scripts\bt_pi\pi"

# sudo 命令前缀：用 -S 让 sudo 从 stdin 读密码，bash -c 包裹整条链（避免 && 之后丢失提权）
def _sudo_quote(cmd: str) -> str:
    """把 cmd 用单引号包起来，内部单引号替换成 '\"'\"' 风格。"""
    return "'" + cmd.replace("'", "'\"'\"'") + "'"


def ssh_exec(client, cmd, check=True, timeout=120, sudo=False):
    """sudo=True 会通过 stdin 喂密码，整条 cmd 在 root shell 下执行。"""
    if sudo:
        full_cmd = f"sudo -S -p '' bash -c {_sudo_quote(cmd)}"
    else:
        full_cmd = cmd
    stdin, stdout, stderr = client.exec_command(full_cmd, timeout=timeout, get_pty=False)
    if sudo:
        stdin.write(PASSWORD + "\n")
        stdin.flush()
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    rc = stdout.channel.recv_exit_status()
    if check and rc != 0:
        print(f"  ! cmd failed (rc={rc}): {full_cmd}\n  stdout={out}\n  stderr={err}")
    return rc, out, err


def sftp_put(sftp, local_path, remote_tmp_path):
    sftp.put(local_path, remote_tmp_path)


def main():
    print(f"[1/6] connect {USER}@{HOST} via SSH ...")
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        cli.connect(HOST, username=USER, password=PASSWORD, timeout=10)
    except Exception as e:
        print(f"FAIL: SSH 连接失败: {e}")
        sys.exit(1)
    print("  ok")

    print(f"[2/6] 探测 sudo 是否需要密码 ...")
    rc, _, _ = ssh_exec(cli, "sudo -n true", check=False)
    if rc == 0:
        print("  ok (passwordless sudo)")
    else:
        # 用 -S 喂密码试一下
        rc, out, err = ssh_exec(cli, "true", check=False, sudo=True)
        if rc != 0:
            print(f"  ! sudo 喂密码也失败: {err[-300:]}")
            sys.exit(2)
        print("  ok (sudo with password)")

    print(f"[3/6] apt install 依赖 ...")
    apt_cmd = (
        "DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
        "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "
        "python3-bluez python3-rpi.gpio python3-serial "
        "python3-dbus python3-gi bluez"
    )
    rc, out, err = ssh_exec(cli, apt_cmd, check=False, timeout=240, sudo=True)
    if rc != 0:
        print(f"  ! apt 失败 tail: {err[-500:]}")
        sys.exit(3)
    print("  ok")

    print(f"[4/6] 上传 daemon + service ...")
    sftp = cli.open_sftp()
    try:
        ssh_exec(cli, f"install -d -m 755 {PI_DAEMON_DIR}", check=False, sudo=True)
        sftp_put(sftp, os.path.join(LOCAL_PI_DIR, "bt_gpio_daemon.py"), "/tmp/bt_gpio_daemon.py")
        sftp_put(sftp, os.path.join(LOCAL_PI_DIR, "bt-gpio.service"), "/tmp/bt-gpio.service")
        print("  uploaded")
        ssh_exec(cli, f"install -m 755 /tmp/bt_gpio_daemon.py {PI_DAEMON_DIR}/bt_gpio_daemon.py", check=False, sudo=True)
        ssh_exec(cli, f"install -m 644 /tmp/bt-gpio.service /etc/systemd/system/bt-gpio.service", check=False, sudo=True)
        print("  installed")
    finally:
        sftp.close()

    print(f"[5/6] 启动服务 ...")
    # Pi 4 + 串口 console 经常把 ttyS0 占住导致 BT 走 rfkill soft-block + hci0 DOWN
    # 这里先解掉这些坑，再启动我们的服务
    ssh_exec(cli, "systemctl disable --now serial-getty@ttyS0.service", check=False, sudo=True)
    ssh_exec(cli, "rfkill unblock bluetooth", check=False, sudo=True)
    ssh_exec(cli, "systemctl daemon-reload", check=False, sudo=True)
    ssh_exec(cli, "systemctl enable bt-gpio.service", check=False, sudo=True)
    ssh_exec(cli, "systemctl restart bluetooth.service", check=False, sudo=True)
    time.sleep(2)
    ssh_exec(cli, "systemctl restart bt-gpio.service", check=False, sudo=True)
    time.sleep(3)
    rc, out, _ = ssh_exec(cli, "systemctl is-active bt-gpio.service", check=False)
    print(f"  bt-gpio active: {out.strip() or '(unknown)'}")

    print(f"[6/6] 验证日志 + 蓝牙地址 ...")
    rc, out, _ = ssh_exec(cli, "journalctl -u bt-gpio.service -n 20 --no-pager", check=False, timeout=10, sudo=True)
    print("--- journal ---")
    print(out)
    rc, out, _ = ssh_exec(cli, "bluetoothctl show 2>/dev/null | grep -E 'Controller|Address|Powered|Discoverable'", check=False, timeout=10)
    if not out.strip():
        rc, out, _ = ssh_exec(cli, "hciconfig -a 2>/dev/null | head -20", check=False)
    print("--- bluetooth ---")
    print(out or "(no bluetooth tools available)")

    cli.close()
    print("\n部署完成。下一步：")
    print("  1) Windows 端打开蓝牙，搜索并配对树莓派 (PIN 通常 0000)")
    print("  2) 设备管理器 → 端口 (COM 和 LPT) → 找 'Standard Serial over Bluetooth link' 的 COMx")
    print("  3) PC 端:  python bt_gpio_client.py COMx  或  --auto")


if __name__ == "__main__":
    main()