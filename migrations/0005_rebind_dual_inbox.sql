-- 现有 D1 数据库的一次性迁移：为双邮箱验证码 token 增加邮箱角色字段。
-- 执行前先确认字段不存在：
-- PRAGMA table_info(rebind_inbox_tokens);
-- 已存在 mailbox_type 时不要重复执行本文件。
ALTER TABLE rebind_inbox_tokens
  ADD COLUMN mailbox_type TEXT NOT NULL DEFAULT 'new';
