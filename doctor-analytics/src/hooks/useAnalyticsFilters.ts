import { useMemo, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { resolveDateRange, validateDateRange } from '@/lib/date-utils';
import type { AnalyticsFilter, DatePreset, PatientTypeFilter } from '@/types/analytics';
import type { DoctorProfile } from '@/types/analytics';

export function useAnalyticsFilters(profile: DoctorProfile | null) {
  const [preset, setPreset] = useState<DatePreset>('last_180');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [doctorProfileId, setDoctorProfileId] = useState<string | null>(null);
  const [patientType, setPatientType] = useState<PatientTypeFilter>('all');
  const [includeDemo, setIncludeDemo] = useState(false);

  const debouncedCustomFrom = useDebouncedValue(customFrom, preset === 'custom' ? 350 : 0);
  const debouncedCustomTo = useDebouncedValue(customTo, preset === 'custom' ? 350 : 0);

  const dateRange = useMemo(
    () => resolveDateRange(preset, debouncedCustomFrom, debouncedCustomTo),
    [preset, debouncedCustomFrom, debouncedCustomTo],
  );

  const dateRangeError = useMemo(
    () => (preset === 'custom' ? validateDateRange(dateRange.fromDate, dateRange.toDate) : null),
    [preset, dateRange.fromDate, dateRange.toDate],
  );

  const filter: AnalyticsFilter | null = useMemo(() => {
    if (!profile?.clinic_id || dateRangeError) return null;
    return {
      clinicId: profile.clinic_id,
      fromDate: dateRange.fromDate,
      toDate: dateRange.toDate,
      doctorProfileId: profile.is_clinic_admin ? doctorProfileId : profile.id,
      patientType,
      includeDemo,
    };
  }, [profile, dateRange, dateRangeError, doctorProfileId, patientType, includeDemo]);

  return {
    filter,
    dateRangeError,
    preset,
    setPreset,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    doctorProfileId,
    setDoctorProfileId,
    patientType,
    setPatientType,
    includeDemo,
    setIncludeDemo,
  };
}
