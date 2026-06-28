-- =============================================================================
-- Migration: Doctor Analytics Dashboard
--
-- Depends on migration-v0-multitenant.sql and migration-admin-console.sql.
-- Adds doctor-scoped analytics RPCs, follow-up view, and daily rollup table.
-- Safe to run repeatedly.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- Access control
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_user_can_view_clinic_analytics(p_clinic_id UUID)
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
          AND cm.role IN ('doctor', 'clinic_admin', 'staff', 'super_admin')
     );
$$;

CREATE OR REPLACE FUNCTION public.doctor_analytics_effective_doctor_id(
  p_clinic_id UUID,
  p_requested_doctor_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.doctor_profiles%ROWTYPE;
BEGIN
  SELECT dp.*
    INTO v_profile
    FROM public.doctor_profiles dp
   WHERE dp.user_id = auth.uid()
     AND dp.clinic_id = p_clinic_id
   ORDER BY dp.updated_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF COALESCE(v_profile.is_clinic_admin, FALSE) THEN
    RETURN p_requested_doctor_id;
  END IF;

  RETURN v_profile.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.doctor_analytics_assert_access(p_clinic_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_can_view_clinic_analytics(p_clinic_id) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Follow-up analytics view
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_follow_up_analytics AS
SELECT
  p.id AS patient_id,
  p.clinic_id,
  p.patient_code,
  p.name,
  p.phone,
  p.follow_up_required,
  p.follow_up_date,
  p.status AS patient_status,
  COALESCE(p.is_demo, FALSE) AS is_demo,
  p.response_status,
  (
    SELECT pr.doctor_profile_id
      FROM public.prescriptions pr
     WHERE pr.patient_id = p.id
       AND pr.clinic_id = p.clinic_id
     ORDER BY pr.created_at DESC
     LIMIT 1
  ) AS doctor_profile_id,
  CASE
    WHEN p.follow_up_required = 'Yes'
         AND p.follow_up_date IS NOT NULL
         AND p.follow_up_date < CURRENT_DATE
         AND p.status IN ('pending', 'missed')
         AND NOT EXISTS (
           SELECT 1
             FROM public.patient_visits pv
            WHERE pv.patient_id = p.id
              AND pv.clinic_id = p.clinic_id
              AND pv.visit_status NOT IN ('cancelled', 'no_show')
              AND pv.visit_date >= p.follow_up_date
         ) THEN 'overdue'
    WHEN p.follow_up_required = 'Yes'
         AND p.follow_up_date = CURRENT_DATE THEN 'due_today'
    WHEN p.follow_up_required = 'Yes'
         AND p.follow_up_date > CURRENT_DATE THEN 'upcoming'
    ELSE 'none'
  END AS follow_up_bucket
FROM public.patients p
WHERE p.follow_up_required = 'Yes';

-- -----------------------------------------------------------------------------
-- Daily rollup table (Phase 2 population; schema ready for MVP)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clinic_daily_analytics (
  clinic_id           UUID NOT NULL REFERENCES public.clinics (id) ON DELETE CASCADE,
  doctor_profile_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  metric_date         DATE NOT NULL,
  visits_total        INT NOT NULL DEFAULT 0,
  visits_completed    INT NOT NULL DEFAULT 0,
  visits_new_patients INT NOT NULL DEFAULT 0,
  visits_returning    INT NOT NULL DEFAULT 0,
  followups_scheduled INT NOT NULL DEFAULT 0,
  followups_completed INT NOT NULL DEFAULT 0,
  followups_overdue   INT NOT NULL DEFAULT 0,
  is_demo_included    BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (clinic_id, metric_date, doctor_profile_id, is_demo_included)
);

CREATE INDEX IF NOT EXISTS idx_clinic_daily_analytics_lookup
  ON public.clinic_daily_analytics (clinic_id, metric_date DESC, doctor_profile_id);

ALTER TABLE public.clinic_daily_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "doctors read clinic daily analytics" ON public.clinic_daily_analytics;
CREATE POLICY "doctors read clinic daily analytics"
  ON public.clinic_daily_analytics FOR SELECT
  TO authenticated
  USING (public.current_user_can_view_clinic_analytics(clinic_id));

-- -----------------------------------------------------------------------------
-- Nightly rollup refresh (Phase 2 — callable by n8n cron)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_clinic_daily_analytics(p_metric_date DATE DEFAULT CURRENT_DATE - 1)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clinic public.clinics%ROWTYPE;
  v_doctor public.doctor_profiles%ROWTYPE;
  v_sentinel UUID := '00000000-0000-0000-0000-000000000000'::uuid;
BEGIN
  FOR v_clinic IN SELECT * FROM public.clinics WHERE status = 'active' LOOP
    -- Clinic-wide rollup (real patients only)
    INSERT INTO public.clinic_daily_analytics (
      clinic_id, doctor_profile_id, metric_date, is_demo_included,
      visits_total, visits_completed, visits_new_patients, visits_returning,
      followups_scheduled, followups_completed, followups_overdue, computed_at
    )
    SELECT
      v_clinic.id,
      v_sentinel,
      p_metric_date,
      FALSE,
      COUNT(*) FILTER (WHERE pv.visit_status NOT IN ('cancelled', 'no_show')),
      COUNT(*) FILTER (WHERE pv.visit_status = 'completed'),
      COUNT(*) FILTER (
        WHERE pv.visit_status NOT IN ('cancelled', 'no_show')
          AND NOT EXISTS (
            SELECT 1 FROM public.patient_visits pv2
             WHERE pv2.clinic_id = pv.clinic_id
               AND pv2.patient_id = pv.patient_id
               AND pv2.visit_status NOT IN ('cancelled', 'no_show')
               AND pv2.visit_date < pv.visit_date
          )
      ),
      COUNT(*) FILTER (
        WHERE pv.visit_status NOT IN ('cancelled', 'no_show')
          AND EXISTS (
            SELECT 1 FROM public.patient_visits pv2
             WHERE pv2.clinic_id = pv.clinic_id
               AND pv2.patient_id = pv.patient_id
               AND pv2.visit_status NOT IN ('cancelled', 'no_show')
               AND pv2.visit_date < pv.visit_date
          )
      ),
      (
        SELECT COUNT(*)
          FROM public.patients p
         WHERE p.clinic_id = v_clinic.id
           AND COALESCE(p.is_demo, FALSE) = FALSE
           AND p.follow_up_required = 'Yes'
           AND p.follow_up_date = p_metric_date
      ),
      (
        SELECT COUNT(*)
          FROM public.patients p
         WHERE p.clinic_id = v_clinic.id
           AND COALESCE(p.is_demo, FALSE) = FALSE
           AND p.follow_up_required = 'Yes'
           AND p.follow_up_date = p_metric_date
           AND EXISTS (
             SELECT 1 FROM public.patient_visits pv3
              WHERE pv3.patient_id = p.id
                AND pv3.clinic_id = p.clinic_id
                AND pv3.visit_status NOT IN ('cancelled', 'no_show')
                AND pv3.visit_date >= p.follow_up_date
                AND pv3.visit_date <= p.follow_up_date + 14
           )
      ),
      (
        SELECT COUNT(*)
          FROM public.patients p
         WHERE p.clinic_id = v_clinic.id
           AND COALESCE(p.is_demo, FALSE) = FALSE
           AND p.follow_up_required = 'Yes'
           AND p.follow_up_date = p_metric_date
           AND p.follow_up_date < CURRENT_DATE
           AND p.status IN ('pending', 'missed')
           AND NOT EXISTS (
             SELECT 1 FROM public.patient_visits pv4
              WHERE pv4.patient_id = p.id
                AND pv4.clinic_id = p.clinic_id
                AND pv4.visit_status NOT IN ('cancelled', 'no_show')
                AND pv4.visit_date >= p.follow_up_date
           )
      ),
      NOW()
    FROM public.patient_visits pv
    JOIN public.patients pt ON pt.id = pv.patient_id
   WHERE pv.clinic_id = v_clinic.id
     AND pv.visit_date = p_metric_date
     AND COALESCE(pt.is_demo, FALSE) = FALSE
    ON CONFLICT (clinic_id, metric_date, doctor_profile_id, is_demo_included)
    DO UPDATE SET
      visits_total = EXCLUDED.visits_total,
      visits_completed = EXCLUDED.visits_completed,
      visits_new_patients = EXCLUDED.visits_new_patients,
      visits_returning = EXCLUDED.visits_returning,
      followups_scheduled = EXCLUDED.followups_scheduled,
      followups_completed = EXCLUDED.followups_completed,
      followups_overdue = EXCLUDED.followups_overdue,
      computed_at = NOW();

    -- Per-doctor rollups
    FOR v_doctor IN
      SELECT * FROM public.doctor_profiles dp WHERE dp.clinic_id = v_clinic.id
    LOOP
      INSERT INTO public.clinic_daily_analytics (
        clinic_id, doctor_profile_id, metric_date, is_demo_included,
        visits_total, visits_completed, visits_new_patients, visits_returning,
        followups_scheduled, followups_completed, followups_overdue, computed_at
      )
      SELECT
        v_clinic.id,
        v_doctor.id,
        p_metric_date,
        FALSE,
        COUNT(*) FILTER (WHERE pv.visit_status NOT IN ('cancelled', 'no_show')),
        COUNT(*) FILTER (WHERE pv.visit_status = 'completed'),
        COUNT(*) FILTER (
          WHERE pv.visit_status NOT IN ('cancelled', 'no_show')
            AND NOT EXISTS (
              SELECT 1 FROM public.patient_visits pv2
               WHERE pv2.clinic_id = pv.clinic_id
                 AND pv2.patient_id = pv.patient_id
                 AND pv2.visit_status NOT IN ('cancelled', 'no_show')
                 AND pv2.visit_date < pv.visit_date
            )
        ),
        COUNT(*) FILTER (
          WHERE pv.visit_status NOT IN ('cancelled', 'no_show')
            AND EXISTS (
              SELECT 1 FROM public.patient_visits pv2
               WHERE pv2.clinic_id = pv.clinic_id
                 AND pv2.patient_id = pv.patient_id
                 AND pv2.visit_status NOT IN ('cancelled', 'no_show')
                 AND pv2.visit_date < pv.visit_date
            )
        ),
        0, 0, 0,
        NOW()
      FROM public.patient_visits pv
      JOIN public.patients pt ON pt.id = pv.patient_id
     WHERE pv.clinic_id = v_clinic.id
       AND pv.doctor_profile_id = v_doctor.id
       AND pv.visit_date = p_metric_date
       AND COALESCE(pt.is_demo, FALSE) = FALSE
      ON CONFLICT (clinic_id, metric_date, doctor_profile_id, is_demo_included)
      DO UPDATE SET
        visits_total = EXCLUDED.visits_total,
        visits_completed = EXCLUDED.visits_completed,
        visits_new_patients = EXCLUDED.visits_new_patients,
        visits_returning = EXCLUDED.visits_returning,
        computed_at = NOW();
    END LOOP;
  END LOOP;
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_list_clinic_doctors
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_list_clinic_doctors(UUID);
CREATE OR REPLACE FUNCTION public.doctor_list_clinic_doctors(p_clinic_id UUID)
RETURNS TABLE(
  doctor_profile_id UUID,
  doctor_name TEXT,
  is_clinic_admin BOOLEAN,
  is_self BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_self UUID;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);

  SELECT dp.id INTO v_self
    FROM public.doctor_profiles dp
   WHERE dp.user_id = auth.uid()
     AND dp.clinic_id = p_clinic_id
   ORDER BY dp.updated_at DESC
   LIMIT 1;

  RETURN QUERY
  SELECT
    dp.id,
    dp.doctor_name,
    COALESCE(dp.is_clinic_admin, FALSE),
    dp.id = v_self
  FROM public.doctor_profiles dp
  WHERE dp.clinic_id = p_clinic_id
  ORDER BY dp.doctor_name;
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_analytics_overview
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_analytics_overview(UUID, DATE, DATE, UUID, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION public.doctor_get_analytics_overview(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_patient_type TEXT DEFAULT 'all',
  p_include_demo BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_week_start DATE := date_trunc('week', CURRENT_DATE)::date;
  v_month_start DATE := date_trunc('month', CURRENT_DATE)::date;
  v_patients_today BIGINT;
  v_patients_week BIGINT;
  v_patients_month BIGINT;
  v_followups_today BIGINT;
  v_followups_week BIGINT;
  v_followups_month BIGINT;
  v_new_count BIGINT;
  v_returning_count BIGINT;
  v_followups_due BIGINT;
  v_followups_completed BIGINT;
  v_overdue BIGINT;
  v_retention NUMERIC;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);

  IF p_to_date < p_from_date THEN
    RAISE EXCEPTION 'invalid date range';
  END IF;
  IF p_to_date - p_from_date > 730 THEN
    RAISE EXCEPTION 'date range too wide (max 24 months)';
  END IF;

  WITH filtered_visits AS (
    SELECT pv.*
      FROM public.patient_visits pv
      JOIN public.patients p ON p.id = pv.patient_id
     WHERE pv.clinic_id = p_clinic_id
       AND pv.visit_status NOT IN ('cancelled', 'no_show')
       AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
       AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
       AND (
         p_patient_type = 'all'
         OR (p_patient_type = 'new' AND NOT EXISTS (
           SELECT 1 FROM public.patient_visits pv2
            WHERE pv2.clinic_id = pv.clinic_id
              AND pv2.patient_id = pv.patient_id
              AND pv2.visit_status NOT IN ('cancelled', 'no_show')
              AND pv2.visit_date < pv.visit_date
         ))
         OR (p_patient_type = 'returning' AND EXISTS (
           SELECT 1 FROM public.patient_visits pv2
            WHERE pv2.clinic_id = pv.clinic_id
              AND pv2.patient_id = pv.patient_id
              AND pv2.visit_status NOT IN ('cancelled', 'no_show')
              AND pv2.visit_date < pv.visit_date
         ))
       )
  )
  SELECT
    COUNT(*) FILTER (WHERE visit_date = CURRENT_DATE),
    COUNT(*) FILTER (WHERE visit_date >= v_week_start),
    COUNT(*) FILTER (WHERE visit_date >= v_month_start)
  INTO v_patients_today, v_patients_week, v_patients_month
  FROM filtered_visits;

  SELECT
    COUNT(*) FILTER (WHERE follow_up_date = CURRENT_DATE),
    COUNT(*) FILTER (WHERE follow_up_date >= v_week_start),
    COUNT(*) FILTER (WHERE follow_up_date >= v_month_start)
  INTO v_followups_today, v_followups_week, v_followups_month
  FROM public.v_follow_up_analytics v
  WHERE v.clinic_id = p_clinic_id
    AND (p_include_demo OR NOT v.is_demo)
    AND (v_doctor IS NULL OR v.doctor_profile_id = v_doctor);

  WITH period_visits AS (
    SELECT pv.*
      FROM public.patient_visits pv
      JOIN public.patients p ON p.id = pv.patient_id
     WHERE pv.clinic_id = p_clinic_id
       AND pv.visit_date BETWEEN p_from_date AND p_to_date
       AND pv.visit_status NOT IN ('cancelled', 'no_show')
       AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
       AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
  )
  SELECT
    COUNT(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM public.patient_visits pv2
       WHERE pv2.clinic_id = period_visits.clinic_id
         AND pv2.patient_id = period_visits.patient_id
         AND pv2.visit_status NOT IN ('cancelled', 'no_show')
         AND pv2.visit_date < period_visits.visit_date
    )),
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.patient_visits pv2
       WHERE pv2.clinic_id = period_visits.clinic_id
         AND pv2.patient_id = period_visits.patient_id
         AND pv2.visit_status NOT IN ('cancelled', 'no_show')
         AND pv2.visit_date < period_visits.visit_date
    ))
  INTO v_new_count, v_returning_count
  FROM period_visits;

  SELECT COUNT(*)
    INTO v_followups_due
    FROM public.patients p
   WHERE p.clinic_id = p_clinic_id
     AND p.follow_up_required = 'Yes'
     AND p.follow_up_date BETWEEN p_from_date AND p_to_date
     AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
     AND (
       v_doctor IS NULL
       OR EXISTS (
         SELECT 1 FROM public.prescriptions pr
          WHERE pr.patient_id = p.id
            AND pr.clinic_id = p.clinic_id
            AND pr.doctor_profile_id = v_doctor
       )
     );

  SELECT COUNT(*)
    INTO v_followups_completed
    FROM public.patients p
   WHERE p.clinic_id = p_clinic_id
     AND p.follow_up_required = 'Yes'
     AND p.follow_up_date BETWEEN p_from_date AND p_to_date
     AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
     AND (
       v_doctor IS NULL
       OR EXISTS (
         SELECT 1 FROM public.prescriptions pr
          WHERE pr.patient_id = p.id
            AND pr.clinic_id = p.clinic_id
            AND pr.doctor_profile_id = v_doctor
       )
     )
     AND EXISTS (
       SELECT 1 FROM public.patient_visits pv
        WHERE pv.patient_id = p.id
          AND pv.clinic_id = p.clinic_id
          AND pv.visit_status NOT IN ('cancelled', 'no_show')
          AND pv.visit_date >= p.follow_up_date
          AND pv.visit_date <= p.follow_up_date + 14
     );

  SELECT COUNT(*)
    INTO v_overdue
    FROM public.v_follow_up_analytics v
   WHERE v.clinic_id = p_clinic_id
     AND v.follow_up_bucket = 'overdue'
     AND (p_include_demo OR NOT v.is_demo)
     AND (v_doctor IS NULL OR v.doctor_profile_id = v_doctor);

  v_retention := CASE
    WHEN COALESCE(v_followups_due, 0) = 0 THEN 0
    ELSE ROUND((v_followups_completed::numeric / v_followups_due::numeric) * 100, 1)
  END;

  RETURN jsonb_build_object(
    'patients', jsonb_build_object(
      'today', COALESCE(v_patients_today, 0),
      'week', COALESCE(v_patients_week, 0),
      'month', COALESCE(v_patients_month, 0)
    ),
    'followups', jsonb_build_object(
      'today', COALESCE(v_followups_today, 0),
      'week', COALESCE(v_followups_week, 0),
      'month', COALESCE(v_followups_month, 0)
    ),
    'new_vs_returning', jsonb_build_object(
      'new', COALESCE(v_new_count, 0),
      'returning', COALESCE(v_returning_count, 0),
      'new_pct', CASE
        WHEN COALESCE(v_new_count, 0) + COALESCE(v_returning_count, 0) = 0 THEN 0
        ELSE ROUND((v_new_count::numeric / (v_new_count + v_returning_count)::numeric) * 100, 1)
      END
    ),
    'retention_rate', v_retention,
    'overdue_followups', COALESCE(v_overdue, 0),
    'period', jsonb_build_object('from', p_from_date, 'to', p_to_date)
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_visit_trends
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_visit_trends(UUID, DATE, DATE, UUID, TEXT, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION public.doctor_get_visit_trends(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_patient_type TEXT DEFAULT 'all',
  p_include_demo BOOLEAN DEFAULT FALSE,
  p_granularity TEXT DEFAULT 'month'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_result JSONB;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'period'), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT jsonb_build_object(
        'period', to_char(d.bucket, CASE WHEN lower(p_granularity) = 'week' THEN 'IYYY-"W"IW' ELSE 'YYYY-MM' END),
        'label', to_char(d.bucket, CASE WHEN lower(p_granularity) = 'week' THEN 'Mon DD, YYYY' ELSE 'Mon YYYY' END),
        'visits', d.cnt
      ) AS row
      FROM (
        SELECT
          date_trunc(CASE WHEN lower(p_granularity) = 'week' THEN 'week' ELSE 'month' END, pv.visit_date::timestamp)::date AS bucket,
          COUNT(*) AS cnt
        FROM public.patient_visits pv
        JOIN public.patients p ON p.id = pv.patient_id
       WHERE pv.clinic_id = p_clinic_id
         AND pv.visit_date BETWEEN p_from_date AND p_to_date
         AND pv.visit_status NOT IN ('cancelled', 'no_show')
         AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
         AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
         AND (
           p_patient_type = 'all'
           OR (p_patient_type = 'new' AND NOT EXISTS (
             SELECT 1 FROM public.patient_visits pv2
              WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
                AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
           ))
           OR (p_patient_type = 'returning' AND EXISTS (
             SELECT 1 FROM public.patient_visits pv2
              WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
                AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
           ))
         )
       GROUP BY 1
      ) d
    ) s;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_followup_trends
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_followup_trends(UUID, DATE, DATE, UUID, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION public.doctor_get_followup_trends(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_include_demo BOOLEAN DEFAULT FALSE,
  p_granularity TEXT DEFAULT 'month'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_result JSONB;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'period'), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT jsonb_build_object(
        'period', to_char(d.bucket, CASE WHEN lower(p_granularity) = 'week' THEN 'IYYY-"W"IW' ELSE 'YYYY-MM' END),
        'label', to_char(d.bucket, CASE WHEN lower(p_granularity) = 'week' THEN 'Mon DD, YYYY' ELSE 'Mon YYYY' END),
        'scheduled', d.scheduled,
        'completed', d.completed,
        'overdue', d.overdue
      ) AS row
      FROM (
        SELECT
          date_trunc(CASE WHEN lower(p_granularity) = 'week' THEN 'week' ELSE 'month' END, p.follow_up_date::timestamp)::date AS bucket,
          COUNT(*) AS scheduled,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM public.patient_visits pv
               WHERE pv.patient_id = p.id AND pv.clinic_id = p.clinic_id
                 AND pv.visit_status NOT IN ('cancelled', 'no_show')
                 AND pv.visit_date >= p.follow_up_date
                 AND pv.visit_date <= p.follow_up_date + 14
            )
          ) AS completed,
          COUNT(*) FILTER (
            WHERE p.follow_up_date < CURRENT_DATE
              AND p.status IN ('pending', 'missed')
              AND NOT EXISTS (
                SELECT 1 FROM public.patient_visits pv
                 WHERE pv.patient_id = p.id AND pv.clinic_id = p.clinic_id
                   AND pv.visit_status NOT IN ('cancelled', 'no_show')
                   AND pv.visit_date >= p.follow_up_date
              )
          ) AS overdue
        FROM public.patients p
       WHERE p.clinic_id = p_clinic_id
         AND p.follow_up_required = 'Yes'
         AND p.follow_up_date BETWEEN p_from_date AND p_to_date
         AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
         AND (
           v_doctor IS NULL
           OR EXISTS (
             SELECT 1 FROM public.prescriptions pr
              WHERE pr.patient_id = p.id AND pr.clinic_id = p.clinic_id
                AND pr.doctor_profile_id = v_doctor
           )
         )
       GROUP BY 1
      ) d
    ) s;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_new_vs_returning_trends
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_new_vs_returning_trends(UUID, DATE, DATE, UUID, BOOLEAN, TEXT);
CREATE OR REPLACE FUNCTION public.doctor_get_new_vs_returning_trends(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_include_demo BOOLEAN DEFAULT FALSE,
  p_granularity TEXT DEFAULT 'month'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_result JSONB;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'period'), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT jsonb_build_object(
        'period', to_char(d.bucket, CASE WHEN lower(p_granularity) = 'week' THEN 'IYYY-"W"IW' ELSE 'YYYY-MM' END),
        'label', to_char(d.bucket, CASE WHEN lower(p_granularity) = 'week' THEN 'Mon DD, YYYY' ELSE 'Mon YYYY' END),
        'new', d.new_cnt,
        'returning', d.returning_cnt
      ) AS row
      FROM (
        SELECT
          date_trunc(CASE WHEN lower(p_granularity) = 'week' THEN 'week' ELSE 'month' END, pv.visit_date::timestamp)::date AS bucket,
          COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM public.patient_visits pv2
             WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
               AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
          )) AS new_cnt,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.patient_visits pv2
             WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
               AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
          )) AS returning_cnt
        FROM public.patient_visits pv
        JOIN public.patients p ON p.id = pv.patient_id
       WHERE pv.clinic_id = p_clinic_id
         AND pv.visit_date BETWEEN p_from_date AND p_to_date
         AND pv.visit_status NOT IN ('cancelled', 'no_show')
         AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
         AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
       GROUP BY 1
      ) d
    ) s;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_recent_visits
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_recent_visits(UUID, DATE, DATE, UUID, TEXT, BOOLEAN, INT, INT);
CREATE OR REPLACE FUNCTION public.doctor_get_recent_visits(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_patient_type TEXT DEFAULT 'all',
  p_include_demo BOOLEAN DEFAULT FALSE,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_rows JSONB;
  v_total BIGINT;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*)
    INTO v_total
    FROM public.patient_visits pv
    JOIN public.patients p ON p.id = pv.patient_id
   WHERE pv.clinic_id = p_clinic_id
     AND pv.visit_date BETWEEN p_from_date AND p_to_date
     AND pv.visit_status NOT IN ('cancelled', 'no_show')
     AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
     AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
     AND (
       p_patient_type = 'all'
       OR (p_patient_type = 'new' AND NOT EXISTS (
         SELECT 1 FROM public.patient_visits pv2
          WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
            AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
       ))
       OR (p_patient_type = 'returning' AND EXISTS (
         SELECT 1 FROM public.patient_visits pv2
          WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
            AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
       ))
     );

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'visit_date' DESC, row->>'checked_in_at' DESC), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
        'visit_id', pv.id,
        'patient_id', p.id,
        'patient_code', p.patient_code,
        'patient_name', p.name,
        'doctor_name', pv.doctor_name,
        'visit_date', pv.visit_date,
        'visit_status', pv.visit_status,
        'chief_complaint', pv.chief_complaint,
        'checked_in_at', pv.checked_in_at,
        'is_new', NOT EXISTS (
          SELECT 1 FROM public.patient_visits pv2
           WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
             AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
        )
      ) AS row
      FROM public.patient_visits pv
      JOIN public.patients p ON p.id = pv.patient_id
     WHERE pv.clinic_id = p_clinic_id
       AND pv.visit_date BETWEEN p_from_date AND p_to_date
       AND pv.visit_status NOT IN ('cancelled', 'no_show')
       AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
       AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
       AND (
         p_patient_type = 'all'
         OR (p_patient_type = 'new' AND NOT EXISTS (
           SELECT 1 FROM public.patient_visits pv2
            WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
              AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
         ))
         OR (p_patient_type = 'returning' AND EXISTS (
           SELECT 1 FROM public.patient_visits pv2
            WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
              AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
         ))
       )
     ORDER BY pv.visit_date DESC, pv.checked_in_at DESC NULLS LAST
     LIMIT p_limit OFFSET p_offset
    ) q;

  RETURN jsonb_build_object('total', v_total, 'rows', COALESCE(v_rows, '[]'::jsonb));
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_followup_pipeline
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_followup_pipeline(UUID, DATE, DATE, UUID, BOOLEAN, INT, INT);
CREATE OR REPLACE FUNCTION public.doctor_get_followup_pipeline(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_include_demo BOOLEAN DEFAULT FALSE,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_rows JSONB;
  v_total BIGINT;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);
  p_limit := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  p_offset := GREATEST(COALESCE(p_offset, 0), 0);

  SELECT COUNT(*)
    INTO v_total
    FROM public.v_follow_up_analytics v
   WHERE v.clinic_id = p_clinic_id
     AND v.follow_up_date BETWEEN p_from_date AND p_to_date
     AND v.follow_up_bucket IN ('overdue', 'due_today', 'upcoming')
     AND (p_include_demo OR NOT v.is_demo)
     AND (v_doctor IS NULL OR v.doctor_profile_id = v_doctor);

  SELECT COALESCE(jsonb_agg(row ORDER BY
    CASE row->>'follow_up_bucket' WHEN 'overdue' THEN 0 WHEN 'due_today' THEN 1 ELSE 2 END,
    row->>'follow_up_date'
  ), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT jsonb_build_object(
        'patient_id', v.patient_id,
        'patient_code', v.patient_code,
        'patient_name', v.name,
        'phone', v.phone,
        'follow_up_date', v.follow_up_date,
        'follow_up_bucket', v.follow_up_bucket,
        'patient_status', v.patient_status,
        'days_overdue', CASE
          WHEN v.follow_up_bucket = 'overdue' THEN CURRENT_DATE - v.follow_up_date
          ELSE 0
        END,
        'doctor_profile_id', v.doctor_profile_id
      ) AS row
      FROM public.v_follow_up_analytics v
     WHERE v.clinic_id = p_clinic_id
       AND v.follow_up_date BETWEEN p_from_date AND p_to_date
       AND v.follow_up_bucket IN ('overdue', 'due_today', 'upcoming')
       AND (p_include_demo OR NOT v.is_demo)
       AND (v_doctor IS NULL OR v.doctor_profile_id = v_doctor)
     ORDER BY
       CASE v.follow_up_bucket WHEN 'overdue' THEN 0 WHEN 'due_today' THEN 1 ELSE 2 END,
       v.follow_up_date
     LIMIT p_limit OFFSET p_offset
    ) q;

  RETURN jsonb_build_object('total', v_total, 'rows', COALESCE(v_rows, '[]'::jsonb));
END;
$$;

-- -----------------------------------------------------------------------------
-- doctor_get_monthly_summary
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.doctor_get_monthly_summary(UUID, DATE, DATE, UUID, BOOLEAN);
CREATE OR REPLACE FUNCTION public.doctor_get_monthly_summary(
  p_clinic_id UUID,
  p_from_date DATE,
  p_to_date DATE,
  p_doctor_profile_id UUID DEFAULT NULL,
  p_include_demo BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_doctor UUID;
  v_result JSONB;
BEGIN
  PERFORM public.doctor_analytics_assert_access(p_clinic_id);
  v_doctor := public.doctor_analytics_effective_doctor_id(p_clinic_id, p_doctor_profile_id);

  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'month' DESC), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT jsonb_build_object(
        'month', to_char(months.bucket, 'YYYY-MM'),
        'label', to_char(months.bucket, 'Mon YYYY'),
        'visits', COALESCE(vs.visits, 0),
        'new_patients', COALESCE(vs.new_patients, 0),
        'returning_patients', COALESCE(vs.returning_patients, 0),
        'followups_due', COALESCE(fs.followups_due, 0),
        'followups_completed', COALESCE(fs.followups_completed, 0),
        'retention_rate', CASE
          WHEN COALESCE(fs.followups_due, 0) = 0 THEN 0
          ELSE ROUND((fs.followups_completed::numeric / fs.followups_due::numeric) * 100, 1)
        END
      ) AS row
      FROM (
        SELECT DISTINCT date_trunc('month', d::timestamp)::date AS bucket
          FROM generate_series(p_from_date, p_to_date, '1 month'::interval) AS d
      ) months
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS visits,
          COUNT(*) FILTER (WHERE NOT EXISTS (
            SELECT 1 FROM public.patient_visits pv2
             WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
               AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
          )) AS new_patients,
          COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM public.patient_visits pv2
             WHERE pv2.clinic_id = pv.clinic_id AND pv2.patient_id = pv.patient_id
               AND pv2.visit_status NOT IN ('cancelled', 'no_show') AND pv2.visit_date < pv.visit_date
          )) AS returning_patients
        FROM public.patient_visits pv
        JOIN public.patients pt ON pt.id = pv.patient_id
       WHERE pv.clinic_id = p_clinic_id
         AND date_trunc('month', pv.visit_date::timestamp)::date = months.bucket
         AND pv.visit_status NOT IN ('cancelled', 'no_show')
         AND (p_include_demo OR NOT COALESCE(pt.is_demo, FALSE))
         AND (v_doctor IS NULL OR pv.doctor_profile_id = v_doctor)
      ) vs ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS followups_due,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM public.patient_visits pv3
               WHERE pv3.patient_id = p.id AND pv3.clinic_id = p.clinic_id
                 AND pv3.visit_status NOT IN ('cancelled', 'no_show')
                 AND pv3.visit_date >= p.follow_up_date
                 AND pv3.visit_date <= p.follow_up_date + 14
            )
          ) AS followups_completed
        FROM public.patients p
       WHERE p.clinic_id = p_clinic_id
         AND p.follow_up_required = 'Yes'
         AND date_trunc('month', p.follow_up_date::timestamp)::date = months.bucket
         AND (p_include_demo OR NOT COALESCE(p.is_demo, FALSE))
         AND (
           v_doctor IS NULL OR EXISTS (
             SELECT 1 FROM public.prescriptions pr
              WHERE pr.patient_id = p.id AND pr.clinic_id = p.clinic_id
                AND pr.doctor_profile_id = v_doctor
           )
         )
      ) fs ON TRUE
    ) s;

  RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.current_user_can_view_clinic_analytics(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_analytics_effective_doctor_id(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_analytics_assert_access(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_list_clinic_doctors(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_analytics_overview(UUID, DATE, DATE, UUID, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_visit_trends(UUID, DATE, DATE, UUID, TEXT, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_followup_trends(UUID, DATE, DATE, UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_new_vs_returning_trends(UUID, DATE, DATE, UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_recent_visits(UUID, DATE, DATE, UUID, TEXT, BOOLEAN, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_followup_pipeline(UUID, DATE, DATE, UUID, BOOLEAN, INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.doctor_get_monthly_summary(UUID, DATE, DATE, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_clinic_daily_analytics(DATE) TO service_role;

NOTIFY pgrst, 'reload schema';
