import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchClinicDoctors } from '@/lib/analytics-api';
import { presetLabel } from '@/lib/date-utils';
import type { DatePreset, PatientTypeFilter } from '@/types/analytics';
import type { DoctorProfile } from '@/types/analytics';

interface FilterBarProps {
  profile: DoctorProfile;
  preset: DatePreset;
  setPreset: (value: DatePreset) => void;
  customFrom: string;
  setCustomFrom: (value: string) => void;
  customTo: string;
  setCustomTo: (value: string) => void;
  doctorProfileId: string | null;
  setDoctorProfileId: (value: string | null) => void;
  patientType: PatientTypeFilter;
  setPatientType: (value: PatientTypeFilter) => void;
  includeDemo: boolean;
  setIncludeDemo: (value: boolean) => void;
  dateRangeError?: string | null;
  onRefresh: () => void;
  refreshing?: boolean;
}

export function FilterBar({
  profile,
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
  dateRangeError,
  onRefresh,
  refreshing,
}: FilterBarProps) {
  const doctorsQuery = useQuery({
    queryKey: ['doctors', profile.clinic_id],
    queryFn: () => fetchClinicDoctors(profile.clinic_id),
    enabled: profile.is_clinic_admin,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!profile.is_clinic_admin) {
      setDoctorProfileId(profile.id);
    }
  }, [profile.id, profile.is_clinic_admin, setDoctorProfileId]);

  return (
    <div className="sticky top-0 z-20 card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Date range">
          <select className="input min-w-[160px]" value={preset} onChange={(e) => setPreset(e.target.value as DatePreset)}>
            {(['today', 'this_week', 'this_month', 'last_30', 'last_90', 'last_180', 'last_365', 'custom'] as DatePreset[]).map((p) => (
              <option key={p} value={p}>
                {presetLabel(p)}
              </option>
            ))}
          </select>
        </Field>

        {preset === 'custom' ? (
          <>
            <Field label="From">
              <input className="input" type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <input className="input" type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </Field>
          </>
        ) : null}

        <Field label="Clinic">
          <input className="input min-w-[180px]" value={profile.clinic_name} readOnly />
        </Field>

        {profile.is_clinic_admin ? (
          <Field label="Doctor">
            <select
              className="input min-w-[180px]"
              value={doctorProfileId || ''}
              onChange={(e) => setDoctorProfileId(e.target.value || null)}
              disabled={doctorsQuery.isLoading || doctorsQuery.isError}
            >
              <option value="">All doctors</option>
              {(doctorsQuery.data || []).map((d) => (
                <option key={d.doctor_profile_id} value={d.doctor_profile_id}>
                  {d.doctor_name}
                  {d.is_self ? ' (You)' : ''}
                </option>
              ))}
            </select>
            {doctorsQuery.isError ? (
              <span className="text-[11px] font-normal normal-case text-rose-600">Could not load doctors.</span>
            ) : null}
          </Field>
        ) : null}

        <Field label="Patient type">
          <select
            className="input min-w-[160px]"
            value={patientType}
            onChange={(e) => setPatientType(e.target.value as PatientTypeFilter)}
          >
            <option value="all">All patients</option>
            <option value="new">New only</option>
            <option value="returning">Returning only</option>
          </select>
        </Field>

        <label className="flex items-center gap-2 pb-2 text-sm text-muted">
          <input type="checkbox" checked={includeDemo} onChange={(e) => setIncludeDemo(e.target.checked)} />
          Include demo patients
        </label>

        <button
          type="button"
          className="btn btn-primary"
          onClick={onRefresh}
          disabled={refreshing || Boolean(dateRangeError)}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
      {label}
      {children}
    </label>
  );
}
