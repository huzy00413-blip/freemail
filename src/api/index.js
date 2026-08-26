/**
 * API 路由注册
 */

import { handleUsersApi } from './users.js';
import { handleMailboxesApi } from './mailboxes.js';
import { handleMailboxAdminApi } from './mailboxAdmin.js';
import { handleEmailsApi } from './emails.js';
import { handleSendApi } from './send.js';
import { handleRebindApi } from './rebind.js';
import { handleDomainsApi } from './domains.js';
import { handleProxiesApi } from './proxies.js';
import { handleExternalInboxesApi } from './external-inboxes.js';
import { handleMailpostApi } from './mailpost.js';

export { getExternalInbox } from './external-inboxes.js';

/**
 * 处理所有 /api/* 请求
 * @param {Request} request
 * @param {object} db - D1 数据库
 * @param {string[]} mailDomains - 启用的域名列表
 * @param {object} options
 */
export async function handleApiRequest(request, db, mailDomains, options) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 用户管理
  if (path.startsWith('/api/users')) {
    return handleUsersApi(request, db, url, path, options);
  }

  // 邮箱管理（管理员操作：删除、重置密码、转发收藏等）
  const mailboxAdminResp = await handleMailboxAdminApi(request, db, url, path, options);
  if (mailboxAdminResp) return mailboxAdminResp;

  // 邮箱列表/创建
  if (path.startsWith('/api/mailboxes')) {
    return handleMailboxesApi(request, db, mailDomains, url, path, options);
  }

  // 邮件收发
  if (path.startsWith('/api/email') || path.startsWith('/api/message')) {
    return handleEmailsApi(request, db, url, path, options);
  }

  // 发件
  if (path.startsWith('/api/send') || path.startsWith('/api/sent')) {
    return handleSendApi(request, db, url, path, options);
  }

  // 管理员接口
  if (path.startsWith('/api/admin')) {
    if (path.startsWith('/api/admin/domains')) {
      return handleDomainsApi(request, db, url, path, options);
    }
    if (path.startsWith('/api/admin/proxies')) {
      return handleProxiesApi(request, db, url, path, options);
    }
    if (path.startsWith('/api/admin/external-inboxes')) {
      return handleExternalInboxesApi(request, db, url, path, options);
    }
    // 其他管理员操作走用户管理
    return handleUsersApi(request, db, url, path, options);
  }

  // 换绑相关
  if (path.startsWith('/api/rebind')) {
    return handleRebindApi(request, db, url, path, options);
  }

  // 邮局系统管理
  if (path.startsWith('/api/mailpost')) {
    return handleMailpostApi(request, db, url, path, options);
  }

  return new Response(JSON.stringify({ error: 'API not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}
