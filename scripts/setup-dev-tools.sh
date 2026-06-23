#!/usr/bin/env bash
# Bootstrap local dev tools for this repo (Node/npm via nvm).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "Installing nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi

# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js 20..."
  nvm install 20
  nvm alias default 20
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

echo "Installing npm dependencies..."
npm install

if ! python3 -c "import psycopg2" 2>/dev/null; then
  echo "Installing psycopg2-binary for Python migration scripts..."
  python3 -m pip install --user psycopg2-binary
fi

echo ""
echo "Dev tools ready. Useful commands:"
echo "  npm run validate-env"
echo "  npm run bootstrap:platform-admin"
echo "  npm run sync:prescription-secrets"
echo "  npm run test:production-cleanup-e2e"
echo ""
echo "If npm is not found in a new terminal, add this to ~/.zshrc:"
echo '  export NVM_DIR="$HOME/.nvm"'
echo '  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
