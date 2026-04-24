-- =============================================================================
-- Migration: align legacy Supabase schema with current workflows + PostgREST
-- Run once in: Supabase Dashboard → SQL Editor
--
-- Fixes common drift:
--   • patients: workflows expect column "name" (not patient_name)
--   • system_logs: workflows expect workflow_name, execution_id, log_level, message, details
--   • hospital_boarding: table missing from API cache until created
-- After run: Settings → API → Reload schema (or wait ~1 min for cache refresh)
-- =============================================================================

-- ── patients.name ───────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.patients') IS NULL THEN
    RAISE NOTICE 'public.patients does not exist — apply supabase-schema.sql first.';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'name'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'patient_name'
    ) THEN
      ALTER TABLE public.patients RENAME COLUMN patient_name TO name;
      RAISE NOTICE 'Renamed patients.patient_name → name.';
    ELSE
      ALTER TABLE public.patients ADD COLUMN name TEXT NOT NULL DEFAULT '';
      RAISE NOTICE 'Added patients.name (populate manually if needed).';
    END IF;
  END IF;
END $$;

-- ── system_logs columns (additive, idempotent) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_logs (
  log_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workflow_name TEXT,
  execution_id  TEXT,
  log_level     TEXT        NOT NULL DEFAULT 'INFO'
                CHECK (log_level IN ('INFO','WARN','ERROR')),
  message       TEXT,
  details       JSONB
);

ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS execution_id  TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS log_level     TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS message       TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS details       JSONB;

UPDATE public.system_logs SET log_level = 'INFO' WHERE log_level IS NULL;

-- ── hospital_boarding (full definition — safe IF NOT EXISTS) ──────────────
CREATE TABLE IF NOT EXISTS public.hospital_boarding (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_name      TEXT        NOT NULL,
  facility_type      TEXT        NOT NULL DEFAULT 'Unspecified'
                   CONSTRAINT hospital_boarding_facility_type_check
                   CHECK (facility_type IN (
                     'General Hospital',
                     'Multi-specialty Clinic',
                     'Dental Clinic',
                     'Pathology Lab',
                     'Diagnostic Center',
                     'Physiotherapy Clinic',
                     'Eye Clinic',
                     'ENT Clinic',
                     'Other Medical Facility',
                     'Unspecified'
                   )),
  address            TEXT        NOT NULL,
  doctor_name        TEXT        NOT NULL,
  doctor_expertise   TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hospital_boarding_hospital_name
  ON public.hospital_boarding (lower(trim(hospital_name)));

-- Nudge PostgREST to reload (Supabase)
NOTIFY pgrst, 'reload schema';
