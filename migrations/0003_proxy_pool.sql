-- 代理池管理表
-- 存储换绑服务使用的代理，管理员可在后台动态管理，无需重新部署 Render
CREATE TABLE IF NOT EXISTS proxy_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_url TEXT NOT NULL UNIQUE,       -- 完整代理URL（含凭据），不返回给前端
  proxy_display TEXT NOT NULL,          -- 脱敏显示（host:port）
  proxy_scheme TEXT NOT NULL,           -- http/https/socks5/socks5h
  enabled INTEGER NOT NULL DEFAULT 1,
  last_check_status TEXT,               -- ok/failed/unknown
  last_check_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proxy_pool_enabled ON proxy_pool(enabled);
