-- Fix prescription workflow RLS failures in the doctor dashboard.
--
-- Root causes addressed:
--   1. Doctors could read/update visits (boarding-match policies) without an active
--      clinic_memberships row, while prescriptions still require membership.
--   2. get_or_create_doctor_profile_for_current_user() sometimes returned a profile
--      without syncing memberships (regression in migration-doctor-queue-boarding-match).
--   3. Storage policy expected path "{auth.uid()}/..." but the dashboard uploads
--      "{clinic_id}/{auth.uid()}/{prescription_id}.pdf".

CREATE OR REPLACE FUNCTION public.sync_clinic_memberships_for_doctor_profile(
  p_profile public.doctor_profiles
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_profile.id IS NULL THEN
    RETURN;
  END IF;

  IF p_profile.clinic_id IS NOT NULL THEN
    INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
    VALUES (p_profile.clinic_id, auth.uid(), p_profile.id, 'doctor', 'active')
    ON CONFLICT (clinic_id, user_id, role) DO UPDATE
      SET doctor_profile_id = EXCLUDED.doctor_profile_id,
          status = 'active',
          updated_at = NOW();

    IF COALESCE(p_profile.is_clinic_admin, FALSE) THEN
      INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
      VALUES (p_profile.clinic_id, auth.uid(), p_profile.id, 'clinic_admin', 'active')
      ON CONFLICT (clinic_id, user_id, role) DO UPDATE
        SET doctor_profile_id = EXCLUDED.doctor_profile_id,
            status = 'active',
            updated_at = NOW();
    END IF;
  END IF;

  INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
  SELECT DISTINCT
    hb.clinic_id,
    auth.uid(),
    p_profile.id,
    'doctor',
    'active'
  FROM public.hospital_boarding hb
  WHERE hb.clinic_id IS NOT NULL
    AND hb.auth_user_id = auth.uid()
  ON CONFLICT (clinic_id, user_id, role) DO UPDATE
    SET doctor_profile_id = EXCLUDED.doctor_profile_id,
        status = 'active',
        updated_at = NOW();
END;
$$;

GRANT EXECUTE ON FUNCTION public.sync_clinic_memberships_for_doctor_profile(public.doctor_profiles) TO authenticated;

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
      OR (
        verified_phone IS NOT NULL
        AND public.normalized_whatsapp_phone(dp.doctor_phone) = verified_phone
      )
   ORDER BY (dp.user_id = auth.uid()) DESC, dp.updated_at DESC
   LIMIT 1;

  IF FOUND THEN
    IF profile.user_id IS NULL OR profile.user_id IS DISTINCT FROM auth.uid() THEN
      UPDATE public.doctor_profiles
         SET user_id = auth.uid(),
             doctor_phone = COALESCE(doctor_phone, verified_phone),
             updated_at = NOW()
       WHERE id = profile.id
       RETURNING * INTO profile;
    END IF;

    PERFORM public.sync_clinic_memberships_for_doctor_profile(profile);
    RETURN profile;
  END IF;

  SELECT hb.*
    INTO boarding
    FROM public.hospital_boarding hb
   WHERE hb.auth_user_id = auth.uid()
      OR (
        verified_phone IS NOT NULL
        AND public.normalized_whatsapp_phone(hb.doctor_phone) = verified_phone
      )
   ORDER BY (hb.auth_user_id = auth.uid()) DESC, hb.created_at DESC
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
    COALESCE(boarding.doctor_phone, verified_phone),
    boarding.login_username,
    boarding.doctor_signature_url,
    boarding.doctor_name,
    COALESCE(NULLIF(boarding.doctor_registration_number, ''), 'Registration pending')
  )
  RETURNING * INTO profile;

  PERFORM public.sync_clinic_memberships_for_doctor_profile(profile);
  RETURN profile;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_doctor_profile_for_current_user() TO authenticated;

-- Backfill memberships for existing doctors (safe/idempotent).
INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
SELECT dp.clinic_id, dp.user_id, dp.id, 'doctor', 'active'
FROM public.doctor_profiles dp
WHERE dp.user_id IS NOT NULL
  AND dp.clinic_id IS NOT NULL
ON CONFLICT (clinic_id, user_id, role) DO UPDATE
  SET doctor_profile_id = EXCLUDED.doctor_profile_id,
      status = 'active',
      updated_at = NOW();

INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
SELECT dp.clinic_id, dp.user_id, dp.id, 'clinic_admin', 'active'
FROM public.doctor_profiles dp
WHERE dp.user_id IS NOT NULL
  AND dp.clinic_id IS NOT NULL
  AND dp.is_clinic_admin = TRUE
ON CONFLICT (clinic_id, user_id, role) DO UPDATE
  SET doctor_profile_id = EXCLUDED.doctor_profile_id,
      status = 'active',
      updated_at = NOW();

INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
SELECT DISTINCT
  hb.clinic_id,
  hb.auth_user_id,
  dp.id,
  'doctor',
  'active'
FROM public.hospital_boarding hb
JOIN public.doctor_profiles dp
  ON dp.user_id = hb.auth_user_id
WHERE hb.auth_user_id IS NOT NULL
  AND hb.clinic_id IS NOT NULL
ON CONFLICT (clinic_id, user_id, role) DO UPDATE
  SET doctor_profile_id = EXCLUDED.doctor_profile_id,
      status = 'active',
      updated_at = NOW();

-- Align storage RLS with the dashboard upload path.
-- Dashboard uploads to: {clinic_id}/{auth.uid()}/{prescription_id}.pdf
-- Older files on existing instances used: {auth.uid()}/{prescription_id}.pdf
-- The new policy accepts BOTH formats so no stored files become inaccessible.
DROP POLICY IF EXISTS "doctors manage prescription pdfs" ON storage.objects;
DROP POLICY IF EXISTS "members manage clinic prescription pdfs" ON storage.objects;
CREATE POLICY "members manage clinic prescription pdfs"
  ON storage.objects FOR ALL
  TO authenticated
  USING (
    bucket_id = 'prescriptions'
    AND (
      -- Old format: {user_id}/{prescription_id}.pdf
      (storage.foldername(name))[1] = auth.uid()::text
      OR (
        -- New format: {clinic_id}/{user_id}/{prescription_id}.pdf
        (storage.foldername(name))[2] = auth.uid()::text
        AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
      )
    )
  )
  WITH CHECK (
    bucket_id = 'prescriptions'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR (
        (storage.foldername(name))[2] = auth.uid()::text
        AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
      )
    )
  );

NOTIFY pgrst, 'reload schema';
