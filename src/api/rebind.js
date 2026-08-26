/**
 * ChatGPT 换绑邮箱 API 处理器 v2.0.0
 *
 * 通过 HTTP 调用独立部署的 Python 换绑服务（rebind-service），
 * 不直接在 Workers 中运行 Python 代码。
 *
 * 安全设计：
 *   - 仅严格管理员或拥有目标邮箱的用户可发起换绑
 *   - task_id 绑定用户身份，状态查询/取消均校验归属
 *   - 收信使用两枚短期 token（分别绑定旧/新邮箱、user+mailbox+task、记录邮件基线、任务结束撤销），仅通过 header 传输
 *   - 返回结果严格过滤，不泄露密码、TOTP、cookie、代理凭据、bundle、traceback
 *   - 强制 Python 服务地址为 HTTPS（localhost 开发环境除外）
 *   - D1 写入失败时调用 Python 取消接口，不产生孤儿任务
 *   - 代理由 Python 服务端选择，不接受前端任意代理
 *
 * 任务状态（与 Python 端一致）：
 *   created → running → waiting_code → success / failed / cancelled / expired
 *
 * @module api/rebind
 */

import { errorResponse, jsonResponse, getAuthContext, getMailboxAccess } from './helpers.js';
import { getMailboxIdByAddress } from '../db/index.js';

/** 收信 token 有效期（毫秒）：10 分钟 */
const INBOX_TOKEN_TTL_MS = 10 * 60 * 1000;

/** 任务终态集合 */
const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled', 'expired']);

/**
 * 生成安全随机 token。
 */
function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成仅用于服务端幂等控制的 HMAC 指纹。
 * D1 只保存摘要，避免持久化密码或 TOTP 原文。
 */
async function createIdempotencyKey(secret, userId, oldEmail, newEmail, password, totpSecret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const input = [userId ?? -1, oldEmail.toLowerCase(), newEmail.toLowerCase(), password, totpSecret].join('\n');
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function findActiveIdempotentTask(db, userId, idempotencyKey) {
  return db.prepare(`
    SELECT task_id, status
    FROM rebind_tasks
    WHERE COALESCE(user_id, -1) = ?
      AND idempotency_key = ?
      AND status IN ('created', 'running', 'waiting_code')
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId ?? -1, idempotencyKey).first();
}

/**
 * 校验当前用户是否有权操作目标邮箱。
 * @returns {{allowed: boolean, reason?: string, mailboxId?: number}}
 */
async function checkRebindPermission(db, request, options, newEmail) {
  const ctx = getAuthContext(request, options);

  // guest 账号禁止
  if (ctx.payload?.role === 'guest' || options.mockOnly) {
    return { allowed: false, reason: '访客账号无权使用换绑功能' };
  }

  // 严格管理员允许任意邮箱
  if (ctx.strictAdmin) {
    return { allowed: true };
  }

  // 非管理员必须拥有目标邮箱
  if (!newEmail) {
    return { allowed: false, reason: '缺少新邮箱' };
  }

  const access = await getMailboxAccess(db, request, options, { address: newEmail });
  if (!access.exists) {
    return { allowed: false, reason: `邮箱 ${newEmail} 不存在` };
  }
  if (!access.allowed) {
    return { allowed: false, reason: '无权操作该邮箱' };
  }
  return { allowed: true, mailboxId: access.mailbox?.id };
}

/**
 * 读取邮箱基线，用于过滤任务创建前已经存在的验证码邮件。
 */
async function getMailboxBaseline(db, mailboxId) {
  try {
    const latest = await db.prepare(`
      SELECT id, received_at FROM messages
      WHERE mailbox_id = ? ORDER BY received_at DESC LIMIT 1
    `).bind(mailboxId).first();
    return latest
      ? { messageId: latest.id, receivedAt: latest.received_at }
      : { messageId: null, receivedAt: null };
  } catch (_) {
    return { messageId: null, receivedAt: null };
  }
}

/**
 * 从 Python 服务返回的任务数据中提取安全字段，过滤敏感信息。
 */
function sanitizeTaskResult(task) {
  if (!task || typeof task !== 'object') return { status: 'unknown' };
  const result = task.result || {};
  const out = {
    task_id: task.task_id,
    status: task.status,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    ok: result.ok,
    code: result.code,
    message: result.message,
    old_email: result.old_email,
    new_email: result.new_email,
    session_email: result.session_email,
    access_token_masked: result.access_token_masked,
  };
  if (task.status === 'failed' || task.status === 'expired') {
    out.error = task.error || result.message || '';
  }
  if (task.status === 'cancelled') {
    out.message = task.message || '任务已取消';
  }
  return out;
}

/**
 * 撤销指定 task_id 关联的收信 token。
 */
async function revokeInboxTokens(db, taskId) {
  if (!taskId) return;
  try {
    await db.prepare(
      'UPDATE rebind_inbox_tokens SET revoked = 1 WHERE task_id = ?'
    ).bind(taskId).run();
  } catch (_) { /* 忽略 */ }
}

/**
 * 回滚任务：将 rebind_tasks 标为 failed，撤销收信 token。
 * 用于 Python 服务调用失败时的 D1 回滚。
 */
async function _rollbackTask(db, taskId, reason) {
  try {
    await db.batch([
      db.prepare(
        'UPDATE rebind_tasks SET status = ?, updated_at = ? WHERE task_id = ?'
      ).bind('failed', new Date().toISOString(), taskId),
      db.prepare(
        'UPDATE rebind_inbox_tokens SET revoked = 1 WHERE task_id = ?'
      ).bind(taskId),
    ]);
  } catch (e) {
    console.error('[rebind] 回滚任务失败:', taskId, e.message);
  }
}

/**
 * 调用 Python 服务取消任务（fire-and-forget，不阻塞主流程）。
 */
async function cancelPythonTask(serviceUrl, serviceToken, taskId) {
  if (!serviceUrl || !taskId) return;
  try {
    const headers = {};
    if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`;
    await fetch(`${serviceUrl}/rebind/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers,
    });
  } catch (_) { /* 忽略取消失败，Python 端会自动过期清理 */ }
}

/**
 * 检查表是否包含必需字段（PRAGMA table_info）。
 * @returns {Promise<boolean>}
 */
async function requireColumns(db, table, columns) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  const existing = new Set((results || []).map(row => row.name));
  return columns.every(column => existing.has(column));
}

/**
 * 检查 D1 换绑表是否可用（检查字段完整性，而非只检查表存在）。
 * @returns {{ok: boolean, error?: string}}
 */
async function checkRebindTablesReady(db) {
  try {
    const tasksOk = await requireColumns(db, 'rebind_tasks', [
      'task_id', 'user_id', 'status', 'updated_at', 'idempotency_key',
    ]);
    const tokensOk = await requireColumns(db, 'rebind_inbox_tokens', [
      'token', 'user_id', 'mailbox_id', 'task_id', 'expires_at',
      'used_count', 'max_uses', 'baseline_message_id',
      'baseline_received_at', 'mailbox_type', 'revoked',
    ]);

    return tasksOk && tokensOk
      ? { ok: true }
      : { ok: false, error: 'rebind 数据库字段未迁移完成，请执行 migrations/0001_rebind_tables.sql' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * 处理换绑相关 API 请求。
 */
export async function handleRebindApi(request, db, url, path, options = {}) {
  const serviceUrl = (options.rebindServiceUrl || '').trim().replace(/\/+$/, '');
  const serviceToken = options.rebindServiceToken || '';
  const workerOrigin = (options.workerOrigin || '').trim().replace(/\/+$/, '');

  // ---------- GET /api/rebind/config ----------
  if (path === '/api/rebind/config' && request.method === 'GET') {
    const tables = await checkRebindTablesReady(db);
    const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(serviceUrl);
    const httpsOk = serviceUrl.startsWith('https://') || isLocalDev;
    const configured = !!serviceUrl && !!serviceToken;
    return jsonResponse({
      enabled: configured && tables.ok && httpsOk,
      service_url_masked: serviceUrl
        ? serviceUrl.replace(/^https?:\/\/([^/]+).*/, '$1')
        : '',
      reason: !serviceUrl
        ? 'REBIND_SERVICE_URL 未配置'
        : !serviceToken
        ? 'REBIND_SERVICE_TOKEN 未配置'
        : !tables.ok
        ? `数据库表未就绪：${tables.error}`
        : !httpsOk
        ? 'REBIND_SERVICE_URL 必须使用 HTTPS'
        : null,
    });
  }

  // 以下端点需要服务已配置
  if (!serviceUrl) {
    if (path.startsWith('/api/rebind')) {
      return errorResponse('换绑服务未配置，请设置 REBIND_SERVICE_URL 环境变量', 503);
    }
    return null;
  }

  // 强制 HTTPS（localhost / 127.0.0.1 开发环境除外，但记录警告）
  const isLocalDev = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(serviceUrl);
  if (!serviceUrl.startsWith('https://') && !isLocalDev) {
    return errorResponse('REBIND_SERVICE_URL 必须使用 HTTPS，禁止通过 HTTP 传输账号密码', 503);
  }
  if (isLocalDev && !serviceUrl.startsWith('https://')) {
    console.warn('[rebind] 警告：Python 服务使用 HTTP，仅允许本地开发环境');
  }

  // 统一 fail-close：除 /api/rebind/config 外，所有换绑接口必须通过表就绪和 token 检查
  // （config 端点已在上方处理并返回，不会执行到这里）
  if (path.startsWith('/api/rebind/')) {
    const tables = await checkRebindTablesReady(db);
    if (!tables.ok) {
      return errorResponse(`换绑数据库未就绪：${tables.error}`, 503);
    }
    if (!serviceToken) {
      return errorResponse('REBIND_SERVICE_TOKEN 未配置', 503);
    }
  }

  // workerOrigin 用于构造收信回调地址
  if (!workerOrigin && path === '/api/rebind/start' && request.method === 'POST') {
    return errorResponse('WORKER_ORIGIN 未配置，无法构造收信回调地址', 503);
  }

  // ---------- POST /api/rebind/start ----------
  if (path === '/api/rebind/start' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return errorResponse('请求体必须为 JSON', 400);
    }

    const oldEmail = String(body.old_email || '').trim();
    const password = String(body.password || '');
    const totpSecret = String(body.totp_secret || '').trim();
    const newEmail = String(body.new_email || '').trim().toLowerCase();
    const mailTimeout = Number(body.mail_timeout || 180);
    // 注意：proxy 字段已移除，代理由 Python 服务端统一选择

    if (!oldEmail || !password || !totpSecret || !newEmail) {
      return errorResponse('缺少必填字段：old_email / password / totp_secret / new_email', 400);
    }
    if (!oldEmail.includes('@') || !newEmail.includes('@')) {
      return errorResponse('旧邮箱或新邮箱格式非法', 400);
    }
    if (oldEmail.toLowerCase() === newEmail) {
      return errorResponse('旧邮箱和新邮箱不能相同', 400);
    }

    const ctx = getAuthContext(request, options);

    // 权限校验
    const perm = await checkRebindPermission(db, request, options, newEmail);
    if (!perm.allowed) {
      return errorResponse(perm.reason || '无权操作', 403);
    }

    // 旧邮箱也必须是 freemail 中的邮箱，因为旧邮箱验证码由本系统收取。
    // 非管理员同时校验旧邮箱归属，避免借用其他用户的收信入口。
    const oldMailboxId = await getMailboxIdByAddress(db, oldEmail);
    if (!oldMailboxId) {
      return errorResponse(`旧邮箱 ${oldEmail} 不存在，无法提供旧邮箱验证码收信地址`, 400);
    }
    if (!ctx.strictAdmin) {
      const oldAccess = await getMailboxAccess(db, request, options, { mailboxId: oldMailboxId });
      if (!oldAccess.allowed) {
        return errorResponse('无权读取旧邮箱验证码，请使用自己拥有的旧邮箱', 403);
      }
    }

    // 确认新邮箱存在并获取 mailbox_id
    const mailboxId = perm.mailboxId || await getMailboxIdByAddress(db, newEmail);
    if (!mailboxId) {
      return errorResponse(`新邮箱 ${newEmail} 不存在`, 400);
    }

    // 与 D1 的 COALESCE(user_id, -1) 作用域保持一致。0 不是有效用户 ID，
    // 不能一处写成 NULL、另一处按 0 查询。
    const ownerUserId = Number.isInteger(ctx.userId) && ctx.userId > 0 ? ctx.userId : null;
    const idempotencyKey = await createIdempotencyKey(
      serviceToken,
      ownerUserId,
      oldEmail,
      newEmail,
      password,
      totpSecret
    );

    // 正常重试直接返回原任务，避免生成第二个 token、D1 记录或 Python 任务。
    const existingTask = await findActiveIdempotentTask(db, ownerUserId, idempotencyKey);
    if (existingTask) {
      return jsonResponse({
        success: true,
        task_id: existingTask.task_id,
        status: existingTask.status,
        idempotent: true,
        message: '已有相同的进行中任务',
      });
    }

    const oldBaseline = await getMailboxBaseline(db, oldMailboxId);
    const newBaseline = await getMailboxBaseline(db, mailboxId);

    // 预先生成 task_id（必须在写 D1 之前，确保 Python 回调时 token 和任务记录已存在）
    const taskId = crypto.randomUUID();

    // 为旧/新邮箱分别生成短期收信 token，直接绑定 task_id，避免创建阶段竞态。
    const oldInboxToken = generateToken();
    const newInboxToken = generateToken();
    const expiresAt = new Date(Date.now() + INBOX_TOKEN_TTL_MS).toISOString();

    // 第一步：一次写入两枚 token；任一步失败都不启动 Python。
    try {
      await db.batch([
        db.prepare(`
          INSERT INTO rebind_inbox_tokens
            (token, user_id, mailbox_id, task_id, expires_at, baseline_message_id, baseline_received_at, mailbox_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(oldInboxToken, ownerUserId, oldMailboxId, taskId, expiresAt, oldBaseline.messageId, oldBaseline.receivedAt, 'old'),
        db.prepare(`
          INSERT INTO rebind_inbox_tokens
            (token, user_id, mailbox_id, task_id, expires_at, baseline_message_id, baseline_received_at, mailbox_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(newInboxToken, ownerUserId, mailboxId, taskId, expiresAt, newBaseline.messageId, newBaseline.receivedAt, 'new'),
      ]);
    } catch (e) {
      return errorResponse('创建收信令牌失败：' + e.message, 500);
    }

    // 第二步：写入 rebind_tasks（status='created'）
    try {
      await db.prepare(`
        INSERT INTO rebind_tasks (task_id, user_id, username, old_email, new_email, status, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(taskId, ownerUserId, ctx.payload?.username || '', oldEmail, newEmail, 'created', idempotencyKey).run();
    } catch (e) {
      // 并发重复提交会命中部分唯一索引。撤销刚创建的 token 并返回原任务。
      try { await db.prepare('UPDATE rebind_inbox_tokens SET revoked = 1 WHERE task_id = ?').bind(taskId).run(); } catch (_) {}
      const concurrentTask = await findActiveIdempotentTask(db, ownerUserId, idempotencyKey);
      if (concurrentTask) {
        return jsonResponse({
          success: true,
          task_id: concurrentTask.task_id,
          status: concurrentTask.status,
          idempotent: true,
          message: '已有相同的进行中任务',
        });
      }
      return errorResponse('保存任务记录失败：' + e.message, 500);
    }

    // 两个收信 API 地址均不带 token；Python 通过 X-Rebind-Token header 传递。
    const oldMailApi = `${workerOrigin}/rebind/old-inbox`;
    const newMailApi = `${workerOrigin}/rebind/new-inbox`;

    const payload = {
      task_id: taskId,
      old_email: oldEmail,
      password,
      totp_secret: totpSecret,
      new_email: newEmail,
      old_mail_api: oldMailApi,
      old_inbox_token: oldInboxToken,
      new_mail_api: newMailApi,
      new_inbox_token: newInboxToken,
      mail_timeout: Math.min(mailTimeout, 300),
      // 不发送 proxy：由 Python 服务端代理池统一选择
    };

    // 第三步：D1 两步均成功后才调用 Python
    let pyResp, pyData;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`;
      pyResp = await fetch(`${serviceUrl}/rebind`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      pyData = await pyResp.json().catch(() => ({}));
    } catch (e) {
      // Python 服务调用失败：回滚 D1（标 failed + 撤销 token）
      await _rollbackTask(db, taskId, '连接换绑服务失败：' + e.message);
      return errorResponse('连接换绑服务失败：' + e.message, 502);
    }

    if (!pyResp.ok) {
      // Python 服务拒绝：回滚 D1
      const errMsg = pyData.detail || pyData.error || `换绑服务返回 ${pyResp.status}`;
      await _rollbackTask(db, taskId, errMsg);
      return errorResponse(errMsg, pyResp.status);
    }

    // Python 不应返回不同 ID；否则浏览器会轮询未运行的 D1 任务。
    if (pyData.task_id !== taskId) {
      await _rollbackTask(db, taskId, 'Python 返回了不匹配的 task_id');
      return errorResponse('换绑服务返回的 task_id 不匹配，任务已回滚，请重试', 502);
    }

    return jsonResponse({
      success: true,
      task_id: taskId,
      status: pyData.status || 'created',
      message: '换绑任务已提交，请轮询 /api/rebind/status/{task_id} 获取结果',
    });
  }

  // ---------- GET /api/rebind/status/:taskId ----------
  if (path.startsWith('/api/rebind/status/') && request.method === 'GET') {
    const taskId = path.split('/')[4];
    if (!taskId) return errorResponse('缺少 task_id', 400);

    const ctx = getAuthContext(request, options);

    // 从本地表查询任务归属
    let taskRow;
    try {
      taskRow = await db.prepare(
        'SELECT task_id, user_id, username, status FROM rebind_tasks WHERE task_id = ? LIMIT 1'
      ).bind(taskId).first();
    } catch (e) {
      return errorResponse('查询任务记录失败：' + e.message, 500);
    }

    if (!taskRow) {
      return errorResponse('任务不存在', 404);
    }

    // 权限校验：严格管理员可查看任意任务；普通用户只能查看自己提交的任务
    if (!ctx.strictAdmin) {
      if (!ctx.userId || !taskRow.user_id || taskRow.user_id !== ctx.userId) {
        return errorResponse('无权查看此任务', 403);
      }
    }

    // 从 Python 服务查询最新状态
    let pyResp, pyData;
    try {
      const headers = {};
      if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`;
      pyResp = await fetch(`${serviceUrl}/rebind/${encodeURIComponent(taskId)}`, { headers });
      pyData = await pyResp.json().catch(() => ({}));
    } catch (e) {
      return errorResponse('连接换绑服务失败：' + e.message, 502);
    }

    if (!pyResp.ok) {
      if (pyResp.status === 404) {
        return jsonResponse({
          task_id: taskId,
          status: taskRow.status || 'unknown',
          message: '任务在换绑服务端已不存在（可能已过期清理）',
        });
      }
      return errorResponse(pyData.detail || `换绑服务返回 ${pyResp.status}`, pyResp.status);
    }

    // 更新本地状态
    try {
      await db.prepare(
        'UPDATE rebind_tasks SET status = ?, updated_at = ? WHERE task_id = ?'
      ).bind(pyData.status || taskRow.status, new Date().toISOString(), taskId).run();
    } catch (_) { /* 忽略 */ }

    // 任务到达终态时撤销收信 token
    if (TERMINAL_STATUSES.has(pyData.status)) {
      await revokeInboxTokens(db, taskId);
    }

    // 过滤敏感信息后返回
    return jsonResponse(sanitizeTaskResult(pyData));
  }

  // ---------- POST /api/rebind/cancel/:taskId ----------
  if (path.startsWith('/api/rebind/cancel/') && request.method === 'POST') {
    const taskId = path.split('/')[4];
    if (!taskId) return errorResponse('缺少 task_id', 400);

    const ctx = getAuthContext(request, options);

    // 从本地表查询任务归属
    let taskRow;
    try {
      taskRow = await db.prepare(
        'SELECT task_id, user_id, username, status FROM rebind_tasks WHERE task_id = ? LIMIT 1'
      ).bind(taskId).first();
    } catch (e) {
      return errorResponse('查询任务记录失败：' + e.message, 500);
    }

    if (!taskRow) {
      return errorResponse('任务不存在', 404);
    }

    // 权限校验
    if (!ctx.strictAdmin) {
      if (!ctx.userId || !taskRow.user_id || taskRow.user_id !== ctx.userId) {
        return errorResponse('无权取消此任务', 403);
      }
    }

    // 已终态的任务无需取消
    if (TERMINAL_STATUSES.has(taskRow.status)) {
      return jsonResponse({
        task_id: taskId,
        status: taskRow.status,
        cancelled: false,
        message: '任务已结束，无需取消',
      });
    }

    // 调用 Python 取消接口
    let pyResp, pyData;
    try {
      const headers = {};
      if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`;
      pyResp = await fetch(`${serviceUrl}/rebind/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers,
      });
      pyData = await pyResp.json().catch(() => ({}));
    } catch (e) {
      return errorResponse('连接换绑服务失败：' + e.message, 502);
    }

    if (!pyResp.ok && pyResp.status !== 404) {
      return errorResponse(pyData.detail || `取消失败：换绑服务返回 ${pyResp.status}`, pyResp.status);
    }

    // 更新本地状态
    const newStatus = pyData.status || 'cancelled';
    try {
      await db.prepare(
        'UPDATE rebind_tasks SET status = ?, updated_at = ? WHERE task_id = ?'
      ).bind(newStatus, new Date().toISOString(), taskId).run();
    } catch (_) { /* 忽略 */ }

    // 撤销收信 token
    await revokeInboxTokens(db, taskId);

    return jsonResponse({
      task_id: taskId,
      status: newStatus,
      cancelled: true,
      message: '任务已取消',
    });
  }

  return null;
}
