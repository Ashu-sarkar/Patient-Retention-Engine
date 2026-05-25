-- Allow doctors to see queue visits for any hospital_boarding row tied to their
-- verified WhatsApp phone (not only the single clinic on doctor_profiles).

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

-- Prefer boarding row with the most recent matching visit when bootstrapping profile.
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

NOTIFY pgrst, 'reload schema';
