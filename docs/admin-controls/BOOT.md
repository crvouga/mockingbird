# Boot

An emulator starts with whatever controls you give it. That starting point is also what a reset returns to.

<!-- search: boot startup start initial configuration cli flags environment variables env createRuntime createServer serve fleet mockingbird.json options -->

## Interface

| Carrier | How |
| --- | --- |
| In code | `createRuntime({ seed, adminControls })` · `createServer({ seed, adminControls })` |
| Command line | `serve --admin-controls <json\|file>` and one flag per control |
| Environment | `MOCKINGBIRD_ADMIN_CONTROLS` · `MOCKINGBIRD_SEED` · `MOCKINGBIRD_ADMIN_KEY` · `MOCKINGBIRD_ADMIN_PREFIX` |
| Fleet | `adminControls` in `mockingbird.json`, for every service or for one |
| Admin page | Not a screen. Reset returns to whatever boot set |

All of them take the same [control document](CONTROL_DOCUMENT.md).

## Admin page

Boot is how the process starts, so the admin page does not edit it. **Overview** → [Reset namespace](RESET.md#admin-page) returns the selected namespace to that starting point.

## In code

`adminControls` is an option of every emulator's `createRuntime` and `createServer`:

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

A document that cannot be read throws a `ControlError` before the emulator exists.

## Command line

```bash
npx mockingbird-stripe serve --seed 7 --clock 2030-01-01T00:00:00Z --freeze \
  --latency 40ms --fault rate_limited
npx mockingbird-stripe serve --admin-controls ./controls.json
npx mockingbird-stripe serve --admin-controls '{"latency": "40ms"}'
```

| Flag | Environment | Sets | Page |
| --- | --- | --- | --- |
| `--admin-controls <json\|file>` | `MOCKINGBIRD_ADMIN_CONTROLS` | The whole document, inline or from a file | [Control document](CONTROL_DOCUMENT.md) |
| `--seed <seed>` | `MOCKINGBIRD_SEED` | `seed` | [Seed and determinism](SEED_AND_DETERMINISM.md) |
| `--clock <instant>` | | `clock.now` | [Clock](CLOCK.md) |
| `--freeze` | | `clock.frozen` | [Clock](CLOCK.md) |
| `--auto-advance <duration>` | | `clock.autoAdvance` | [Clock](CLOCK.md) |
| `--latency <duration>` | | `latency.delay` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `--jitter <duration>` | | `latency.jitter` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `--virtual-time` | | `virtualTime` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#virtual-time) |
| `--fault <fault>` | | One more entry in `faults`, in [header syntax](FAULTS.md#request-header) | [Faults](FAULTS.md) |
| `--snapshot <file>` | | `snapshot` | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |
| `--admin-key <key>` | `MOCKINGBIRD_ADMIN_KEY` | Who may use the controls | [Reference](REFERENCE.md#access) |
| `--admin-prefix <path>` | `MOCKINGBIRD_ADMIN_PREFIX` | Where the controls live. Default `/__admin` | [Reference](REFERENCE.md#access) |

How they combine:

- `--admin-controls` is used instead of `MOCKINGBIRD_ADMIN_CONTROLS` when both are set.
- A control flag replaces the matching key of the document. `--fault` adds to the document's `faults` instead of replacing them.
- A value that cannot be read stops the command before anything listens, and names the flag or key.

## Per namespace, and by credential

At boot the document takes two keys it takes nowhere else:

```json
{
  "latency": "5ms",
  "credentials": { "sk_test_tenant_a": "tenant-a" },
  "namespaces": { "tenant-a": { "latency": "50ms", "faults": [{ "status": 429 }] } }
}
```

| Key | Meaning |
| --- | --- |
| `namespaces` | A control document per [namespace](NAMESPACES.md) key. Each applies on top of the shared controls: a key it names replaces the shared one for that namespace |
| `credentials` | Maps a vendor credential to a namespace, as `PUT /__admin/credentials` does |

Here every namespace has 5 ms of latency, except `tenant-a`, which has 50 ms and answers `429`; requests authenticated with `sk_test_tenant_a` land in `tenant-a`.

## Fleet

In a fleet's `mockingbird.json`, `adminControls` at the top level boots every HTTP service with it, and a service's own entry replaces the keys it names:

```jsonc
{
  "adminControls": { "clock": { "now": "2030-01-01T00:00:00Z", "frozen": true } },
  "services": {
    "stripe": { "port": 0, "seed": "fixture", "adminControls": { "latency": "40ms" } },
    "resend": { "port": 0 }
  }
}
```

Flags and `MOCKINGBIRD_ADMIN_CONTROLS` apply on top of the file. See [Fleets](../FLEETS.md).

## Rules

- **Every namespace boots the same way.** A namespace is created on its first request, from the boot controls: the shared ones, then its own entry in `namespaces`.
- **Boot is what [reset](RESET.md) returns to.** A reset namespace cannot be told apart from a freshly booted one.
- **A boot `snapshot` replaces the emulator's own seed data**, in every namespace.
- **The boot `clock` sets the base clock** that every namespace's clock follows. See [Clock](CLOCK.md#how-the-clocks-relate).
- **The `seed` option wins** over `adminControls.seed`.

## Related

- [Control document](CONTROL_DOCUMENT.md) for the schema.
- [Request headers](REQUEST_HEADERS.md) and the admin API change the same controls after boot.
