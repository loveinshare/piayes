"""恢复 LED 服务 + 加 systemd 开机自启.

步骤:
1. scp led_remote.py -> /opt/bt-gpio/led_remote.py (永久位置, 避免 /tmp 重启清空)
2. scp led-remote.service -> /etc/systemd/system/led-remote.service
3. sudo systemctl daemon-reload
4. sudo systemctl enable led-remote.service (开机自启)
5. sudo systemctl start led-remote.service (立刻拉起)
6. 验证: 端口 7777 listening, ping/status 协议通, systemd status active
"""
import paramiko
import sys
import time
sys.stdout.reconfigure(encoding='utf-8')

HOST = '192.168.1.113'
USER = 'loveinshare'
PASS = '<脱敏>'

LOCAL_PY = r'D:\code\piano-follow\scripts\bt_pi\pi\led_remote.py'
LOCAL_SVC = r'D:\code\piano-follow\scripts\bt_pi\pi\led-remote.service'
REMOTE_PY = '/opt/bt-gpio/led_remote.py'
REMOTE_SVC = '/etc/systemd/system/led-remote.service'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=10)

def run(cmd, t=15, use_sudo=False):
    if use_sudo and not cmd.startswith('echo'):
        # 用 -S 从 stdin 读密码; 非交互式 sudo
        cmd = f"echo '{PASS}' | sudo -S {cmd}"
    print(f'\n=== $ {cmd}')
    si, so, se = ssh.exec_command(cmd, timeout=t, get_pty=False)
    o = so.read().decode(errors='replace').rstrip()
    e = se.read().decode(errors='replace').rstrip()
    if o: print(o)
    if e and 'password' not in e: print('STDERR:', e)
    return o

def sudo_run(cmd, t=15):
    """用 -S + 密码管道, 跳过交互. 适合 enable/start 这类."""
    return run(cmd, t=t, use_sudo=True)

# 1. scp 文件 — 先到 /tmp (loveinshare 可写), 再 sudo cp 到最终位置
print('=== 1) 部署 led_remote.py + service ===')
sftp = ssh.open_sftp()
sftp.put(LOCAL_PY, '/tmp/led_remote.py')
sftp.chmod('/tmp/led_remote.py', 0o755)
sftp.put(LOCAL_SVC, '/tmp/led-remote.service')
sftp.chmod('/tmp/led-remote.service', 0o644)
sftp.close()
# sudo 移到目标位置
sudo_run(f'cp /tmp/led_remote.py {REMOTE_PY} && chmod 755 {REMOTE_PY}')
sudo_run(f'cp /tmp/led-remote.service {REMOTE_SVC} && chmod 644 {REMOTE_SVC}')
run(f'ls -la {REMOTE_PY} {REMOTE_SVC}')

# 2. 杀掉任何残留 (保险 — 比如用户之前手动跑过)
run('pkill -9 -f "led_remote.py" 2>/dev/null; sleep 0.5; echo killed-old')

# 3. 重新加载 systemd + enable + start
print('\n=== 2) systemctl daemon-reload + enable + start ===')
sudo_run('systemctl daemon-reload')
sudo_run('systemctl enable led-remote.service')
sudo_run('systemctl start led-remote.service')
time.sleep(2.5)  # 等 strip init

# 4. 状态检查
print('\n=== 3) 状态 ===')
sudo_run('systemctl is-active led-remote.service', t=5)
sudo_run('systemctl is-enabled led-remote.service', t=5)
sudo_run('systemctl status led-remote.service --no-pager -n 10', t=5)

# 5. 端口检查
print('\n=== 4) 端口 + 进程 ===')
run('ss -tlnp 2>/dev/null | grep -E ":7777|:8080"')
run('ps aux | grep led_remote | grep -v grep')

# 6. 协议验证
print('\n=== 5) 协议验证 (ping + status + set/show) ===')
run('(echo \'{"id":1,"op":"ping"}\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')
run('(echo \'{"id":2,"op":"status"}\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')
# off 清掉之前测试的 LED 0 红色
run('(echo \'{"id":3,"op":"off"}\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')

# 7. 日志
print('\n=== 6) journalctl -u led-remote ===')
sudo_run('journalctl -u led-remote --no-pager -n 10', t=5)

# 8. 模拟重启测试 (用 systemctl restart, 不真重启 Pi)
print('\n=== 7) 模拟「重启服务」验证 Restart=on-failure ===')
sudo_run('systemctl restart led-remote.service')
time.sleep(2.5)
sudo_run('systemctl is-active led-remote.service', t=5)
run('ss -tlnp 2>/dev/null | grep 7777')

ssh.close()
print('\n=== DONE ===')
