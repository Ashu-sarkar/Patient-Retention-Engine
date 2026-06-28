import { QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { createAppQueryClient } from '@/lib/query-client';
import { DashboardPage } from '@/pages/DashboardPage';
import { LoginPage } from '@/pages/LoginPage';

const queryClient = createAppQueryClient();

function ProfileLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted">
      Loading your clinic profile…
    </div>
  );
}

function ProfileErrorScreen({ message, onSignOut }: { message: string; onSignOut: () => void }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-lg items-center px-4">
      <div className="card w-full p-6">
        <h1 className="text-xl font-bold text-ink">Could not load profile</h1>
        <p className="mt-2 text-sm text-muted">{message}</p>
        <button type="button" className="btn btn-primary mt-4" onClick={onSignOut}>
          Sign out and try again
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const auth = useAuth();

  if (auth.loading && !auth.session) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted">
        Loading session…
      </div>
    );
  }

  if (!auth.configured) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-xl font-bold">Configuration required</h1>
        <p className="mt-2 text-sm text-muted">
          Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, or inject{' '}
          <code>window.VAITALCARE_CONFIG</code> before loading this app.
        </p>
      </div>
    );
  }

  if (!auth.session) {
    return <LoginPage onSignIn={auth.signIn} error={auth.error} />;
  }

  if (auth.loadingProfile) {
    return <ProfileLoadingScreen />;
  }

  if (!auth.profile) {
    return (
      <ProfileErrorScreen
        message={auth.error || 'Your doctor profile could not be loaded for this account.'}
        onSignOut={() => void auth.signOut()}
      />
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <DashboardPage profile={auth.profile} onSignOut={() => void auth.signOut()} />
    </QueryClientProvider>
  );
}
