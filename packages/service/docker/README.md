# @crvouga/mockingbird-service-docker

Work-in-progress Docker Engine API 1.52 mock. It implements GET/HEAD `/_ping`,
GET `/version`, `/info`, `/containers/json`, and `/containers/{id}/json`, plus
Mockingbird's shared runtime controls. POST `/containers/create` persists a stopped
container. Start, wait, stop, kill, and removal use explicit simulated completion.
The Node entry supports non-TTY attach and scripted duplex streams. The contract is
pinned in [API_EVIDENCE.md](API_EVIDENCE.md); [SUPPORT.md](SUPPORT.md) lists operations.

## Install

```sh
bun add @crvouga/mockingbird-service-docker
```

## Usage

```ts
import { createRuntime } from "@crvouga/mockingbird-service-docker"

const docker = createRuntime({ seed: 42 })
const response = await docker.fetch(new Request("http://docker.mock/_ping"))
console.log(await response.text()) // OK
```

Use `DockerAPI` for the provider-only Fetch surface, or `createRuntime` for health,
admin controls, namespaces, faults, metrics, and the request journal. Neither entry
imports a Node server. The Node entry provides `createServer()` with an ephemeral
loopback port by default; close it with `await server.close()` after a test.

```sh
mockingbird-docker serve --port 8826
```

HTTP clients can target `http://127.0.0.1:8826`. A Docker client using `DOCKER_HOST`
can select `tcp://127.0.0.1:8826`. Unversioned and `/v1.52` provider routes work.
Versions above 1.52 or below the simulated Engine minimum 1.44 receive provider
400 errors (plain text below 1.24, JSON otherwise). Versions 1.44–1.51 receive an
explicit mock-only 501: their wire formats are not implemented. The mock reports
a synthetic Engine 29.1.0 identity; this is not a required local Docker version.
Selected API 1.52 scenarios passed against Engine 29.8.0; full client and Engine
compatibility are not claimed. See [verification boundaries](#verification-boundaries).

## Node HTTP example

Run this with Node against the built package. The server uses an ephemeral
loopback port and synthetic state; no Docker installation is needed.

```ts
import { createServer } from "@crvouga/mockingbird-service-docker/server"

const server = await createServer({ seed: 42 })
try {
  const response = await fetch(`${server.url}/v1.52/version`)
  if (!response.ok) throw new Error(`Docker mock returned ${response.status}`)
  console.log(await response.json())
} finally {
  await server.close()
}
```

For Unix sockets, pass an absolute, absent `socketPath` in your test directory
and use Node HTTP requests as described below. The CLI uses the shared TCP
adapter; use `createServer` for Docker's attach and Unix-socket transport.

## Synthetic observations

`POST /__admin/docker/seed` atomically adds images and containers in the selected
namespace. It never downloads an image or starts a process. For example:

```ts
import { createRuntime } from "@crvouga/mockingbird-service-docker"

const docker = createRuntime({ seed: 42 })
await docker.fetch(new Request("http://docker.mock/__admin/docker/seed", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    images: [{ id: `sha256:${"a".repeat(64)}`, tags: ["synthetic:latest"] }],
    containers: [{
      id: "b".repeat(64), name: "worker", image: "synthetic:latest",
      status: "running", labels: { suite: "example" }, cmd: ["synthetic-worker"],
    }],
    daemon: { rootless: true },
  }),
}))
```

Image IDs are immutable SHA-256 strings; container IDs are separate 64-character
lowercase hexadecimal strings. Container `image` resolves an existing image ID
or exact tag. Duplicate IDs, names and image tags conflict; unknown images return
404. Invalid seed fields return 400 and roll back the entire seed. Container
fields also accept `exitCode`, `entrypoint`, `env`, `workingDir`, `user`,
`hostConfig`, `networkSettings`, `sizeRw`, and `sizeRootFs`. Status is one of
`created`, `running`, `paused`, `restarting`, `removing`, `exited`, or `dead`.
Timestamps use the mock clock; reported PIDs are zero, never host processes.

`GET /__admin/docker/daemon` reports `{ available, rootless, simulated: true }`.
`POST` to the same route changes either boolean. `available: false` drops provider
requests while shared health/admin routes remain accessible and container state
is retained. Rootless, security, OS, build, size, and resource metadata are
synthetic observations, not host attestation or enforcement.

List defaults to running containers, including paused/restarting ones. `all`,
positive `limit`, or a `status` filter includes stopped containers. `limit` selects
the newest results; `size` includes the seeded byte counts. Like the pinned
Engine's boolean parser, empty/0/no/false/none (case-insensitive) mean false and
other values mean true. Inspect resolves full IDs, unique prefixes, and names.

`filters` accepts JSON string arrays or boolean-key sets for `id`, `name`,
`status`, `label`, and `exited`. Categories combine with AND; values within a
category combine with OR, except labels which all must match. Name matching
supports literals, dots, anchors, and at most one `.*`; other regex constructs
and other filter categories return explicit mock-only 501 errors. Malformed
filter shapes, statuses and exit codes return 400. Seeded state and daemon
settings participate in shared reset and Timeline checkpoints.

## Container creation

Seed images before calling `POST /containers/create`. Image seeds may include
`platform` (default `linux/amd64`) and `config` containing supported image defaults.
Creation resolves image IDs or exact tags, adding `:latest` to an untagged reference.
It never pulls or executes an image. Missing images and requested platform
mismatches return 404; an implicit host-platform mismatch produces a warning.

The supported body fields are `Image`, `Cmd`, `Entrypoint`, `Env`, `Labels`,
`WorkingDir`, `User`, `Hostname`, `Domainname`, `AttachStdin`, `AttachStdout`,
`AttachStderr`, `OpenStdin`, `StdinOnce`, `Tty`, `NetworkDisabled`, `StopSignal`,
`StopTimeout`, `HostConfig`, and `NetworkingConfig`. Unsupported fields return
explicit mock-only 501 errors. Bad field types, relative working directories,
invalid stop signals, invalid names, and missing commands return 400.
Image defaults supply commands/entrypoints, environment, labels and selected
strings. Request environment keys and labels take precedence. `Entrypoint: [""]`
clears the image entrypoint; provide a replacement command when doing so.

Use `?name=...` for a stable name. Conflicting names return 409, including concurrent
creation requests. Omitted names use `mockingbird_<id-prefix>`. Responses contain
`Id` and `Warnings`; IDs are deterministic synthetic 64-character hex strings,
immutable within stored records and restored with the shared ID sequence by
Timeline checkout. New records inspect as `created` with `Running: false`.

Supported `HostConfig` metadata includes `NetworkMode`, `IpcMode`, `PidMode`,
`CgroupnsMode`, `Runtime`, `AutoRemove`, `ReadonlyRootfs`, `Privileged`, `Init`,
`Memory`, `MemorySwap`, `NanoCpus`, `CpuShares`, `PidsLimit`, `Binds`, `CapDrop`,
`CapAdd`, `SecurityOpt`, `Dns`, `ExtraHosts`, `Mounts`, `Tmpfs`, `PortBindings`,
`RestartPolicy`, and `LogConfig`. `NetworkingConfig.EndpointsConfig` is retained
under inspected `NetworkSettings.Networks`. These are declared configuration
observations, not enforced resources, mounts, security controls or network setup.
Nested host metadata is retained as supplied; full daemon-specific resource and
network validation is not modelled. No host isolation claim follows from it.

## Start, wait and scripted completion

`POST /containers/<id>/start` marks a created/exited container running (204),
returns 304 when already running/restarting, and returns 409 for paused, dead,
or removing records. No image is executed. The clock supplies `StartedAt`;
restart clears the exit code but retains the prior `FinishedAt` until completion.
Checkpoint, checkpoint-dir and detachKeys options return explicit mock-only 501.
As in the pinned Engine route, bodies longer than seven bytes and chunked bodies
return 400; use an empty body.

`POST /containers/<id>/wait?condition=...` accepts `not-running` (also the default
for omitted/empty values), `next-exit`, or `removed`. Headers arrive immediately;
the JSON body `{ "StatusCode": 7 }` arrives only when the condition holds.
Not-running returns immediately for stopped/created containers. Next-exit waits
for a future exit even if already stopped. Removed remains pending after an
ordinary exit. Invalid conditions return 400 and unknown containers return 404
before opening the stream.

Use `POST /__admin/docker/containers/<id>/complete` with `{ "exitCode": 7 }` to
explicitly finish a running synthetic container. Completion persists `exited`,
`FinishedAt`, and the supplied integer code, wakes relevant waiters, and captures
a shared Timeline checkpoint. If `HostConfig.AutoRemove` is true, completion also
removes the synthetic record and satisfies removed waits. No host resource is
touched. Repeated completion while stopped returns 409. These controls operate on
the selected namespace's main branch; provider operations can use shared branches.

`GET /__admin/docker/waits` reports the namespace's pending wait and termination-reply handles.
Aborting the request or canceling its response body releases its wait handle.
Reset cancels waits in the reset namespace; `runtime.close()`, `DockerAPI.close()`
and `createServer().close()` cancel owned waits. Canceled bodies reject rather
than fabricate an exit code. Wait handles are transient and never serialized.
Checkout and snapshot restore cancel handles owned by the restored instance before
replacing its state; subsequent completion cannot satisfy an old wait.
Generated parity excludes blocking waits; deterministic Fetch and real HTTP tests
cover their completion/cancellation behavior. The real Engine oracle separately
checks selected wait and termination outcomes; cancellation coverage is synthetic.

## Stop, signals and removal

`POST /containers/<id>/stop` records an accepted stop request without changing
`Running`. The HTTP request remains pending until the explicit completion control
finishes execution, then returns 204. Already-stopped containers return 304.
`signal` selects the requested signal (default Config.StopSignal or TERM); `t`
selects the timeout (default Config.StopTimeout or 10 seconds; negative means no
escalation timeout). The mock records these parameters for scenario inspection.
It does not schedule real timers or automatically declare exit when a timeout
expires: script graceful completion or forced completion, including the exit code,
through `/__admin/docker/containers/<id>/complete`. This permits controlled delayed
termination without fabricating an early Docker success response.

`POST /containers/<id>/kill` defaults to SIGKILL and keeps its 204 reply pending
until completion; explicit KILL/9 behaves identically. Other supported Linux
signal names/numbers acknowledge delivery with 204 while preserving execution
state. The fixture decides the subsequent process response. No host signal is
sent. Killing a stopped container returns 409. Invalid kill signals return 400;
pinned Engine stop signal errors and malformed `t` return 500. Timeouts outside
JavaScript's safe integer range return explicit mock-only 501.

`DELETE /containers/<id>` removes a stopped record and releases its name (204).
Running or paused records require `force=true`; otherwise removal returns 409.
Forced removal records intent and waits for explicit completion, then removes the
record and wakes both exit and removed waiters. A second removal while forced
removal is pending returns 409. Seed status `removing` to model an existing removal
conflict. Missing records return 404. `v` is accepted but no host volumes exist;
`link=true` is outside this subset and returns mock-only 501.

`GET /__admin/docker/containers/<id>/termination` returns the last accepted request
(operation, numeric signal, optional timeout and request time), `removalPending`,
and `simulated: true`. These diagnostic fields are not Docker wire fields.
Canceling a stop/kill/removal reply releases only the reply handle. Accepted intent
and running state survive socket loss; explicit completion still applies, including
pending forced removal. Reset clears the namespace and cancels its pending replies.
Closing a runtime/server cancels replies without claiming exit. Accepted-mutation
history survives response loss through shared Timeline checkpoints, as described
under failure scenarios below.

## Controls

- `GET /health` reports readiness and service identity.
- Select independent state with `x-mockingbird-namespace` or `/ns/<name>/…`.
- `POST /__admin/reset` resets the selected namespace's records and Timeline;
  `?all=1` resets all namespaces. It preserves clock, fault configuration and journal.
- `POST /__admin/clock` accepts shared `set`, `advance`, and `freeze` controls.
- `POST /__admin/faults` configures faults by operation, path, or method.
  `DELETE /__admin/faults` clears them. Docker fault presets are described below.
- `GET /__admin/requests` exposes metadata, never request bodies or query values;
  `DELETE /__admin/requests` clears the selected journal.
- `POST /__admin/checkpoints`, `POST /__admin/branches/<name>`, and
  `POST /__admin/branches/<name>/checkout` use the shared Timeline coordinator.
  There is no Docker-local history manager. Pass `{ "checkpoint": "cp_…" }` to checkout.

The shared `adminKey` option gates admin routes. Docker credential-based namespace
selection, webhooks and provider credentials are not configured.

## API

The portable `@crvouga/mockingbird-service-docker` entry exports:

- `DockerAPI`: provider Fetch handler with `fetch`, `reset`, and `close`.
- `DOCKER_NAMESPACE`: default storage namespace (`docker`).
- `createRuntime`: provider plus standard Mockingbird controls and Timeline.
- `document`: annotated OpenAPI contract.
- `operationIds`: all inventoried operation IDs, including unsupported routes.
- `supportedOperationIds`: currently implemented operation IDs.

The Node-only `@crvouga/mockingbird-service-docker/server` entry exports:

- `createServer`: HTTP server with `runtime`, `url`, `port`, `host`, `server`,
  `close`, `attachments()`, and optional Unix `socketPath`.
- `DEFAULT_PORT`: CLI default port, 8826 (programmatic default is ephemeral).
- `serveTarget`: shared CLI server configuration.

Type exports include `DockerAPIOptions`, `DockerRuntime`, `DockerRuntimeOptions`,
`OperationId`, `SupportedOperationId`, and the Node entry's `DockerServer` and
`DockerServerOptions`, `AttachStreamOptions`, and `DockerAttachment`. The executable `mockingbird-docker` provides `serve`.

## Deliberately not modelled

Fetch attach and unsupported options return Mockingbird-specific 501 JSON errors;
unknown routes return 404. The mock never starts real containers or executes
commands. The Node server supports the documented non-TTY attach handshake and
scripted duplex streams; a Fetch response cannot represent that upgrade.

Image builds/pulls, registry access, exec, TTY streams, log replay, real networks,
mounts, volumes, resource enforcement, peer credentials and host isolation are
outside this package. Reported rootless/security settings and HostConfig fields
are synthetic metadata. Logical restart controls do not reproduce real daemon
restart or live-restore. No Initiative orchestration or recovery policy is verified.

## Failure scenarios and logical restart

For each operation `create`, `start`, `stop`, `kill`, and `remove`, install a
one-use preset through `POST /__admin/faults` with
`{"preset":"docker_<operation>_pre_failure"}` or
`{"preset":"docker_<operation>_accepted_drop"}`. The first returns 503 before
mutation. The second lets validation and mutation run, captures the accepted
state in shared Timeline, then drops the reply. Failed validation and unchanged
operations do not become accepted mutations. Inspect state after a lost reply;
acceptance alone does not establish container exit or removal.

The shared journal records lost replies with status 0, `accepted: true`, the
acceptance `checkpoint`, container ID, and fault ID. Ordinary rejected operations
do not gain an acceptance checkpoint. Pending termination intent is checkpointed
before waiting for completion, including when the caller later disconnects.

`POST /__admin/docker/restart` requires an explicit `containers` choice:
`"preserve"` retains execution state and accepted intent; `"terminate"` completes
running containers with `exitCode` (default 137), applying pending removal and
AutoRemove. Both cancel existing wait/reply handles, set daemon availability to
true, and checkpoint the selected namespace's main branch. Invalid input changes
nothing. Daemon availability changes also checkpoint independently of execution.
These are synthetic scenario controls, not claims about a real daemon's restart
policy or live-restore configuration. No daemon or host process is restarted.

## Node Unix-socket transport

The programmatic Node entry supports `createServer({ socketPath })` on Unix.
Supply an absolute, absent path (at most 103 UTF-8 bytes) in a test-owned directory.
It refuses existing files, symlinks and sockets, including stale sockets; it never
unlinks them to make room. Do not use a host Engine path. The operating system and
Node remove the bound socket when `await server.close()` completes. Close also
cancels runtime waits and destroys owned connections; repeated close calls share
one shutdown operation. Tests must close their server in a finally block.

Use Node HTTP `request({ socketPath, path: "/_ping" })` for Unix requests. The
returned `socketPath` identifies the endpoint; `url` is the synthetic HTTP origin
`http://docker.mock` and `port` is 0. For TCP, omit `socketPath` and use `host`/`port`
as before. Combining Unix and TCP options rejects. Retained sequential HTTP/1.1
requests work on both transports. Each connection permits one active request;
pipelining another request before its response finishes closes that connection
before dispatching the extra request. A deliberate drop closes the connection; the
transport does not reconnect clients.

`createServer` bounds bodies to `maxBodyBytes` (default 1 MiB, including chunked
input), with a `bodyTimeoutMs` receive deadline (default 30 seconds). Rejections
return transport-specific 413 or 408 and close the connection without invoking a
provider operation. Response waits have no artificial execution deadline. Header
size is limited to 16 KiB, header/request receive time to 30 seconds, idle
keep-alive to 5 seconds, and simultaneous connections to `maxConnections` (default
128). These limits are Mockingbird controls, not Docker Engine parity claims.
The existing CLI/shared fleet target still uses the shared TCP adapter; Unix
sockets and these Docker transport limits currently require `createServer`.
No peer credentials, procfs provenance, host isolation or real Engine access is
claimed. Attach framing and lifetime controls are described below.

## Node attach handshake

Send POST `/v1.52/containers/<id>/attach?stream=1&stdout=1&stderr=1` with
`Connection: Upgrade` and `Upgrade: tcp` to `createServer`. Unversioned attach
uses the same pinned contract. The response is `101 UPGRADED` with
`Content-Type: application/vnd.docker.multiplexed-stream`, `Connection: Upgrade`,
and `Upgrade: tcp`. Read through the first CRLFCRLF and retain all following
bytes. This duplex upgrade cannot be represented by a Fetch Response; ordinary
Fetch and non-upgrade requests continue to return an explicit 501.

`stream=true`, `logs=false`, and stdin/stdout/stderr selections are accepted for
handshake negotiation. TTY, replay, detachKeys, unknown query modes and non-TCP
upgrades are unsupported. Missing containers and paused/restarting conflicts use
the pinned pre-upgrade plain-text error envelope with raw-stream content type.
Shared namespaces, branches, faults, daemon availability and request logging apply.
Attach admission is journaled as 101 and does not itself checkpoint a mutation.

For protocol fixtures, `attachHandshake: { chunkBytes, initialStreamBytes }`
splits header writes into 1–4096-byte chunks and appends at most 1 MiB of synthetic
already-framed bytes to the last fragment. This does not promise OS packet
boundaries. The bytes are caller-owned wire fixtures, not generated container
output. Use the live attachment controls below for framing, channel routing and scripted
stdin. No command interprets the input, and payload bytes never enter the journal. Connection loss does not stop the container.
Owned sockets close on server shutdown. The mock never connects to a real Engine;
the separately invoked oracle performs the authorized provider comparison.

## Scripted attach streams

`server.attachments()` returns current Node-owned handles. Each exposes an `id`,
`containerId`, public `namespace` and `branch`, plus `closed`, `stdinClosed` and
`queuedBytes`. Retain a handle only for that attachment; it cannot address a
restored container or a new execution after its lifetime ends.

```ts
import type { DockerServer } from "@crvouga/mockingbird-service-docker/server"

// Call after a client attaches to a running container on this server.
export async function writeAttachedOutput(server: DockerServer) {
  const [attachment] = server.attachments()
  if (attachment) {
    await attachment.write("stdout", new TextEncoder().encode("synthetic output"))
    const rawInput = attachment.takeStdin()
    await attachment.end()
    return rawInput
  }
}
```

`write("stdout" | "stderr", bytes)` emits the selected channel as an eight-byte
Docker header (channel 1/2, three reserved zero bytes, uint32 big-endian length)
followed by the exact payload. Empty frames work; concurrent writes are serialized
without frame interleaving. Unselected output is ignored. Await each write for
backpressure. `attachStreams.frameChunkBytes` splits frames for protocol tests
(default 64 KiB); OS packet boundaries remain uncontrolled.

Incoming stdin is raw, including bytes read ahead with the HTTP upgrade. Input
requires `stdin=1` and container `OpenStdin=true`; otherwise it is ignored.
`takeStdin()` drains the bounded synthetic input buffer. No program is executed.
With `StdinOnce=true`, input EOF closes modeled container stdin and checkpoints
that state without declaring exit; output may continue until explicit completion.
Without StdinOnce, effective stdin EOF ends that attachment and leaves container
input reusable. Starting a new execution reopens modeled input. Transport loss
alone never invokes container completion.

`end()` scripts output EOF after queued frames. For non-TTY StdinOnce containers,
it retains the connection until explicit process completion, matching the pinned
handler's wait. `cancel()` immediately disconnects just this attachment. Process
completion ends its attachments after queued output. Reset, snapshot restore,
checkout, synthetic restart and shutdown immediately invalidate the affected
physical instance's handles; other namespaces/branches remain isolated. Queued
stale writes reject. Socket handles and buffered payloads are never snapshotted.

`attachStreams.maxQueuedBytes` and `maxStdinBytes` default to 1 MiB. Queued output
includes frame headers; exceeding the output limit rejects the write. Exceeding
unread stdin capacity cancels that attachment. Stream limits must be positive
integers no greater than 16 MiB. These bounds are mock resource controls.

## Verification boundaries

`bun run build && bun test` exercises the modeled contract without an Engine or
credentials. Generated OpenAPI self-parity asserts that all eight eligible
operations are planned and exercised: list, create, inspect, start, info, version,
GET ping and HEAD ping. Generated walks include error paths; an exercised count
alone does not establish successful creation or state transitions. A seeded
nonempty-list comparison additionally rejects a deliberately wrong, schema-valid
execution state. The independent wire scenarios cover successful mutations.

`test/node-consumer.mjs` runs under native Node against the built server entry,
once over loopback TCP and once over a test-owned Unix socket. It uses Node HTTP
requests on a retained connection and raw attach bytes. It verifies lost create
and start responses, lookup by name, duplicate-name conflict, framed binary
stdout/stderr, raw stdin, continued execution after attachment loss, and lost
stop/kill/remove responses followed by completion and re-inspection. Setup and
completion use public mock admin controls; attachment handles only script output
and observe synthetic stdin. Public request metadata confirms each dropped mutation
was accepted and checkpointed. No client assertion imports provider handlers or
internal state. The fixture never automatically retries a mutation.

Wait/stop/kill/remove have deterministic lifecycle and wire tests rather than
unbounded generated walks. Attach uses dedicated raw-wire tests because Fetch
cannot represent duplex HTTP upgrade. The declared Docker consumer is raw-socket,
so no SDK compatibility is claimed or substituted for wire coverage. Self-parity
and synthetic consumer tests are separate from real Engine differential evidence
recorded by the oracle, and do not verify Initiative recovery policies or host enforcement.

The opt-in [real Engine oracle](ORACLE.md) requires an explicitly authorized
current Engine endpoint and immutable image. The recorded Engine 29.8.0 run
passed 29 selected API 1.52 comparisons; see the evidence record for scope and
limitations. Engine identity fields and full API 1.56 compatibility are not claimed.
