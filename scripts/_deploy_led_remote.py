"""部署 led_remote.py 到树莓派, sudo 启动, 验证."""
import paramiko
import sys
import time
sys.stdout.reconfigure(encoding='utf-8')

LOCAL = r'D:\code\piano-follow\scripts\bt_pi\pi\led_remote.py'
REMOTE = '/tmp/led_remote.py'
HOST = '192.168.1.113'
USER = 'loveinshare'
PASS = '<脱敏>'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=10)

def run(cmd, t=15, get_pty=False):
    print(f'\n=== $ {cmd}')
    si, so, se = ssh.exec_command(cmd, timeout=t, get_pty=get_pty)
    o = so.read().decode(errors='replace')
    e = se.read().decode(errors='replace')
    if o: print(o.rstrip())
    if e: print('STDERR:', e.rstrip())
    return o

# 1. scp 上传
print('=== Uploading led_remote.py...')
sftp = ssh.open_sftp()
sftp.put(LOCAL, REMOTE)
sftp.chmod(REMOTE, 0o755)
sftp.close()
run(f'ls -la {REMOTE}')
run(f'head -5 {REMOTE}')

# 2. 杀掉任何残留进程 (没有 — 我们已经查过, 但保险)
run('pkill -f "led_remote.py" 2>&1; sleep 0.5; echo killed')

# 3. sudo 启动 (用 -S 从 stdin 读密码)
# nohup + & 让进程脱离 ssh session
print('\n=== Starting led_remote via sudo...')
start_cmd = f"echo '{PASS}' | sudo -S nohup python3 -u {REMOTE} --auto-init > /tmp/led_remote.log 2>&1 &"
run(start_cmd, t=10)
time.sleep(2.5)  # 等待 strip init (PWM ready)

# 4. 看启动 log
run('cat /tmp/led_remote.log')

# 5. 进程检查
run('ps aux | grep -E "led_remote" | grep -v grep')
run('ss -tlnp 2>/dev/null | grep 7777')

# 6. 试 ping
print('\n=== Test ping...')
run('(echo \'{"id":1,"op":"ping"}\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')

# 7. 试 status
print('\n=== Test status...')
run('(echo \'{"id":2,"op":"status"}\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')

# 8. 试 off (确保能关)
print('\n=== Test off...')
run('(echo \'{"id":3,"op":"off"}\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')

# 9. 试 set+show 一颗红色 LED (物理验证用 — 用户看着灯条)
print('\n=== Test set pixel 0 red + show (物理验证)...')
run('(printf \'{"id":4,"op":"set","args":{"i":0,"r":255,"g":0,"b":0}}\\n{"id":5,"op":"show"}\\n\'; sleep 0.5) | nc -w 2 127.0.0.1 7777')

# 10. 看 log 确认 set/show 被处理
print('\n=== Final log:')
run('cat /tmp/led_remote.log')

ssh.close()
print('\n=== DONE')
