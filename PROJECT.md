# Freemail 临时邮箱 + ChatGPT 账号换绑系统 — 项目文档

> 最后更新：2026-08-27
> 仓库：https://github.com/huzy00413-blip/freemail （main 分支）
> Worker 地址：https://mailfree.1842068403.workers.dev
> 换绑服务：https://rebind.xiaobaikuzi.online
> 邮局系统：https://mail.xiaobaikuzi.online

---

## 一、项目概述和架构图

### 1.1 项目简介

Freemail 是一套临时邮箱 + ChatGPT 账号批量换绑系统，包含：

- **临时邮箱服务**：用户可生成随机邮箱地址，实时接收邮件（支持多域名、R2 存储 .eml 原件）
- **邮局管理系统**：独立的 TempMail/Maildrop 邮局，提供邮箱创建、管理、发件能力
- **ChatGPT 账号换绑**：将 ChatGPT 账号的绑定邮箱从旧邮箱更换为新邮箱，支持密码登录、TOTP 二次验证、代理池、验证码自动获取
- **批量换绑工具**：深色主题 Web 界面，支持批量导入账号/邮箱/代理，一键提交换绑队列，实时查看进度，导出结果

### 1.2 整体架构图

```
                              ┌─────────────────────────────┐
                              │        用户浏览器             │
                              │  (邮箱首页 / 批量换绑页面)     │
                              └──────────────┬──────────────┘
                                             │ HTTPS
                                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (freemail)                          │
│                     https://mailfree.1842068403.workers.dev               │
│                                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ 静态资源  │  │ 邮箱 API  │  │ 换绑 API  │  │ 代理 API  │  │ 管理 API   │  │
│  │ (ASSETS) │  │/api/...  │  │/api/rebind│  │/api/admin│  │/api/admin │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       │             │             │             │              │         │
│  ┌────▼─────────────▼─────────────▼─────────────▼──────────────▼─────┐  │
│  │                        D1 数据库 (mail_free_db)                    │  │
│  │  mailboxes / emails / users / mail_domains / rebind_tasks /       │  │
│  │  rebind_inbox_tokens / proxy_pool / external_inbox_accounts       │  │
│  └───────────────────────────────────┬───────────────────────────────┘  │
│                                      │                                  │
│  ┌───────────────────────────────────▼───────────────────────────────┐  │
│  │                     R2 存储 (mail-eml)                             │  │
│  │              邮件 .eml 原件、附件、profile 图片                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└──────────┬───────────────────┬──────────────────────┬───────────────────┘
           │                   │                      │
           │ ① 创建/查询邮箱     │ ② 提交换绑任务         │ ③ 拉取代理池
           │   收信 token       │   查询状态/取消        │   测试代理
           ▼                   ▼                      ▼
┌──────────────────┐  ┌──────────────────────┐  ┌──────────────────┐
│  邮局系统          │  │  rebind-service       │  │  代理池            │
│  (Mailpost)      │  │  (Python/FastAPI)     │  │  (socks5/http)   │
│  mail.xiaobaikuzi │  │  rebind.xiaobaikuzi   │  │  家宽代理          │
│  .online         │  │  .online:8000         │  │                  │
│                  │  │                       │  │                  │
│  /api/admin/...  │  │  POST /rebind         │  └──────────────────┘
│  /api/get_...    │  │  GET  /rebind/:id     │
│  /api/inbox/...  │  │  GET  /rebind         │
│                  │  │  POST /rebind/:id/... │
│  内置邮局邮箱      │  │  GET  /health         │
│  + 第三方域名      │  │  POST /admin/proxies  │
└──────────────────┘  └───────────┬───────────┘
                                  │
                                  │ ④ 登录 ChatGPT + 收验证码
                                  ▼
                          ┌──────────────────┐
                          │   ChatGPT / OpenAI │
                          │   auth.openai.com  │
                          └──────────────────┘
                                  │
                                  │ ⑤ 发送验证码邮件
                                  ▼
                          ┌──────────────────┐
                          │  旧/新邮箱收件箱    │
                          │  (freemail/邮局/   │
                          │   外部接码地址)     │
                          └──────────────────┘
```

### 1.3 请求流转说明

1. **邮箱生成**：浏览器 → Worker `/api/generate` → 优先调用邮局 API 创建邮箱 → 写入 D1 → 返回地址
2. **邮件接收**：发件方 → 邮局系统 / Cloudflare Email Routing → Worker 接收邮件 webhook → 解析 → 存 D1 + R2
3. **换绑任务提交**：浏览器 → Worker `/api/rebind/batch` → 解析接码配置 → 写入 D1 任务记录 → 逐个提交到 rebind-service `POST /rebind`
4. **换绑执行**：rebind-service 通过代理登录 ChatGPT → 触发邮箱变更 → 轮询 Worker `/rebind/old-inbox` 获取旧邮箱验证码 → 提交 → 轮询 `/rebind/new-inbox` 获取新邮箱验证码 → 完成
5. **状态查询**：浏览器轮询 Worker `/api/rebind/tasks` → Worker 代理到 rebind-service `GET /rebind` → 返回任务列表
6. **任务回调**：rebind-service 任务终态时回调 Worker `/rebind/task-terminal`（Bearer token 认证）→ 更新 D1 状态

---

## 二、各组件说明

### 2.1 freemail Worker（Cloudflare Worker）

| 项目 | 说明 |
|------|------|
| 技术栈 | Cloudflare Workers（原生 ES Modules）、Hono 框架 |
| 入口 | `src/index.js` |
| 数据库 | Cloudflare D1（`mail_free_db`） |
| 对象存储 | Cloudflare R2（`mail-eml`） |
| 静态资源 | `public/` 目录通过 ASSETS binding 直接服务 |
| 部署工具 | Wrangler v4 |
| 主要职责 | 邮箱 CRUD、邮件接收/解析/存储、用户认证（JWT）、换绑任务编排、代理池管理、静态页面服务 |

### 2.2 rebind-service（Python 换绑微服务）

| 项目 | 说明 |
|------|------|
| 技术栈 | Python 3.11、FastAPI、uvicorn、curl-cffi（TLS 指纹模拟） |
| 代码位置 | `rebind-service/server.py` |
| 核心引擎 | `rebind_core` / `registration_core`（从上游仓库 `chatgpt-rebind-standalone` 固定 commit 克隆，构建时打补丁） |
| 部署方式 | Docker 容器，Caddy 反向代理，仅监听 127.0.0.1:8000 |
| 并发控制 | 信号量控制最大并发（默认 3），超出排队（默认 10） |
| 认证 | Bearer Token（`REBIND_SERVICE_TOKEN`） |
| 主要职责 | 执行 ChatGPT 登录、TOTP 验证、邮箱变更流程、代理轮换、验证码轮询、Playwright/curl-cffi 浏览器自动化 |

### 2.3 邮局系统（Mailpost / TempMail）

| 项目 | 说明 |
|------|------|
| 地址 | https://mail.xiaobaikuzi.online |
| 技术栈 | 独立部署的 TempMail/Maildrop 系统（非本仓库代码） |
| 认证 | Admin Token（`MAILPOST_ADMIN_TOKEN`） |
| 主要职责 | 邮箱创建/删除/查询、邮件收发、邮箱 token 签发、发件 API |
| Worker 集成 | `src/api/mailpost.js` 代理邮局管理 API；`/api/generate` 和 `/api/create` 优先调用邮局创建邮箱 |

### 2.4 Caddy 反向代理

| 项目 | 说明 |
|------|------|
| 配置文件 | `deploy/Caddyfile` |
| 职责 | 自动 HTTPS 证书、反向代理到 127.0.0.1:8000、健康检查、安全头、访问日志、gzip/zstd 压缩 |
| 日志 | `/var/log/caddy/rebind.log`（JSON 格式，10MB 轮转，保留 5 份） |

### 2.5 D1 数据库

| 表名 | 用途 |
|------|------|
| `users` | 用户账号（admin/guest/普通用户） |
| `mailboxes` | 邮箱地址、域名、用户归属、登录权限、收藏、转发、置顶 |
| `emails` | 邮件元数据（发件人、主题、时间、R2 key） |
| `mail_domains` | 可用域名列表 |
| `rebind_tasks` | 换绑任务记录（task_id、旧/新邮箱、状态、幂等键） |
| `rebind_inbox_tokens` | 换绑收信短期 token（30 分钟过期，绑定 task_id） |
| `proxy_pool` | 代理池（加密存储 URL、scheme、状态、失败计数） |
| `external_inbox_accounts` | 外部接码地址绑定（邮箱 → 第三方接码 URL） |

迁移文件位于 `migrations/0001` ~ `0007_*.sql`。

### 2.6 R2 存储

- Bucket 名：`mail-eml`
- 存储内容：邮件 `.eml` 原件、附件、profile 图片
- 通过 Worker 的 `env.MAIL_EML` binding 访问

---

## 三、目录结构说明

```
freemail-deploy/
├── src/                          # Worker 后端源码
│   ├── index.js                  # Worker 入口，路由分发
│   ├── server.js                 # Hono 应用（备用入口）
│   ├── api/                      # API 处理模块
│   │   ├── index.js              # API 路由聚合
│   │   ├── helpers.js            # 通用工具（JWT、响应、权限校验）
│   │   ├── mailboxes.js          # 邮箱生成/创建/删除/列表（含邮局集成）
│   │   ├── mailpost.js           # 邮局系统 API 代理
│   │   ├── rebind.js             # 换绑 API（单个 + 批量 + 任务查询 + 取码测试）
│   │   ├── proxies.js            # 代理池管理 API
│   │   ├── emails.js             # 邮件查询/删除
│   │   ├── auth.js               # 登录/注册/会话
│   │   ├── admin.js              # 管理员 API
│   │   ├── external-inboxes.js   # 外部接码地址管理
│   │   └── ...
│   ├── routes/                   # 路由层
│   │   ├── api.js                # /api/* 路由
│   │   ├── static.js             # 静态资源路由
│   │   ├── rebind.js             # /rebind/* 收信回调路由
│   │   └── email.js              # 邮件 webhook 路由
│   └── utils/
│       ├── ssrf.js               # SSRF 防护（URL 校验、内网地址拦截）
│       └── ...
├── public/                       # 静态资源（通过 ASSETS binding 服务）
│   ├── html/
│   │   ├── rebind.html           # ★ 批量换绑工具页面（深色主题）
│   │   ├── login.html            # 登录页
│   │   └── ...
│   ├── js/
│   │   ├── mailboxes.js          # 邮箱管理页逻辑
│   │   ├── api.js                # 前端 fetch 封装
│   │   ├── core/
│   │   │   └── utils.js          # 前端工具（copyToClipboard 等）
│   │   └── modules/
│   │       ├── app/mailbox-actions.js  # 邮箱操作（含复制降级方案）
│   │       ├── mailboxes/        # 邮箱页模块化代码
│   │       └── ...
│   ├── css/                      # 样式文件
│   └── ...
├── rebind-service/               # Python 换绑微服务
│   ├── server.py                 # FastAPI 服务主文件
│   ├── Dockerfile                # 容器构建（含核心代码克隆+补丁）
│   ├── requirements.txt          # Python 依赖
│   ├── proxies.txt               # 代理列表（挂载到容器）
│   └── patches/                  # 核心代码补丁
│       ├── apply_dual_mailbox_otp.py
│       └── apply_initial_old_email_otp.py
├── deploy/                       # 部署配置
│   ├── Caddyfile                 # Caddy 反向代理配置
│   ├── deploy.md                 # 换绑服务部署指南
│   └── server-setup.sh           # 服务器初始化脚本
├── migrations/                   # D1 数据库迁移
│   ├── 0001_rebind_tables.sql
│   ├── 0002_mail_domains.sql
│   ├── 0003_proxy_pool.sql
│   ├── 0004_proxy_url_encryption.sql
│   ├── 0005_rebind_dual_inbox.sql
│   ├── 0006_external_inbox_accounts.sql
│   └── 0007_mailpost_integration.sql
├── docker-compose.rebind.yml     # rebind-service Docker Compose
├── wrangler.toml                 # Cloudflare Worker 配置
├── package.json                  # Node 依赖（hono、postal-mime、sendflare-sdk-ts）
└── .env.example                  # 换绑服务环境变量模板
```

---

## 四、完整部署流程

### 4.1 前置准备

1. **Cloudflare 账号**：已创建 D1 数据库、R2 bucket、Worker
2. **服务器**：Ubuntu 22.04 / Debian 12+，1 核 1GB+，开放 80/443 端口
3. **域名**：
   - Worker 使用 `*.workers.dev` 子域或自定义域
   - 换绑服务域名（如 `rebind.xiaobaikuzi.online`）解析到服务器 IP
   - 邮局域名（如 `mail.xiaobaikuzi.online`）
4. **邮局系统**：已部署 TempMail/Maildrop，获取 Admin Token

### 4.2 服务器初始化（rebind-service）

```bash
# SSH 登录服务器
cd /opt
git clone https://github.com/huzy00413-blip/freemail.git freemail
cd freemail
chmod +x deploy/server-setup.sh && ./deploy/server-setup.sh
# 脚本会安装 Docker、Caddy、配置防火墙、设置时区
```

### 4.3 配置换绑服务环境变量

```bash
cp .env.example .env

# 生成密钥
echo "REBIND_SERVICE_TOKEN=$(openssl rand -hex 32)" >> .env
echo "REBIND_CALLBACK_TOKEN=$(openssl rand -hex 32)" >> .env

# 编辑 .env，确认以下配置：
# WORKER_TASK_CALLBACK_URL=https://mailfree.1842068403.workers.dev/rebind/task-terminal
# REBIND_WORKER_API_BASE=https://mailfree.1842068403.workers.dev
# REBIND_MAX_CONCURRENT=3
# MAX_WAITING=10
nano .env
```

### 4.4 配置代理池

```bash
# 编辑代理列表（一行一个，支持 socks5://、http://）
nano rebind-service/proxies.txt
# 格式示例：
# socks5://user:pass@host:port
# http://user:pass@host:port
```

### 4.5 配置 Caddy

```bash
cp deploy/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile  # 将 rebind.your-domain.com 改为实际域名
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 4.6 启动换绑服务

```bash
docker compose -f docker-compose.rebind.yml up -d --build

# 验证
curl http://127.0.0.1:8000/health
curl https://rebind.xiaobaikuzi.online/health
# 应返回 {"status":"ok","ready":true,...}
```

### 4.7 配置 Worker Secrets

在本地项目目录执行（需要 Cloudflare API Token）：

```powershell
# Windows PowerShell
$env:CLOUDFLARE_API_TOKEN="你的 Cloudflare API Token"

npx wrangler secret put REBIND_SERVICE_URL
# 输入：https://rebind.xiaobaikuzi.online

npx wrangler secret put REBIND_SERVICE_TOKEN
# 输入：与服务器 .env 中一致

npx wrangler secret put REBIND_CALLBACK_TOKEN
# 输入：与服务器 .env 中一致

npx wrangler secret put MAILPOST_API_URL
# 输入：https://mail.xiaobaikuzi.online

npx wrangler secret put MAILPOST_ADMIN_TOKEN
# 输入：邮局 Admin Token
```

### 4.8 D1 数据库迁移

```powershell
# 查看数据库 ID（在 wrangler.toml 中已配置 database_name 和 database_id）
npx wrangler d1 execute mail_free_db --remote --file=migrations/0001_rebind_tables.sql
npx wrangler d1 execute mail_free_db --remote --file=migrations/0002_mail_domains.sql
npx wrangler d1 execute mail_free_db --remote --file=migrations/0003_proxy_pool.sql
npx wrangler d1 execute mail_free_db --remote --file=migrations/0004_proxy_url_encryption.sql
npx wrangler d1 execute mail_free_db --remote --file=migrations/0005_rebind_dual_inbox.sql
npx wrangler d1 execute mail_free_db --remote --file=migrations/0006_external_inbox_accounts.sql
npx wrangler d1 execute mail_free_db --remote --file=migrations/0007_mailpost_integration.sql
```

### 4.9 wrangler.toml 配置要点

```toml
name = "mailfree"
main = "src/index.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[vars]
ADMIN_NAME = "admin"
SESSION_EXPIRE_DAYS = "365"
MAIL_DOMAIN = "xiaobaikuzi.online"
WORKER_ORIGIN = "https://mailfree.1842068403.workers.dev"
# RESEND_API_KEY / SENDFLARE_API_KEY / CYBERPERSONS_API_KEY 为发件服务密钥

[[d1_databases]]
binding = "TEMP_MAIL_DB"
database_name = "mail_free_db"
database_id = "（实际 D1 数据库 ID）"

[[r2_buckets]]
binding = "MAIL_EML"
bucket_name = "mail-eml"

[assets]
directory = "./public"
binding = "ASSETS"
```

### 4.10 部署 Worker

```powershell
npx wrangler deploy
```

### 4.11 验证部署

```bash
# Worker 首页
curl https://mailfree.1842068403.workers.dev/

# 换绑页面（需登录后访问）
# 浏览器打开 https://mailfree.1842068403.workers.dev/html/rebind.html

# 换绑服务健康
curl https://rebind.xiaobaikuzi.online/health
```

---

## 五、环境变量和 Secrets 清单

### 5.1 Worker Secrets（通过 `wrangler secret put` 设置）

| Secret 名 | 说明 | 脱敏值示例 | 获取方式 |
|-----------|------|-----------|---------|
| `REBIND_SERVICE_URL` | 换绑服务地址 | `https://rebind.xiaobai***` | 服务器域名 + Caddy |
| `REBIND_SERVICE_TOKEN` | Worker ↔ rebind-service 共享密钥 | `b361c4a7dbca***` | `openssl rand -hex 32` |
| `REBIND_CALLBACK_TOKEN` | 换绑回调认证密钥 | `ad9aefe07c24***` | `openssl rand -hex 32` |
| `MAILPOST_API_URL` | 邮局系统 API 地址 | `https://mail.xiaobai***` | 邮局部署地址 |
| `MAILPOST_ADMIN_TOKEN` | 邮局管理员 Token | `admin123***` | 邮局系统配置 |
| `RESEND_API_KEY` | Resend 发件密钥 | `re_***` | Resend 控制台 |
| `SENDFLARE_API_KEY` | Sendflare 发件密钥 | `SF***` | Sendflare 控制台 |
| `CYBERPERSONS_API_KEY` | Cyberpersons 发件密钥 | `cp_***` | Cyberpersons 控制台 |

### 5.2 Worker 环境变量（wrangler.toml [vars]）

| 变量名 | 说明 | 当前值 |
|--------|------|--------|
| `ADMIN_NAME` | 管理员用户名 | `admin` |
| `SESSION_EXPIRE_DAYS` | JWT 会话有效期（天） | `365` |
| `MAIL_DOMAIN` | 主邮箱域名 | `xiaobaikuzi.online` |
| `WORKER_ORIGIN` | Worker 对外地址 | `https://mailfree.1842068403.workers.dev` |

### 5.3 rebind-service 环境变量（服务器 .env）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `REBIND_SERVICE_TOKEN` | 服务认证密钥（必填） | 无 |
| `REBIND_CALLBACK_TOKEN` | 回调认证密钥（必填） | 无 |
| `WORKER_TASK_CALLBACK_URL` | Worker 回调地址 | 无 |
| `REBIND_WORKER_API_BASE` | Worker API 基址 | 无 |
| `REBIND_MAX_CONCURRENT` | 最大并发换绑线程数 | `3` |
| `MAX_WAITING` | 最大排队任务数 | `10` |
| `REBIND_BUNDLE_TTL` | 任务结果保留时间（秒） | `3600` |
| `PROXY_DEFAULT_SCHEME` | 代理默认协议 | `socks5h` |
| `PROXY_POOL` | 代理池文件路径 | `@/app/proxies.txt` |
| `TZ` | 时区 | `Asia/Shanghai` |

---

## 六、API 接口文档

### 6.1 Worker API

#### 邮箱相关

**POST /api/generate** — 生成随机邮箱
- 响应：`{ "email": "abc123@xiaobaikuzi.online", "id": 123 }`
- 优先调用邮局 API 创建，失败则回退到本地 D1

**POST /api/create** — 创建指定用户名邮箱
- 请求：`{ "local": "myname", "domainIndex": 0 }`
- 响应：`{ "email": "myname@xiaobaikuzi.online" }`

**GET /api/mailboxes** — 邮箱列表（分页、搜索、筛选）
- 参数：`page`, `size`, `q`, `domain`, `login`, `favorite`, `forward`
- 响应：`{ "list": [...], "total": 100 }`

**DELETE /api/mailboxes?address=xxx** — 删除邮箱

**POST /api/mailboxes/login?address=xxx** — 允许/禁止登录

**POST /api/mailboxes/pin?address=xxx** — 置顶/取消置顶

**POST /api/mailboxes/reset-password?address=xxx** — 重置密码为默认

**POST /api/mailboxes/change-password** — 设置新密码
- 请求：`{ "address": "xxx", "password": "newpass" }`

**GET /api/mailbox/info?address=xxx** — 邮箱详情

#### 换绑相关

**GET /api/rebind/config** — 换绑功能配置（公开）
- 响应：`{ "enabled": true, "service_configured": true, "worker_origin": "https://..." }`

**GET /api/rebind/inbox-config?email=xxx** — 查询邮箱接码配置
- 响应：`{ "type": "freemail|mailpost|external|none", "inbox_url": "...", "description": "..." }`

**POST /api/rebind/start** — 创建单个换绑任务
- 请求：
```json
{
  "old_email": "old@example.com",
  "new_email": "new@example.com",
  "password": "xxx",
  "totp_secret": "BASE32SECRET"
}
```
- 响应：`{ "task_id": "abc123...", "status": "created", "old_inbox_type": "freemail", "new_inbox_type": "mailpost" }`

**POST /api/rebind/batch** — ★ 批量创建换绑任务（管理员）
- 请求：
```json
{
  "accounts": [
    { "old_email": "a@x.com", "password": "xxx", "totp_secret": "", "old_inbox_url": "" },
    { "old_email": "b@x.com", "password": "xxx", "totp_secret": "JBSWY3DPEHPK3PXP", "old_inbox_url": "" },
    { "old_email": "c@x.com", "password": "xxx", "old_inbox_url": "https://sms.example.com/code?email=c@x.com" }
  ],
  "mailboxes": [
    { "email": "new1@xiaobaikuzi.online", "inbox_url": "https://mail.xiaobaikuzi.online/api/inbox/..." },
    { "email": "new2@xiaobaikuzi.online", "inbox_url": "" }
  ]
}
```
- 响应：
```json
{
  "total": 3,
  "submitted": 2,
  "failed": 1,
  "results": [
    { "index": 0, "task_id": "abc...", "old_email": "a@x.com", "new_email": "new1@...", "ok": true, "status": "created" },
    { "index": 1, "task_id": "def...", "old_email": "b@x.com", "new_email": "new2@...", "ok": true, "status": "created" },
    { "index": 2, "ok": false, "error": "旧邮箱未配置接码地址" }
  ]
}
```
- 邮箱按轮询方式分配；单次最多 200 个账号；内联 inbox_url 经 SSRF 校验

**GET /api/rebind/tasks?limit=200** — ★ 获取所有任务状态（管理员）
- 代理到 rebind-service `GET /rebind`
- 响应：
```json
{
  "tasks": [
    {
      "task_id": "abc...",
      "status": "running",
      "created_at": "2026-08-27T10:00:00Z",
      "started_at": "2026-08-27T10:00:01Z",
      "finished_at": null,
      "params": { "old_email": "a***@x.com", "new_email": "n***@..." },
      "result": null,
      "error": null
    }
  ]
}
```
- 任务状态：`created`（排队）、`running`（运行中）、`waiting_code`（等待验证码）、`success`、`failed`、`cancelled`、`expired`
- 成功时 `result` 包含：`{ ok: true, old_email, new_email, session_email, access_token_masked }`

**GET /api/rebind/task/:id** — 查询单个任务状态

**POST /api/rebind/task/:id/cancel** — 取消任务

**POST /api/rebind/batch-cancel** — ★ 取消所有活跃任务（管理员）
- 响应：`{ "cancelled": 3, "task_ids": ["abc...", "def..."] }`

**GET /api/rebind/health** — 换绑服务健康状态
- 响应：`{ "ok": true, "status": "ok", "tasks": 0, "max_concurrent": 3, "proxy_total": 1, "proxy_available": 1, ... }`

**POST /api/rebind/test-inbox-url** — ★ 测试取码地址兼容性
- 请求：`{ "url": "https://example.com/code" }`
- 响应：
```json
{
  "ok": true,
  "status": 200,
  "content_type": "application/json",
  "code_found": true,
  "code_preview": "12***89",
  "snippet": "{\"code\":\"123456\"}..."
}
```
- 经 SSRF 校验，禁止内网地址；验证码脱敏返回

#### 代理池相关

**GET /api/admin/proxies** — 代理列表
**POST /api/admin/proxies/batch** — 批量保存代理
- 请求：`{ "proxies": "socks5://...\nhttp://..." }`
- 响应：`{ "added": 5, "failed": 0 }`

**POST /api/admin/proxies/test** — 测试全部代理连通性
- 响应：`{ "total": 5, "available": 4, "items": [{ "address": "host:port", "ok": true, "latency_ms": 320 }] }`

#### 收信回调（rebind-service 调用）

**GET /rebind/old-inbox?token=xxx&mailbox=xxx** — 旧邮箱收信
**GET /rebind/new-inbox?token=xxx&mailbox=xxx** — 新邮箱收信
**GET /rebind/mailpost-inbox?token=xxx&mailbox=xxx** — 邮局邮箱收信
**POST /rebind/task-terminal** — 任务终态回调（Bearer `REBIND_CALLBACK_TOKEN`）

### 6.2 rebind-service API

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/health` | 健康检查 | 无 |
| POST | `/rebind` | 创建换绑任务 | Bearer Token |
| GET | `/rebind?limit=N` | 列出任务 | Bearer Token |
| GET | `/rebind/:task_id` | 查询任务状态 | Bearer Token |
| POST | `/rebind/:task_id/cancel` | 取消任务 | Bearer Token |
| POST | `/admin/proxies/test` | 测试所有代理 | Bearer Token |
| POST | `/admin/proxies/refresh` | 刷新代理池 | Bearer Token |

**POST /rebind 请求体：**
```json
{
  "task_id": "abc123",
  "old_email": "old@example.com",
  "password": "xxx",
  "totp_secret": "BASE32SECRET",
  "new_email": "new@example.com",
  "old_mail_api": "https://worker/rebind/old-inbox",
  "old_inbox_token": "短期token",
  "new_mail_api": "https://worker/rebind/new-inbox",
  "new_inbox_token": "短期token",
  "mail_timeout": 180
}
```
外部邮箱场景使用 `old_inbox_url` / `new_inbox_url` 替代 `mail_api` + `token`。

### 6.3 邮局 API（Mailpost）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/mailboxes?search=xxx` | 搜索邮箱（Bearer Admin Token） |
| GET | `/api/admin/mailboxes/:id` | 邮箱详情（含 mailbox_key） |
| POST | `/api/admin/mailboxes` | 创建邮箱 |
| DELETE | `/api/admin/mailboxes/:id` | 删除邮箱 |
| POST | `/api/get_mailbox_token` | 获取邮箱访问 token |
| GET | `/api/inbox/messages` | 获取邮件列表 |

---

## 七、前端页面说明

| 页面路径 | 功能 |
|---------|------|
| `/` | 邮箱首页：生成邮箱、查看邮件、邮箱列表、收藏、转发、置顶 |
| `/html/login.html` | 登录页 |
| `/html/rebind.html` | ★ 批量换绑工具（深色主题） |
| `/html/mailboxes.html` | 全部邮箱管理：搜索、筛选、批量操作、改密 |
| `/html/admin.html` | 管理员面板：域名管理、用户管理、代理池、外部接码 |

### 7.1 批量换绑页面使用方法

1. **导入账号**：在左侧文本框粘贴账号（一行一个），支持四种格式：
   - `账号——密码——TOTP`
   - `账号——密码——接码地址`
   - `账号——接码地址`
   - `账号——接码地址——TOTP`
2. **导入新邮箱**：在中间文本框粘贴 `邮箱----接码地址`（一行一个）
3. **粘贴代理池**：在右侧文本框粘贴代理，支持 `host:port:user:pass`、`http://user:pass@host:port`、`socks5://...`，点击"保存代理池"
4. **测试连通性**：点击"测试全部连通性"验证代理可用性
5. **取码地址测试**：粘贴取码地址测试兼容性
6. **开始换绑**：点击"加入全局换绑队列"，系统自动分配邮箱并提交任务
7. **监控进度**：顶部统计栏实时显示账号/邮箱/代理数量、排队/运行/成功/失败数、全局线程和成功率
8. **导出结果**：成功后点击"导出成功账号"或"单独提取 AT"下载结果
9. **其他操作**：一键重试失败、停止任务、清空当前会话

**注意**：账号数据仅存储在浏览器内存中，刷新页面清空；日志中所有账号均脱敏显示。

---

## 八、运维手册

### 8.1 更新代码并部署

**Worker 更新：**
```powershell
cd freemail-deploy
git pull
$env:CLOUDFLARE_API_TOKEN="***"
npx wrangler deploy
```

**rebind-service 更新：**
```bash
cd /opt/freemail
git pull
docker compose -f docker-compose.rebind.yml up -d --build
```

### 8.2 查看日志

**Worker 实时日志：**
```powershell
npx wrangler tail
```

**rebind-service 日志：**
```bash
docker compose -f docker-compose.rebind.yml logs -f --tail=100
# 或
docker logs -f freemail-rebind
```

**Caddy 日志：**
```bash
journalctl -u caddy -f
tail -f /var/log/caddy/rebind.log
```

### 8.3 重启服务

```bash
# 重启换绑服务
docker compose -f docker-compose.rebind.yml restart

# 重启 Caddy
systemctl restart caddy
```

### 8.4 D1 数据库备份与恢复

```powershell
# 备份（导出 SQL）
npx wrangler d1 execute mail_free_db --remote --command "SELECT * FROM mailboxes" --json > backup_mailboxes.json
npx wrangler d1 execute mail_free_db --remote --command "SELECT * FROM users" --json > backup_users.json

# 或使用 wrangler 的导出功能
npx wrangler d1 export mail_free_db --remote --output backup.sql

# 恢复
npx wrangler d1 execute mail_free_db --remote --file=backup.sql
```

### 8.5 更新代理池

```bash
# 编辑代理文件
nano /opt/freemail/rebind-service/proxies.txt
# 重启服务使代理生效
docker compose -f docker-compose.rebind.yml restart
```

或通过批量换绑页面的"保存代理池"功能在线更新（Worker 会同步到 rebind-service）。

---

## 九、故障排查指南

| 问题 | 可能原因 | 解决方案 |
|------|---------|---------|
| `wrangler deploy` 失败 | API Token 无效或过期 | 重新设置 `$env:CLOUDFLARE_API_TOKEN`，确保 Token 有 Worker/D1/R2 编辑权限 |
| 邮箱创建失败 | 邮局 API 不可达或 Token 错误 | 检查 `MAILPOST_API_URL` / `MAILPOST_ADMIN_TOKEN` secret；`curl` 测试邮局 API |
| 换绑页面打不开（401） | 未登录或会话过期 | 先登录 Worker，再访问 `/html/rebind.html` |
| 换绑任务一直排队 | 并发线程已满 | 等待前序任务完成；调大 `REBIND_MAX_CONCURRENT`（需服务器性能支持） |
| 换绑任务卡在 waiting_code | 验证码未收到 | 检查邮箱接码配置：freemail 邮箱查 D1 emails 表；外部地址用"取码地址测试"验证 |
| 换绑任务失败：代理不通 | 代理失效或被封 | 在换绑页面点"测试全部连通性"；更换代理；检查 `proxies.txt` |
| 换绑任务失败：登录失败 | 密码错误 / TOTP 错误 / 账号被风控 | 核对账号密码和 TOTP；检查账号是否可正常登录 ChatGPT |
| `/health` 返回 502 | Docker 容器未运行 | `docker ps` 检查；`docker logs freemail-rebind` 查看错误 |
| HTTPS 证书失败 | DNS 未解析或 80 端口未开放 | 确认域名 A 记录指向服务器 IP；`ufw status` 检查防火墙；`caddy validate` |
| Worker 调用换绑服务超时 | 防火墙/Caddy 配置问题 | 服务器 `curl http://127.0.0.1:8000/health`；检查 Caddy 日志 |
| 复制邮箱按钮无效 | 非 HTTPS 环境 clipboard API 不可用 | 已添加 `document.execCommand('copy')` 降级方案；确保使用现代浏览器 |
| 批量提交报"旧邮箱未配置接码地址" | 旧邮箱既不在 freemail/邮局，也未提供内联接码地址 | 导入账号时使用"账号——接码地址"格式，或在外部接码管理中添加 |
| SSRF 校验拒绝取码地址 | 地址指向内网/保留 IP | 使用公网可访问的 URL；不允许 127.0.0.1、10.x、192.168.x 等内网地址 |
| D1 迁移失败 | 迁移已执行过或表已存在 | 检查是否重复执行；新环境按顺序执行 0001-0007 |

---

## 十、本次开发日志（2026-08-27）

### 10.1 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/api/rebind.js` | 修改 | 新增批量换绑 API（batch/tasks/health/test-inbox-url/batch-cancel）；引入 SSRF 校验 |
| `public/html/rebind.html` | 重写 | 从单个换绑页面重写为深色主题批量换绑工具（约 800 行） |
| `public/js/mailboxes.js` | 修改 | 修复一键复制：改用 `copyToClipboard` 工具函数（含 execCommand 降级） |
| `public/js/modules/app/mailbox-actions.js` | 修改 | 修复首页邮箱复制：添加 `execCommand('copy')` 降级方案 |
| `src/api/mailboxes.js` | 已有修改 | `/api/generate` 和 `/api/create` 优先调用邮局 API（本次部署前已改好） |

### 10.2 部署操作记录

1. **第一次部署**（仅 mailboxes.js 邮局集成）：
   - 语法检查：`node --check src/api/mailboxes.js` → 通过
   - 执行 `npx wrangler deploy` → 成功

2. **后端 API 开发**：
   - 在 `src/api/rebind.js` 新增 5 个端点
   - 语法检查：`node --check src/api/rebind.js` → 通过（修复了 JS 不支持 `(?i)` 内联正则标志的问题，改用 `/pattern/i`）

3. **前端页面开发**：
   - 重写 `public/html/rebind.html`，深色主题，12 项统计卡片、三导入区、任务控制栏、进度表格、邮箱/代理池、日志区
   - 提取内联 JS 做语法检查 → 通过
   - 修复两个 bug：代理测试日志中未定义变量 `it`；健康检查轮询逻辑错误（health 端点不返回运行数，改为同时拉取任务列表）

4. **复制功能修复**：
   - `mailboxes.js`：引入 `copyToClipboard`（core/utils.js 已有 execCommand 降级）
   - `mailbox-actions.js`：内联实现 clipboard API + execCommand 双重降级

5. **GitHub 推送**：
   - Commit 1: `src/api/rebind.js`（批量 API）
   - Commit 2: `public/html/rebind.html`（批量换绑页面）
   - Commit 3: `public/js/mailboxes.js` + `public/js/modules/app/mailbox-actions.js`（复制修复）
   - 仓库：huzy00413-blip/freemail，分支：main

6. **最终部署**：
   - 执行 `npx wrangler deploy` → 成功
   - 上传 3 个新/修改的静态资源：`/html/rebind.html`、`/js/mailboxes.js`、`/js/modules/app/mailbox-actions.js`
   - Worker 地址：https://mailfree.1842068403.workers.dev
   - Version ID: `5cefa8ec-72b5-4880-b2a1-51ccc3ff437d`

### 10.3 验证结果

| 验证项 | 结果 |
|--------|------|
| rebind.html 可访问（HTTP 200，40447 字节） | ✅ |
| 页面包含批量 UI 元素（btn-start、btn-import-accounts、/api/rebind/batch、test-inbox-url、st-accounts、logs） | ✅ |
| mailboxes.js 包含 copyToClipboard | ✅ |
| mailbox-actions.js 包含 execCommand 降级 | ✅ |
| rebind-service /health 正常（status:ok, max_concurrent:3, proxy_available:1） | ✅ |
| 后端 JS 语法检查全部通过 | ✅ |
| 前端内联 JS 语法检查通过 | ✅ |

### 10.4 已知问题和限制

1. **rebind-service 任务存储为内存态**：服务重启后任务历史丢失，全局统计（全站完成/成功率）会重置
2. **AT 仅返回脱敏值**：rebind-service 的 `_scrub` 函数对 access_token 做了脱敏，前端只能导出脱敏 AT
3. **批量页面账号数据在浏览器内存**：刷新页面清空（设计如此，避免敏感数据持久化）
4. **代理测试不区分"基础链路"和"ChatGPT 预检"**：rebind-service 的代理测试一次性测连通性，前端两列显示相同结果
5. **全局线程数显示**：`max_concurrent` 当前为 3（服务器配置），前端硬编码显示 `/30` 作为上限参考，实际以服务端 health 返回的 `max_concurrent` 为准
6. **健康检查 API 需要登录**：Worker 全局认证中间件对 `/api/` 路径要求登录，未登录时返回 401（浏览器端有会话 cookie，不影响使用）

---

## 十一、安全注意事项

1. **Secrets 管理**：
   - 所有 Token/密钥通过 `wrangler secret put` 设置，不写入代码或 wrangler.toml
   - 服务器 `.env` 文件已加入 `.gitignore`，禁止提交
   - 文档中所有密钥均脱敏显示

2. **敏感信息脱敏**：
   - 前端日志只显示掩码账号（如 `ab***cd@example.com`），不记录密码、TOTP、接码地址、代理密码、AT
   - rebind-service 返回的任务参数和结果经 `_scrub` 脱敏（密码、token、access_token 均掩码）
   - 取码地址测试返回的验证码脱敏（如 `12***89`）

3. **SSRF 防护**：
   - 所有外部接码 URL 经 `src/utils/ssrf.js` 校验，禁止内网/保留 IP 地址
   - 批量提交时内联 inbox_url 同样经过 SSRF 校验

4. **访问控制**：
   - 批量换绑 API（batch/tasks/batch-cancel）要求管理员权限（`isStrictAdmin`）
   - 单个换绑任务要求登录，非管理员只能查看自己的任务
   - rebind-service 所有写操作要求 Bearer Token
   - 任务回调要求 Bearer `REBIND_CALLBACK_TOKEN`

5. **HTTPS**：
   - Caddy 自动管理 TLS 证书，HSTS 头已启用
   - Worker 通过 `*.workers.dev` 默认 HTTPS

6. **短期 Token**：
   - 换绑收信 token 有效期 30 分钟，绑定 task_id，使用后即失效
   - JWT 会话默认 365 天过期

7. **代理凭证加密**：
   - D1 中代理 URL 经 AES-GCM 加密存储（migration 0004）
   - 前端代理列表不显示密码
