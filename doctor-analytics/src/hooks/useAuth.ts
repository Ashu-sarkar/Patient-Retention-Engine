import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { fetchDoctorProfile } from '@/lib/analytics-api';
import { isUnauthorizedError, normalizeApiError } from '@/lib/errors';
import { hasSupabaseConfig, readRuntimeConfig, usernameToInternalEmail, isValidUsername } from '@/lib/config';
import { getSupabase, resetSupabaseClient } from '@/lib/supabase';
import type { DoctorProfile } from '@/types/analytics';

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<DoctorProfile | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = hasSupabaseConfig(readRuntimeConfig());

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) {
      setLoadingSession(false);
      setError('Supabase is not configured for this deployment.');
      return;
    }

    let active = true;

    sb.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setError(normalizeApiError(sessionError).message);
      }
      setSession(data.session);
      setLoadingSession(false);
    });

    const { data: sub } = sb.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === 'SIGNED_OUT') {
        setProfile(null);
        setError(null);
      }
      if (event === 'TOKEN_REFRESHED' && next) {
        setError(null);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [configured]);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      setLoadingProfile(false);
      return;
    }

    let active = true;
    setLoadingProfile(true);
    setError(null);

    fetchDoctorProfile()
      .then((nextProfile) => {
        if (!active) return;
        setProfile(nextProfile);
      })
      .catch(async (err) => {
        if (!active) return;
        const normalized = normalizeApiError(err);
        setProfile(null);
        setError(normalized.message);
        if (isUnauthorizedError(err)) {
          const sb = getSupabase();
          await sb?.auth.signOut();
          resetSupabaseClient();
          setSession(null);
        }
      })
      .finally(() => {
        if (active) setLoadingProfile(false);
      });

    return () => {
      active = false;
    };
  }, [session]);

  async function signIn(username: string, password: string) {
    setError(null);
    if (!isValidUsername(username)) {
      throw new Error('Username must be 3–80 characters: letters, numbers, dots, dashes, or underscores.');
    }
    const sb = getSupabase();
    if (!sb) throw new Error('Supabase is not configured');
    const email = usernameToInternalEmail(username);
    const { error: signInError } = await sb.auth.signInWithPassword({ email, password });
    if (signInError) throw normalizeApiError(signInError);
  }

  async function signOut() {
    const sb = getSupabase();
    if (sb) await sb.auth.signOut();
    resetSupabaseClient();
    setProfile(null);
    setSession(null);
    setError(null);
  }

  return {
    session,
    profile,
    loading: loadingSession || (Boolean(session) && loadingProfile),
    loadingProfile,
    error,
    configured,
    signIn,
    signOut,
  };
}
