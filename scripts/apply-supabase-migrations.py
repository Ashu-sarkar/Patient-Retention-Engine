#!/usr/bin/env python3
"""Apply preflight + multitenant SQL migrations to Supabase Postgres."""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import psycopg2
except ImportError:
    print("Install psycopg2-binary: pip3 install psycopg2-binary")
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]


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


def split_sql_statements(content: str) -> list[str]:
    statements: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(content)

    while i < n:
        if content.startswith("--", i):
            while i < n and content[i] != "\n":
                i += 1
            continue
        if content.startswith("/*", i):
            i += 2
            while i < n - 1 and not (content[i] == "*" and content[i + 1] == "/"):
                i += 1
            i += 2
            continue

        ch = content[i]
        if ch == "'":
            buf.append(ch)
            i += 1
            while i < n:
                if content[i] == "'":
                    if i + 1 < n and content[i + 1] == "'":
                        buf.append("''")
                        i += 2
                        continue
                    buf.append("'")
                    i += 1
                    break
                buf.append(content[i])
                i += 1
            continue

        if ch == "$":
            m = re.match(r"\$([a-zA-Z_0-9]*)\$", content[i:])
            if m:
                tag = m.group(0)
                buf.append(tag)
                i += len(tag)
                while i < n:
                    if content.startswith(tag, i):
                        buf.append(tag)
                        i += len(tag)
                        break
                    buf.append(content[i])
                    i += 1
                continue

        if ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                statements.append(stmt)
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return statements


def main() -> int:
    env = load_env()
    required = ["SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD"]
    missing = [k for k in required if not env.get(k)]
    if missing:
        print(f"Missing .env keys: {', '.join(missing)}")
        return 1

    files = [
        ROOT / "schemas" / "preflight-migrations.sql",
        ROOT / "schemas" / "migration-v0-multitenant.sql",
        ROOT / "schemas" / "migration-admin-console.sql",
    ]
    for path in files:
        if not path.exists():
            print(f"Missing {path}")
            return 1

    conn = psycopg2.connect(
        host=env["SUPABASE_DB_HOST"],
        port=int(env.get("SUPABASE_DB_PORT", "5432")),
        dbname=env.get("SUPABASE_DB_NAME", "postgres"),
        user=env["SUPABASE_DB_USER"],
        password=env["SUPABASE_DB_PASSWORD"],
        connect_timeout=60,
    )
    conn.autocommit = False
    cur = conn.cursor()
    total = 0
    try:
        for sql_file in files:
            chunks = [
                s for s in split_sql_statements(sql_file.read_text())
                if s.strip() and not s.strip().startswith("--")
            ]
            for stmt in chunks:
                cur.execute(stmt)
                total += 1
            print(f"  applied {sql_file.name} ({len(chunks)} statements)")
        conn.commit()
    except Exception as exc:  # noqa: BLE001
        conn.rollback()
        print(f"Migration failed: {exc}")
        return 1
    finally:
        conn.close()

    print(f"OK — applied {total} SQL statements.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
