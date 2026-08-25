-- 邮件域名管理表
-- 用于后台动态管理可用域名，无需修改 wrangler.toml 或重新部署
CREATE TABLE IF NOT EXISTS mail_domains (
  domain TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 导入当前 MAIL_DOMAIN 中已配置的域名
INSERT OR IGNORE INTO mail_domains (domain, enabled) VALUES ('xiaobaikuzi.online', 1);

-- 同时从 mailboxes 表导入实际存在但未在 MAIL_DOMAIN 中的域名
INSERT OR IGNORE INTO mail_domains (domain, enabled)
SELECT DISTINCT domain, 1 FROM mailboxes WHERE domain IS NOT NULL AND domain != '';

-- 索引：按启用状态查询
CREATE INDEX IF NOT EXISTS idx_mail_domains_enabled ON mail_domains(enabled);
