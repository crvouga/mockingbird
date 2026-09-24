#!/usr/bin/env bash
# Build the docs site's workspace dependencies, then serve it on this
# workspace's reserved port. The Run button executes this script.
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$PROJECT_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to reserve a dev-server port." >&2
  exit 1
fi

# Record the shell before exec. exec keeps this pid, so teardown can stop the
# server (and the dependency build, if delete happens mid-start).
echo $$ >"$DEV_PID_FILE"

port="$(reserve_docs_port)"
write_port_files "$port"
export MOCKINGBIRD_DOCS_PORT="$port"
if [ -z "${NODE_OPTIONS:-}" ]; then
  export NODE_OPTIONS="--max-old-space-size=4096"
fi

if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  echo "Dependencies are missing. Installing..."
  bun install --frozen-lockfile
fi

echo "Docs dev server: http://127.0.0.1:$port"
exec bun docs
