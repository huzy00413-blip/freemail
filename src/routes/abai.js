/**
 * aBaiFreeGPT API 代理路由
 * 将 /api/abai/* 转发到 ABAI_SERVICE_URL（Render 上的 aBaiFreeGPT 服务）
 *
 * 安全要求：
 * - 必须通过 freemail 登录认证（authMiddleware 已覆盖 /api/*）
 * - 请求体大小限制 10MB
 * - 超时 30 秒
 * - 不转发 freemail 的 Cookie 等敏感头
 * - 添加独立 Bearer token（ABAI_SERVICE_TOKEN）
 *
 * @module routes/abai
 */

import { Hono } from 'hono';

const router = new Hono();

/** 最大请求体 10MB */
const MAX_BODY_SIZE = 10 * 1024 * 1024;
/** 上游超时 30 秒 */
const UPSTREAM_TIMEOUT = 30_000;

/**
 * 从请求路径中提取上游路径。
 * /api/abai/foo/bar -> /foo/bar
 * /api/abai -> /
 * /api/abai/ -> /
 */
function extractUpstreamPath(path) {
  const prefix = '/api/abai';
  let rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (!rest.startsWith('/')) rest = '/' + rest;
  return rest;
}

/**
 * 转发请求到上游 aBaiFreeGPT 服务。
 */
async function proxyRequest(c) {
  const serviceUrl = String(c.env.ABAI_SERVICE_URL || '').trim().replace(/\/+$/, '');
  const serviceToken = String(c.env.ABAI_SERVICE_TOKEN || '').trim();

  if (!serviceUrl) {
    return c.json({ error: 'AI 服务未配置（ABAI_SERVICE_URL）' }, 503);
  }

  const upstreamPath = extractUpstreamPath(c.req.path);
  const url = new URL(c.req.url);
  const targetUrl = serviceUrl + upstreamPath + (url.search || '');

  // 构建转发头：不转发 Cookie、Authorization（freemail 的），使用独立 token
  const headers = new Headers();
  const reqHeaders = c.req.raw.headers;
  for (const [key, value] of reqHeaders.entries()) {
    const lower = key.toLowerCase();
    // 跳过敏感头和逐跳头
    if (['cookie', 'authorization', 'x-forwarded-for', 'x-forwarded-proto',
         'x-real-ip', 'host', 'connection', 'content-length'].includes(lower)) {
      continue;
    }
    headers.set(key, value);
  }
  // 设置上游服务 token
  if (serviceToken) {
    headers.set('Authorization', `Bearer ${serviceToken}`);
  }
  headers.set('X-Forwarded-Proto', 'https');

  // 请求体大小限制
  let body = null;
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      return c.json({ error: '请求体过大（上限 10MB）' }, 413);
    }
    body = await c.req.raw.arrayBuffer();
    if (body.byteLength > MAX_BODY_SIZE) {
      return c.json({ error: '请求体过大（上限 10MB）' }, 413);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const resp = await fetch(targetUrl, {
      method,
      headers,
      body: body,
      signal: controller.signal,
      redirect: 'follow',
    });

    // 构建响应头
    const respHeaders = new Headers();
    for (const [key, value] of resp.headers.entries()) {
      const lower = key.toLowerCase();
      // 跳过逐跳头和可能导致问题的头
      if (['connection', 'transfer-encoding', 'content-encoding',
           'content-length', 'set-cookie'].includes(lower)) {
        continue;
      }
      respHeaders.set(key, value);
    }

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      return c.json({ error: 'AI 服务请求超时' }, 504);
    }
    console.error('[abai proxy] upstream error:', e.message);
    return c.json({ error: 'AI 服务暂时不可用' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

// 所有方法和路径都转发
router.all('/*', proxyRequest);

export default router;
