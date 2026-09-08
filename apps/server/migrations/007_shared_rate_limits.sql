CREATE TABLE rate_limit_buckets (
  key TEXT PRIMARY KEY,
  reset_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);
CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets (reset_at);
CREATE TABLE rate_limit_leases (
  id UUID PRIMARY KEY,
  bucket_key TEXT NOT NULL REFERENCES rate_limit_buckets(key) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX rate_limit_leases_bucket_idx ON rate_limit_leases (bucket_key);
CREATE INDEX rate_limit_leases_expiry_idx ON rate_limit_leases (expires_at);
