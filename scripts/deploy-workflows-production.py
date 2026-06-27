#!/usr/bin/env python3
"""Push messaging workflows to production n8n and re-activate them."""

from __future__ import annotations

import copy
import http.cookiejar
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WF_DIR = ROOT / "workflows"
TARGETS = {
    "WF1 — Follow-up Reminder": "workflow-1-followup-reminder.json",
    "WF2 — Same-day Reminder": "workflow-2-sameday-reminder.json",
    "WF3 — Missed Appointment": "workflow-3-missed-appointment.json",
    "WF4 — Health Check": "workflow-4-health-check.json",
    "WF5 — Reactivation": "workflow-5-reactivation.json",
    "WF6 — Feedback Listener": "workflow-6-feedback-listener.json",
    "WF7 — New Patient Welcome": "workflow-7-new-patient.json",
    "WF11 — QR Form Intake": "workflow-11-form-intake.json",
    "WF12 — Hospital / Clinic Boarding": "workflow-12-hospital-boarding.json",
    "WF13 — Prescription Delivery": "workflow-13-prescription-delivery.json",
    "WF14 — Medicine Journey Reminders": "workflow-14-medicine-journey.json",
}


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def replace_runtime(value, env: dict[str, str]):
    if isinstance(value, str):
        return (
            value.replace("__TWILIO_ACCOUNT_SID__", env.get("TWILIO_ACCOUNT_SID", ""))
            .replace("__TWILIO_WHATSAPP_FROM__", env.get("TWILIO_WHATSAPP_FROM", ""))
            .replace("__WEBHOOK_URL__", env.get("WEBHOOK_URL", "").rstrip("/"))
            .replace("__TWILIO_STATUS_CALLBACK_URL__", env.get("TWILIO_STATUS_CALLBACK_URL", ""))
        )
    if isinstance(value, list):
        return [replace_runtime(item, env) for item in value]
    if isinstance(value, dict):
        return {k: replace_runtime(v, env) for k, v in value.items()}
    return value


class Client:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )

    def request(self, method: str, path: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.base}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with self.opener.open(req, timeout=60) as res:
                text = res.read().decode()
                payload = json.loads(text) if text else {}
                return res.status, payload
        except urllib.error.HTTPError as exc:
            text = exc.read().decode()
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {"_raw": text[:300]}
            return exc.code, payload

    def login(self, email: str, password: str) -> None:
        for attempt in range(1, 31):
            status, payload = self.request(
                "POST",
                "/rest/login",
                {"emailOrLdapLoginId": email, "password": password},
            )
            if status == 404:
                time.sleep(2)
                continue
            if status >= 400:
                raise RuntimeError(f"login failed ({status}): {payload}")
            print(f"  logged in as {payload.get('data', {}).get('email', email)}")
            return
        raise RuntimeError("login route never became available")

    def list_workflows(self):
        status, payload = self.request("GET", "/rest/workflows")
        if status >= 400:
            raise RuntimeError(f"list workflows failed: {payload}")
        return payload.get("data", [])

    def patch_workflow(self, wf_id: str, wf: dict) -> None:
        patch = {
            "name": wf["name"],
            "nodes": wf["nodes"],
            "connections": wf["connections"],
            "settings": wf.get("settings") or {},
            "staticData": wf.get("staticData"),
            "pinData": wf.get("pinData") or {},
            "tags": wf.get("tags") or [],
        }
        status, payload = self.request("PATCH", f"/rest/workflows/{wf_id}", patch)
        if status >= 400:
            raise RuntimeError(f"patch failed: {payload}")

    def activate(self, wf_id: str) -> None:
        self.request("POST", f"/rest/workflows/{wf_id}/deactivate")
        time.sleep(0.5)
        status, payload = self.request("GET", f"/rest/workflows/{wf_id}")
        version_id = payload.get("data", {}).get("versionId")
        if not version_id:
            raise RuntimeError(f"missing versionId for {wf_id}")
        status, payload = self.request(
            "POST",
            f"/rest/workflows/{wf_id}/activate",
            {"versionId": version_id},
        )
        if status >= 400:
            raise RuntimeError(f"activate failed: {payload}")


def main() -> int:
    env = load_env()
    base = env.get("WEBHOOK_URL", "").rstrip("/")
    email = env.get("N8N_OWNER_EMAIL", "")
    password = env.get("N8N_OWNER_PASSWORD", "")
    if not base or not email or not password:
        print("WEBHOOK_URL, N8N_OWNER_EMAIL, and N8N_OWNER_PASSWORD required in .env")
        return 1

    client = Client(base)
    print(f"Pushing workflows to {base}")
    client.login(email, password)
    existing = {wf["name"]: wf for wf in client.list_workflows() if not wf.get("isArchived")}

    for wf_name, filename in TARGETS.items():
        wf = json.loads((WF_DIR / filename).read_text())
        wf = replace_runtime(wf, env)
        wf.pop("versionId", None)
        wf.pop("activeVersionId", None)
        found = existing.get(wf_name)
        if not found:
            print(f"  skip {wf_name}: not found in n8n")
            continue
        client.patch_workflow(found["id"], wf)
        client.activate(found["id"])
        print(f"  ✅ patched + activated {wf_name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
