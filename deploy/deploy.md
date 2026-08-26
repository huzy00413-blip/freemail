# rebind-service 自托管部署指南

## 服务器要求
- Ubuntu 22.04 / Debian 12+，1 核 1GB+，可访问外网，开放 80/443
- 一个已解析到服务器 IP 的域名（如 rebind.xiaobaikuzi.online）

## 一、初始化服务器
```bash
cd /opt && git clone https://github.com/huzy00413-blip/freemail.git freemail
cd freemail
chmod +x deploy/server-setup.sh && ./deploy/server-setup.sh
```

## 二、配置环境变量
```bash
cp .env.example .env
echo "REBIND_SERVICE_TOKEN=$(openssl rand -hex 32)" >> .env
echo "REBIND_CALLBACK_TOKEN=$(openssl rand -hex 32)" >> .env
nano .env  # 确认配置
```

## 三、配置 Caddy
```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile  # 改为实际域名
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

## 四、启动服务
```bash
docker compose -f docker-compose.rebind.yml up -d --build
curl http://127.0.0.1:8000/health
curl https://rebind.your-domain.com/health
```

## 五、更新 Worker 配置
```powershell
npx wrangler secret put REBIND_SERVICE_URL   # https://rebind.your-domain.com
npx wrangler secret put REBIND_SERVICE_TOKEN  # 与 .env 一致
npx wrangler secret put REBIND_CALLBACK_TOKEN # 与 .env 一致
npx wrangler deploy
```

## 六、更新部署
```bash
cd /opt/freemail && git pull
docker compose -f docker-compose.rebind.yml up -d --build
```

## 七、运维
```bash
docker compose -f docker-compose.rebind.yml logs -f --tail=100
docker compose -f docker-compose.rebind.yml restart
journalctl -u caddy -f
```

## 八、故障排查
| 问题 | 排查 |
|------|------|
| /health 502 | docker ps 检查容器状态 |
| HTTPS 证书失败 | 确认 80 端口开放、DNS 已解析 |
| Worker 调用超时 | 检查防火墙、Caddy 配置 |
| 代理池为空 | 确认 Worker /rebind/proxies 可访问 |
