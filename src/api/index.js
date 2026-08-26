/**
 * API 路由注册
 */

import { handleSessionApi } from './session.js';
import { handleMailboxesApi } from './mailboxes.js';
import { handleMailApi } from './mail.js';
import { handleAdminApi } from './admin.js';
import { handleRebindApi } from './rebind.js';
import { handleDomainsApi } from './domains.js';
import { handleProxiesApi } from './proxies.js';
import { handleExternalInboxesApi } from './external-inboxes.js';
import { handleMailpostApi } from './mailpost.js';

export { getExternalInbox } from './external-inboxes.js';

/**
 * 处理所有 /api/* 请求
 */
export async function handleApiRequest(request, db, env, options) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 会话相关
  if (path.startsWith('/api/session')) {
    return handleSessionApi(request, db, url, path, options);
  }

  // 邮箱管理
  if (path.startsWith('/api/mailboxes')) {
    return handleMailboxesApi(request, db, url, path, options);
  }

  // 邮件收发
  if (path.startsWith('/api/mail')) {
    return handleMailApi(request, db, url, path, options);
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
    return handleAdminApi(request, db, url, path, options);
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
