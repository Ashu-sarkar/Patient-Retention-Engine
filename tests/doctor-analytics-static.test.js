#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'schemas', 'migration-doctor-analytics.sql'), 'utf8');
const preflightScript = fs.readFileSync(path.join(root, 'scripts', 'preflight-supabase.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dashboard = fs.readFileSync(path.join(root, 'doctor-dashboard', 'index.html'), 'utf8');

const analyticsApi = fs.readFileSync(path.join(root, 'doctor-analytics', 'src', 'lib', 'analytics-api.ts'), 'utf8');
const dashboardPage = fs.readFileSync(path.join(root, 'doctor-analytics', 'src', 'pages', 'DashboardPage.tsx'), 'utf8');
const vercel = fs.readFileSync(path.join(root, 'doctor-analytics', 'vercel.json'), 'utf8');

function includes(haystack, needle, label) {
  assert(haystack.includes(needle), `${label || 'Expected content'} missing: ${needle}`);
}

const rpcs = [
  'doctor_list_clinic_doctors',
  'doctor_get_analytics_overview',
  'doctor_get_visit_trends',
  'doctor_get_followup_trends',
  'doctor_get_new_vs_returning_trends',
  'doctor_get_recent_visits',
  'doctor_get_followup_pipeline',
  'doctor_get_monthly_summary',
];

for (const rpc of rpcs) {
  includes(migration, `CREATE OR REPLACE FUNCTION public.${rpc}`, `migration defines ${rpc}`);
  includes(migration, `GRANT EXECUTE ON FUNCTION public.${rpc}`, `grant for ${rpc}`);
}
includes(migration, 'CREATE OR REPLACE VIEW public.v_follow_up_analytics', 'follow-up analytics view');
includes(migration, 'CREATE TABLE IF NOT EXISTS public.clinic_daily_analytics', 'daily rollup table');
includes(migration, 'CREATE OR REPLACE FUNCTION public.current_user_can_view_clinic_analytics', 'access helper');
includes(migration, 'CREATE OR REPLACE FUNCTION public.refresh_clinic_daily_analytics', 'rollup refresh function');
includes(preflightScript, 'migration-doctor-analytics.sql', 'preflight applies doctor analytics migration');

includes(analyticsApi, "'doctor_get_analytics_overview'", 'React API calls overview RPC');
includes(analyticsApi, "'doctor_get_visit_trends'", 'React API calls visit trends RPC');
includes(analyticsApi, "'doctor_get_followup_trends'", 'React API calls follow-up trends RPC');
includes(analyticsApi, "'doctor_get_new_vs_returning_trends'", 'React API calls new vs returning RPC');
includes(analyticsApi, "'doctor_get_recent_visits'", 'React API calls recent visits RPC');
includes(analyticsApi, "'doctor_get_followup_pipeline'", 'React API calls follow-up pipeline RPC');
includes(analyticsApi, "'doctor_get_monthly_summary'", 'React API calls monthly summary RPC');
includes(analyticsApi, "'doctor_list_clinic_doctors'", 'React API calls doctor list RPC');

includes(dashboardPage, 'KpiGrid', 'dashboard renders KPI grid');
includes(dashboardPage, 'VisitsBarChart', 'dashboard renders visits chart');
includes(dashboardPage, 'FollowupLineChart', 'dashboard renders follow-up chart');
includes(dashboardPage, 'NewReturningChart', 'dashboard renders new vs returning chart');
includes(dashboardPage, 'RecentVisitsTable', 'dashboard renders recent visits table');
includes(dashboardPage, 'FollowupPipelineTable', 'dashboard renders follow-up pipeline table');
includes(dashboardPage, 'MonthlySummaryTable', 'dashboard renders monthly summary table');
includes(dashboardPage, 'ErrorBoundary', 'dashboard isolates chart render failures');
includes(dashboardPage, 'QuerySection', 'dashboard uses per-section query states');
includes(dashboardPage, 'lazy(()', 'dashboard lazy-loads chart bundle');

includes(analyticsApi, 'normalizeApiError', 'API layer normalizes RPC errors');
includes(analyticsApi, 'parseOverview', 'API layer validates overview payloads');
includes(analyticsApi, 'RPC_TIMEOUT_MS', 'API layer enforces RPC timeout');

includes(dashboard, 'id="analytics-link"', 'doctor dashboard analytics nav link');
includes(dashboard, 'DEFAULT_DOCTOR_ANALYTICS_URL', 'doctor dashboard analytics URL config');
includes(dashboard, 'doctorAnalyticsUrl', 'doctor dashboard reads analytics URL from config');

includes(vercel, 'X-Content-Type-Options', 'analytics vercel security headers');

assert(pkg.scripts['test:doctor-analytics'], 'root package.json defines test:doctor-analytics script');
assert(pkg.scripts['test:doctor-analytics:integration'], 'root package.json defines integration test script');

console.log('[doctor-analytics-static] Passed.');
