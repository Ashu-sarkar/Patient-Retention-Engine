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
  ALTER TABLE public.message_logs DROP CONSTRAINT IF EXISTS message_logs_delivery_status_check;
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
  scheduled_date  DATE,
  delivery_status TEXT        NOT NULL DEFAULT 'sent',
  error_message   TEXT,
  provider_message_id TEXT,
  twilio_message_sid  TEXT
);

ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS patient_id UUID;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS patient_name TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS message_type TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS message_sent TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS scheduled_date DATE;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS twilio_message_sid TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'twilio_sid'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'twilio_message_sid'
  ) THEN
    ALTER TABLE public.message_logs RENAME COLUMN twilio_sid TO twilio_message_sid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'message_logs' AND column_name = 'wa_message_id'
  ) THEN
    UPDATE public.message_logs
       SET provider_message_id = COALESCE(provider_message_id, wa_message_id)
     WHERE provider_message_id IS NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'message_logs' AND c.conname = 'message_logs_delivery_status_check'
  ) THEN
    ALTER TABLE public.message_logs ADD CONSTRAINT message_logs_delivery_status_check
      CHECK (delivery_status IN ('queued','sent','failed','delivered','read','undelivered'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_logs_patient_id ON public.message_logs (patient_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_sent_at    ON public.message_logs (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_workflow   ON public.message_logs (workflow_name);
CREATE INDEX IF NOT EXISTS idx_message_logs_provider_message_id ON public.message_logs (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_twilio_message_sid  ON public.message_logs (twilio_message_sid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_patient_type_date
  ON public.message_logs (patient_id, message_type, scheduled_date)
  WHERE patient_id IS NOT NULL AND scheduled_date IS NOT NULL;

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

-- ── message_ledger ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.message_ledger (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           UUID        REFERENCES public.patients (id) ON DELETE CASCADE,
  message_type         TEXT        NOT NULL,
  scheduled_date       DATE        NOT NULL,
  workflow_name        TEXT,
  provider_message_id  TEXT,
  twilio_message_sid   TEXT,
  status               TEXT        NOT NULL DEFAULT 'reserved',
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_id, message_type, scheduled_date)
);

ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS patient_id UUID;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS message_type TEXT;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS scheduled_date DATE;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS workflow_name TEXT;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS twilio_message_sid TEXT;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'reserved';
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS error_message TEXT;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'message_ledger' AND c.conname = 'message_ledger_status_check'
  ) THEN
    ALTER TABLE public.message_ledger ADD CONSTRAINT message_ledger_status_check
      CHECK (status IN ('reserved','sent','failed','delivered','read','undelivered'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_message_ledger_provider_message_id ON public.message_ledger (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_message_ledger_twilio_message_sid  ON public.message_ledger (twilio_message_sid);

DROP TRIGGER IF EXISTS trg_message_ledger_updated_at ON public.message_ledger;
CREATE TRIGGER trg_message_ledger_updated_at
  BEFORE UPDATE ON public.message_ledger
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

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
  city               TEXT,
  contact_phone      TEXT,
  admin_contact_name TEXT,
  clinic_logo_url    TEXT,
  clinic_email       TEXT,
  clinic_website     TEXT,
  doctor_name        TEXT        NOT NULL,
  doctor_qualification TEXT,
  doctor_expertise   TEXT        NOT NULL,
  doctor_registration_number TEXT,
  doctor_phone       TEXT,
  doctor_signature_url TEXT,
  consultation_hours TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS hospital_name TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS facility_type TEXT NOT NULL DEFAULT 'Unspecified';
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS admin_contact_name TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS clinic_logo_url TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS clinic_email TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS clinic_website TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_qualification TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_expertise TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_registration_number TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_phone TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS doctor_signature_url TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS consultation_hours TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_hospital_boarding_hospital_name
  ON public.hospital_boarding (lower(trim(hospital_name)));
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_facility_type
  ON public.hospital_boarding (facility_type);
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_city
  ON public.hospital_boarding (lower(trim(city)));
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_doctor_name
  ON public.hospital_boarding (lower(trim(doctor_name)));

DROP TRIGGER IF EXISTS trg_hospital_boarding_updated_at ON public.hospital_boarding;
CREATE TRIGGER trg_hospital_boarding_updated_at
  BEFORE UPDATE ON public.hospital_boarding
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── doctor dashboard / prescriptions ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.doctor_profiles (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
  doctor_name           TEXT        NOT NULL,
  clinic_name           TEXT        NOT NULL,
  registration_number   TEXT        NOT NULL,
  specialty             TEXT,
  qualification         TEXT,
  clinic_address        TEXT,
  clinic_city           TEXT,
  clinic_phone          TEXT,
  clinic_email          TEXT,
  clinic_website        TEXT,
  clinic_logo_url       TEXT,
  doctor_phone          TEXT,
  signature_image_url   TEXT,
  signature_label       TEXT,
  stamp_label           TEXT,
  is_clinic_admin       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_name TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS registration_number TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS specialty TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS qualification TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_address TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_city TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_phone TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_email TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_website TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_logo_url TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS doctor_phone TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS signature_image_url TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS signature_label TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS stamp_label TEXT;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS is_clinic_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_profiles_user_id
  ON public.doctor_profiles (user_id)
  WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doctor_profiles_doctor_phone
  ON public.doctor_profiles ((regexp_replace(coalesce(doctor_phone, ''), '[\s\-().]', '', 'g')));
CREATE INDEX IF NOT EXISTS idx_doctor_profiles_clinic_doctor
  ON public.doctor_profiles (lower(trim(clinic_name)), lower(trim(doctor_name)));

DROP TRIGGER IF EXISTS trg_doctor_profiles_updated_at ON public.doctor_profiles;
CREATE TRIGGER trg_doctor_profiles_updated_at
  BEFORE UPDATE ON public.doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.normalized_whatsapp_phone(input_phone TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN input_phone IS NULL OR btrim(input_phone) = '' THEN NULL
    WHEN regexp_replace(btrim(input_phone), '[\s\-().]', '', 'g') LIKE '+%' THEN regexp_replace(btrim(input_phone), '[\s\-().]', '', 'g')
    WHEN regexp_replace(btrim(input_phone), '[\s\-().]', '', 'g') ~ '^[1-9][0-9]{6,14}$' THEN '+' || regexp_replace(btrim(input_phone), '[\s\-().]', '', 'g')
    ELSE regexp_replace(btrim(input_phone), '[\s\-().]', '', 'g')
  END
$$;

CREATE OR REPLACE FUNCTION public.current_auth_phone()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT public.normalized_whatsapp_phone(
    COALESCE(auth.jwt() ->> 'phone', auth.jwt() -> 'user_metadata' ->> 'phone')
  )
$$;

CREATE OR REPLACE FUNCTION public.doctor_profile_matches_current_user(profile_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.doctor_profiles dp
    WHERE dp.id = profile_id
      AND (
        dp.user_id = auth.uid()
        OR (
          public.current_auth_phone() IS NOT NULL
          AND public.normalized_whatsapp_phone(dp.doctor_phone) = public.current_auth_phone()
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION public.get_or_create_doctor_profile_for_current_user()
RETURNS public.doctor_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  verified_phone TEXT := public.current_auth_phone();
  profile public.doctor_profiles;
  boarding public.hospital_boarding;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT *
    INTO profile
    FROM public.doctor_profiles dp
   WHERE dp.user_id = auth.uid()
      OR (verified_phone IS NOT NULL AND public.normalized_whatsapp_phone(dp.doctor_phone) = verified_phone)
   ORDER BY (dp.user_id = auth.uid()) DESC, dp.updated_at DESC
   LIMIT 1;

  IF FOUND THEN
    IF profile.user_id IS NULL THEN
      UPDATE public.doctor_profiles
         SET user_id = auth.uid(),
             doctor_phone = COALESCE(doctor_phone, verified_phone),
             updated_at = NOW()
       WHERE id = profile.id
       RETURNING * INTO profile;
    END IF;
    RETURN profile;
  END IF;

  IF verified_phone IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT *
    INTO boarding
    FROM public.hospital_boarding hb
   WHERE public.normalized_whatsapp_phone(hb.doctor_phone) = verified_phone
   ORDER BY hb.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.doctor_profiles (
    user_id,
    doctor_name,
    clinic_name,
    registration_number,
    specialty,
    qualification,
    clinic_address,
    clinic_city,
    clinic_phone,
    clinic_email,
    clinic_website,
    clinic_logo_url,
    doctor_phone,
    signature_image_url,
    signature_label,
    stamp_label
  )
  VALUES (
    auth.uid(),
    boarding.doctor_name,
    boarding.hospital_name,
    COALESCE(NULLIF(boarding.doctor_registration_number, ''), 'PENDING-' || right(auth.uid()::text, 8)),
    boarding.doctor_expertise,
    boarding.doctor_qualification,
    boarding.address,
    boarding.city,
    boarding.contact_phone,
    boarding.clinic_email,
    boarding.clinic_website,
    boarding.clinic_logo_url,
    verified_phone,
    boarding.doctor_signature_url,
    boarding.doctor_name,
    COALESCE(NULLIF(boarding.doctor_registration_number, ''), 'Registration pending')
  )
  RETURNING * INTO profile;

  RETURN profile;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_doctor_profile_for_current_user() TO authenticated;

CREATE TABLE IF NOT EXISTS public.patient_visits (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            UUID        NOT NULL REFERENCES public.patients (id) ON DELETE CASCADE,
  doctor_profile_id     UUID        REFERENCES public.doctor_profiles (id) ON DELETE SET NULL,
  patient_code          TEXT,
  clinic_name           TEXT        NOT NULL,
  doctor_name           TEXT        NOT NULL,
  visit_date            DATE        NOT NULL DEFAULT CURRENT_DATE,
  visit_status          TEXT        NOT NULL DEFAULT 'waiting',
  chief_complaint       TEXT,
  symptoms_duration     TEXT,
  known_allergies       TEXT,
  current_medicines     TEXT,
  existing_conditions   TEXT,
  vitals_notes          TEXT,
  staff_notes           TEXT,
  checked_in_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consultation_started_at TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT patient_visits_status_check
    CHECK (visit_status IN ('waiting','in_consultation','completed','cancelled','no_show'))
);

ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS patient_id UUID;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS doctor_profile_id UUID;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS patient_code TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS clinic_name TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS visit_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS visit_status TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS chief_complaint TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS symptoms_duration TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS known_allergies TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS current_medicines TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS existing_conditions TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS vitals_notes TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS staff_notes TEXT;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS consultation_started_at TIMESTAMPTZ;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_patient_visits_patient_id
  ON public.patient_visits (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor_profile
  ON public.patient_visits (doctor_profile_id);
CREATE INDEX IF NOT EXISTS idx_patient_visits_queue
  ON public.patient_visits (visit_date DESC, visit_status, lower(trim(clinic_name)), lower(trim(doctor_name)));

DROP TRIGGER IF EXISTS trg_patient_visits_updated_at ON public.patient_visits;
CREATE TRIGGER trg_patient_visits_updated_at
  BEFORE UPDATE ON public.patient_visits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.prescriptions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id            UUID        NOT NULL REFERENCES public.patients (id) ON DELETE CASCADE,
  visit_id              UUID        REFERENCES public.patient_visits (id) ON DELETE SET NULL,
  doctor_profile_id     UUID        REFERENCES public.doctor_profiles (id) ON DELETE SET NULL,
  status                TEXT        NOT NULL DEFAULT 'draft',
  diagnosis             TEXT,
  clinical_remarks      TEXT,
  advice                TEXT,
  follow_up_date        DATE,
  issued_at             TIMESTAMPTZ,
  doctor_snapshot       JSONB,
  clinic_snapshot       JSONB,
  pdf_url               TEXT,
  pdf_storage_path      TEXT,
  delivery_status       TEXT        NOT NULL DEFAULT 'not_sent',
  created_by            UUID        DEFAULT auth.uid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prescriptions_status_check
    CHECK (status IN ('draft','issued','cancelled')),
  CONSTRAINT prescriptions_delivery_status_check
    CHECK (delivery_status IN ('not_sent','queued','sent','failed'))
);

ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS patient_id UUID;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS visit_id UUID;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS doctor_profile_id UUID;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS diagnosis TEXT;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS clinical_remarks TEXT;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS advice TEXT;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS follow_up_date DATE;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS issued_at TIMESTAMPTZ;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS doctor_snapshot JSONB;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS clinic_snapshot JSONB;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS pdf_url TEXT;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS pdf_storage_path TEXT;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid();
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id
  ON public.prescriptions (patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_visit_id
  ON public.prescriptions (visit_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_status
  ON public.prescriptions (doctor_profile_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_prescriptions_updated_at ON public.prescriptions;
CREATE TRIGGER trg_prescriptions_updated_at
  BEFORE UPDATE ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.prevent_issued_prescription_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'issued' AND (
    NEW.patient_id IS DISTINCT FROM OLD.patient_id OR
    NEW.visit_id IS DISTINCT FROM OLD.visit_id OR
    NEW.doctor_profile_id IS DISTINCT FROM OLD.doctor_profile_id OR
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.diagnosis IS DISTINCT FROM OLD.diagnosis OR
    NEW.clinical_remarks IS DISTINCT FROM OLD.clinical_remarks OR
    NEW.advice IS DISTINCT FROM OLD.advice OR
    NEW.follow_up_date IS DISTINCT FROM OLD.follow_up_date OR
    NEW.issued_at IS DISTINCT FROM OLD.issued_at OR
    NEW.doctor_snapshot IS DISTINCT FROM OLD.doctor_snapshot OR
    NEW.clinic_snapshot IS DISTINCT FROM OLD.clinic_snapshot
  ) THEN
    RAISE EXCEPTION 'Issued prescriptions are immutable except delivery/PDF metadata';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prescriptions_prevent_issued_mutation ON public.prescriptions;
CREATE TRIGGER trg_prescriptions_prevent_issued_mutation
  BEFORE UPDATE ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.prevent_issued_prescription_mutation();

CREATE TABLE IF NOT EXISTS public.prescription_medicines (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id       UUID        NOT NULL REFERENCES public.prescriptions (id) ON DELETE CASCADE,
  medicine_name         TEXT        NOT NULL,
  generic_name          TEXT,
  dosage                TEXT        NOT NULL,
  frequency             TEXT        NOT NULL,
  timing                TEXT        NOT NULL,
  duration              TEXT        NOT NULL,
  instructions          TEXT,
  sort_order            INTEGER     NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS prescription_id UUID;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS medicine_name TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS generic_name TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS dosage TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS frequency TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS timing TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS duration TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS instructions TEXT;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_prescription_medicines_prescription_id
  ON public.prescription_medicines (prescription_id, sort_order);

CREATE OR REPLACE FUNCTION public.prevent_issued_prescription_medicine_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  parent_status TEXT;
  parent_id UUID;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    parent_id := NEW.prescription_id;
  ELSE
    parent_id := OLD.prescription_id;
  END IF;

  SELECT status INTO parent_status
  FROM public.prescriptions
  WHERE id = parent_id;

  IF parent_status = 'issued' THEN
    RAISE EXCEPTION 'Medicines on issued prescriptions are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prescription_medicines_prevent_issued_update ON public.prescription_medicines;
CREATE TRIGGER trg_prescription_medicines_prevent_issued_update
  BEFORE UPDATE OR DELETE ON public.prescription_medicines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_issued_prescription_medicine_mutation();

DROP TRIGGER IF EXISTS trg_prescription_medicines_prevent_issued_insert ON public.prescription_medicines;
CREATE TRIGGER trg_prescription_medicines_prevent_issued_insert
  BEFORE INSERT ON public.prescription_medicines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_issued_prescription_medicine_mutation();

CREATE TABLE IF NOT EXISTS public.prescription_audit_logs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id       UUID        REFERENCES public.prescriptions (id) ON DELETE CASCADE,
  visit_id              UUID        REFERENCES public.patient_visits (id) ON DELETE SET NULL,
  actor_user_id         UUID        DEFAULT auth.uid(),
  action                TEXT        NOT NULL,
  details               JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prescription_audit_prescription_id
  ON public.prescription_audit_logs (prescription_id, created_at DESC);

INSERT INTO storage.buckets (id, name, public)
VALUES ('prescriptions', 'prescriptions', false)
ON CONFLICT (id) DO NOTHING;

-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.patients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hospital_boarding  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_ledger     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doctor_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_visits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescription_medicines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prescription_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "doctors read own profile" ON public.doctor_profiles;
CREATE POLICY "doctors read own profile"
  ON public.doctor_profiles FOR SELECT
  TO authenticated
  USING (public.doctor_profile_matches_current_user(id));

DROP POLICY IF EXISTS "doctors update own profile" ON public.doctor_profiles;
CREATE POLICY "doctors update own profile"
  ON public.doctor_profiles FOR UPDATE
  TO authenticated
  USING (public.doctor_profile_matches_current_user(id))
  WITH CHECK (public.doctor_profile_matches_current_user(id));

DROP POLICY IF EXISTS "doctors insert claimed profile" ON public.doctor_profiles;
CREATE POLICY "doctors insert claimed profile"
  ON public.doctor_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.current_auth_phone() IS NOT NULL
    AND public.normalized_whatsapp_phone(doctor_phone) = public.current_auth_phone()
  );

DROP POLICY IF EXISTS "doctors read matching hospital boarding" ON public.hospital_boarding;
CREATE POLICY "doctors read matching hospital boarding"
  ON public.hospital_boarding FOR SELECT
  TO authenticated
  USING (
    (
      public.current_auth_phone() IS NOT NULL
      AND public.normalized_whatsapp_phone(hospital_boarding.doctor_phone) = public.current_auth_phone()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.doctor_profiles dp
      WHERE public.doctor_profile_matches_current_user(dp.id)
        AND lower(trim(dp.clinic_name)) = lower(trim(hospital_boarding.hospital_name))
        AND lower(trim(dp.doctor_name)) = lower(trim(hospital_boarding.doctor_name))
    )
  );

DROP POLICY IF EXISTS "doctors read assigned visits" ON public.patient_visits;
CREATE POLICY "doctors read assigned visits"
  ON public.patient_visits FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.doctor_profiles dp
      WHERE public.doctor_profile_matches_current_user(dp.id)
        AND (
          dp.id = patient_visits.doctor_profile_id
          OR (dp.is_clinic_admin AND lower(trim(dp.clinic_name)) = lower(trim(patient_visits.clinic_name)))
          OR (
            lower(trim(dp.clinic_name)) = lower(trim(patient_visits.clinic_name))
            AND lower(trim(dp.doctor_name)) = lower(trim(patient_visits.doctor_name))
          )
        )
    )
  );

DROP POLICY IF EXISTS "doctors update assigned visits" ON public.patient_visits;
CREATE POLICY "doctors update assigned visits"
  ON public.patient_visits FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.doctor_profiles dp
      WHERE public.doctor_profile_matches_current_user(dp.id)
        AND (
          dp.id = patient_visits.doctor_profile_id
          OR (dp.is_clinic_admin AND lower(trim(dp.clinic_name)) = lower(trim(patient_visits.clinic_name)))
          OR (
            lower(trim(dp.clinic_name)) = lower(trim(patient_visits.clinic_name))
            AND lower(trim(dp.doctor_name)) = lower(trim(patient_visits.doctor_name))
          )
        )
    )
  );

DROP POLICY IF EXISTS "doctors read queue patients" ON public.patients;
CREATE POLICY "doctors read queue patients"
  ON public.patients FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.patient_visits pv
      JOIN public.doctor_profiles dp ON public.doctor_profile_matches_current_user(dp.id)
      WHERE pv.patient_id = patients.id
        AND (
          dp.id = pv.doctor_profile_id
          OR (dp.is_clinic_admin AND lower(trim(dp.clinic_name)) = lower(trim(pv.clinic_name)))
          OR (
            lower(trim(dp.clinic_name)) = lower(trim(pv.clinic_name))
            AND lower(trim(dp.doctor_name)) = lower(trim(pv.doctor_name))
          )
        )
    )
  );

DROP POLICY IF EXISTS "doctors manage own prescriptions" ON public.prescriptions;
CREATE POLICY "doctors manage own prescriptions"
  ON public.prescriptions FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.doctor_profiles dp
      WHERE public.doctor_profile_matches_current_user(dp.id)
        AND dp.id = prescriptions.doctor_profile_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.doctor_profiles dp
      WHERE public.doctor_profile_matches_current_user(dp.id)
        AND dp.id = prescriptions.doctor_profile_id
    )
  );

DROP POLICY IF EXISTS "doctors manage prescription medicines" ON public.prescription_medicines;
CREATE POLICY "doctors manage prescription medicines"
  ON public.prescription_medicines FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.prescriptions pr
      JOIN public.doctor_profiles dp ON dp.id = pr.doctor_profile_id
      WHERE pr.id = prescription_medicines.prescription_id
        AND public.doctor_profile_matches_current_user(dp.id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.prescriptions pr
      JOIN public.doctor_profiles dp ON dp.id = pr.doctor_profile_id
      WHERE pr.id = prescription_medicines.prescription_id
        AND public.doctor_profile_matches_current_user(dp.id)
    )
  );

DROP POLICY IF EXISTS "doctors read prescription audit logs" ON public.prescription_audit_logs;
CREATE POLICY "doctors read prescription audit logs"
  ON public.prescription_audit_logs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.prescriptions pr
      JOIN public.doctor_profiles dp ON dp.id = pr.doctor_profile_id
      WHERE pr.id = prescription_audit_logs.prescription_id
        AND public.doctor_profile_matches_current_user(dp.id)
    )
  );

DROP POLICY IF EXISTS "doctors insert prescription audit logs" ON public.prescription_audit_logs;
CREATE POLICY "doctors insert prescription audit logs"
  ON public.prescription_audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    actor_user_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.prescriptions pr
      JOIN public.doctor_profiles dp ON dp.id = pr.doctor_profile_id
      WHERE pr.id = prescription_audit_logs.prescription_id
        AND public.doctor_profile_matches_current_user(dp.id)
    )
  );

DROP POLICY IF EXISTS "doctors manage prescription pdfs" ON storage.objects;
CREATE POLICY "doctors manage prescription pdfs"
  ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'prescriptions' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'prescriptions' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ── Public hospital list (used by patient intake form without auth) ──────────
CREATE OR REPLACE FUNCTION public.get_public_hospital_list()
RETURNS TABLE(hospital_name TEXT, doctor_name TEXT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT DISTINCT
    hb.hospital_name,
    hb.doctor_name
  FROM public.hospital_boarding hb
  WHERE hb.hospital_name IS NOT NULL AND trim(hb.hospital_name) <> ''
    AND hb.doctor_name   IS NOT NULL AND trim(hb.doctor_name)   <> ''
  ORDER BY hb.hospital_name, hb.doctor_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_hospital_list() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_hospital_list() TO authenticated;

NOTIFY pgrst, 'reload schema';
