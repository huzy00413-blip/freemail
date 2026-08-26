# ChatGPT 换绑邮箱功能集成说明 v2.4.0（Render 部署版）

## 一、架构概览

```
用户浏览器
    │
    ▼
freemail Worker (Cloudflare)
    ├── /html/rebind.html              前端页面（含取消按钮，无代理输入）
    ├── /api/rebind/start              提交任务（登录+权限校验）
    ├── /api/rebind/status/:id         查询状态（归属校验+脱敏）
    ├── /api/rebind/cancel/:id         取消任务（归属校验）
    ├── /api/rebind/config             可用性检测（字段级 schema 校验）
    ├── /rebind/old-inbox              旧邮箱验证码收信端点
    ├── /rebind/new-inbox              新邮箱验证码收信端点
    └── /rebind/task-terminal          Python 终态回调（撤销 token，Bearer 鉴权）
    │ HTTPS + Bearer Token
    ▼
Python 换绑服务 (Render Docker, FastAPI v2.3.0)
    ├── POST /rebind                   提交（鉴权+限流+并发+等待队列）
    ├── GET  /rebind/:id               查询（脱敏）
    ├── POST /rebind/:id/cancel        取消（释放线程+代理+临时文件）
    ├── GET  /health                   健康检查（含代理池状态）
    └── 代理池（连通性检查+失败计数+空池503+任务内领取）
```

### 任务状态机

`created → running → waiting_code → success / failed / cancelled / expired`

### 安全设计

- 仅管理员或邮箱拥有者可发起；guest 禁止
- task_id 绑定用户，状态/取消均校验归属
- 收信 token 绑定 user+mailbox+task，仅 header 传输，原子次数限制
- **Python 终态主动回调 Worker 撤销 token**（不依赖前端轮询）
- Python 服务强制 token（未设置拒绝启动）
- 代理由 Render Secret File 配置；**代理在取得 semaphore 后才领取**，避免泄漏
- 每任务独立目录 `outputs/<task_id>/`，结束后 `shutil.rmtree`
- 状态接口过滤敏感字段；代理只显示 host:port
- 并发上限 3 + 等待队列上限 10；启动清理残留目录
- config 端点检查**字段完整性**（PRAGMA table_info），缺字段即禁用
- Docker 构建阶段从上游 clone 固定 commit，核心代码不提交 freemail 仓库

---

## 二、文件清单

| 文件 | 说明 |
|------|------|
| `rebind-service/server.py` | FastAPI v2.3.0（代理任务内领取+终态回调+取消） |
| `rebind-service/requirements.txt` | Python 依赖（固定版本） |
| `rebind-service/Dockerfile` | 容器化（构建阶段 clone 核心代码） |
| `rebind-service/.gitignore` | 排除 .env、proxies.txt、outputs、核心代码、__pycache__ |
| `src/api/rebind.js` | Worker API（字段级 schema 校验+serviceToken 检查） |
| `src/routes/rebind.js` | 收信端点 + **终态回调端点** |
| `src/db/init.js` | 表结构（仅建表，字段迁移走显式文件） |
| `migrations/0001_rebind_tables.sql` | **显式迁移文件**（建表+字段补全指引） |
| `public/html/rebind.html` | 前端（无代理输入+取消按钮+XSS转义） |
| `d1-init.sql` | D1 初始化（全部 IF NOT EXISTS） |
| `wrangler.toml` | WORKER_ORIGIN 为普通变量；敏感变量走 secret |

---

## 三、环境变量参考

### Render 服务（Environment 变量）

| 变量 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `REBIND_SERVICE_TOKEN` | ✅ | - | 鉴权 token，未设置拒绝启动 |
| `REBIND_CALLBACK_TOKEN` | ✅ | - | 终态回调鉴权 token，与 Worker 一致 |
| `WORKER_TASK_CALLBACK_URL` | ✅ | - | Worker 回调地址，如 `https://xxx.workers.dev/rebind/task-terminal` |
| `REBIND_MAX_CONCURRENT` | ❌ | 3 | 最大并发（兼容 `MAX_CONCURRENT`） |
| `REBIND_MAX_WAITING` | ❌ | 10 | 等待队列上限（兼容 `MAX_WAITING`） |
| `REBIND_TASK_TTL` | ❌ | 86400 | 任务内存保留秒数 |
| `REBIND_RATE_LIMIT` | ❌ | 30 | 每IP每分钟上限 |
| `PROXY_POOL` | ❌ | - | 代理池，如 `@/etc/secrets/proxies.txt`；不设则直连 |
| `REBIND_MAX_PROXY_FAILURES` | ❌ | 5 | 代理连续失败上限 |

### Render Secret File（代理池）

| 文件名 | 挂载路径 | 说明 |
|--------|----------|------|
| `proxies.txt` | `/etc/secrets/proxies.txt` | 每行一个代理 URL，含用户名密码 |

### Cloudflare Worker

**普通变量（wrangler.toml [vars]）：**

| 变量 | 说明 |
|------|------|
| `WORKER_ORIGIN` | Worker 公网地址（非机密，已在 wrangler.toml 配置） |

**Secrets（通过 `wrangler secret put` 设置）：**

| 变量 | 必填 | 说明 |
|------|------|------|
| `JWT_TOKEN` | ✅ | JWT签名密钥+root admin token，必须强随机且轮换 |
| `ADMIN_PASSWORD` | ✅ | 管理员登录密码，必须强随机且轮换 |
| `REBIND_SERVICE_URL` | ✅ | Render 服务 HTTPS 地址 |
| `REBIND_SERVICE_TOKEN` | ✅ | 与 Render 端一致 |
| `REBIND_CALLBACK_TOKEN` | ✅ | 与 Render 端一致 |
| `PROXY_ENCRYPTION_KEY` | 使用代理池时必填 | D1 代理凭据 AES-GCM 加密密钥 |
| `GUEST_PASSWORD` | ❌ | 访客密码；不设置则禁用访客登录 |

> `GUEST_PASSWORD` 在 `src/routes/auth.js` 中使用。访客被换绑功能禁止。如不需要可不设置。

---

## 四、Render 部署步骤（Windows PowerShell）

### 步骤 1：本地提交代码

先检查敏感文件：

```powershell
# 在 freemail 根目录执行
rg -n "JWT_TOKEN|GUEST_PASSWORD|REBIND_SERVICE_TOKEN|REBIND_CALLBACK_TOKEN|PROXY_POOL|https?://[^ ]*:[^ ]*@" -g "!node_modules" -g "!*.lock" .
```

确认无敏感信息后，检查忽略规则并提交：

```powershell
git status --ignored
git diff --cached
git add .
git commit -m "feat: deploy rebind service to Render v2.3"
git push origin main
```

> 若 GitHub Actions 配置了 Worker 自动部署，此时只会部署 Worker。Python 服务需在 Render 单独创建。

### 步骤 2：在 Render 创建 Web Service

Render 控制台：

1. **New → Web Service**
2. 连接 freemail GitHub 仓库
3. **Branch**: `main`
4. **Runtime**: `Docker`
5. **Root Directory**: `rebind-service`
6. **Health Check Path**: `/health`
7. 选择**不会自动休眠**的实例类型
8. 点击创建

Dockerfile 构建时自动从上游 clone 固定 commit 的 `rebind_core/` 和 `registration_core/`。

创建后 Render 生成服务 URL，例如：`https://freemail-rebind.onrender.com`

### 步骤 3：设置 Render 环境变量

在 Render 服务的 **Environment** 中添加：

| Key | Value |
|-----|-------|
| `REBIND_SERVICE_TOKEN` | `<随机 32 字节以上 token>` |
| `REBIND_CALLBACK_TOKEN` | `<随机 32 字节以上 token>` |
| `WORKER_TASK_CALLBACK_URL` | `https://mailfree.1842068403.workers.dev/rebind/task-terminal` |
| `REBIND_MAX_CONCURRENT` | `3` |
| `REBIND_MAX_WAITING` | `10` |

生成 token（PowerShell，C# RandomNumberGenerator）：

```powershell
$token = -join ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32) | % { $_.ToString('x2') })
Write-Output $token
```

> `REBIND_SERVICE_TOKEN` 和 `REBIND_CALLBACK_TOKEN` 应分别生成不同的值。

### 步骤 4：通过 Render Secret File 配置代理池

在 **Environment → Secret Files** 中新增：

- **Filename**: `proxies.txt`
- **Mount path**: `/etc/secrets/proxies.txt`
- **内容**（每行一个代理）：
  ```
  http://username:password@host1:port
  http://username:password@host2:port
  ```

然后在 **Environment 变量**中添加：

| Key | Value |
|-----|-------|
| `PROXY_POOL` | `@/etc/secrets/proxies.txt` |

> 如不需要代理（直连），跳过此步骤。

### 步骤 5：验证 Render 服务

```powershell
Invoke-RestMethod "https://freemail-rebind.onrender.com/health"
```

确认结果：

```json
{
  "status": "ok",
  "rebind_core_loaded": true,
  "proxy_pool_enabled": true,
  "proxy_total": 2,
  "proxy_available": 2,
  "auth_required": true
}
```

> `proxy_available` 为 0 时不要继续。代理在任务取得 semaphore 后才领取，空池时任务会 failed。

### 步骤 6：配置 Cloudflare Worker Secrets

在 freemail 项目目录：

```powershell
# JWT_TOKEN（必须轮换，旧值曾硬编码在代码中）
$jwt = -join ([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32) | % { $_.ToString('x2') })
Write-Output "JWT_TOKEN = $jwt"
npx wrangler secret put JWT_TOKEN
npx wrangler secret put ADMIN_PASSWORD

npx wrangler secret put REBIND_SERVICE_TOKEN
# 与 Render 完全一致

npx wrangler secret put REBIND_CALLBACK_TOKEN
# 与 Render 完全一致

npx wrangler secret put REBIND_SERVICE_URL
# https://freemail-rebind.onrender.com

npx wrangler secret put PROXY_ENCRYPTION_KEY
# 使用代理池时设置；不使用代理池也可暂不设置
```

确认是否需要访客密码：

```powershell
rg -n "GUEST_PASSWORD" src
```

若需要：
```powershell
npx wrangler secret put GUEST_PASSWORD
```

> `WORKER_ORIGIN` 已在 wrangler.toml [vars] 中配置为普通变量，**不需要** `wrangler secret put`。

### 步骤 7：迁移 D1 后部署 Worker

**先检查远程数据库字段：**

```powershell
npx wrangler d1 execute mail_free_db --remote --command "PRAGMA table_info(rebind_inbox_tokens);"
npx wrangler d1 execute mail_free_db --remote --command "PRAGMA table_info(rebind_tasks);"
```

若已有 `rebind_tasks` 缺少 `idempotency_key`，先补列。新数据库跳过此命令：

```powershell
npx wrangler d1 execute mail_free_db --remote --command "ALTER TABLE rebind_tasks ADD COLUMN idempotency_key TEXT;"
```

**再执行显式迁移（建表及索引部分安全）：**

```powershell
npx wrangler d1 execute mail_free_db --remote --file .\migrations\0001_rebind_tables.sql
```

> 迁移文件中的 ALTER TABLE 语句已注释。如 PRAGMA 显示缺少字段，先手动执行对应的 ALTER TABLE，再执行迁移文件（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。

如果 `PRAGMA table_info(rebind_inbox_tokens);` 显示缺少 `mailbox_type`，再单独执行：

```powershell
npx wrangler d1 execute mail_free_db --remote --file .\migrations\0005_rebind_dual_inbox.sql
```

**确认字段完整：**

```powershell
npx wrangler d1 execute mail_free_db --remote --command "PRAGMA table_info(rebind_inbox_tokens);"
```

`rebind_inbox_tokens` 应包含：`token, user_id, mailbox_id, task_id, expires_at, used_count, max_uses, baseline_message_id, baseline_received_at, mailbox_type, revoked`。`mailbox_type` 为 `old` 或 `new`（历史旧 token 默认 `new`）。
`rebind_tasks` 还必须包含：`task_id, user_id, status, updated_at, idempotency_key`，并存在 `idx_rebind_tasks_active_idempotency` 唯一索引。

**二选一部署 Worker（不要同时执行）：**

方式 A（GitHub Actions）：
```powershell
git push origin main
# 等待 Actions 完成
```

方式 B（手动）：
```powershell
npx wrangler deploy
```

### 步骤 8：端到端验证

访问 `https://mailfree.1842068403.workers.dev/html/rebind.html`，测试：

1. 创建任务 → 状态 `created` → `running` → `waiting_code`
2. 取消任务 → 状态 `cancelled`
3. Render 日志无代理用户名/密码/cookie/验证码明文
4. 任务目录被删除（Render 日志显示 `[cleanup] 已删除任务目录`）
5. 终态后 `rebind_inbox_tokens.revoked = 1`（**Python 主动回调，不依赖前端**）：
   ```powershell
   npx wrangler d1 execute mail_free_db --remote --command "SELECT token, task_id, revoked, used_count FROM rebind_inbox_tokens ORDER BY created_at DESC LIMIT 5"
   ```
6. `/api/rebind/config` 返回 `enabled: true`

---

## 五、验证状态

### 5.1 已通过的静态检查（开发环境完成）

| 检查项 | 方法 | 结果 |
|--------|------|------|
| Python 语法 | `python -m py_compile server.py` | ✅ 通过 |
| Worker JS 语法 | `node --check src/api/rebind.js` | ✅ 通过 |
| Worker JS 语法 | `node --check src/routes/rebind.js` | ✅ 通过 |
| Worker JS 语法 | `node --check src/db/init.js` | ✅ 通过 |
| 代理池泄漏逻辑 | 代码审查：create_rebind_task 不领取代理，_run_task semaphore 后领取，finally 释放 | ✅ 通过 |
| 创建时序逻辑 | 代码审查：Worker 预生成 task_id → 写 token → 写 rebind_tasks → 调 Python，失败回滚 | ✅ 通过 |
| 终态回调逻辑 | 代码审查：_run_task finally + _cleanup_expired_tasks 均调用 _notify_worker_terminal | ✅ 通过 |
| fail-close 逻辑 | 代码审查：config 后统一拦截 tables.ok + serviceToken | ✅ 通过 |
| schema 校验逻辑 | 代码审查：PRAGMA table_info 检查 11 个必需字段 | ✅ 通过 |
| 敏感信息扫描 | `rg` 搜索代码中无明文密钥、代理密码 | ✅ 通过 |

### 5.2 待 Render 测试环境验证（8项，上线前必须通过）

> 以下项目需要真实上游核心代码、Render 运行环境和 D1 数据库才能验证，目前尚未执行。

#### 测试 1：重复提交不消耗代理

**操作**：用相同参数连续提交 3 次任务（命中幂等），观察 `/health` 的 `proxy_available`

**预期**：`proxy_available` 不下降。代理在 `_run_task` 取得 semaphore 后才领取，幂等直接返回不占用代理。

#### 测试 2：队列满不消耗代理

**操作**：设置 `REBIND_MAX_WAITING=1`，提交 2 个任务使第 2 个返回 429，观察 `proxy_available`

**预期**：`proxy_available` 不下降。队列满在领取代理之前判断。

#### 测试 3：四种终态各执行一次

**操作**：分别触发 success（正常完成）、failed（错误密码）、cancelled（主动取消）、expired（等待超时）

**预期**：每种终态后：
- Python 任务状态正确
- `outputs/<task_id>/` 目录被删除
- Render 日志显示 `[callback] 已通知 Worker 终态`

#### 测试 4：终态后 token 立即撤销（不依赖前端）

**操作**：任务进入终态后，**不打开前端页面**，直接查询 D1：

```powershell
npx wrangler d1 execute mail_free_db --remote --command "SELECT revoked FROM rebind_inbox_tokens WHERE task_id = '<任务ID>'"
```

**预期**：`revoked = 1`。Python 通过 `WORKER_TASK_CALLBACK_URL` 主动调用 `/rebind/task-terminal` 撤销。

#### 测试 5：Render 重启后旧任务处理

**操作**：Render 重启服务后，查询重启前的任务状态

**预期**：旧任务不在内存中（返回 404 或显示已过期），`outputs/` 目录在启动时被清理。

#### 测试 6：收信请求带 X-Rebind-Token 且取消能中断

**操作**：创建任务后，在 `waiting_code` 状态时取消，观察 Worker `/rebind/old-inbox` 或 `/rebind/new-inbox` 日志和 Python 日志

**预期**：
- Worker 收信端点收到 `X-Rebind-Token` header（不在 URL 中）
- 取消后 Python 日志显示 `[task <id>] 已取消`，收信轮询停止
- monkey-patch 的 `requests.get` 在收信时注入 token 并检查 cancel_event

#### 测试 8：旧邮箱验证码链路

**操作**：使用一个会在登录响应返回 `email_otp_verification` 的账号执行换绑。

**预期**：旧邮箱收到登录验证码并被 `/rebind/old-inbox` 读取；换绑开始后新邮箱验证码被 `/rebind/new-inbox` 读取；不能用新 token 访问旧端点。

#### 测试 7：上游代码收信确实经过 requests.get（关键）

**操作**：在 Render 构建日志中确认核心代码 commit，在 `_patched_requests_get` 中临时添加 `print` 日志，创建任务观察

**预期**：收信轮询时日志输出 `has_token=True is_inbox=True`，证明上游 `mail_inbox.py` 的收信调用确实经过被 patch 的 `requests.get`。

> **注意**：测试 6、7 依赖上游 `chatgpt-rebind-standalone` 固定 commit 的实际收信实现。如果上游代码使用了 `httpx` 或其他 HTTP 库而非 `requests`，monkey-patch 将不生效，需要调整方案。

---

## 六、运行环境说明

- **Render 托管后**：本地电脑和 Docker Desktop 不需要持续运行
- **需要持续运行**：Render 的 Web Service（选择不休眠实例）
- **本地开发**：可直接 `python server.py`（默认 127.0.0.1）或 Docker 构建测试
- **Render 构建**：Dockerfile 自动 clone 上游核心代码，无需手动复制

---

## 七、上线前最终检查清单

- [ ] Render `/health` 返回 `status: ok`，`proxy_available > 0`（如使用代理）
- [ ] `REBIND_SERVICE_TOKEN` 在 Render 和 Worker 两端一致
- [ ] `REBIND_CALLBACK_TOKEN` 在 Render 和 Worker 两端一致
- [ ] `WORKER_TASK_CALLBACK_URL` 指向正确的 Worker 地址
- [ ] `JWT_TOKEN` 已轮换
- [ ] 代理池通过 Secret File 配置
- [ ] D1 字段完整（PRAGMA 确认 10 个必需字段）
- [ ] `/api/rebind/config` 返回 `enabled: true`
- [ ] Worker 部署方式二选一，无重复部署
- [ ] 第五节 5.2 的 8 项真实环境测试全部通过
- [ ] Render 日志无敏感信息明文
- [ ] 终态后 token 自动撤销（不依赖前端轮询）

---

## 八、上线加固说明（v2.1）

### 8.1 /health 的局限性

`/health` 返回 `status: ok` **只能证明当前实例进程健康**，不代表以下环节已验证：

- 服务重启后代理池能否成功从 Worker 恢复（启动时 fail-fast，拉取失败会拒绝启动）
- 代理批量刷新链路（Worker → Python 服务）是否正常
- 真实换绑任务全链路（登录 → MFA → 换绑 → 收信 → 回调）是否正常
- 代理在 curl_cffi（实际换绑请求栈）下是否真正可用

上线前必须完成下方推荐顺序中的真实任务测试。

### 8.2 代理检测使用 curl_cffi（无 requests 降级）

代理连通性检测使用 `curl_cffi.requests.Session`，与实际换绑请求使用相同的 libcurl TLS/SOCKS5 栈。**不提供 requests 降级**——requests 检测成功不代表 curl_cffi 实际换绑成功。

- 测试 URL：`https://cloudflare.com/cdn-cgi/trace`（验证出口 IP）
- `socks5://` 自动归一化为 `socks5h://`（DNS 经由代理端）
- curl_cffi 不可用且代理池启用时，服务启动失败（`sys.exit(1)`）
- `requests` 依赖保留（`mail_inbox` 收信轮询使用，直连 Worker 不走代理）

### 8.3 代理池状态管理

| 层级 | 存储 | 内容 |
|------|------|------|
| D1（管理状态） | Cloudflare D1 `proxy_pool` 表 | 代理配置、enabled/disabled、last_check_status、fail_count |
| Render 内存（运行时） | Python 进程内存 | in_use 标记、实时可用性、last_check 时间戳 |

- 启动时**同步**从 Worker `/rebind/proxies` 拉取，失败且无文件代理备用时拒绝启动
- 定时刷新（5 分钟）采用"新池校验成功后原子替换"：拉取失败保留旧池，不清空
- Worker 只返回 `enabled=1` 的代理；D1 中禁用的代理不会进入内存池
- Render 重启后内存池清空，必须重新从 Worker 拉取恢复
- 连续失败 3 次（管理接口测试）或 5 次（任务失败）自动禁用

### 8.4 任务代理固定

每个换绑任务在获取信号量后调用一次 `_acquire_proxy()` 获取代理，**全程使用同一代理**，不中途切换。无论成功、失败还是取消，代理都在 `finally` 块中释放。

### 8.5 推荐上线顺序

1. **轮换代理凭据**（此前对话中暴露过的凭据必须更换）
2. **部署 Worker**（`npx wrangler deploy`）
3. **部署 Render**（git push 触发 Docker 重建，等待 Live）
4. **检查 /health**：`curl https://<render-url>/health`，确认 `status: ok`、`proxy_pool_enabled: true`
5. **测试管理员接口权限**：非管理员（未登录/guest）访问 `/api/admin/proxies/*` 返回 401/403
6. **添加一条测试代理**：通过管理后台代理池页面添加，点击"测试全部代理"确认可用
7. **测试真实换绑任务**：使用真实账号完成一次换绑，确认登录/MFA/换绑/收信/回调全链路
8. **检查日志、D1 状态和代理释放**：Render 日志无敏感信息，D1 任务状态正确，代理 in_use 已释放
9. **再批量导入正式代理**：单条验证通过后，通过"批量添加"导入正式代理池

### 8.6 安全提醒

- 代理凭据（用户名/密码）绝不返回前端，列表只显示 `host:port`
- 批量添加错误信息只显示行号和原因，不回显完整代理行
- Python 服务接口用 `REBIND_SERVICE_TOKEN` Bearer 鉴权
- 所有管理接口严格校验管理员身份（root），非管理员返回 403
