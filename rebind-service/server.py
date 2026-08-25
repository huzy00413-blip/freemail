#!/usr/bin/env python3
"""
ChatGPT 换绑邮箱 HTTP 服务（FastAPI）v2.0.0

将 chatgpt-rebind-standalone 的纯协议流程包装为 REST API：
  POST /rebind                  提交换绑任务，返回 task_id（后台异步执行）
  GET  /rebind/{task_id}        查询任务状态与结果
  POST /rebind/{task_id}/cancel 取消任务
  GET  /health                  健康检查

安全设计：
  - 强制要求 REBIND_SERVICE_TOKEN，未设置则拒绝启动（fail-close）
  - 默认监听 127.0.0.1，需通过反向代理（HTTPS/Cloudflare Tunnel）暴露
  - 并发上限 + 等待队列上限，防止资源耗尽
  - 每个任务独立输出目录，结束后立即 shutil.rmtree 清理
  - 代理池由服务端配置，不接受前端任意代理
  - 任务可取消（通过 threading.Event + requests.get 中断点）
  - 敏感字段严格脱敏，状态接口不返回密码/TOTP/cookie/代理凭据/bundle
  - 启动时清理 outputs 残留目录

部署前请将 chatgpt-rebind-standalone 仓库的 rebind_core/ 与 registration_core/
放在本文件同级目录，或通过环境变量 REBIND_CORE_DIR 指定其所在父目录。
"""
from __future__ import annotations

import os
import sys
import time
import uuid
import random
import hashlib
import shutil
import threading
import traceback
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Header, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# 路径准备：确保能 import 到 rebind_core / registration_core
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
CORE_DIR = Path(os.environ.get("REBIND_CORE_DIR", str(HERE))).expanduser().resolve()
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

try:
    from rebind_core.pipeline import run_rebind_email  # type: ignore
except Exception as exc:  # pragma: no cover
    print(f"[WARN] 无法导入 rebind_core.pipeline: {exc}", file=sys.stderr)
    print("       请确认 rebind_core/ 与 registration_core/ 位于:", CORE_DIR, file=sys.stderr)
    run_rebind_email = None  # type: ignore

# ---------------------------------------------------------------------------
# 配置（启动时校验）
# ---------------------------------------------------------------------------
SERVICE_TOKEN = os.environ.get("REBIND_SERVICE_TOKEN", "").strip()
MAX_CONCURRENT = int(os.environ.get("REBIND_MAX_CONCURRENT", os.environ.get("MAX_CONCURRENT", "3")))
MAX_WAITING = int(os.environ.get("REBIND_MAX_WAITING", os.environ.get("MAX_WAITING", "10")))
TASK_TTL_SECONDS = int(os.environ.get("REBIND_TASK_TTL", str(24 * 3600)))
IDEMPOTENCY_WINDOW = int(os.environ.get("REBIND_IDEMPOTENCY_WINDOW", "60"))
RATE_LIMIT_PER_MIN = int(os.environ.get("REBIND_RATE_LIMIT", "30"))
DEFAULT_MAIL_TIMEOUT = float(os.environ.get("REBIND_MAIL_TIMEOUT", "180"))
OUTPUTS_ROOT = Path(os.environ.get("REBIND_OUTPUTS_DIR", str(HERE / "outputs"))).resolve()

# Worker 终态回调（任务结束后主动通知 Worker 撤销收信 token）
WORKER_TASK_CALLBACK_URL = os.environ.get("WORKER_TASK_CALLBACK_URL", "").strip().rstrip("/")
REBIND_CALLBACK_TOKEN = os.environ.get("REBIND_CALLBACK_TOKEN", "").strip()
CALLBACK_MAX_RETRIES = 3

# 代理池配置
# PROXY_POOL: 逗号分隔列表，或 @前缀表示文件路径（每行一个代理 URL）
# 未设置则直连（proxy=None）；设置后必须至少有一个可用代理，否则返回 503
_PROXY_POOL_RAW = os.environ.get("PROXY_POOL", "").strip()
MAX_PROXY_FAILURES = int(os.environ.get("REBIND_MAX_PROXY_FAILURES", "5"))
PROXY_CHECK_TIMEOUT = float(os.environ.get("REBIND_PROXY_CHECK_TIMEOUT", "5"))
PROXY_TEST_URL = os.environ.get("REBIND_PROXY_TEST_URL", "https://auth.openai.com/")
PROXY_RECHECK_INTERVAL = int(os.environ.get("REBIND_PROXY_RECHECK_INTERVAL", "300"))
# ---------------------------------------------------------------------------
# 代理池（带连通性检查、失败计数、空池拒绝）
# ---------------------------------------------------------------------------
_PROXY_POOL_ENABLED = bool(_PROXY_POOL_RAW)
# 每个代理的状态：{url, fail_count, available, last_check, in_use}
_proxies: list[dict[str, Any]] = []
_proxy_lock = threading.Lock()

if _PROXY_POOL_ENABLED:
    if _PROXY_POOL_RAW.startswith("@"):
        _f = Path(_PROXY_POOL_RAW[1:]).expanduser()
        if _f.is_file():
            _raw_list = [ln.strip() for ln in _f.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.strip().startswith("#")]
        else:
            print(f"[WARN] 代理池文件不存在: {_f}", file=sys.stderr)
            _raw_list = []
    else:
        _raw_list = [p.strip() for p in _PROXY_POOL_RAW.split(",") if p.strip()]
    for _url in _raw_list:
        _proxies.append({
            "url": _url,
            "fail_count": 0,
            "available": True,
            "last_check": 0,
            "in_use": False,
        })
    print(f"[proxy] 代理池已加载 {len(_proxies)} 个代理", file=sys.stderr)

# 强制要求 token（fail-close）
if not SERVICE_TOKEN:
    print(
        "[FATAL] 未设置 REBIND_SERVICE_TOKEN 环境变量。\n"
        "        为防止账号密码/TOTP 泄露，服务强制要求鉴权 token。",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# 并发与任务存储
# ---------------------------------------------------------------------------
_semaphore = threading.Semaphore(MAX_CONCURRENT)
_tasks: dict[str, dict[str, Any]] = {}
_tasks_lock = threading.Lock()
_rate_limit: dict[str, deque] = {}
_rate_lock = threading.Lock()
_cleanup_stop = threading.Event()
# 每线程的收信 token 和取消事件（用于 requests.get monkey-patch）
_thread_local = threading.local()

# 合法状态集合
VALID_STATUSES = {"created", "running", "waiting_code", "success", "failed", "cancelled", "expired"}
ACTIVE_STATUSES = {"created", "running", "waiting_code"}


def _mask(value: str, head: int = 10, tail: int = 4) -> str:
    text = str(value or "")
    if len(text) <= head + tail:
        return "*" * len(text)
    return f"{text[:head]}...{text[-tail:]}"


def _mask_proxy(proxy_url: str) -> str:
    """代理 URL 脱敏：只保留 host:port，移除用户名密码。"""
    if not proxy_url:
        return ""
    try:
        p = urlparse(proxy_url)
        host = p.hostname or ""
        port = p.port or ""
        return f"{host}:{port}" if port else host
    except Exception:
        return "***"


def _check_proxy_connectivity(proxy_url: str) -> bool:
    """通过代理请求测试 URL，验证代理可用。"""
    try:
        _original_requests_get(
            PROXY_TEST_URL,
            proxies={"http": proxy_url, "https": proxy_url},
            timeout=PROXY_CHECK_TIMEOUT,
            allow_redirects=True,
        )
        return True
    except Exception:
        return False


def _acquire_proxy() -> str | None:
    """
    从代理池中选择一个可用代理并标记为使用中。
    返回代理 URL；如果代理池未启用返回 None（直连）；
    如果代理池启用但无可用代理返回空字符串 ""（调用方应返回 503）。
    """
    if not _PROXY_POOL_ENABLED:
        return None  # 直连

    now = time.time()
    with _proxy_lock:
        # 筛选可用代理：available 且 fail_count < 上限 且未在使用
        candidates = [
            p for p in _proxies
            if p["available"] and p["fail_count"] < MAX_PROXY_FAILURES and not p["in_use"]
        ]
        if not candidates:
            return ""  # 无可用代理

        # 优先选择最近检查过且成功的，否则随机
        fresh = [p for p in candidates if now - p["last_check"] < PROXY_RECHECK_INTERVAL]
        chosen = random.choice(fresh) if fresh else random.choice(candidates)
        chosen["in_use"] = True
        proxy_url = chosen["url"]

    # 在锁外做连通性检查（避免长时间持锁）
    if now - chosen["last_check"] >= PROXY_RECHECK_INTERVAL or not chosen["last_check"]:
        ok = _check_proxy_connectivity(proxy_url)
        with _proxy_lock:
            chosen["last_check"] = now
            if not ok:
                chosen["fail_count"] += 1
                chosen["in_use"] = False
                if chosen["fail_count"] >= MAX_PROXY_FAILURES:
                    chosen["available"] = False
                    print(f"[proxy] 代理 {_mask_proxy(proxy_url)} 连续失败 {MAX_PROXY_FAILURES} 次，标记不可用", file=sys.stderr)
                return ""  # 连通性检查失败，返回空让调用方重试或 503
            else:
                chosen["fail_count"] = 0  # 检查成功重置失败计数

    return proxy_url


def _release_proxy(proxy_url: str | None, success: bool) -> None:
    """任务结束后释放代理，更新失败计数。"""
    if not proxy_url or not _PROXY_POOL_ENABLED:
        return
    with _proxy_lock:
        for p in _proxies:
            if p["url"] == proxy_url:
                p["in_use"] = False
                if success:
                    p["fail_count"] = 0
                else:
                    p["fail_count"] += 1
                    if p["fail_count"] >= MAX_PROXY_FAILURES:
                        p["available"] = False
                        print(f"[proxy] 代理 {_mask_proxy(proxy_url)} 任务失败，累计 {p['fail_count']} 次，标记不可用", file=sys.stderr)
                break


def _recheck_disabled_proxies() -> None:
    """后台定期重新检查被标记不可用的代理。"""
    while not _cleanup_stop.is_set():
        try:
            now = time.time()
            with _proxy_lock:
                disabled = [p for p in _proxies if not p["available"]]
            for p in disabled:
                if now - p["last_check"] >= PROXY_RECHECK_INTERVAL:
                    ok = _check_proxy_connectivity(p["url"])
                    with _proxy_lock:
                        p["last_check"] = now
                        if ok:
                            p["available"] = True
                            p["fail_count"] = 0
                            print(f"[proxy] 代理 {_mask_proxy(p['url'])} 恢复可用", file=sys.stderr)
        except Exception:
            pass
        _cleanup_stop.wait(PROXY_RECHECK_INTERVAL)


def _scrub(payload: dict[str, Any]) -> dict[str, Any]:
    """递归清除敏感字段。已以 _masked 结尾的字段跳过（本身已是脱敏值）。"""
    sensitive_substrings = {
        "password", "totp", "secret", "cookie", "session_token",
        "access_token", "refresh_token", "mail_api", "token",
        "authorization", "auth_session", "proxy", "bundle",
        "run_dir", "out_dir", "inbox_token",
    }
    out: dict[str, Any] = {}
    for k, v in payload.items():
        lk = k.lower()
        if lk.endswith("_masked"):
            out[k] = v
            continue
        if any(s in lk for s in sensitive_substrings):
            if isinstance(v, str):
                # proxy 字段特殊处理：显示 host:port
                if "proxy" in lk:
                    out[k] = _mask_proxy(v)
                else:
                    out[k] = _mask(v)
            elif isinstance(v, (dict, list)):
                out[k] = "***"
            else:
                out[k] = v
        elif isinstance(v, dict):
            out[k] = _scrub(v)
        elif isinstance(v, list):
            out[k] = [_scrub(x) if isinstance(x, dict) else x for x in v]
        else:
            out[k] = v
    return out


def _idempotency_key(params: dict[str, Any]) -> str:
    """基于关键参数生成幂等键。"""
    key_parts = [
        str(params.get("old_email", "")).lower(),
        str(params.get("new_email", "")).lower(),
        str(params.get("password", "")),
        str(params.get("totp_secret", "")),
    ]
    raw = "|".join(key_parts)
    return hashlib.sha256(raw.encode()).hexdigest()


def _cleanup_task_dir(task_id: str) -> None:
    """删除任务独立输出目录。"""
    task_dir = OUTPUTS_ROOT / task_id
    if task_dir.is_dir():
        try:
            shutil.rmtree(task_dir, ignore_errors=True)
            print(f"[cleanup] 已删除任务目录: {task_dir}", file=sys.stderr)
        except Exception as e:
            print(f"[cleanup] 删除任务目录失败 {task_dir}: {e}", file=sys.stderr)


def _notify_worker_terminal(task_id: str, status: str | None = None) -> None:
    """任务终态后主动通知 Worker 撤销收信 token（有限重试，不阻塞清理）。"""
    if not WORKER_TASK_CALLBACK_URL or not REBIND_CALLBACK_TOKEN:
        return

    if status is None:
        with _tasks_lock:
            task = _tasks.get(task_id)
            status = task.get("status") if task else None

    if status not in ("success", "failed", "cancelled", "expired"):
        return

    payload = {"task_id": task_id, "status": status}
    for attempt in range(1, CALLBACK_MAX_RETRIES + 1):
        try:
            resp = _requests_mod.post(
                WORKER_TASK_CALLBACK_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {REBIND_CALLBACK_TOKEN}",
                    "Content-Type": "application/json",
                },
                timeout=10,
            )
            if resp.status_code == 200:
                print(f"[callback] 已通知 Worker 终态: {task_id} -> {status}", file=sys.stderr)
                return
            print(f"[callback] Worker 返回 {resp.status_code}: {task_id}", file=sys.stderr)
        except Exception as e:
            print(f"[callback] 通知 Worker 失败 (尝试 {attempt}/{CALLBACK_MAX_RETRIES}): {e}", file=sys.stderr)
        if attempt < CALLBACK_MAX_RETRIES:
            time.sleep(2 ** attempt)  # 指数退避：2s, 4s


def _cleanup_expired_tasks() -> None:
    """后台线程：定期清理过期任务及其目录。"""
    while not _cleanup_stop.is_set():
        try:
            now = time.time()
            expired_ids: list[str] = []
            newly_expired: list[str] = []  # 新标记为 expired 的任务，需要回调 Worker
            with _tasks_lock:
                for tid, t in _tasks.items():
                    # 活跃任务超时标记为 expired
                    if t.get("status") in ACTIVE_STATUSES:
                        if t.get("created_at", 0) + TASK_TTL_SECONDS < now:
                            t["status"] = "expired"
                            t["finished_at"] = now
                            t["error"] = "任务超时"
                            # 触发取消事件
                            evt = t.get("cancel_event")
                            if evt:
                                evt.set()
                            newly_expired.append(tid)
                            expired_ids.append(tid)
                    # 已结束任务超过 TTL 后从内存移除
                    elif (t.get("finished_at") or t.get("created_at", 0)) + TASK_TTL_SECONDS < now:
                        expired_ids.append(tid)
                for tid in expired_ids:
                    _tasks.pop(tid, None)
            # 清理目录和回调（在锁外执行 IO）
            for tid in expired_ids:
                _cleanup_task_dir(tid)
            for tid in newly_expired:
                _notify_worker_terminal(tid, "expired")
        except Exception:
            pass
        _cleanup_stop.wait(300)  # 每 5 分钟检查一次


def _check_rate_limit(client_ip: str) -> bool:
    """简单的固定窗口限流。返回 True 表示允许。"""
    now = time.time()
    with _rate_lock:
        dq = _rate_limit.setdefault(client_ip, deque())
        while dq and now - dq[0] > 60:
            dq.popleft()
        if len(dq) >= RATE_LIMIT_PER_MIN:
            return False
        dq.append(now)
        return True


def _startup_cleanup() -> None:
    """启动时清理 outputs 目录中的残留任务目录。"""
    if not OUTPUTS_ROOT.is_dir():
        OUTPUTS_ROOT.mkdir(parents=True, exist_ok=True)
        return
    removed = 0
    for child in OUTPUTS_ROOT.iterdir():
        if child.is_dir():
            try:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
            except Exception:
                pass
    if removed:
        print(f"[startup] 已清理 {removed} 个残留任务目录", file=sys.stderr)


# ---------------------------------------------------------------------------
# 全局 requests.get monkey-patch：
#   1. 从 thread-local 读取 inbox_token，对 /rebind/inbox 请求注入 header
#   2. 检查取消事件，已取消则抛出异常中断收信轮询
#   3. 收信请求时更新任务状态为 waiting_code
# 多线程安全：每个任务线程有独立的 token 和 cancel_event。
# ---------------------------------------------------------------------------
import requests as _requests_mod
_original_requests_get = _requests_mod.get


class TaskCancelledError(Exception):
    """任务被取消时抛出。"""
    pass


def _patched_requests_get(url, **kwargs):
    # 检查取消事件
    cancel_evt = getattr(_thread_local, "cancel_event", None)
    if cancel_evt is not None and cancel_evt.is_set():
        raise TaskCancelledError("任务已被取消")

    token = getattr(_thread_local, "inbox_token", None)
    is_inbox = token and "/rebind/inbox" in str(url)
    if is_inbox:
        headers = dict(kwargs.get("headers") or {})
        headers["X-Rebind-Token"] = token
        kwargs["headers"] = headers
        # 更新状态为 waiting_code
        tid = getattr(_thread_local, "task_id", None)
        if tid:
            with _tasks_lock:
                if tid in _tasks and _tasks[tid].get("status") == "running":
                    _tasks[tid]["status"] = "waiting_code"

    try:
        return _original_requests_get(url, **kwargs)
    finally:
        # 收信请求返回后恢复 running 状态
        if is_inbox:
            tid = getattr(_thread_local, "task_id", None)
            if tid:
                with _tasks_lock:
                    if tid in _tasks and _tasks[tid].get("status") == "waiting_code":
                        _tasks[tid]["status"] = "running"


_requests_mod.get = _patched_requests_get


def _run_task(task_id: str, params: dict[str, Any]) -> None:
    """后台执行换绑流程（受信号量限制）。代理在取得 semaphore 后才领取。"""
    cancel_evt: threading.Event | None = None
    with _tasks_lock:
        cancel_evt = _tasks.get(task_id, {}).get("cancel_event")

    proxy: str | None = None
    task_success = False
    acquired = False

    try:
        # 检查是否已被取消（在等待信号量期间）
        if cancel_evt and cancel_evt.is_set():
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(status="cancelled", finished_at=time.time())
            return

        acquired = _semaphore.acquire(timeout=120)
        if not acquired:
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(
                        status="failed",
                        finished_at=time.time(),
                        error="服务器繁忙，并发任务已达上限，请稍后重试",
                    )
            return

        # 再次检查取消
        if cancel_evt and cancel_evt.is_set():
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(status="cancelled", finished_at=time.time())
            return

        # 取得 semaphore 后才领取代理（幂等返回、队列满、请求错误都不会占用代理）
        proxy = _acquire_proxy()
        if _PROXY_POOL_ENABLED and not proxy:
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(
                        status="failed",
                        finished_at=time.time(),
                        error="没有可用代理",
                    )
            return

        task_dir = OUTPUTS_ROOT / task_id
        task_dir.mkdir(parents=True, exist_ok=True)

        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id]["status"] = "running"
                _tasks[task_id]["started_at"] = time.time()

        if run_rebind_email is None:
            raise RuntimeError("rebind_core 未正确导入，请检查 REBIND_CORE_DIR")

        # 设置线程本地变量
        _thread_local.inbox_token = params.get("inbox_token", "")
        _thread_local.cancel_event = cancel_evt
        _thread_local.task_id = task_id

        try:
            result = run_rebind_email(
                old_email=params["old_email"],
                password=params["password"],
                totp_secret=params["totp_secret"],
                new_email=params["new_email"],
                mail_api=params["mail_api"],
                proxy=proxy,
                out_dir=str(task_dir),
                mail_timeout=float(params.get("mail_timeout") or DEFAULT_MAIL_TIMEOUT),
            )
        finally:
            # 清除线程本地变量
            for attr in ("inbox_token", "cancel_event", "task_id"):
                if hasattr(_thread_local, attr):
                    delattr(_thread_local, attr)

        # 检查是否被取消
        if cancel_evt and cancel_evt.is_set():
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(status="cancelled", finished_at=time.time())
            return

        task_success = bool(getattr(result, "ok", False))
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id].update(
                    status="success" if result.ok else "failed",
                    finished_at=time.time(),
                    result={
                        "ok": result.ok,
                        "code": result.code,
                        "message": result.message,
                        "old_email": result.old_email,
                        "new_email": result.new_email,
                        "session_email": result.session_email,
                        "access_token_masked": result.access_token_masked,
                    },
                )
    except TaskCancelledError:
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id].update(status="cancelled", finished_at=time.time())
        print(f"[task {task_id}] 已取消", file=sys.stderr)
    except Exception as exc:
        # 检查是否因取消导致的异常
        if cancel_evt and cancel_evt.is_set():
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(status="cancelled", finished_at=time.time())
        else:
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id].update(
                        status="failed",
                        finished_at=time.time(),
                        error=str(exc),
                    )
            print(f"[task {task_id}] 失败: {exc}\n{traceback.format_exc()}", file=sys.stderr)
    finally:
        if acquired:
            _semaphore.release()
        # 释放代理，更新失败计数（proxy 为 None 时直接返回）
        _release_proxy(proxy, task_success)
        # 任务结束后统一删除整个目录
        _cleanup_task_dir(task_id)
        # 主动通知 Worker 撤销收信 token（有限重试，不阻塞）
        _notify_worker_terminal(task_id)


# ---------------------------------------------------------------------------
# FastAPI 应用
# ---------------------------------------------------------------------------
app = FastAPI(
    title="ChatGPT Rebind Email Service",
    description="将 chatgpt-rebind-standalone 包装为 HTTP API（强制鉴权、可取消、独立目录）",
    version="2.0.0",
)

# CORS：仅允许同源或明确指定的来源
_allowed_origins = os.environ.get("REBIND_CORS_ORIGINS", "").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins.split(",") if _allowed_origins else [],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

# 启动清理
_startup_cleanup()

# 启动过期清理线程
_cleanup_thread = threading.Thread(target=_cleanup_expired_tasks, daemon=True)
_cleanup_thread.start()

# 启动代理健康检查线程（仅当代理池启用时）
if _PROXY_POOL_ENABLED:
    _proxy_recheck_thread = threading.Thread(target=_recheck_disabled_proxies, daemon=True)
    _proxy_recheck_thread.start()


def verify_token(authorization: str | None = Header(default=None)) -> None:
    """强制 Bearer Token 鉴权。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="缺少 Authorization Bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if token != SERVICE_TOKEN:
        raise HTTPException(status_code=403, detail="token 无效")


def get_client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


class RebindRequest(BaseModel):
    task_id: str = Field(..., description="Worker 预生成的任务 ID（必填，用于 D1 回调一致性）")
    old_email: str = Field(..., description="旧邮箱")
    password: str = Field(..., description="账号密码")
    totp_secret: str = Field(..., description="TOTP 密钥（Base32）")
    new_email: str = Field(..., description="新邮箱")
    mail_api: str = Field(..., description="新邮箱收信 API URL（不含 token）")
    inbox_token: str = Field(..., description="收信端点鉴权 token，通过 X-Rebind-Token header 传递")
    mail_timeout: float | None = Field(default=None, description="收信超时秒数（上限300）")
    # 注意：proxy 字段已移除，代理由服务端代理池统一选择


class RebindTaskResponse(BaseModel):
    task_id: str
    status: str


@app.get("/health")
async def health() -> dict[str, Any]:
    with _proxy_lock:
        total_proxies = len(_proxies)
        available_proxies = sum(1 for p in _proxies if p["available"] and p["fail_count"] < MAX_PROXY_FAILURES)
    return {
        "status": "ok",
        "rebind_core_loaded": run_rebind_email is not None,
        "core_dir": str(CORE_DIR),
        "tasks": len(_tasks),
        "max_concurrent": MAX_CONCURRENT,
        "max_waiting": MAX_WAITING,
        "proxy_pool_enabled": _PROXY_POOL_ENABLED,
        "proxy_total": total_proxies,
        "proxy_available": available_proxies,
        "auth_required": True,
        "version": "2.1.0",
    }


@app.post("/rebind", response_model=RebindTaskResponse, dependencies=[Depends(verify_token)])
async def create_rebind_task(req: RebindRequest, request: Request) -> RebindTaskResponse:
    # 限流
    client_ip = get_client_ip(request)
    if not _check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后重试")

    if run_rebind_email is None:
        raise HTTPException(status_code=500, detail="rebind_core 未正确导入")

    params = req.model_dump()
    # 限制 mail_timeout 上限
    if params.get("mail_timeout"):
        params["mail_timeout"] = min(float(params["mail_timeout"]), 300)

    # 使用 Worker 预生成的 task_id（确保 D1 记录和 Python 内存任务 ID 一致）
    task_id = req.task_id.strip()
    if not task_id:
        raise HTTPException(status_code=400, detail="task_id 不能为空")

    # 注意：代理不在此处领取。在 _run_task 取得 semaphore 后才调用 _acquire_proxy()，
    # 避免幂等返回、队列满、请求错误时泄漏代理。

    # 幂等控制 + 等待队列检查 + 任务插入（同一锁内）
    idem_key = _idempotency_key(params)
    now = time.time()
    cancel_event = threading.Event()

    with _tasks_lock:
        # task_id 已存在：直接返回已有任务（幂等）
        if task_id in _tasks:
            existing = _tasks[task_id]
            return RebindTaskResponse(task_id=task_id, status=existing.get("status", "created"))

        # 幂等检查（相同参数的活跃任务）
        for tid, t in _tasks.items():
            if (
                t.get("idempotency_key") == idem_key
                and t.get("status") in ACTIVE_STATUSES
                and (t.get("created_at", 0) + IDEMPOTENCY_WINDOW > now)
            ):
                return RebindTaskResponse(task_id=tid, status=t["status"])

        # 等待队列上限（created 状态 = 等待中）
        waiting_count = sum(1 for t in _tasks.values() if t.get("status") == "created")
        if waiting_count >= MAX_WAITING:
            raise HTTPException(status_code=429, detail=f"等待队列已满（上限 {MAX_WAITING}），请稍后重试")

        # 插入任务
        _tasks[task_id] = {
            "task_id": task_id,
            "status": "created",
            "created_at": now,
            "idempotency_key": idem_key,
            "cancel_event": cancel_event,
            "params": _scrub(params),  # 存储时即脱敏
        }

    t = threading.Thread(target=_run_task, args=(task_id, params), daemon=True)
    t.start()

    return RebindTaskResponse(task_id=task_id, status="created")


@app.get("/rebind/{task_id}", dependencies=[Depends(verify_token)])
async def get_rebind_task(task_id: str) -> dict[str, Any]:
    with _tasks_lock:
        task = _tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    # 返回前再次确保脱敏（不返回 cancel_event 等内部对象）
    safe = {k: v for k, v in task.items() if k != "cancel_event"}
    return _scrub(safe)


@app.post("/rebind/{task_id}/cancel", dependencies=[Depends(verify_token)])
async def cancel_rebind_task(task_id: str) -> dict[str, Any]:
    with _tasks_lock:
        task = _tasks.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在或已过期")
        if task.get("status") not in ACTIVE_STATUSES:
            return {"task_id": task_id, "status": task["status"], "cancelled": False, "message": "任务已结束，无需取消"}
        # 设置取消事件
        evt = task.get("cancel_event")
        if evt:
            evt.set()
        task["status"] = "cancelled"
        task["finished_at"] = time.time()
        current_status = "cancelled"
    # 目录清理在 _run_task 的 finally 中执行；如果任务还在 created 状态未启动线程，这里手动清理
    _cleanup_task_dir(task_id)
    return {"task_id": task_id, "status": current_status, "cancelled": True}


@app.get("/rebind", dependencies=[Depends(verify_token)])
async def list_tasks(limit: int = 20) -> dict[str, Any]:
    with _tasks_lock:
        items = sorted(
            _tasks.values(),
            key=lambda t: t.get("created_at", 0),
            reverse=True,
        )[:limit]
    safe_items = []
    for t in items:
        safe = {k: v for k, v in t.items() if k != "cancel_event"}
        safe_items.append(_scrub(safe))
    return {"count": len(safe_items), "tasks": safe_items}


if __name__ == "__main__":
    import uvicorn

    # 默认监听 127.0.0.1，需通过反向代理暴露
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))

    if host == "0.0.0.0":
        print(
            "[WARN] 服务监听 0.0.0.0，请确保前置反向代理启用了 HTTPS，"
            "否则账号密码/TOTP 将明文传输！",
            file=sys.stderr,
        )

    uvicorn.run(app, host=host, port=port)
