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

-- Profile bootstrap lives in migration-v0-multitenant.sql and
-- migration-prescription-access-fix.sql (membership sync). Do not redefine
-- get_or_create_doctor_profile_for_current_user() here — an older version
-- dropped clinic_memberships sync and caused prescription RLS failures.

NOTIFY pgrst, 'reload schema';
