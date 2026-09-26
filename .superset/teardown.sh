#!/usr/bin/env bash
# Stop the docs dev server started by run.sh and release its port.
# Setup itself does not leave a process behind; the server is started on demand
# by the Run button. Deleting a workspace still has to stop that process and
# give the port back, or the next workspace cannot reuse the slot.
set -euo pipefail

# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

cd "$PROJECT_ROOT"
stop_dev_server

if command -v python3 >/dev/null 2>&1; then
  release_docs_port
else
  echo "python3 is not available; left the port allocation in place." >&2
  exit 1
fi

rm -f "$DEV_PORT_FILE" "$PORTS_JSON"
echo "Teardown complete."
