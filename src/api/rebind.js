/**
 * 换绑邮箱 API
 *
 * 支持两种接码方式：
 * 1. freemail 邮箱：生成短期收信 token，通过 /rebind/old-inbox 和 /rebind/new-inbox 接收验证码
 * 2. 外部邮箱（如 iCloud）：从 external_inbox_accounts 表获取第三方接码 URL，Python 服务直接轮询
 */

import { jsonResponse, errorResponse, isStrictAdmin, getUserFromSession, getUserId } from './helpers.js';
import { getExternalInbox } from './external-inboxes.js';

const REBIND_SERVICE_URL = (globalThis.REBIND_SERVICE_URL || '').replace(/\/$/, '');
const REBIND_SERVICE_TOKEN = globalThis.REBIND_SERVICE_TOKEN || '';
const WORKER_ORIGIN = globalThis.WORKER_ORIGIN || '';

/** 生成随机 token */
function generateToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/** 邮箱格式校验 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 检查邮箱是否在 freemail mailboxes 表中
 */
async function findFreemailMailbox(db, email) {
  if (!email) return null;
  try {
    const row = await db.prepare(
      'SELECT id, address, user_id FROM mailboxes WHERE address = ? LIMIT 1'
    ).bind(email.toLowerCase().trim()).first();
    return row || null;
  } catch (_) {
    return null;
  }
}

/**
 * 确定邮箱的接码配置。
 * 返回 { type: 'freemail'|'external'|'none', mail_api?, inbox_token?, inbox_url?, mailbox? }
 */
async function resolveInboxConfig(db, email, label) {
  const freemail = await findFreemailMailbox(db, email);
  if (freemail) {
    const token = generateToken(24);
    // 写入 token 表
    try {
      await db.prepare(
        'INSERT INTO rebind_inbox_tokens (token, email, label, expires_at) VALUES (?, ?, ?, datetime("now", "+30 minutes"))'
      ).bind(token, email, label).run();
    } catch (_) {}
    return {
      type: 'freemail',
      mail_api: `${WORKER_ORIGIN}/rebind/${label}-inbox`,
      inbox_token: token,
      mailbox: freemail,
    };
  }

  // 查外部接码表
  const external = await getExternalInbox(db, email);
  if (external && external.enabled) {
    return {
      type: 'external',
      inbox_url: external.inbox_url,
    };
  }

  return { type: 'none' };
}

/**
 * 处理换绑 API 请求
 */
export async function handleRebindApi(request, db, url, path, options) {
  // GET /api/rebind/config — 换绑功能配置
  if (path === '/api/rebind/config' && request.method === 'GET') {
    const enabled = !!(REBIND_SERVICE_URL && REBIND_SERVICE_TOKEN);
    return jsonResponse({
      enabled,
      service_configured: enabled,
      worker_origin: WORKER_ORIGIN,
    });
  }

  // GET /api/rebind/inbox-config?email=xxx — 查询邮箱接码配置
  if (path === '/api/rebind/inbox-config' && request.method === 'GET') {
    const email = url.searchParams.get('email') || '';
    if (!email || !EMAIL_RE.test(email)) {
      return errorResponse('邮箱格式不合法', 400);
    }
    const freemail = await findFreemailMailbox(db, email);
    if (freemail) {
      return jsonResponse({
        type: 'freemail',
        inbox_url: `${WORKER_ORIGIN}/rebind/inbox`,
        description: 'freemail 托管邮箱，验证码将自动接收',
      });
    }
    const external = await getExternalInbox(db, email);
    if (external && external.enabled) {
      return jsonResponse({
        type: 'external',
        inbox_url: external.inbox_url,
        description: '外部接码地址绑定',
      });
    }
    return jsonResponse({
      type: 'none',
      inbox_url: '',
      description: '该邮箱未配置接码地址，请在外部接码管理中添加',
    });
  }

  // POST /api/rebind/start — 创建换绑任务
  if (path === '/api/rebind/start' && request.method === 'POST') {
    const user = await getUserFromSession(request, db, options);
    if (!user) return errorResponse('请先登录', 401);

    let body;
    try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }

    const oldEmail = String(body.old_email || '').trim().toLowerCase();
    const newEmail = String(body.new_email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const totpSecret = String(body.totp_secret || '');

    if (!oldEmail || !EMAIL_RE.test(oldEmail)) return errorResponse('旧邮箱格式不合法', 400);
    if (!newEmail || !EMAIL_RE.test(newEmail)) return errorResponse('新邮箱格式不合法', 400);
    if (!password) return errorResponse('缺少密码', 400);

    if (!REBIND_SERVICE_URL || !REBIND_SERVICE_TOKEN) {
      return errorResponse('换绑服务未配置', 503);
    }

    // 确定旧邮箱接码配置
    const oldConfig = await resolveInboxConfig(db, oldEmail, 'old');
    if (oldConfig.type === 'none') {
      return errorResponse('旧邮箱未配置接码地址，请在外部接码管理中添加', 400);
    }

    // 确定新邮箱接码配置
    const newConfig = await resolveInboxConfig(db, newEmail, 'new');
    if (newConfig.type === 'none') {
      return errorResponse('新邮箱未配置接码地址，请在外部接码管理中添加', 400);
    }

    // 生成任务 ID
    const taskId = generateToken(16);

    // 写入 D1 任务记录
    try {
      await db.prepare(
        `INSERT INTO rebind_tasks (task_id, user_id, old_email, new_email, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, 'created', ?, datetime('now'))`
      ).bind(taskId, user.id, oldEmail, newEmail, generateToken(8)).run();
    } catch (e) {
      return errorResponse('创建任务记录失败：' + e.message, 500);
    }

    // 构造发给 Python 服务的参数
    const pythonParams = {
      task_id: taskId,
      old_email: oldEmail,
      password,
      totp_secret: totpSecret,
      new_email: newEmail,
      mail_timeout: 180,
    };

    // freemail 邮箱：传 mail_api + inbox_token
    // 外部邮箱：传 inbox_url
    if (oldConfig.type === 'freemail') {
      pythonParams.old_mail_api = oldConfig.mail_api;
      pythonParams.old_inbox_token = oldConfig.inbox_token;
    } else {
      pythonParams.old_inbox_url = oldConfig.inbox_url;
      pythonParams.old_mail_api = oldConfig.inbox_url;
      pythonParams.old_inbox_token = '';
    }

    if (newConfig.type === 'freemail') {
      pythonParams.new_mail_api = newConfig.mail_api;
      pythonParams.new_inbox_token = newConfig.inbox_token;
    } else {
      pythonParams.new_inbox_url = newConfig.inbox_url;
      pythonParams.new_mail_api = newConfig.inbox_url;
      pythonParams.new_inbox_token = '';
    }

    // 调用 Python 服务
    try {
      const resp = await fetch(`${REBIND_SERVICE_URL}/rebind`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${REBIND_SERVICE_TOKEN}`,
        },
        body: JSON.stringify(pythonParams),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return errorResponse(data.detail || data.error || '换绑服务返回错误', resp.status);
      }
      return jsonResponse({ task_id: taskId, status: data.status || 'created', old_inbox_type: oldConfig.type, new_inbox_type: newConfig.type });
    } catch (e) {
      return errorResponse('调用换绑服务失败：' + e.message, 502);
    }
  }

  // GET /api/rebind/task/:id — 查询任务状态
  if (path.startsWith('/api/rebind/task/') && request.method === 'GET') {
    const taskId = path.split('/')[4];
    if (!taskId) return errorResponse('缺少任务 ID', 400);

    const user = await getUserFromSession(request, db, options);
    if (!user) return errorResponse('请先登录', 401);

    // 先查 D1
    let dbTask = null;
    try {
      dbTask = await db.prepare('SELECT * FROM rebind_tasks WHERE task_id = ? LIMIT 1').bind(taskId).first();
    } catch (_) {}

    if (!dbTask) return errorResponse('任务不存在', 404);

    // 非管理员只能查看自己的任务
    if (!isStrictAdmin(request, options) && dbTask.user_id !== user.id) {
      return errorResponse('无权查看此任务', 403);
    }

    // 从 Python 服务查询实时状态
    try {
      const resp = await fetch(`${REBIND_SERVICE_URL}/rebind/${taskId}`, {
        headers: { 'Authorization': `Bearer ${REBIND_SERVICE_TOKEN}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        return jsonResponse(data);
      }
    } catch (_) {}

    // Python 服务不可用时返回 D1 中的状态
    return jsonResponse({
      task_id: dbTask.task_id,
      status: dbTask.status,
      old_email: dbTask.old_email,
      new_email: dbTask.new_email,
      created_at: dbTask.created_at,
      finished_at: dbTask.finished_at,
      error: dbTask.error,
    });
  }

  // POST /api/rebind/task/:id/cancel — 取消任务
  if (path.startsWith('/api/rebind/task/') && path.endsWith('/cancel') && request.method === 'POST') {
    const taskId = path.split('/')[4];
    if (!taskId) return errorResponse('缺少任务 ID', 400);

    const user = await getUserFromSession(request, db, options);
    if (!user) return errorResponse('请先登录', 401);

    let dbTask = null;
    try {
      dbTask = await db.prepare('SELECT * FROM rebind_tasks WHERE task_id = ? LIMIT 1').bind(taskId).first();
    } catch (_) {}

    if (!dbTask) return errorResponse('任务不存在', 404);
    if (!isStrictAdmin(request, options) && dbTask.user_id !== user.id) {
      return errorResponse('无权操作此任务', 403);
    }

    try {
      const resp = await fetch(`${REBIND_SERVICE_URL}/rebind/${taskId}/cancel`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${REBIND_SERVICE_TOKEN}` },
      });
      const data = await resp.json();
      return jsonResponse(data);
    } catch (e) {
      return errorResponse('取消任务失败：' + e.message, 502);
    }
  }

  return null;
}
