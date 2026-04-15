-- =============================================================================
-- Supabase / PostgreSQL Schema
-- Patient Retention Engine
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- =============================================================================

-- -------------------------
-- Table: patients
-- Primary record store. One row per patient (keyed on phone number).
-- Upserted by WF11 (QR form intake) on conflict with phone.
-- WF1–WF8 read exclusively from this table (Supabase = source of truth).
-- -------------------------
CREATE TABLE IF NOT EXISTS public.patients (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_code      TEXT,                          -- Human-readable ID assigned by WF11 (PAT-0001)
  name              TEXT        NOT NULL,
  phone             TEXT        NOT NULL,
  doctor_name       TEXT,
  clinic_name       TEXT,
  dob               DATE,                          -- Date of birth (optional)
  sex               TEXT        CHECK (sex IN ('Male','Female','Other') OR sex IS NULL),
  visit_date        DATE,
  follow_up_required TEXT       DEFAULT 'No'
                    CHECK (follow_up_required IN ('Yes','No')),
  follow_up_date    DATE,
  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','missed','inactive')),
  last_message_sent TIMESTAMPTZ,
  message_count     INTEGER     NOT NULL DEFAULT 0,
  response_status   TEXT        NOT NULL DEFAULT 'none'
                    CHECK (response_status IN ('none','responded','confirmed','cancelled')),
  last_response     TEXT,
  health_check_sent BOOLEAN     NOT NULL DEFAULT FALSE,
  reactivation_sent BOOLEAN     NOT NULL DEFAULT FALSE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique constraints
ALTER TABLE public.patients
  ADD CONSTRAINT patients_phone_unique UNIQUE (phone);

ALTER TABLE public.patients
  ADD CONSTRAINT patients_patient_code_unique UNIQUE (patient_code);

CREATE INDEX IF NOT EXISTS idx_patients_follow_up_date    ON public.patients (follow_up_date);
CREATE INDEX IF NOT EXISTS idx_patients_status             ON public.patients (status);
CREATE INDEX IF NOT EXISTS idx_patients_phone              ON public.patients (phone);
CREATE INDEX IF NOT EXISTS idx_patients_follow_up_required ON public.patients (follow_up_required);
CREATE INDEX IF NOT EXISTS idx_patients_visit_date         ON public.patients (visit_date);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_patients_updated_at
  BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -------------------------
-- Table: message_logs
-- Append-only log of every WhatsApp message sent.
-- -------------------------
CREATE TABLE IF NOT EXISTS public.message_logs (
  log_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      UUID        REFERENCES public.patients (id) ON DELETE SET NULL,
  patient_name    TEXT,
  phone           TEXT,
  workflow_name   TEXT,
  message_type    TEXT,
  message_sent    TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_status TEXT        NOT NULL DEFAULT 'sent'
                  CHECK (delivery_status IN ('sent','failed','delivered','read')),
  error_message   TEXT,
  wa_message_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_logs_patient_id ON public.message_logs (patient_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_sent_at    ON public.message_logs (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_workflow   ON public.message_logs (workflow_name);

-- -------------------------
-- Table: system_logs
-- Operational log for all workflow executions, errors, and events.
-- Uses JSONB for structured details (queryable via ->>'key').
-- -------------------------
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

CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON public.system_logs (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_log_level ON public.system_logs (log_level);
CREATE INDEX IF NOT EXISTS idx_system_logs_workflow  ON public.system_logs (workflow_name);
-- GIN index enables fast JSONB queries: details->>'patient_id'
CREATE INDEX IF NOT EXISTS idx_system_logs_details   ON public.system_logs USING GIN (details);

-- =============================================================================
-- Row Level Security (RLS)
-- Enable after verifying n8n can connect with the service-role key.
-- The service-role key bypasses RLS — used by n8n for all writes/reads.
-- The anon key is subject to RLS — block all access by default.
-- =============================================================================

ALTER TABLE public.patients     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs  ENABLE ROW LEVEL SECURITY;
-- Note: daily_intake_sheets table removed — Google Sheets intake is no longer used.
-- All patient data enters via the QR form (WF11) which writes directly to public.patients.

-- Service role bypasses RLS automatically — no policy needed for it.
-- Block anonymous / authenticated access by default (no permissive policy = deny all).
-- Add read-only policies below if you want a Supabase dashboard / reporting tool to query.

-- Example: allow SELECT for authenticated users on patients (optional, add when needed)
-- CREATE POLICY "authenticated read patients"
--   ON public.patients FOR SELECT
--   TO authenticated
--   USING (true);

-- =============================================================================
-- Useful verification queries (run after import to check data)
-- =============================================================================
-- SELECT COUNT(*) FROM public.patients;
-- SELECT COUNT(*) FROM public.message_logs;
-- SELECT COUNT(*) FROM public.system_logs;
-- SELECT * FROM public.patients ORDER BY created_at DESC LIMIT 20;
-- SELECT * FROM public.system_logs ORDER BY timestamp DESC LIMIT 20;
-- SELECT * FROM public.message_logs WHERE patient_id = '<uuid>' ORDER BY sent_at DESC;
-- SELECT * FROM public.patients WHERE status = 'pending' AND follow_up_date = CURRENT_DATE + 1;

-- =============================================================================
-- Migration: Twilio → WhatsApp Business API
-- Run this in Supabase SQL Editor if the table was created before this migration.
-- Safe to run even if already applied (IF EXISTS guard).
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'message_logs'
      AND column_name  = 'twilio_sid'
  ) THEN
    ALTER TABLE public.message_logs RENAME COLUMN twilio_sid TO wa_message_id;
  END IF;
END $$;
