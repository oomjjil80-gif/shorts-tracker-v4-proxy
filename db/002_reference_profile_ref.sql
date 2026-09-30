-- P1.5 ReferenceProfile is immutable Blob data; each Production Job stores only its stable Blob ref.
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS reference_profile_ref text;
