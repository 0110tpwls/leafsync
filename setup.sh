#!/usr/bin/env bash
# leafsync one-step setup.
#
# Installs everything leafsync needs:
#   1. checks Node >= 18
#   2. installs npm dependencies (playwright, chokidar)
#   3. downloads the Chromium browser Playwright drives (~150 MB, one time)
#
# Re-runnable and idempotent. Run it from the repo root:
#   ./setup.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "leafsync setup"
echo "==============="

# 1. Node version check ------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed. Install Node >= 18 from https://nodejs.org and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node $(node --version) found, but leafsync needs Node >= 18. Please upgrade."
  exit 1
fi
echo "✓ Node $(node --version)"

# 2. npm dependencies --------------------------------------------------------
echo
echo "Installing npm dependencies (playwright, chokidar)…"
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi
echo "✓ dependencies installed"

# 3. Chromium for Playwright (~150 MB, one time) -----------------------------
echo
echo "Downloading the Chromium browser Playwright drives (~150 MB, one time)…"
npx playwright install chromium
echo "✓ Chromium ready"

echo
echo "Setup complete. Next:"
echo "  node src/cli.js link <your-overleaf-project-url>   # one-time login"
echo "  node src/cli.js pull                                # mirror + comment report"
echo
echo "Run 'node src/cli.js --help' for all commands."
