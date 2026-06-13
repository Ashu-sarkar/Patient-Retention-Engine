# v0 Multi-Tenancy Rollout

This release uses one shared Supabase Postgres database and one shared schema.
Tenant isolation is enforced with `clinic_id`, clinic memberships, tenant-aware
RLS, and tenant-scoped n8n workflow SQL.

## Rollout Order

1. Deploy the SQL changes with `npm run preflight`.
2. Import the updated n8n workflows.
3. Deploy the updated patient form, hospital form, doctor dashboard, and Supabase Edge Functions.
4. Run `npm run lint:workflow-tenancy`.
5. Run `npm run validate-tenants` against the target Supabase database.
6. Smoke test hospital onboarding, patient intake, doctor login, prescription issue, WhatsApp delivery, inbound replies, and Twilio status callbacks.

## Required Checks

- `public.tenant_isolation_validation` must return `0` for every check before launch.
- Same patient phone must be accepted in two different clinics without overwriting either row.
- Doctor dashboard queries must only show the active clinic.
- Twilio callback updates must only touch rows that already have `clinic_id`.

## Notes

- Existing `clinic_name`, `hospital_name`, and snapshot columns remain as display/history fields.
- Authorization should use `clinic_memberships`, not clinic name matching.
- Prescription PDF links are now HMAC-signed with an expiry timestamp.
