/**
 * 代理凭据 AES-GCM 加密/解密（Web Crypto API）
 *
 * 存储格式（hex）：IV(12 bytes) + ciphertext + authTag(16 bytes)
 * 密钥从环境变量 PROXY_ENCRYPTION_KEY 读取（32 字节 hex = 64 hex chars）。
 *
 * @module utils/proxy-crypto
 */

const ALGO = { name: 'AES-GCM', length: 256 };
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

let _keyPromise = null;

/**
 * 获取加密密钥（缓存 Promise，避免重复 importKey）。
 * @param {string} keyHex - 64 字符 hex 字符串（32 字节）
 * @returns {Promise<CryptoKey>}
 */
function getKey(keyHex) {
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('PROXY_ENCRYPTION_KEY 必须为 32 字节 hex（64 字符）');
  }
  if (!_keyPromise) {
    const keyBytes = hexToBytes(keyHex);
    _keyPromise = crypto.subtle.importKey('raw', keyBytes, ALGO, false, ['encrypt', 'decrypt']);
  }
  return _keyPromise;
}

/**
 * 加密明文代理 URL。
 * @param {string} plaintext - 完整代理 URL（含凭据）
 * @param {string} keyHex - 加密密钥 hex
 * @returns {Promise<string>} hex 编码的 IV + ciphertext + tag
 */
export async function encryptProxyUrl(plaintext, keyHex) {
  const key = await getKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
    key,
    encoded
  );
  // 拼接 IV + ciphertext（含 authTag，Web Crypto 将 tag 附加在密文末尾）
  const combined = new Uint8Array(IV_LENGTH + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), IV_LENGTH);
  return bytesToHex(combined);
}

/**
 * 解密密文，还原完整代理 URL。
 * @param {string} hexCiphertext - hex 编码的 IV + ciphertext + tag
 * @param {string} keyHex - 加密密钥 hex
 * @returns {Promise<string>} 明文代理 URL
 */
export async function decryptProxyUrl(hexCiphertext, keyHex) {
  const key = await getKey(keyHex);
  const data = hexToBytes(hexCiphertext);
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('密文长度不足');
  }
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: TAG_LENGTH * 8 },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plainBuf);
}

/**
 * 计算代理 URL 的 SHA-256 哈希（用于去重，不泄露明文）。
 * @param {string} plaintext - 完整代理 URL
 * @returns {Promise<string>} hex 编码的 SHA-256
 */
export async function hashProxyUrl(plaintext) {
  const encoded = new TextEncoder().encode(plaintext);
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(hashBuf));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
