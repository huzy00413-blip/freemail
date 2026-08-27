/**
 * API 请求封装
 * @module api
 */

/**
 * 统一 API 请求函数
 * @param {string} path - 请求路径
 * @param {object} options - fetch 选项
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    if (location.pathname !== '/html/login.html') location.replace('/html/login.html');
    throw new Error('unauthorized');
  }
  return res;
}

export default { apiFetch };
