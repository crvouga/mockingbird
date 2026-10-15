# Single-container fleet reference

Build from a pinned checkout at the repository root:

```sh
docker build --platform linux/arm64 -f packages/examples/fleet-reference/Dockerfile -t mockingbird-fleet:local .
# Use linux/amd64 on x64 hosts. No Docker socket is mounted in the container.
docker run --rm --name synthetic-fleet --stop-timeout 35 \
  --env MOCKINGBIRD_ADMIN_KEY \
  --mount type=volume,source=synthetic-fleet-state,target=/state \
  -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 \
  -p 127.0.0.1:5432:5432 -p 127.0.0.1:6379:6379 mockingbird-fleet:local
```

Set `MOCKINGBIRD_ADMIN_KEY` in the caller's environment before running; it is required and never
included in the build context. This is a reproducible reference Dockerfile, not a published fleet
image. Both build/runtime stages pin Bun 1.4.2 by a multi-platform digest. `bun.lock` pins the
checkout's package inventory. `/app/inventory.json` records the Bun version, lock hash and three
service versions; development checkouts retain their truthful development version. Pin the source
revision along with the Dockerfile digest when distributing a downstream image.

The runtime runs as `bun` (UID 1000), with HTTP Stripe on 9001, PostgreSQL on 5432, Redis on 6379,
and aggregate controls on 9000. The named volume inherits writable ownership from `/state` in the
image; a bind mount must be writable by UID 1000. Discovery is `/state/ready.json`, published only
after initialization, and the privileged `/state/connections.json` is mode 0600. Manifest addresses
are inside-container addresses; map them explicitly to published host ports. Dynamic protocol
namespace ports require co-container clients or explicit downstream networking; they are not
implicitly exposed by these four port mappings.

`FLEET_CONFIG` optionally names a mounted fleet JSON file. Only `stripe`, `postgres` and `redis`
are in the reference inventory; an unavailable target fails with its name before readiness.
The image supports Linux amd64/arm64. The source entrypoint also permits macOS for the host smoke;
other OS/CPU combinations fail explicitly. Downstream images can copy application processes and
provide a supervisor, while preserving the signal and readiness contract.

At boot, the latest verified repository archive in `/state/backups` is restored before readiness.
On SIGTERM/SIGINT, the pre-shutdown gate captures every namespace, writes and verifies an immutable
archive, and publishes latest before closing listeners. Logs emit `shutdown-backup` with
`status:"verified"`, then `stopped`. Failure logs `status:"failed"` and retains the fleet so storage
or active clients can be addressed before another signal. Close application DB/Redis clients
before stopping: a non-quiescent workload can correctly fail the gate. Docker's timeout may still
force SIGKILL; SIGKILL, power loss and exhausted stop grace cannot guarantee a final backup.
Persist the volume and use scheduled backups for those cases.

CI builds and runs the image natively on Linux amd64 and arm64. The smoke checks non-root execution,
all three real protocols, readiness, a controlled stop, a fresh container with the same volume,
and restored HTTP/SQL/Redis state:

```sh
bun run --cwd packages/examples/fleet-reference smoke --image=mockingbird-fleet:local
# Contributor check without Docker, after building the workspace:
bun run --cwd packages/examples/fleet-reference smoke --host
```

The image has no Docker socket, credentials file, automatic deployment or hosting-account setup.
See [Fleets](../../../docs/FLEETS.md) for control authentication, archives and protected repositories.
