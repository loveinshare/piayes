"""Pi 状态总览: SSH 通不通, 进程, 端口, 服务, 日志."""
import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8')

HOST = '192.168.1.113'
USER = 'loveinshare'
PASS = '<脱敏>'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    ssh.connect(HOST, username=USER, password=PASS, timeout=10)
    print('SSH OK')
except Exception as e:
    print(f'SSH FAIL: {e}')
    sys.exit(1)

def run(cmd, t=10):
    print(f'\n=== $ {cmd}')
    si, so, se = ssh.exec_command(cmd, timeout=t)
    o = so.read().decode(errors='replace').rstrip()
    e = se.read().decode(errors='replace').rstrip()
    if o: print(o)
    if e: print('STDERR:', e)

# 1. 基础状态
run('uptime')
run('date')
# 2. LED 相关进程
run('ps aux | grep -iE "led|ws_led" | grep -v grep')
# 3. 端口
run('ss -tlnp 2>/dev/null | grep -E ":8080|:7777"')
# 4. led_remote.py 是否还在
run('ls -la /tmp/led_remote* 2>&1')
# 5. systemd 状态 (看开机后 systemd 服务是否起来了)
run('systemctl is-active ws-led-bridge 2>&1')
run('systemctl is-enabled ws-led-bridge 2>&1')
# 6. 桥日志
run('journalctl -u ws-led-bridge --no-pager -n 15 2>&1')
# 7. 看有没有 /etc/systemd/system/led-remote.service 之类
run('ls -la /etc/systemd/system/led* 2>&1; ls -la /lib/systemd/system/led* 2>&1')

ssh.close()
