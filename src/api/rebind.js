/**
 * 换绑邮箱 API
 *
 * 支持两种接码方式：
 * 1. freemail 邮箱：生成短期收信 token，通过 /rebind/old-inbox 和 /rebind/new-inbox 接收验证码
 * 2. 外部邮箱（如 iCloud）：从 external_inbox_accounts 表获取第三方接码 URL，Python 服务直接轮询
 */

import { jsonResponse, errorResponse, isStrictAdmin, getJwtPayload } from './helpers.js';
import { getExternalInbox } from './external-inboxes.js';
import { getMailpostMailbox } from './mailpost.js';
import { validateInboxUrl } from '../utils/ssrf.js';

/** 从 options 读取换绑服务配置 */
function getRebindConfig(options) {
  return {
    serviceUrl: String(options.rebindServiceUrl || '').replace(/\/$/, ''),
    serviceToken: options.rebindServiceToken || '',
    workerOrigin: options.workerOrigin || '',
  };
}

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
 * 返回 { type: 'freemail'|'mailpost'|'external'|'none', mail_api?, inbox_token?, inbox_url?, mailbox? }
 */
async function resolveInboxConfig(db, email, label, options, taskId) {
  const { workerOrigin } = getRebindConfig(options);
  const freemail = await findFreemailMailbox(db, email);
  if (freemail) {
    const token = generateToken(24);
    try {
      await db.prepare(
        `INSERT INTO rebind_inbox_tokens (token, user_id, mailbox_id, task_id, mailbox_type, expires_at)
         VALUES (?, ?, ?, ?, ?, datetime("now", "+30 minutes"))`
      ).bind(token, freemail.user_id || 0, freemail.id, taskId || null, label).run();
    } catch (e) {
      console.error('[rebind] freemail token insert failed:', e.message);
    }
    return {
      type: 'freemail',
      mail_api: `${workerOrigin}/rebind/${label}-inbox`,
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

  // 查邮局系统
  const mp = await getMailpostMailbox(options, email);
  if (mp.exists && mp.mailbox && mp.mailbox.is_active !== false && !mp.mailbox.is_expired) {
    const token = generateToken(24);
    try {
      await db.prepare(
        `INSERT INTO rebind_inbox_tokens (token, mailbox_id, task_id, mailbox_type, expires_at, metadata)
         VALUES (?, 0, ?, ?, datetime("now", "+30 minutes"), ?)`
      ).bind(token, taskId || null, 'mailpost-' + label, JSON.stringify({ address: email, key: mp.mailbox.mailbox_key })).run();
    } catch (e) {
      console.error('[rebind] mailpost token insert failed:', e.message);
    }
    return {
      type: 'mailpost',
      mail_api: `${workerOrigin}/rebind/mailpost-inbox`,
      inbox_token: token,
    };
  }

  return { type: 'none' };
}

/**
 * 处理换绑 API 请求
 */
export async function handleRebindApi(request, db, url, path, options) {
  const { serviceUrl: REBIND_SERVICE_URL, serviceToken: REBIND_SERVICE_TOKEN, workerOrigin: WORKER_ORIGIN } = getRebindConfig(options);

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
    const mp = await getMailpostMailbox(options, email);
    if (mp.exists && mp.mailbox && mp.mailbox.is_active !== false && !mp.mailbox.is_expired) {
      return jsonResponse({
        type: 'mailpost',
        inbox_url: `${WORKER_ORIGIN}/rebind/mailpost-inbox`,
        description: '邮局系统邮箱，自动收信',
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
    const payload = getJwtPayload(request, options);
    if (!payload) return errorResponse('请先登录', 401);
    const userId = Number(payload.userId || 0);

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

    // 生成任务 ID（提前生成，供 token 绑定 task_id）
    const taskId = generateToken(16);

    // 确定旧邮箱接码配置
    const oldConfig = await resolveInboxConfig(db, oldEmail, 'old', options, taskId);
    if (oldConfig.type === 'none') {
      return errorResponse('旧邮箱未配置接码地址，请在外部接码管理中添加', 400);
    }

    // 确定新邮箱接码配置
    const newConfig = await resolveInboxConfig(db, newEmail, 'new', options, taskId);
    if (newConfig.type === 'none') {
      return errorResponse('新邮箱未配置接码地址，请在外部接码管理中添加', 400);
    }

    // 写入 D1 任务记录
    try {
      await db.prepare(
        `INSERT INTO rebind_tasks (task_id, user_id, old_email, new_email, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, 'created', ?, datetime('now'))`
      ).bind(taskId, userId, oldEmail, newEmail, generateToken(8)).run();
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

    // freemail/邮局邮箱：传 mail_api + inbox_token
    // 外部邮箱：传 inbox_url
    if (oldConfig.type === 'freemail' || oldConfig.type === 'mailpost') {
      pythonParams.old_mail_api = oldConfig.mail_api;
      pythonParams.old_inbox_token = oldConfig.inbox_token;
    } else {
      pythonParams.old_inbox_url = oldConfig.inbox_url;
      pythonParams.old_mail_api = oldConfig.inbox_url;
      pythonParams.old_inbox_token = '';
    }

    if (newConfig.type === 'freemail' || newConfig.type === 'mailpost') {
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

    const payload = getJwtPayload(request, options);
    if (!payload) return errorResponse('请先登录', 401);
    const userId = Number(payload.userId || 0);

    // 先查 D1
    let dbTask = null;
    try {
      dbTask = await db.prepare('SELECT * FROM rebind_tasks WHERE task_id = ? LIMIT 1').bind(taskId).first();
    } catch (_) {}

    if (!dbTask) return errorResponse('任务不存在', 404);

    // 非管理员只能查看自己的任务
    if (!isStrictAdmin(request, options) && dbTask.user_id !== userId) {
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

    const payload = getJwtPayload(request, options);
    if (!payload) return errorResponse('请先登录', 401);
    const userId = Number(payload.userId || 0);

    let dbTask = null;
    try {
      dbTask = await db.prepare('SELECT * FROM rebind_tasks WHERE task_id = ? LIMIT 1').bind(taskId).first();
    } catch (_) {}

    if (!dbTask) return errorResponse('任务不存在', 404);
    if (!isStrictAdmin(request, options) && dbTask.user_id !== userId) {
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

  // ========== 批量换绑 API ==========

  // GET /api/rebind/tasks — 获取所有任务状态（代理到 rebind-service）
  if (path === '/api/rebind/tasks' && request.method === 'GET') {
    if (!isStrictAdmin(request, options)) {
      return errorResponse('需要管理员权限', 403);
    }
    if (!REBIND_SERVICE_URL || !REBIND_SERVICE_TOKEN) {
      return errorResponse('换绑服务未配置', 503);
    }
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200)));
    try {
      const resp = await fetch(`${REBIND_SERVICE_URL}/rebind?limit=${limit}`, {
        headers: { 'Authorization': `Bearer ${REBIND_SERVICE_TOKEN}` },
      });
      const data = await resp.json();
      if (!resp.ok) {
        return errorResponse(data.detail || data.error || '换绑服务返回错误', resp.status);
      }
      return jsonResponse(data);
    } catch (e) {
      return errorResponse('无法连接换绑服务：' + e.message, 502);
    }
  }

  // GET /api/rebind/health — 换绑服务健康状态
  if (path === '/api/rebind/health' && request.method === 'GET') {
    if (!REBIND_SERVICE_URL || !REBIND_SERVICE_TOKEN) {
      return jsonResponse({ ok: false, error: '换绑服务未配置' });
    }
    try {
      const resp = await fetch(`${REBIND_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(8000),
      });
      const data = await resp.json();
      return jsonResponse({ ok: resp.ok, ...data });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message });
    }
  }

  // POST /api/rebind/test-inbox-url — 测试取码地址兼容性
  if (path === '/api/rebind/test-inbox-url' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }
    const inboxUrl = String(body.url || '').trim();
    if (!inboxUrl) return errorResponse('缺少 url 参数', 400);

    // SSRF 校验
    const v = validateInboxUrl(inboxUrl);
    if (!v.ok) return errorResponse(v.error, 400);

    try {
      const resp = await fetch(inboxUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (freemail-rebind-tester)' },
      });
      const text = await resp.text();
      const contentType = resp.headers.get('content-type') || '';

      // 尝试提取验证码
      let codeFound = false;
      let codePreview = '';
      if (contentType.includes('json')) {
        try {
          const json = JSON.parse(text);
          const codeKeys = ['code', 'otp', 'verification_code', 'security_code', '验证码', 'vcode', 'verify_code'];
          const findCode = (obj, depth) => {
            if (depth > 5) return;
            if (obj && typeof obj === 'object') {
              for (const [k, val] of Object.entries(obj)) {
                if (codeKeys.includes(k.toLowerCase()) && typeof val === 'string' && /^[0-9]{4,8}$/.test(val)) {
                  codeFound = true; codePreview = val; return;
                }
                if (typeof val === 'object') findCode(val, depth + 1);
              }
            }
          };
          findCode(json, 0);
        } catch (_) {}
      }
      if (!codeFound) {
        const m = text.match(/(?:verification\s*code|security\s*code|验证码|校验码|otp|code)[^0-9]{0,40}([0-9]{4,8})/i) || text.match(/\b(\d{6})\b/);
        if (m) { codeFound = true; codePreview = m[1]; }
      }

      return jsonResponse({
        ok: resp.ok,
        status: resp.status,
        content_type: contentType,
        code_found: codeFound,
        code_preview: codeFound ? codePreview.replace(/.(?=.{2})/g, '*') : '',
        snippet: text.substring(0, 300),
      });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message });
    }
  }

  // POST /api/rebind/batch-cancel — 取消所有活跃任务
  if (path === '/api/rebind/batch-cancel' && request.method === 'POST') {
    if (!isStrictAdmin(request, options)) {
      return errorResponse('需要管理员权限', 403);
    }
    if (!REBIND_SERVICE_URL || !REBIND_SERVICE_TOKEN) {
      return errorResponse('换绑服务未配置', 503);
    }
    try {
      const listResp = await fetch(`${REBIND_SERVICE_URL}/rebind?limit=500`, {
        headers: { 'Authorization': `Bearer ${REBIND_SERVICE_TOKEN}` },
      });
      const listData = await listResp.json();
      const tasks = listData.tasks || [];
      const activeStatuses = ['created', 'running', 'waiting_code'];
      const cancelled = [];
      for (const t of tasks) {
        if (activeStatuses.includes(t.status)) {
          try {
            await fetch(`${REBIND_SERVICE_URL}/rebind/${t.task_id}/cancel`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${REBIND_SERVICE_TOKEN}` },
            });
            cancelled.push(t.task_id);
          } catch (_) {}
        }
      }
      return jsonResponse({ cancelled: cancelled.length, task_ids: cancelled });
    } catch (e) {
      return errorResponse('操作失败：' + e.message, 502);
    }
  }

  // POST /api/rebind/batch — 批量创建换绑任务
  if (path === '/api/rebind/batch' && request.method === 'POST') {
    if (!isStrictAdmin(request, options)) {
      return errorResponse('需要管理员权限', 403);
    }
    if (!REBIND_SERVICE_URL || !REBIND_SERVICE_TOKEN) {
      return errorResponse('换绑服务未配置', 503);
    }

    let body;
    try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }

    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    const mailboxes = Array.isArray(body.mailboxes) ? body.mailboxes : [];

    if (!accounts.length) return errorResponse('账号列表为空', 400);
    if (accounts.length > 200) return errorResponse('单次最多提交 200 个账号', 400);
    if (!mailboxes.length) return errorResponse('邮箱池为空，请先导入新邮箱', 400);

    const results = [];
    let mbIndex = 0;

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i] || {};
      const oldEmail = String(acc.old_email || '').trim().toLowerCase();
      const password = String(acc.password || '');
      const totpSecret = String(acc.totp_secret || '');
      const oldInboxUrl = String(acc.old_inbox_url || '').trim();

      if (!oldEmail || !EMAIL_RE.test(oldEmail)) {
        results.push({ index: i, ok: false, error: '旧邮箱格式不合法' });
        continue;
      }
      if (!password) {
        results.push({ index: i, ok: false, error: '缺少密码' });
        continue;
      }

      // 轮询分配邮箱
      const mailbox = mailboxes[mbIndex % mailboxes.length];
      mbIndex++;
      const newEmail = String(mailbox.email || '').trim().toLowerCase();
      const newInboxUrl = String(mailbox.inbox_url || '').trim();

      if (!newEmail || !EMAIL_RE.test(newEmail)) {
        results.push({ index: i, old_email: oldEmail, ok: false, error: '新邮箱格式不合法' });
        continue;
      }

      const taskId = generateToken(16);

      // 解析旧邮箱接码配置：优先使用内联 URL，否则查库
      let oldConfig;
      if (oldInboxUrl) {
        const sv = validateInboxUrl(oldInboxUrl);
        if (!sv.ok) {
          results.push({ index: i, old_email: oldEmail, ok: false, error: '旧邮箱接码地址不安全：' + sv.error });
          continue;
        }
        oldConfig = { type: 'external', inbox_url: oldInboxUrl };
      } else {
        oldConfig = await resolveInboxConfig(db, oldEmail, 'old', options, taskId);
      }
      if (oldConfig.type === 'none') {
        results.push({ index: i, old_email: oldEmail, ok: false, error: '旧邮箱未配置接码地址' });
        continue;
      }

      // 解析新邮箱接码配置：优先使用内联 URL，否则查库
      let newConfig;
      if (newInboxUrl) {
        const sv = validateInboxUrl(newInboxUrl);
        if (!sv.ok) {
          results.push({ index: i, old_email: oldEmail, ok: false, error: '新邮箱接码地址不安全：' + sv.error });
          continue;
        }
        newConfig = { type: 'external', inbox_url: newInboxUrl };
      } else {
        newConfig = await resolveInboxConfig(db, newEmail, 'new', options, taskId);
      }
      if (newConfig.type === 'none') {
        results.push({ index: i, old_email: oldEmail, ok: false, error: '新邮箱未配置接码地址' });
        continue;
      }

      // 写入 D1 任务记录
      try {
        await db.prepare(
          `INSERT INTO rebind_tasks (task_id, user_id, old_email, new_email, status, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, 'created', ?, datetime('now'))`
        ).bind(taskId, 0, oldEmail, newEmail, generateToken(8)).run();
      } catch (e) {
        results.push({ index: i, old_email: oldEmail, ok: false, error: 'D1 记录失败：' + e.message });
        continue;
      }

      // 构造提交参数
      const pythonParams = {
        task_id: taskId,
        old_email: oldEmail,
        password,
        totp_secret: totpSecret,
        new_email: newEmail,
        mail_timeout: 180,
      };

      if (oldConfig.type === 'freemail' || oldConfig.type === 'mailpost') {
        pythonParams.old_mail_api = oldConfig.mail_api;
        pythonParams.old_inbox_token = oldConfig.inbox_token;
      } else {
        pythonParams.old_inbox_url = oldConfig.inbox_url;
        pythonParams.old_mail_api = oldConfig.inbox_url;
        pythonParams.old_inbox_token = '';
      }

      if (newConfig.type === 'freemail' || newConfig.type === 'mailpost') {
        pythonParams.new_mail_api = newConfig.mail_api;
        pythonParams.new_inbox_token = newConfig.inbox_token;
      } else {
        pythonParams.new_inbox_url = newConfig.inbox_url;
        pythonParams.new_mail_api = newConfig.inbox_url;
        pythonParams.new_inbox_token = '';
      }

      // 提交到换绑服务
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
          results.push({ index: i, task_id: taskId, old_email: oldEmail, new_email: newEmail, ok: false, error: data.detail || data.error || '换绑服务返回错误' });
        } else {
          results.push({ index: i, task_id: taskId, old_email: oldEmail, new_email: newEmail, ok: true, status: data.status || 'created' });
        }
      } catch (e) {
        results.push({ index: i, task_id: taskId, old_email: oldEmail, new_email: newEmail, ok: false, error: '调用换绑服务失败：' + e.message });
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    return jsonResponse({
      total: accounts.length,
      submitted: succeeded,
      failed: results.length - succeeded,
      results,
    });
  }

  return null;
}
