-- Bounded recent AI/public reads, ordered keyset history and heatmap range.
CREATE INDEX IF NOT EXISTS storage_logs_recent_live_idx
    ON storage_logs (storage_key, logged_at DESC, id ASC) WHERE NOT is_deleted;

-- AI's catalog cap must stop at the limit without sorting the whole catalog.
CREATE INDEX IF NOT EXISTS storage_workout_types_recent_live_idx
    ON storage_workout_types (storage_key, updated_at DESC, id ASC) WHERE NOT is_deleted;
