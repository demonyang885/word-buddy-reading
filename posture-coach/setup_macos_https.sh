#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew 未安裝，請先安裝：https://brew.sh"
  exit 1
fi
if ! command -v mkcert >/dev/null 2>&1; then
  brew install mkcert
fi
mkcert -install

IP="${1:-}"
if [[ -z "$IP" ]]; then IP="$(ipconfig getifaddr en0 2>/dev/null || true)"; fi
if [[ -z "$IP" ]]; then IP="$(ipconfig getifaddr en1 2>/dev/null || true)"; fi
if [[ -z "$IP" ]]; then
  echo "無法自動找到 LAN IP。用法：./setup_macos_https.sh 192.168.1.88"
  exit 1
fi

mkdir -p .cert
mkcert -cert-file .cert/cert.pem -key-file .cert/key.pem "$IP" localhost 127.0.0.1

echo "LAN IP: $IP"
echo "CA root: $(mkcert -CAROOT)/rootCA.pem"
echo "啟動：python3 serve_https.py"
echo "iPad： https://$IP:8443"
