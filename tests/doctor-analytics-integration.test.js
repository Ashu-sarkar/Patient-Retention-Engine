#!/usr/bin/env node
'use strict';

/**
 * Doctor Analytics — integration tests (Postgres RPCs + seeded data).
 *
 * Prerequisites:
 *   npm run preflight
 *   SUPABASE_DB_* or SUPABASE_DATABASE_URL in .env
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseEnv(filePath) {
  try {
    return Object.fromEntries(
      fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  } catch {
    return {};
  }
}

const env = { ...parseEnv(path.join(__dirname, '..', '.env')), ...process.env };

function getDbConfig() {
  const raw = (env.SUPABASE_DATABASE_URL || env.DATABASE_URL || '').trim();
  if (raw && /^postgres(ql)?:\/\//i.test(raw)) {
    const u = new URL(raw.replace(/^postgresql:/i, 'postgres:'));
    return {
      host: u.hostname,
      port: parseInt(u.port || '5432', 10),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: (u.pathname || '/postgres').replace(/^\//, '') || 'postgres',
    };
  }
  return {
    host: env.SUPABASE_DB_HOST,
    port: parseInt(env.SUPABASE_DB_PORT || '5432', 10),
    user: env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    database: env.SUPABASE_DB_NAME || 'postgres',
  };
}

function date(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function main() {
  const cfg = getDbConfig();
  if (!cfg.host || !cfg.user || !cfg.password) {
    console.error('Missing database credentials — set SUPABASE_DATABASE_URL or SUPABASE_DB_* in .env');
    process.exit(1);
  }

  const client = new Client({ ...cfg, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const suffix = crypto.randomBytes(4).toString('hex');
  const clinicName = `Analytics Test Clinic ${suffix}`;
  const phoneNew = `+9199${suffix.slice(0, 8).padEnd(8, '0')}`;
  const phoneReturn = `+9198${suffix.slice(0, 8).padEnd(8, '0')}`;
  const phoneOverdue = `+9197${suffix.slice(0, 8).padEnd(8, '0')}`;
  const authUserId = crypto.randomUUID();
  let clinicId;
  let doctorProfileId;
  let passed = 0;
  let failed = 0;

  async function test(label, fn) {
    process.stdout.write(`  ${label} … `);
    try {
      await fn();
      process.stdout.write('PASS\n');
      passed += 1;
    } catch (err) {
      process.stdout.write(`FAIL\n       → ${err.message}\n`);
      failed += 1;
    }
  }

  async function asUser(userId, fn) {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
    try {
      return await fn();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  console.log('\nDoctor Analytics — Integration Tests\n');

  try {
    await test('migration RPCs exist', async () => {
      const { rows } = await client.query(
        `SELECT proname FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND proname LIKE 'doctor_get_%' OR proname = 'doctor_list_clinic_doctors'`,
      );
      const names = new Set(rows.map((r) => r.proname));
      assert(names.has('doctor_get_analytics_overview'), 'overview RPC missing — run npm run preflight');
      assert(names.has('doctor_get_followup_pipeline'), 'followup pipeline RPC missing');
    });

    await test('seed clinic, doctor, patients, and visits', async () => {
      const clinicRes = await client.query('SELECT public.get_or_create_clinic_id($1)::uuid AS id', [clinicName]);
      clinicId = clinicRes.rows[0].id;

      await client.query(
        `INSERT INTO auth.users (id, aud, role, email)
         VALUES ($1::uuid, 'authenticated', 'authenticated', $2)
         ON CONFLICT (id) DO NOTHING`,
        [authUserId, `analytics.${suffix}@auth.vaitalcare.local`],
      );

      const doctorRes = await client.query(
        `INSERT INTO public.doctor_profiles (
           user_id, clinic_id, doctor_name, clinic_name, registration_number, is_clinic_admin
         ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, TRUE)
         ON CONFLICT (user_id) DO UPDATE SET clinic_id = EXCLUDED.clinic_id
         RETURNING id`,
        [authUserId, clinicId, 'Dr Analytics Test', clinicName, `REG-${suffix}`],
      );
      doctorProfileId = doctorRes.rows[0].id;

      await client.query(
        `INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'clinic_admin', 'active')
         ON CONFLICT (clinic_id, user_id, role) DO NOTHING`,
        [clinicId, authUserId, doctorProfileId],
      );
      await client.query(
        `INSERT INTO public.clinic_memberships (clinic_id, user_id, doctor_profile_id, role, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'doctor', 'active')
         ON CONFLICT (clinic_id, user_id, role) DO NOTHING`,
        [clinicId, authUserId, doctorProfileId],
      );

      const patients = [
        { phone: phoneNew, name: 'New Patient', followUp: date(7), overdue: false, priorVisit: false },
        { phone: phoneReturn, name: 'Returning Patient', followUp: date(-3), overdue: false, priorVisit: true },
        { phone: phoneOverdue, name: 'Overdue Patient', followUp: date(-10), overdue: true, priorVisit: true },
      ];

      for (const p of patients) {
        const patientRes = await client.query(
          `INSERT INTO public.patients (
             clinic_id, name, phone, clinic_name, doctor_name, follow_up_required, follow_up_date, status
           ) VALUES ($1::uuid, $2, $3, $4, $5, 'Yes', $6::date, $7)
           RETURNING id`,
          [
            clinicId,
            p.name,
            p.phone,
            clinicName,
            'Dr Analytics Test',
            p.followUp,
            p.overdue ? 'pending' : 'pending',
          ],
        );
        const patientId = patientRes.rows[0].id;

        if (p.priorVisit) {
          await client.query(
            `INSERT INTO public.patient_visits (
               clinic_id, patient_id, doctor_profile_id, doctor_name, clinic_name,
               visit_date, visit_status, chief_complaint
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, 'completed', 'Prior visit')`,
            [clinicId, patientId, doctorProfileId, 'Dr Analytics Test', clinicName, date(-30)],
          );
        }

        if (!p.overdue) {
          await client.query(
            `INSERT INTO public.patient_visits (
               clinic_id, patient_id, doctor_profile_id, doctor_name, clinic_name,
               visit_date, visit_status, chief_complaint
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, 'completed', 'Current visit')`,
            [clinicId, patientId, doctorProfileId, 'Dr Analytics Test', clinicName, date(0)],
          );
        }

        if (p.phone === phoneReturn) {
          await client.query(
            `INSERT INTO public.patient_visits (
               clinic_id, patient_id, doctor_profile_id, doctor_name, clinic_name,
               visit_date, visit_status
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, 'completed')`,
            [clinicId, patientId, doctorProfileId, 'Dr Analytics Test', clinicName, date(-2)],
          );
        }
      }
    });

    await test('doctor_get_analytics_overview returns expected counts', async () => {
      const overview = await asUser(authUserId, async () => {
        const { rows } = await client.query(
          `SELECT public.doctor_get_analytics_overview($1::uuid, $2::date, $3::date, NULL, 'all', FALSE) AS data`,
          [clinicId, date(-30), date(0)],
        );
        return rows[0].data;
      });

      assert(Number(overview.patients.today) >= 2, `expected >=2 visits today, got ${overview.patients.today}`);
      assert(Number(overview.new_vs_returning.new) >= 1, 'expected at least one new patient in period');
      assert(Number(overview.new_vs_returning.returning) >= 1, 'expected at least one returning patient in period');
      assert(Number(overview.overdue_followups) >= 1, 'expected at least one overdue follow-up');
    });

    await test('doctor_get_visit_trends returns monthly buckets', async () => {
      const trends = await asUser(authUserId, async () => {
        const { rows } = await client.query(
          `SELECT public.doctor_get_visit_trends($1::uuid, $2::date, $3::date, NULL, 'all', FALSE, 'month') AS data`,
          [clinicId, date(-60), date(0)],
        );
        return rows[0].data;
      });
      assert(Array.isArray(trends), 'visit trends should be an array');
      assert(trends.length >= 1, 'expected at least one trend bucket');
    });

    await test('doctor_get_followup_pipeline includes overdue row', async () => {
      const pipeline = await asUser(authUserId, async () => {
        const { rows } = await client.query(
          `SELECT public.doctor_get_followup_pipeline($1::uuid, $2::date, $3::date, NULL, FALSE, 25, 0) AS data`,
          [clinicId, date(-30), date(30)],
        );
        return rows[0].data;
      });
      assert(Array.isArray(pipeline.rows), 'pipeline rows should be an array');
      assert(pipeline.rows.some((r) => r.follow_up_bucket === 'overdue'), 'expected overdue follow-up in pipeline');
    });

    await test('unauthorized clinic access is rejected', async () => {
      const otherUser = crypto.randomUUID();
      await client.query(
        `INSERT INTO auth.users (id, aud, role, email)
         VALUES ($1::uuid, 'authenticated', 'authenticated', $2)
         ON CONFLICT (id) DO NOTHING`,
        [otherUser, `other.${suffix}@auth.vaitalcare.local`],
      );

      let rejected = false;
      try {
        await asUser(otherUser, async () => {
          await client.query(
            `SELECT public.doctor_get_analytics_overview($1::uuid, $2::date, $3::date)`,
            [clinicId, date(-7), date(0)],
          );
        });
      } catch (err) {
        rejected = /not authorized/i.test(String(err.message));
      }
      assert(rejected, 'expected not authorized for user without clinic membership');
    });

    await test('refresh_clinic_daily_analytics runs without error', async () => {
      await client.query(`SELECT public.refresh_clinic_daily_analytics($1::date)`, [date(-1)]);
      const { rows } = await client.query(
        `SELECT COUNT(*)::int AS c FROM public.clinic_daily_analytics WHERE clinic_id = $1::uuid`,
        [clinicId],
      );
      assert(rows[0].c >= 0, 'rollup table should be readable after refresh');
    });
  } finally {
    if (clinicId) {
      await client.query('DELETE FROM public.patient_visits WHERE clinic_id = $1::uuid', [clinicId]).catch(() => {});
      await client.query('DELETE FROM public.patients WHERE clinic_id = $1::uuid', [clinicId]).catch(() => {});
      await client.query('DELETE FROM public.clinic_memberships WHERE clinic_id = $1::uuid', [clinicId]).catch(() => {});
      await client.query('DELETE FROM public.doctor_profiles WHERE clinic_id = $1::uuid', [clinicId]).catch(() => {});
      await client.query('DELETE FROM public.clinic_daily_analytics WHERE clinic_id = $1::uuid', [clinicId]).catch(() => {});
    }
    await client.query('DELETE FROM auth.users WHERE id = $1::uuid', [authUserId]).catch(() => {});
    await client.end();
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
