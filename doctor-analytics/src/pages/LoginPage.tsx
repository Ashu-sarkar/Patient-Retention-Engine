import { FormEvent, useState } from 'react';
import { normalizeApiError } from '@/lib/errors';
import { isValidUsername } from '@/lib/config';

interface LoginPageProps {
  onSignIn: (username: string, password: string) => Promise<void>;
  error?: string | null;
}

export function LoginPage({ onSignIn, error }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValidUsername(username)) {
      setLocalError('Username must be 3–80 characters: letters, numbers, dots, dashes, or underscores.');
      return;
    }
    setSubmitting(true);
    setLocalError(null);
    try {
      await onSignIn(username, password);
    } catch (err) {
      setLocalError(normalizeApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <form onSubmit={handleSubmit} className="card w-full p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal">VaitalCare</p>
        <h1 className="mt-2 text-2xl font-extrabold text-ink">Doctor Analytics</h1>
        <p className="mt-1 text-sm text-muted">Sign in with the same username and password as the doctor queue.</p>

        <label className="mt-5 grid gap-1 text-sm font-semibold text-muted">
          Username
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label className="mt-3 grid gap-1 text-sm font-semibold text-muted">
          Password
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {(localError || error) && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{localError || error}</p>}

        <button type="submit" className="btn btn-primary mt-5 w-full" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
