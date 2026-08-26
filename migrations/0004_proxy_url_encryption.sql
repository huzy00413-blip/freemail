-- 代理凭据加密存储：proxy_url 改为存储 AES-GCM 密文，proxy_hash 用于去重
-- proxy_hash = SHA-256(明文代理 URL)，proxy_url = AES-GCM(明文代理 URL, PROXY_ENCRYPTION_KEY)

ALTER TABLE proxy_pool ADD COLUMN proxy_hash TEXT;

-- 代理 URL 唯一性通过 hash 保证（密文含随机 IV，不能直接 UNIQUE）
CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_pool_hash ON proxy_pool(proxy_hash);
