-- 0008: 换绑账号池持久化
-- 保存批量换绑提交的账号凭据与终态结果（新邮箱、AT 掩码），支持导出。
-- 注意: password/totp_secret 为用户自己导入的凭据，仅管理员可读写导出。

CREATE TABLE IF NOT EXISTS rebind_accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  old_email      TEXT    NOT NULL UNIQUE,
  password       TEXT    NOT NULL DEFAULT '',
  totp_secret    TEXT    NOT NULL DEFAULT '',
  old_inbox_url  TEXT    NOT NULL DEFAULT '',
  login_type     TEXT    NOT NULL DEFAULT '',
  new_email      TEXT    NOT NULL DEFAULT '',
  new_inbox_url  TEXT    NOT NULL DEFAULT '',
  at_masked      TEXT    NOT NULL DEFAULT '',
  task_id        TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'created',
  error          TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_rebind_accounts_status ON rebind_accounts(status);
CREATE INDEX IF NOT EXISTS idx_rebind_accounts_task   ON rebind_accounts(task_id);
