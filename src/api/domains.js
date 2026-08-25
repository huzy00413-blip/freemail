/**
 * 域名管理 API（仅严格管理员可用）
 *
 * 提供域名的增删改查，域名存储在 D1 的 mail_domains 表中。
 * 创建邮箱时优先从该表读取启用的域名，MAIL_DOMAIN 环境变量仅作回退。
 *
 * @module api/domains
 */

import { jsonResponse, errorResponse, isStrictAdmin } from './helpers.js';

/**
 * 合法域名格式校验（不包含协议、路径、端口）
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * 从 D1 获取启用的域名列表；表不存在或查询失败时回退到环境变量。
 * @param {object} db - D1 数据库
 * @param {string[]} fallbackDomains - 环境变量中的域名列表
 * @returns {Promise<string[]>}
 */
export async function getEnabledDomains(db, fallbackDomains) {
  try {
    const { results } = await db.prepare(
      'SELECT domain FROM mail_domains WHERE enabled = 1 ORDER BY domain ASC'
    ).all();
    if (results && results.length > 0) {
      return results.map(r => r.domain);
    }
  } catch (_) {
    // 表不存在或查询失败，回退到环境变量
  }
  return Array.isArray(fallbackDomains) ? fallbackDomains : [fallbackDomains || 'temp.example.com'];
}

/**
 * 处理域名管理 API 请求。
 */
export async function handleDomainsApi(request, db, url, path, options) {
  // 严格管理员鉴权（后端强制，不依赖前端）
  if (!isStrictAdmin(request, options)) {
    return errorResponse('需要管理员权限', 403);
  }

  // GET /api/admin/domains — 列出所有域名
  if (path === '/api/admin/domains' && request.method === 'GET') {
    try {
      const { results } = await db.prepare(
        'SELECT domain, enabled, created_at FROM mail_domains ORDER BY domain ASC'
      ).all();
      return jsonResponse({ domains: results || [] });
    } catch (e) {
      return errorResponse('查询域名失败：' + e.message, 500);
    }
  }

  // POST /api/admin/domains — 添加域名
  if (path === '/api/admin/domains' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return errorResponse('请求体必须为 JSON', 400);
    }

    const domain = String(body.domain || '').trim().toLowerCase();
    if (!domain) return errorResponse('缺少域名', 400);
    if (!DOMAIN_RE.test(domain)) return errorResponse('域名格式不合法', 400);
    if (domain.length > 253) return errorResponse('域名过长', 400);

    const enabled = body.enabled === false ? 0 : 1;

    try {
      await db.prepare(
        'INSERT INTO mail_domains (domain, enabled) VALUES (?, ?)'
      ).bind(domain, enabled).run();
      return jsonResponse({ success: true, domain, enabled: !!enabled });
    } catch (e) {
      if (String(e.message).includes('UNIQUE') || String(e.message).includes('PRIMARY')) {
        return errorResponse('域名已存在', 409);
      }
      return errorResponse('添加失败：' + e.message, 500);
    }
  }

  // PATCH /api/admin/domains/:domain — 启用/禁用
  if (path.startsWith('/api/admin/domains/') && request.method === 'PATCH') {
    const domain = decodeURIComponent(path.split('/')[4] || '').trim().toLowerCase();
    if (!domain) return errorResponse('缺少域名', 400);

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return errorResponse('请求体必须为 JSON', 400);
    }

    if (typeof body.enabled !== 'boolean') {
      return errorResponse('enabled 必须为布尔值', 400);
    }

    try {
      const result = await db.prepare(
        'UPDATE mail_domains SET enabled = ? WHERE domain = ?'
      ).bind(body.enabled ? 1 : 0, domain).run();
      if (!result.meta?.changes) return errorResponse('域名不存在', 404);
      return jsonResponse({ success: true, domain, enabled: body.enabled });
    } catch (e) {
      return errorResponse('更新失败：' + e.message, 500);
    }
  }

  // DELETE /api/admin/domains/:domain — 删除域名
  if (path.startsWith('/api/admin/domains/') && request.method === 'DELETE') {
    const domain = decodeURIComponent(path.split('/')[4] || '').trim().toLowerCase();
    if (!domain) return errorResponse('缺少域名', 400);

    try {
      // 检查是否有关联邮箱
      const { results } = await db.prepare(
        'SELECT COUNT(*) AS cnt FROM mailboxes WHERE domain = ?'
      ).bind(domain).all();
      const count = results?.[0]?.cnt || 0;
      if (count > 0) {
        return errorResponse(`该域名下仍有 ${count} 个邮箱，无法删除（可先禁用）`, 409);
      }

      const result = await db.prepare(
        'DELETE FROM mail_domains WHERE domain = ?'
      ).bind(domain).run();
      if (!result.meta?.changes) return errorResponse('域名不存在', 404);
      return jsonResponse({ success: true, domain });
    } catch (e) {
      return errorResponse('删除失败：' + e.message, 500);
    }
  }

  return null;
}
