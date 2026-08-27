/**
 * 会话 UI 模块
 * 处理登录状态、用户信息显示、权限相关 UI 控制
 */

import { apiFetch } from '../../api.js';

let currentUser = null;
let sessionListeners = [];

/**
 * 获取当前用户信息
 */
export function getCurrentUser() {
  return currentUser;
}

/**
 * 检查是否已登录
 */
export function isLoggedIn() {
  return !!currentUser;
}

/**
 * 检查是否为严格管理员（root）
 */
export function isStrictAdmin() {
  return currentUser && currentUser.role === 'root';
}

/**
 * 检查是否为管理员（root 或 admin）
 */
export function isAdmin() {
  return currentUser && (currentUser.role === 'root' || currentUser.role === 'admin');
}

/**
 * 注册会话变化监听器
 */
export function onSessionChange(callback) {
  sessionListeners.push(callback);
}

/**
 * 通知监听器
 */
function notifyListeners() {
  for (const cb of sessionListeners) {
    try { cb(currentUser); } catch (_) {}
  }
}

/**
 * 从 /api/session 获取当前用户信息
 */
export async function fetchSession() {
  try {
    const data = await apiFetch('/api/session');
    if (data && data.user) {
      currentUser = data.user;
    } else {
      currentUser = null;
    }
  } catch (_) {
    currentUser = null;
  }
  applySessionUI();
  notifyListeners();
  return currentUser;
}

/**
 * 应用会话相关的 UI 显示/隐藏
 */
export function applySessionUI() {
  const user = currentUser;

  // 登录/未登录元素
  document.querySelectorAll('[data-auth="logged-in"]').forEach(el => {
    el.style.display = user ? '' : 'none';
  });
  document.querySelectorAll('[data-auth="logged-out"]').forEach(el => {
    el.style.display = user ? 'none' : '';
  });

  // 管理员元素
  document.querySelectorAll('[data-auth="admin"]').forEach(el => {
    el.style.display = isAdmin() ? '' : 'none';
  });

  // 严格管理员元素
  document.querySelectorAll('[data-auth="strict-admin"]').forEach(el => {
    el.style.display = isStrictAdmin() ? '' : 'none';
  });

  // 用户名显示
  document.querySelectorAll('[data-user="name"]').forEach(el => {
    el.textContent = user ? (user.username || user.email || '') : '';
  });
  document.querySelectorAll('[data-user="email"]').forEach(el => {
    el.textContent = user ? (user.email || '') : '';
  });
  document.querySelectorAll('[data-user="role"]').forEach(el => {
    el.textContent = user ? (user.role || '') : '';
  });

  // 侧边栏入口控制
  const domainsLink = document.getElementById('domains-link');
  if (domainsLink) domainsLink.style.display = isStrictAdmin() ? '' : 'none';

  const proxiesLink = document.getElementById('proxies-link');
  if (proxiesLink) proxiesLink.style.display = isStrictAdmin() ? '' : 'none';

  const extInboxesLink = document.getElementById('external-inboxes-link');
  if (extInboxesLink) extInboxesLink.style.display = isStrictAdmin() ? '' : 'none';

  const mailpostLink = document.getElementById('mailpost-link');
  if (mailpostLink) mailpostLink.style.display = isStrictAdmin() ? '' : 'none';
}

/**
 * 登出
 */
export async function logout() {
  try {
    await apiFetch('/api/session/logout', { method: 'POST' });
  } catch (_) {}
  currentUser = null;
  applySessionUI();
  notifyListeners();
}

/**
 * 初始化会话模块
 */
export async function initSession() {
  await fetchSession();
}

/**
 * 从缓存初始化会话（不发起网络请求）
 */
export function initSessionFromCache() {
  try {
    const cached = localStorage.getItem('mailfree:user');
    if (cached) {
      currentUser = JSON.parse(cached);
      applySessionUI();
      notifyListeners();
    }
  } catch (_) {}
}

/**
 * 验证当前会话（发起网络请求）
 * @returns {Promise<object|null>} 用户信息或 null
 */
export async function validateSession() {
  try {
    const res = await fetch('/api/session', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      currentUser = data;
      try { localStorage.setItem('mailfree:user', JSON.stringify(data)); } catch (_) {}
      applySessionUI();
      notifyListeners();
      return data;
    }
  } catch (_) {}
  currentUser = null;
  try { localStorage.removeItem('mailfree:user'); } catch (_) {}
  applySessionUI();
  notifyListeners();
  return null;
}

/**
 * 检查是否为访客模式
 * @returns {boolean}
 */
export function isGuest() {
  return currentUser && currentUser.role === 'guest';
}

/**
 * 初始化访客模式
 */
export function initGuestMode() {
  window.__GUEST_MODE__ = true;
  // 隐藏管理员相关元素
  document.querySelectorAll('[data-auth="admin"], [data-auth="strict-admin"]').forEach(el => {
    el.style.display = 'none';
  });
}
