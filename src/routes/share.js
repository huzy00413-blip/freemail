/**
 * 公开分享路由：无需登录即可查看分享的邮件
 * @module routes/share
 */
import { Hono } from 'hono';
import { getInitializedDatabase } from '../db/index.js';
import { parseEmailBody } from '../email/parser.js';

const router = new Hono();

/**
 * HTML 转义（服务端版本，无 DOM 依赖）
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML 属性转义
 */
function escapeAttr(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 基础 XSS 过滤：移除危险标签和属性
 */
function sanitizeHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<\/?(?:iframe|object|embed|form|input|button|textarea|select|option|link|meta|base|svg|math)[^>]*>/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
  s = s.replace(/javascript\s*:/gi, '');
  s = s.replace(/expression\s*\(/gi, '');
  return s;
}

/**
 * 格式化时间为东八区显示
 */
function formatTime(ts) {
  if (!ts) return '';
  try {
    const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
    const d = new Date(iso + 'Z');
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).format(d);
  } catch (_) { return ts; }
}

/**
 * 渲染 404 页面
 */
function renderNotFound() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>分享链接不存在</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 40px; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); max-width: 400px; }
    h1 { color: #333; margin: 0 0 12px; font-size: 24px; }
    p { color: #666; margin: 0; line-height: 1.6; }
    .icon { font-size: 48px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔍</div>
    <h1>分享链接不存在</h1>
    <p>该分享链接可能已失效或被删除，请确认链接是否正确。</p>
  </div>
</body>
</html>`;
}

/**
 * 渲染邮件分享页面
 */
function renderSharePage(email) {
  const subject = escapeHtml(email.subject || '(无主题)');
  const sender = escapeHtml(email.sender || '未知发件人');
  const to = escapeHtml(email.to_addrs || '');
  const receivedAt = formatTime(email.received_at);
  const verificationCode = email.verification_code || '';

  let bodyContent = '';
  if (email.html_content) {
    const safeHtml = sanitizeHtml(email.html_content);
    bodyContent = `<iframe srcdoc="${escapeAttr(safeHtml)}" sandbox="allow-same-origin allow-popups" style="width:100%;min-height:500px;border:none;display:block;background:#fff;"></iframe>`;
  } else {
    bodyContent = `<pre style="white-space:pre-wrap;word-break:break-word;padding:16px;margin:0;font-family:inherit;color:#333;line-height:1.6;">${escapeHtml(email.content || '')}</pre>`;
  }

  let codeHtml = '';
  if (verificationCode) {
    codeHtml = `<div style="margin:12px 0;padding:12px 16px;background:#e8f5e9;border-radius:8px;border-left:4px solid #4caf50;">
      <span style="color:#2e7d32;font-weight:600;">验证码：</span>
      <span style="font-size:18px;font-weight:700;color:#1b5e20;letter-spacing:2px;">${escapeHtml(verificationCode)}</span>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${subject} - 邮件分享</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background: #f0f2f5; color: #333; }
    .header { background: #fff; border-bottom: 1px solid #e8e8e8; padding: 16px 24px; position: sticky; top: 0; z-index: 10; }
    .header-title { font-size: 14px; color: #888; margin: 0; display: flex; align-items: center; gap: 8px; }
    .header-title::before { content: '📧'; font-size: 18px; }
    .container { max-width: 800px; margin: 24px auto; padding: 0 16px; }
    .email-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); overflow: hidden; }
    .email-header { padding: 24px 28px 16px; border-bottom: 1px solid #f0f0f0; }
    .email-subject { font-size: 22px; font-weight: 700; color: #1a1a1a; margin: 0 0 16px; word-break: break-all; line-height: 1.4; }
    .email-meta { display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 13px; color: #666; }
    .email-meta span { display: inline-flex; align-items: center; gap: 4px; }
    .email-meta .label { color: #999; }
    .email-body { padding: 20px 28px 28px; }
    .footer { text-align: center; padding: 24px; color: #aaa; font-size: 12px; }
    @media (max-width: 600px) {
      .email-header { padding: 16px; }
      .email-subject { font-size: 18px; }
      .email-body { padding: 16px; }
      .email-meta { flex-direction: column; gap: 4px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <p class="header-title">公开分享的邮件</p>
  </div>
  <div class="container">
    <div class="email-card">
      <div class="email-header">
        <h1 class="email-subject">${subject}</h1>
        <div class="email-meta">
          <span><span class="label">发件人：</span>${sender}</span>
          ${to ? `<span><span class="label">收件人：</span>${to}</span>` : ''}
          <span><span class="label">时间：</span>${receivedAt}</span>
        </div>
      </div>
      <div class="email-body">
        ${codeHtml}
        ${bodyContent}
      </div>
    </div>
    <div class="footer">此邮件通过 Freemail 公开分享链接查看</div>
  </div>
</body>
</html>`;
}

router.get('/share/:token', async (c) => {
  const token = c.req.param('token');
  if (!token || !/^[a-z0-9]+$/.test(token)) {
    return c.html(renderNotFound(), 404);
  }

  let DB;
  try {
    DB = await getInitializedDatabase(c.env);
  } catch (_) {
    return c.html(renderNotFound(), 404);
  }

  try {
    const share = await DB.prepare(
      'SELECT id, message_id, expire_at FROM message_share WHERE token = ? LIMIT 1'
    ).bind(token).first();

    if (!share) {
      return c.html(renderNotFound(), 404);
    }

    if (share.expire_at && new Date(share.expire_at) <= new Date()) {
      return c.html(renderNotFound(), 404);
    }

    const message = await DB.prepare(
      'SELECT id, sender, to_addrs, subject, verification_code, r2_bucket, r2_object_key, received_at FROM messages WHERE id = ? LIMIT 1'
    ).bind(share.message_id).first();

    if (!message) {
      return c.html(renderNotFound(), 404);
    }

    let content = '';
    let html_content = '';
    const r2 = c.env.MAIL_EML;
    if (r2 && message.r2_object_key) {
      try {
        const obj = await r2.get(message.r2_object_key);
        if (obj) {
          let raw = '';
          if (typeof obj.text === 'function') raw = await obj.text();
          else if (typeof obj.arrayBuffer === 'function') raw = await new Response(await obj.arrayBuffer()).text();
          else raw = await new Response(obj.body).text();
          const parsed = await parseEmailBody(raw || '');
          content = parsed.text || '';
          html_content = parsed.html || '';
        }
      } catch (e) {
        console.error('读取 R2 邮件失败:', e);
      }
    }

    if (!content && !html_content) {
      try {
        const fallback = await DB.prepare(
          'SELECT content, html_content FROM messages WHERE id = ?'
        ).bind(share.message_id).first();
        if (fallback) {
          content = fallback.content || '';
          html_content = fallback.html_content || '';
        }
      } catch (_) { }
    }

    const email = {
      ...message,
      content,
      html_content
    };

    return c.html(renderSharePage(email));
  } catch (e) {
    console.error('分享页面错误:', e);
    return c.html(renderNotFound(), 404);
  }
});

export default router;
