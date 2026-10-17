# Fleets

One service CLI can supervise installed HTTP emulators, PostgreSQL wire servers and Redis RESP
servers. Every listener starts before readiness is published; a boot failure names the service,
closes listeners that already started, and exits nonzero. SIGINT/SIGTERM closes the whole fleet.

```json
{
  "log": "off",
  "control": { "port": 0 },
  "services": {
    "stripe": { "port": 0, "seed": "fixture" },
    "postgres": {
      "protocol": "postgres", "port": 0, "database": "app",
      "namespaces": { "worker-7": "app", "other": "app" }
    },
    "redis": {
      "protocol": "redis", "port": 0,
      "namespaces": { "worker-7": 0, "other": 0 }
    }
  }
}
```

```sh
mockingbird-stripe serve --config mockingbird.json --ready-file ready.json --ready-json
```

Set top-level `adminControls` to boot HTTP services and protocol clocks with the same
[admin controls](admin-controls/BOOT.md) (clock, latency, faults, a starting snapshot); a service
entry's own `adminControls` replaces the keys it names. `--admin-controls`, `--clock`,
`--freeze`, `--latency`, `--fault` and `MOCKINGBIRD_ADMIN_CONTROLS` apply on top of the file.
A document that cannot be read stops the fleet before any listener opens, and names the service.

```json
{
  "adminControls": { "clock": { "now": "2030-01-01T00:00:00Z", "frozen": true } },
  "services": {
    "stripe": { "port": 0, "seed": "fixture", "adminControls": { "latency": "40ms" } },
    "resend": { "port": 0 }
  }
}
```

Set top-level `adminPrefix` (default `/__admin`) to move the aggregate API and all
HTTP children together. A service entry may override `adminPrefix`. CLI
`--admin-prefix` and `MOCKINGBIRD_ADMIN_PREFIX` also apply; ready manifests always
report the actual URLs. Aggregate controls are under `<adminPrefix>/fleet`, and
readiness is `<adminPrefix>/health`. Old `/__fleet` and `/health` routes are removed.

HTTP namespace selection uses `x-mockingbird-namespace` or `/__admin/ns/{name}`. Protocol namespaces
must be declared in the config; each gets its own engine and listener. Use the URL from
`services[name].namespaces.endpoints[namespace]`. This isolates scripts, Pub/Sub, faults and
clocks as well as records. Within one Redis endpoint, `SELECT` retains Redis's logical-database
semantics: keys are partitioned, but scripts, Pub/Sub and time belong to the server.

The aggregate `/__admin/health` endpoint reports `processReady`, `protocolReady` and `status` per child.
If any child stops, it returns 503. The control listener defaults to a loopback ephemeral port.

## Endpoint discovery

Provider entries can also carry their synthetic fixture object and advertised public URL:

```json
{
  "services": {
    "google": {
      "port": 0,
      "baseUrl": "https://preview.example.test/google",
      "fixtures": { "users": [{ "email": "fixture@example.test" }] }
    },
    "vercel": { "port": 0, "fixtures": { "projects": [{ "name": "fixture-app" }] } }
  }
}
```

This applies to the added providers and expanded GitHub, Slack, Resend and Twilio services.
Their `options.fixtures` may instead name a JSON file, relative to the command's working
directory; that file takes precedence over the inline object. `options.base-url` overrides
`baseUrl`. Fixture parsing and public URL validation happen before the child listener opens.
Reset replays fixtures; restoring a snapshot uses its stored state. `baseUrl` controls URLs
advertised by the provider, while the endpoint manifest reports the actual local listener.

`--ready-json` emits one version-1 ready record with `pid`, a unique `id`, `startedAt`, aggregate
`healthUrl`/`adminBase`, and every child's actual protocol URL, health URL, admin URL and namespace
mechanism. The ready file contains the same JSON. It is published by rename after all children
are healthy, and removed on shutdown only if it still belongs to this process. Starting with
an existing ready-file path invalidates the earlier artifact before boot. Give concurrent fleets
different paths.

Public URLs omit passwords. `--connections-file private.json` writes credential-bearing default and namespace
connection URLs to a separate file, atomically and with mode 0600. Keep configuration and this
private payload outside tracked files. PostgreSQL accepts `user`, `password` and `database`;
Redis accepts `password`. Protocol seeds are numeric. An admin key belongs in the config's
`adminKey` field or `MOCKINGBIRD_ADMIN_KEY`; it is never part of discovery.

## Fleet controls

Call these paths under the manifest's `adminBase`. Every control request requires
`x-mockingbird-admin-key` when a fleet admin key is configured.

| Method | Path relative to `adminBase` | Behavior |
| --- | --- | --- |
| POST | `/namespaces/{name}/reset` | Reset records, namespace faults, clock and pending work across children. |
| POST | `/namespaces/{name}/snapshots` | Capture an opaque in-process checkpoint; optional `label` and `services` list. |
| POST | `/namespaces/{name}/snapshots/{id}/restore` | Restore every child captured by that checkpoint, including deterministic random state. |
| GET/POST | `/clock?namespace={name}` | Read or update logical time with `set`, `freeze`, and `advance` (milliseconds or e.g. `"1h"`). |
| GET | `/metrics?namespace={name}` | Per-child unmatched requests, active requests/connections, blocked commands, jobs and webhooks. |
| POST | `/wait-until-idle?namespace={name}` | Return 200 when idle, otherwise 409 with exact per-child diagnostics. |

Reset and clock operations accept an optional `services` list. Fleet mutations fence new work,
checkpoint each child, then apply the operation. A rejection returns the failed service and each
rollback result, including `rolledBack: false` if any rollback failed. Only a completed operation
returns global success. Opaque checkpoints belong to one namespace and the current fleet process. Export a portable archive for process replacement.

Active HTTP requests, pending webhooks, active BullMQ jobs, blocked Redis commands, or live PostgreSQL sessions
cause a precise 409 conflict. Close workers and PostgreSQL pools before checkpointing/resetting;
PostgreSQL sessions can retain transactions and prepared statements even when apparently idle.
Queued and delayed Redis jobs are checkpointable state; `/wait-until-idle` still counts them.
HTTP clocks and random streams are independent per namespace in a fleet. Reset/restore of one
namespace leaves the others unchanged.

BullMQ timestamps and worker timers also read the client process's clock. For deterministic
delay/backoff tests, inject the same clock in the client test harness and Redis, then use public
`Worker.getNextJob`/`Job` APIs. Advancing the server clock cannot change `Date.now()` in a separate
consumer process.


## Management discovery and errors

`GET <adminBase>` returns capability contract version 1, routes/methods, per-child protocol,
package/codec versions, portable snapshot and provisioning support, supported budgets and limits.
The readiness document includes `capabilityVersion: 1`. Feature-detect this contract rather than
assuming a package version supplies a route. `GET <adminPrefix>/ui` serves the authenticated fleet
console with child links, namespace actions and operation/rollback results. Supply the admin key
as an HTTP header when loading the console and in its key field for control calls.

Fleet failures use `{error:{type:"mockingbird_admin",code,message}}`, with `namespace`, `services`,
`failedService`, `rollback`, `rolledBack` and `operationId` alongside it where applicable. This
replaces the former string `error`. Invalid documents/encoding return 400, missing namespaces or
checkpoints 404, conflicting/active work 409, and failed transactions 500. Unknown control fields,
non-string or over-256-character labels, and service selection on checkpoint restore are rejected
before any checkpoint/mutation. Restore always covers the checkpoint's recorded services.
Numeric protocol seeds must be finite. Ready/private output destinations must differ after path
and symlink resolution. Common configuration, policies, target loading and control documents are preflighted before any listener starts; service factory failures close all started listeners.
Startup failures retain their cause and install remediation. Shutdown attempts every child and
returns a failing exit status if any child fails to close.

## Namespaces, quiescence and generations

| Method | Path relative to `adminBase` | Body / result |
| --- | --- | --- |
| GET | `/namespaces` | Namespace generations, lifecycle, creation/activity/expiry times and pin state. |
| POST | `/namespaces/{name}` | `{}` or `{baseline:"checkpoint-id"}`; provision isolated HTTP/PG/Redis state and return updated discovery and private connections. |
| DELETE | `/namespaces/{name}` | Refuse active work or clients, delete children and release listeners; roll back partial deletion. The default and pinned namespaces cannot be deleted. |
| POST | `/namespaces/{name}/policy` | `{pinned:true}` protects a namespace from cleanup/deletion. |
| POST | `/can-checkpoint?namespace={name}` | `{services?:[...],timeoutMs?:0..30000}`; read-only admission probe. |

Provisioning reserves capacity before asynchronous work; a partial failure cleans up created
children. Explicit operations for alpha and beta run concurrently. Conflicting operations return
409 and the active operation identity. All-namespace capture/restore coordinates an environment
fence across selected children. An incomplete rollback keeps the affected namespace fenced; use
an explicit reset or checkpoint/archive restore to recover it. Other namespaces stay available.

`/wait-until-idle` evaluates only selected children and counts pending jobs. `/can-checkpoint`
uses the same active-request/session, blocked-command, active-job and pending-webhook rules as
snapshot admission. Delayed/queued Redis jobs can be checkpoint-ready while not idle. The probe
creates no checkpoint and does not advance time. HTTP responses count as active until their
bodies finish or are cancelled, including event streams. Webhook counts are namespace-local and
count an active delivery once.

Namespace generations change after successful reset, restore and provisioning, including a repeat
restore of the same archive. They never rewind with saved data. HTTP responses advertise
`x-mockingbird-generation`; an HTTP write supplying an old generation receives 409. Protocol
clients must reconnect/resynchronize using discovery after replacement. Failed operations do not
advance the generation. Aggregate clocks start from shared/per-namespace boot controls; empty
clock documents preserve every child clock. Relative advances preserve intentional child offsets.
Reset returns children and the aggregate reference clock to their configured boot baseline.

## Checkpoints and portable archives

`GET /namespaces/{name}/snapshots` lists checkpoint ids, creation times, labels, captured service
inventory and portability. `GET` and `DELETE` the collection's `/{id}` inspect/delete one. Retention
is configured programmatically with `retention:{maxCount,ttlMs}`; defaults are 50 checkpoints per
fleet and 24 hours. Expiry is swept on control requests; count eviction is oldest first across the
fleet. Dropping a checkpoint releases its opaque handles for garbage collection.

| Method | Path | Body |
| --- | --- | --- |
| POST | `/archives/export?namespace={name}` | `{services?:[...],allNamespaces?:true}` |
| POST | `/archives/import` | `{archive:<document>,namespace?:"one-captured-namespace"}` |
| POST | `/archives/inspect` | `{archive:<document>}` |
| POST | `/archives/diff` | `{left:<document>,right:<document>,namespace?,service?,values?:false,limit?:100}` |

`mockingbird.fleet/v1` archives carry source/creation metadata, namespace clocks, service protocol
and codec version, package provenance and a SHA-256 digest of canonical content. HTTP state carries
records, sequences, random/control streams, latency/faults and quiescent webhook endpoints/history.
PostgreSQL carries encoded PGMM snapshots for every database, PRNG state, faults and clock. Redis
uses a tagged JSON representation for binary values, Maps and bigint stream ids, including scripts,
queued/delayed work and consumer pause state. Archives contain private data/configuration: store
them privately. Unfinished outbound webhook deliveries and live protocol sessions must be drained.

Imports validate integrity, namespace/service/codec support and decode every child before changing
state. They create absent namespaces in a fresh fleet, restore selected state transactionally, and
report rollback failures. Unsupported codecs/services and corrupt archives are refused. Compatibility
is determined by archive and child codec versions; package versions are provenance rather than an
assumption of binary compatibility. Keep independent backups before replacing a running fleet.
Inspection/diff is read-only, versioned and bounded; raw HTTP/Redis values are opt-in. Raw PostgreSQL diff is explicitly unsupported; use bounded inspection for row values. HTTP record identifiers, PostgreSQL table/record hashes, Redis key identifiers,
clock/control changes and protocol metadata changes are compared without restoring either side.

## Operations, events and retry safety

Mutations return `x-mockingbird-operation-id`. `GET /operations?namespace={name}` and
`GET /operations/{id}?namespace={name}` expose phase, measured completed/total child work,
terminal status and bounded result metadata. `POST /operations/{id}/cancel` requests cancellation
before commit; committed work is never described as cancelled. Retain at most 200 operations per
process. Checkpointing, committing, verification, resume and rollback are distinct phases.

Send `Idempotency-Key` on retried mutations. The key is bound to caller, namespace, route, method
and canonical body. Simultaneous/identical retries receive the original result and operation id;
conflicting reuse receives 409. Retention is one host-clock hour, at most 1000 keys; a restart
clears this in-memory retry history. Persist archive identities externally for recovery across
process replacement.

`GET /events?namespace={name}` is an SSE stream with ids containing the fleet process id and a
sequence. Reconnect with `Last-Event-ID` to replay up to 500 retained events for that namespace.
A missing/expired/other-process cursor emits `resync` with the current generation/lifecycle.
`memberStatus:true` enables an anonymous namespace-only projection of operation id, phase, status
and progress; it omits administrative results, configuration and other namespaces.

`GET <adminPrefix>/live` reports controller liveness throughout initialization, maintenance and
shutdown. Readiness returns 503 with lifecycle and affected operation/fence scopes during planned
work, rather than misreporting a protocol fence as an unexpected child failure. Startup verifies
actual protocol handshakes; once admission policies are installed, readiness checks listener
availability without consuming namespace connection quotas.

## Workload and startup hooks

The programmatic `startFleet(config, options)` accepts `workload:{prepare,verify,resume}`. Each
async hook receives `{namespace,services,signal,operationId}`. Prepare should pause application
admission/workers and close pools. Verification runs after child mutations; resume runs only for
the selected namespace. Hook deadlines default to 30 seconds (`hookTimeoutMs`). A failed drain
or mutation triggers safe compensation; failed rollback or resume retains the recovery fence.
Observe the abort signal and make application-side hooks idempotent.

`initialize({manifest,connections,headers,signal})` runs asynchronously after listeners bind and
before readiness/private artifacts or the existing synchronous `onReady` callback are published.
Use its discovered HTTP endpoints with the supplied temporary initializer header. For protocols,
use its private `connections`: temporary loopback listeners share the actual namespace engines
while ordinary listeners remain gated. Temporary listeners close before readiness. Initialization
is bounded by `initializationTimeoutMs` (default 30 seconds); failure closes the fleet with its
original cause. PostgreSQL initialization listeners select the namespace's configured database.

`beforeClose({manifest,signal,capture})` is a final backup/acknowledgement gate, with
`shutdownTimeoutMs` (default 30 seconds). Status remains readable and vendor admission is blocked
until it completes. Failure defaults to aborting shutdown and leaving a failed fenced environment;
a repeated close retries the hook. `shutdownFailure:"close"` instead attempts all cleanup and
still rejects/reports failure. SIGKILL, crashes and host loss cannot guarantee a final backup.

## Profiles and reusable scenarios

`profiles:{name:{service:controls}}` registers named cross-service profiles.
`POST /profiles/apply?namespace={name}` accepts `{name}` or `{profile:{service:controls}}`.
The entire profile is normalized before mutation; protocol children accept clock controls only.
Unsupported latency/fault controls are rejected rather than skipped. Partial failures restore all
captured children. `POST /profiles/baseline` accepts optional `services` and clears HTTP faults and
latency, leaving data intact. Use namespace reset for a full configured boot baseline.

`scenarios` registers bundles with `format:"mockingbird.scenario/v1"`, positive `version`, service
protocol requirements, optional deterministic `seed`/`clock`, per-service `controls`/`fixtures`, and
an optional async `seedApplication` hook. The bundle seed applies to HTTP random streams; protocol engines retain their configured numeric seeds. Fixtures are portable HTTP snapshot record arrays.
`GET /scenarios` describes available bundles; `POST /scenarios/{name}/apply?namespace={customer}`
applies one transactionally. Incompatible services are rejected before mutation. Application seed
hooks receive the workload context, private namespace connections, manifest and temporary HTTP headers. Only the bundle's selected services are exposed through private seed access. Hooks must honor the deadline/signal; an uncertain application seed failure retains the recovery fence.

## Backups, quotas and expiry

The public fleet entry point exports an `ArchiveRepository` interface (`put/get/list/delete/latest/publishLatest`),
`filesystemRepository(directory,maxBytes?)` and `s3Repository({endpoint,bucket,region,accessKeyId,
secretAccessKey,sessionToken?,prefix?,pathStyle?,maxBytes?,fetch?})`. Explicit S3 storage credentials
are separate from any captured application S3 emulator. Path-style endpoints default on; use
`pathStyle:false` for virtual-hosted buckets. Signed requests use the S3 general-purpose bucket
API. Transfers are bounded (64 MiB default), immutable objects use archive digest identities, and
latest publication follows a verified read-back. Interrupted/corrupt uploads never advance it.
Filesystem objects/pointers are atomically published with private permissions. Latest archives
cannot be deleted until a newer verified pointer replaces them.

Configure `repository` and `backupPolicy:{intervalMs,namespaces?,keep?}` to enable scheduled verified
backups on real host elapsed time, independent of a frozen emulator clock. Runs never overlap;
an overlapping interval is skipped. `GET /backups` reports last attempt, last verified success,
next run, failures and retained ids. `POST /backups` captures one namespace, or accepts
`{allNamespaces:true}`. Scheduler history is process-local; repositories/latest pointers survive
restart. Keep protects recent repository objects after a verified publication.

`limits:{maxNamespaces,maxListeners,connections}` bounds namespace reservations, listener count
(including the controller), and namespace protocol connections/HTTP active admissions. Discovery
reports usage, remaining namespace capacity and unsupported budgets. New protocol connections
are closed at the quota boundary; existing clients continue. Object-byte, record and pending-job
budgets are explicitly unsupported and rejected when configured. Deleting a namespace releases
capacity. No limits are enabled by default.

`expiry:{idleMs,intervalMs?,finalBackup?}` opts into host-clock idle cleanup. `GET /cleanup` previews
candidates and pin/expiry state; `POST /cleanup` executes eligible cleanup. Requests/connections
refresh host activity; active clients/work, operations, recovery fences and pins prevent deletion.
`finalBackup:true` requires a repository and a verified final upload before retirement. Failed
uploads leave the namespace present for a later retry. Default cleanup cadence is 60 seconds.

## Client, configuration rendering and preflight tools

The supported `@crvouga/mockingbird-service-stripe/fleet` entry point exports `FleetClient`, `FleetClientError`, `renderConnections`, `writeConnections`,
`doctorFleet` and `rehearseFleet`. Use the discovered `adminBase`, including a custom prefix, and
pass keys in client options/headers. Namespace-specific private URL mappings must come from actual
discovery. Explicit variable mappings avoid guessing application variable names:

```ts
const values = renderConnections(publicManifest, privateManifest, "synthetic-customer", {
  DATABASE_URL: { service: "postgres" },
  REDIS_URL: { service: "redis" },
  STRIPE_BASE_URL: { service: "stripe" },
})
await writeConnections("app.env", values, "dotenv")
```

Missing services/namespaces are refused; HTTP URLs include the namespace base path.
`writeConnections` atomically publishes JSON/dotenv with mode 0600. Re-render after listener
replacement. The common HTTP service CLIs offer:

```sh
mockingbird-stripe fleet doctor --config mockingbird.json --json
mockingbird-stripe fleet control --base http://127.0.0.1:9000/__admin/fleet --action namespaces
mockingbird-stripe fleet render --manifest ready.json --connections private.json --mapping mapping.json --namespace synthetic-customer --output app.env --format dotenv
mockingbird-stripe fleet rehearse --config mockingbird.json --archive saved-archive.json
```

Control uses `MOCKINGBIRD_ADMIN_KEY` (or `--key-env NAME`); `--body FILE`, `--method` and
`--idempotency-key` support other routes. Doctor performs read-only load/schema/output-path and
optional `--endpoint URL` reachability checks, reports versions and a dry startup plan, and returns
nonzero for failures. It never resets state or probes storage by writing. Programmatic rehearsals
accept bounded async probes, restore an archive into distinct ephemeral listeners/storage, report
a machine-readable result, and clean up without changing source state or its latest pointer.

`GET /inspect?namespace={name}&service={service}&offset=0&limit=100&collection={table-or-key}`
reads the actual child engine. PostgreSQL lists public tables or bounded records from an explicitly
quoted table; Redis lists keys, type/TTL and queue counters. Inspection is separate from mutations,
and cannot execute arbitrary SQL/Redis commands. Limits are 1–1000 rows/keys.

`GET /diagnostics?namespace={name}&service={optional-service}` exports
`mockingbird.diagnostics/v1`: timestamp/process/generation, package/capability versions, configuration
fingerprint, selected diagnostic counters and up to 50 unmatched-request method/path fingerprints, limits and the last 50 operation summaries. It excludes
credentials, request bodies, raw records, model text and operation payloads. Truncation is explicit;
use a separately requested private archive for privileged state capture.

## Node transport limits

`serve(api,{maxBodyBytes,requestTimeoutMs})` streams uploads to Fetch handlers with incremental byte
limits (16 MiB and 30 seconds by default), including chunked bodies without Content-Length. Configure
larger bounded limits for archive imports; they still parse bounded JSON at the control handler.
Oversize and stalled uploads return 413 and 408. Request aborts, URL/Request construction failures
and response-body errors stay inside the adapter boundary. Disconnect cancels response streams and
releases backpressure waits. Configure the exported Node `serve` directly when custom transport
limits are needed; ordinary fleet CLI listeners use these defaults.

## Isolated runs, namespace forks and warm leases

All helpers below ship from `@crvouga/mockingbird-service-stripe/fleet`; the standalone internal
adapter package is not a consumer dependency. Load supported service `serveTarget` exports from
matching installed `@crvouga/mockingbird-service-*/server` packages. Independently bundled runtime
declarations are accepted at the loader boundary and their fleet protocol is checked before
listening. Missing/incompatible packages fail with concrete installation/version diagnostics.

`POST /namespaces/{source}/fork` accepts `{destination,bindings?}`. It fences the selected environment,
captures all child state and clocks consistently, provisions a new namespace, and restores rebased
HTTP/SQL/Redis state. Source state and archive identity stay unchanged. Existing destinations are
refused. The caller must be an administrator. Failed provisioning/restore is reported and cleaned
up or left fenced when recovery cannot be proven.

`withFleetRun(client,{baseline?,scenario?,verify?,preserveOnFailureMs?},async run => …)` owns a unique
namespace. The run descriptor exposes namespace, generation and discovered endpoints without admin
credentials. Use `run.registerCleanup(async () => …)` for application clients/workers. Cleanup runs
on success and failure, then the namespace is deleted. `FleetRunError` preserves original/cleanup
failures and diagnostic evidence. Optional debug preservation expires within one day; it does not
silently leak an indefinitely pinned namespace.

`NamespacePool` provides bounded prewarmed namespace leases, not shared vendor state. Acquiring
returns a unique lease identity/generation and expiry. Register client cleanup on the lease, then
release it: the pool closes clients, checks quiescence, restores and verifies its baseline before
making it warm again. Failed or expired leases are quarantined rather than reassigned. Waits have
a timeout/cancellation policy. Changing baseline version retires stale warm entries. This is an
in-process lease coordinator; use one pool owner, not independent competing pools for the same names.

## Restore bindings, archive protection and version upgrades

`POST /archives/bindings` plans explicit `{bindings:[{namespace,service,endpointId,endpointRef,secretRef?,signing?,signingRef?}],endpoints:{ref:url}}`
bindings without restoring. The `RestoreBindings` API lists only supported webhook endpoint and
signing-material fields; opaque records are never searched/replaced. Reports redact signing
material. Resolve secret references through the host-owned `resolveArchiveSecret` hook. Import and
fork may apply the same binding plan. Missing or ambiguous references fail before child mutation;
leave application-owned URLs untouched unless they have an explicit supported binding.

`archiveProtector({activeKeyId,trustedKeyIds,resolveKey})` uses RFC 7516 compact JWE with direct
A256GCM, random 96-bit nonces and authenticated key-id metadata. The resolver supplies 32-byte keys
from outside the artifact; the artifact contains no key. Keep previous key ids trusted only for the
required rotation window. Unknown keys, corruption and authentication failures reject before
archive parsing/restore; protection never falls back to plaintext. Hash identity remains the
verified inner archive identity, not a claim of ciphertext authenticity by itself.

Set `archiveProtection` on the fleet for protected control exports/imports. For at-rest protection,
pass the same protector to `filesystemRepository(directory,maxBytes?,protector)` or
`s3Repository({...options,protection:protector})`; protected fleet policy rejects an unprotected
repository. Use `client.exportProtectedArchive()` for its typed envelope and `importArchive()` for
either supported artifact type. Generic `request()` can also transport envelopes. Configure body
and repository byte limits for encryption overhead. Secrets and opaque application fields still
require careful privileged artifact access even when protection is disabled intentionally.

`archiveCompatibility(input,registry)` reports supported source formats, per-target version
transforms and blockers. `migrateArchive` applies only explicitly registered deterministic
transformations, produces a separately hashed v1 artifact and records provenance. Unknown formats
or incomplete transformation chains fail; source bytes/identity are preserved. `migrateAndVerify`
requires an independent verification callback before publishing to a repository. Rehearse a migrated
archive in a fresh fleet and verify application-specific probes before promoting it.

`incrementalArchive`, `materializeArchive`, `archiveReachability`, `publishIncremental` and
`compactArchive` offer optional content-addressed section deduplication with verified base chains.
Participants may still capture full sections; this does not claim engine-level change tracking.
Missing/corrupt bases, cycles and inconsistent target hashes fail. Materialization must match the
full archive's state and identity before promotion. Reachability protects every required base/object
from pruning. Compaction publishes only a verified independent full archive. Full archives remain
the default and the management import surface consumes materialized full artifacts.

## Competing writers and interrupted operation recovery

For shared storage, use `RepositoryWriter` with `filesystemConditionalStore` (same-host filesystem
mutex/CAS) or `s3ConditionalStore` (ETag/If-Match and If-None-Match). Acquire an owner lease and bind it
to the repository before supplying it to a fleet. Expired takeover must be explicitly allowed.
Renewals and latest publication compare the current generation/lease; a delayed previous writer
cannot publish after takeover. Immutable uploads can succeed independently, but only verified
objects become the fenced recovery pointer. Storage without the required conditional semantics
is refused. The ordinary repository alone is a single-writer convenience, not a distributed lock.

For a voluntary handoff, first stop accepting workload writes, drain application processes,
await the final archive upload and verified `publish`, then `await writer.release(lease)`.
Release keeps the latest verified archive and generation, marks the lease relinquished with a
conditional write, and lets the replacement `acquire` immediately without expired-takeover
permission. The replacement increments the generation. Release returns `"released"` or
`"already-released"` for a repeat of the same lease, and rejects stale leases after handoff.
Renew and publish reject released leases. A conditional conflict throws `writer release conflict`;
connectivity/storage errors propagate. After an uncertain response, retry the same lease (or
read the control record); never delete the record. Filesystem and S3 use the same CAS contract.
Expired-owner takeover remains a separate explicit policy.

`journal:filesystemOperationJournal(directory)` opts into fsynced per-operation metadata and
requires an archive repository. Before a mutation, capture a verified portable before-state where
available; durably record prepared/committing, then upload/publication and terminal outcomes.
Metadata contains ids, scope, action, fingerprints and archive hashes, never raw request bodies or
snapshots. Stale journal revisions cannot overwrite reconciliation from another controller.

On restart, prepared-only records can be marked abandoned before commit. A published archive is
accepted only after object verification and matching conditional-writer generation; it is restored
before readiness without rerunning the original mutation. Unprovable commit/rollback remains
`recovery-required`: affected namespaces stay fenced, health fails, and the manifest does not claim
ready. `GET /recovery` lists interrupted work. `POST /recovery/{id}/rollback` restores a verified
before-state; explicit namespace reset/restore can also resolve its own scope. An absent before-state
requires explicit reset. Required journal read/write failures are visible and cannot claim a durable
outcome. This covers declared portable participants, not exactly-once external effects or a final
backup after SIGKILL. Archive access and journal storage must remain available together.

## Audit, lifecycle telemetry, assertions and traces

`audit:{write,failurePolicy:"open"|"closed"}` sends attributable denied/attempt/terminal metadata to
a host sink. Entries contain actor/credential identity, namespace, selected participants, operation
id, real timestamp and outcome. They omit keys, bodies, records and signed URLs. `GET /audit` exposes
a bounded 200-entry administrator-only history and whether a durable sink accepted each record.
Restore does not rewind this administrative history. Fail-closed admission prevents mutation when
the sink is unavailable; terminal sink failure retains recovery fences. Memory-only history does
not claim durable or tamper-proof audit storage.

`telemetry(event)` receives operation id, phase, optional participant, action, status, host elapsed
milliseconds and recovery flag. Checkpoint, commit, rollback, workload hooks, upload verification
and publication share the operation correlation. `GET /telemetry` reports aggregate started,
succeeded, failed/cancelled, rollback attempts/failures, recovery-required, duration count/sum/max,
and hook/sink failure counts. Clock rewind cannot rewind durations. Defaults have no namespace
metric labels and require no collector. Hook failures are counted without changing vendor output.

`POST /assertions/baseline` creates a run-scoped observation cursor. `POST /assertions/{id}/check`
reports unmatched/rejected requests, applied faults, failed deliveries and current active/pending
work since that baseline. Explicit service/path-fingerprint/operation allowances may constrain
status and count. Pending queues are opt-in allowances; active work remains visible. Baselines do
not clear another run's vendor history. Retention is bounded and truncated evidence is explicit.
Request observations exclude bodies and credentials. See the exported `AssertionAllowance` type
for the exact allowlist shape.

`trace:true` enables privileged `POST /trace/start`, `GET /trace` and `POST /trace/stop`. A trace
holds a verified baseline plus bounded HTTP observations, response hashes and supported clock/reset
controls. Body capture requires `includeBodies:true`; sensitive JSON/form/query fields and
credentials are omitted. Limits are 200 events/1 MiB per trace, 64 KiB captured bodies and four
retained traces; overflow/truncation and unsupported controls are explicit limitations. Streams,
concurrent order and unrecorded protocol/external effects cannot claim complete serial replay.

`replayFleetTrace` restores into a distinct explicitly supplied synthetic fleet and checks response
hashes. It rejects replay into its source fleet, admin-path requests and undeclared/live destinations.
Only discovered loopback endpoints or an explicit synthetic-origin allowlist are eligible.
Incomplete artifacts require explicit `allowIncomplete` plus any necessary application credential
bindings; replay never silently reconstructs omitted credentials or contacts vendor production.

## Logical event stepping and participant certification

`POST /time/step-next` advances to the earliest declared event; `/time/run-until` accepts bounded
`condition:"no-events"|"idle"|"checkpoint-ready"`, `maxEvents`, `maxAdvanceMs` and `timeoutMs`, with
optional service selection. First freeze and align selected clocks. Redis declares key expiry and
BullMQ delayed-job deadlines; HTTP participants opt in through `nextEvent()`, while unsupported
participants are reported. After every step the controller settles timers and rechecks cross-child
events. Cycles or a delayed job without a worker stop at the budget with diagnostics. Optional
`synchronizeClock` runs after releasing mutation fences so application workers can consume work;
external worker clocks are not advanced by assumption. Host timeout uncertainty retains fences.

`launchFleet(command,config)` owns an installed CLI subprocess, private temporary config/discovery
files and bounded readiness/teardown. `participantConformance(factory,probe)` populates independent
namespaces, verifies reset isolation, captures state, destroys the first process, restores in a
second process and compares deterministic continuation. Declare included/excluded state explicitly.
Failure-injection probes certify capture/restore/rollback fences; unconfigured probes are reported
as exclusions, never inferred passes. The test suite exercises the bundled public Stripe CLI and
real mixed-protocol fresh-process recovery in the container reference.

External host state can implement `FleetChild` and register through `participants`; it joins the
same readiness, namespace, archive and fencing lifecycle. `fileParticipant(root,allowlist)` supplies
a bounded reference for explicitly allowed relative files. It rejects traversal, unexpected archive
paths and symlink traversal, scopes files by namespace and never lets an archive choose a host root.
Coordinate application processes through workload hooks; the helper cannot stop unrelated writers
that bypass its API.

## Schema, ordering, ingress and container deployment

Set `schemaVersion:1` and `$schema:"https://mockingbird.chrisvouga.dev/schemas/fleet-v1.json"` in fleet
JSON. The published JSON Schema and runtime validator share one source. `composeFleetSchema` admits
only declared target flags and registered extensions for authoring tools. Runtime config errors
include precise paths; unknown fields/future versions reject before listeners. Programmatic
extensions need explicit host integration rather than silently ignored configuration keys.

An instance name is independent of vendor identity: `{services:{billing:{target:"stripe"},payments:{target:"stripe"}}}`
creates independent endpoints and state. Omit `target` for existing suffix-based configurations.
Archives record target identity and reject mismatched restore targets. `dependsOn:["billing"]`
orders startup/verification and reverses shutdown; unknown edges and cycles fail in preflight.
Dependency ordering does not imply snapshot consistency with unregistered external systems.

`cors:{origins:["https://console.example.test"],methods?,headers?}` permits explicit browser origins
for aggregate controls. OPTIONS is unauthenticated only for allowed preflight combinations; actual
mutations still require credentials/scopes. Responses vary by Origin. Child vendor routes retain
their provider CORS behavior. Avoid wildcard credential policies.

For Stripe, `publicOrigin:"https://mocks.example.test",publicPath:"/billing"` separates the advertised
HTTP base from the private listener. Generated Checkout/portal links and namespace paths use the
fixed configured origin. `createFleetIngress(config,privateConnections)` is a streaming Fetch proxy
reference; use the private connection manifest, not advertised URLs, as its upstream map. It strips
forwarding/admin headers, preserves query and namespace carriers, streams bodies, propagates
cancellation, and keeps administration on a separate private listener. Supply TLS/DNS externally.

| Provider/profile | Origin/prefix behavior | Signing policy |
| --- | --- | --- |
| Stripe reference | Configured origin/prefix, hosted pages and namespace follow-ups tested | Vendor requests do not use host/path signing; webhook payload signatures remain intact |
| Cognito | Configured origin/prefix and namespace JWT discovery/authentication; restore on changed private ports tested | RS256 issuer/JWKS certified; SigV4 requests require direct endpoints |
| Medplum | Configured FHIR/OAuth origin/prefix and namespace links, pagination, restored state tested | Existing OAuth/project policies; reacquire tokens after restore |
| S3 and other providers | Public origin/prefix mapping is explicitly unsupported/discoverable | Use direct endpoints preserving signed host/path/query; arbitrary rewrites are not certified |
| PostgreSQL/Redis | Actual protocol endpoints and explicit host port mappings | HTTP reverse-proxy options do not apply |

Untrusted Host/Forwarded headers never replace the configured public origin. Other mappings fail
preflight; SDK path-prefix support must not be assumed. The opt-in
[single-container reference](../packages/examples/fleet-reference/README.md) pins a source/lockfile
inventory and Bun image digest, runs non-root without a Docker socket, supports Linux amd64/arm64,
and verifies controlled shutdown plus fresh-process HTTP/PostgreSQL/Redis archive restoration.
It supplies packaging and lifecycle, not live hosting or an automatic deployment.


`outbound:{mode:"offline"|"allowlist",origins?,maxRedirects?,maxBodyBytes?,onReject?}` restricts
fleet-owned webhook delivery. Offline sends fail locally; allowlist mode checks every destination
and redirect, bounds bodies/redirects, and emits only namespace/policy/reason rejection metadata.
Configured proxy/fetch injection remains host-owned. Discovery identifies HTTP children using the
WebhookHub transport and reports unsupported participants. This is not a network sandbox for SDKs,
application sockets, arbitrary provider-specific transports or DNS rebinding; apply a separate
network policy when those need isolation. No outbound restriction is enabled by default.

Provider-specific ingress limits and acceptance coverage are documented in the
[Cognito README](../packages/service/cognito/README.md#fleet-fixtures-and-public-identity-endpoints) and
[Medplum README](../packages/service/medplum/README.md#fleet-public-ingress).
