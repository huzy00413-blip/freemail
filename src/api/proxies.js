/**
 * 代理池管理 API（管理员接口）
 *
 * 严格管理员鉴权：
 *   GET    /api/admin/proxies          列出代理（脱敏，不含凭据）
 *   POST   /api/admin/proxies          添加代理
 *   PATCH  /api/admin/proxies/:id      启用/禁用
 *   DELETE /api/admin/proxies/:id      删除
 *
 * Python 服务拉取接口 GET /rebind/proxies 在 routes/rebind.js 中（公开路由，Bearer service token）。
 *
 * @module api/proxies
 */

import { jsonResponse, errorResponse, isStrictAdmin } from './helpers.js';
import { encryptProxyUrl, hashProxyUrl } from '../utils/proxy-crypto.js';

const SUPPORTED_SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h']);
const DEFAULT_SCHEME = (typeof process !== 'undefined' && process.env && process.env.PROXY_DEFAULT_SCHEME) || 'socks5h';

/**
 * 将多种代理格式归一化为 scheme://user:pass@host:port。
 * 与 rebind-service/server.py 的 normalize_proxy 逻辑保持一致。
 * @param {string} value
 * @returns {{url: string, display: string, scheme: string}}
 */
export function normalizeProxy(value) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('#')) {
    throw new Error('空代理行');
  }

  let url, scheme;

  if (v.includes('://')) {
    let parsed;
    try { parsed = new URL(v); } catch (_) { throw new Error('代理 URL 格式不合法'); }
    scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      throw new Error(`不支持的代理协议: ${scheme}`);
    }
    if (!parsed.hostname || !parsed.port) {
      throw new Error('代理 URL 缺少主机或端口');
    }
    url = v;
  } else {
    // host:port:username:password
    const parts = v.split(':');
    if (parts.length !== 4) {
      throw new Error('格式应为 host:port:username:password 或 scheme:// URL');
    }
    const [host, port, username, password] = parts;
    if (!host || !port || !username || !password) {
      throw new Error('host:port:username:password 各段不能为空');
    }
    scheme = DEFAULT_SCHEME;
    if (!SUPPORTED_SCHEMES.has(scheme)) {
      throw new Error(`无效的 PROXY_DEFAULT_SCHEME: ${scheme}`);
    }
    url = `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }

  // 提取 host:port 用于脱敏显示
  let display = '';
  try {
    const u = new URL(url.includes('://') ? url : `${scheme}://${url}`);
    display = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch (_) {
    display = '***';
  }

  return { url, display, scheme };
}

/**
 * 处理代理池 API 请求。
 */
export async function handleProxiesApi(request, db, url, path, options) {
  // ---- 管理员接口（严格管理员鉴权）----
  if (path.startsWith('/api/admin/proxies')) {
    if (!isStrictAdmin(request, options)) {
      return errorResponse('需要管理员权限', 403);
    }

    // GET /api/admin/proxies — 列出代理（脱敏）
    if (path === '/api/admin/proxies' && request.method === 'GET') {
      try {
        const { results } = await db.prepare(
          `SELECT id, proxy_display, proxy_scheme, enabled, last_check_status,
                  last_check_at, fail_count, created_at
           FROM proxy_pool ORDER BY id DESC`
        ).all();
        return jsonResponse({ proxies: (results || []).map(r => ({
          ...r,
          enabled: !!r.enabled,
        })) });
      } catch (e) {
        return errorResponse('查询代理池失败：' + e.message, 500);
      }
    }

    // POST /api/admin/proxies — 添加代理
    if (path === '/api/admin/proxies' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }

      const raw = String(body.proxy || '').trim();
      if (!raw) return errorResponse('缺少代理地址', 400);

      let normalized;
      try {
        normalized = normalizeProxy(raw);
      } catch (e) {
        return errorResponse(e.message, 400);
      }

      if (!options.proxyEncryptionKey) {
        return errorResponse('代理加密密钥未配置（PROXY_ENCRYPTION_KEY）', 500);
      }

      try {
        const encrypted = await encryptProxyUrl(normalized.url, options.proxyEncryptionKey);
        const hash = await hashProxyUrl(normalized.url);
        await db.prepare(
          `INSERT INTO proxy_pool (proxy_url, proxy_hash, proxy_display, proxy_scheme, enabled, last_check_status, fail_count)
           VALUES (?, ?, ?, ?, 1, 'unknown', 0)`
        ).bind(encrypted, hash, normalized.display, normalized.scheme).run();
        return jsonResponse({ success: true, proxy: { display: normalized.display, scheme: normalized.scheme } });
      } catch (e) {
        const msg = String(e.message);
        if (msg.includes('UNIQUE') || msg.includes('PRIMARY') || msg.includes('constraint')) {
          return errorResponse('该代理已存在', 409);
        }
        return errorResponse('添加失败：' + msg, 500);
      }
    }

    // POST /api/admin/proxies/batch — 批量添加代理
    if (path === '/api/admin/proxies/batch' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }

      const rawText = String(body.proxies || '');
      if (rawText.length > 65536) return errorResponse('请求体超过 64KB 限制', 413);

      const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      if (lines.length > 500) return errorResponse('单次最多添加 500 条代理', 400);
      if (!lines.length) return errorResponse('未提供有效代理行', 400);

      if (!options.proxyEncryptionKey) {
        return errorResponse('代理加密密钥未配置（PROXY_ENCRYPTION_KEY）', 500);
      }

      // 查询现有代理 hash 用于去重
      let existingHashes = new Set();
      try {
        const { results } = await db.prepare('SELECT proxy_hash FROM proxy_pool WHERE proxy_hash IS NOT NULL').all();
        existingHashes = new Set((results || []).map(r => r.proxy_hash));
      } catch (_) { /* 表可能为空 */ }

      const toInsert = [];
      const errors = [];
      const seenInBatch = new Set();

      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        try {
          const normalized = normalizeProxy(lines[i]);
          const hash = await hashProxyUrl(normalized.url);
          if (existingHashes.has(hash) || seenInBatch.has(hash)) {
            errors.push({ line: lineNum, error: '重复代理' });
            continue;
          }
          seenInBatch.add(hash);
          const encrypted = await encryptProxyUrl(normalized.url, options.proxyEncryptionKey);
          toInsert.push({ encrypted, hash, normalized });
        } catch (e) {
          errors.push({ line: lineNum, error: e.message });
        }
      }

      // 批量写入
      let added = 0;
      if (toInsert.length) {
        try {
          const stmt = db.prepare(
            `INSERT INTO proxy_pool (proxy_url, proxy_hash, proxy_display, proxy_scheme, enabled, last_check_status, fail_count)
             VALUES (?, ?, ?, ?, 1, 'unknown', 0)`
          );
          const batch = toInsert.map(item =>
            stmt.bind(item.encrypted, item.hash, item.normalized.display, item.normalized.scheme)
          );
          await db.batch(batch);
          added = toInsert.length;
        } catch (e) {
          return errorResponse('批量写入失败：' + e.message, 500);
        }
      }

      // 通知 Python 服务立即刷新代理池（fire-and-forget，5秒超时，失败不影响添加结果）
      if (added > 0 && options.rebindServiceUrl && options.rebindServiceToken) {
        const refreshUrl = `${options.rebindServiceUrl.replace(/\/+$/, '')}/admin/proxies/refresh`;
        fetch(refreshUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${options.rebindServiceToken}` },
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }

      return jsonResponse({
        total: lines.length,
        added,
        failed: errors.length,
        errors,
      });
    }

    // POST /api/admin/proxies/test — 测试所有代理连通性
    if (path === '/api/admin/proxies/test' && request.method === 'POST') {
      if (!options.rebindServiceUrl || !options.rebindServiceToken) {
        return errorResponse('换绑服务未配置，无法测试代理', 503);
      }

      let testResult;
      try {
        const resp = await fetch(
          `${options.rebindServiceUrl.replace(/\/+$/, '')}/admin/proxies/test`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${options.rebindServiceToken}` },
          }
        );
        if (!resp.ok) {
          const txt = await resp.text().catch(() => '');
          return errorResponse(`换绑服务返回 ${resp.status}: ${txt.slice(0, 200)}`, 502);
        }
        testResult = await resp.json();
      } catch (e) {
        return errorResponse('无法连接换绑服务：' + e.message, 502);
      }

      // 同步测试结果到 D1
      const items = testResult.items || [];
      const now = new Date().toISOString();
      try {
        for (const item of items) {
          const status = item.ok ? 'ok' : 'failed';
          if (item.ok) {
            await db.prepare(
              `UPDATE proxy_pool SET last_check_status = ?, last_check_at = ?, fail_count = 0, enabled = 1
               WHERE proxy_display = ?`
            ).bind(status, now, item.address).run();
          } else {
            // 失败时 fail_count + 1，连续失败 3 次以上自动禁用
            await db.prepare(
              `UPDATE proxy_pool SET last_check_status = ?, last_check_at = ?,
                 fail_count = fail_count + 1,
                 enabled = CASE WHEN fail_count + 1 >= 3 THEN 0 ELSE enabled END
               WHERE proxy_display = ?`
            ).bind(status, now, item.address).run();
          }
        }
      } catch (e) {
        // D1 同步失败不影响返回测试结果
        console.error('代理测试结果同步 D1 失败:', e);
      }

      return jsonResponse(testResult);
    }

    // PATCH /api/admin/proxies/:id — 启用/禁用
    const matchPatch = path.match(/^\/api\/admin\/proxies\/(\d+)$/);
    if (matchPatch && request.method === 'PATCH') {
      const id = parseInt(matchPatch[1], 10);
      let body;
      try { body = await request.json(); } catch (_) { return errorResponse('请求体必须为 JSON', 400); }
      if (typeof body.enabled !== 'boolean') return errorResponse('enabled 必须为布尔值', 400);

      try {
        const result = await db.prepare(
          'UPDATE proxy_pool SET enabled = ? WHERE id = ?'
        ).bind(body.enabled ? 1 : 0, id).run();
        if (!result.meta?.changes) return errorResponse('代理不存在', 404);
        return jsonResponse({ success: true, id, enabled: body.enabled });
      } catch (e) {
        return errorResponse('更新失败：' + e.message, 500);
      }
    }

    // DELETE /api/admin/proxies/:id — 删除
    const matchDel = path.match(/^\/api\/admin\/proxies\/(\d+)$/);
    if (matchDel && request.method === 'DELETE') {
      const id = parseInt(matchDel[1], 10);
      try {
        const result = await db.prepare('DELETE FROM proxy_pool WHERE id = ?').bind(id).run();
        if (!result.meta?.changes) return errorResponse('代理不存在', 404);
        return jsonResponse({ success: true, id });
      } catch (e) {
        return errorResponse('删除失败：' + e.message, 500);
      }
    }
  }

  return null;
}
