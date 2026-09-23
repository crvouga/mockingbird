#!/usr/bin/env bash
# Install dependencies, copy local untracked files (including .env) from the
# main checkout, and reserve a docs port for this workspace.
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$PROJECT_ROOT"
copy_local_files

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required (https://bun.sh). This repo's packageManager is bun@1.4.0." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to reserve a dev-server port." >&2
  exit 1
fi

port="$(reserve_docs_port)"
write_port_files "$port"
echo "Reserved docs port $port (http://127.0.0.1:$port)."

echo "Installing dependencies..."
bun install --frozen-lockfile
echo "Setup complete."
