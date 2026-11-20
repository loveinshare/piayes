import paramiko
import sys
sys.stdout.reconfigure(encoding='utf-8')

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('192.168.1.113', username='loveinshare', password='<脱敏>', timeout=10)

def run(cmd, t=15):
    print(f'\n=== $ {cmd}')
    si, so, se = ssh.exec_command(cmd, timeout=t)
    o = so.read().decode(errors='replace')
    e = se.read().decode(errors='replace')
    if o: print(o.rstrip())
    if e: print('STDERR:', e.rstrip())

# 1. 进程
run('ps aux | grep -iE "led|ws_led|python.*8080|python.*7777" | grep -v grep')
# 2. 端口
run('ss -tlnp 2>/dev/null | grep -E ":8080|:7777"')
# 3. 桥日志 (最后 30 行)
run('journalctl -u ws-led-bridge --no-pager -n 30 2>&1')
# 4. led_remote.py 是否还在
run('ls -la /tmp/led_remote* 2>&1')
# 5. rpi_ws281x 装没装
run('python3 -c "from rpi_ws281x import PixelStrip, Color; print(\"rpi_ws281x OK\")" 2>&1')
# 6. 试 nc 7777 (看 7777 是不是真的没人在听)
run('(echo -e "{\\"id\\":\\"t1\\",\\"op\\":\\"ping\\"}\\n"; sleep 1) | nc -w 2 127.0.0.1 7777 2>&1; echo END')
# 7. WS 桥本身活不活 (curl WS upgrade, 拿到 400 + Server 头就是活)
run('curl -s -i --max-time 2 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Key: dGVzdA==" -H "Sec-WebSocket-Version: 13" http://127.0.0.1:8080/ 2>&1 | head -5')

ssh.close()
