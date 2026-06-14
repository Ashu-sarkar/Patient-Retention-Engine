#!/usr/bin/env python3
"""
Deploy and configure doctor-dashboard OTP delivery via Supabase Send SMS hook.

Uses Supabase CLI (not Management API) to avoid Cloudflare blocks on api.supabase.com.
"""
from __future__ import annotations

import base64
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
TEST_PHONE = "+919685722570"
MGMT_BASE = "https://api.supabase.com/v1"
MGMT_UA = "supabase-cli/2.106.0 (vaitalcare-doctor-otp)"


def mgmt_patch_auth(token: str, ref: str, hook_secrets: str, fn_url: str) -> bool:
    """Force-update auth hook secret via Management API (config push may not rotate secrets)."""
    body = {
        "external_phone_enabled": True,
        "hook_send_sms_enabled": True,
        "hook_send_sms_uri": fn_url,
        "hook_send_sms_secrets": hook_secrets,
    }
    payload = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{MGMT_BASE}/projects/{ref}/config/auth",
        data=payload,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": MGMT_UA,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"  Management API auth PATCH HTTP {resp.status}")
            return True
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        print(f"  Management API auth PATCH failed HTTP {exc.code}: {detail[:300]}")
        return False


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not ENV_PATH.exists():
        return env
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def append_env(key: str, value: str) -> None:
    with ENV_PATH.open("a") as f:
        f.write(f"\n{key}={value}\n")
    print(f"  Saved {key} to .env")


def cli_env(token: str, env: dict[str, str]) -> dict[str, str]:
    deploy_env = {**os.environ, **env, "SUPABASE_ACCESS_TOKEN": token}
    nvm_node = Path.home() / ".nvm"
    node_bins = sorted(nvm_node.glob("versions/node/*/bin"), reverse=True)
    if node_bins:
        deploy_env["PATH"] = str(node_bins[0]) + ":" + deploy_env.get("PATH", "")
    return deploy_env


def write_functions_env(hook_secrets: str) -> None:
    """Supabase config push resolves env(SEND_SMS_HOOK_SECRETS) from supabase/functions/.env."""
    fn_env = ROOT / "supabase" / "functions" / ".env"
    fn_env.write_text(f"SEND_SMS_HOOK_SECRETS={hook_secrets}\n")
    print(f"  Wrote {fn_env.relative_to(ROOT)} for config push")


def run_cli(token: str, env: dict[str, str], args: list[str]) -> int:
    return subprocess.run(
        ["npx", "supabase", *args],
        env=cli_env(token, env),
        cwd=str(ROOT),
    ).returncode


def anon_key(env: dict[str, str]) -> str:
    if env.get("SUPABASE_ANON_KEY"):
        return env["SUPABASE_ANON_KEY"]
    dash = ROOT / "doctor-dashboard" / "index.html"
    if dash.exists():
        m = re.search(r"DEFAULT_SUPABASE_ANON_KEY\s*=\s*'([^']+)'", dash.read_text())
        if m and "YOUR_" not in m.group(1):
            return m.group(1)
    return ""


def test_otp_request(supabase_url: str, anon_key: str) -> bool:
    print("\n=== Step 6: Test OTP request ===")
    if not anon_key:
        print("  SKIP: no SUPABASE_ANON_KEY available for test")
        return False

    url = f"{supabase_url.rstrip('/')}/auth/v1/otp"
    payload = json.dumps({"phone": TEST_PHONE}).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "apikey": anon_key,
            "Content-Type": "application/json",
            "User-Agent": "vaitalcare-doctor-otp-test/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode(errors="replace")
            print(f"  HTTP {resp.status} — OTP request accepted for {TEST_PHONE}")
            if body.strip():
                print(f"  Body: {body[:200]}")
            print("  Check WhatsApp on that number for the login code.")
            return True
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        print(f"  HTTP {exc.code} — OTP request failed")
        print(f"  {detail[:400]}")
        return False


def main() -> None:
    env = load_env()
    env.update(os.environ)

    print("\n=== Step 1: Checking required variables ===")
    for key in ("SUPABASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"):
        print(f"  {key}: {'OK' if env.get(key) else 'MISSING'}")

    if not env.get("SUPABASE_ACCESS_TOKEN"):
        print("\n  SUPABASE_ACCESS_TOKEN is not set.")
        print("  Get one at: https://supabase.com/dashboard/account/tokens")
        sys.exit(1)

    for key in ("SUPABASE_URL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"):
        if not env.get(key):
            sys.exit(f"Missing {key}")

    token = env["SUPABASE_ACCESS_TOKEN"]
    m = re.search(r"https://([^.]+)\.supabase\.co", env["SUPABASE_URL"])
    if not m:
        sys.exit("Could not parse project ref from SUPABASE_URL")
    ref = m.group(1)

    print("\n=== Step 2: Hook secret ===")
    hook_secrets = env.get("SEND_SMS_HOOK_SECRETS", "")
    if not hook_secrets:
        hook_secrets = f"v1,whsec_{base64.b64encode(secrets.token_bytes(32)).decode()}"
        append_env("SEND_SMS_HOOK_SECRETS", hook_secrets)
    else:
        print("  Already set.")

    write_functions_env(hook_secrets)

    print("\n=== Step 3: Uploading edge function secrets (CLI) ===")
    secret_args = [
        "secrets", "set", "--project-ref", ref,
        f"SEND_SMS_HOOK_SECRETS={hook_secrets}",
        f"TWILIO_ACCOUNT_SID={env['TWILIO_ACCOUNT_SID']}",
        f"TWILIO_AUTH_TOKEN={env['TWILIO_AUTH_TOKEN']}",
        f"TWILIO_WHATSAPP_FROM={env['TWILIO_WHATSAPP_FROM']}",
    ]
    doctor_otp_sid = env.get("TWILIO_CONTENT_DOCTOR_OTP", "").strip()
    if doctor_otp_sid:
        secret_args.append(f"TWILIO_CONTENT_DOCTOR_OTP={doctor_otp_sid}")
    else:
        print("  Warning: TWILIO_CONTENT_DOCTOR_OTP missing — run: npm run push:twilio-templates -- --only=doctor_dashboard_otp --submit-approval")
    status_cb = env.get("TWILIO_STATUS_CALLBACK_URL", "")
    if status_cb:
        secret_args.append(f"TWILIO_STATUS_CALLBACK_URL={status_cb}")
    code = run_cli(token, env, secret_args)
    if code != 0:
        sys.exit("  secrets set failed")
    print("  Secrets uploaded.")

    print("\n=== Step 4: Deploying send-sms-hook edge function ===")
    code = run_cli(token, env, [
        "functions", "deploy", "send-sms-hook",
        "--project-ref", ref, "--no-verify-jwt", "--use-api",
    ])
    if code != 0:
        sys.exit("  Edge function deploy failed")
    print("  send-sms-hook deployed.")

    print("\n=== Step 5: Pushing auth hook config (config.toml) ===")
    code = run_cli(token, env, ["config", "push", "--project-ref", ref])
    if code != 0:
        sys.exit("  config push failed")
    print("  Auth hook enabled via config.toml")

    print("\n=== Step 5b: Force auth hook secret via Management API ===")
    fn_url = f"https://{ref}.supabase.co/functions/v1/send-sms-hook"
    if not mgmt_patch_auth(token, ref, hook_secrets, fn_url):
        print("  Warning: Management API patch failed; hook secret may still be mismatched.")

    ok = test_otp_request(env["SUPABASE_URL"], anon_key(env))

    print("\n=== Done ===")
    if ok:
        print("  OTP API accepted the request. Verify WhatsApp delivery on the test phone.")
    else:
        print("  Deploy succeeded but OTP API test failed — check Supabase Auth logs.")
    print(f"  Dashboard: https://vaitalcare-doctor.vercel.app/")


if __name__ == "__main__":
    main()
