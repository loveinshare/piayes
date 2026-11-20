#!/usr/bin/env bash
# 生成 piano-follow 自签证书 (HTTPS + Web MIDI 需要的 secure context)
#
# 证书含 SAN, 覆盖:
#   IP  : 192.168.1.111 (局域网访问用的实际地址)
#   IP  : 127.0.0.1    (本机自测)
#   DNS : localhost
#   DNS : piano-follow.local (可选, 局域网 mDNS 名字)
#
# 用法: ./scripts/make-cert.sh [输出目录]
# 默认输出目录: ~/.config/piano-follow
set -euo pipefail

OUT_DIR="${1:-$HOME/.config/piano-follow}"
CERT="$OUT_DIR/cert.pem"
KEY="$OUT_DIR/key.pem"
DAYS=825   # 浏览器对自签证书的容忍上限 (Chrome 398 天), 留点余量

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

if [[ -f "$CERT" && -f "$KEY" ]]; then
  echo "证书已存在: $CERT"
  echo "如需重新生成, 先删除: rm -f $CERT $KEY"
  exit 0
fi

echo "=== 生成自签证书 -> $CERT ==="

# SAN 里的 IP 必须写实际 IP, 否则浏览器报 ERR_CERT_COMMON_NAME_INVALID
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$KEY" -out "$CERT" \
  -subj "/CN=piano-follow" \
  -addext "subjectAltName=IP:192.168.1.111,IP:127.0.0.1,DNS:localhost,DNS:piano-follow.local" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"

chmod 600 "$KEY"
chmod 644 "$CERT"

echo "=== 证书信息 ==="
openssl x509 -in "$CERT" -noout -subject -dates -ext subjectAltName

echo
echo "完成. 首次访问 https://192.168.1.111:8130 浏览器会提示证书不受信任,"
echo "点「高级 -> 继续前往」即可 (之后该站点算 secure context, Web MIDI 可用)."
