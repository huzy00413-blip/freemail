/**
 * 邮件查看模块
 * @module modules/app/email-viewer
 */

import { escapeHtml, escapeAttr, extractCode } from './ui-helpers.js';
import { getEmailFromCache, setEmailCache } from './email-list.js';

/**
 * 显示邮件详情
 * @param {number} id - 邮件ID
 * @param {object} elements - DOM 元素
 * @param {Function} api - API 函数
 * @param {Function} showToast - 提示函数
 */
export async function showEmailDetail(id, elements, api, showToast) {
  const { modal, modalSubject, modalContent } = elements;
  
  try {
    let email = getEmailFromCache(id);
    if (!email || (!email.html_content && !email.content)) {
      const r = await api(`/api/email/${id}`);
      email = await r.json();
      setEmailCache(id, email);
    }

    modalSubject.innerHTML = `<span class="modal-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-mail"/></svg></span><span>${escapeHtml(email.subject || '(无主题)')}</span>`;

    const code = email.verification_code || extractCode(email.content || email.html_content || '');

    let metaHtml = `<div class="email-meta-inline">`;
    if (email.sender) metaHtml += `<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-user"/></svg> 发件人：${escapeHtml(email.sender)}</span>`;
    // 展示收件人地址（别名地址）
    if (email.to_addrs) metaHtml += `<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-mail"/></svg> 收件人：${escapeHtml(email.to_addrs)}</span>`;
    if (email.received_at) {
      const d = new Date((email.received_at.includes('T') ? email.received_at : email.received_at.replace(' ', 'T')) + 'Z');
      const timeStr = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
      metaHtml += `<span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-clock"/></svg> ${timeStr}</span>`;
    }
    if (email.download) metaHtml += `<span><a href="${email.download}" download style="color:var(--primary);text-decoration:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-download"/></svg> 下载 EML</a></span>`;
    metaHtml += `</div>`;

    let codeHtml = '';
    if (code) {
      codeHtml = `<div class="code-highlight" onclick="navigator.clipboard.writeText('${escapeAttr(code)}').then(()=>showToast('验证码已复制','success'))" title="点击复制" style="cursor:pointer">${escapeHtml(code)}</div>`;
    }

    let bodyHtml = '';
    if (email.html_content) {
      bodyHtml = `<div class="email-content-area"><iframe srcdoc="${escapeAttr(email.html_content)}" sandbox="allow-same-origin allow-popups" style="width:100%;min-height:400px;border:none;display:block"></iframe></div>`;
    } else {
      bodyHtml = `<div class="email-content-area"><pre class="email-content-text" style="white-space:pre-wrap;word-break:break-word">${escapeHtml(email.content || '')}</pre></div>`;
    }

    // 分享链接区域
    const shareHtml = `
      <div class="email-share-section" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border,#e8e8e8);">
        <div id="share-link-container" style="display:none; margin-bottom:12px;">
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="share-link-input" type="text" readonly style="flex:1;padding:8px 12px;border:1px solid var(--border,#ddd);border-radius:6px;font-size:13px;background:var(--bg-secondary,#f9f9f9);color:var(--text,#333);" />
            <button class="btn btn-secondary btn-sm" onclick="copyShareLink()" style="white-space:nowrap;">复制链接</button>
          </div>
        </div>
        <button id="share-btn" class="btn btn-primary btn-sm" onclick="generateShareLink(${id})" style="display:inline-flex;align-items:center;gap:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><use href="/icons/sprites.svg#icon-share"/></svg>
          生成公开分享链接
        </button>
      </div>
    `;

    modalContent.innerHTML = `<div class="email-detail-container">${metaHtml}${codeHtml}${bodyHtml}${shareHtml}</div>`;
    modal.classList.add('show');
  } catch(e) {
    showToast(e.message || '加载失败', 'error');
  }
}

/**
 * 删除邮件
 * @param {number} id - 邮件ID
 * @param {Function} api - API 函数
 * @param {Function} showToast - 提示函数
 * @param {Function} showConfirm - 确认函数
 * @param {Function} refresh - 刷新函数
 */
export async function deleteEmailById(id, api, showToast, showConfirm, refresh) {
  const confirmed = await showConfirm('确定删除这封邮件？');
  if (!confirmed) return;
  
  try {
    const r = await api(`/api/email/${id}`, { method: 'DELETE' });
    if (r.ok) {
      showToast('邮件已删除', 'success');
      await refresh();
    }
  } catch(e) {
    showToast(e.message || '删除失败', 'error');
  }
}

/**
 * 删除已发送邮件
 * @param {number} id - 邮件ID
 * @param {Function} api - API 函数
 * @param {Function} showToast - 提示函数
 * @param {Function} showConfirm - 确认函数
 * @param {Function} refresh - 刷新函数
 */
export async function deleteSentById(id, api, showToast, showConfirm, refresh) {
  const confirmed = await showConfirm('确定删除这条发送记录？');
  if (!confirmed) return;
  
  try {
    const r = await api(`/api/sent/${id}`, { method: 'DELETE' });
    if (r.ok) {
      showToast('记录已删除', 'success');
      await refresh();
    }
  } catch(e) {
    showToast(e.message || '删除失败', 'error');
  }
}

/**
 * 从列表复制验证码或内容
 * @param {Event} event - 事件
 * @param {number} id - 邮件ID
 * @param {Function} api - API 函数
 * @param {Function} showToast - 提示函数
 */
export async function copyFromEmailList(event, id, api, showToast) {
  const btn = event.target.closest('button');
  const code = btn?.dataset?.code;
  
  if (code) {
    try {
      await navigator.clipboard.writeText(code);
      showToast(`验证码 ${code} 已复制`, 'success');
    } catch(_) {
      showToast('复制失败', 'error');
    }
  } else {
    let email = getEmailFromCache(id);
    if (!email) {
      const r = await api(`/api/email/${id}`);
      email = await r.json();
      setEmailCache(id, email);
    }
    const text = email.content || email.html_content?.replace(/<[^>]+>/g, ' ') || '';
    try {
      await navigator.clipboard.writeText(text.slice(0, 500));
      showToast('内容已复制', 'success');
    } catch(_) {
      showToast('复制失败', 'error');
    }
  }
}

/**
 * 预取邮件详情
 * @param {Array} emails - 邮件列表
 * @param {Function} api - API 函数
 */
export async function prefetchEmails(emails, api) {
  const top = emails.slice(0, 5);
  for (const e of top) {
    if (!getEmailFromCache(e.id)) {
      try {
        const r = await api(`/api/email/${e.id}`);
        const detail = await r.json();
        setEmailCache(e.id, detail);
      } catch(_) {}
    }
  }
}

/**
 * 生成邮件公开分享链接
 * @param {number} id - 邮件ID
 */
export async function generateShareLink(id) {
  const btn = document.getElementById('share-btn');
  const container = document.getElementById('share-link-container');
  const input = document.getElementById('share-link-input');
  if (!btn || !container || !input) return;

  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div><span style="margin-left:6px;">生成中…</span>`;

  try {
    const r = await fetch(`/api/message/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    if (r.ok && data.share_url) {
      input.value = data.share_url;
      container.style.display = 'block';
      btn.style.display = 'none';
      if (typeof showToast === 'function') showToast('分享链接已生成', 'success');
    } else {
      if (typeof showToast === 'function') showToast(data.error || '生成失败', 'error');
    }
  } catch(e) {
    if (typeof showToast === 'function') showToast(e.message || '生成失败', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

/**
 * 复制分享链接
 */
export function copyShareLink() {
  const input = document.getElementById('share-link-input');
  if (!input || !input.value) return;
  input.select();
  try {
    navigator.clipboard.writeText(input.value).then(() => {
      if (typeof showToast === 'function') showToast('链接已复制到剪贴板', 'success');
    }).catch(() => {
      document.execCommand('copy');
      if (typeof showToast === 'function') showToast('链接已复制', 'success');
    });
  } catch(_) {
    document.execCommand('copy');
    if (typeof showToast === 'function') showToast('链接已复制', 'success');
  }
}

export default {
  showEmailDetail,
  deleteEmailById,
  deleteSentById,
  copyFromEmailList,
  prefetchEmails,
  generateShareLink,
  copyShareLink
};
