-- 外部接码地址绑定表
-- 用于将不在 freemail 系统中的邮箱（如 iCloud）与第三方接码服务 URL 绑定
CREATE TABLE IF NOT EXISTS external_inbox_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  inbox_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 索引：按邮箱快速查询
CREATE INDEX IF NOT EXISTS idx_external_inbox_email ON external_inbox_accounts(email);
-- 索引：按启用状态查询
CREATE INDEX IF NOT EXISTS idx_external_inbox_enabled ON external_inbox_accounts(enabled);
