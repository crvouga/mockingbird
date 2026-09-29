# @crvouga/mockingbird-service-hermes

Work-in-progress mock for the Hermes Agent public peer-run API pinned to
`v2026.8.31`. Submission, polling and stop work with explicit synthetic lifecycle observations.
Events, approval and steer remain unsupported. No agent or inference runs.
[API_EVIDENCE.md](API_EVIDENCE.md) records source-backed semantics and gaps;
[SUPPORT.md](SUPPORT.md) records current operation support.

## Install

```sh
bun add @crvouga/mockingbird-service-hermes
```

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-hermes"

const hermes = createRuntime({ seed: 42 })
const response = await hermes.fetch(new Request("http://hermes.mock/health"))
console.log(await response.json())
```

Use the portable `HermesAPI` class for provider routes alone. `createRuntime`
adds health, namespaces, admin controls, faults, clock, metrics, metadata-only
request journal, and shared Timeline checkpoints. It needs no Hermes installation,
provider account, prompt data, API key, or local service.

For an HTTP endpoint:

```ts
import { createServer } from "@crvouga/mockingbird-service-hermes/server"

const server = await createServer() // ephemeral loopback port
try {
  console.log(await (await fetch(`${server.url}/health`)).json())
} finally {
  await server.close()
}
```

The CLI is `mockingbird-hermes serve --port 8827`. Point a peer HTTP client's base
URL at `http://127.0.0.1:8827`; submission returns immediately while execution remains queued until scripted.
The Node entry is separate from the portable Fetch entry.

## Routes and controls

`POST /v1/runs` admits a run and `GET /v1/runs/{run_id}` polls it.
`POST /v1/runs/{run_id}/stop` requests interruption. Events, approval and steer
return a mock-only 501 envelope with `error.type` of
`mockingbird_unsupported` and `error.code` of `operation_not_implemented`.
Missing runs use the pinned `run_not_found` 404 envelope. Unknown paths return
404. Mock-only errors do not claim real Hermes rejection behavior.

- `GET /health` identifies the `hermes` runtime.
- Select isolated namespaces with `x-mockingbird-namespace` or `/ns/<name>/…`.
- `POST /__admin/reset` clears selected provider state and Timeline. Shared clock,
  faults and diagnostic journal retain their standard independent lifetimes.
- `POST /__admin/clock` controls the shared clock.
- `POST /__admin/faults` configures scoped operation/path/method fault rules;
  `DELETE /__admin/faults` clears them. Named Hermes presets are documented below.
- `GET /__admin/requests` exposes request metadata without bodies, query values
  or credentials. `DELETE /__admin/requests` clears selected diagnostic history.
- `POST /__admin/checkpoints` captures shared Timeline state. Checkout through
  `POST /__admin/branches/<name>/checkout` with `{ "checkpoint": "cp_…" }`.

The existing shared `adminKey` option controls admin access. No credential-based
namespace mapping or Hermes provider authentication logic is introduced.

## API

The portable entry exports:

- `HermesAPI`: provider `fetch` and `reset`, with namespace and shared SQLite storage.
- `HERMES_NAMESPACE`: the default storage namespace, `hermes`.
- `createRuntime`: the standard service runtime and shared controls.
- `document`: annotated OpenAPI contract.
- `operationIds`: all inventoried operations.
- `supportedOperationIds`: `RunCreate`, `RunGet`, and `RunStop`.

The Node-only `/server` entry exports:

- `createServer`: returns `runtime`, `server`, `url`, `host`, `port`, and `close`.
- `DEFAULT_PORT`: CLI default 8827; programmatic calls default to an ephemeral port.
- `serveTarget`: shared CLI server target.

Types include `HermesAPIOptions`, `HermesRuntime`, `HermesRuntimeOptions`,
`OperationId`, `SupportedOperationId`, `HermesServer`, and `HermesServerOptions`.
The executable `mockingbird-hermes` provides `serve`.

## Script a run

```ts
import { createRuntime } from "@crvouga/mockingbird-service-hermes"

const hermes = createRuntime({ seed: 42 })
const accepted = await hermes.fetch(new Request("http://hermes.mock/v1/runs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "synthetic prompt" }),
}))
const { run_id } = await accepted.json()
await hermes.fetch(new Request(`http://hermes.mock/__admin/hermes/runs/${run_id}/observe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "completed", output: "synthetic result" }),
}))
const status = await hermes.fetch(new Request(`http://hermes.mock/v1/runs/${run_id}`))
console.log(await status.json())
```

Admission returns 202 `{ run_id, status: "started", replayed: false }`. The stored
status starts as `queued`. Repeated polling does not advance execution or time.
Use the same namespace on submission, observations and polling. Optional
`session_id` defaults to the run ID when absent or falsy. `model` defaults to
`hermes-agent` only when absent; an explicit null or empty value is retained, as
in the pinned handler. A valid `X-Hermes-Session-Key` is echoed without deriving a
conversation ID or authenticating credentials. Model routing and transcript loading
are not simulated. IDs are deterministic opaque hex strings, separate from sessions.

The observation control accepts `status`: `queued`, `running`,
`waiting_for_approval`, `stopping`, `completed`, `failed`, `cancelled`, or
`interrupted`. It accepts optional `last_event`; `approval` only while waiting;
`error` only for failed/interrupted; and `output`, `usage`, `pending_steer` only
for completed. Usage has three nonnegative integer counts: `input_tokens`,
`output_tokens`, `total_tokens`. Completion defaults to empty output and zero counts.
Terminal observations cannot be changed (409); invalid control payloads return 400
without changing state. These are mock controls, not additional Hermes routes.

Timestamps are Unix seconds from the shared clock. Run records and their identity
sequence use shared storage and Timeline; reset clears them. No timers, agent
handles or prompts are stored. Polling result content stays out of journals.
Malformed roots/final input elements, hosted rooms and invalid memory-scope headers
currently return explicit mock-only 501 responses. See evidence for these limits.

## Idempotent submission and synthetic scope

Send `Idempotency-Key` to reserve a delivery. Identical retries return 202 with
the original run ID, its current status, `replayed: true`, and
`Idempotency-Replayed: true`. A changed payload with the same scoped key returns
409 `idempotency_key_conflict`. Concurrent identical requests reserve one run.
Empty/whitespace keys disable deduplication; other keys must contain 1–255 visible
ASCII characters after Python-style trimming. Validation errors reserve nothing.

The fingerprint covers the entire parsed JSON body, including unknown fields,
and the trimmed `X-Hermes-Session-Key`. Object key order does not matter; array
order and session/body changes do. Raw integer/float forms follow Python:
`1` and `1.0` conflict, `1.0` and `1e0` replay, and negative floating zero differs
from positive zero. Lone Unicode surrogates return an explicit mock-only 501;
Python cannot UTF-8 encode that fingerprint either.

`POST /__admin/hermes/scope` with `{ "profile": "synthetic-profile",
"identity": "synthetic-listener" }` selects an explicit synthetic scope within
the current Mockingbird namespace. Defaults are `default` and
`unauthenticated-test-listener`. Use only synthetic labels, never credentials.
Changing scope isolates reservations and public polling; returning to it restores
access to its runs. Session IDs and memory keys are not scope selectors, and
bearer text is ignored. This control does not implement authentication.

Reservations and owners survive reconstructing a `HermesAPI` with the same
SQLite client and namespace. Terminal replay is verified after that modeled
adapter reconstruction. Actual process/disk durability and unfinished-run restart
outcomes are modeled by the explicit restart control below. Shared
Timeline restores scope, reservations and run records together; reset clears them.
No public key-lookup endpoint is added. Request bodies are hashed in memory and
not persisted; stored reservations contain the key, hash, run identity and durable observation.

## Stop and logical restart

`POST /v1/runs/{run_id}/stop` returns 200 `{ run_id, status: "stopping" }` for
locally active work. Repeated stop requests retain that intermediate state. Use
`observe` to script the eventual outcome: `cancelled` for acknowledged interruption,
`completed` when normal completion wins the race, or `failed` for execution failure.
Stopping a terminal run returns its full unchanged status, not a new cancellation.
Missing or inaccessible runs return 404 `run_not_found`.

`POST /__admin/hermes/restart` with `{ "owner": "stale" }` models loss of the
current namespace's gateway. It discards cached observations and retains surviving keyed durable
reservations across all synthetic profiles in that namespace. An unfinished keyed
run becomes `interrupted` when next polled, replayed or stopped, with
`The gateway restarted before this run settled.` and `run.interrupted`.
Its creation timestamp remains intact; its update timestamp reflects that first
observation. Terminal runs retain their status and result. Retrying an old delivery
key replays the interrupted run; a new key creates a different run.

Use `{ "owner": "alive" }` to model another live owner after gateway replacement.
Keyed observations stay unchanged, but stopping unfinished foreign work returns
409 `run_not_active`. An explicit `observe` can represent that owner's eventual
completion. Neither control reads PIDs, interrupts a real process, or runs an agent.
It is a logical scenario, not a process/disk durability guarantee. Shared Timeline
restores the owner flags and run/reservation state together.

## Retention and history

The controlled clock governs two independent retention layers. Cached `completed`,
`failed` and `cancelled` results expire when their update age is strictly greater
than one hour; equality survives and `interrupted` is excluded. The mock evaluates
elapsed 60-second sweep ticks on admission or observation, without a background
process. `POST /__admin/hermes/sweep` with `{}` explicitly executes one sweep at the
current clock, returning `cacheRemoved` and `simulated: true`.

Keyed terminal reservations expire only when their durable update age is strictly
greater than 24 hours. Valid keyed admission triggers that pruning, including a
request that subsequently conflicts. Polling and keyless admission do not prune
durable rows. Active reservations never expire by age. Polling can recover a
retained durable result after cache eviction, even beyond 24 hours before pruning;
a cached result can also temporarily outlive its pruned reservation. Missing results
return the ordinary 404 `run_not_found`, without an invented expired state.

Same-status progress observations update cached timestamps but do not persist the
new progress payload unless a selected durable field changes. Logical restart
clears cached observations and hydrates only surviving durable rows. Timeline
restores both layers, ownership, the sweep schedule and controlled clock together.
These are shared-storage and logical-restart guarantees, not process-crash or disk
durability evidence. SSE buffer and hosted-room retention remain outside the subset.

## Fault and consumer scenarios

Use `POST /__admin/faults` with `{ "preset": "hermes_submit_accepted_drop" }` to
admit one new run and lose its response. The shared journal records acceptance and
its checkpoint even though delivery fails. Retry the same body and idempotency key
to recover the original run. Validation failures still return their normal errors.

Other one-shot presets are `hermes_poll_timeout` (delay one poll by 1000ms),
`hermes_throttled` (429 with the pinned default-capacity envelope), and
`hermes_draining` (503 with the pinned draining envelope). Both rejection presets
include `Retry-After: 1` and run before admission. These are explicit scenarios;
they do not automatically count capacity or simulate a real draining gateway.
To script an executor failure, use `observe` with `status: "failed"` and synthetic
`error` text, then poll or replay the same run.

The Node HTTP consumer fixture owns its disposable server and uses an independent
HTTP client to test lost responses, replay, polling, stopping, client deadlines and
expiry. It does not import Initiative or impose a consumer retry policy. Property
tests compare eligible peer operations and assert coverage; a seeded poll check
injects a schema-valid lifecycle divergence to test the comparator. Self-parity is
consistency evidence, not an independent Hermes runtime compatibility claim.

## Deliberately not modelled

Prompts, instructions and history are validated then discarded.
Synthetic result text can be stored by observation controls and is cleared by reset.
Kanban attempts, client intake/recovery policy, inference, Python dispatchers,
host tool execution and credential enforcement are excluded. There are no outgoing
webhooks, provider calls or agent processes. Public peer-run IDs will remain
separate from consumer intake and Kanban identities.

Source evidence is not runtime parity. Package/shared-control tests do not establish
compatibility with a real Hermes process. The opt-in
[pinned oracle](oracle/README.md) separately passed 33 documented public HTTP
comparisons, including a fresh-process SQLite restart; its substitutions and
limitations remain explicit. Keep this package WIP until independent Ready requirements are met.


## HTTP replay example

Start `mockingbird-hermes serve --port 8827`, then submit a synthetic delivery:

```sh
curl -sS http://127.0.0.1:8827/v1/runs \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-delivery' \
  -d '{"input":"synthetic prompt"}'
```

Repeating the identical request returns the same `run_id` and a replay header.
Poll `GET /v1/runs/<run_id>`; request interruption with
`POST /v1/runs/<run_id>/stop`. A stop response is intermediate. Complete the
scenario with `POST /__admin/hermes/runs/<run_id>/observe`, using a JSON body
such as `{ "status": "cancelled" }`, then poll again. Use only synthetic input
and result data. No Python dispatcher or Kanban integration is required.

## Verification and evidence

The package remains **WIP**. Three of six inventoried operations are supported;
SSE events, approval execution and steering remain excluded. The shipped
[oracle guide](oracle/README.md), [source manifest](oracle/source-lock.json), and
[recorded comparisons](evidence/pinned-oracle.json) make the exact upstream pin
and substitutions inspectable. Run the oracle only after separately authorizing
its dependency, disposable database and process operations. Normal package tests
need none of those operations or provider credentials.

From this repository, run `bun test packages/service/hermes` and the package's
`typecheck`, `lint`, `generate:check`, `openapi:check`, `build`, `portability` and
`pack:check` scripts. Root `bun run check` also verifies catalog and generated
documentation freshness. The docs catalog playground uses the same portable
runtime; its state is local to the browser.
