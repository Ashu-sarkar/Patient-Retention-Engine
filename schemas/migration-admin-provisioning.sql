-- =============================================================================
-- Migration: admin console test provisioning (doctors + patients)
--
-- Depends on schemas/migration-admin-console.sql.
--
-- Adds:
--   * admin_provisioned tagging on hospital_boarding, patients, patient_visits
--   * admin_add_patient_to_clinic RPC (parallel to WF11, no intake token)
--   * admin_provision_doctor_to_clinic RPC (called by WF15 after Auth creation)
--   * user_is_platform_admin(UUID) helper for service-role workflow calls
--
-- Admin-provisioned records are excluded from retention messaging workflows
-- (WF1–WF5, WF14) so test data does not affect production patient journeys.
--
-- Safe to run repeatedly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tagging: distinguish admin test provisioning from real intake / demo seed
-- -----------------------------------------------------------------------------
ALTER TABLE public.hospital_boarding ADD COLUMN IF NOT EXISTS admin_provisioned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.patients           ADD COLUMN IF NOT EXISTS admin_provisioned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.patient_visits     ADD COLUMN IF NOT EXISTS admin_provisioned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_patients_clinic_admin_provisioned
  ON public.patients (clinic_id, admin_provisioned);
CREATE INDEX IF NOT EXISTS idx_hospital_boarding_clinic_admin_provisioned
  ON public.hospital_boarding (clinic_id, admin_provisioned);

-- -----------------------------------------------------------------------------
-- Helper: check platform admin by explicit user id (for WF15 service-role calls)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_is_platform_admin(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM public.platform_admins pa
         WHERE pa.user_id = p_user_id
       )
       OR EXISTS (
         SELECT 1
         FROM public.clinic_memberships cm
         WHERE cm.user_id = p_user_id
           AND cm.status = 'active'
           AND cm.role = 'super_admin'
       )
     )
$$;

GRANT EXECUTE ON FUNCTION public.user_is_platform_admin(UUID) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Admin: add patient to existing clinic (testing — mirrors WF11 field rules)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_add_patient_to_clinic(
  p_clinic_id    UUID,
  p_patient_name TEXT,
  p_phone_number TEXT,
  p_doctor_name  TEXT,
  p_visit_date   DATE,
  p_dob          DATE DEFAULT NULL,
  p_sex          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name         TEXT;
  v_phone_raw    TEXT;
  v_phone        TEXT;
  v_doctor       TEXT;
  v_clinic_name  TEXT;
  v_doctor_pid   UUID;
  v_patient_id   UUID;
  v_patient_code TEXT;
  v_visit_id     UUID;
  v_notes        TEXT := 'Added via admin console (testing)';
BEGIN
  IF NOT public.current_user_is_platform_admin() THEN
    RAISE EXCEPTION 'not authorized to provision patients';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clinics WHERE id = p_clinic_id) THEN
    RAISE EXCEPTION 'clinic not found';
  END IF;

  v_name := trim(COALESCE(p_patient_name, ''));
  v_phone_raw := regexp_replace(trim(COALESCE(p_phone_number, '')), '\s+', '', 'g');
  v_doctor := trim(COALESCE(p_doctor_name, ''));

  IF char_length(v_name) < 2 THEN
    RAISE EXCEPTION 'patient_name: required, minimum 2 characters';
  END IF;
  IF v_phone_raw !~ '^[0-9]{10}$' THEN
    RAISE EXCEPTION 'phone_number: must be exactly 10 digits (no +91)';
  END IF;
  IF v_doctor = '' THEN
    RAISE EXCEPTION 'doctor_name: required';
  END IF;
  IF p_visit_date IS NULL THEN
    RAISE EXCEPTION 'visit_date: required';
  END IF;
  IF p_visit_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'visit_date: cannot be in the future';
  END IF;
  IF p_dob IS NOT NULL AND p_dob >= CURRENT_DATE THEN
    RAISE EXCEPTION 'dob: must be a past date';
  END IF;
  IF p_sex IS NOT NULL AND p_sex NOT IN ('Male', 'Female', 'Other') THEN
    RAISE EXCEPTION 'sex: must be Male, Female, or Other';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.hospital_boarding hb
    WHERE hb.clinic_id = p_clinic_id
      AND lower(trim(hb.doctor_name)) = lower(trim(v_doctor))
  ) THEN
    RAISE EXCEPTION 'doctor_name: doctor is not registered for this clinic';
  END IF;

  v_phone := '+91' || v_phone_raw;

  SELECT COALESCE(c.name, hb.hospital_name)
    INTO v_clinic_name
  FROM public.clinics c
  LEFT JOIN public.hospital_boarding hb ON hb.clinic_id = c.id
  WHERE c.id = p_clinic_id
  ORDER BY hb.created_at
  LIMIT 1;

  SELECT dp.id
    INTO v_doctor_pid
  FROM public.doctor_profiles dp
  WHERE dp.clinic_id = p_clinic_id
    AND lower(trim(dp.doctor_name)) = lower(trim(v_doctor))
  ORDER BY dp.created_at DESC
  LIMIT 1;

  INSERT INTO public.patients (
    clinic_id, patient_code, name, phone, dob, sex, clinic_name, doctor_name,
    visit_date, follow_up_required, follow_up_date, status, message_count,
    admin_provisioned, notes, created_at, updated_at
  )
  VALUES (
    p_clinic_id,
    public.next_patient_code(p_clinic_id),
    v_name,
    v_phone,
    p_dob,
    p_sex,
    v_clinic_name,
    v_doctor,
    p_visit_date,
    'No',
    NULL,
    'pending',
    0,
    TRUE,
    v_notes,
    NOW(),
    NOW()
  )
  ON CONFLICT (clinic_id, phone) DO UPDATE SET
    name               = EXCLUDED.name,
    dob                = COALESCE(EXCLUDED.dob, public.patients.dob),
    sex                = COALESCE(EXCLUDED.sex, public.patients.sex),
    clinic_name        = EXCLUDED.clinic_name,
    doctor_name        = EXCLUDED.doctor_name,
    visit_date         = EXCLUDED.visit_date,
    follow_up_required = 'No',
    follow_up_date     = NULL,
    status             = 'pending',
    health_check_sent  = FALSE,
    reactivation_sent  = FALSE,
    admin_provisioned  = TRUE,
    notes              = v_notes,
    updated_at         = NOW()
  RETURNING id, patient_code INTO v_patient_id, v_patient_code;

  INSERT INTO public.patient_visits (
    clinic_id, patient_id, doctor_profile_id, patient_code, clinic_name, doctor_name,
    visit_date, visit_status, checked_in_at, admin_provisioned
  )
  VALUES (
    p_clinic_id, v_patient_id, v_doctor_pid, v_patient_code, v_clinic_name, v_doctor,
    p_visit_date, 'waiting', NOW(), TRUE
  )
  ON CONFLICT (patient_id, visit_date) WHERE visit_status NOT IN ('cancelled', 'no_show')
  DO UPDATE SET
    doctor_name       = EXCLUDED.doctor_name,
    doctor_profile_id = EXCLUDED.doctor_profile_id,
    clinic_name       = EXCLUDED.clinic_name,
    patient_code      = EXCLUDED.patient_code,
    checked_in_at     = NOW(),
    admin_provisioned = TRUE,
    updated_at        = NOW()
  RETURNING id INTO v_visit_id;

  INSERT INTO public.system_logs (workflow_name, log_level, message, details)
  VALUES (
    'admin-console',
    'INFO',
    'Admin provisioned test patient',
    jsonb_build_object(
      'clinic_id', p_clinic_id,
      'patient_id', v_patient_id,
      'patient_code', v_patient_code,
      'visit_id', v_visit_id,
      'admin_provisioned', TRUE
    )::text
  );

  RETURN jsonb_build_object(
    'status', 'success',
    'patient_id', v_patient_id,
    'patient_code', v_patient_code,
    'visit_id', v_visit_id,
    'admin_provisioned', TRUE
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- Admin: finalize doctor provisioning for an existing clinic (WF15 calls this)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_provision_doctor_to_clinic(
  p_admin_user_id              UUID,
  p_clinic_id                  UUID,
  p_auth_user_id               UUID,
  p_doctor_name                TEXT,
  p_doctor_expertise           TEXT,
  p_doctor_registration_number TEXT,
  p_login_username             TEXT,
  p_doctor_qualification       TEXT DEFAULT NULL,
  p_doctor_phone               TEXT DEFAULT NULL,
  p_doctor_signature_url       TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facility       RECORD;
  v_username       TEXT;
  v_boarding_id    UUID;
  v_profile_id     UUID;
  v_clinic_name    TEXT;
BEGIN
  IF NOT public.user_is_platform_admin(p_admin_user_id) THEN
    RAISE EXCEPTION 'not authorized to provision doctors';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clinics WHERE id = p_clinic_id) THEN
    RAISE EXCEPTION 'clinic not found';
  END IF;

  IF p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_user_id is required';
  END IF;

  v_username := lower(trim(COALESCE(p_login_username, '')));
  IF v_username !~ '^[a-z0-9._-]{3,80}$' THEN
    RAISE EXCEPTION 'login_username: invalid format';
  END IF;
  IF trim(COALESCE(p_doctor_name, '')) = '' OR char_length(trim(p_doctor_name)) < 2 THEN
    RAISE EXCEPTION 'doctor_name: required, minimum 2 characters';
  END IF;
  IF trim(COALESCE(p_doctor_expertise, '')) = '' OR char_length(trim(p_doctor_expertise)) < 2 THEN
    RAISE EXCEPTION 'doctor_expertise: required, minimum 2 characters';
  END IF;
  IF trim(COALESCE(p_doctor_registration_number, '')) = '' OR char_length(trim(p_doctor_registration_number)) < 2 THEN
    RAISE EXCEPTION 'doctor_registration_number: required, minimum 2 characters';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hospital_boarding hb
    WHERE hb.login_username = v_username AND hb.clinic_id IS DISTINCT FROM p_clinic_id
  ) OR EXISTS (
    SELECT 1 FROM public.doctor_profiles dp
    WHERE dp.login_username = v_username
  ) THEN
    RAISE EXCEPTION 'login_username: already in use';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hospital_boarding hb
    WHERE hb.clinic_id = p_clinic_id
      AND lower(trim(hb.doctor_registration_number)) = lower(trim(p_doctor_registration_number))
  ) THEN
    RAISE EXCEPTION 'doctor_registration_number: already registered for this clinic';
  END IF;

  SELECT c.name INTO v_clinic_name FROM public.clinics c WHERE c.id = p_clinic_id;

  SELECT
    hb.hospital_name,
    hb.facility_type,
    hb.address,
    hb.city,
    hb.contact_phone,
    hb.admin_contact_name,
    hb.clinic_logo_url,
    hb.clinic_email,
    hb.clinic_website,
    hb.consultation_hours
  INTO v_facility
  FROM public.hospital_boarding hb
  WHERE hb.clinic_id = p_clinic_id
  ORDER BY hb.created_at
  LIMIT 1;

  IF v_facility.hospital_name IS NULL THEN
    RAISE EXCEPTION 'clinic has no onboarding records — use hospital form first';
  END IF;

  INSERT INTO public.hospital_boarding (
    clinic_id, hospital_name, facility_type, address, city, contact_phone, admin_contact_name,
    clinic_logo_url, clinic_email, clinic_website,
    doctor_name, doctor_qualification, doctor_expertise, doctor_registration_number,
    doctor_phone, doctor_signature_url, consultation_hours,
    login_username, auth_user_id, admin_provisioned
  )
  VALUES (
    p_clinic_id,
    v_facility.hospital_name,
    v_facility.facility_type,
    v_facility.address,
    v_facility.city,
    v_facility.contact_phone,
    v_facility.admin_contact_name,
    v_facility.clinic_logo_url,
    v_facility.clinic_email,
    v_facility.clinic_website,
    trim(p_doctor_name),
    NULLIF(trim(COALESCE(p_doctor_qualification, '')), ''),
    trim(p_doctor_expertise),
    trim(p_doctor_registration_number),
    NULLIF(regexp_replace(trim(COALESCE(p_doctor_phone, '')), '\s+', '', 'g'), ''),
    NULLIF(trim(COALESCE(p_doctor_signature_url, '')), ''),
    v_facility.consultation_hours,
    v_username,
    p_auth_user_id,
    TRUE
  )
  RETURNING id INTO v_boarding_id;

  INSERT INTO public.doctor_profiles (
    clinic_id, user_id, doctor_name, clinic_name, registration_number,
    specialty, qualification, clinic_address, clinic_city, clinic_phone,
    clinic_email, clinic_website, clinic_logo_url, doctor_phone,
    login_username, signature_image_url, signature_label, stamp_label
  )
  VALUES (
    p_clinic_id,
    p_auth_user_id,
    trim(p_doctor_name),
    v_facility.hospital_name,
    trim(p_doctor_registration_number),
    trim(p_doctor_expertise),
    NULLIF(trim(COALESCE(p_doctor_qualification, '')), ''),
    v_facility.address,
    v_facility.city,
    v_facility.contact_phone,
    v_facility.clinic_email,
    v_facility.clinic_website,
    v_facility.clinic_logo_url,
    NULLIF(regexp_replace(trim(COALESCE(p_doctor_phone, '')), '\s+', '', 'g'), ''),
    v_username,
    NULLIF(trim(COALESCE(p_doctor_signature_url, '')), ''),
    trim(p_doctor_name),
    trim(p_doctor_registration_number)
  )
  ON CONFLICT (user_id) DO UPDATE SET
    clinic_id           = EXCLUDED.clinic_id,
    doctor_name         = EXCLUDED.doctor_name,
    clinic_name         = EXCLUDED.clinic_name,
    registration_number = EXCLUDED.registration_number,
    specialty           = EXCLUDED.specialty,
    qualification       = EXCLUDED.qualification,
    clinic_address      = EXCLUDED.clinic_address,
    clinic_city         = EXCLUDED.clinic_city,
    clinic_phone        = EXCLUDED.clinic_phone,
    clinic_email        = EXCLUDED.clinic_email,
    clinic_website      = EXCLUDED.clinic_website,
    clinic_logo_url     = EXCLUDED.clinic_logo_url,
    doctor_phone        = EXCLUDED.doctor_phone,
    login_username      = EXCLUDED.login_username,
    signature_image_url = EXCLUDED.signature_image_url,
    signature_label     = EXCLUDED.signature_label,
    stamp_label         = EXCLUDED.stamp_label,
    updated_at          = NOW()
  RETURNING id INTO v_profile_id;

  INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
  VALUES (p_clinic_id, p_auth_user_id, v_profile_id, 'doctor', 'active')
  ON CONFLICT (clinic_id, user_id, role) DO UPDATE
    SET doctor_profile_id = EXCLUDED.doctor_profile_id,
        status = 'active',
        updated_at = NOW();

  INSERT INTO public.system_logs (workflow_name, log_level, message, details)
  VALUES (
    'workflow-15-admin-add-doctor',
    'INFO',
    'Admin provisioned test doctor',
    jsonb_build_object(
      'clinic_id', p_clinic_id,
      'boarding_id', v_boarding_id,
      'doctor_profile_id', v_profile_id,
      'login_username', v_username,
      'admin_user_id', p_admin_user_id,
      'admin_provisioned', TRUE
    )::text
  );

  RETURN jsonb_build_object(
    'status', 'success',
    'boarding_id', v_boarding_id,
    'doctor_profile_id', v_profile_id,
    'login_username', v_username,
    'doctor_name', trim(p_doctor_name),
    'clinic_id', p_clinic_id,
    'admin_provisioned', TRUE
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_add_patient_to_clinic(UUID, TEXT, TEXT, TEXT, DATE, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_provision_doctor_to_clinic(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Extend clinic details: surface admin_provisioned on doctors
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
    'admin_settings', COALESCE((
      SELECT to_jsonb(acs) FROM public.platform_clinic_admin_settings acs
      WHERE acs.clinic_id = c.id
    ), jsonb_build_object(
      'lifecycle_status', 'active',
      'payment_status', 'not_started',
      'plan_label', 'Manual'
    )),
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
               COALESCE(hb.admin_provisioned, FALSE) AS admin_provisioned,
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
      'real_patient_count', (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id AND COALESCE(p.is_demo, FALSE) = FALSE),
      'provisioned_patient_count', (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id AND p.admin_provisioned),
      'total_visits',       (SELECT COUNT(*) FROM public.patient_visits pv WHERE pv.clinic_id = c.id),
      'visits_today',       (SELECT COUNT(*) FROM public.patient_visits pv WHERE pv.clinic_id = c.id AND pv.visit_date = CURRENT_DATE),
      'visits_7d',          (SELECT COUNT(*) FROM public.patient_visits pv WHERE pv.clinic_id = c.id AND pv.visit_date >= CURRENT_DATE - 6),
      'patients_7d',        (SELECT COUNT(*) FROM public.patients p WHERE p.clinic_id = c.id AND p.created_at >= NOW() - INTERVAL '7 days'),
      'last_visit_at',      (SELECT MAX(pv.checked_in_at) FROM public.patient_visits pv WHERE pv.clinic_id = c.id),
      'prescriptions',      (SELECT COUNT(*) FROM public.prescriptions pr WHERE pr.clinic_id = c.id),
      'active_tokens',      (SELECT COUNT(*) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id AND t.status = 'active' AND (t.expires_at IS NULL OR t.expires_at > NOW())),
      'total_token_uses',   (SELECT COALESCE(SUM(t.use_count), 0) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id),
      'last_token_used_at', (SELECT MAX(t.last_used_at) FROM public.clinic_intake_tokens t WHERE t.clinic_id = c.id)
    ),
    'messaging', jsonb_build_object(
      'sent_24h',       (SELECT COUNT(*) FROM public.message_logs ml WHERE ml.clinic_id = c.id AND ml.sent_at >= NOW() - INTERVAL '24 hours'),
      'failed_24h',     (SELECT COUNT(*) FROM public.message_logs ml WHERE ml.clinic_id = c.id AND ml.sent_at >= NOW() - INTERVAL '24 hours' AND ml.delivery_status IN ('failed','undelivered')),
      'sent_7d',        (SELECT COUNT(*) FROM public.message_logs ml WHERE ml.clinic_id = c.id AND ml.sent_at >= NOW() - INTERVAL '7 days'),
      'failed_7d',      (SELECT COUNT(*) FROM public.message_logs ml WHERE ml.clinic_id = c.id AND ml.sent_at >= NOW() - INTERVAL '7 days' AND ml.delivery_status IN ('failed','undelivered')),
      'last_sent_at',   (SELECT MAX(ml.sent_at) FROM public.message_logs ml WHERE ml.clinic_id = c.id)
    ),
    'health_issues', COALESCE((
      SELECT jsonb_agg(issue ORDER BY (issue->>'severity_rank')::int DESC)
      FROM (
        SELECT jsonb_build_object(
          'severity', 'critical', 'severity_rank', 3, 'code', 'no_active_qr',
          'message', 'No active intake QR — patients cannot self-register via scan'
        ) AS issue
        WHERE NOT EXISTS (
          SELECT 1 FROM public.clinic_intake_tokens t
          WHERE t.clinic_id = c.id AND t.status = 'active'
            AND (t.expires_at IS NULL OR t.expires_at > NOW())
        )
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'high', 'severity_rank', 2, 'code', 'missing_doctor_whatsapp',
          'message', 'Doctor missing WhatsApp phone — dashboard login unavailable'
        )
        WHERE EXISTS (
          SELECT 1 FROM public.hospital_boarding hb
          WHERE hb.clinic_id = c.id
            AND public.normalized_whatsapp_phone(hb.doctor_phone) IS NULL
        )
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'high', 'severity_rank', 2, 'code', 'doctor_not_signed_in',
          'message', 'Doctor account created but has not signed in yet'
        )
        WHERE EXISTS (
          SELECT 1 FROM public.hospital_boarding hb
          WHERE hb.clinic_id = c.id AND hb.auth_user_id IS NULL
        )
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'high', 'severity_rank', 2, 'code', 'payment_overdue',
          'message', 'Payment overdue or failed — manual follow-up required'
        )
        WHERE EXISTS (
          SELECT 1 FROM public.platform_clinic_admin_settings acs
          WHERE acs.clinic_id = c.id
            AND acs.payment_status IN ('overdue','payment_failed')
        )
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'warning', 'severity_rank', 1, 'code', 'payment_due',
          'message', 'Payment due or past due date'
        )
        WHERE EXISTS (
          SELECT 1 FROM public.platform_clinic_admin_settings acs
          WHERE acs.clinic_id = c.id
            AND (
              acs.payment_status = 'due'
              OR (acs.payment_due_date IS NOT NULL AND acs.payment_due_date < CURRENT_DATE AND acs.payment_status <> 'paid')
            )
        )
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'warning', 'severity_rank', 1, 'code', 'lifecycle_restricted',
          'message', 'Account lifecycle is ' || COALESCE(acs.lifecycle_status, 'active') || ' — may be limited'
        )
        FROM public.platform_clinic_admin_settings acs
        WHERE acs.clinic_id = c.id
          AND acs.lifecycle_status IN ('onboarding','paused','suspended')
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'warning', 'severity_rank', 1, 'code', 'no_recent_visits',
          'message', 'No patient visits in the last 14 days — clinic may be idle'
        )
        WHERE NOT EXISTS (
          SELECT 1 FROM public.patient_visits pv
          WHERE pv.clinic_id = c.id AND pv.visit_date >= CURRENT_DATE - 13
        )
        AND EXISTS (SELECT 1 FROM public.patients p WHERE p.clinic_id = c.id AND COALESCE(p.is_demo, FALSE) = FALSE)
        UNION ALL
        SELECT jsonb_build_object(
          'severity', 'warning', 'severity_rank', 1, 'code', 'message_failures_7d',
          'message', 'WhatsApp delivery failures in the last 7 days'
        )
        WHERE EXISTS (
          SELECT 1 FROM public.message_logs ml
          WHERE ml.clinic_id = c.id
            AND ml.sent_at >= NOW() - INTERVAL '7 days'
            AND ml.delivery_status IN ('failed','undelivered')
        )
      ) issues
    ), '[]'::jsonb),
    'recent_errors', COALESCE((
      SELECT jsonb_agg(e ORDER BY e.timestamp DESC)
      FROM (
        SELECT sl.timestamp, sl.workflow_name, sl.log_level, sl.message
        FROM public.system_logs sl
        WHERE sl.clinic_id = c.id AND sl.log_level IN ('ERROR','WARN')
        ORDER BY sl.timestamp DESC
        LIMIT 8
      ) e
    ), '[]'::jsonb),
    'recent_message_failures', COALESCE((
      SELECT jsonb_agg(m ORDER BY m.sent_at DESC)
      FROM (
        SELECT ml.sent_at, ml.workflow_name, ml.patient_name, ml.phone, ml.delivery_status, ml.error_message
        FROM public.message_logs ml
        WHERE ml.clinic_id = c.id AND ml.delivery_status IN ('failed','undelivered')
        ORDER BY ml.sent_at DESC
        LIMIT 8
      ) m
    ), '[]'::jsonb)
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
