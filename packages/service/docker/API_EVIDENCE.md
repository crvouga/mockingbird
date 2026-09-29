# Docker Engine API evidence

US-002 research, retrieved **2026-09-25 UTC**. Status: documentation and pinned
source inspected; **historical research status, superseded by the US-013 live
run recorded below**.
This file defines a planned subset, not an implemented support claim. See
[boundaries and scenario IDs](../../../docs/INFRASTRUCTURE_MOCKS.md).

## Compatibility target and provenance

- API target: **v1.52**. The downloaded reference declares Swagger 2.0,
  `info.version: 1.52`, `basePath: /v1.52`.
- Historical proposed oracle (superseded by user direction in US-013):
  **Docker Engine 29.1.0**, Linux, default API settings.
  This is a reproducible compatibility pin, not a recommendation to downgrade a
  host or a claim of availability. No default Docker socket was queried.
- Verified upstream tag: `docker-v29.1.0`, commit
  `710302ecf2e958db92cb7d92f8838ea063a31765`. The initial guessed `v29.1.0`
  tag returned 404; it is not the source pin.
- Pinning evidence: [release tag object](https://api.github.com/repos/moby/moby/git/tags/ab0910fb285e342a43491868a095052ac24308d8),
  [pinned tree](https://github.com/moby/moby/tree/710302ecf2e958db92cb7d92f8838ea063a31765).
- Versioned docs [D1](https://docs.docker.com/reference/api/engine/version/v1.52.yaml)
  SHA-256: `893db6d64dad76a0662e33557f1689f7b394cbf1a2fa2d1a9dc5e2e2edbe0e25`.
- Pinned specification [S1](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/api/swagger.yaml)
  SHA-256: `69fe12ce2c6ef1e42a317e5c3d60c9e0dbc5bf4f30e56472ab947975d9a6eedb`.
  Both YAML files were fetched and parsed. Their selected path objects agree
  except that D1 adds a `400` response to ContainerStart; S1 omits it.

Immutable source references used below:

| ID | Source | Evidence used |
| --- | --- | --- |
| S2 | [Version middleware](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/server/middleware/version.go) | Default version for unversioned calls; version errors and response headers |
| S3 | [Server routing](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/server/server.go) | Versioned/unversioned route registration; error formatting; unknown path/method |
| S4 | [Container routes](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/server/router/container/container_routes.go) | Attach handshake/errors; wait response timing; stop completion |
| S5 | [Daemon configuration](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/config/config.go) | Maximum 1.52, default minimum 1.44; configurable floor down to 1.24 |
| S6 | [Container stop](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/stop.go) | Stop waits for termination; cancelling the request does not undo the stop |
| S7 | [Container state](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/container/state.go) | Wait conditions, immediate results and cancellation |
| S8 | [Container attach](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/attach.go) | Multiplexed output, raw input, OpenStdin/StdinOnce, paused/restarting conflicts |

## Context7 research record

Resolved `Docker` with the query “Docker Engine API v1.52 container lifecycle and
HTTP attach upgrade protocol official documentation.” Selected `/docker/docs`
because it is the official docs repository. Resolver advertised only
`__branch__main`, not a pinned v1.52 library version. Three queries were made;
their results are discovery evidence, not v1.52 verification:

| Query scope | Returned source/version | Claim and reconciliation |
| --- | --- | --- |
| v1.52 attach upgrade, 101, framing, stdin and TTY | [v1.19](https://github.com/docker/docs/blob/main/_vendor/github.com/moby/moby/api/docs/v1.19.md), [v1.23](https://github.com/docker/docs/blob/main/_vendor/github.com/moby/moby/api/docs/v1.23.md), v1.11/v1.17/v1.18 excerpts | Historical raw-stream/upgrade examples. Superseded for this subset by D1/S1 and S4/S8: non-TTY v1.52 upgrade uses multiplexed-stream. |
| v1.52 create/start/stop/kill/wait/remove lifecycle statuses and conditions | [current SDK examples](https://github.com/docker/docs/blob/main/content/reference/api/engine/sdk/_index.md), [v1.16 stop](https://github.com/docker/docs/blob/main/_vendor/github.com/moby/moby/api/docs/v1.16.md), v1.0/v1.20 excerpts | General create/start/wait and old stop statuses; insufficient for current lifecycle semantics. D1/S1 and S4/S6/S7 supply the pin. |
| v1.52 discovery, unversioned calls, version rejection, inspect/list | [CLI deprecations](https://github.com/docker/docs/blob/main/_vendor/github.com/docker/cli/docs/deprecated.md), v1.22/v1.44 excerpts; unrelated Docker Agent `/api/ping` | Historical guidance deprecates unversioned calls, but S2/S3 still register/default them in this pin. Docker Agent ping is unrelated and excluded. |

The [current API matrix](https://docs.docker.com/reference/api/engine/#api-version-matrix)
maps Engine 29.0/29.1 to API 1.52. S5, rather than current-main prose, establishes
the exact selected daemon's defaults. Refresh Context7 and primary evidence before
adding operation families or changing versions, and before US-010 transport work.

## Version routing and rejection policy

US-004 refresh (2026-09-27): Context7 `/docker/docs` still exposes only main.
List/inspect queries returned v1.4/v1.6/v1.56 excerpts; info/rootless queries
returned v1.12/v1.20/current docs. None replaces the pinned 1.52 source.
Newly inspected pinned sources are
[daemon/list.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/list.go),
[daemon/inspect.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/inspect.go),
[filters/parse.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/internal/filters/parse.go), and
[httputils/form.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/server/httputils/form.go).
List uses creation-descending order, AND label matching, OR status/exit values,
unique ID-prefix selection, and name regex matching. A status filter or positive
limit includes non-running containers. Exited filtering requires a stopped
container that has started. JSON filter maps accept legacy arrays and boolean
sets (keys matter even if false); null denotes an empty map. Boolean query
parsing is permissive: trimmed empty/0/no/false/none are false, other values true.
The mock bounds name regex support as documented in README and returns explicit
501 for other patterns/filters. No installed Engine or differential run was used.
Pinned [container lookup](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/container.go)
and [prefix lookup](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/container/view.go)
confirm full ID, exact name, then unique prefix precedence; ambiguous prefixes
return InvalidParameter (400), while missing containers return 404.
List status descriptions follow pinned S7 and its
[duration formatter](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/vendor/github.com/docker/go-units/duration.go),
using the injected mock clock rather than host process uptime.

S2/S3 explain why the observed `/v1.52/containers/{id}/attach` and unversioned
`/info` can belong to one client: every provider route is registered with and
without a version, and an absent version uses the daemon default (1.52 here).
Deprecation guidance is not evidence that this pinned daemon rejects `/info`.

Planned mock policy: support v1.52 and unversioned aliases for the listed subset.
Do not claim to emulate all older APIs merely because the real Engine accepts them.
For numeric versions above 1.52, use the provider's too-new `400` error; versions
below the default minimum 1.44 use its too-old `400` error. Versions 1.44–1.51
are **unsupported by this mock subset**: return an explicitly Mockingbird-labelled
`501` message, not a fictional Engine rejection. Historical compatibility can only
be expanded with new evidence. Document these mock-only 501 responses in codegen.

Provider version-error message templates from S2 are:

```text
client version <v> is too new. Maximum supported API version is 1.52
client version <v> is too old. Minimum supported API version is 1.44, please upgrade your client to a newer version
```

S3 serializes errors as `{"message":"..."}` except requests below API 1.24,
which receive plain text. Unknown paths/methods use `404` with
`{"message":"page not found"}`. Malformed version paths are not a promise of
version negotiation. No automatic client reconnection or fallback is part of
the mock. Its declared API support must remain distinct from simulated Engine
`MinAPIVersion` metadata.

## Planned operation contract

Paths below are relative to `/v1.52`, also available unversioned as above.
The status column is the pinned S1 vendor contract; additional implementation
errors supported by pinned source must be annotated explicitly, not silently
invented. Global version errors and mock-only unsupported-feature errors are
separate from this table. Unless stated otherwise, vendor errors use
`ErrorResponse` with required string `message`.

| Method/path (operation ID) | Inputs and bounded planned behavior | Vendor statuses |
| --- | --- | --- |
| GET/HEAD `/_ping` (SystemPing/SystemPingHead) | GET body `OK`, HEAD empty; API-Version, Builder-Version, Docker-Experimental, Swarm and cache headers | 200, 500 |
| GET `/version` (SystemVersion) | Version, ApiVersion, MinAPIVersion, Os, Arch, GitCommit and system/build metadata; simulation labelled in package docs | 200, 500 |
| GET `/info` (SystemInfo) | Synthetic daemon identity, container counts, operating-system and security observations; availability independent of container state | 200, 500 |
| GET `/containers/json` (ContainerList) | `all` defaults false, `limit`, `size`; JSON `filters` map. Initial filters: id, name, status, label, exited. Other filters explicitly unsupported | 200, 400, 500 |
| GET `/containers/{id}/json` (ContainerInspect) | Container ID/name; `size` defaults false. Coherent Id, Name, Image, Config, HostConfig, State and NetworkSettings | 200, 404, 500 |
| POST `/containers/create` (ContainerCreate) | `name`, `platform`, ContainerConfig plus HostConfig/NetworkingConfig; seeded local image lookup, name uniqueness, immutable Id and Warnings | 201, 400, 404 (image missing), 409 (conflict), 500 |
| POST `/containers/{id}/start` (ContainerStart) | ID/name; no execution. Supported transition and already-running result; detachKeys/checkpoint features outside initial subset | 204, 304, 404, 500; D1 additionally documents 400 |
| POST `/containers/{id}/stop` (ContainerStop) | ID/name, signal, integer timeout `t`; pending graceful termination then completion | 204, 304, 404, 500 |
| POST `/containers/{id}/kill` (ContainerKill) | ID/name, signal (default SIGKILL); supported signal observations, no host signal | 204, 404, 409 (not running), 500 |
| POST `/containers/{id}/wait` (ContainerWait) | ID/name, condition omitted/empty => not-running; also next-exit and removed | 200, 400, 404, 500 |
| DELETE `/containers/{id}` (ContainerDelete) | ID/name, force; `v`/`link` default false. Volumes/legacy links outside subset | 204, 400, 404, 409, 500 |
| POST `/containers/{id}/attach` (ContainerAttach) | Node upgrade only; stream=true, logs=false, stdin/stdout/stderr selections, Tty=false | 101 (upgrade), 200 (real non-upgrade, unsupported here), 400, 404, 500; S8 additionally shows 409 |

S1 schemas distinguish container list summaries from inspection. `ContainerState`
includes Status, Running, Paused, Restarting, OOMKilled, Dead, Pid, ExitCode,
Error, StartedAt and FinishedAt. A simulated Pid or rootless/security field is not
host evidence. An image reference in Config.Image, immutable image identity in
Image, and container Id must not be conflated. Create returns `Id` and `Warnings`;
wait returns integer `StatusCode` with optional `Error.Message`.

Initial creation scope stores Image, Cmd, Entrypoint, Env, Labels, WorkingDir,
User, attachment/OpenStdin/StdinOnce/Tty flags, StopSignal/StopTimeout and declared
HostConfig/NetworkingConfig metadata. Mount/resource/network settings are stored
observations only. Do not accept unsupported configuration as executed or enforced.
Resolve any newly supported field's validation against S1 before implementation.

## Lifecycle details that constrain implementation

US-005 refresh (2026-09-27): Context7 returned v1.56/current networking and
entrypoint examples, used only for discovery. Pinned
[creation](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/create.go)
and [configuration merge](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/commit.go)
establish image resolution, platform warnings, request-over-image environment
and label precedence, command/entrypoint defaults, empty-entrypoint clearing,
and `no command specified` (400). The selected 1.52 request fields come from S1.
The mock stores launch/host/network configuration without executing it. Full
daemon resource/network validation and image execution are excluded; the README
lists the explicit supported subset and mock-only501 behavior. No real Engine
creation or host resource operation was performed.

- S4/S6: a successful stop `204` follows backend completion. For delayed-stop
  scenarios, keep the HTTP operation pending until modeled termination; an admin
  observation that a stop was received is not an early successful vendor response.
  A lost reply or cancellation does not reverse an already accepted stop. This
  preserves US-007's distinction between request acceptance and actual retirement
  without inventing a 202-like Docker acknowledgement.
- S7: not-running completes immediately when the condition already holds;
  next-exit does not. Removed waits for removal, which also wakes stop waiters.
  S4 sends HTTP 200 headers before the wait result for this API version, then
  writes the eventual JSON result. Tests must distinguish header arrival from
  body completion and cover client cancellation, reset and shutdown.
- S1: start on an already-running container and stop on an already-stopped
  container use 304, not a fabricated second transition. Kill on a non-running
  container is a conflict. Force removal kills before removal; it is not a
  permission to remove host resources.
- Before/after-mutation fault points must preserve state/journal/Timeline evidence
  independently of delivery. No source here proves shared-runtime correctness,
  restart/live-restore, or active socket restoration; those are later test gates.

## Attach wire contract and limits

For the supported non-TTY upgrade, send `Connection: Upgrade` and `Upgrade: tcp`.
S4 returns the following header block for v1.52, followed immediately by stream
bytes (the reader must retain bytes received with the final header fragment):

```http
HTTP/1.1 101 UPGRADED
Content-Type: application/vnd.docker.multiplexed-stream
Connection: Upgrade
Upgrade: tcp

```

D1/S1's old illustrative handshake uses raw-stream, but its framing prose and
S4 agree on multiplexed-stream for upgraded non-TTY API >=1.42. S4's non-upgrade
path really uses HTTP 200/raw-stream; it is deliberately excluded from initial
mock serving. Fetch cannot represent the raw hijacked duplex connection.

Output frames have an 8-byte header: stream byte (1 stdout, 2 stderr), three zero
bytes, and a uint32 big-endian payload length, followed by exactly that many bytes.
The spec also describes stream 0 as stdin written to stdout; it is not an input
framing requirement. S8 wraps output writers only: client stdin is raw bytes,
enabled only when requested and OpenStdin is true. StdinOnce influences EOF/
lifetime and needs explicit tests; stdin data must not enter the metadata journal.
Fragmentation, zero-length payloads, backpressure, EOF and cancellation must be
tested using an independent consumer. Stream closure alone does not establish
container termination.

Error caveat: S4 handles attach backend errors by hijacking, writing an HTTP error
with stream content type and a plain-text body, then closing. This differs from
the specification's generic ErrorResponse schemas. S8 rejects paused/restarting
containers with conflicts. Implement and test the actual pre-upgrade missing/
conflict wire errors separately from ordinary JSON REST errors; live oracle
execution remains necessary to establish observed fidelity.

Excluded modes: TTY/PTY, websocket attach, non-upgrade attach, log replay
(`logs=true`), exec, standalone logs/events, detach-key processing, image
pull/build, real networking/volumes/health checks and arbitrary command execution.
Unsupported modes receive explicit mock-only 501 errors before upgrade rather
than silently different successful behavior. Reset/checkout/shutdown terminate
owned streams and waiters; handles are never serialized into Timeline state.

## Verification gaps and oracle requirements

The original US-013 proposal required Engine 29.1.0. The user superseded that
restriction: use the current selected Engine without downgrading the host.
US-013 now records an authorized Engine 29.8.0 run below, including actual
version/API configuration, image identity and cleanup evidence. Engine process restart/live-restore
needs its own scoped operational authorization and evidence. Harness construction
alone cannot complete that story.

US-004–US-012 must resolve exact filter/name matching, signal validation/error
wrapping, identifier-prefix ambiguity and every newly implemented field against
this source pin before advertising support. US-010 must refresh attach research,
test pre-upgrade errors and supported stdin/EOF semantics. Post-mutation history
capture and stream invalidation remain implementation hypotheses, not upstream
guarantees. No SDK is claimed pinned or exercised by this research story.


### US-006 start/wait implementation evidence

Context7 `/docker/docs` was refreshed for start/wait on 2026-09-27. It returned
current SDK flow examples and older API excerpts, so the pinned sources remain
authoritative. [Start validation and transitions](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/start.go)
checks paused before running, returns304 for running/restarting, and409 for
removal/dead state. S4 rejects start bodies with ContentLength above7 or unknown
chunked length. S7 preserves FinishedAt across SetRunning, resets ExitCode, and
notifies all stop waiters at SetStopped; removal also wakes removal-only waiters.

The implementation uses explicit admin completion instead of executing a task.
AutoRemove completes synthetic removal atomically within that synchronous control.
Wait response headers and completion bodies are separately tested through Fetch
and Node HTTP; client cancellation, body cancellation, reset, and close release
transient handles. This is source-backed simulation evidence, not live Engine
parity. Restart policies, process scheduling and host execution are not simulated.


### US-007 termination/removal evidence

Context7 `/docker/docs` refreshed stop/kill/remove on 2026-09-27: current SDK/CLI
stop examples, timeout guidance, and historical v1.6/v1.11 operation excerpts.
Pinned sources resolve the precise v1.52 semantics:

- [kill.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/kill.go): SIGKILL (including an explicit numeric9) waits for exit; other signals acknowledge delivery. Stopped containers conflict. Linux signal names/numbers are validated before lookup.
- [delete.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/delete.go): concurrent removal conflicts, non-forced running/paused removal conflicts, and force kills before deleting and releasing the name.
- [signal.go](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/vendor/github.com/moby/sys/signal/signal.go) and [Linux map](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/vendor/github.com/moby/sys/signal/signal_linux.go): zero is invalid; kill restricts to the Linux map (1–31 and34–64). Real-time aliases are supported.
- S4/S6 and [HTTP status mapping](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/server/httpstatus/status.go): malformed t returns an unclassified strconv error (500), while a stop signal parsing error is wrapped as System (500). Kill signal errors are InvalidParameter (400). Stop on an already stopped record returns304 before validating its signal.

The mock holds stop/SIGKILL/forced-removal replies until explicit completion;
acceptance and socket loss never prove retirement. Signal/timeout parameters are
stored diagnostic metadata; fixture-controlled completion replaces process/timer
scheduling. v is inert without modeled volumes; link removal is explicit mock-only501.
Shared state/checkpoints and transient handles are reused. Fetch and real Node HTTP
tests cover acceptance versus exit and response loss; no live Engine parity claimed.

## US-009 transport implementation evidence

Node's [HTTP API](https://nodejs.org/api/http.html) documents the parser header
limit, receive timeouts and retained connections. The Docker-local transport uses
these Node facilities plus its own bounded body collector and owned connection
set. [Node IPC sockets](https://nodejs.org/api/net.html#ipc-support) define local
path serving and normal server-close cleanup. Transport bounds and path refusal
are explicit mock controls, not assertions of Docker daemon limits. Verification
uses synthetic project-local Unix sockets and TCP, including a built-entry fixture
executed under Node; it does not use Linux peer credentials or a real Engine.

## US-010 handshake implementation refresh

Context7 `/docker/docs` was refreshed for v1.52 attach on 2026-09-27 and returned
v1.23/v1.19/v1.11 examples. Re-reading pinned S4/S8 confirmed the existing wire
contract above; historical raw-stream examples do not supersede non-TTY v1.52
multiplexed-stream. The Node path now implements admission/headers and plain-text
backend errors, with synthetic fragmented-write/initial-byte fixtures and an
independent raw consumer exercised under Bun and Node. Namespace/branch/fault
selection stays in shared runtime; private response notes record upgrade101
without a POST mutation checkpoint. Plain Fetch remains unsupported. Full stream
framing, stdin semantics and history invalidation are US-011; real parity remains
US-013. These tests do not establish host enforcement or consumer policy.

## US-011 stream framing and lifetime

The pinned [stream copier](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/internal/stream/attach.go)
adds EOF detail to S8: effective stdin copies raw bytes; non-TTY CloseStdin closes
container input, while the other EOF path closes the attachment's output pipes.
S8 separately waits for process-not-running for non-TTY StdinOnce. Implemented
synthetic controls distinguish input EOF, output EOF, cancellation, and explicit
process completion. Source evidence is not a live-oracle claim. The pinned
[Linux close notifier](https://github.com/moby/moby/blob/710302ecf2e958db92cb7d92f8838ea063a31765/daemon/server/router/container/notify_linux.go)
uses EPOLLHUP; portable Node tests assert observed reset/close, not kernel
provenance. Raw consumers cover fragmented frames, bytes and channel selection,
input read-ahead/half-close, bounded slow-reader output, peer reset, and instance
invalidation with stale-handle rejection. Native Node also exercises framing,
raw input, StdinOnce half-close and process completion.

## US-012 — independent consumer verification

The package-owned `test/node-consumer.mjs` imports only the built server entry for
fixture ownership; its clients use native Node HTTP and raw socket bytes over TCP
and Unix. All mutations, inspections, setup and completion travel through HTTP;
Node attachment handles supply scripted output/input observation. Both transports
exercise accepted create/start/stop/kill/remove response loss and re-inspection,
retained ordinary HTTP connections and fragmented attach with exact binary frames.
This is independent client/protocol evidence against the mock, not a real Engine
oracle or evidence of the external consumer's retry policy.

OpenAPI walks assert eligible planned/exercised operation coverage. A seeded
nonempty list passes unchanged and fails on a deliberate schema-valid State
mismatch; the existing ping mismatch check remains. Blocking operations and attach
retain their deterministic lifecycle/protocol evidence. PRD inspection provenance
identifies raw-socket Docker consumers; there is no declared SDK consumer, no SDK
pin exercised here, and no SDK compatibility claim.

## US-013 — current Engine oracle

User direction on 2026-09-27 superseded the exact old-Engine prerequisite: use the
current Engine and do not downgrade the local Docker installation. Desktop 4.92.0
reports Engine **29.8.0**, Linux/arm64, GitCommit `3ce5872`, API maximum **1.56**,
minimum **1.40**. The [official release notes](https://docs.docker.com/engine/release-notes/29/)
list standalone **29.8.1** as the latest patch; this run establishes 29.8.0 evidence
only. API **1.52** remains the observed consumer contract and comparison subset.
This separates the API contract from the executable Engine used as an oracle.

Refreshed Context7 `/docker/docs` on 2026-09-27. It returned current negotiation
and release guidance plus historical v1.17 attach excerpts; those excerpts do not
establish current wire behavior. Resolved `docker-v29.8.0` through its
[tag object](https://api.github.com/repos/moby/moby/git/tags/dc4db3d292c317ca216dae9301dffc935c8d7680)
to commit **3ce5872b7950c63ba2ffbc5123101019ff3e6682**, matching the running daemon.
Compared selected pinned sources against the prior 29.1.0 source:

- [Version middleware](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/server/middleware/version.go),
  [daemon attach](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/attach.go), and
  [stream attach](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/internal/stream/attach.go)
  are unchanged between those pins.
- [Container routes](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/server/router/container/container_routes.go)
  retain the selected attach/wait paths. Changes include invalid-parameter error
  wrapping, legacy capability rejection and API 1.56 Umask handling; the live
  scenarios do not send those fields or malformed parameters.
- [Stop](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/stop.go)
  and [kill](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/kill.go)
  now use configured daemon default stop timeout and propagate non-cancelable
  contexts. This oracle uses explicit `stop?t=0` and `kill?signal=KILL`; it does not
  establish custom daemon-default timeout equivalence.
- [Image/config merge](https://github.com/moby/moby/blob/3ce5872b7950c63ba2ffbc5123101019ff3e6682/daemon/commit.go)
  changes map copying without changing the explicit-entrypoint command merge rule.

The authorized live run used an explicit Docker Desktop Unix endpoint and existing
Linux/arm64 image `sha256:dbbd346860d29f1543e991f30f3284bf4ab5f096d049ecc3426528f20b1b6e6b`.
No image installation, daemon restart or privileged Engine setup was performed.
Run `mb-oracle-ab4aefb9657d4b6993bc5f5273593796` passed **29 normalized comparisons**:
create/start/remove statuses; created/running/exited inspection; 101 attach headers;
raw stdin echo and separated stdout/stderr bytes; exit 7; stop/kill exit 137;
wait results and post-removal 404. The three named/labeled containers were confirmed
absent during cleanup. The [captured JSON report](evidence/engine-29.8.0-api-1.52.json)
retains actual/model values, image identity, exact Engine version and cleanup.

An earlier attempt failed at mock image seeding before creating any container:
the PostgreSQL image contained unsupported metadata and declared storage. The
harness now rejects declared volumes/active healthchecks and projects only modeled
image defaults, recording omitted metadata. The successful fixture omitted
`ArgsEscaped` and `ExposedPorts` from synthetic image defaults; no ports were
published and no config-equivalence claim covers those fields.

Normalization excludes dynamic IDs/timestamps, daemon identity/platform fields,
frame/packet boundaries and cross-channel interleaving. The mock scripts expected
process completion; it never executes the image. Existing synthetic response-loss
checks remain separate from real Engine execution. Daemon restart/live-restore,
host isolation, SDKs, all API 1.56 features and external consumer policies remain
unverified. The historical mock discovery profile remains explicit; this narrow
live run does not certify every operation/response field against every newer Engine.
