# Latency and timeouts

Make responses slow, or make them never arrive. Latency is how long every request takes; a timeout holds a request and then drops it. With virtual time, the waits are spent on the mock clock and cost no test time.

<!-- search: latency delay slow duration timeout hang jitter virtual time sleep wait response time throttle -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `GET /__admin/latency` · `PUT /__admin/latency` · `DELETE /__admin/latency` · `PUT /__admin/controls {"virtualTime": …}` |
| Request header | `x-mockingbird-delay: <duration>` · `x-mockingbird-timeout: <duration>` · `x-mockingbird-virtual-time: true \| false` |
| Fault rule | `delay` · `jitter` · `timeout` on a [fault](FAULTS.md) |
| At boot | `adminControls.latency` · `adminControls.virtualTime` · `--latency <duration>` · `--jitter <duration>` · `--virtual-time` |
| In process | `runtime.latency` · `runtime.configure({ virtualTime })` |
| Admin page | **Latency** at `/__admin/ui#latency`. Virtual time is on **Clock** |

A duration is milliseconds or a string: `"250ms"`, `"2s"`, `"15m"`, `"1h"`, `"3d"`.

## Admin page

Open `http://localhost:8787/__admin/ui#latency`.

| Control | Does |
| --- | --- |
| Baseline Delay and Jitter, then Set baseline | `PUT /__admin/latency` for every vendor request in this namespace |
| operationId, Delay and Jitter, then Set override | The same call, with `operations` replacing the baseline for one operation |
| Remove on an override | The same call, without that operation |
| Clear latency | `DELETE /__admin/latency`. Removes the baseline and every override |

A timeout is not on this screen. Send `x-mockingbird-timeout` on the request, or set `timeout` on a [fault](FAULTS.md). Virtual time is the switch on [Clock](CLOCK.md#admin-page).

## Three ways to wait

| To slow | Use |
| --- | --- |
| Every request in a namespace | Latency: `PUT /__admin/latency` |
| The requests a rule matches | A fault with `delay` or `timeout`: `POST /__admin/faults` |
| One request | `x-mockingbird-delay` or `x-mockingbird-timeout` on that request |

They add up: a request waits its latency, then its header's delay, then the delay of each fault rule that fires.

## Admin API

### `PUT /__admin/latency`

Set the namespace's baseline response time.

| Body field | Type | Meaning |
| --- | --- | --- |
| `delay` | duration | How long every vendor request takes before anything else |
| `jitter` | duration | Add a seeded `0`–`jitter` milliseconds |
| `operations` | object | Per-operation overrides, keyed by operationId. Each is a duration, or `{delay, jitter}`, and replaces the baseline for that operation |

```bash
curl -X PUT localhost:8787/__admin/latency \
  -d '{"delay": "40ms", "jitter": "10ms", "operations": {"CreateCharge": {"delay": "250ms"}}}'
```

```json
{
  "delayMs": 40,
  "jitterMs": 10,
  "operations": { "CreateCharge": { "delayMs": 250, "jitterMs": 0 } }
}
```

### `GET /__admin/latency`

The same body.

```bash
curl localhost:8787/__admin/latency
```

### `DELETE /__admin/latency`

Remove it.

```bash
curl -X DELETE localhost:8787/__admin/latency
```

```json
{ "delayMs": 0, "jitterMs": 0, "operations": {} }
```

## Timeouts

A timeout never answers: it holds the request for a duration, then drops the connection. An in-process `fetch` rejects with a `TypeError`; a served emulator destroys the socket.

```bash
# The next CreateCharge hangs for 30 seconds and then dies.
curl -X POST localhost:8787/__admin/faults -d '{"operationId": "CreateCharge", "timeout": "30s", "count": 1}'
```

```bash
# This request only.
curl -X POST localhost:8787/v1/charges -H 'x-mockingbird-timeout: 30s' \
  -H 'authorization: Bearer sk_test_mockingbird'
```

The `timeout` [preset](FAULTS.md#presets) is the same thing by name. A held request ends as soon as the caller gives up.

## Virtual time

By default a wait is real: the emulator holds the response for that long on the wall clock, which is what trips a client's own timeout.

With `virtualTime`, a wait is spent on the mock [clock](CLOCK.md) instead. The request returns at once, the clock has moved forward by the wait, and the journal records it exactly.

| | Real (default) | Virtual |
| --- | --- | --- |
| A `2s` delay | The response arrives two seconds later | The response arrives now; the clock is two seconds later |
| A `30s` timeout | The connection drops after thirty seconds | The connection drops now; the clock is thirty seconds later |
| Journal `durationMs` | Measured | Exactly the injected wait |

```bash
curl -X PUT localhost:8787/__admin/controls -d '{"virtualTime": true}'
```

Turn it off with `{"virtualTime": false}`, or per namespace with the `x-mockingbird-virtual-time` header.

## Request headers

| Header | Scope | Does |
| --- | --- | --- |
| `x-mockingbird-delay: <duration>` | This request | Hold the response back, on top of the namespace's latency |
| `x-mockingbird-timeout: <duration>` | This request | Never answer: hold this long, then drop the connection |
| `x-mockingbird-virtual-time: true \| false` | The namespace, from now on | Turn virtual time on or off |

## At boot

```json
{
  "latency": { "delay": "40ms", "jitter": "10ms", "operations": { "CreateCharge": "250ms" } },
  "virtualTime": true
}
```

```bash
npx mockingbird-stripe serve --latency 40ms --jitter 10ms --virtual-time
```

`"latency": "40ms"` is short for `{"delay": "40ms"}`.

## In process

```ts
runtime.latency.set("default", { delayMs: 40, jitterMs: 10, operations: {} })
runtime.latency.get("default")   // { delayMs, jitterMs, operations }
runtime.latency.clear("default")
runtime.configure({ virtualTime: true, latency: "40ms" })
runtime.headers({ delay: "250ms", timeout: "30s" })
```

## Rules

- **Jitter is seeded**, from a stream of its own per namespace. The same [seed](SEED_AND_DETERMINISM.md) gives the same waits, and adding latency never shifts which requests a `rate` fault hits.
- **Latency applies to vendor requests**, not to `/__admin`.
- **The journal records the wait** as `delayMs` on each entry.
- The Node server and the CLI destroy the socket for a timeout. `Bun.serve` cannot close a connection from a handler, so the Bun adapter answers `500`.

## Errors

| Status | When |
| --- | --- |
| `400` | A duration cannot be read or is negative, or the body has an unknown field |
| `401` | The emulator has an admin key and the request did not carry it |

## Related

- [Faults](FAULTS.md) for `delay`, `jitter` and `timeout` on the requests a rule matches.
- [Clock](CLOCK.md), which virtual time moves.
