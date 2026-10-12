# The control document

Every control is described once, as JSON. The same document boots an emulator, is read and written over the admin API, and is what the request headers stand for. This page is its schema.

<!-- search: control document config configuration schema json settings options adminControls all controls at once PUT controls -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `GET /__admin/controls` · `PUT /__admin/controls` · `DELETE /__admin/controls` |
| At boot | `adminControls` · `--admin-controls <json\|file>` · `MOCKINGBIRD_ADMIN_CONTROLS` |
| In process | `runtime.controls(key?)` · `runtime.configure(document, key?)` |
| Admin page | **Routes** can send `GET /controls`, `PUT /controls` and `DELETE /controls` |

## Admin page

There is no control-document screen. **Overview** shows the seed, clock, virtual time and latency from the document. **Routes** (`/__admin/ui#routes`) sends `GET /controls`, `PUT /controls` and `DELETE /controls`: choose the route, edit the JSON body, and press Send request.

## The document

```json
{
  "seed": 7,
  "clock": { "now": "2030-01-01T00:00:00Z", "frozen": true, "autoAdvance": "1s" },
  "virtualTime": true,
  "latency": { "delay": "40ms", "jitter": "10ms", "operations": { "CreateCharge": "250ms" } },
  "faults": [
    { "operationId": "CreateCharge", "status": 503, "count": 2 },
    { "preset": "rate_limited", "rate": 0.1 }
  ],
  "snapshot": { "format": "mockingbird.snapshot/v1", "records": [] }
}
```

Every key is optional.

| Key | Type | Meaning | Page |
| --- | --- | --- | --- |
| `seed` | number or string | Seeds every random choice. Default `0` | [Seed and determinism](SEED_AND_DETERMINISM.md) |
| `clock.now` | instant | Move the clock to this instant | [Clock](CLOCK.md) |
| `clock.frozen` | boolean | Stop time. A frozen clock moves only when told to | [Clock](CLOCK.md) |
| `clock.autoAdvance` | duration | Step the clock this much before every vendor request | [Clock](CLOCK.md) |
| `virtualTime` | boolean | Spend injected waits on the mock clock instead of the wall clock | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md#virtual-time) |
| `latency` | duration, or `{delay, jitter, operations}` | Baseline response time. A bare duration is its `delay` | [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) |
| `faults` | list of fault rules and presets | Replaces the namespace's rules | [Faults](FAULTS.md) |
| `snapshot` | snapshot document | Start from, or restore, this state | [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) |

At boot only, the document takes two more keys; see [Boot](BOOT.md):

| Key | Type | Meaning |
| --- | --- | --- |
| `namespaces` | object of documents, by key | Controls for one [namespace](NAMESPACES.md), on top of the shared ones |
| `credentials` | object of namespace keys, by credential | Vendor credential → namespace |

### Values

- **Duration**: milliseconds as a number, or a string: `"250ms"`, `"2s"`, `"15m"`, `"1h"`, `"3d"`.
- **Instant**: epoch milliseconds, or ISO-8601 (`"2030-01-01T00:00:00Z"`).
- **Unknown keys are errors.** A key the document does not have, or a value that cannot be read, is refused and never ignored.

## Admin API

A document read or written over the admin API belongs to one [namespace](NAMESPACES.md).

### `GET /__admin/controls`

The namespace's controls as they stand.

```bash
curl localhost:8787/__admin/controls
```

```json
{
  "namespace": "default",
  "seed": 0,
  "clock": {
    "now": 1893456000000,
    "iso": "2030-01-01T00:00:00.000Z",
    "frozen": true,
    "offsetMs": 0,
    "autoAdvanceMs": 0
  },
  "virtualTime": false,
  "latency": { "delayMs": 0, "jitterMs": 0, "operations": {} },
  "faults": [],
  "snapshots": []
}
```

| Response field | Meaning |
| --- | --- |
| `namespace` | The key these controls belong to |
| `seed` | The namespace's seed |
| `clock` | As `GET /__admin/clock` answers it |
| `virtualTime` | Whether waits are spent on the mock clock |
| `latency` | As `GET /__admin/latency` answers it |
| `faults` | The namespace's own rules, with `hits`, `seen` and `remaining` |
| `snapshots` | The namespace's snapshots, as `GET /__admin/snapshots` lists them |

### `PUT /__admin/controls`

Apply a document. Each key given replaces that control; a key left out is untouched. Answers the controls as they now stand.

```bash
curl -X PUT localhost:8787/__admin/controls \
  -d '{"virtualTime": true, "latency": "40ms", "faults": [{"preset": "rate_limited", "count": 1}]}'
```

```json
{
  "namespace": "default",
  "virtualTime": true,
  "latency": { "delayMs": 40, "jitterMs": 0, "operations": {} },
  "faults": [
    {
      "id": "rate_limited",
      "fromPreset": "rate_limited",
      "namespace": "default",
      "count": 1,
      "status": 429,
      "headers": { "retry-after": "1" },
      "remaining": 1,
      "hits": 0,
      "seen": 0
    }
  ]
}
```

- **All or nothing.** The whole document is checked first. One that is refused has changed nothing.
- **Round trip.** What `GET` returns is itself a document `PUT` accepts, in the same namespace or another. Applying it arms each fault rule afresh, with its counters at zero.
- **`snapshot` restores.** A `snapshot` key restores that document into the namespace; any control named beside it wins over the one the snapshot carries.
- **No rules for every namespace.** The document belongs to one namespace, so a fault with `"namespace": "*"` is refused. Add those with `POST /__admin/faults`.

### `DELETE /__admin/controls`

Put the namespace's controls back to boot: seed, clock, virtual time, latency and faults. Records, snapshots and the journal are untouched. Answers the controls as they now stand. To return records too, [reset](RESET.md).

```bash
curl -X DELETE localhost:8787/__admin/controls
```

## In process

```ts
runtime.controls()                                    // the "default" namespace's controls
runtime.controls("worker-3")
runtime.configure({ latency: "40ms", faults: [{ preset: "rate_limited" }] })
runtime.configure({ clock: { now: "2030-01-01T00:00:00Z", frozen: true } }, "worker-3")
```

`configure` throws a `ControlError` for a document it cannot read, and changes nothing.

## Errors

| Status | When |
| --- | --- |
| `400` | An unknown key, a value that cannot be read, a fault rule that is refused, a preset that does not exist, or a `snapshot` that is malformed or from another emulator |
| `401` | The emulator has an admin key and the request did not carry it |

The message names the key: `controls.latency.delay: expected milliseconds or a duration like "250ms" or "15m"`.

## Related

- [Boot](BOOT.md) for every way to hand this document to an emulator as it starts.
- [Request headers](REQUEST_HEADERS.md) for the same controls on one request.
