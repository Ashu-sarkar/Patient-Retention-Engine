import { readRuntimeConfig } from '@/lib/config';
import type { DoctorProfile } from '@/types/analytics';

interface HeaderProps {
  profile: DoctorProfile;
  onSignOut: () => void;
}

export function Header({ profile, onSignOut }: HeaderProps) {
  const { doctorDashboardUrl } = readRuntimeConfig();

  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">VaitalCare</p>
        <h1 className="text-2xl font-extrabold text-ink">Doctor Analytics</h1>
        <p className="text-sm text-muted">
          {profile.doctor_name} · {profile.clinic_name}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="btn" href={doctorDashboardUrl}>
          Back to Queue
        </a>
        <button type="button" className="btn" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}
