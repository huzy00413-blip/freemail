#!/usr/bin/env bash
set -euo pipefail
echo "=== freemail rebind-service 服务器初始化 ==="
echo "[1/6] 安装基础工具..."
apt-get update -y && apt-get install -y curl wget git ufw ca-certificates gnupg lsb-release
echo "[2/6] 安装 Docker..."
if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable docker && systemctl start docker
fi
echo "[3/6] 安装 Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
echo "[4/6] 配置防火墙..."
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 8080/tcp comment 'Mailpost'
ufw --force enable
echo "[5/6] 创建应用目录..."
mkdir -p /opt/freemail
echo "[6/6] 设置时区..."
timedatectl set-timezone Asia/Shanghai || true
echo "=== 初始化完成 ==="
echo "下一步："
echo "  cd /opt/freemail && git clone https://github.com/huzy00413-blip/freemail.git ."
echo "  cp .env.example .env && nano .env"
echo "  cp deploy/Caddyfile /etc/caddy/Caddyfile  # 修改域名"
echo "  docker compose -f docker-compose.rebind.yml up -d --build"
echo "  systemctl reload caddy"
