# Seed and determinism

Given the same boot controls and the same requests in the same order, an emulator answers the same bytes: ids, timestamps, which requests a fault hits, jitter, and the journal. The seed is what fixes every random choice.

<!-- search: seed deterministic determinism reproducible replay random rng flaky same ids stable repeatable -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `PUT /__admin/controls {"seed": …}` · `GET /__admin/controls` |
| Request header | `x-mockingbird-seed: <seed>` |
| At boot | `seed` · `adminControls.seed` · `--seed <seed>` · `MOCKINGBIRD_SEED` |
| In process | `runtime.configure({ seed })` · `runtime.controls().seed` |
| Admin page | **Overview** shows the seed. No screen edits it |

A seed is a number or a string. A string of digits is that number, so `--seed 7`, `{"seed": 7}` and `x-mockingbird-seed: 7` are the same seed. The default is `0`.

## Admin page

**Overview** shows the namespace's seed and does not edit it. Change it with `PUT /__admin/controls` and `{"seed": …}`, from [Routes](REFERENCE.md#admin-page) or the API. [Reset](RESET.md#admin-page) returns the seed to the value the process booted with.

## The recipe

Three controls make a run replay exactly:

```json
{ "seed": 7, "clock": { "now": "2030-01-01T00:00:00Z", "frozen": true, "autoAdvance": "1s" }, "virtualTime": true }
```

| Control | Fixes |
| --- | --- |
| `seed` | Every random choice: generated ids, `rate` faults, jitter, whatever the emulator invents |
| A frozen [clock](CLOCK.md) | Every timestamp. `autoAdvance` keeps them distinct |
| [`virtualTime`](LATENCY_AND_TIMEOUTS.md#virtual-time) | Takes the wall clock out of latency, delays, timeouts and the journal's `durationMs` |

```bash
npx mockingbird-stripe serve --seed 7 --clock 2030-01-01T00:00:00Z --freeze --auto-advance 1s --virtual-time
```

## Admin API

### `PUT /__admin/controls`

Reseed the namespace: its random streams restart from the new seed.

| Body field | Type | Meaning |
| --- | --- | --- |
| `seed` | number or string | The new seed |

```bash
curl -X PUT localhost:8787/__admin/controls -d '{"seed": 7}'
```

```json
{ "namespace": "default", "seed": 7 }
```

The response is the namespace's whole [control document](CONTROL_DOCUMENT.md); `seed` is the part shown.

### `GET /__admin/controls`

Read the seed back, with the rest of the namespace's controls.

```bash
curl localhost:8787/__admin/controls
```

## Request header

`x-mockingbird-seed: <seed>` restarts the namespace's random streams from this seed before the request is handled, and persists.

```bash
curl -X POST localhost:8787/v1/customers -H 'x-mockingbird-seed: 7' \
  -H 'authorization: Bearer sk_test_mockingbird' -d email=ada@example.com
```

## At boot

```ts
const stripe = createRuntime({ seed: 7 })
const same = createRuntime({ adminControls: { seed: 7 } })
```

```bash
npx mockingbird-stripe serve --seed 7
MOCKINGBIRD_SEED=7 npx mockingbird-stripe serve
```

The `seed` option wins over `adminControls.seed` when both are given.

## In process

```ts
runtime.configure({ seed: 7 })              // reseed "default"
runtime.configure({ seed: 7 }, "worker-3")
runtime.controls("worker-3").seed
runtime.headers({ seed: 7 })                // { "x-mockingbird-seed": "7" }
```

## What the seed covers

A namespace has three seeded streams, each independent of the others:

| Stream | Drives |
| --- | --- |
| The emulator's | Generated ids, tokens and anything else the emulator invents |
| Faults | Which requests a `rate` rule hits, and a rule's `jitter` |
| Latency | The namespace's latency `jitter` |

Because they are separate, adding latency never shifts which requests a fault hits, and adding a fault never changes a generated id.

- **Every namespace draws from the same seed**, and each has its own streams and counters, `default` included. A test gives the same result in `worker-1` as in `worker-7`, and one worker's requests never shift another's.
- **[Reset](RESET.md) rewinds the streams** to the boot seed. **[Restore](SNAPSHOT_AND_RESTORE.md)** puts them back where the snapshot left them. A test replays whether it runs first or last.

## Ids that outlive a boot

Id counters restart at 0 on every boot, so by default every boot issues the previous boot's ids, and `seed` does not change that. A consumer whose database outlives the emulator then meets unique-key collisions. The **id base** is a separate, boot-time choice that moves a boot onto its own run of ids:

| Carrier | How |
| --- | --- |
| In code | `createRuntime({ idBase: 7 })` · `runtime.setIdBase(7)` |
| Command line | `serve --id-base <n\|boot>` · `MOCKINGBIRD_ID_BASE` |
| Fleet | `idBase` at the top level of `mockingbird.json`, or on one service (which replaces the fleet's) |

```bash
npx mockingbird-twilio serve --id-base 7
npx mockingbird-twilio serve --id-base boot
```

- A base is a non-negative integer. The same base issues the same ids, a different base issues none of them, and the default `0` is today's ids, so nothing changes until you ask.
- `boot` takes the base from the wall clock when the emulator starts, so every boot gets a fresh run. That run is not reproducible; use a number when you need one.
- The base is a property of the boot, not of the state: [reset](RESET.md) and [restore](SNAPSHOT_AND_RESTORE.md) leave it as it was.
- A value that is not a non-negative integer or `boot` stops the command before anything listens.

## Outside the seed

- **Key material.** Signing keys, vault keys and encryption nonces come from the platform's random source by design. Pin them with the emulator's own fixture option (a `vaultKey`, a signing key).
- **Real waits.** Without `virtualTime`, `durationMs` is measured and a live clock reads the wall clock.
- **Overlapping requests.** Order decides which request draws first. Two requests in flight at once in one namespace, or in two namespaces of an emulator built on the shared provider core (Apple, AWS, Clerk, GitHub, Google, Linear, Microsoft, MongoDB Atlas, Okta, Resend, Slack, Twilio, Vercel), can swap the ids they mint. Send them one at a time when you assert on exact ids.

## Errors

| Status | When |
| --- | --- |
| `400` | The seed is not a number or a non-empty string |
| `401` | The emulator has an admin key and the request did not carry it |

## Related

- [Clock](CLOCK.md) and [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) for the other two parts of the recipe.
- [Namespaces](NAMESPACES.md) for running the same test in parallel workers.
