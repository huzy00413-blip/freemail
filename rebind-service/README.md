# ChatGPT 换绑邮箱 HTTP 服务

将 [chatgpt-rebind-standalone](https://github.com/huzy00413-blip/chatgpt-rebind-standalone) 的 Python 纯协议脚本包装为 FastAPI 服务，供 freemail（Cloudflare Workers）通过 HTTP 调用。

## 安全特性

- **强制鉴权**：未设置 `REBIND_SERVICE_TOKEN` 时拒绝启动（fail-close）
- **默认本地监听**：`127.0.0.1:8000`，需通过反向代理（HTTPS/Cloudflare Tunnel）暴露
- **并发上限**：默认最多 3 个并发任务，防止资源耗尽
- **任务过期清理**：超过 24 小时的任务自动清理
- **幂等控制**：相同参数 60 秒内重复提交返回同一 task_id
- **限流**：每 IP 每分钟最多 30 个请求
- **严格脱敏**：状态接口不返回密码、TOTP、完整 bundle、收信 token、traceback

## 为什么需要独立服务

freemail 运行在 Cloudflare Workers（JavaScript 环境），而换绑脚本依赖：

- `curl-cffi`：C 扩展，用于模拟浏览器 TLS 指纹绕过反爬
- 复杂的多步 HTTP 协议（CSRF / Sentinel / OAuth / MFA）

以上均无法在 Workers 中运行。

## 目录结构

```
rebind-service/
├── server.py              # FastAPI 服务入口（v1.1.0）
├── requirements.txt       # Python 依赖（固定版本）
├── Dockerfile             # 容器化部署
├── README.md              # 本文件
├── rebind_core/           # （从 chatgpt-rebind-standalone 复制）
└── registration_core/     # （从 chatgpt-rebind-standalone 复制）
```

## 快速开始

### 1. 获取原脚本代码

```bash
cd rebind-service
git clone https://github.com/huzy00413-blip/chatgpt-rebind-standalone.git /tmp/rebind-src
cd /tmp/rebind-src && git checkout e27b3217dbfddab19e83dc57ab225173877e4663
cd -
cp -r /tmp/rebind-src/rebind_core .
cp -r /tmp/rebind-src/registration_core .
```

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 设置环境变量

```bash
# 必填：鉴权 token（未设置则拒绝启动）
export REBIND_SERVICE_TOKEN=$(openssl rand -hex 32)

# 可选
export REBIND_MAX_CONCURRENT=3       # 最大并发任务
export REBIND_TASK_TTL=86400         # 任务过期时间（秒）
export REBIND_OUT_DIR=./outputs/session_export
```

### 4. 启动服务

```bash
python server.py
# 默认监听 127.0.0.1:8000
```

### Docker 部署

```bash
docker build -t chatgpt-rebind-service .
docker run -d \
  --name rebind-service \
  --restart unless-stopped \
  -p 127.0.0.1:8000:8000 \
  -e REBIND_SERVICE_TOKEN="your-secret-token" \
  -v $(pwd)/outputs:/app/outputs \
  chatgpt-rebind-service
```

> **不要直接暴露 8000 端口到公网**。请通过 Nginx/Caddy 配置 HTTPS 反向代理，或使用 Cloudflare Tunnel。

## API 接口

### `POST /rebind`

提交换绑任务（后台异步执行）。需要 `Authorization: Bearer <token>`。

**请求体：**

```json
{
  "old_email": "old@example.com",
  "password": "your-password",
  "totp_secret": "BASE32SECRET",
  "new_email": "new@example.com",
  "mail_api": "https://freemail.example.com/rebind/inbox?token=xxx",
  "proxy": "",
  "mail_timeout": 180
}
```

**响应：**

```json
{ "task_id": "abc123...", "status": "pending" }
```

### `GET /rebind/{task_id}`

查询任务状态（脱敏返回）。

### `GET /health`

健康检查。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `REBIND_SERVICE_TOKEN` | **是** | - | 鉴权 token |
| `REBIND_CORE_DIR` | 否 | 脚本目录 | rebind_core 父目录 |
| `REBIND_OUT_DIR` | 否 | ./outputs/session_export | 输出目录 |
| `REBIND_MAX_CONCURRENT` | 否 | 3 | 最大并发任务 |
| `REBIND_TASK_TTL` | 否 | 86400 | 任务过期秒数 |
| `REBIND_IDEMPOTENCY_WINDOW` | 否 | 60 | 幂等窗口秒数 |
| `REBIND_RATE_LIMIT` | 否 | 30 | 每 IP 每分钟请求上限 |
| `REBIND_CORS_ORIGINS` | 否 | 空 | CORS 来源（逗号分隔） |
| `HOST` | 否 | 127.0.0.1 | 监听地址 |
| `PORT` | 否 | 8000 | 监听端口 |

## 安全提示

- 账号密码、TOTP 密钥仅在请求体中传输，**务必使用 HTTPS**
- `REBIND_SERVICE_TOKEN` 使用足够长的随机字符串（推荐 `openssl rand -hex 32`）
- 输出文件包含 session / access_token，妥善保管或定期清理
- 服务默认监听 `127.0.0.1`，如需远程访问请通过反向代理
