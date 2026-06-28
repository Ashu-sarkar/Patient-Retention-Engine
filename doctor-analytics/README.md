# Doctor Analytics Dashboard

React + TypeScript analytics app for clinic performance: KPIs, charts, and actionable tables backed by Supabase doctor-scoped RPCs.

## Stack

- Vite + React 18 + TypeScript
- Tailwind CSS
- Recharts
- TanStack Query
- Supabase Auth + RPCs

## Configuration

Set environment variables for local dev (`doctor-analytics/.env`):

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_DOCTOR_DASHBOARD_URL=http://localhost:5173
```

Or inject at runtime before the bundle loads:

```html
<script>
  window.VAITALCARE_CONFIG = {
    supabaseUrl: '...',
    supabaseAnonKey: '...',
    doctorDashboardUrl: 'https://vaitalcare-doctor.vercel.app'
  };
</script>
```

## Development

```bash
cd doctor-analytics
npm install
npm run dev
```

## Database

Apply analytics RPCs via root preflight:

```bash
npm run preflight
```

Migration file: `schemas/migration-doctor-analytics.sql`

## Deploy

Static Vercel deploy from `doctor-analytics/` (see `vercel.json`).

### Vercel

Create a Vercel project (e.g. `vaitalcare-doctor-analytics`) with **Root Directory** set to `doctor-analytics`. Add these environment variables in Project Settings → Environment Variables:

```bash
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_DOCTOR_DASHBOARD_URL=https://vaitalcare-doctor.vercel.app
```

Then deploy:

```bash
cd doctor-analytics
npx vercel --prod
```

Assign the production domain `vaitalcare-doctor-analytics.vercel.app` in Vercel → Project → Settings → Domains.
