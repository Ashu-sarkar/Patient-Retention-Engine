-- =============================================================================
-- Migration: v0 shared-schema multi-tenancy
--
-- Adds a first-class clinic tenant model, backfills clinic_id from the existing
-- text clinic fields, and replaces global uniqueness/idempotency with
-- clinic-scoped rules. Safe to run repeatedly.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.slugify_clinic_name(input_name TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(
      trim(both '-' from regexp_replace(lower(coalesce(input_name, 'clinic')), '[^a-z0-9]+', '-', 'g')),
      ''
    ),
    'clinic'
  )
$$;

CREATE TABLE IF NOT EXISTS public.clinics (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  slug        TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','inactive','suspended')),
  settings    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slug),
  UNIQUE (code)
);

DROP TRIGGER IF EXISTS trg_clinics_updated_at ON public.clinics;
CREATE TRIGGER trg_clinics_updated_at
  BEFORE UPDATE ON public.clinics
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.get_or_create_clinic_id(input_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clean_name TEXT := COALESCE(NULLIF(trim(input_name), ''), 'Unassigned Clinic');
  base_slug TEXT := public.slugify_clinic_name(clean_name);
  candidate_slug TEXT := base_slug;
  candidate_code TEXT;
  suffix INTEGER := 1;
  clinic_id UUID;
BEGIN
  SELECT id INTO clinic_id
  FROM public.clinics
  WHERE lower(trim(name)) = lower(trim(clean_name))
     OR slug = base_slug
  ORDER BY created_at
  LIMIT 1;

  IF clinic_id IS NOT NULL THEN
    RETURN clinic_id;
  END IF;

  LOOP
    candidate_code := upper(left(regexp_replace(candidate_slug, '[^a-z0-9]', '', 'g'), 10));
    IF candidate_code = '' THEN
      candidate_code := 'CLINIC';
    END IF;

    BEGIN
      INSERT INTO public.clinics (name, slug, code)
      VALUES (clean_name, candidate_slug, candidate_code)
      RETURNING id INTO clinic_id;
      RETURN clinic_id;
    EXCEPTION WHEN unique_violation THEN
      suffix := suffix + 1;
      candidate_slug := base_slug || '-' || suffix::text;
    END;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS public.clinic_memberships (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID        NOT NULL REFERENCES public.clinics (id) ON DELETE CASCADE,
  user_id           UUID        REFERENCES auth.users (id) ON DELETE CASCADE,
  doctor_profile_id UUID        REFERENCES public.doctor_profiles (id) ON DELETE SET NULL,
  role              TEXT        NOT NULL
                    CHECK (role IN ('clinic_admin','doctor','staff','super_admin')),
  status            TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','invited','disabled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, user_id, role),
  UNIQUE (clinic_id, doctor_profile_id, role)
);

DROP TRIGGER IF EXISTS trg_clinic_memberships_updated_at ON public.clinic_memberships;
CREATE TRIGGER trg_clinic_memberships_updated_at
  BEFORE UPDATE ON public.clinic_memberships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_clinic_memberships_user
  ON public.clinic_memberships (user_id, status, clinic_id);
CREATE INDEX IF NOT EXISTS idx_clinic_memberships_clinic_role
  ON public.clinic_memberships (clinic_id, role, status);

CREATE OR REPLACE FUNCTION public.current_user_has_clinic_role(
  p_clinic_id UUID,
  p_roles TEXT[] DEFAULT ARRAY['clinic_admin','doctor','staff','super_admin']
)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.clinic_memberships cm
       WHERE cm.clinic_id = p_clinic_id
         AND cm.user_id = auth.uid()
         AND cm.status = 'active'
         AND cm.role = ANY (p_roles)
     )
$$;

CREATE OR REPLACE FUNCTION public.current_user_is_platform_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.clinic_memberships cm
       WHERE cm.user_id = auth.uid()
         AND cm.status = 'active'
         AND cm.role = 'super_admin'
     )
$$;

CREATE TABLE IF NOT EXISTS public.clinic_patient_code_counters (
  clinic_id  UUID PRIMARY KEY REFERENCES public.clinics (id) ON DELETE CASCADE,
  next_value INTEGER NOT NULL DEFAULT 1 CHECK (next_value > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.clinic_intake_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID        NOT NULL REFERENCES public.clinics (id) ON DELETE CASCADE,
  token_hash   TEXT        NOT NULL UNIQUE,
  label        TEXT        NOT NULL DEFAULT 'Primary QR',
  status       TEXT        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','disabled','expired')),
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  use_count    INTEGER     NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_by   UUID        REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_clinic_intake_tokens_updated_at ON public.clinic_intake_tokens;
CREATE TRIGGER trg_clinic_intake_tokens_updated_at
  BEFORE UPDATE ON public.clinic_intake_tokens
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS idx_clinic_intake_tokens_clinic_status
  ON public.clinic_intake_tokens (clinic_id, status, expires_at);

CREATE OR REPLACE FUNCTION public.hash_intake_token(p_token TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION public.create_clinic_intake_token(
  p_clinic_id UUID,
  p_label TEXT DEFAULT 'Primary QR',
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE(id UUID, clinic_id UUID, token TEXT, label TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_token TEXT;
BEGIN
  IF NOT (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(p_clinic_id, ARRAY['clinic_admin'])
  ) THEN
    RAISE EXCEPTION 'not authorized to create intake tokens';
  END IF;

  raw_token := encode(gen_random_bytes(32), 'hex');

  RETURN QUERY
  WITH inserted AS (
    INSERT INTO public.clinic_intake_tokens (clinic_id, token_hash, label, expires_at, created_by)
    VALUES (
      p_clinic_id,
      public.hash_intake_token(raw_token),
      COALESCE(NULLIF(trim(p_label), ''), 'Primary QR'),
      p_expires_at,
      auth.uid()
    )
    RETURNING clinic_intake_tokens.id, clinic_intake_tokens.clinic_id, clinic_intake_tokens.label, clinic_intake_tokens.expires_at
  )
  SELECT inserted.id, inserted.clinic_id, raw_token, inserted.label, inserted.expires_at
  FROM inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_public_intake_token(p_token TEXT)
RETURNS TABLE(clinic_id UUID, hospital_name TEXT, doctor_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  token_row public.clinic_intake_tokens%ROWTYPE;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN
    RETURN;
  END IF;

  SELECT *
    INTO token_row
    FROM public.clinic_intake_tokens
   WHERE token_hash = public.hash_intake_token(p_token)
     AND status = 'active'
     AND (expires_at IS NULL OR expires_at > NOW())
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.clinic_intake_tokens
     SET last_used_at = NOW(),
         use_count = use_count + 1
   WHERE id = token_row.id;

  RETURN QUERY
  SELECT DISTINCT
    hb.clinic_id,
    hb.hospital_name,
    hb.doctor_name
  FROM public.hospital_boarding hb
  JOIN public.clinics c ON c.id = hb.clinic_id
  WHERE hb.clinic_id = token_row.clinic_id
    AND c.status = 'active'
    AND hb.hospital_name IS NOT NULL AND trim(hb.hospital_name) <> ''
    AND hb.doctor_name   IS NOT NULL AND trim(hb.doctor_name)   <> ''
  ORDER BY hb.hospital_name, hb.doctor_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_clinic_intake_token(UUID, TEXT, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_intake_token(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_public_intake_token(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.next_patient_code(p_clinic_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_num INTEGER;
  clinic_code TEXT;
BEGIN
  IF p_clinic_id IS NULL THEN
    RAISE EXCEPTION 'clinic_id is required for patient code generation';
  END IF;

  INSERT INTO public.clinic_patient_code_counters (clinic_id, next_value)
  VALUES (p_clinic_id, 1)
  ON CONFLICT (clinic_id) DO NOTHING;

  UPDATE public.clinic_patient_code_counters
     SET next_value = next_value + 1,
         updated_at = NOW()
   WHERE clinic_id = p_clinic_id
   RETURNING next_value - 1 INTO next_num;

  SELECT code INTO clinic_code FROM public.clinics WHERE id = p_clinic_id;
  RETURN COALESCE(clinic_code, 'CLINIC') || '-PAT-' || lpad(next_num::text, 4, '0');
END;
$$;

-- Tenant columns -------------------------------------------------------------
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS login_username TEXT;
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS auth_user_id UUID;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.doctor_profiles ADD COLUMN IF NOT EXISTS login_username TEXT;
ALTER TABLE public.patients ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.prescriptions ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.prescription_medicines ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.prescription_audit_logs ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.message_logs ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.message_ledger ADD COLUMN IF NOT EXISTS clinic_id UUID;
ALTER TABLE public.system_logs ADD COLUMN IF NOT EXISTS clinic_id UUID;

-- Backfill clinic rows from existing text fields.
INSERT INTO public.clinics (name, slug, code)
SELECT DISTINCT
  clean_name,
  public.slugify_clinic_name(clean_name),
  upper(left(regexp_replace(public.slugify_clinic_name(clean_name), '[^a-z0-9]', '', 'g'), 10))
FROM (
  SELECT COALESCE(NULLIF(trim(hospital_name), ''), 'Unassigned Clinic') AS clean_name FROM public.hospital_boarding
  UNION
  SELECT COALESCE(NULLIF(trim(clinic_name), ''), 'Unassigned Clinic') FROM public.doctor_profiles
  UNION
  SELECT COALESCE(NULLIF(trim(clinic_name), ''), 'Unassigned Clinic') FROM public.patients
  UNION
  SELECT COALESCE(NULLIF(trim(clinic_name), ''), 'Unassigned Clinic') FROM public.patient_visits
) names
ON CONFLICT (slug) DO NOTHING;

INSERT INTO public.clinics (name, slug, code)
VALUES ('Unassigned Clinic', 'unassigned-clinic', 'UNASSIGNED')
ON CONFLICT (slug) DO NOTHING;

UPDATE public.hospital_boarding hb
   SET clinic_id = public.get_or_create_clinic_id(hb.hospital_name)
 WHERE hb.clinic_id IS NULL;

UPDATE public.doctor_profiles dp
   SET clinic_id = public.get_or_create_clinic_id(dp.clinic_name)
 WHERE dp.clinic_id IS NULL;

UPDATE public.patients p
   SET clinic_id = public.get_or_create_clinic_id(p.clinic_name)
 WHERE p.clinic_id IS NULL;

UPDATE public.patient_visits pv
   SET clinic_id = COALESCE(p.clinic_id, public.get_or_create_clinic_id(pv.clinic_name))
  FROM public.patients p
 WHERE pv.patient_id = p.id
   AND pv.clinic_id IS NULL;

UPDATE public.patient_visits pv
   SET clinic_id = public.get_or_create_clinic_id(pv.clinic_name)
 WHERE pv.clinic_id IS NULL;

UPDATE public.prescriptions AS pr
   SET clinic_id = sub.clinic_id
  FROM (
    SELECT pr2.id,
           COALESCE(pv.clinic_id, p.clinic_id, dp.clinic_id) AS clinic_id
      FROM public.prescriptions pr2
      JOIN public.patients p ON p.id = pr2.patient_id
      LEFT JOIN public.patient_visits pv ON pv.id = pr2.visit_id
      LEFT JOIN public.doctor_profiles dp ON dp.id = pr2.doctor_profile_id
     WHERE pr2.clinic_id IS NULL
  ) AS sub
 WHERE pr.id = sub.id;

UPDATE public.prescriptions
   SET clinic_id = public.get_or_create_clinic_id('Unassigned Clinic')
 WHERE clinic_id IS NULL;

UPDATE public.prescription_medicines pm
   SET clinic_id = pr.clinic_id
  FROM public.prescriptions pr
 WHERE pr.id = pm.prescription_id
   AND pm.clinic_id IS NULL;

UPDATE public.prescription_medicines
   SET clinic_id = public.get_or_create_clinic_id('Unassigned Clinic')
 WHERE clinic_id IS NULL;

UPDATE public.prescription_audit_logs AS pal
   SET clinic_id = sub.clinic_id
  FROM (
    SELECT pal2.id,
           COALESCE(pr.clinic_id, pv.clinic_id) AS clinic_id
      FROM public.prescription_audit_logs pal2
      JOIN public.prescriptions pr ON pr.id = pal2.prescription_id
      LEFT JOIN public.patient_visits pv ON pv.id = pal2.visit_id
     WHERE pal2.clinic_id IS NULL
  ) AS sub
 WHERE pal.id = sub.id;

UPDATE public.prescription_audit_logs
   SET clinic_id = public.get_or_create_clinic_id('Unassigned Clinic')
 WHERE clinic_id IS NULL;

UPDATE public.message_logs ml
   SET clinic_id = p.clinic_id
  FROM public.patients p
 WHERE p.id = ml.patient_id
   AND ml.clinic_id IS NULL;

UPDATE public.message_ledger l
   SET clinic_id = p.clinic_id
  FROM public.patients p
 WHERE p.id = l.patient_id
   AND l.clinic_id IS NULL;

UPDATE public.system_logs
   SET clinic_id = public.get_or_create_clinic_id('Unassigned Clinic')
 WHERE clinic_id IS NULL;

UPDATE public.message_logs
   SET clinic_id = public.get_or_create_clinic_id('Unassigned Clinic')
 WHERE clinic_id IS NULL;

UPDATE public.message_ledger
   SET clinic_id = public.get_or_create_clinic_id('Unassigned Clinic')
 WHERE clinic_id IS NULL;

-- Foreign keys and required tenant ownership --------------------------------
ALTER TABLE public.hospital_boarding
  DROP CONSTRAINT IF EXISTS hospital_boarding_clinic_id_fkey,
  ADD CONSTRAINT hospital_boarding_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.doctor_profiles
  DROP CONSTRAINT IF EXISTS doctor_profiles_clinic_id_fkey,
  ADD CONSTRAINT doctor_profiles_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.patients
  DROP CONSTRAINT IF EXISTS patients_clinic_id_fkey,
  ADD CONSTRAINT patients_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.patient_visits
  DROP CONSTRAINT IF EXISTS patient_visits_clinic_id_fkey,
  ADD CONSTRAINT patient_visits_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.prescriptions
  DROP CONSTRAINT IF EXISTS prescriptions_clinic_id_fkey,
  ADD CONSTRAINT prescriptions_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.prescription_medicines
  DROP CONSTRAINT IF EXISTS prescription_medicines_clinic_id_fkey,
  ADD CONSTRAINT prescription_medicines_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.prescription_audit_logs
  DROP CONSTRAINT IF EXISTS prescription_audit_logs_clinic_id_fkey,
  ADD CONSTRAINT prescription_audit_logs_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.message_logs
  DROP CONSTRAINT IF EXISTS message_logs_clinic_id_fkey,
  ADD CONSTRAINT message_logs_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.message_ledger
  DROP CONSTRAINT IF EXISTS message_ledger_clinic_id_fkey,
  ADD CONSTRAINT message_ledger_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;
ALTER TABLE public.system_logs
  DROP CONSTRAINT IF EXISTS system_logs_clinic_id_fkey,
  ADD CONSTRAINT system_logs_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES public.clinics (id) ON DELETE RESTRICT;

ALTER TABLE public.hospital_boarding ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.doctor_profiles ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.patients ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.patient_visits ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.prescriptions ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.prescription_medicines ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.prescription_audit_logs ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.message_logs ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.message_ledger ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.system_logs ALTER COLUMN clinic_id SET NOT NULL;
ALTER TABLE public.message_logs ALTER COLUMN clinic_id SET DEFAULT public.get_or_create_clinic_id('Unassigned Clinic');
ALTER TABLE public.message_ledger ALTER COLUMN clinic_id SET DEFAULT public.get_or_create_clinic_id('Unassigned Clinic');
ALTER TABLE public.system_logs ALTER COLUMN clinic_id SET DEFAULT public.get_or_create_clinic_id('Unassigned Clinic');

-- Clinic-scoped uniqueness and performance indexes ---------------------------
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_phone_unique;
ALTER TABLE public.patients DROP CONSTRAINT IF EXISTS patients_patient_code_unique;
ALTER TABLE public.message_ledger DROP CONSTRAINT IF EXISTS message_ledger_patient_id_message_type_scheduled_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_clinic_phone_unique
  ON public.patients (clinic_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_patients_clinic_patient_code_unique
  ON public.patients (clinic_id, patient_code)
  WHERE patient_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patients_clinic_followup_status
  ON public.patients (clinic_id, follow_up_date, status);
CREATE INDEX IF NOT EXISTS idx_patient_visits_clinic_queue
  ON public.patient_visits (clinic_id, visit_date DESC, visit_status, doctor_profile_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_clinic_patient
  ON public.prescriptions (clinic_id, patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_clinic_sid
  ON public.message_logs (clinic_id, twilio_message_sid);
CREATE INDEX IF NOT EXISTS idx_message_ledger_clinic_sid
  ON public.message_ledger (clinic_id, twilio_message_sid);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_ledger_clinic_patient_type_date
  ON public.message_ledger (clinic_id, patient_id, message_type, scheduled_date)
  WHERE patient_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_logs_clinic_patient_type_date
  ON public.message_logs (clinic_id, patient_id, message_type, scheduled_date)
  WHERE patient_id IS NOT NULL AND scheduled_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_system_logs_clinic_timestamp
  ON public.system_logs (clinic_id, timestamp DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_profiles_clinic_registration
  ON public.doctor_profiles (clinic_id, registration_number)
  WHERE registration_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_doctor_profiles_clinic_phone
  ON public.doctor_profiles (clinic_id, public.normalized_whatsapp_phone(doctor_phone));
CREATE UNIQUE INDEX IF NOT EXISTS idx_hospital_boarding_login_username
  ON public.hospital_boarding (login_username)
  WHERE login_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_auth_user_id
  ON public.hospital_boarding (auth_user_id)
  WHERE auth_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_doctor_profiles_login_username
  ON public.doctor_profiles (login_username)
  WHERE login_username IS NOT NULL;

INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
SELECT dp.clinic_id, dp.user_id, dp.id, 'doctor', 'active'
FROM public.doctor_profiles dp
WHERE dp.user_id IS NOT NULL
ON CONFLICT (clinic_id, user_id, role) DO NOTHING;

INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
SELECT dp.clinic_id, dp.user_id, dp.id, 'clinic_admin', 'active'
FROM public.doctor_profiles dp
WHERE dp.user_id IS NOT NULL
  AND dp.is_clinic_admin = TRUE
ON CONFLICT (clinic_id, user_id, role) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_or_create_doctor_profile_for_current_user()
RETURNS public.doctor_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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
   ORDER BY dp.updated_at DESC
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
    VALUES (profile.clinic_id, auth.uid(), profile.id, 'doctor', 'active')
    ON CONFLICT (clinic_id, user_id, role) DO NOTHING;

    IF profile.is_clinic_admin THEN
      INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
      VALUES (profile.clinic_id, auth.uid(), profile.id, 'clinic_admin', 'active')
      ON CONFLICT (clinic_id, user_id, role) DO NOTHING;
    END IF;

    RETURN profile;
  END IF;

  SELECT hb.*
    INTO boarding
    FROM public.hospital_boarding hb
   WHERE hb.auth_user_id = auth.uid()
   ORDER BY hb.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.doctor_profiles (
    clinic_id,
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
    login_username,
    signature_image_url,
    signature_label,
    stamp_label
  )
  VALUES (
    boarding.clinic_id,
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
    boarding.doctor_phone,
    boarding.login_username,
    boarding.doctor_signature_url,
    boarding.doctor_name,
    COALESCE(NULLIF(boarding.doctor_registration_number, ''), 'Registration pending')
  )
  RETURNING * INTO profile;

  INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
  VALUES (profile.clinic_id, auth.uid(), profile.id, 'doctor', 'active')
  ON CONFLICT (clinic_id, user_id, role) DO NOTHING;

  RETURN profile;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_doctor_profile_for_current_user() TO authenticated;

-- Tenant consistency guardrails ---------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_clinic_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_clinic UUID;
BEGIN
  IF TG_TABLE_NAME = 'patient_visits' THEN
    SELECT clinic_id INTO parent_clinic FROM public.patients WHERE id = NEW.patient_id;
    IF parent_clinic IS NULL OR parent_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'patient_visits.clinic_id must match patients.clinic_id';
    END IF;
  ELSIF TG_TABLE_NAME = 'prescriptions' THEN
    SELECT clinic_id INTO parent_clinic FROM public.patients WHERE id = NEW.patient_id;
    IF parent_clinic IS NULL OR parent_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'prescriptions.clinic_id must match patients.clinic_id';
    END IF;
    IF NEW.visit_id IS NOT NULL THEN
      SELECT clinic_id INTO parent_clinic FROM public.patient_visits WHERE id = NEW.visit_id;
      IF parent_clinic IS NULL OR parent_clinic <> NEW.clinic_id THEN
        RAISE EXCEPTION 'prescriptions.clinic_id must match patient_visits.clinic_id';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'prescription_medicines' THEN
    SELECT clinic_id INTO parent_clinic FROM public.prescriptions WHERE id = NEW.prescription_id;
    IF parent_clinic IS NULL OR parent_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'prescription_medicines.clinic_id must match prescriptions.clinic_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patient_visits_clinic_consistency ON public.patient_visits;
CREATE TRIGGER trg_patient_visits_clinic_consistency
  BEFORE INSERT OR UPDATE OF clinic_id, patient_id ON public.patient_visits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_clinic_consistency();

DROP TRIGGER IF EXISTS trg_prescriptions_clinic_consistency ON public.prescriptions;
CREATE TRIGGER trg_prescriptions_clinic_consistency
  BEFORE INSERT OR UPDATE OF clinic_id, patient_id, visit_id ON public.prescriptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_clinic_consistency();

DROP TRIGGER IF EXISTS trg_prescription_medicines_clinic_consistency ON public.prescription_medicines;
CREATE TRIGGER trg_prescription_medicines_clinic_consistency
  BEFORE INSERT OR UPDATE OF clinic_id, prescription_id ON public.prescription_medicines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_clinic_consistency();

-- RLS policies ---------------------------------------------------------------
ALTER TABLE public.clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clinic_intake_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "members read own clinics" ON public.clinics;
CREATE POLICY "members read own clinics"
  ON public.clinics FOR SELECT
  TO authenticated
  USING (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(id)
  );

DROP POLICY IF EXISTS "members read own memberships" ON public.clinic_memberships;
CREATE POLICY "members read own memberships"
  ON public.clinic_memberships FOR SELECT
  TO authenticated
  USING (
    public.current_user_is_platform_admin()
    OR user_id = auth.uid()
    OR public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin'])
  );

DROP POLICY IF EXISTS "clinic admins manage memberships" ON public.clinic_memberships;
CREATE POLICY "clinic admins manage memberships"
  ON public.clinic_memberships FOR ALL
  TO authenticated
  USING (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin'])
  )
  WITH CHECK (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin'])
  );

DROP POLICY IF EXISTS "clinic admins manage intake tokens" ON public.clinic_intake_tokens;
CREATE POLICY "clinic admins manage intake tokens"
  ON public.clinic_intake_tokens FOR ALL
  TO authenticated
  USING (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin'])
  )
  WITH CHECK (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin'])
  );

-- Replace broad name-matching doctor policies with clinic membership policies.
DROP POLICY IF EXISTS "doctors read own profile" ON public.doctor_profiles;
DROP POLICY IF EXISTS "members read clinic doctor profiles" ON public.doctor_profiles;
CREATE POLICY "members read clinic doctor profiles"
  ON public.doctor_profiles FOR SELECT
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','staff','super_admin'])
  );

DROP POLICY IF EXISTS "doctors update own profile" ON public.doctor_profiles;
DROP POLICY IF EXISTS "members update clinic doctor profiles" ON public.doctor_profiles;
CREATE POLICY "members update clinic doctor profiles"
  ON public.doctor_profiles FOR UPDATE
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  )
  WITH CHECK (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  );

DROP POLICY IF EXISTS "doctors insert claimed profile" ON public.doctor_profiles;
DROP POLICY IF EXISTS "members insert clinic doctor profiles" ON public.doctor_profiles;
CREATE POLICY "members insert clinic doctor profiles"
  ON public.doctor_profiles FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','super_admin'])
  );

DROP POLICY IF EXISTS "doctors read matching hospital boarding" ON public.hospital_boarding;
DROP POLICY IF EXISTS "members read clinic hospital boarding" ON public.hospital_boarding;
CREATE POLICY "members read clinic hospital boarding"
  ON public.hospital_boarding FOR SELECT
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','staff','super_admin'])
  );

DROP POLICY IF EXISTS "doctors read assigned visits" ON public.patient_visits;
DROP POLICY IF EXISTS "members read clinic visits" ON public.patient_visits;
CREATE POLICY "members read clinic visits"
  ON public.patient_visits FOR SELECT
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','staff','super_admin'])
  );

DROP POLICY IF EXISTS "doctors update assigned visits" ON public.patient_visits;
DROP POLICY IF EXISTS "members update clinic visits" ON public.patient_visits;
CREATE POLICY "members update clinic visits"
  ON public.patient_visits FOR UPDATE
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','staff','super_admin'])
  )
  WITH CHECK (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','staff','super_admin'])
  );

DROP POLICY IF EXISTS "doctors read queue patients" ON public.patients;
DROP POLICY IF EXISTS "members read clinic patients" ON public.patients;
CREATE POLICY "members read clinic patients"
  ON public.patients FOR SELECT
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','staff','super_admin'])
  );

DROP POLICY IF EXISTS "doctors manage own prescriptions" ON public.prescriptions;
DROP POLICY IF EXISTS "members manage clinic prescriptions" ON public.prescriptions;
CREATE POLICY "members manage clinic prescriptions"
  ON public.prescriptions FOR ALL
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  )
  WITH CHECK (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  );

DROP POLICY IF EXISTS "doctors manage prescription medicines" ON public.prescription_medicines;
DROP POLICY IF EXISTS "members manage clinic prescription medicines" ON public.prescription_medicines;
CREATE POLICY "members manage clinic prescription medicines"
  ON public.prescription_medicines FOR ALL
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  )
  WITH CHECK (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  );

DROP POLICY IF EXISTS "doctors read prescription audit logs" ON public.prescription_audit_logs;
DROP POLICY IF EXISTS "members read clinic prescription audit logs" ON public.prescription_audit_logs;
CREATE POLICY "members read clinic prescription audit logs"
  ON public.prescription_audit_logs FOR SELECT
  TO authenticated
  USING (
    public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  );

DROP POLICY IF EXISTS "doctors insert prescription audit logs" ON public.prescription_audit_logs;
DROP POLICY IF EXISTS "members insert clinic prescription audit logs" ON public.prescription_audit_logs;
CREATE POLICY "members insert clinic prescription audit logs"
  ON public.prescription_audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    actor_user_id = auth.uid()
    AND public.current_user_has_clinic_role(clinic_id, ARRAY['clinic_admin','doctor','super_admin'])
  );

DROP FUNCTION IF EXISTS public.get_public_hospital_list();

CREATE OR REPLACE FUNCTION public.get_public_hospital_list()
RETURNS TABLE(clinic_id UUID, hospital_name TEXT, doctor_name TEXT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT DISTINCT
    hb.clinic_id,
    hb.hospital_name,
    hb.doctor_name
  FROM public.hospital_boarding hb
  JOIN public.clinics c ON c.id = hb.clinic_id
  WHERE c.status = 'active'
    AND hb.hospital_name IS NOT NULL AND trim(hb.hospital_name) <> ''
    AND hb.doctor_name   IS NOT NULL AND trim(hb.doctor_name)   <> ''
  ORDER BY hb.hospital_name, hb.doctor_name;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_hospital_list() TO anon;
GRANT EXECUTE ON FUNCTION public.get_public_hospital_list() TO authenticated;

CREATE OR REPLACE VIEW public.tenant_isolation_validation AS
SELECT 'patients_missing_clinic' AS check_name, COUNT(*)::bigint AS failing_rows FROM public.patients WHERE clinic_id IS NULL
UNION ALL SELECT 'visits_missing_clinic', COUNT(*) FROM public.patient_visits WHERE clinic_id IS NULL
UNION ALL SELECT 'visits_patient_clinic_mismatch', COUNT(*)
  FROM public.patient_visits pv JOIN public.patients p ON p.id = pv.patient_id WHERE pv.clinic_id <> p.clinic_id
UNION ALL SELECT 'prescriptions_patient_clinic_mismatch', COUNT(*)
  FROM public.prescriptions pr JOIN public.patients p ON p.id = pr.patient_id WHERE pr.clinic_id <> p.clinic_id
UNION ALL SELECT 'message_logs_missing_clinic', COUNT(*) FROM public.message_logs WHERE clinic_id IS NULL
UNION ALL SELECT 'message_ledger_missing_clinic', COUNT(*) FROM public.message_ledger WHERE clinic_id IS NULL;

NOTIFY pgrst, 'reload schema';
