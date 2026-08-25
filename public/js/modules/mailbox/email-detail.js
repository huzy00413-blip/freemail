/**
 * 邮件详情模块
 * @module modules/mailbox/email-detail
 */

import { escapeHtml, escapeAttr } from '../app/ui-helpers.js';
import { formatTime } from './email-list.js';

/**
 * 渲染邮件详情
 * @param {object} email - 邮件数据
 * @returns {string}
 */
export function renderEmailDetail(email) {
  if (!email) {
    return '<div class="empty-detail">请选择一封邮件</div>';
  }
  
  const sender = escapeHtml(email.sender || '未知发件人');
  const to = escapeHtml(email.to_addrs || '');
  const subject = escapeHtml(email.subject || '(无主题)');
  const receivedAt = formatTime(email.received_at);
  const verificationCode = email.verification_code || '';
  
  // 优先使用 HTML 内容
  let content = '';
  if (email.html_content) {
    // 对 HTML 内容进行安全处理
    content = sanitizeHtml(email.html_content);
  } else {
    content = `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(email.content || '')}</pre>`;
  }
  
  let metaHtml = `<div class="email-meta-inline">`;
  metaHtml += `<span>发件人：${sender}</span>`;
  if (to) metaHtml += `<span>收件人：${to}</span>`;
  metaHtml += `<span>${receivedAt}</span>`;
  metaHtml += `</div>`;

  let codeHtml = '';
  if (verificationCode) {
    codeHtml = `<div class="code-highlight" onclick="navigator.clipboard.writeText('${escapeAttr(verificationCode)}')" title="点击复制" style="cursor:pointer">${escapeHtml(verificationCode)}</div>`;
  }

  // 分享链接区域
  const shareHtml = `
    <div class="email-share-section" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border,#e8e8e8);">
      <div id="share-link-container" style="display:none; margin-bottom:12px;">
        <div style="display:flex;gap:8px;align-items:center;">
          <input id="share-link-input" type="text" readonly style="flex:1;padding:8px 12px;border:1px solid var(--border,#ddd);border-radius:6px;font-size:13px;background:var(--bg-secondary,#f9f9f9);color:var(--text,#333);" />
          <button class="btn btn-secondary btn-sm" onclick="copyShareLinkMb()" style="white-space:nowrap;">复制链接</button>
        </div>
      </div>
      <button id="share-btn" class="btn btn-primary btn-sm" onclick="generateShareLinkMb(${email.id})" style="display:inline-flex;align-items:center;gap:6px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-share"/></svg>
        生成公开分享链接
      </button>
    </div>
  `;

  return `
    <div class="email-detail-container">
      <h2 style="font-size:18px;font-weight:700;color:var(--text);word-break:break-all;padding:0 4px">${subject}</h2>
      ${metaHtml}
      ${codeHtml}
      ${content}
      ${shareHtml}
    </div>
  `;
}

/**
 * 使用白名单方式安全净化 HTML，替换移除固定危险标签的简单实现。
 * @param {string} html - 原始 HTML
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (!html) return '';

  // 白名单标签
  const ALLOWED_TAGS = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col',
    'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
    'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
    's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u',
    'ul', 'var', 'wbr'
  ]);

  // 白名单属性
  const ALLOWED_ATTRS = new Set([
    'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
    'cite', 'colspan', 'datetime', 'headers', 'height', 'href',
    'hreflang', 'lang', 'rel', 'rowspan', 'scope', 'src',
    'style', 'target', 'title', 'valign', 'width'
  ]);

  // URI 协议白名单
  const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:', 'tel:'];

  // 禁止的 CSS 属性模式
  const DANGEROUS_CSS = /(expression|javascript|vbscript|url\s*\()/i;

  const temp = document.createElement('div');
  temp.innerHTML = html;

  // 递归清理节点
  function sanitizeNode(node) {
    if (node.nodeType === 1) { // Element node
      const tag = node.tagName.toLowerCase();

      if (!ALLOWED_TAGS.has(tag)) {
        // 移除不允许的标签，保留其文本内容
        const fragment = document.createDocumentFragment();
        while (node.firstChild) {
          fragment.appendChild(node.firstChild);
        }
        node.parentNode.replaceChild(fragment, node);
        return;
      }

      // 处理 href/src 属性
      for (const attr of ['href', 'src']) {
        if (node.hasAttribute(attr)) {
          const val = node.getAttribute(attr).trim().toLowerCase();
          if (!SAFE_PROTOCOLS.some(p => val.startsWith(p)) && !val.startsWith('/') && !val.startsWith('#') && !val.startsWith('data:image/')) {
            node.removeAttribute(attr);
          }
        }
      }

      // 移除不在白名单中的属性
      const attrsToRemove = [];
      for (let i = 0; i < node.attributes.length; i++) {
        const attr = node.attributes[i].name;
        if (!ALLOWED_ATTRS.has(attr)) {
          attrsToRemove.push(attr);
        }
      }
      for (const attr of attrsToRemove) {
        node.removeAttribute(attr);
      }

      // 净化 style 属性
      if (node.hasAttribute('style')) {
        const style = node.getAttribute('style');
        if (DANGEROUS_CSS.test(style)) {
          node.removeAttribute('style');
        }
      }

      // 递归处理子节点
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        sanitizeNode(node.childNodes[i]);
      }
    } else if (node.nodeType === 3) { // Text node
      // 文本节点安全，无需处理
    }
  }

  sanitizeNode(temp);
  return temp.innerHTML;
}

/**
 * 渲染邮件模态框内容
 * @param {object} email - 邮件数据
 * @returns {string}
 */
export function renderEmailModal(email) {
  if (!email) return '';
  
  const subject = escapeHtml(email.subject || '(无主题)');
  const sender = escapeHtml(email.sender || '未知发件人');
  const to = escapeHtml(email.to_addrs || '');
  const receivedAt = formatTime(email.received_at);
  const verificationCode = email.verification_code || '';
  
  let content = '';
  if (email.html_content) {
    content = sanitizeHtml(email.html_content);
  } else {
    content = `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(email.content || '')}</pre>`;
  }
  
  return `
    <div class="modal-header">
      <h3 class="modal-title">${subject}</h3>
      <button class="modal-close" data-action="close">&times;</button>
    </div>
    <div class="email-meta-inline">
      <span>发件人：${sender}</span>
      ${to ? `<span>收件人：${to}</span>` : ''}
      <span>${receivedAt}</span>
      ${verificationCode ? `<span class="code-highlight" data-code="${escapeAttr(verificationCode)}" title="点击复制" style="cursor:pointer">验证码：${escapeHtml(verificationCode)}</span>` : ''}
    </div>
    <div class="modal-body">
      ${content}
    </div>
    <div class="modal-footer">
      <button class="btn btn-danger" data-action="delete" data-email-id="${email.id}">删除邮件</button>
      <button class="btn btn-secondary" data-action="close">关闭</button>
    </div>
  `;
}

/**
 * 提取邮件中的验证码
 * @param {string} text - 邮件内容
 * @returns {string}
 */
export function extractVerificationCode(text) {
  if (!text) return '';
  
  const keywords = '(?:验证码|校验码|激活码|verification\\s+code|security\\s+code|otp|code)';
  
  // 关键词后的 4-8 位数字
  let m = text.match(new RegExp(keywords + '[^0-9]{0,20}(\\d{4,8})', 'i'));
  if (m) return m[1];
  
  // 全局 6 位数字
  m = text.match(/(?<!\d)(\d{6})(?!\d)/);
  if (m) return m[1];
  
  return '';
}

// 导出默认对象
export default {
  renderEmailDetail,
  sanitizeHtml,
  renderEmailModal,
  extractVerificationCode
};
