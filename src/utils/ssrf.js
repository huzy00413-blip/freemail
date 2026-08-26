/**
 * SSRF 防护工具
 * 验证外部接码地址 URL，禁止访问内网、回环地址和云元数据地址。
 *
 * @module utils/ssrf
 */

/** 禁止的 hostname 模式 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  '169.254.169.254', // 云元数据
  'metadata.google.internal',
  'metadata',
]);

/** 内网网段正则 */
const PRIVATE_IP_PATTERNS = [
  /^10\./,                    // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./,              // 192.168.0.0/16
  /^169\.254\./,              // 169.254.0.0/16 (link-local)
  /^127\./,                   // 127.0.0.0/8
  /^fc00:/,                   // IPv6 unique local
  /^fe80:/,                   // IPv6 link-local
  /^::1$/,                    // IPv6 loopback
];

/**
 * 验证 URL 是否安全（防 SSRF）。
 * @param {string} url - 待验证的 URL
 * @returns {{ok: boolean, error?: string, parsed?: URL}}
 */
export function validateInboxUrl(url) {
  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'URL 不能为空' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'URL 格式非法' };
  }

  // 只允许 http/https
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: '只允许 http/https 协议' };
  }

  const hostname = parsed.hostname.toLowerCase().trim();
  if (!hostname) {
    return { ok: false, error: 'URL 缺少 hostname' };
  }

  // 检查禁止的 hostname
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, error: '禁止访问回环或元数据地址' };
  }

  // 检查内网 IP（hostname 是 IP 地址时）
  if (isIpAddress(hostname)) {
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { ok: false, error: '禁止访问内网地址' };
      }
    }
  }

  return { ok: true, parsed };
}

/**
 * 判断字符串是否为 IP 地址（IPv4 或 IPv6）。
 */
function isIpAddress(str) {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(str)) {
    return true;
  }
  if (str.includes(':') && /^[0-9a-f:]+$/i.test(str)) {
    return true;
  }
  return false;
}

/**
 * 脱敏 URL（用于日志和前端显示，隐藏 query 中的敏感参数）。
 */
export function maskInboxUrl(url) {
  try {
    const parsed = new URL(url);
    const sensitiveParams = ['auth_code', 'token', 'key', 'secret', 'password', 'api_key', 'apikey'];
    for (const [key] of parsed.searchParams) {
      if (sensitiveParams.includes(key.toLowerCase())) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
