/**
 * 邮件 API 处理器。
 * @module api/emails
 */

import { getMailboxAccess, getMessageAccess, errorResponse } from './helpers.js';
import { buildMockEmails, buildMockEmailDetail } from './mock.js';
import { extractEmail, generateRandomId } from '../utils/common.js';
import { getMailboxIdByAddress } from '../db/index.js';
import { parseEmailBody } from '../email/parser.js';
import { getMailpostMailbox, fetchMailpostInbox } from './mailpost.js';

/**
 * 从邮局系统拉取指定邮箱的收件箱。
 * 流程：admin 查详情拿 mailbox_key → /api/get_mailbox_token 换 token → /api/get_inbox。
 * 邮局不可用时返回 { ok: false }，由调用方回退到 D1。
 * @param {object} options - 含 mailpostApiUrl / mailpostAdminToken
 * @param {string} address - 邮箱地址
 * @returns {Promise<{ok:boolean, emails?:Array, error?:string}>}
 */
export async function fetchMailpostEmails(options, address) {
  if (!address) return { ok: false, error: '缺少邮箱地址' };

  // 1. admin 查详情拿 mailbox_key（复用已有函数）
  const mp = await getMailpostMailbox(options, address);
  if (!mp.exists || !mp.mailbox?.mailbox_key) {
    return { ok: false, error: '邮局中未找到该邮箱或缺少 mailbox_key' };
  }

  // 2. 换 token + 拉 inbox（复用已有函数）
  const result = await fetchMailpostInbox(options, address, mp.mailbox.mailbox_key);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // 3. 映射为前端兼容格式 {id, sender, to_addrs, subject, received_at, is_read, preview, verification_code}
  const emails = (result.emails || []).map((e, idx) => {
    const body = String(e.Body || e.body || e.Text || e.text || '');
    return {
      id: e.id || e.ID || e.MessageID || `mp-${idx}`,
      sender: e.From || e.from || e.Sender || e.sender || '',
      to_addrs: address,
      subject: e.Subject || e.subject || '(无主题)',
      received_at: e.Sent || e.Timestamp || e.Date || e.received_at || '',
      is_read: 0,
      preview: body.substring(0, 120),
      verification_code: '',
    };
  });

  // 按时间倒序
  emails.sort((a, b) => {
    const ta = new Date(a.received_at).getTime() || 0;
    const tb = new Date(b.received_at).getTime() || 0;
    return tb - ta;
  });

  return { ok: true, emails };
}

// 邮箱登录模式只允许查看最近 24 小时内的邮件。
function mailboxOnlyTimeFilter(enabled) {
  if (!enabled) return { sql: '', params: [] };
  return {
    sql: ' AND received_at >= ?',
    params: [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]
  };
}

// 邮件正文优先从 R2 原始 EML 解析，失败时由调用方回退到数据库字段。
async function loadEmailBodyFromR2(r2, objectKey) {
  if (!r2 || !objectKey) return { content: '', html_content: '' };
  try {
    const obj = await r2.get(objectKey);
    if (!obj) return { content: '', html_content: '' };
    let raw = '';
    if (typeof obj.text === 'function') raw = await obj.text();
    else if (typeof obj.arrayBuffer === 'function') raw = await new Response(await obj.arrayBuffer()).text();
    else raw = await new Response(obj.body).text();
    const parsed = await parseEmailBody(raw || '');
    return { content: parsed.text || '', html_content: parsed.html || '' };
  } catch (_) {
    return { content: '', html_content: '' };
  }
}

export async function handleEmailsApi(request, db, url, path, options) {
  const isMock = !!options.mockOnly;
  const isMailboxOnly = !!options.mailboxOnly;
  const r2 = options.r2;

  if (path === '/api/emails' && request.method === 'GET') {
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) return errorResponse('缺少 mailbox 参数', 400);
    try {
      if (isMock) return Response.json(buildMockEmails(6));

      const normalized = extractEmail(mailbox).trim().toLowerCase();

      // 优先走邮局系统，失败静默回退 D1
      try {
        const mpResult = await fetchMailpostEmails(options, normalized);
        if (mpResult.ok) {
          return Response.json(mpResult.emails || []);
        }
      } catch (e) {
        console.error('[emails] 邮局查询失败，回退D1:', e.message);
      }

      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) return Response.json([]);
      const access = await getMailboxAccess(db, request, options, { mailboxId });
      if (!access.allowed) return errorResponse('Forbidden', 403);

      const filter = mailboxOnlyTimeFilter(isMailboxOnly);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      try {
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, received_at, is_read, preview, verification_code
          FROM messages
          WHERE mailbox_id = ?${filter.sql}
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailboxId, ...filter.params, limit).all();
        return Response.json(results || []);
      } catch (_) {
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, received_at, is_read,
                 CASE WHEN content IS NOT NULL AND content <> ''
                      THEN SUBSTR(content, 1, 120)
                      ELSE SUBSTR(COALESCE(html_content, ''), 1, 120)
                 END AS preview
          FROM messages
          WHERE mailbox_id = ?${filter.sql}
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailboxId, ...filter.params, limit).all();
        return Response.json(results || []);
      }
    } catch (e) {
      console.error('查询邮件失败:', e);
      return errorResponse('查询邮件失败', 500);
    }
  }

  if (path === '/api/emails/batch' && request.method === 'GET') {
    try {
      const idsParam = String(url.searchParams.get('ids') || '').trim();
      if (!idsParam) return Response.json([]);
      const ids = idsParam.split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
      if (!ids.length) return Response.json([]);
      if (ids.length > 50) return errorResponse('单次最多查询50封邮件', 400);
      if (isMock) return Response.json(ids.map(id => buildMockEmailDetail(id)));

      for (const id of ids) {
        const access = await getMessageAccess(db, request, options, id);
        if (access.exists && !access.allowed) return errorResponse('Forbidden', 403);
      }

      const filter = mailboxOnlyTimeFilter(isMailboxOnly);
      const placeholders = ids.map(() => '?').join(',');
      try {
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${filter.sql}
        `).bind(...ids, ...filter.params).all();
        return Response.json(results || []);
      } catch (_) {
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, content, html_content, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${filter.sql}
        `).bind(...ids, ...filter.params).all();
        return Response.json(results || []);
      }
    } catch (_) {
      return errorResponse('批量查询失败', 500);
    }
  }

  if (request.method === 'DELETE' && path === '/api/emails') {
    if (isMock) return errorResponse('演示模式不可清空', 403);
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) return errorResponse('缺少 mailbox 参数', 400);
    try {
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) return Response.json({ success: true, deletedCount: 0 });
      const access = await getMailboxAccess(db, request, options, { mailboxId });
      if (!access.allowed) return errorResponse('Forbidden', 403);

      const { results: toDelete } = await db.prepare(
        'SELECT r2_object_key FROM messages WHERE mailbox_id = ? AND r2_object_key IS NOT NULL'
      ).bind(mailboxId).all();
      const result = await db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailboxId).run();
      const deletedCount = result?.meta?.changes || 0;

      if (r2 && toDelete?.length) {
        for (const { r2_object_key } of toDelete) {
          try { await r2.delete(r2_object_key); } catch (err) {
            console.error('清空邮件时删除 R2 对象失败:', err);
          }
        }
      }

      return Response.json({ success: true, deletedCount });
    } catch (e) {
      console.error('清空邮件失败:', e);
      return errorResponse('清空邮件失败', 500);
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/') && path.endsWith('/download')) {
    if (isMock) return errorResponse('演示模式不可下载', 403);
    const id = path.split('/')[3];
    const access = await getMessageAccess(db, request, options, id);
    if (!access.exists) return errorResponse('未找到邮件', 404);
    if (!access.allowed) return errorResponse('Forbidden', 403);

    const { results } = await db.prepare('SELECT r2_bucket, r2_object_key FROM messages WHERE id = ?').bind(id).all();
    const row = (results || [])[0];
    if (!row || !row.r2_object_key) return errorResponse('未找到对象', 404);
    try {
      if (!r2) return errorResponse('R2 未绑定', 500);
      const obj = await r2.get(row.r2_object_key);
      if (!obj) return errorResponse('对象不存在', 404);
      const headers = new Headers({ 'Content-Type': 'message/rfc822' });
      headers.set('Content-Disposition', `attachment; filename="${String(row.r2_object_key).split('/').pop()}"`);
      return new Response(obj.body, { headers });
    } catch (_) {
      return errorResponse('下载失败', 500);
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/')) {
    const emailId = path.split('/')[3];
    if (isMock) return Response.json(buildMockEmailDetail(emailId));

    const access = await getMessageAccess(db, request, options, emailId);
    if (!access.exists) return errorResponse('未找到邮件', 404);
    if (!access.allowed) return errorResponse('Forbidden', 403);

    try {
      const filter = mailboxOnlyTimeFilter(isMailboxOnly);
      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, received_at, is_read
        FROM messages WHERE id = ?${filter.sql}
      `).bind(emailId, ...filter.params).all();
      if (!results || results.length === 0) return errorResponse('未找到邮件', 404);

      await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(emailId).run();
      const row = results[0];
      let { content, html_content } = await loadEmailBodyFromR2(r2, row.r2_object_key);

      if (!content && !html_content) {
        try {
          const fallback = await db.prepare('SELECT content, html_content FROM messages WHERE id = ?').bind(emailId).all();
          const fr = (fallback?.results || [])[0] || {};
          content = fr.content || '';
          html_content = fr.html_content || '';
        } catch (_) { }
      }

      return Response.json({
        ...row,
        content,
        html_content,
        download: row.r2_object_key ? `/api/email/${emailId}/download` : ''
      });
    } catch (_) {
      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, content, html_content, received_at, is_read
        FROM messages WHERE id = ?
      `).bind(emailId).all();
      if (!results || !results.length) return errorResponse('未找到邮件', 404);
      await db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').bind(emailId).run();
      return Response.json(results[0]);
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/email/')) {
    if (isMock) return errorResponse('演示模式不可删除', 403);
    const emailId = path.split('/')[3];
    if (!emailId || !Number.isInteger(parseInt(emailId, 10))) return errorResponse('无效的邮件ID', 400);

    const access = await getMessageAccess(db, request, options, emailId);
    if (!access.exists) return errorResponse('未找到邮件', 404);
    if (!access.allowed) return errorResponse('Forbidden', 403);

    try {
      const row = await db.prepare('SELECT r2_object_key FROM messages WHERE id = ?').bind(emailId).first();
      const result = await db.prepare('DELETE FROM messages WHERE id = ?').bind(emailId).run();
      const deleted = (result?.meta?.changes || 0) > 0;

      if (deleted && r2 && row?.r2_object_key) {
        try { await r2.delete(row.r2_object_key); } catch (err) {
          console.error('删除 R2 对象失败:', err);
        }
      }

      return Response.json({
        success: true,
        deleted,
        message: deleted ? '邮件已删除' : '邮件不存在或已被删除'
      });
    } catch (e) {
      console.error('删除邮件失败:', e);
      return errorResponse('删除邮件时发生错误: ' + e.message, 500);
    }
  }

  // 生成邮件公开分享链接
  if (request.method === 'POST' && path.startsWith('/api/message/') && path.endsWith('/share')) {
    if (isMock) return errorResponse('演示模式不可分享', 403);
    const parts = path.split('/');
    const messageId = parts[3];
    if (!messageId || !Number.isInteger(parseInt(messageId, 10))) return errorResponse('无效的邮件ID', 400);
    const access = await getMessageAccess(db, request, options, messageId);
    if (!access.exists) return errorResponse('未找到邮件', 404);
    if (!access.allowed) return errorResponse('Forbidden', 403);
    try {
      const existing = await db.prepare(
        'SELECT id, token, expire_at FROM message_share WHERE message_id = ? ORDER BY id DESC LIMIT 1'
      ).bind(Number(messageId)).first();
      let token;
      if (existing && (!existing.expire_at || new Date(existing.expire_at) > new Date())) {
        token = existing.token;
      } else {
        token = generateRandomId(16);
        await db.prepare(
          'INSERT INTO message_share (message_id, token, expire_at) VALUES (?, ?, NULL)'
        ).bind(Number(messageId), token).run();
      }
      const origin = options.workerOrigin || '';
      const shareUrl = `${origin}/share/${token}`;
      return Response.json({
        success: true,
        token,
        share_url: shareUrl,
        message: '分享链接已生成'
      });
    } catch (e) {
      console.error('生成分享链接失败:', e);
      return errorResponse('生成分享链接失败: ' + e.message, 500);
    }
  }

  return null;
}
