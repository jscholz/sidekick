#!/usr/bin/env bash
# Sidekick — one-command install for Mac / Linux.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jscholz/sidekick/master/install.sh | bash
#
# What it does:
#   1. Verifies node >= 22 is on PATH (sidekick uses node 22's
#      --experimental-strip-types flag at runtime).
#   2. Clones the sidekick repo to ~/sidekick if missing, or pulls
#      latest if already there.
#   3. Runs `npm install` at root + under `backends/stub/`.
#   4. Copies `.env.example` to `.env` (idempotent — won't overwrite
#      an existing .env).
#   5. Starts the proxy + the in-tree stub agent (echo LLM) via
#      `npm start`, and prints the URL to visit.
#
# After the script returns, open http://localhost:3001 in your
# browser. The agent is the in-tree stub by default — point at a
# real hermes install or any /v1/*-speaking server by editing
# `~/sidekick/.env` and restarting.

set -euo pipefail

INSTALL_DIR="${SIDEKICK_INSTALL_DIR:-$HOME/sidekick}"
REPO_URL="https://github.com/jscholz/sidekick.git"

echo "==> sidekick install — target: $INSTALL_DIR"

# 1. Node version check
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is not installed. Install Node 22+ first:"
  echo "  macOS:   brew install node"
  echo "  Linux:   https://nodejs.org or your package manager"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: node $(node -v) is too old. Sidekick requires Node 22+."
  echo "  Update via brew (\`brew upgrade node\`) or nvm."
  exit 1
fi
echo "==> node $(node -v) ✓"

# 2. Clone or pull
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> existing checkout — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only origin master
else
  echo "==> cloning $REPO_URL → $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# 3. npm install (root + agent)
echo "==> installing root dependencies"
npm install --no-audit --no-fund
if [ -f "backends/stub/package.json" ]; then
  echo "==> installing agent dependencies"
  (cd backends/stub && npm install --no-audit --no-fund)
fi

# 4. .env (idempotent)
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "==> created .env (copy of .env.example — edit to override)"
else
  echo "==> .env already exists (preserved)"
fi

# 5. Start
echo ""
echo "================================================================"
echo "  Sidekick is starting up."
echo ""
echo "  Defaults: proxy on :3001, stub agent on :4001 — start-all"
echo "  auto-shifts to :3002/:4002 (etc) if either is busy. The"
echo "  actual URL is printed below as soon as the proxy binds."
echo ""
echo "  Override with PROXY_PORT / AGENT_PORT, or set"
echo "  SIDEKICK_PLATFORM_URL=http://host:port to skip the in-tree"
echo "  stub and proxy to an existing agent."
echo ""
echo "  Stop with Ctrl+C."
echo "================================================================"
echo ""

exec npm start
