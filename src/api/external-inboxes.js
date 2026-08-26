/**
 * 外部接码地址管理 API（仅严格管理员可用）
 *
 * 将不在 freemail 系统中的邮箱（如 iCloud）与第三方接码服务 URL 绑定。
 * 换绑任务创建时，若旧/新邮箱不在 freemail 中，则查此表获取接码 URL。
 *
 * @module api/external-inboxes
 */

import { jsonResponse, errorResponse, isStrictAdmin } from './helpers.js';
import { validateInboxUrl, maskInboxUrl } from '../utils/ssrf.js';

/** 邮箱格式校验 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 查询外部接码地址（供换绑 start 接口调用，非管理员 API）。
 */
export async function getExternalInbox(db, email) {
  if (!email) return null;
  try {
    const row = await db.prepare(
      'SELECT id, email, inbox_url, enabled FROM external_inbox_accounts WHERE email = ? LIMIT 1'
    ).bind(email.toLowerCase().trim()).first();
    return row || null;
  } catch (_) {
    return null;
  }
}

/**
 * 处理外部接码地址管理 API 请求。
 */
export async function handleExternalInboxesApi(request, db, url, path, options) {
  if (!isStrictAdmin(request, options)) {
    return errorResponse('需要管理员权限', 403);
  }

  // GET /api/admin/external-inboxes — 列表
  if (path === '/api/admin/external-inboxes' && request.method === 'GET') {
    try {
      const { results } = await db.prepare(
        'SELECT id, email, inbox_url, enabled, created_at, updated_at FROM external_inbox_accounts ORDER BY id DESC'
      ).all();
      const list = (results || []).map(r => ({
        id: r.id,
        email: r.email,
        inbox_url: r.inbox_url,
        inbox_url_masked: maskInboxUrl(r.inbox_url),
        enabled: !!r.enabled,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));
      return jsonResponse({ items: list, total: list.length });
    } catch (e) {
      return errorResponse('查询失败：' + e.message, 500);
    }
  }

  // POST /api/admin/external-inboxes — 单个添加
  if (path === '/api/admin/external-inboxes' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }

    const email = String(body.email || '').trim().toLowerCase();
    const inboxUrl = String(body.inbox_url || '').trim();
    const enabled = body.enabled === false ? 0 : 1;

    if (!email || !EMAIL_RE.test(email)) return errorResponse('邮箱格式不合法', 400);
    if (!inboxUrl) return errorResponse('缺少接码地址', 400);

    const validation = validateInboxUrl(inboxUrl);
    if (!validation.ok) return errorResponse('接码地址不合法：' + validation.error, 400);

    try {
      const result = await db.prepare(
        'INSERT INTO external_inbox_accounts (email, inbox_url, enabled) VALUES (?, ?, ?)'
      ).bind(email, inboxUrl, enabled).run();
      return jsonResponse({ success: true, id: result.meta?.last_row_id, email, inbox_url_masked: maskInboxUrl(inboxUrl), enabled: !!enabled });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return errorResponse('该邮箱已绑定接码地址', 409);
      return errorResponse('添加失败：' + e.message, 500);
    }
  }

  // POST /api/admin/external-inboxes/batch — 批量导入
  if (path === '/api/admin/external-inboxes/batch' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }

    const raw = String(body.proxies || body.items || body.text || '').trim();
    if (!raw) return errorResponse('缺少导入内容', 400);

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 500) return errorResponse('单次最多导入 500 条', 400);

    let added = 0;
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const parts = line.split('----');
      if (parts.length < 2) { errors.push({ line: lineNum, error: '格式错误，使用 ---- 分隔邮箱和URL' }); continue; }
      const email = parts[0].trim().toLowerCase();
      const inboxUrl = parts.slice(1).join('----').trim();
      if (!EMAIL_RE.test(email)) { errors.push({ line: lineNum, error: '邮箱格式不合法' }); continue; }
      const validation = validateInboxUrl(inboxUrl);
      if (!validation.ok) { errors.push({ line: lineNum, error: validation.error }); continue; }
      try {
        await db.prepare('INSERT OR IGNORE INTO external_inbox_accounts (email, inbox_url, enabled) VALUES (?, ?, 1)').bind(email, inboxUrl).run();
        added++;
      } catch (e) { errors.push({ line: lineNum, error: '数据库错误' }); }
    }

    return jsonResponse({ total: lines.length, added, failed: errors.length, errors });
  }

  // PATCH /api/admin/external-inboxes/:id — 启用/禁用
  if (path.startsWith('/api/admin/external-inboxes/') && request.method === 'PATCH') {
    const id = parseInt(path.split('/')[4], 10);
    if (!id || isNaN(id)) return errorResponse('缺少 ID', 400);
    let body;
    try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }
    if (typeof body.enabled !== 'boolean') return errorResponse('enabled 必须为布尔值', 400);
    try {
      const result = await db.prepare('UPDATE external_inbox_accounts SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(body.enabled ? 1 : 0, id).run();
      if (!result.meta?.changes) return errorResponse('记录不存在', 404);
      return jsonResponse({ success: true, id, enabled: body.enabled });
    } catch (e) { return errorResponse('更新失败：' + e.message, 500); }
  }

  // DELETE /api/admin/external-inboxes/:id — 删除
  if (path.startsWith('/api/admin/external-inboxes/') && request.method === 'DELETE') {
    const id = parseInt(path.split('/')[4], 10);
    if (!id || isNaN(id)) return errorResponse('缺少 ID', 400);
    try {
      const result = await db.prepare('DELETE FROM external_inbox_accounts WHERE id = ?').bind(id).run();
      if (!result.meta?.changes) return errorResponse('记录不存在', 404);
      return jsonResponse({ success: true, id });
    } catch (e) { return errorResponse('删除失败：' + e.message, 500); }
  }

  return null;
}
