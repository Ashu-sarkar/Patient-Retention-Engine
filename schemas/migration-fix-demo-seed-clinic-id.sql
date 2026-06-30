-- =============================================================================
-- Hotfix: demo seed fails on prescription_medicines.clinic_id NOT NULL
--
-- Root cause:
--   1. migration-v0-multitenant made prescription_medicines.clinic_id NOT NULL
--   2. admin_seed_dummy_patients inserted medicines without clinic_id
--   3. enforce_clinic_consistency did not auto-fill NULL clinic_id (NULL <> uuid
--      is unknown, so the trigger passed and NOT NULL failed)
--
-- Safe to run repeatedly. Paste into Supabase SQL editor, then retry Demo Seed.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_clinic_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_clinic UUID;
BEGIN
  IF TG_TABLE_NAME = 'patient_visits' THEN
    SELECT clinic_id INTO parent_clinic FROM public.patients WHERE id = NEW.patient_id;
    IF parent_clinic IS NULL THEN
      RAISE EXCEPTION 'patient_visits.patient_id is invalid';
    END IF;
    IF NEW.clinic_id IS NULL THEN
      NEW.clinic_id := parent_clinic;
    ELSIF parent_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'patient_visits.clinic_id must match patients.clinic_id';
    END IF;
  ELSIF TG_TABLE_NAME = 'prescriptions' THEN
    SELECT clinic_id INTO parent_clinic FROM public.patients WHERE id = NEW.patient_id;
    IF parent_clinic IS NULL THEN
      RAISE EXCEPTION 'prescriptions.patient_id is invalid';
    END IF;
    IF NEW.clinic_id IS NULL THEN
      NEW.clinic_id := parent_clinic;
    ELSIF parent_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'prescriptions.clinic_id must match patients.clinic_id';
    END IF;
    IF NEW.visit_id IS NOT NULL THEN
      SELECT clinic_id INTO parent_clinic FROM public.patient_visits WHERE id = NEW.visit_id;
      IF parent_clinic IS NULL THEN
        RAISE EXCEPTION 'prescriptions.visit_id is invalid';
      END IF;
      IF NEW.clinic_id IS DISTINCT FROM parent_clinic THEN
        RAISE EXCEPTION 'prescriptions.clinic_id must match patient_visits.clinic_id';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'prescription_medicines' THEN
    SELECT clinic_id INTO parent_clinic FROM public.prescriptions WHERE id = NEW.prescription_id;
    IF parent_clinic IS NULL THEN
      RAISE EXCEPTION 'prescription_medicines.prescription_id is invalid';
    END IF;
    IF NEW.clinic_id IS NULL THEN
      NEW.clinic_id := parent_clinic;
    ELSIF parent_clinic <> NEW.clinic_id THEN
      RAISE EXCEPTION 'prescription_medicines.clinic_id must match prescriptions.clinic_id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

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

  SELECT COUNT(*) INTO v_base FROM public.patients WHERE clinic_id = p_clinic_id AND is_demo;

  FOR i IN 1..v_count LOOP
    v_name  := first_names[1 + ((v_base + i) % array_length(first_names, 1))]
               || ' ' || last_names[1 + ((v_base + i) % array_length(last_names, 1))];
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
        (prescription_id, clinic_id, medicine_name, dosage, frequency, timing, duration, instructions, sort_order)
      VALUES
        (v_rx_id, p_clinic_id, 'Paracetamol 500mg', '1 tablet', 'Twice daily', 'After food', '3 days', 'For fever', 1),
        (v_rx_id, p_clinic_id, 'Cetirizine 10mg', '1 tablet', 'Once daily', 'At night', '5 days', 'For allergy', 2);
    END IF;

    v_seeded := v_seeded + 1;
  END LOOP;

  RETURN QUERY SELECT v_seeded;
END;
$$;

NOTIFY pgrst, 'reload schema';
