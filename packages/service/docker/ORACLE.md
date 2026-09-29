# Docker differential oracle

This opt-in harness is incomplete evidence until it has run against an explicitly
authorized Linux Docker Engine supporting the comparison API 1.52. Ordinary tests verify the
harness against local fixtures; recorded live results are separate evidence.

## Preconditions and scope

Supply an explicit Unix socket or loopback HTTP endpoint for a disposable Engine.
The harness never reads Docker contexts, `DOCKER_HOST`, or a default socket. It
requires the exact Engine version, an existing immutable Linux image ID, a unique
run ID, and the `--allow-lifecycle` acknowledgment. The flag records the caller's
intent; it does not grant agent permission. Obtain operational approval first.

The image must contain `/bin/sh`, `read`, `printf`, and `sleep`. Images declaring volumes or active healthchecks are rejected before creation.
Only modeled image defaults are seeded; omitted metadata fields are recorded.
No image is pulled,
built, tagged, or deleted. No volumes, host mounts or published ports are used;
created containers use `NetworkMode: none`. The harness creates at most three
containers named `<run-id>-attach`, `<run-id>-stop`, and `<run-id>-kill`, with the
`mockingbird.oracle=<run-id>` label. The run ID must be `mb-oracle-` followed by
32 lowercase hexadecimal characters; generate a fresh one for each run.

Before creating anything, the harness checks the actual Engine version/OS, image
identity and absence of all three names. It refuses any collision. Each created
container is started, inspected and removed. Attach executes a shell that echoes
one input line, writes a stderr marker and exits 7. Stop and kill use a sleeping
shell loop; stop uses timeout zero and kill uses SIGKILL. Those scenarios expect
exit 137. These operations affect only these three containers, not the daemon.

Cleanup re-inspects each known create intent and requires matching name, image,
label and (when returned) immutable container ID before force-removing it. It
never adopts a definitively rejected create. Unknown ownership fails cleanup
without deleting the object. Cleanup failures make the run fail and identify the
run-owned name needing investigation. Abrupt process/host termination can prevent
cleanup; preserve the run ID and inspect ownership before any manual cleanup.

## Invocation

Build the package, then run from its directory after obtaining approval:

```sh
node scripts/docker-oracle.mjs \
  --endpoint unix:///absolute/path/to/approved-engine.sock \
  --engine-version 29.8.0 \
  --image sha256:<64-lowercase-hex-image-id> \
  --run-id mb-oracle-<32-lowercase-hex-run-id> \
  --allow-lifecycle
```

A loopback endpoint such as `http://127.0.0.1:23750` is also supported. Placeholders
are rejected. Authenticated/TLS endpoints are outside this harness; use an
explicitly authorized local endpoint or tunnel. The numeric Engine version must match the endpoint exactly. The selected API
must be within its advertised minimum/maximum range. Record each new tested
Engine version; do not require downgrading the user's host.

## Comparison and evidence

The JSON report records actual Engine/API/platform information, immutable image,
normalized comparisons, cleanup results and gaps. Exit status is nonzero on a
comparison, setup or cleanup failure. Preserve that report under the project's
ignored `.mockingbird/` directory, then summarize verified evidence in
`API_EVIDENCE.md`; do not turn absent execution into a passing result.

Comparisons cover create/start/remove HTTP statuses, inspect execution state,
wait exit code, attach upgrade headers and stdout/stderr bytes. Multiplexed output
is decoded independently and concatenated by channel, removing arbitrary frame
and packet boundaries. Output bytes are recorded as base64. Container IDs,
timestamps, daemon-specific metadata and cross-channel interleaving are not
compared. The mock's completion control scripts the known exit behavior; it does
not execute the image. Tests of image execution or host isolation are not implied.

The harness performs no daemon restart or live-restore operation. Existing
synthetic transport response-loss tests are separate evidence and do not establish
real restart/live-restore behavior. This harness does not verify an SDK or
Initiative's recovery policies.

## Recorded run

On 2026-09-27, Desktop 4.92.0 / Engine 29.8.0 (Linux/arm64, API range
1.40–1.56) passed all 29 comparisons at API 1.52. All three containers were
confirmed absent afterward. See [the captured report](evidence/engine-29.8.0-api-1.52.json)
and [source reconciliation](API_EVIDENCE.md#us-013--current-engine-oracle).
This does not claim testing of standalone Engine 29.8.1, all API 1.56 features,
or matching daemon identity fields from `/version` and `/info`.
