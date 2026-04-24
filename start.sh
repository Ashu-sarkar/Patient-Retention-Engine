#!/bin/sh
# Container entry-point.
# On first boot: imports all workflow JSONs with --overwrite.
# On subsequent boots: skips import (flag file exists) and just starts n8n.
set -e

DATA_DIR=/home/node/.n8n
FLAG_FILE="${DATA_DIR}/.initialized"
WORKFLOW_DIR=/workflows

if [ ! -f "${FLAG_FILE}" ]; then
  echo "[start.sh] First boot — importing workflows from ${WORKFLOW_DIR}..."
  if n8n import:workflow --separate --input="${WORKFLOW_DIR}" --overwrite; then
    touch "${FLAG_FILE}"
    echo "[start.sh] Workflows imported successfully."
  else
    echo "[start.sh] WARNING: workflow import failed. n8n will still start." >&2
  fi
else
  echo "[start.sh] Already initialized — skipping workflow import."
fi

exec n8n start
