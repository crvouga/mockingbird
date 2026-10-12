# Admin controls

Every Mockingbird HTTP emulator answers the same controls: isolate state by key, reset it, snapshot and restore it, move the clock, inject faults, latency and timeouts, and replay all of it from a seed. They are the same on every emulator, and the same whether you set them at boot, call the admin API, or send a request header.

<!-- search: admin controls control plane __admin snapshot restore reset clock time travel faults latency timeout namespace isolation seed deterministic headers -->

## Find a control

Each control has its own page. That page is the interface: every route, body field, header, boot option, in-process method, admin screen and error.

**Save state and put it back:** [Snapshot and restore](admin-controls/SNAPSHOT_AND_RESTORE.md). Take one with `POST /__admin/snapshots`. Restore it with `POST /__admin/snapshots/<id>/restore`. On the admin page the sidebar item is **Snapshot & restore** (`/__admin/ui#snapshots`) and **Restore** is the button on a saved snapshot. The **Restore** button on **Checkpoints** checks out a checkpoint. That is [a different control](admin-controls/CHECKPOINTS_AND_BRANCHES.md).

### State

| I want to | Page | Interface |
| --- | --- | --- |
| Give each test or worker its own state | [Namespaces](admin-controls/NAMESPACES.md) | `x-mockingbird-namespace: <key>` |
| Wipe state between tests | [Reset](admin-controls/RESET.md) | `POST /__admin/reset` |
| Save state and put it back | [Snapshot and restore](admin-controls/SNAPSHOT_AND_RESTORE.md) | `POST /__admin/snapshots` · `POST /__admin/snapshots/<id>/restore` |

### Time

| I want to | Page | Interface |
| --- | --- | --- |
| Set, freeze or advance time | [Clock](admin-controls/CLOCK.md) | `POST /__admin/clock` |
| Read old state, or try a different path from it | [Checkpoints and branches](admin-controls/CHECKPOINTS_AND_BRANCHES.md) | `x-mockingbird-at: <checkpoint>` |

### Failure

| I want to | Page | Interface |
| --- | --- | --- |
| Make requests fail | [Faults](admin-controls/FAULTS.md) | `POST /__admin/faults` |
| Make requests slow, or hang | [Latency and timeouts](admin-controls/LATENCY_AND_TIMEOUTS.md) | `PUT /__admin/latency` · `x-mockingbird-timeout: 30s` |

### Set them

| I want to | Page | Interface |
| --- | --- | --- |
| Get the same ids and outcomes every run | [Seed and determinism](admin-controls/SEED_AND_DETERMINISM.md) | `--seed 7` |
| Set several controls in one call | [Control document](admin-controls/CONTROL_DOCUMENT.md) | `PUT /__admin/controls` |
| Start an emulator already configured | [Boot](admin-controls/BOOT.md) | `adminControls` · `serve --clock … --fault …` |
| Control one request without any setup | [Request headers](admin-controls/REQUEST_HEADERS.md) | `x-mockingbird-fault: 503` |

### Inspect

| I want to | Page | Interface |
| --- | --- | --- |
| See what the emulator received and holds | [Journal, metrics and state](admin-controls/JOURNAL_AND_STATE.md) | `GET /__admin/requests` · `GET /__admin/state` |
| Look up a route, a header, an error or an admin screen | [Reference](admin-controls/REFERENCE.md) | `GET /__admin` |

## One document, three carriers

A control is described once, as JSON:

```json
{
  "seed": 7,
  "clock": { "now": "2030-01-01T00:00:00Z", "frozen": true, "autoAdvance": "1s" },
  "virtualTime": true,
  "latency": { "delay": "40ms", "jitter": "10ms" },
  "faults": [{ "preset": "rate_limited", "count": 1 }]
}
```

The same document applies in three places. [Control document](admin-controls/CONTROL_DOCUMENT.md) is its schema.

**At boot.** Pass it as `adminControls`, or as flags. See [Boot](admin-controls/BOOT.md).

```ts
import { createRuntime } from "@crvouga/mockingbird-service-stripe"

const stripe = createRuntime({
  seed: 7,
  adminControls: {
    clock: { now: "2030-01-01T00:00:00Z", frozen: true },
    latency: "40ms",
    faults: [{ preset: "rate_limited", count: 1 }],
  },
})
```

```bash
npx mockingbird-stripe serve --seed 7 --clock 2030-01-01T00:00:00Z --freeze \
  --latency 40ms --fault rate_limited
```

**Over the admin API.** Every control has routes under `/__admin`. See [Reference](admin-controls/REFERENCE.md) for all of them.

```bash
curl -X POST localhost:8787/__admin/snapshots -d '{"name": "baseline"}'
curl -X POST localhost:8787/__admin/clock -d '{"advance": "15m"}'
curl -X POST localhost:8787/__admin/faults -d '{"preset": "rate_limited", "count": 1}'
curl -X POST localhost:8787/__admin/snapshots/baseline/restore
```

**In a request header.** A request carries its own controls. See [Request headers](admin-controls/REQUEST_HEADERS.md).

```bash
curl -X POST localhost:8787/v1/charges \
  -H 'authorization: Bearer sk_test_mockingbird' \
  -H 'x-mockingbird-namespace: worker-3' \
  -H 'x-mockingbird-time: 2030-01-01T00:00:00Z' \
  -H 'x-mockingbird-fault: status=503; delay=2s'
```

In process, the runtime every emulator returns has the same controls as methods:

| Method | Control |
| --- | --- |
| `runtime.reset(key?)` | [Reset](admin-controls/RESET.md) |
| `runtime.snapshots` | [Snapshot and restore](admin-controls/SNAPSHOT_AND_RESTORE.md) |
| `runtime.namespaceClock(key?)` · `runtime.clock` | [Clock](admin-controls/CLOCK.md) |
| `runtime.checkpoint()` · `runtime.branch()` · `runtime.checkout()` · `runtime.timeline()` | [Checkpoints and branches](admin-controls/CHECKPOINTS_AND_BRANCHES.md) |
| `runtime.faults` · `runtime.applyPreset()` | [Faults](admin-controls/FAULTS.md) |
| `runtime.latency` | [Latency and timeouts](admin-controls/LATENCY_AND_TIMEOUTS.md) |
| `runtime.controls(key?)` · `runtime.configure(document, key?)` | [Control document](admin-controls/CONTROL_DOCUMENT.md) |
| `runtime.headers(input)` | [Request headers](admin-controls/REQUEST_HEADERS.md) |
| `runtime.journal` · `runtime.metrics` · `runtime.state(key?)` | [Journal, metrics and state](admin-controls/JOURNAL_AND_STATE.md) |
| `runtime.namespaces()` · `runtime.dropNamespace(key)` | [Namespaces](admin-controls/NAMESPACES.md) |

## What holds everywhere

- **Every control belongs to a namespace.** A request that names none uses `default`. One namespace's records, clock, faults, latency, journal and snapshots are invisible to every other.
- **Refused means unchanged.** A document, body or header that cannot be read answers `400` and changes nothing. Unknown keys are errors, never ignored.
- **Durations** are milliseconds or a string: `"250ms"`, `"2s"`, `"15m"`, `"1h"`, `"3d"`. **Instants** are epoch milliseconds or ISO-8601.
- **Errors** are always `{"error": {"type": "mockingbird_admin", "message": "…"}}`, never a vendor's error shape.
- **Same seed, same requests, same bytes.** See [Seed and determinism](admin-controls/SEED_AND_DETERMINISM.md).
- **A running emulator describes itself.** `GET /__admin` lists every route and header with a summary and a link to its page, so a script or an agent can discover the controls without these docs.

The examples in this guide assume an emulator on `localhost:8787` (`npx mockingbird-stripe serve --port 8787`). Every `curl` to `/__admin` and every JSON document shown is run by the test suite.
