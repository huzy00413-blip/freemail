/**
 * 邮局系统（TempMail/Maildrop）集成 API
 * 代理邮局管理 API，并为换绑流程提供收信支持。
 * 邮局认证信息通过 Worker secret 配置，前端不接触管理员凭据。
 * @module api/mailpost
 */
import { jsonResponse, errorResponse, isStrictAdmin } from './helpers.js';

const API_TIMEOUT = 15000;

function getMailpostConfig(options) {
  const baseUrl = String(options.mailpostApiUrl || '').replace(/\/+$/, '');
  const adminToken = String(options.mailpostAdminToken || '');
  return { baseUrl, adminToken, configured: !!(baseUrl && adminToken) };
}

async function mailpostFetch(baseUrl, adminToken, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || API_TIMEOUT);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`,
      ...(options.headers || {}),
    };
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body || undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message || '请求失败' } };
  } finally {
    clearTimeout(timeout);
  }
}

/** 查询邮局邮箱是否存在，返回含 mailbox_key 的详情 */
export async function getMailpostMailbox(options, address) {
  const { baseUrl, adminToken, configured } = getMailpostConfig(options);
  if (!configured || !address) return { exists: false };
  const result = await mailpostFetch(
    baseUrl, adminToken,
    `/api/admin/mailboxes?page=1&page_size=10&search=${encodeURIComponent(address)}`
  );
  if (!result.ok || !result.data?.success) return { exists: false };
  const mailboxes = result.data.data?.mailboxes || [];
  const found = mailboxes.find(m => String(m.address || '').toLowerCase() === address.toLowerCase());
  if (found) {
    const detail = await mailpostFetch(
      baseUrl, adminToken,
      `/api/admin/mailboxes/${encodeURIComponent(found.id)}`
    );
    if (detail.ok && detail.data?.success && detail.data.data) {
      return { exists: true, mailbox: detail.data.data };
    }
    return { exists: true, mailbox: found };
  }
  return { exists: false };
}

/** 获取邮局邮箱邮件列表（供 rebind mailpost-inbox 端点调用） */
export async function fetchMailpostInbox(options, address, mailboxKey) {
  const { baseUrl, configured } = getMailpostConfig(options);
  if (!configured) return { ok: false, error: '邮局系统未配置' };
  const tokenResp = await fetch(`${baseUrl}/api/get_mailbox_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, mailbox_key: mailboxKey }),
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenData.access_token) {
    return { ok: false, error: tokenData.message || tokenData.error || '邮局认证失败' };
  }
  const inboxResp = await fetch(
    `${baseUrl}/api/get_inbox?address=${encodeURIComponent(address)}`,
    { headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
  );
  const emails = await inboxResp.json().catch(() => []);
  return { ok: true, emails: Array.isArray(emails) ? emails : (emails.emails || []) };
}

/** 邮局管理 API（仅严格管理员） */
export async function handleMailpostApi(request, db, url, path, options) {
  if (!path.startsWith('/api/mailpost/')) return null;
  if (!isStrictAdmin(request, options)) {
    return errorResponse('需要管理员权限', 403);
  }
  const { baseUrl, adminToken, configured } = getMailpostConfig(options);
  if (!configured) {
    return errorResponse('邮局系统未配置（MAILPOST_API_URL / MAILPOST_ADMIN_TOKEN）', 503);
  }

  if (path === '/api/mailpost/stats' && request.method === 'GET') {
    const result = await mailpostFetch(baseUrl, adminToken, '/api/admin/stats');
    if (!result.ok) return errorResponse(result.data.error || '获取统计失败', 502);
    return jsonResponse(result.data);
  }

  if (path === '/api/mailpost/domains' && request.method === 'GET') {
    try {
      const resp = await fetch(`${baseUrl}/api/get_random_address`);
      const data = await resp.json().catch(() => ({}));
      return jsonResponse({ success: true, domains: data.available_domains || [] });
    } catch (e) {
      return errorResponse('获取域名失败：' + e.message, 502);
    }
  }

  if (path === '/api/mailpost/mailboxes' && request.method === 'GET') {
    const qs = url.searchParams.toString();
    const result = await mailpostFetch(
      baseUrl, adminToken,
      `/api/admin/mailboxes${qs ? '?' + qs : ''}`
    );
    if (!result.ok) return errorResponse(result.data.error || '获取邮箱列表失败', 502);
    return jsonResponse(result.data);
  }

  if (path === '/api/mailpost/mailboxes' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) {
      return errorResponse('请求体必须为 JSON', 400);
    }
    const payload = {
      address: String(body.address || '').trim(),
      retention_days: Number(body.retention_days) || 30,
      sender_whitelist: Array.isArray(body.sender_whitelist) ? body.sender_whitelist : [],
    };
    if (!payload.address) return errorResponse('缺少邮箱地址', 400);
    const result = await mailpostFetch(baseUrl, adminToken, '/api/admin/mailboxes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!result.ok) return errorResponse(result.data.error || '创建失败', 400);
    return jsonResponse(result.data);
  }

  const detailMatch = path.match(/^\/api\/mailpost\/mailboxes\/([^/]+)$/);
  if (detailMatch && request.method === 'GET') {
    const result = await mailpostFetch(
      baseUrl, adminToken,
      `/api/admin/mailboxes/${encodeURIComponent(detailMatch[1])}`
    );
    if (!result.ok) return errorResponse(result.data.error || '获取详情失败', 502);
    return jsonResponse(result.data);
  }

  if (detailMatch && request.method === 'DELETE') {
    const result = await mailpostFetch(
      baseUrl, adminToken,
      `/api/admin/mailboxes/${encodeURIComponent(detailMatch[1])}?soft=true`,
      { method: 'DELETE' }
    );
    if (!result.ok) return errorResponse(result.data.error || '删除失败', 400);
    return jsonResponse(result.data);
  }

  const enableMatch = path.match(/^\/api\/mailpost\/mailboxes\/([^/]+)\/enable$/);
  if (enableMatch && request.method === 'POST') {
    const result = await mailpostFetch(
      baseUrl, adminToken,
      `/api/admin/mailboxes/${encodeURIComponent(enableMatch[1])}/enable`,
      { method: 'POST' }
    );
    if (!result.ok) return errorResponse(result.data.error || '恢复失败', 400);
    return jsonResponse(result.data);
  }

  return null;
}
