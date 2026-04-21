CREATE TABLE IF NOT EXISTS storage_roots (
    storage_key TEXT PRIMARY KEY,
    server_revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS storage_profiles (
    storage_key TEXT PRIMARY KEY REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    is_public BOOLEAN NOT NULL,
    show_full_history BOOLEAN NOT NULL DEFAULT FALSE,
    display_name TEXT,
    username TEXT,
    telegram_username TEXT,
    telegram_user_id BIGINT,
    photo_url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    gender TEXT,
    birth_date DATE,
    height DOUBLE PRECISION,
    weight DOUBLE PRECISION,
    additional_info TEXT,
    friends_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    version BIGINT NOT NULL,
    server_updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_workout_types (
    storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    sort_order INTEGER,
    updated_at TIMESTAMPTZ NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    version BIGINT NOT NULL,
    server_updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (storage_key, id)
);

CREATE TABLE IF NOT EXISTS storage_workouts (
    storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    id TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    name TEXT,
    status TEXT NOT NULL,
    is_manual BOOLEAN NOT NULL,
    pause_intervals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    version BIGINT NOT NULL,
    server_updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (storage_key, id)
);

CREATE TABLE IF NOT EXISTS storage_logs (
    storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    id TEXT NOT NULL,
    workout_type_id TEXT NOT NULL,
    workout_id TEXT,
    reps DOUBLE PRECISION,
    weight DOUBLE PRECISION,
    duration DOUBLE PRECISION,
    duration_seconds DOUBLE PRECISION,
    logged_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    version BIGINT NOT NULL,
    server_updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (storage_key, id)
);

CREATE TABLE IF NOT EXISTS public_profile_aliases (
    alias_lower TEXT PRIMARY KEY,
    alias TEXT NOT NULL,
    storage_key TEXT NOT NULL REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public_profile_cache (
    storage_key TEXT PRIMARY KEY REFERENCES storage_roots(storage_key) ON DELETE CASCADE,
    source_revision BIGINT NOT NULL,
    payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS storage_profiles_version_idx
    ON storage_profiles(storage_key, version DESC);

CREATE INDEX IF NOT EXISTS storage_workout_types_version_idx
    ON storage_workout_types(storage_key, version DESC);

CREATE INDEX IF NOT EXISTS storage_workouts_version_idx
    ON storage_workouts(storage_key, version DESC);

CREATE INDEX IF NOT EXISTS storage_logs_version_idx
    ON storage_logs(storage_key, version DESC);

CREATE INDEX IF NOT EXISTS storage_logs_workout_type_idx
    ON storage_logs(storage_key, workout_type_id);

CREATE INDEX IF NOT EXISTS storage_logs_workout_idx
    ON storage_logs(storage_key, workout_id);

CREATE INDEX IF NOT EXISTS public_profile_aliases_storage_idx
    ON public_profile_aliases(storage_key);
