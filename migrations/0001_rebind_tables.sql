-- ============================================================================
-- 迁移 0001: 换绑功能表结构
-- 执行方式：
--   1. 先检查 rebind_tasks 和 rebind_inbox_tokens 的现有字段。
--   2. 若已有 rebind_tasks 缺 idempotency_key，先执行本文件第 61 行的 ALTER TABLE。
--      然后再执行本文件，避免创建唯一索引时因缺列失败。
--   3. 对其他缺失的字段，手动执行对应的 ALTER TABLE。
--      （SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报 duplicate column 错误）
-- ============================================================================

-- 1. 建表（新数据库或首次部署，IF NOT EXISTS 安全）
CREATE TABLE IF NOT EXISTS rebind_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  user_id INTEGER,
  username TEXT,
  old_email TEXT,
  new_email TEXT,
  status TEXT DEFAULT 'created',
  idempotency_key TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rebind_inbox_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER,
  mailbox_id INTEGER NOT NULL,
  task_id TEXT,
  expires_at TEXT NOT NULL,
  used_count INTEGER DEFAULT 0,
  max_uses INTEGER DEFAULT 200,
  baseline_message_id INTEGER,
  baseline_received_at TEXT,
  mailbox_type TEXT NOT NULL DEFAULT 'new',
  revoked INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

-- 2. 索引
CREATE INDEX IF NOT EXISTS idx_rebind_tasks_task_id ON rebind_tasks(task_id);
CREATE INDEX IF NOT EXISTS idx_rebind_tasks_user_id ON rebind_tasks(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rebind_tasks_active_idempotency
  ON rebind_tasks(COALESCE(user_id, -1), idempotency_key)
  WHERE status IN ('created', 'running', 'waiting_code');
CREATE INDEX IF NOT EXISTS idx_rebind_inbox_tokens_token ON rebind_inbox_tokens(token);
CREATE INDEX IF NOT EXISTS idx_rebind_inbox_tokens_mailbox ON rebind_inbox_tokens(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_rebind_inbox_tokens_expires ON rebind_inbox_tokens(expires_at);

-- ============================================================================
-- 3. 字段补全（仅对已有旧表执行，先查 PRAGMA 确认缺失后再执行）
--    以下语句不要整体复制执行，按需选择缺失的字段：
-- ============================================================================

-- ALTER TABLE rebind_inbox_tokens ADD COLUMN user_id INTEGER;
-- ALTER TABLE rebind_inbox_tokens ADD COLUMN max_uses INTEGER DEFAULT 200;
-- ALTER TABLE rebind_inbox_tokens ADD COLUMN baseline_message_id INTEGER;
-- ALTER TABLE rebind_inbox_tokens ADD COLUMN baseline_received_at TEXT;
-- ALTER TABLE rebind_inbox_tokens ADD COLUMN mailbox_type TEXT NOT NULL DEFAULT 'new';
-- ALTER TABLE rebind_inbox_tokens ADD COLUMN revoked INTEGER DEFAULT 0;
-- ALTER TABLE rebind_tasks ADD COLUMN idempotency_key TEXT;
-- CREATE UNIQUE INDEX IF NOT EXISTS idx_rebind_tasks_active_idempotency
--   ON rebind_tasks(COALESCE(user_id, -1), idempotency_key)
--   WHERE status IN ('created', 'running', 'waiting_code');

-- ============================================================================
-- 4. 验证（执行后确认字段完整）
--    PRAGMA table_info(rebind_inbox_tokens);
--    应包含：token, user_id, mailbox_id, task_id, expires_at, used_count,
--            max_uses, baseline_message_id, baseline_received_at, mailbox_type, revoked
-- ============================================================================
