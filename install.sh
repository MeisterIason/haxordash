#!/usr/bin/env sh
# HAXORDASH bootstrap - verifies Node 20+ and ensures the opencode CLI exists.
# The dashboard itself needs nothing beyond Node (zero npm dependencies).
set -e

command -v node >/dev/null 2>&1 || {
  echo "[x] node not found - install Node 20+ from https://nodejs.org"; exit 1; }
echo "[ok] node $(node -v)"

MAJOR=$(node -p "parseInt(process.versions.node, 10)" 2>/dev/null || echo 0)
[ "$MAJOR" -ge 20 ] || { echo "[x] Node 20+ required (installed: $(node -v))"; exit 1; }

if command -v opencode >/dev/null 2>&1; then
  echo "[ok] opencode already installed"
else
  echo "[ ] installing opencode via npm - @opencode/cli@latest ..."
  npm install -g @opencode/cli@latest
fi
echo "[i] opencode $(opencode --version 2>/dev/null || echo '(no version output)')"

echo "[ok] setup complete - run: node server.js"
