declare global {
  interface Window {
    VAITALCARE_CONFIG?: {
      supabaseUrl?: string;
      supabaseAnonKey?: string;
      doctorDashboardUrl?: string;
      doctorAnalyticsUrl?: string;
    };
  }
}

export interface RuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  doctorDashboardUrl: string;
}

const DEFAULT_SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
const DEFAULT_DOCTOR_DASHBOARD_URL = 'https://vaitalcare-doctor.vercel.app';

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function readRuntimeConfig(): RuntimeConfig {
  const globalConfig = window.VAITALCARE_CONFIG || {};
  return {
    supabaseUrl:
      globalConfig.supabaseUrl ||
      readStored('vaitalcare.supabaseUrl') ||
      import.meta.env.VITE_SUPABASE_URL ||
      DEFAULT_SUPABASE_URL,
    supabaseAnonKey:
      globalConfig.supabaseAnonKey ||
      readStored('vaitalcare.supabaseAnonKey') ||
      import.meta.env.VITE_SUPABASE_ANON_KEY ||
      DEFAULT_SUPABASE_ANON_KEY,
    doctorDashboardUrl:
      globalConfig.doctorDashboardUrl ||
      readStored('vaitalcare.doctorDashboardUrl') ||
      import.meta.env.VITE_DOCTOR_DASHBOARD_URL ||
      DEFAULT_DOCTOR_DASHBOARD_URL,
  };
}

export function hasSupabaseConfig(config: RuntimeConfig): boolean {
  return (
    config.supabaseUrl.startsWith('https://') &&
    Boolean(config.supabaseAnonKey) &&
    !config.supabaseAnonKey.includes('YOUR_')
  );
}

export {};
export const AUTH_USERNAME_EMAIL_DOMAIN = 'auth.vaitalcare.local';

export function normalizeUsername(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return /^[a-z0-9._-]{3,80}$/.test(username);
}

export function usernameToInternalEmail(username: string): string {
  const clean = normalizeUsername(username);
  if (!isValidUsername(clean)) return '';
  return `${clean}@${AUTH_USERNAME_EMAIL_DOMAIN}`;
}
