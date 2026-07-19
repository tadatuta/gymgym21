CREATE TABLE IF NOT EXISTS storage_sync_receipts (
    storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    batch_id TEXT NOT NULL,
    response_payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (storage_key, batch_id)
);

CREATE INDEX IF NOT EXISTS storage_sync_receipts_storage_created_idx
    ON storage_sync_receipts(storage_key, created_at);
