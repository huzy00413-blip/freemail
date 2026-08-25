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

## 代理池配置

### 代理格式

支持以下格式（每行一个，或逗号分隔）：

- `host:port:username:password` — 无 scheme 时默认按 `PROXY_DEFAULT_SCHEME` 补全
- `http://user:password@host:port`
- `https://user:password@host:port`
- `socks5://user:password@host:port`
- `socks5h://user:password@host:port`（**推荐**，DNS 解析也经由代理）

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_POOL` | 空 | 逗号分隔代理列表，或 `@/path/to/proxies.txt` 表示文件 |
| `PROXY_DEFAULT_SCHEME` | `socks5h` | 无 scheme 代理的默认协议 |
| `REBIND_MAX_PROXY_FAILURES` | 5 | 连续失败多少次后标记不可用 |
| `REBIND_PROXY_CHECK_TIMEOUT` | 5 | 代理连通性检查超时（秒） |
| `REBIND_PROXY_RECHECK_INTERVAL` | 300 | 不可用代理重新检查间隔（秒） |
| `REBIND_WORKER_API_BASE` | 自动推导 | Worker API 基址，用于从 D1 拉取代理池 |
| `REBIND_PROXY_REFRESH_INTERVAL` | 300 | 从 Worker 刷新代理池间隔（秒） |

### Render Secret File 配置

在 Render 控制台添加 Secret File：

- **Filename**: `/etc/secrets/proxies.txt`
- **Contents**: 每行一个代理，例如：
  ```
  socks5h://user:pass@proxy1.example.com:1080
  http://user:pass@proxy2.example.com:8080
  1.2.3.4:1080:myuser:mypass
  ```

然后设置环境变量 `PROXY_POOL=@/etc/secrets/proxies.txt`。

### Worker D1 代理池（推荐）

代理也可在 freemail 管理后台"代理池管理"页面添加，Python 服务会自动从 Worker API 拉取并每 5 分钟刷新，与文件代理合并去重。无需重新部署 Render 服务。

### 验证

访问 `/health` 确认：

```json
{
  "status": "ok",
  "proxy_pool_enabled": true,
  "proxy_total": 3,
  "proxy_available": 2
}
```

### 代理检测使用 curl_cffi

代理连通性检测使用 `curl_cffi.requests.Session`（与实际换绑请求相同的 libcurl TLS/SOCKS5 栈），测试 URL 为 `https://cloudflare.com/cdn-cgi/trace`。**不提供 requests 降级**——requests 检测成功不代表 curl_cffi 实际换绑成功。

- `socks5://` 自动归一化为 `socks5h://`（DNS 经由代理端）
- curl_cffi（libcurl）原生支持 SOCKS5，无需 PySocks
- curl_cffi 不可用且代理池启用时，服务启动失败（`sys.exit(1)`）
- `requests` 依赖保留：`mail_inbox` 收信轮询直连 Worker API，不走代理

### /health 的局限性

`/health` 返回 `status: ok` 只能证明当前实例进程健康，不代表重启恢复、批量刷新和真实换绑任务链路已验证。上线前请完成真实任务测试。

## 推荐上线顺序

1. **轮换代理凭据**（暴露过的凭据必须更换）
2. **部署 Worker**（`npx wrangler deploy`）
3. **部署 Render**（git push 触发 Docker 重建，等待 Live）
4. **检查 /health**：确认 `status: ok`、`proxy_pool_enabled: true`
5. **测试管理员接口权限**：非管理员访问 `/api/admin/proxies/*` 返回 401/403
6. **添加一条测试代理**：管理后台 → 代理池 → 添加 → 测试全部代理
7. **测试真实换绑任务**：确认登录/MFA/换绑/收信/回调全链路
8. **检查日志、D1 状态和代理释放**：无敏感信息、任务状态正确、代理已释放
9. **再批量导入正式代理**

## 安全提示

- 账号密码、TOTP 密钥仅在请求体中传输，**务必使用 HTTPS**
- `REBIND_SERVICE_TOKEN` 使用足够长的随机字符串（推荐 `openssl rand -hex 32`）
- 输出文件包含 session / access_token，妥善保管或定期清理
- 服务默认监听 `127.0.0.1`，如需远程访问请通过反向代理
- 代理凭据（用户名/密码）绝不返回前端，管理接口只显示 `host:port`
- 代理池刷新失败时保留旧池不清空；启动时拉取失败且无备用代理则拒绝启动
