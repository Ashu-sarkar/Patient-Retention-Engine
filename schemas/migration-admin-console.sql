-- =============================================================================
-- Migration: admin console + per-clinic token QR support
--
-- Depends on schemas/migration-v0-multitenant.sql (clinics, clinic_memberships,
-- clinic_intake_tokens, get_or_create_clinic_id, next_patient_code,
-- current_user_is_platform_admin). Apply AFTER that file.
--
-- Adds:
--   * platform_admins table (super admins not tied to a single clinic)
--   * is_demo tagging on patients / patient_visits / prescriptions
--   * admin RPCs to create clinics, list clinics, manage intake tokens, and
--     seed / clear demo patients (all gated on current_user_is_platform_admin)
--   * platform-admin SELECT (read-only) RLS so the admin dashboard can read any
--     clinic without broadening write access
--
-- Safe to run repeatedly.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Platform admins (decoupled from any single clinic)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_admins (
  user_id    UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- Platform admins may see the admin roster. No INSERT/UPDATE/DELETE policy is
-- defined on purpose: the roster is bootstrapped/managed only via SQL or the
-- service role, never from a browser session.
DROP POLICY IF EXISTS "platform admins read roster" ON public.platform_admins;
CREATE POLICY "platform admins read roster"
  ON public.platform_admins FOR SELECT
  TO authenticated
  USING (public.current_user_is_platform_admin());

-- Treat a row in platform_admins as platform-admin in addition to the existing
-- super_admin clinic membership. SECURITY DEFINER bypasses RLS so there is no
-- recursion against platform_admins' own policy.
CREATE OR REPLACE FUNCTION public.current_user_is_platform_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.platform_admins pa
         WHERE pa.user_id = auth.uid()
       )
       OR EXISTS (
         SELECT 1
         FROM public.clinic_memberships cm
         WHERE cm.user_id = auth.uid()
           AND cm.status = 'active'
           AND cm.role = 'super_admin'
       )
     )
$$;

-- -----------------------------------------------------------------------------
-- Demo data tagging
-- -----------------------------------------------------------------------------
ALTER TABLE public.patients       ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.patient_visits ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.prescriptions  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_patients_clinic_is_demo
  ON public.patients (clinic_id, is_demo);
CREATE INDEX IF NOT EXISTS idx_patient_visits_clinic_is_demo
  ON public.patient_visits (clinic_id, is_demo);

-- -----------------------------------------------------------------------------
-- Clinic registration is owned by the hospital-onboarding form (WF12), which
-- calls get_or_create_clinic_id and writes hospital_boarding. The admin console
-- never creates clinics, so any earlier admin_create_clinic RPC is removed to
-- keep a single source of truth for onboarding.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_create_clinic(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

-- -----------------------------------------------------------------------------
-- Admin: list clinics with rollup stats (onboarded via the hospital form)
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_clinics();
CREATE OR REPLACE FUNCTION public.admin_list_clinics()
RETURNS TABLE(
  clinic_id          UUID,
  name               TEXT,
  slug               TEXT,
  code               TEXT,
  status             TEXT,
  created_at         TIMESTAMPTZ,
  city               TEXT,
  primary_doctor     TEXT,
  contact_phone      TEXT,
  doctor_count       BIGINT,
  patient_count      BIGINT,
  demo_patient_count BIGINT,
  visits_today       BIGINT,
  last_visit_at      TIMESTAMPTZ,
  active_tokens      BIGINT,
  total_token_uses   BIGINT,
  needs_attention    BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.name,
    c.slug,
    c.code,
    c.status,
    c.created_at,
    hb.city,
    hb.doctor_name,
    hb.contact_phone,
    (SELECT COUNT(DISTINCT lower(trim(h.doctor_name))) FROM public.hospital_boarding h WHERE h.clinic_id = c.id),
    (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id),
    (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id AND p.is_demo),
    (SELECT COUNT(*) FROM public.patient_visits pv WHERE pv.clinic_id = c.id AND pv.visit_date = CURRENT_DATE),
    (SELECT MAX(pv.checked_in_at) FROM public.patient_visits pv WHERE pv.clinic_id = c.id),
    (SELECT COUNT(*) FROM public.clinic_intake_tokens t
       WHERE t.clinic_id = c.id AND t.status = 'active'
         AND (t.expires_at IS NULL OR t.expires_at > NOW())),
    (SELECT COALESCE(SUM(t.use_count), 0) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id),
    -- Flag clinics that cannot fully operate yet: no active QR, or a doctor
    -- without a WhatsApp phone (so they cannot sign in to the dashboard).
    (
      NOT EXISTS (
        SELECT 1 FROM public.clinic_intake_tokens t
        WHERE t.clinic_id = c.id AND t.status = 'active'
          AND (t.expires_at IS NULL OR t.expires_at > NOW())
      )
      OR EXISTS (
        SELECT 1 FROM public.hospital_boarding h
        WHERE h.clinic_id = c.id
          AND public.normalized_whatsapp_phone(h.doctor_phone) IS NULL
      )
    )
  FROM public.clinics c
  LEFT JOIN LATERAL (
    SELECT h.city, h.doctor_name, h.contact_phone
    FROM public.hospital_boarding h
    WHERE h.clinic_id = c.id
    ORDER BY h.created_at DESC
    LIMIT 1
  ) hb ON TRUE
  ORDER BY c.created_at DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- Admin: full onboarding detail for one clinic (contact + doctors + activity)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_get_clinic_details(p_clinic_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT public.current_user_is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT jsonb_build_object(
    'clinic', to_jsonb(c.*),
    'contact', (
      SELECT to_jsonb(h) FROM (
        SELECT hb.hospital_name, hb.facility_type, hb.address, hb.city, hb.contact_phone,
               hb.admin_contact_name, hb.clinic_email, hb.clinic_website,
               hb.consultation_hours, hb.clinic_logo_url, hb.created_at AS onboarded_at
        FROM public.hospital_boarding hb
        WHERE hb.clinic_id = c.id
        ORDER BY hb.created_at DESC
        LIMIT 1
      ) h
    ),
    'doctors', COALESCE((
      SELECT jsonb_agg(d ORDER BY d.doctor_name) FROM (
        SELECT DISTINCT hb.doctor_name, hb.doctor_qualification, hb.doctor_expertise,
               hb.doctor_registration_number,
               public.normalized_whatsapp_phone(hb.doctor_phone) AS doctor_phone,
               EXISTS (
                 SELECT 1 FROM public.doctor_profiles dp
                 WHERE dp.clinic_id = c.id
                   AND lower(trim(dp.doctor_name)) = lower(trim(hb.doctor_name))
                   AND dp.user_id IS NOT NULL
               ) AS has_logged_in
        FROM public.hospital_boarding hb
        WHERE hb.clinic_id = c.id
      ) d
    ), '[]'::jsonb),
    'stats', jsonb_build_object(
      'patient_count',      (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id),
      'demo_patient_count', (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id AND p.is_demo),
      'total_visits',       (SELECT COUNT(*) FROM public.patient_visits pv WHERE pv.clinic_id = c.id),
      'visits_today',       (SELECT COUNT(*) FROM public.patient_visits pv WHERE pv.clinic_id = c.id AND pv.visit_date = CURRENT_DATE),
      'last_visit_at',      (SELECT MAX(pv.checked_in_at) FROM public.patient_visits pv WHERE pv.clinic_id = c.id),
      'prescriptions',      (SELECT COUNT(*) FROM public.prescriptions pr WHERE pr.clinic_id = c.id),
      'active_tokens',      (SELECT COUNT(*) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id AND t.status = 'active' AND (t.expires_at IS NULL OR t.expires_at > NOW())),
      'total_token_uses',   (SELECT COALESCE(SUM(t.use_count), 0) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id),
      'last_token_used_at', (SELECT MAX(t.last_used_at) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id)
    )
  )
  INTO v_result
  FROM public.clinics c
  WHERE c.id = p_clinic_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'clinic not found';
  END IF;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- Admin: list intake tokens (metadata only, never the raw token)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_intake_tokens(p_clinic_id UUID)
RETURNS TABLE(
  id           UUID,
  label        TEXT,
  status       TEXT,
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  use_count    INTEGER,
  created_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(p_clinic_id, ARRAY['clinic_admin'])
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT t.id, t.label, t.status, t.expires_at, t.last_used_at, t.use_count, t.created_at
  FROM public.clinic_intake_tokens t
  WHERE t.clinic_id = p_clinic_id
  ORDER BY t.created_at DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- Admin: enable / disable / expire an intake token
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_token_status(p_token_id UUID, p_status TEXT)
RETURNS public.clinic_intake_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic_id UUID;
  v_row       public.clinic_intake_tokens;
BEGIN
  IF p_status NOT IN ('active', 'disabled', 'expired') THEN
    RAISE EXCEPTION 'invalid token status: %', p_status;
  END IF;

  SELECT clinic_id INTO v_clinic_id
  FROM public.clinic_intake_tokens
  WHERE id = p_token_id;

  IF v_clinic_id IS NULL THEN
    RAISE EXCEPTION 'token not found';
  END IF;

  IF NOT (
    public.current_user_is_platform_admin()
    OR public.current_user_has_clinic_role(v_clinic_id, ARRAY['clinic_admin'])
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  UPDATE public.clinic_intake_tokens
     SET status = p_status,
         updated_at = NOW()
   WHERE id = p_token_id
   RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

-- -----------------------------------------------------------------------------
-- Admin: seed demo patients (tagged is_demo, non-routable phones)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_seed_dummy_patients(p_clinic_id UUID, p_count INTEGER DEFAULT 8)
RETURNS TABLE(seeded INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count        INTEGER := LEAST(GREATEST(COALESCE(p_count, 8), 1), 50);
  v_hospital     TEXT;
  v_doctor       TEXT;
  v_doctor_pid   UUID;
  v_base         INTEGER;
  v_seeded       INTEGER := 0;
  v_phone        TEXT;
  v_name         TEXT;
  v_patient_id   UUID;
  v_visit_id     UUID;
  v_rx_id        UUID;
  v_visit_date   DATE;
  v_status       TEXT;
  v_completed    BOOLEAN;
  i              INTEGER;
  first_names    TEXT[] := ARRAY['Aarav','Vivaan','Ananya','Diya','Ishaan','Kabir','Aisha','Meera','Rohan','Saanvi','Arjun','Riya','Kiara','Dev','Tara','Neil','Zara','Aryan','Myra','Vihaan'];
  last_names     TEXT[] := ARRAY['Sharma','Verma','Patel','Reddy','Nair','Iyer','Gupta','Khan','Das','Bose','Mehta','Rao','Singh','Joshi','Pillai'];
  sexes          TEXT[] := ARRAY['Male','Female','Other'];
  complaints     TEXT[] := ARRAY['Fever and body ache','Persistent cough','Headache','Acidity and bloating','Back pain','Skin rash','Seasonal allergy','Routine check-up'];
BEGIN
  IF NOT public.current_user_is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized to seed demo patients';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clinics WHERE id = p_clinic_id) THEN
    RAISE EXCEPTION 'clinic not found';
  END IF;

  SELECT hb.hospital_name, hb.doctor_name
    INTO v_hospital, v_doctor
  FROM public.hospital_boarding hb
  WHERE hb.clinic_id = p_clinic_id
  ORDER BY hb.created_at
  LIMIT 1;

  IF v_hospital IS NULL THEN
    SELECT c.name INTO v_hospital FROM public.clinics c WHERE c.id = p_clinic_id;
  END IF;
  v_doctor := COALESCE(v_doctor, 'Attending Doctor');

  SELECT dp.id INTO v_doctor_pid
  FROM public.doctor_profiles dp
  WHERE dp.clinic_id = p_clinic_id
    AND lower(trim(dp.doctor_name)) = lower(trim(v_doctor))
  ORDER BY dp.created_at
  LIMIT 1;

  -- Offset future phones past any demo patients already seeded for this clinic.
  SELECT COUNT(*) INTO v_base FROM public.patients WHERE clinic_id = p_clinic_id AND is_demo;

  FOR i IN 1..v_count LOOP
    v_name  := first_names[1 + ((v_base + i) % array_length(first_names, 1))]
               || ' ' || last_names[1 + ((v_base + i) % array_length(last_names, 1))];
    -- Country code 999 is unassigned by ITU, so these can never deliver.
    v_phone := '+999' || lpad((1000000 + v_base + i)::text, 8, '0');
    v_completed := (i % 2 = 0);
    v_visit_date := CASE WHEN v_completed THEN CURRENT_DATE - ((i % 20) + 1) ELSE CURRENT_DATE END;
    v_status := CASE WHEN v_completed THEN 'completed' ELSE 'pending' END;

    INSERT INTO public.patients (
      clinic_id, patient_code, name, phone, dob, sex, clinic_name, doctor_name,
      visit_date, follow_up_required, status, message_count, is_demo
    )
    VALUES (
      p_clinic_id, public.next_patient_code(p_clinic_id), v_name, v_phone,
      (CURRENT_DATE - ((18 + ((v_base + i) % 60)) * 365))::date,
      sexes[1 + ((v_base + i) % 3)], v_hospital, v_doctor,
      v_visit_date, 'No', v_status, 0, TRUE
    )
    RETURNING id INTO v_patient_id;

    INSERT INTO public.patient_visits (
      clinic_id, patient_id, doctor_profile_id, patient_code, clinic_name, doctor_name,
      visit_date, visit_status, chief_complaint, checked_in_at,
      consultation_started_at, completed_at, is_demo
    )
    VALUES (
      p_clinic_id, v_patient_id, v_doctor_pid,
      (SELECT patient_code FROM public.patients WHERE id = v_patient_id),
      v_hospital, v_doctor, v_visit_date,
      CASE WHEN v_completed THEN 'completed' ELSE 'waiting' END,
      complaints[1 + ((v_base + i) % array_length(complaints, 1))],
      v_visit_date::timestamptz + interval '9 hours',
      CASE WHEN v_completed THEN v_visit_date::timestamptz + interval '9 hours 20 minutes' ELSE NULL END,
      CASE WHEN v_completed THEN v_visit_date::timestamptz + interval '9 hours 35 minutes' ELSE NULL END,
      TRUE
    )
    RETURNING id INTO v_visit_id;

    -- Demo prescriptions are kept as drafts so they remain deletable on cleanup
    -- (issued prescriptions are immutable/undeletable by design).
    IF v_completed THEN
      INSERT INTO public.prescriptions (
        clinic_id, patient_id, visit_id, doctor_profile_id, status,
        diagnosis, advice, follow_up_required, is_demo
      )
      VALUES (
        p_clinic_id, v_patient_id, v_visit_id, v_doctor_pid, 'draft',
        complaints[1 + ((v_base + i) % array_length(complaints, 1))],
        'Stay hydrated and rest. Return if symptoms persist.', 'No', TRUE
      )
      RETURNING id INTO v_rx_id;

      INSERT INTO public.prescription_medicines
        (prescription_id, medicine_name, dosage, frequency, timing, duration, instructions, sort_order)
      VALUES
        (v_rx_id, 'Paracetamol 500mg', '1 tablet', 'Twice daily', 'After food', '3 days', 'For fever', 1),
        (v_rx_id, 'Cetirizine 10mg', '1 tablet', 'Once daily', 'At night', '5 days', 'For allergy', 2);
    END IF;

    v_seeded := v_seeded + 1;
  END LOOP;

  RETURN QUERY SELECT v_seeded;
END;
$$;

-- -----------------------------------------------------------------------------
-- Admin: clear demo patients for a clinic (cascades visits + draft prescriptions)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_clear_dummy_patients(p_clinic_id UUID)
RETURNS TABLE(deleted INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF NOT public.current_user_is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized to clear demo patients';
  END IF;

  WITH removed AS (
    DELETE FROM public.patients
    WHERE clinic_id = p_clinic_id AND is_demo
    RETURNING id
  )
  SELECT COUNT(*) INTO v_deleted FROM removed;

  RETURN QUERY SELECT v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_clinics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_clinic_details(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_intake_tokens(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_token_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_seed_dummy_patients(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_dummy_patients(UUID) TO authenticated;

-- -----------------------------------------------------------------------------
-- Platform-admin read-only RLS (additive; does NOT grant writes)
-- Permissive policies are OR-ed with existing clinic-scoped policies, so the
-- admin dashboard can read every clinic while writes stay on the gated RPCs.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "platform admin reads patients" ON public.patients;
CREATE POLICY "platform admin reads patients"
  ON public.patients FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads visits" ON public.patient_visits;
CREATE POLICY "platform admin reads visits"
  ON public.patient_visits FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads prescriptions" ON public.prescriptions;
CREATE POLICY "platform admin reads prescriptions"
  ON public.prescriptions FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads prescription medicines" ON public.prescription_medicines;
CREATE POLICY "platform admin reads prescription medicines"
  ON public.prescription_medicines FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads doctor profiles" ON public.doctor_profiles;
CREATE POLICY "platform admin reads doctor profiles"
  ON public.doctor_profiles FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads hospital boarding" ON public.hospital_boarding;
CREATE POLICY "platform admin reads hospital boarding"
  ON public.hospital_boarding FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads message logs" ON public.message_logs;
CREATE POLICY "platform admin reads message logs"
  ON public.message_logs FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads message ledger" ON public.message_ledger;
CREATE POLICY "platform admin reads message ledger"
  ON public.message_ledger FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

DROP POLICY IF EXISTS "platform admin reads system logs" ON public.system_logs;
CREATE POLICY "platform admin reads system logs"
  ON public.system_logs FOR SELECT TO authenticated
  USING (public.current_user_is_platform_admin());

NOTIFY pgrst, 'reload schema';
