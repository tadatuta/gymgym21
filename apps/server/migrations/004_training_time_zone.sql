-- Owner-selected training days must survive device changes and public cache hits.
ALTER TABLE storage_profiles ADD COLUMN IF NOT EXISTS time_zone TEXT;
DELETE FROM public_profile_cache;
