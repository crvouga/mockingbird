# Pinned Hermes runtime oracle

This opt-in harness compares Mockingbird with Hermes `v2026.8.31`, commit
`29112bef099274229cadff79cdff7bf7b99c4b77`. It is not part of default tests or
setup. The authorized run passed 33 comparisons;
[the recorded report](../evidence/pinned-oracle.json) contains the observations
and provenance. This establishes only the declared comparison matrix.

## Execution boundary

`source-lock.json` records exact source hashes and upstream paths. `fetch.py`
downloads only those files; `sources.py` verifies every hash before execution.
Python must be `>=3.11,<3.14`; aiohttp is pinned to `3.14.3`, matching the upstream
release's messaging extra. No full Hermes installation is needed.

The entire pinned run-handler and idempotency-store modules execute unchanged.
Ancillary definitions are selected from original AST nodes, including transitive
local definition dependencies; function bodies are not rewritten. The report lists
every selected definition. The pinned SQLite journal-mode helper and SQLite
version guard are retained, as are the upstream schema, transaction, retention,
lookup, reservation, status persistence and owner PID/start-time checks.

The adapter supplies only the ordinary default listener. Original auth and
session-key parsing functions remain intact in their upstream no-key test mode.
This does not test production authentication. Hosted-room requests are excluded;
no operational board, credentials, webhook, tool or inference execution is used.

Declared substitutions:

- `_create_agent` returns a scripted executor with an explicit completion latch.
  The pinned background handler still owns running, stop races, failure,
  cancellation and completion transitions.
- Session binding, approval notification registration and tool-process ownership
  hooks are inert test integrations. No host tool runs or child-tool process is
  created. The upstream hard-interrupt compatibility function calls the scripted
  agent's interrupt method.
- Routing returns the default route, transcript history is empty, profile context
  is fixed to default, and automatic capacity admission is disabled. These are
  outside the comparison matrix; throttle/draining scenarios belong to US-021.
- Only the loaded run/store modules' `time` bindings use a controlled clock.
  Sweeps invoke the upstream one-shot sweep; the global Python clock is unchanged.
- Gateway startup and unrelated imports are not loaded. Missing optional journal
  configuration takes the upstream default; no operational Hermes home is read.

## Disposable process and database operations

Each comparison creates a unique directory beneath `.mockingbird/hermes-oracle/`.
The pinned store initializes its own SQLite schema there and may perform its
upstream schema adjustments and retention DELETE statements. No existing database
is opened. The comparison deliberately exits the owned Python process without
executor/connection cleanup, then starts a new process against that same disposable
file. This proves the measured restart behavior, not power-loss durability.

The harness also starts its own loopback Mockingbird HTTP server and closes it in
cleanup. Python startup failures may terminate only that fixture child. Source,
virtualenv, caches and database/report artifacts remain inside the project; no
cleanup deletes them automatically.

Repository rules require explicit approval for dependency installation, database
initialization/migrations/DELETE and process lifecycle before the run. The opt-in
flag is a guard, not a grant of authority.

After approval, prepare the environment using the existing compatible Python:

```sh
mkdir -p .mockingbird/tmp .mockingbird/uv-cache
TMPDIR="$PWD/.mockingbird/tmp" uv venv --python python3.11 --no-python-downloads --cache-dir .mockingbird/uv-cache .mockingbird/hermes-oracle-venv
TMPDIR="$PWD/.mockingbird/tmp" uv pip install --python .mockingbird/hermes-oracle-venv/bin/python --cache-dir .mockingbird/uv-cache -r packages/service/hermes/oracle/requirements.lock
PYTHONDONTWRITEBYTECODE=1 python3.11 packages/service/hermes/oracle/fetch.py --fetch
bun run --cwd packages/service/hermes build
MOCKINGBIRD_HERMES_ORACLE_APPROVED=1 HERMES_ORACLE_PYTHON="$PWD/.mockingbird/hermes-oracle-venv/bin/python" node packages/service/hermes/oracle/compare.mjs --run
```

The report records the source hashes, interpreter/aiohttp/SQLite versions,
selected definitions and compared synthetic observations. Only top-level `run_id` and `session_id` identity fields are mapped between sides.
The exact pinned 404 `run_not_found` message template maps its ID suffix; differing
prefixes or trailing text fail comparison. All other error/result strings, status,
replay headers and timestamps remain unchanged and compared.

Verified matrix: admission/running polling, active/terminal replay, changed-body
conflict, stop/cancel, completion winning a stop race, execution failure,
terminal/unfinished/keyless real-process restart, interrupted replay, exact one-hour
cache boundaries and exact24hour
retention equality, GET without durable pruning, expiry/re-admission and ordinary
404 after pruning plus sweep. A failure leaves US-022 incomplete.

## Recorded execution

The passing run used Python3.11.16, aiohttp3.14.3 and SQLite3.53.1. Both owned
process epochs opened the disposable database in WAL mode; their distinct PIDs
are recorded. The report includes all10 installed dependency versions, also
captured in `requirements.lock` for repeat setup. No production or pre-existing
Hermes database was used. The 33 comparisons all matched without changing the
mock's implementation or weakening field comparison.

Initial harness execution exposed two integration defects: importing typing's
module metadata overwrote the synthetic module name, and the run-event callback
binding omitted the upstream namespace argument. Both were fixed in the harness;
upstream functions, source hashes, auth logic and database logic were unchanged.
