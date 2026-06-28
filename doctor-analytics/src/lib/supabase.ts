import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { hasSupabaseConfig, readRuntimeConfig } from './config';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const config = readRuntimeConfig();
  if (!hasSupabaseConfig(config)) return null;
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export function resetSupabaseClient(): void {
  client = null;
}

export async function getAccessToken(): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}
