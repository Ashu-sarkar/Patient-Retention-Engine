# VaitalCare System Design Learning Guide

This guide explains the VaitalCare Patient Retention Engine from the point of view of system design, database architecture, security, RLS, and backend workflow orchestration.

The goal is not only to describe what the system does, but to teach why it was designed this way, what could go wrong with weaker designs, and how each architectural choice reduces risk.

## 1. The Core Product Problem

VaitalCare coordinates patient intake, doctor workflow, prescription delivery, and follow-up reminders across multiple clinics.

At a high level, the platform must answer these questions safely:

- Which clinic owns this patient?
- Which doctor or staff member is allowed to see this visit?
- Which prescription belongs to which clinic?
- Which WhatsApp message belongs to which clinic and patient?
- Can a public QR form be used without letting users choose or spoof tenant identity?
- Can a doctor from Clinic A accidentally see Clinic B data?

The system is not just a form plus database. It is a multi-tenant healthcare workflow where the same phone number, doctor, patient, or clinic name may appear in more than one operational context.

That is why the central design principle is:

> Tenant identity must be explicit, stable, and enforced at the database boundary.

In this project, tenant identity is represented by `clinic_id`.

## 2. The Big Architecture Picture

The current v0 architecture is a cost-aware modular monolith:

```text
Static public forms
  -> n8n webhooks
  -> Supabase Postgres
  -> Doctor dashboard
  -> Supabase Auth + RLS
  -> Supabase Edge Functions
  -> Twilio WhatsApp
  -> n8n callbacks
  -> Logs, ledger, patient state updates
```

This is intentionally not a microservices architecture.

For v0, the system benefits more from clear data boundaries, strong SQL constraints, RLS, and tenant-aware workflows than from splitting into many services.

## 3. Why Shared Database + Shared Schema

The chosen model is:

```text
One Supabase Postgres database
One shared public schema
All tenant-owned rows carry clinic_id
RLS and constraints enforce isolation
```

### Why This Is Good For v0

This approach keeps the operational surface small:

- one migration path
- one backup strategy
- one observability model
- one set of workflows
- simpler reporting across clinics
- lower cost
- easier maintenance for a small team

### What If We Used One Database Per Clinic?

That would increase isolation, but at a high operational cost:

- every migration must be applied many times
- backups become harder to manage
- credentials multiply
- cross-clinic analytics become expensive
- support/debugging becomes slower
- onboarding a clinic becomes infrastructure work

For 30 clinics, that is unnecessary complexity.

### What If We Used One Schema Per Clinic?

Schema-per-clinic looks tempting, but it creates a similar problem:

- duplicated tables and policies
- more migration risk
- more deployment complexity
- difficult global reporting
- harder workflow SQL because every query needs dynamic schema routing

For this project, the stronger v0 choice is a shared schema with disciplined tenant keys.

## 4. Tenant Boundary: `clinic_id`

The most important database column in the multi-tenant architecture is `clinic_id`.

Tenant-owned tables include:

- `hospital_boarding`
- `doctor_profiles`
- `clinic_memberships`
- `patients`
- `patient_visits`
- `prescriptions`
- `prescription_medicines`
- `prescription_audit_logs`
- `message_logs`
- `message_ledger`
- `system_logs`

The rule is:

> If a row belongs to a clinic, it must have `clinic_id`.

### Why Text Names Are Not Enough

Before the tenant model, the system leaned on fields like:

- `clinic_name`
- `hospital_name`
- `doctor_name`
- phone number

These are useful display fields, but they are weak security boundaries.

For example:

- two clinics can have similar names
- a hospital can rename itself
- a doctor can work at multiple clinics
- a patient can visit two clinics with the same phone number
- text normalization can be inconsistent
- user-controlled form fields can be spoofed

So text fields remain useful for history and display, but not authorization.

## 5. Core Database Tables

### `clinics`

This is the root tenant table.

It represents a clinic as a durable business entity:

- `id`
- `name`
- `slug`
- `code`
- `status`
- `settings`
- timestamps

The `id` is what the rest of the system trusts.

The `name` is for humans.

The `slug` and `code` are for readable identifiers and patient code generation.

### `clinic_memberships`

This table answers:

> Which authenticated user can access which clinic, and with what role?

Roles include:

- `clinic_admin`
- `doctor`
- `staff`
- `super_admin`

This table is the foundation for RLS.

Without this table, the system would have to infer access from phone numbers, doctor names, or clinic names. That is fragile and unsafe.

### `patients`

Patients are now unique by:

```sql
(clinic_id, phone)
```

This is a key design correction.

If phone were globally unique, the same patient visiting two clinics could overwrite routing, follow-up state, doctor assignment, or prescription context.

With `(clinic_id, phone)`, the same phone can exist independently in two clinics.

### `patient_visits`

A patient can have many visits.

Each visit carries:

- `clinic_id`
- `patient_id`
- doctor routing
- queue status
- visit date
- clinical context

The system enforces that a visit’s `clinic_id` must match the patient’s `clinic_id`.

This prevents accidental cross-tenant visit creation.

### `prescriptions` and `prescription_medicines`

Prescriptions belong to a clinic, a patient, and often a visit.

Medicines inherit tenant ownership through their parent prescription.

The important principle:

> Child clinical records must not be allowed to drift into another tenant.

That is why the migration adds consistency checks between:

- prescription and patient clinic
- prescription and visit clinic
- prescription medicine and prescription clinic

### `message_logs` and `message_ledger`

These tables are part audit trail, part idempotency system.

`message_logs` records what was sent or attempted.

`message_ledger` helps prevent duplicate sends.

Both now include `clinic_id` because messaging is tenant-owned operational data.

Without `clinic_id`, a Twilio callback or scheduled reminder could accidentally update or deduplicate messages across clinics.

## 6. Constraints: The Database As A Safety Net

Good application code is not enough. Workflows, dashboards, Edge Functions, and future scripts will all touch the database.

So the database must reject unsafe states.

Important constraints include:

```sql
unique (clinic_id, phone)
unique (clinic_id, patient_code)
unique (clinic_id, patient_id, message_type, scheduled_date)
```

And foreign keys from tenant-owned rows to `clinics`.

### Why Constraints Matter

Imagine only the frontend checks clinic ownership.

That fails when:

- n8n runs with elevated credentials
- a script inserts bad data
- a future developer forgets a filter
- a race condition inserts duplicate rows
- a webhook receives a forged payload

Constraints make the data model self-defending.

They do not replace application security, but they reduce the blast radius of mistakes.

## 7. RLS: Row-Level Security

RLS answers:

> Given the current authenticated Supabase user, which rows can this user see or modify?

The important mental model:

```text
Auth session identifies user
clinic_memberships maps user -> clinic + role
RLS checks membership before returning rows
```

For example, a doctor should not be trusted because they typed a doctor name or phone number. They are trusted because:

1. they authenticated through Supabase Auth
2. their `auth.uid()` maps to an active `clinic_memberships` row
3. the requested row has the same `clinic_id`

### Why RLS Is Valuable

RLS moves tenant filtering closer to the data.

Without RLS, every frontend query must remember:

```js
.eq('clinic_id', activeClinicId)
```

That is still useful for performance and clarity, but it is not sufficient as the only defense.

With RLS, even if a dashboard query forgets a filter, Supabase should still deny rows outside the user’s memberships.

### What RLS Does Not Solve

RLS does not protect you from service-role contexts.

n8n workflows and admin scripts may use privileged credentials that bypass RLS. That is why workflow SQL must also include tenant filters.

This gives us two layers:

```text
Dashboard/client path -> RLS enforced
n8n/service path      -> explicit tenant-safe SQL + DB constraints
```

## 8. Public QR Intake Design

Patient intake is public. That makes it one of the highest-risk surfaces.

The safe design is:

```text
Clinic has a unique QR
QR contains opaque token in URL fragment
Browser submits intake_token
n8n resolves token server-side
Database maps token hash -> clinic_id
WF11 creates patient + visit under that clinic
```

The QR looks like:

```text
https://your-patient-form.example/#/i/<token>
```

The token is a random 64-character value. The database stores only its SHA-256 hash.

### Why Use A URL Fragment?

The fragment is the part after `#`.

Browsers do not send fragments to the web server during the initial HTTP request.

That reduces accidental leakage through:

- CDN logs
- static hosting logs
- reverse proxies
- analytics tools
- referrer headers

The browser JavaScript reads the fragment and submits the token in the form body.

### Why Not Use `?clinic_id=...`

Raw query parameters are easy to tamper with and easy to leak.

If the old model allowed:

```text
patient-form.html?clinic_id=<clinic uuid>
```

then an attacker could:

- replace the clinic id
- submit fake patients into another clinic
- test which clinic ids exist
- share a malicious link
- create noisy or misleading patient queues

The opaque token model reduces that risk:

- token is random and unguessable
- token can be disabled
- token can expire
- token maps to a clinic server-side
- token is stored hashed

### Should Every Clinic Have A Separate QR?

Yes.

Each clinic should have at least one QR token.

In practice, a clinic may have more than one:

- front desk QR
- doctor room QR
- campaign QR
- temporary event QR

That gives you rotation and auditability.

If one QR is exposed or printed incorrectly, disable only that token.

## 9. Patient Intake Flow

The hardened intake flow is:

```text
Patient scans clinic QR
  -> patient-form reads #/i/<token>
  -> patient fills name, phone, doctor, visit date
  -> form submits intake_token, not clinic_id
  -> WF11 validates fields
  -> WF11 calls resolve_public_intake_token(token)
  -> database returns clinic and doctors for active token
  -> WF11 verifies selected doctor belongs to that clinic
  -> patient is upserted by (clinic_id, phone)
  -> visit is inserted with same clinic_id
  -> WF7 sends welcome WhatsApp
```

### What Problem This Solves

The patient form is public and untrusted.

So we do not trust:

- user-selected clinic id
- query parameter clinic id
- text hospital name
- hidden fields
- localStorage values

The only clinic routing signal is the token, and the token is resolved on the server side.

## 10. Hospital Onboarding Flow

Hospital onboarding creates or records clinic and doctor onboarding data.

This is still a sensitive area because it can create tenant records.

The current hardening removes URL-based `clinic_id` linking from the public form.

That means a public caller cannot attach onboarding data to an arbitrary existing clinic by posting a forged `clinic_id`.

### Remaining Recommended Improvement

For production, hospital onboarding should ideally become authenticated:

```text
platform admin login
  -> create clinic
  -> create onboarding row
  -> create doctor profile or invitation
  -> create QR token
```

Public onboarding is convenient, but tenant creation is a privileged operation. Treat it as admin work before scaling.

## 11. Doctor Dashboard Design

The doctor dashboard is authenticated through Supabase Auth.

The dashboard flow is:

```text
Doctor signs in
  -> Supabase Auth identifies user
  -> doctor profile/membership is loaded
  -> activeClinicId is selected from membership/profile
  -> dashboard queries visits, patients, prescriptions with clinic_id
  -> RLS enforces membership
```

The dashboard also explicitly filters by `clinic_id`.

This is useful even though RLS exists:

- better performance
- clearer intent
- smaller result sets
- easier debugging
- less accidental broad querying

### Why Query-Config From URL Was Removed

The dashboard previously allowed runtime config like Supabase URL or anon key through URL query parameters.

That is dangerous because a crafted URL could trick a doctor into authenticating against attacker-controlled infrastructure.

This is a phishing and data-exfiltration risk.

Runtime config should come from trusted deployment config, not arbitrary URL parameters.

## 12. Prescription Issue And Delivery

Prescription delivery is sensitive because it involves medical documents.

The designed path is:

```text
Doctor issues prescription
  -> dashboard generates PDF
  -> PDF uploaded to private Supabase Storage
  -> prescription row stores storage path and signed URL
  -> dashboard calls prescription-delivery Edge Function
  -> Edge Function verifies doctor session through Supabase Auth/RLS
  -> Edge Function sends WhatsApp via Twilio
  -> message_logs records clinic_id and Twilio SID
```

### Why Use An Edge Function?

The dashboard should never contain service-role secrets or Twilio auth tokens.

The Edge Function acts as a secure server boundary:

- verifies the doctor session
- reads prescription only if accessible
- signs short PDF links
- talks to Twilio using server-side secrets
- logs delivery result

### PDF Link Security

Prescription PDF links are now HMAC-bound to:

- prescription id
- clinic id
- expiry timestamp

Conceptually:

```text
token = HMAC(secret, "pdf:<prescription_id>:<clinic_id>:<expiry>")
```

The public PDF gateway checks:

- id format
- clinic id format
- expiry
- token validity
- prescription exists for that clinic
- prescription status is issued

### What If We Only Used A Stored Signed URL?

A stored signed URL can outlive the intended sharing semantics or be forwarded.

An HMAC gateway gives more control:

- expiry is explicit
- token format is controlled by us
- clinic context is bound
- gateway can log access later
- gateway can be extended for revocation

## 13. Twilio Callback Design

Twilio sends two important inbound surfaces:

- inbound patient replies
- status callbacks for sent/delivered/read/failed messages

These are public webhooks, so they must be treated as untrusted until verified.

The production requirement is:

```text
TWILIO_VALIDATE_WEBHOOK_SIGNATURE=true
```

### Why Signature Validation Matters

Without signature validation, anyone who knows the webhook URL could spoof:

- message delivery status
- inbound reply text
- cancellation/confirmation responses
- failure events

That could corrupt patient state or message audit trails.

### Why Message SID Matters

Status callbacks should update rows by Twilio message SID.

The SID is the provider’s durable message identifier.

Phone-only matching is weak because the same patient phone may appear in multiple clinics.

The safer pattern is:

```text
Outbound send writes message_logs with clinic_id + twilio_message_sid
Twilio callback sends MessageSid
WF9 updates matching message row
```

## 14. n8n Workflow Design Principles

n8n is the orchestration layer.

It handles:

- patient intake
- hospital onboarding
- scheduled reminders
- missed appointment recovery
- health checks
- reactivation
- inbound replies
- delivery status callbacks
- error logging

### Principle: Workflows Must Carry `clinic_id`

Every workflow touching tenant-owned data must carry tenant context.

Examples:

- scheduled reminders query patients with `clinic_id`
- message logs insert `clinic_id`
- message ledger uniqueness includes `clinic_id`
- patient upsert uses `(clinic_id, phone)`
- visit insert copies the same `clinic_id`

### Why This Matters With Service Credentials

n8n often uses privileged Postgres credentials.

That means RLS may not protect workflow operations.

So workflow SQL must be written as if it is its own security boundary.

Bad pattern:

```sql
select * from patients where phone = '+919...';
```

Good pattern:

```sql
select * from patients
where clinic_id = $clinic_id
  and phone = $phone;
```

### Scheduled Workflow Idempotency

Reminder workflows must avoid duplicate messages.

The system uses tenant-aware idempotency:

```text
clinic_id + patient_id + message_type + scheduled_date
```

Without `clinic_id`, two clinics with similar patient data could collide in the ledger.

## 15. Logging And Audit Design

Logs are not just debugging output. In healthcare workflows, they are operational evidence.

Important log categories:

- message send attempts
- delivery status
- webhook validation failures
- prescription delivery failures
- profile claims
- role changes
- PDF access

Every log row should include `clinic_id` where possible.

### Why Tenant-Aware Logs Matter

Imagine an incident:

> A patient says they received the wrong prescription link.

To investigate, you need to answer:

- which clinic sent the message?
- which workflow sent it?
- which Twilio SID was used?
- which prescription id was linked?
- which doctor issued it?
- when was it delivered?

Without tenant-aware logs, incident response becomes guesswork.

## 16. Data Handling Principles

This system handles sensitive health-related data. The design should follow these data handling rules:

### Store Only What You Need

Do not store full message bodies in places where metadata is enough.

Do not log secrets, OTPs, auth headers, or full request bodies.

### Separate Display Fields From Authorization Fields

Display fields:

- `clinic_name`
- `doctor_name`
- snapshots

Authorization fields:

- `clinic_id`
- `user_id`
- `clinic_memberships.role`

Display fields can be copied, renamed, or historically preserved.

Authorization fields must be stable and enforced.

### Prefer Immutable Clinical Snapshots

When a prescription is issued, preserve doctor and clinic snapshots.

That way, future profile edits do not change the historical prescription context.

This is important for auditability.

## 17. Failure Modes And How The Design Responds

### Missing `clinic_id`

Database `NOT NULL` constraints reject it.

Workflow validation should catch it earlier.

### Wrong clinic token

WF11 rejects the intake token before patient creation.

### Same patient phone in two clinics

Allowed because uniqueness is `(clinic_id, phone)`.

### Doctor tries to read another clinic

RLS denies rows without matching membership.

Dashboard also filters by active clinic.

### n8n forgets tenant filter

The workflow tenancy lint script is designed to catch common unsafe SQL patterns.

DB constraints also reduce damage.

### Duplicate reminders

The message ledger uses tenant-aware idempotency.

### Forged Twilio callback

Production signature validation should reject it.

### Forwarded prescription link

The PDF link expires and is HMAC-signed.

Tenant binding reduces cross-clinic misuse.

## 18. How To Think Like A System Designer

When designing a new feature in this project, ask these questions in order.

### 1. What Is The Tenant?

Which `clinic_id` owns this data?

If there is no clear answer, stop and define it.

### 2. Who Is The Actor?

Is the actor:

- anonymous patient
- authenticated doctor
- clinic admin
- staff
- platform admin
- n8n workflow
- Twilio callback

Each actor has different trust.

### 3. Where Is Authorization Enforced?

Possible layers:

- frontend validation
- n8n validation
- Edge Function auth
- RLS
- SQL constraints
- triggers

Use more than one layer for sensitive flows.

### 4. What Can The Client Tamper With?

Assume any browser-supplied value can be changed.

Never trust:

- hidden inputs
- query parameters
- localStorage
- display names
- client-side selected ids

Use them for UX only, not authority.

### 5. What Is The Idempotency Key?

Any external call can be retried.

Any webhook can be delivered more than once.

Define the key that prevents duplicate effects.

### 6. What Is Logged?

For every sensitive action, record:

- clinic
- actor
- patient or prescription id
- workflow/function
- external provider id
- timestamp
- outcome

### 7. What Happens If This Fails Halfway?

For multi-step operations, think transactionally:

- what is committed first?
- can the workflow retry safely?
- will a duplicate message be sent?
- will the doctor see an inconsistent status?

## 19. Why The Current Design Solves The Main Risks

| Risk | Weak Design | Current Design |
|---|---|---|
| Cross-clinic patient overwrite | `unique(phone)` | `unique(clinic_id, phone)` |
| Tenant spoofing from QR URL | `?clinic_id=...` | opaque intake token resolved server-side |
| Doctor reads another clinic | name/phone matching | Supabase Auth + `clinic_memberships` + RLS |
| Workflow scans all clinics | global SQL | tenant-aware SQL and linting |
| Duplicate messages | patient-only ledger | tenant-aware message ledger |
| PDF link misuse | long-lived signed URL only | expiring HMAC link bound to clinic |
| Callback spoofing | open webhook | Twilio signature validation |
| Poor incident response | global logs | tenant-aware logs and SIDs |

## 20. Practical Development Rules

Use these as day-to-day engineering rules.

1. Every tenant-owned table gets `clinic_id`.
2. Every tenant-owned query includes `clinic_id`.
3. Do not authorize by text names.
4. Do not trust public form fields for tenant identity.
5. Use RLS for authenticated client access.
6. Use explicit SQL filters for n8n and service-role paths.
7. Add composite indexes that start with `clinic_id`.
8. Add idempotency before calling external providers.
9. Put secrets only in server-side environments.
10. Log enough for audit, but do not log sensitive bodies unnecessarily.

## 21. Where To Look In The Codebase

Important files:

- `schemas/migration-v0-multitenant.sql`
  - tenant tables
  - RLS policies
  - consistency triggers
  - QR intake token functions
  - tenant validation view

- `patient-form/index.html`
  - QR token extraction
  - public patient intake UX
  - token-based clinic loading

- `workflows/workflow-11-form-intake.json`
  - server-side form validation
  - intake token resolution
  - patient upsert
  - visit creation

- `doctor-dashboard/index.html`
  - authenticated clinic-scoped dashboard
  - prescription issue
  - PDF upload

- `supabase/functions/prescription-delivery/index.ts`
  - authenticated prescription delivery gateway
  - Twilio send
  - short PDF link generation

- `supabase/functions/prescription-pdf/index.ts`
  - public PDF redirect gateway
  - HMAC and expiry validation

- `scripts/lint-workflow-tenancy.js`
  - static workflow SQL safety check

- `scripts/validate-tenant-isolation.js`
  - database validation checks after migration

## 22. Mental Model To Remember

The safest way to understand this system is:

```text
Public users can submit intent.
Authenticated users can act within memberships.
Workflows can automate, but must carry tenant context.
The database is the final authority.
```

Or even shorter:

> Identity comes from trusted resolution, authorization comes from memberships, and isolation is enforced by `clinic_id`.

That is the spine of the architecture.

