/**
 * 换绑功能的公开路由（无需 JWT 登录）v2.0.0
 *
 * 当前提供：
 *   GET /rebind/old-inbox
 *     —— 旧邮箱登录验证码收信。
 *   GET /rebind/new-inbox
 *     —— 新邮箱换绑验证码收信。
 *   GET /rebind/inbox
 *     —— 兼容旧版本，等同于 new-inbox。
 *     Header: X-Rebind-Token: <短期 token>
 *     —— 供 Python 换绑服务轮询验证码。
 *        token 由 /api/rebind/start 签发，分别绑定 old/new mailbox + user+task，
 *        记录邮件基线，任务结束后立即撤销（revoke），过期自动失效。
 *
 * 安全设计：
 *   - token 仅通过 X-Rebind-Token header 传输，不进入 URL 日志/历史记录
 *   - 无 token 请求直接快速拒绝，不消耗 D1 资源（不执行任何 DB 操作）
 *   - 内存级 IP 限流（每 Worker 实例独立，提供基本保护）
 *   - 邮件基线过滤，避免读取换绑开始前的旧验证码
 *   - token 绑定 task_id，任务结束后 revoke，防止重放
 *   - 使用次数原子限制：一条 SQL 完成检查+递增，并发安全
 *
 * 返回格式兼容 rebind_core/mail_inbox.py 的 _extract_candidates / extract_otp_from_text：
 *   { code, subject, received_at, content }
 *
 * @module routes/rebind
 */

import { Hono } from 'hono';
import { getInitializedDatabase } from '../db/index.js';
import { decryptProxyUrl } from '../utils/proxy-crypto.js';
import { fetchMailpostInbox } from '../api/mailpost.js';

const router = new Hono();

/** 每 IP 每分钟最大请求数 */
const RATE_LIMIT_PER_MIN = 30;
/** 限流记录（内存，每 Worker 实例独立） */
const _rateMap = new Map();

/**
 * 简单内存限流。返回 true 表示允许。
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 60_000;
  let arr = _rateMap.get(ip);
  if (!arr) {
    arr = [];
    _rateMap.set(ip, arr);
  }
  while (arr.length && arr[0] < windowStart) arr.shift();
  if (arr.length >= RATE_LIMIT_PER_MIN) return false;
  arr.push(now);
  return true;
}

/**
 * 从文本中提取 6 位数字验证码。
 */
function extractOtp(text) {
  const matches = String(text || '').match(/(?<!\d)(\d{6})(?!\d)/);
  return matches ? matches[1] : '';
}

/**
 * 惰性清理过期 token（仅在有有效 token 请求时执行，减少 D1 写入）。
 */
async function cleanupExpiredTokens(db) {
  try {
    const now = new Date().toISOString();
    await db.prepare('DELETE FROM rebind_inbox_tokens WHERE expires_at < ?').bind(now).run();
  } catch (_) { /* 忽略清理错误 */ }
}

async function handleInbox(c, expectedMailboxType) {
  // 仅从 header 读取 token（删除 URL 参数兼容，防止 token 进入日志/历史记录）
  const token = String(
    c.req.header('X-Rebind-Token') ||
    c.req.header('x-rebind-token') ||
    ''
  ).trim();

  // 无 token 直接快速拒绝，不执行任何 D1 操作（包括不执行过期清理）
  if (!token) {
    return c.json({ error: '缺少 X-Rebind-Token header' }, 400);
  }

  // IP 限流
  const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return c.json({ error: '请求过于频繁' }, 429);
  }

  let db;
  try {
    db = await getInitializedDatabase(c.env);
  } catch (_) {
    return c.json({ error: '数据库连接失败' }, 500);
  }

  // 惰性清理过期 token
  await cleanupExpiredTokens(db);

  try {
    const now = new Date().toISOString();

    // 原子操作：一条 SQL 同时完成有效性检查和使用次数递增。
    // 条件：token 匹配、未撤销、未过期、使用次数未达上限。
    // 返回 changes=1 表示成功，changes=0 表示 token 无效/过期/超限。
    const updateResult = await db.prepare(`
      UPDATE rebind_inbox_tokens
      SET used_count = used_count + 1
      WHERE token = ?
        AND revoked = 0
        AND expires_at > ?
        AND mailbox_type = ?
        AND used_count < max_uses
    `).bind(token, now, expectedMailboxType).run();

    const changed = updateResult.meta?.changes ?? updateResult.meta?.rows_written ?? 0;
    if (changed !== 1) {
      return c.json({ error: 'token 无效、已过期、已撤销或使用次数已达上限' }, 403);
    }

    // 查询 token 关联的邮箱和基线信息
    const tokenRow = await db.prepare(`
      SELECT id, mailbox_id, task_id, mailbox_type, baseline_message_id, baseline_received_at
      FROM rebind_inbox_tokens
      WHERE token = ?
      LIMIT 1
    `).bind(token).first();

    if (!tokenRow || String(tokenRow.mailbox_type || '') !== expectedMailboxType) {
      return c.json({ error: 'token 不存在' }, 403);
    }

    // 查询该邮箱中、基线之后的最新一封邮件
    // messages 表没有 content 字段，正文存储在 R2 中；
    // 验证码优先使用已提取的 verification_code，其次从 subject/preview 中提取。
    let query = `
      SELECT id, subject, preview, verification_code, received_at
      FROM messages
      WHERE mailbox_id = ?
    `;
    const params = [tokenRow.mailbox_id];

    // 邮件基线过滤：只返回基线之后的邮件
    if (tokenRow.baseline_message_id) {
      query += ' AND id > ?';
      params.push(tokenRow.baseline_message_id);
    } else if (tokenRow.baseline_received_at) {
      query += ' AND received_at > ?';
      params.push(tokenRow.baseline_received_at);
    }

    query += ' ORDER BY received_at DESC LIMIT 1';

    const row = await db.prepare(query).bind(...params).first();

    if (!row) {
      return c.json({ code: '', subject: '', received_at: '', content: '' });
    }

    // 优先用已提取的 verification_code，否则从 subject / preview 中提取
    let code = String(row.verification_code || '').trim();
    if (!code) {
      code = extractOtp(row.subject) || extractOtp(row.preview);
    }

    return c.json({
      code,
      subject: row.subject || '',
      received_at: row.received_at || '',
      content: row.preview || '',
    });
  } catch (e) {
    console.error('rebind inbox 查询失败:', e);
    return c.json({ error: '查询失败: ' + e.message }, 500);
  }
}

router.get('/rebind/old-inbox', (c) => handleInbox(c, 'old'));
router.get('/rebind/new-inbox', (c) => handleInbox(c, 'new'));
router.get('/rebind/inbox', (c) => handleInbox(c, 'new'));

/**
 * 邮局系统邮箱收信端点。
 * 验证短期 token 后，通过邮局 API 拉取邮件并提取验证码。
 */
router.get('/rebind/mailpost-inbox', async (c) => {
  const token = String(
    c.req.header('X-Rebind-Token') || c.req.header('x-rebind-token') || ''
  ).trim();
  if (!token) return c.json({ error: '缺少 X-Rebind-Token header' }, 400);

  const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  if (!checkRateLimit(clientIp)) return c.json({ error: '请求过于频繁' }, 429);

  let db;
  try { db = await getInitializedDatabase(c.env); } catch (_) {
    return c.json({ error: '数据库连接失败' }, 500);
  }
  await cleanupExpiredTokens(db);

  try {
    const now = new Date().toISOString();
    const updateResult = await db.prepare(`
      UPDATE rebind_inbox_tokens
      SET used_count = used_count + 1
      WHERE token = ? AND revoked = 0 AND expires_at > ?
        AND mailbox_type IN ('mailpost-old', 'mailpost-new')
        AND used_count < max_uses
    `).bind(token, now).run();

    const changed = updateResult.meta?.changes ?? 0;
    if (changed !== 1) {
      return c.json({ error: 'token 无效、已过期、已撤销或使用次数已达上限' }, 403);
    }

    const tokenRow = await db.prepare(`
      SELECT id, mailbox_type, metadata
      FROM rebind_inbox_tokens WHERE token = ? LIMIT 1
    `).bind(token).first();

    if (!tokenRow || !String(tokenRow.mailbox_type || '').startsWith('mailpost')) {
      return c.json({ error: 'token 不存在' }, 403);
    }

    let meta;
    try { meta = JSON.parse(tokenRow.metadata || '{}'); } catch (_) { meta = {}; }
    const mpAddress = String(meta.address || '');
    const mpKey = String(meta.key || '');
    if (!mpAddress || !mpKey) {
      return c.json({ error: '邮局邮箱配置缺失' }, 500);
    }

    const mpOptions = {
      mailpostApiUrl: c.env.MAILPOST_API_URL || '',
      mailpostAdminToken: c.env.MAILPOST_ADMIN_TOKEN || '',
    };
    const result = await fetchMailpostInbox(mpOptions, mpAddress, mpKey);
    if (!result.ok) {
      return c.json({ code: '', subject: '', received_at: '', content: '', error: result.error });
    }

    const emails = result.emails || [];
    if (!emails.length) {
      return c.json({ code: '', subject: '', received_at: '', content: '' });
    }
    emails.sort((a, b) => (Number(b.Timestamp) || 0) - (Number(a.Timestamp) || 0));
    const latest = emails[0];
    const bodyText = String(latest.Body || '');
    const subjectText = String(latest.Subject || '');
    const code = extractOtp(bodyText) || extractOtp(subjectText);

    return c.json({
      code: code || '',
      subject: subjectText,
      received_at: latest.Sent || latest.Timestamp || '',
      content: bodyText.substring(0, 2000),
    });
  } catch (e) {
    console.error('[rebind] mailpost-inbox 查询失败:', e);
    return c.json({ error: '查询失败' }, 500);
  }
});

/**
 * Python 服务终态回调：任务结束后主动通知 Worker 撤销收信 token。
 * 鉴权：Authorization: Bearer <REBIND_CALLBACK_TOKEN>
 * 不需要用户登录。
 */
router.post('/rebind/task-terminal', async (c) => {
  const expected = String(c.env.REBIND_CALLBACK_TOKEN || '').trim();
  const auth = String(c.req.header('Authorization') || '').trim();

  if (!expected || auth !== `Bearer ${expected}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await c.req.json();
  } catch (_) {
    return c.json({ error: '请求体必须为 JSON' }, 400);
  }

  const { task_id, status } = body || {};
  const validStatuses = ['success', 'failed', 'cancelled', 'expired'];
  if (!task_id || !validStatuses.includes(status)) {
    return c.json({ error: 'Invalid payload: task_id 和 status(终态) 必填' }, 400);
  }

  let db;
  try {
    db = await getInitializedDatabase(c.env);
  } catch (_) {
    return c.json({ error: '数据库连接失败' }, 500);
  }

  try {
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare(
        'UPDATE rebind_tasks SET status = ?, updated_at = ? WHERE task_id = ?'
      ).bind(status, now, task_id),
      db.prepare(
        'UPDATE rebind_inbox_tokens SET revoked = 1 WHERE task_id = ?'
      ).bind(task_id),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) {
      return c.json({ error: '任务不存在或已被清理' }, 404);
    }
    return c.json({ ok: true });
  } catch (e) {
    console.error('[rebind] task-terminal 回调处理失败:', e);
    return c.json({ error: '处理失败: ' + e.message }, 500);
  }
});

/**
 * Python 服务拉取代理池：返回启用的代理完整 URL 列表。
 * 鉴权：Authorization: Bearer <REBIND_SERVICE_TOKEN>
 * 不需要用户登录。代理凭据仅返回给持有 service token 的 Python 服务。
 */
router.get('/rebind/proxies', async (c) => {
  const expected = String(c.env.REBIND_SERVICE_TOKEN || '').trim();
  const auth = String(c.req.header('Authorization') || '').trim();

  if (!expected || auth !== `Bearer ${expected}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let db;
  try {
    db = await getInitializedDatabase(c.env);
  } catch (_) {
    return c.json({ error: '数据库连接失败' }, 500);
  }

  try {
    const { results } = await db.prepare(
      'SELECT proxy_url FROM proxy_pool WHERE enabled = 1 ORDER BY id ASC'
    ).all();

    // 解密代理 URL（仅返回给持有 service token 的 Python 服务，HTTPS 保护传输）
    const encKey = String(c.env.PROXY_ENCRYPTION_KEY || '').trim();
    if (!encKey) {
      console.error('[rebind] PROXY_ENCRYPTION_KEY 未配置，无法解密代理');
      return c.json({ error: '代理加密密钥未配置' }, 500);
    }

    const proxies = [];
    for (const row of (results || [])) {
      try {
        const decrypted = await decryptProxyUrl(row.proxy_url, encKey);
        proxies.push(decrypted);
      } catch (e) {
        console.error('[rebind] 代理解密失败，跳过该条');
      }
    }
    return c.json({ proxies });
  } catch (e) {
    console.error('[rebind] proxies 查询失败:', e);
    return c.json({ error: '查询失败' }, 500);
  }
});

export default router;
