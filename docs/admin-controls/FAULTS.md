# Faults

A fault makes the emulator fail on purpose: answer `503`, drop the connection, cut a response off mid-body, or hold it back. It is how a test reaches a vendor's failure modes without the vendor.

<!-- search: fault injection error failure chaos 500 503 429 rate limit drop connection reset retry outage flaky preset truncate network error -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `POST /__admin/faults` · `GET /__admin/faults` · `PUT /__admin/faults` · `DELETE /__admin/faults` · `GET /__admin/faults/<id>` · `DELETE /__admin/faults/<id>` · `GET /__admin/faults/presets` · `POST /__admin/faults/presets/<name>` |
| Request header | `x-mockingbird-fault: <fault>` |
| Response header | `x-mockingbird-fault: <rule id>` on a response a rule answered or shaped |
| At boot | `adminControls.faults` · `--fault <fault>` |
| In process | `runtime.faults` · `runtime.applyPreset()` |
| Admin page | **Faults** at `/__admin/ui#faults` |

## Admin page

Open `http://localhost:8787/__admin/ui#faults`.

| Control | Does |
| --- | --- |
| Add a fault, Fields, then Add fault | `POST /__admin/faults` with the match, schedule and effect fields you filled |
| Add a fault, JSON, then Add fault | The same call. The textarea accepts every rule field, including ones the field form does not show |
| Active rules, Remove | `DELETE /__admin/faults/<id>` |
| Clear all | `DELETE /__admin/faults` for this namespace. Rules that apply to every namespace stay |
| Presets, count, Apply | `POST /__admin/faults` with `{"preset": "<name>"}`. A count retires the preset after that many faults |

## Quick start

```bash
# The third CreateCharge fails once with a 503.
curl -X POST localhost:8787/__admin/faults -d '{
  "operationId": "CreateCharge", "after": 2, "count": 1,
  "status": 503, "headers": {"retry-after": "1"}, "body": {"error": "unavailable"}
}'
```

```json
{
  "id": "fault_1",
  "namespace": "default",
  "operationId": "CreateCharge",
  "after": 2,
  "count": 1,
  "status": 503,
  "headers": { "retry-after": "1" },
  "body": { "error": "unavailable" }
}
```

Or by name, with a preset every emulator has:

```bash
curl -X POST localhost:8787/__admin/faults -d '{"preset": "rate_limited", "count": 1}'
```

Or for one request, in a header: `x-mockingbird-fault: 503`.

## The fault rule

A rule says what it **matches**, **when** it fires among the matching requests, and what it **does**. Every field is optional except that a rule must do something.

### Match

| Field | Type | Matches |
| --- | --- | --- |
| `operationId` | string | One operation of the vendor contract |
| `method` | string | An HTTP method, case-insensitive |
| `path` | string | This exact path |
| `pathPrefix` | string | Paths starting with this |
| `pathPattern` | string | Paths matching this regular expression |
| `requestHeaders` | object of strings | Requests carrying these headers. `"*"` matches any value |
| `query` | object of strings | Requests carrying these query parameters. `"*"` matches any value |
| `namespace` | string | Default: the calling namespace. `"*"` faults every namespace |

A rule with no match fields matches every vendor request in its namespace.

### When

| Field | Type | Meaning |
| --- | --- | --- |
| `after` | integer ≥ 0 | Let this many matching requests through first |
| `every` | integer ≥ 1 | Then fault only every nth: `3` faults the 3rd, 6th, 9th |
| `count` | integer ≥ 0 | Retire the rule after this many faults |
| `rate` | number `0`–`1` | Fault this fraction of the rest, drawn from the [seed](SEED_AND_DETERMINISM.md) |
| `from` | instant or duration | Fault only from this instant on the namespace [clock](CLOCK.md). A duration counts from when the rule was added |
| `until` | instant or duration | Stop faulting at this instant |

### Do

| Field | Type | Does |
| --- | --- | --- |
| `status` | integer `200`–`599` | Answer with this status instead of reaching the emulator |
| `body` | any | The response body, as JSON. A string is sent as it is. Default `{"detail": "Injected by Mockingbird"}` |
| `headers` | object of strings | Response headers |
| `delay` | duration | Hold the response back this long |
| `jitter` | duration | Add a seeded `0`–`jitter` to the delay |
| `timeout` | duration | Never answer: hold the request this long, then drop the connection |
| `drop` | `true` | Drop the connection at once |
| `truncate` | integer ≥ 0 | Send the status and headers, then cut the body off after this many bytes |
| `effect` | string | Switch on a named emulator behaviour for this request. Each emulator's guide lists its own |
| `params` | object | Parameters for `effect` |

A dropped connection rejects an in-process `fetch` with a `TypeError` and destroys the socket of a served emulator. See [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) for how waits are spent.

### As stored

`id` is `fault_1`, `fault_2`, … per namespace unless you give one. Durations are stored in milliseconds (`delayMs`, `jitterMs`, `timeoutMs`) and windows as epoch ms. A listed rule also carries its counters:

| Field | Meaning |
| --- | --- |
| `hits` | Times the rule faulted a request |
| `seen` | Requests that matched it, faulted or not |
| `remaining` | Faults left before it retires. `null` without `count` |
| `fromPreset` | The preset it was expanded from, if any |

### Order

Rules are tried in the order they were added. One that answers, drops or times out ends the search. A rule that only delays, truncates or sets an effect lets later rules, and the emulator, still act.

## Admin API

### `POST /__admin/faults`

Add a rule, or a preset with `{"preset": "<name>", …overrides}`. Status `201`. Answers the stored rule, or `{"preset", "rules"}` for a preset.

```bash
curl -X POST localhost:8787/__admin/faults -d '{"preset": "rate_limited", "count": 1}'
```

```json
{
  "preset": "rate_limited",
  "rules": [
    {
      "id": "rate_limited",
      "fromPreset": "rate_limited",
      "namespace": "default",
      "count": 1,
      "status": 429,
      "headers": { "retry-after": "1" }
    }
  ]
}
```

### `GET /__admin/faults`

The rules that can hit this namespace: its own and the `"*"` ones. `?all=1` lists every namespace's.

```bash
curl localhost:8787/__admin/faults
```

```json
{
  "faults": [
    {
      "id": "fault_1",
      "namespace": "default",
      "operationId": "CreateCharge",
      "after": 2,
      "count": 1,
      "status": 503,
      "headers": { "retry-after": "1" },
      "body": { "error": "unavailable" },
      "remaining": 1,
      "hits": 0,
      "seen": 0
    },
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

### `GET /__admin/faults/<id>` · `DELETE /__admin/faults/<id>`

Read or remove one rule. `DELETE` answers `{"status": "ok"}`.

```bash
curl -X DELETE localhost:8787/__admin/faults/rate_limited
```

### `PUT /__admin/faults`

Replace the namespace's rules with a list. The whole list is checked first: one bad rule and nothing changes.

```bash
curl -X PUT localhost:8787/__admin/faults -d '{"faults": [{"status": 500, "rate": 0.5}]}'
```

```json
{
  "faults": [
    { "id": "fault_1", "namespace": "default", "rate": 0.5, "status": 500, "remaining": null, "hits": 0, "seen": 0 }
  ]
}
```

### `DELETE /__admin/faults`

Remove the namespace's rules. `?id=<id>` removes one; `?all=1` removes every namespace's and the `"*"` ones. Answers `{"status": "ok"}`.

```bash
curl -X DELETE localhost:8787/__admin/faults
```

### `GET /__admin/faults/presets` · `POST /__admin/faults/presets/<name>`

List the presets this emulator answers to, or switch one on. The body of the `POST` overrides the preset's fields.

```bash
curl -X POST localhost:8787/__admin/faults/presets/slow -d '{"count": 2}'
```

```json
{
  "preset": "slow",
  "rules": [{ "id": "slow", "fromPreset": "slow", "namespace": "default", "count": 2, "delayMs": 2000 }]
}
```

## Presets

A preset is a fault by name. Any rule field given beside `preset` overrides it. Its rule takes the preset's name as its id (`rate_limited`, or `rate_limited_1`, `rate_limited_2` when the preset has several), so applying a preset again replaces it; give an `id` to keep both.

Every emulator answers to these:

| Preset | Does |
| --- | --- |
| `server_error` | `500` |
| `bad_gateway` | `502` |
| `unavailable` | `503` with `retry-after` |
| `gateway_timeout` | `504` |
| `rate_limited` | `429` with `retry-after` |
| `unauthorized` | `401` |
| `forbidden` | `403` |
| `slow` | Two more seconds on every response |
| `timeout` | The request hangs 30 seconds, then the connection drops |
| `connection_reset` | The connection drops before any response |
| `truncated_response` | The response starts, then the connection dies mid-body |
| `flaky` | Half of the requests answer `503`, chosen by the seed |

An emulator adds presets with its vendor's own error bodies and failure modes, and replaces a standard one when the vendor has a specific shape for it. `GET /__admin/faults/presets` is the list for the emulator in front of you.

## Request header

`x-mockingbird-fault` faults one request. It is never stored, and when it answers the request no stored rule is consulted or used up.

| Value | Means |
| --- | --- |
| `503` | Answer with that status |
| `drop` | Drop the connection |
| `rate_limited` | A preset, by name |
| `status=503; delay=2s; header.retry-after=5` | `key=value` pairs: `status`, `delay`, `jitter`, `timeout`, `drop`, `truncate`, `effect`, `body`, `preset`, `header.<name>` |
| `{"status": 503, "body": {"error": "down"}}` | A rule as JSON |

```bash
curl -X POST localhost:8787/v1/charges -H 'x-mockingbird-fault: status=503; delay=2s' \
  -H 'authorization: Bearer sk_test_mockingbird'
```

It says what happens to its own request and nothing else: a field that chooses requests (`operationId`, `count`, `rate`, …) is refused with `400`, and a preset's own are ignored.

## At boot

```json
{
  "faults": [
    { "operationId": "CreateCharge", "status": 503, "count": 2 },
    { "preset": "rate_limited", "rate": 0.1 }
  ]
}
```

```bash
npx mockingbird-stripe serve --fault rate_limited
npx mockingbird-stripe serve --fault 'status=503; delay=2s'
```

Each namespace boots with its own copy of these rules, with its own counters. [Reset](RESET.md) returns to them.

## In process

```ts
runtime.faults.add({ id: "down", operationId: "CreateCharge", status: 503, count: 1 })
runtime.faults.list("worker-3")           // rules that can hit a namespace, with counters
runtime.faults.remove("down")
runtime.faults.clear("worker-3")
runtime.applyPreset("rate_limited", "worker-3", { count: 1 })
runtime.headers({ fault: { status: 503 } }) // { "x-mockingbird-fault": "{\"status\":503}" }
```

A rule added in process without a `namespace` faults every namespace.

## Rules for every namespace

A rule with `"namespace": "*"` is one rule with one set of counters, whichever namespace the requests come from. It belongs to no namespace:

- It is added with `POST /__admin/faults`. A [control document](CONTROL_DOCUMENT.md) belongs to one namespace and cannot hold one.
- A namespace's reset and `DELETE /__admin/faults` leave it. `?all=1` removes it.
- A `rate` on it draws from the stream of the namespace each request arrives in.

## Errors

| Status | When |
| --- | --- |
| `400` | A field has the wrong type or an unknown name, a rule does nothing, or `namespace` is not a key or `"*"` |
| `404` | No rule of that id, or no preset of that name |
| `401` | The emulator has an admin key and the request did not carry it |

A rejected rule takes no id and stores nothing.

## Related

- [Latency and timeouts](LATENCY_AND_TIMEOUTS.md) for delays that apply to every request.
- [Journal, metrics and state](JOURNAL_AND_STATE.md): each journal entry records the `faultId` that shaped it.
- [Seed and determinism](SEED_AND_DETERMINISM.md) for how `rate` and `jitter` replay.
