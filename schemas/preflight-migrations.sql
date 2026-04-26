-- =============================================================================
-- Patient Retention Engine — idempotent preflight migration
-- Applied automatically by: npm run preflight  (see scripts/preflight-supabase.js)
--
-- Covers:
--   • Legacy column names (patient_name → name)
--   • Missing columns on patients / system_logs / message_logs
--   • hospital_boarding + indexes
--   • RLS enable (harmless if already on)
--   • PostgREST schema cache reload (NOTIFY pgrst)
-- Safe to run repeatedly.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ── patients ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.patients (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_code      TEXT,
  name              TEXT,
  phone             TEXT,
  doctor_name       TEXT,
  clinic_name       TEXT,
  dob               DATE,
  sex               TEXT,
  visit_date        DATE,
  follow_up_required TEXT       DEFAULT 'No',
  follow_up_date    DATE,
  status            TEXT        DEFAULT 'pending',
  last_message_sent TIMESTAMPTZ,
  message_count     INTEGER     NOT NULL DEFAULT 0,
  response_status   TEXT        NOT NULL DEFAULT 'none',
  last_response     TEXT,
  health_check_sent BOOLEAN     NOT NULL DEFAULT FALSE,
  reactivation_sent BOOLEAN     NOT NULL DEFAULT FALSE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'name'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = 'patient_name'
    ) THEN
      ALTER TABLE public.patients RENAME COLUMN patient_name TO name;
    ELSE
      ALTER TABLE public.patients ADD COLUMN name TEXT;
    END IF;
  END IF;
END $$;

ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS patient_code TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS clinic_name TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS dob DATE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS sex TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS visit_date DATE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS follow_up_required TEXT DEFAULT 'No';
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS follow_up_date DATE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS last_message_sent TIMESTAMPTZ;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS response_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS last_response TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS health_check_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS reactivation_sent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'patients' AND c.conname = 'patients_sex_check'
  ) THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_sex_check
      CHECK (sex IS NULL OR sex IN ('Male','Female','Other'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'patients' AND c.conname = 'patients_follow_up_required_check'
  ) THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_follow_up_required_check
      CHECK (follow_up_required IN ('Yes','No'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'patients' AND c.conname = 'patients_status_check'
  ) THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_status_check
      CHECK (status IN ('pending','completed','missed','inactive'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'patients' AND c.conname = 'patients_response_status_check'
  ) THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_response_status_check
      CHECK (response_status IN ('none','responded','confirmed','cancelled'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'patients' AND c.conname = 'patients_phone_unique'
  ) THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_phone_unique UNIQUE (phone);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'patients' AND c.conname = 'patients_patient_code_unique'
  ) THEN
    ALTER TABLE public.patients ADD CONSTRAINT patients_patient_code_unique UNIQUE (patient_code);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_patients_follow_up_date    ON public.patients (follow_up_date);
CREATE INDEX IF NOT EXISTS idx_patients_status             ON public.patients (status);
CREATE INDEX IF NOT EXISTS idx_patients_phone              ON public.patients (phone);
CREATE INDEX IF NOT EXISTS idx_patients_follow_up_required ON public.patients (follow_up_required);
CREATE INDEX IF NOT EXISTS idx_patients_visit_date         ON public.patients (visit_date);

DROP TRIGGER IF EXISTS trg_patients_updated_at ON public.patients;
CREATE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── message_logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.message_logs (
  log_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID        REFERENCES public.patients (id) ON DELETE SET NULL,
  patient_name    TEXT,
  phone           TEXT,
  workflow_name   TEXT,
  message_type    TEXT,
  message_sent    TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_status TEXT        NOT NULL DEFAULT 'sent',
  error_message   TEXT,
  wa_message_id   TEXT
);

ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS patient_id UUID;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS patient_name TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS message_type TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS message_sent TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS wa_message_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'message_logs' AND c.conname = 'message_logs_delivery_status_check'
  ) THEN
    ALTER TABLE public.message_logs ADD CONSTRAINT message_logs_delivery_status_check
      CHECK (delivery_status IN ('sent','failed','delivered','read'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_logs_patient_id ON public.message_logs (patient_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_sent_at    ON public.message_logs (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_workflow   ON public.message_logs (workflow_name);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'twilio_sid'
  ) THEN
    ALTER TABLE public.message_logs RENAME COLUMN twilio_sid TO wa_message_id;
  END IF;
END $$;

-- ── system_logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_logs (
  log_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  workflow_name TEXT,
  execution_id  TEXT,
  log_level     TEXT        NOT NULL DEFAULT 'INFO',
  message       TEXT,
  details       JSONB
);

ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS execution_id  TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS log_level     TEXT NOT NULL DEFAULT 'INFO';
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS message       TEXT;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS details       JSONB;

UPDATE public.system_logs SET log_level = 'INFO' WHERE log_level IS NULL OR log_level = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'system_logs' AND c.conname = 'system_logs_log_level_check'
  ) THEN
    ALTER TABLE public.system_logs ADD CONSTRAINT system_logs_log_level_check
      CHECK (log_level IN ('INFO','WARN','ERROR'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON public.system_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_log_level ON public.system_logs (log_level);
CREATE INDEX IF NOT EXISTS idx_system_logs_workflow  ON public.system_logs (workflow_name);
CREATE INDEX IF NOT EXISTS idx_system_logs_details   ON public.system_logs USING GIN (details);

-- ── hospital_boarding ─────────────────────────────────────────────────────
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

ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS hospital_name TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS facility_type TEXT NOT NULL DEFAULT 'Unspecified';
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_expertise TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_hospital_boarding_hospital_name
  ON public.hospital_boarding (lower(trim(hospital_name)));
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_facility_type
  ON public.hospital_boarding (facility_type);
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_doctor_name
  ON public.hospital_boarding (lower(trim(doctor_name)));

DROP TRIGGER IF EXISTS trg_hospital_boarding_updated_at ON public.hospital_boarding;
CREATE TRIGGER trg_hospital_boarding_updated_at
  BEFORE UPDATE ON public.hospital_boarding
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.patients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_boarding  ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
