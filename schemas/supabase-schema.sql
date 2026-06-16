-- =============================================================================
-- Supabase / PostgreSQL Schema
-- Patient Retention Engine
--
-- For day-to-day dev, prefer automated alignment (idempotent):
--   npm run preflight   or   ./launch.sh
-- which applies schemas/preflight-migrations.sql (schema drift + PostgREST reload).
-- Use this file for a full reference or greenfield manual install in SQL Editor.
-- For v0 multi-clinic production, also apply schemas/migration-v0-multitenant.sql
-- (npm run preflight applies it automatically after this baseline alignment).
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
  scheduled_date  DATE,
  delivery_status TEXT        NOT NULL DEFAULT 'sent'
                  CHECK (delivery_status IN ('queued','sent','failed','delivered','read','undelivered')),
  error_message   TEXT,
  provider_message_id TEXT,
  twilio_message_sid  TEXT
);

CREATE INDEX IF NOT EXISTS idx_message_logs_patient_id ON public.message_logs (patient_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_sent_at    ON public.message_logs (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_workflow   ON public.message_logs (workflow_name);
CREATE INDEX IF NOT EXISTS idx_message_logs_provider_message_id ON public.message_logs (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_twilio_message_sid  ON public.message_logs (twilio_message_sid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_patient_type_date
  ON public.message_logs (patient_id, message_type, scheduled_date)
  WHERE patient_id IS NOT NULL AND scheduled_date IS NOT NULL;

-- -------------------------
-- Table: message_ledger
-- Idempotency ledger for proactive WhatsApp messages.
-- -------------------------
CREATE TABLE IF NOT EXISTS public.message_ledger (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id           UUID        REFERENCES public.patients (id) ON DELETE CASCADE,
  message_type         TEXT        NOT NULL,
  scheduled_date       DATE        NOT NULL,
  workflow_name        TEXT,
  provider_message_id  TEXT,
  twilio_message_sid   TEXT,
  status               TEXT        NOT NULL DEFAULT 'reserved'
                      CHECK (status IN ('reserved','sent','failed','delivered','read','undelivered')),
  error_message        TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (patient_id, message_type, scheduled_date)
);

CREATE INDEX IF NOT EXISTS idx_message_ledger_provider_message_id ON public.message_ledger (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_message_ledger_twilio_message_sid  ON public.message_ledger (twilio_message_sid);

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

-- -------------------------
-- Table: hospital_boarding
-- One row per hospital/clinic onboarding submission (facility + doctor).
-- Written by WF12 (hospital boarding form). Patient-facing UIs may expose only
-- hospital_name + doctor_name; facility_type is WhatsApp-safe metadata for
-- segmentation, while full address and expertise stay in this table.
-- -------------------------
CREATE TABLE IF NOT EXISTS public.hospital_boarding (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_name      TEXT        NOT NULL,
  facility_type      TEXT        NOT NULL
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

-- -------------------------
-- Doctor dashboard and prescriptions
-- -------------------------
CREATE TABLE IF NOT EXISTS public.doctor_profiles (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        UNIQUE REFERENCES auth.users (id) ON DELETE CASCADE,
  doctor_name         TEXT        NOT NULL,
  clinic_name         TEXT        NOT NULL,
  registration_number TEXT        NOT NULL,
  specialty           TEXT,
  qualification       TEXT,
  clinic_address      TEXT,
  clinic_city         TEXT,
  clinic_phone        TEXT,
  clinic_email        TEXT,
  clinic_website      TEXT,
  clinic_logo_url     TEXT,
  doctor_phone        TEXT,
  signature_image_url TEXT,
  signature_label     TEXT,
  stamp_label         TEXT,
  is_clinic_admin     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doctor_profiles_clinic_doctor
  ON public.doctor_profiles (lower(trim(clinic_name)), lower(trim(doctor_name)));
CREATE INDEX IF NOT EXISTS idx_doctor_profiles_doctor_phone
  ON public.doctor_profiles ((regexp_replace(coalesce(doctor_phone, ''), '[\s\-().]', '', 'g')));

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

  SELECT hb.*
    INTO boarding
    FROM public.hospital_boarding hb
   WHERE public.normalized_whatsapp_phone(hb.doctor_phone) = verified_phone
   ORDER BY (
      SELECT MAX(pv.checked_in_at)
      FROM public.patient_visits pv
      WHERE lower(trim(pv.clinic_name)) = lower(trim(hb.hospital_name))
        AND lower(trim(pv.doctor_name)) = lower(trim(hb.doctor_name))
    ) DESC NULLS LAST,
    hb.created_at DESC
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
  visit_status          TEXT        NOT NULL DEFAULT 'waiting'
                    CHECK (visit_status IN ('waiting','in_consultation','completed','cancelled','no_show')),
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
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patient_visits_patient_id ON public.patient_visits (patient_id);
CREATE INDEX IF NOT EXISTS idx_patient_visits_doctor_profile ON public.patient_visits (doctor_profile_id);
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
  status                TEXT        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','issued','cancelled')),
  diagnosis             TEXT,
  clinical_remarks      TEXT,
  advice                TEXT,
  follow_up_required    TEXT        NOT NULL DEFAULT 'No'
                    CHECK (follow_up_required IN ('Yes','No')),
  follow_up_date        DATE,
  issued_at             TIMESTAMPTZ,
  doctor_snapshot       JSONB,
  clinic_snapshot       JSONB,
  pdf_url               TEXT,
  pdf_storage_path      TEXT,
  delivery_status       TEXT        NOT NULL DEFAULT 'not_sent'
                    CHECK (delivery_status IN ('not_sent','queued','sent','failed')),
  created_by            UUID        DEFAULT auth.uid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON public.prescriptions (patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_visit_id ON public.prescriptions (visit_id);
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
    NEW.follow_up_required IS DISTINCT FROM OLD.follow_up_required OR
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

CREATE OR REPLACE FUNCTION public.sync_patient_follow_up_from_prescription()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  visit_day DATE;
BEGIN
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;

  SELECT pv.visit_date INTO visit_day
  FROM public.patient_visits pv
  WHERE pv.id = NEW.visit_id;

  IF NEW.follow_up_required = 'Yes' THEN
    IF NEW.follow_up_date IS NULL THEN
      RAISE EXCEPTION 'Follow-up date is required when issuing a prescription with follow-up required';
    END IF;
    IF visit_day IS NOT NULL AND NEW.follow_up_date <= visit_day THEN
      RAISE EXCEPTION 'Follow-up date must be after the visit date';
    END IF;
    IF NEW.follow_up_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'Follow-up date cannot be in the past';
    END IF;
  END IF;

  UPDATE public.patients
     SET follow_up_required = CASE WHEN NEW.follow_up_required = 'Yes' THEN 'Yes' ELSE 'No' END,
         follow_up_date = CASE WHEN NEW.follow_up_required = 'Yes' THEN NEW.follow_up_date ELSE NULL END,
         status = CASE WHEN NEW.follow_up_required = 'Yes' THEN 'pending' ELSE 'completed' END,
         updated_at = NOW()
   WHERE id = NEW.patient_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prescriptions_sync_patient_follow_up ON public.prescriptions;
CREATE TRIGGER trg_prescriptions_sync_patient_follow_up
  AFTER INSERT OR UPDATE OF status, follow_up_required, follow_up_date ON public.prescriptions
  FOR EACH ROW
  WHEN (NEW.status = 'issued')
  EXECUTE FUNCTION public.sync_patient_follow_up_from_prescription();

CREATE TABLE IF NOT EXISTS public.prescription_medicines (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id UUID        NOT NULL REFERENCES public.prescriptions (id) ON DELETE CASCADE,
  medicine_name   TEXT        NOT NULL,
  generic_name    TEXT,
  dosage          TEXT        NOT NULL,
  frequency       TEXT        NOT NULL,
  timing          TEXT        NOT NULL,
  duration        TEXT        NOT NULL,
  instructions    TEXT,
  sort_order      INTEGER     NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  prescription_id UUID        REFERENCES public.prescriptions (id) ON DELETE CASCADE,
  visit_id        UUID        REFERENCES public.patient_visits (id) ON DELETE SET NULL,
  actor_user_id   UUID        DEFAULT auth.uid(),
  action          TEXT        NOT NULL,
  details         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO storage.buckets (id, name, public)
VALUES ('prescriptions', 'prescriptions', false)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Row Level Security (RLS)
-- Enable after verifying n8n can connect with the service-role key.
-- The service-role key bypasses RLS — used by n8n for all writes/reads.
-- The anon key is subject to RLS — block all access by default.
-- =============================================================================

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

CREATE OR REPLACE FUNCTION public.doctor_boarding_matches_visit(
  p_clinic_name TEXT,
  p_doctor_name TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_auth_phone() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.hospital_boarding hb
      WHERE public.normalized_whatsapp_phone(hb.doctor_phone) = public.current_auth_phone()
        AND lower(trim(hb.hospital_name)) = lower(trim(p_clinic_name))
        AND lower(trim(hb.doctor_name)) = lower(trim(p_doctor_name))
    );
$$;

GRANT EXECUTE ON FUNCTION public.doctor_boarding_matches_visit(TEXT, TEXT) TO authenticated;

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
    OR public.doctor_boarding_matches_visit(patient_visits.clinic_name, patient_visits.doctor_name)
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
    OR public.doctor_boarding_matches_visit(patient_visits.clinic_name, patient_visits.doctor_name)
  );

DROP POLICY IF EXISTS "doctors read queue patients" ON public.patients;
CREATE POLICY "doctors read queue patients"
  ON public.patients FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.patient_visits pv
      WHERE pv.patient_id = patients.id
        AND (
          EXISTS (
            SELECT 1 FROM public.doctor_profiles dp
            WHERE public.doctor_profile_matches_current_user(dp.id)
              AND (
                dp.id = pv.doctor_profile_id
                OR (dp.is_clinic_admin AND lower(trim(dp.clinic_name)) = lower(trim(pv.clinic_name)))
                OR (
                  lower(trim(dp.clinic_name)) = lower(trim(pv.clinic_name))
                  AND lower(trim(dp.doctor_name)) = lower(trim(pv.doctor_name))
                )
              )
          )
          OR public.doctor_boarding_matches_visit(pv.clinic_name, pv.doctor_name)
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
  WITH CHECK (actor_user_id = auth.uid());

DROP POLICY IF EXISTS "doctors manage prescription pdfs" ON storage.objects;
CREATE POLICY "doctors manage prescription pdfs"
  ON storage.objects FOR ALL
  TO authenticated
  USING (bucket_id = 'prescriptions' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'prescriptions' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Note: daily_intake_sheets table removed — Google Sheets intake is no longer used.
-- All patient data enters via the QR form (WF11) which writes directly to public.patients.

-- Service role bypasses RLS automatically — no policy needed for it.

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
-- SELECT * FROM public.hospital_boarding ORDER BY created_at DESC LIMIT 20;
-- SELECT * FROM public.patients ORDER BY created_at DESC LIMIT 20;
-- SELECT * FROM public.system_logs ORDER BY timestamp DESC LIMIT 20;
-- SELECT * FROM public.message_logs WHERE patient_id = '<uuid>' ORDER BY sent_at DESC;
-- SELECT * FROM public.patients WHERE status = 'pending' AND follow_up_date = CURRENT_DATE + 1;

-- =============================================================================
-- Migration: legacy provider message IDs → Twilio/provider-neutral IDs.
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
    ALTER TABLE public.message_logs RENAME COLUMN twilio_sid TO twilio_message_sid;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'message_logs'
      AND column_name  = 'wa_message_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'message_logs'
      AND column_name  = 'provider_message_id'
  ) THEN
    ALTER TABLE public.message_logs RENAME COLUMN wa_message_id TO provider_message_id;
  END IF;
END $$;
