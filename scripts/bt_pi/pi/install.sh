#!/usr/bin/env bash
# 在树莓派上一次性安装蓝牙 GPIO 守护进程 + LED 桥。
# 用法: sudo bash install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "请用 sudo bash install.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/bt-gpio"
TOKEN_FILE="$INSTALL_DIR/led_token"
SVC_USER="pi"

echo "[1/7] 安装系统依赖: python3-bluez, python3-rpi.gpio, python3-serial, python3-dbus, python3-gi"
if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y --no-install-recommends \
    python3-bluez python3-rpi.gpio python3-serial \
    python3-dbus python3-gi bluez
  # WS 桥用 websockets (P1-10 的 token/Origin/限流都在这里)
  apt-get install -y --no-install-recommends python3-websockets || \
    pip3 install --break-system-packages websockets || true
else
  echo "未检测到 apt-get，请手动安装等价包" >&2
  exit 1
fi

echo "[2/7] 安装到 $INSTALL_DIR"
install -d -m 755 "$INSTALL_DIR"
install -m 755 "$SCRIPT_DIR/bt_gpio_daemon.py" "$INSTALL_DIR/bt_gpio_daemon.py"
if [[ -f "$SCRIPT_DIR/ws_led_bridge.py" ]]; then
  install -m 755 "$SCRIPT_DIR/ws_led_bridge.py" "$INSTALL_DIR/ws_led_bridge.py"
fi
if [[ -f "$SCRIPT_DIR/led_remote.py" ]]; then
  install -m 755 "$SCRIPT_DIR/led_remote.py" "$INSTALL_DIR/led_remote.py"
fi
# 点阵屏那条路 (browser -> ws 8081 -> matrix_server -> led_anim -> HUB75).
# 注意: led_anim 本身在 ~/led/src/ 下, 不归这个仓库管 —— 没编的话服务起得来
# 但 spawn 会失败 (journal 里能看到 "起 led_anim 失败").
if [[ -f "$SCRIPT_DIR/matrix_server.py" ]]; then
  install -m 755 "$SCRIPT_DIR/matrix_server.py" "$INSTALL_DIR/matrix_server.py"
fi
# 面板点亮诊断 (不依赖业务链路, 直接喂 led_anim) —— 换面板/查「随机像素」时用.
if [[ -f "$SCRIPT_DIR/panel_probe.py" ]]; then
  install -m 755 "$SCRIPT_DIR/panel_probe.py" "$INSTALL_DIR/panel_probe.py"
fi

# 服务降权后不再以 root 运行 (spec P1-11) —— 确保用户存在且在正确的组里
echo "[2b/7] 确保服务用户 $SVC_USER 存在 + 加入 bluetooth/gpio 组"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$SVC_USER"
fi
getent group "$SVC_USER" >/dev/null 2>&1 || groupadd -r "$SVC_USER"
for grp in bluetooth gpio; do
  getent group "$grp" >/dev/null 2>&1 || groupadd -r "$grp"
  usermod -aG "$grp" "$SVC_USER"
done

echo "[2c/7] 生成 LED 共享 token (P1-10)"
if [[ ! -f "$TOKEN_FILE" ]]; then
  python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$TOKEN_FILE"
fi
chown root:"$SVC_USER" "$TOKEN_FILE"
chmod 640 "$TOKEN_FILE"

echo "[3/7] 安装并启用 systemd 单元"
install -m 644 "$SCRIPT_DIR/bt-gpio.service" /etc/systemd/system/bt-gpio.service
if [[ -f "$SCRIPT_DIR/ws-led-bridge.service" ]]; then
  install -m 644 "$SCRIPT_DIR/ws-led-bridge.service" /etc/systemd/system/ws-led-bridge.service
  systemctl enable ws-led-bridge.service
fi
if [[ -f "$SCRIPT_DIR/led-remote.service" ]]; then
  install -m 644 "$SCRIPT_DIR/led-remote.service" /etc/systemd/system/led-remote.service
  systemctl enable led-remote.service
fi
# 点阵屏: 屏数/帧率都是浏览器下发的, 服务本身只认「一帧多少字节」.
# 它跟灯带互不干扰 (不同端口 / 不同硬件), 没接屏也不会影响灯带.
if [[ -f "$SCRIPT_DIR/led-matrix.service" && -f "$SCRIPT_DIR/matrix_server.py" ]]; then
  install -m 644 "$SCRIPT_DIR/led-matrix.service" /etc/systemd/system/led-matrix.service
  systemctl enable led-matrix.service
fi

# 装完就是 fail-closed: token 文件在步骤 2c 已经生成, 万一丢了/被删了,
# 直接拒绝**所有**连接, 而不是"只告警然后放行" (spec P1-10).
# 手工部署 (不走 install.sh) 保持代码默认的宽松模式, 行为可预期.
mkdir -p /etc/systemd/system/ws-led-bridge.service.d
cat > /etc/systemd/system/ws-led-bridge.service.d/10-security.conf <<'EOF'
[Service]
Environment=LED_REQUIRE_TOKEN=1
Environment=LED_AUTH_TIMEOUT_S=10
EOF

systemctl daemon-reload
systemctl enable bt-gpio.service

# Pi 4 + Bookworm 上常见坑：serial-getty 抢 ttyS0 + rfkill 屏蔽蓝牙
# 这里一次性解掉，否则 hci0 永远 DOWN
echo "[3b/7] 释放 ttyS0 + 解屏蔽蓝牙"
systemctl disable --now serial-getty@ttyS0.service || true
rfkill unblock bluetooth || true
systemctl restart bluetooth.service || true
sleep 2

systemctl restart bt-gpio.service
if [[ -f "$SCRIPT_DIR/ws-led-bridge.service" ]]; then
  systemctl restart ws-led-bridge.service || true
fi
if [[ -f "$SCRIPT_DIR/led-remote.service" ]]; then
  systemctl restart led-remote.service || true
fi
if [[ -f "$SCRIPT_DIR/led-matrix.service" && -f "$SCRIPT_DIR/matrix_server.py" ]]; then
  systemctl restart led-matrix.service || true
fi
sleep 2

echo "[4/7] 当前状态"
systemctl --no-pager status bt-gpio.service || true
echo "---"
journalctl -u bt-gpio.service -n 30 --no-pager || true

echo "[5/7] 蓝牙状态"
bluetoothctl show 2>/dev/null | grep -E "Controller|Address|Powered|Discoverable|Pairable" || true
hciconfig hci0 2>/dev/null | head -3 || true

echo "[6/7] LED 服务状态"
systemctl --no-pager status ws-led-bridge.service led-remote.service || true
if [[ -f /etc/systemd/system/led-matrix.service ]]; then
  echo "--- 点阵屏 ---"
  systemctl --no-pager status led-matrix.service || true
  journalctl -u led-matrix.service -n 20 --no-pager || true
fi

echo "[7/7] LED 共享 token"
LED_TOKEN_VALUE="$(cat "$TOKEN_FILE")"
echo "  token: $LED_TOKEN_VALUE"
echo "  文件: $TOKEN_FILE (root:$SVC_USER 640)"
echo "  在前端设置 → 蓝灯条 →「Pi 令牌」 里填上面这串"

cat <<EOF

================================================================
安装完成。守护进程已在后台运行。

下一步（PC 端）:
  - 在「设置 → 蓝灯条」里填上面的令牌 (必填, 否则连不上)
  - LED 服务已降权到 $SVC_USER 用户 (spec P1-11)

下一步（树莓派本机）:
  - 若想只让本机访问: 在桥的 systemd 单元里加 LED_WS_HOST=127.0.0.1,
    再用 nginx/Caddy 反向代理 (TLS + 白名单 + 连接数限制)
================================================================
EOF
