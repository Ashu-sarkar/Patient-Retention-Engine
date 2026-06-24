#!/usr/bin/env python3
"""Clean production patient/clinic test data and run hospital + patient E2E checks."""

from __future__ import annotations

import json
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

try:
    import psycopg2
except ImportError:
    print("Install psycopg2-binary: pip3 install psycopg2-binary")
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
PHONE_RAW = "9685722570"
PHONE_E164 = f"+91{PHONE_RAW}"
HOSPITAL = "VaitalCare E2E Hospital"
DOCTOR = "Dr Ashu E2E"
PATIENT_NAME = "Dummy Test Patient"
PROD_BASE = "https://vaitalcare-production.up.railway.app"
RAILWAY_HOST = "vaitalcare-production.up.railway.app"
RAILWAY_IP = "66.33.22.247"


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    env_path = ROOT / ".env"
    if not env_path.exists():
        return env
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def db_connect(env: dict[str, str]):
    return psycopg2.connect(
        host=env.get("SUPABASE_DB_HOST"),
        port=int(env.get("SUPABASE_DB_PORT", "5432")),
        dbname=env.get("SUPABASE_DB_NAME", "postgres"),
        user=env.get("SUPABASE_DB_USER"),
        password=env.get("SUPABASE_DB_PASSWORD"),
        connect_timeout=30,
    )


def table_exists(cur, table: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = %s
        """,
        (table,),
    )
    return cur.fetchone() is not None


def column_exists(cur, table: str, column: str) -> bool:
    cur.execute(
        """
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
        """,
        (table, column),
    )
    return cur.fetchone() is not None


def seed_intake_token(cur, clinic_id: str, label: str = "Cleanup E2E QR") -> str:
    token = secrets.token_hex(32)
    cur.execute(
        """
        INSERT INTO public.clinic_intake_tokens (clinic_id, token_hash, label, status)
        VALUES (%s::uuid, public.hash_intake_token(%s), %s, 'active')
        """,
        (clinic_id, token, label),
    )
    return token


def get_boarding_clinic_id(cur, hospital: str) -> str | None:
    cur.execute(
        """
        SELECT clinic_id::text
        FROM public.hospital_boarding
        WHERE lower(trim(hospital_name)) = lower(trim(%s))
        ORDER BY created_at DESC LIMIT 1
        """,
        (hospital,),
    )
    row = cur.fetchone()
    return row[0] if row else None


def cleanup_data(cur) -> None:
    print("\n── Cleaning patient/clinic data ──")
    cur.execute("SET session_replication_role = 'replica'")
    truncate_tables = [
        "prescription_audit_logs",
        "prescription_medicines",
        "prescriptions",
        "patient_visits",
        "message_logs",
        "message_ledger",
        "patients",
        "clinic_intake_tokens",
        "clinic_patient_code_counters",
        "hospital_boarding",
        "doctor_profiles",
        "clinics",
    ]
    existing = [t for t in truncate_tables if table_exists(cur, t)]
    if existing:
        cur.execute(
            "TRUNCATE TABLE "
            + ", ".join(f"public.{t}" for t in existing)
            + " RESTART IDENTITY CASCADE"
        )
        print(f"  truncated {len(existing)} tables: {', '.join(existing)}")
    cur.execute("SET session_replication_role = 'origin'")


def curl_form(path: str, fields: dict[str, str]) -> tuple[int, dict]:
    body = urllib.parse.urlencode(fields).encode()
    url = f"{PROD_BASE}/webhook/{path}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    ctx = ssl.create_default_context()
    # Resolve Railway host to known IP (DNS workaround used by production E2E)
    class ResolveHandler(urllib.request.HTTPHandler):
        def http_open(self, http_class, req):
            return super().http_open(http_class, req)

    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    # Use curl subprocess for --resolve support
    import subprocess

    form = urllib.parse.urlencode(fields)
    cmd = [
        "curl", "-sS",
        "--resolve", f"{RAILWAY_HOST}:443:{RAILWAY_IP}",
        "-w", "\n__HTTP__%{http_code}",
        "-X", "POST",
        f"{PROD_BASE}/webhook/{path}",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-d", form,
    ]
    out = subprocess.check_output(cmd, text=True)
    idx = out.rfind("\n__HTTP__")
    text = out[:idx] if idx >= 0 else out
    status = int(out[idx + 9:]) if idx >= 0 else 0
    try:
        payload = json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        payload = {"_raw": text[:300]}
    return status, payload


def today(offset: int = 0) -> str:
    return (date.today() + timedelta(days=offset)).isoformat()


def assert_ok(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> int:
    env = load_env()
    passed = 0
    failed = 0
    failures: list[str] = []

    def test(label: str, fn) -> None:
        nonlocal passed, failed
        sys.stdout.write(f"  {label} … ")
        try:
            fn()
            print("✅ PASS")
            passed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"❌ FAIL\n       → {exc}")
            failed += 1
            failures.append(f"{label}: {exc}")

    print("╔══════════════════════════════════════════════════════════╗")
    print("║   Cleanup + Production E2E (Hospital + Patient forms)   ║")
    print("╚══════════════════════════════════════════════════════════╝")
    print(f"  Phone     : {PHONE_RAW}")
    print(f"  Hospital  : {HOSPITAL}")
    print(f"  Patient   : {PATIENT_NAME}")

    # ── Safety guard ───────────────────────────────────────────────────────────
    # cleanup_data() TRUNCATEs ALL clinic/patient/prescription data (every tenant),
    # not just the E2E rows, against production. Require explicit opt-in.
    if "--yes-truncate-production" not in sys.argv:
        print(
            "\n⛔ Refusing to run.\n"
            f"   This will TRUNCATE ALL clinic/patient/prescription data on {PROD_BASE}.\n"
            "   Every tenant's data will be deleted, not just the E2E test rows.\n"
            "   Re-run with --yes-truncate-production if you really mean it."
        )
        return 2

    # ── Cleanup ──────────────────────────────────────────────────────────────
    try:
        with db_connect(env) as conn:
            conn.autocommit = False
            with conn.cursor() as cur:
                cleanup_data(cur)
            conn.commit()
            print("  ✅ DB cleanup committed")
    except Exception as exc:  # noqa: BLE001
        print(f"  ❌ DB cleanup failed: {exc}")
        return 1

    boarding = {
        "hospital_name": HOSPITAL,
        "facility_type": "Pathology Lab",
        "address": "42 Dummy Test Lane, Bangalore",
        "city": "Bangalore",
        "contact_phone": PHONE_RAW,
        "admin_contact_name": "Dummy Admin",
        "clinic_logo_url": "",
        "clinic_email": "dummy@vaitalcare.test",
        "clinic_website": "https://vaitalcare.example",
        "doctor_name": DOCTOR,
        "doctor_qualification": "MBBS",
        "doctor_expertise": "General Medicine",
        "doctor_registration_number": "DUMMY-REG-96857",
        "doctor_phone": PHONE_E164,
        "doctor_signature_url": "",
        "consultation_hours": "Mon-Sat 9am-5pm",
    }
    boarding["doctor_count"] = "1"
    boarding["login_username"] = "cleanup.doctor"
    boarding["doctors_json"] = json.dumps([
        {
            "doctor_name": boarding["doctor_name"],
            "doctor_qualification": boarding["doctor_qualification"],
            "doctor_expertise": boarding["doctor_expertise"],
            "doctor_registration_number": boarding["doctor_registration_number"],
            "doctor_phone": boarding["doctor_phone"],
            "doctor_signature_url": boarding["doctor_signature_url"],
            "login_username": boarding["login_username"],
            "password": "CleanupPass123",
        }
    ])

    intake = {
        "patient_name": PATIENT_NAME,
        "phone_number": PHONE_RAW,
        "dob": "1990-05-20",
        "sex": "Male",
        "hospital_name": HOSPITAL,
        "doctor_name": DOCTOR,
        "visit_date": today(0),
        "clinic_mode": "clinic_qr",
        "intake_token": "",
    }
    intake_token = {"value": ""}

    print("\n── §1 Infrastructure ──")
    def infra_healthz() -> None:
        import subprocess
        out = subprocess.check_output(
            [
                "curl", "-sS",
                "--resolve", f"{RAILWAY_HOST}:443:{RAILWAY_IP}",
                "-w", "\n__HTTP__%{http_code}",
                f"{PROD_BASE}/healthz",
            ],
            text=True,
        )
        idx = out.rfind("\n__HTTP__")
        status = int(out[idx + 9:])
        body = json.loads(out[:idx])
        assert_ok(status == 200, f"healthz {status}")
        assert_ok(body.get("status") == "ok", str(body))

    def infra_wf11_validation() -> None:
        import subprocess
        out = subprocess.check_output(
            [
                "curl", "-sS",
                "--resolve", f"{RAILWAY_HOST}:443:{RAILWAY_IP}",
                "-w", "\n__HTTP__%{http_code}",
                "-X", "POST",
                f"{PROD_BASE}/webhook/patient-form-intake",
                "-H", "Content-Type: application/json",
                "-d", "{}",
            ],
            text=True,
        )
        idx = out.rfind("\n__HTTP__")
        status = int(out[idx + 9:])
        body = json.loads(out[:idx] or "{}")
        assert_ok(status == 400, f"expected 400, got {status}")
        assert_ok(body.get("status") == "error", str(body))

    test("1.1 Railway healthz", infra_healthz)
    test("1.2 WF11 empty body → 400", infra_wf11_validation)

    print("\n── §2 Hospital registration (WF12) ──")
    def hospital_happy() -> None:
        status, body = curl_form("hospital-boarding", boarding)
        assert_ok(status == 200, f"status {status}: {body}")
        assert_ok(body.get("status") == "success", str(body))
        assert_ok(body.get("hospital_name") == HOSPITAL, str(body))

    def hospital_invalid() -> None:
        bad = dict(boarding)
        bad["hospital_name"] = f"{HOSPITAL} Invalid"
        bad["facility_type"] = "Veterinary Clinic"
        status, body = curl_form("hospital-boarding", bad)
        assert_ok(status == 400, f"expected 400, got {status}: {body}")
        assert_ok(isinstance(body.get("errors"), list), str(body))

    def hospital_row() -> None:
        with db_connect(env) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT hospital_name, doctor_name, doctor_phone
                FROM public.hospital_boarding
                WHERE lower(trim(hospital_name)) = lower(trim(%s))
                ORDER BY created_at DESC LIMIT 1
                """,
                (HOSPITAL,),
            )
            row = cur.fetchone()
        assert_ok(row, "hospital_boarding row missing")
        assert_ok(row[0] == HOSPITAL, f"hospital_name {row[0]}")
        assert_ok(row[1] == DOCTOR, f"doctor_name {row[1]}")
        phone = (row[2] or "").replace(" ", "")
        assert_ok(phone in {PHONE_E164, PHONE_RAW}, f"doctor_phone {row[2]}")

    test("2.1 Valid hospital boarding", hospital_happy)
    test("2.2 Boarding row in Supabase", hospital_row)
    test("2.3 Invalid facility_type → 400", hospital_invalid)

    def seed_qr_token() -> None:
        with db_connect(env) as conn, conn.cursor() as cur:
            clinic_id = get_boarding_clinic_id(cur, HOSPITAL)
            assert_ok(clinic_id, "clinic_id missing after hospital boarding")
            token = seed_intake_token(cur, clinic_id)
            conn.commit()
        intake_token["value"] = token
        intake["intake_token"] = token

    test("2.4 Seed clinic QR token for patient intake", seed_qr_token)

    print("\n── §3 Patient registration (WF11) ──")
    visit_id = {"value": None}

    def patient_happy() -> None:
        status, body = curl_form("patient-form-intake", intake)
        assert_ok(status == 200, f"status {status}: {body}")
        assert_ok(body.get("status") == "success", str(body))
        assert_ok(body.get("patient_code"), f"missing patient_code: {body}")
        assert_ok(body.get("visit_id"), f"missing visit_id: {body}")
        visit_id["value"] = body["visit_id"]

    def patient_db() -> None:
        with db_connect(env) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT id::text, patient_code, name, phone
                FROM public.patients
                WHERE phone IN (%s, %s)
                ORDER BY updated_at DESC LIMIT 1
                """,
                (PHONE_E164, PHONE_RAW),
            )
            pat = cur.fetchone()
            assert_ok(pat, "patient row missing")
            assert_ok(PATIENT_NAME.lower() in (pat[2] or "").lower(), f"name {pat[2]}")
            cur.execute(
                """
                SELECT id::text, visit_status, clinic_name, doctor_name
                FROM public.patient_visits
                WHERE patient_id = %s::uuid
                ORDER BY checked_in_at DESC LIMIT 1
                """,
                (pat[0],),
            )
            visit = cur.fetchone()
        assert_ok(visit, "patient_visits row missing")
        assert_ok(visit[1] == "waiting", f"visit_status {visit[1]}")
        assert_ok(visit[2] == HOSPITAL, f"clinic_name {visit[2]}")
        assert_ok(visit[3] == DOCTOR, f"doctor_name {visit[3]}")

    def patient_future_date() -> None:
        bad = dict(intake)
        bad["patient_name"] = "Dummy Future Patient"
        bad["visit_date"] = today(2)
        status, body = curl_form("patient-form-intake", bad)
        assert_ok(status == 400, f"expected 400, got {status}: {body}")
        errors = body.get("errors") or []
        assert_ok(any("visit_date" in str(e) for e in errors), str(body))

    def patient_bad_phone() -> None:
        bad = dict(intake)
        bad["phone_number"] = "12345"
        status, body = curl_form("patient-form-intake", bad)
        assert_ok(status == 400, f"expected 400, got {status}: {body}")

    def patient_reregister() -> None:
        updated = dict(intake)
        updated["patient_name"] = "Dummy Updated Patient"
        status, body = curl_form("patient-form-intake", updated)
        assert_ok(status == 200, f"status {status}: {body}")
        with db_connect(env) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT name FROM public.patients WHERE phone IN (%s, %s) LIMIT 1",
                (PHONE_E164, PHONE_RAW),
            )
            row = cur.fetchone()
        assert_ok(row and "Updated" in row[0], f"name not updated: {row}")

    test("3.1 Valid patient intake (clinic QR token)", patient_happy)
    test("3.2 Patient + visit rows in Supabase", patient_db)
    test("3.3 Future visit_date → 400", patient_future_date)
    test("3.4 Invalid phone → 400", patient_bad_phone)
    test("3.5 Re-registration updates name", patient_reregister)

    print("\n── Summary ──")
    print(f"  ✅ Passed: {passed}")
    print(f"  ❌ Failed: {failed}")
    if failures:
        print("\n  Failures:")
        for item in failures:
            print(f"    - {item}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
