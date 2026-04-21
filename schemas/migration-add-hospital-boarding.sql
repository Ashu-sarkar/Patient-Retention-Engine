-- =============================================================================
-- Migration: add public.hospital_boarding (Hospital / clinic onboarding)
-- Run in Supabase SQL Editor if your project already had the base schema applied
-- before this table existed. Safe to run once; uses IF NOT EXISTS where possible.
-- =============================================================================

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

ALTER TABLE public.hospital_boarding
  ADD COLUMN IF NOT EXISTS facility_type TEXT;

UPDATE public.hospital_boarding
SET facility_type = 'Unspecified'
WHERE facility_type IS NULL;

ALTER TABLE public.hospital_boarding
  ALTER COLUMN facility_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'hospital_boarding_facility_type_check'
      AND conrelid = 'public.hospital_boarding'::regclass
  ) THEN
    ALTER TABLE public.hospital_boarding
      ADD CONSTRAINT hospital_boarding_facility_type_check
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
      ));
  END IF;
END $$;

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

ALTER TABLE public.hospital_boarding ENABLE ROW LEVEL SECURITY;
