# Journal, metrics and state

Three ways to see what an emulator did and what it holds: the journal lists every request it received, metrics count them, and state reads and edits the stored rows directly.

<!-- search: journal requests log history inspect assert received metrics counts unmatched state records rows collections seed data edit database admin ui debug verify called -->

## Interface

| To | Use |
| --- | --- |
| Prove a request arrived, or never did | `GET /__admin/requests` · `DELETE /__admin/requests` |
| Count requests and find paths nothing matched | `GET /__admin/metrics` · `DELETE /__admin/metrics` |
| Read stored rows | `GET /__admin/state` · `GET /__admin/state/<collection>` · `GET /__admin/state/<collection>/<id>` |
| Seed or edit stored rows | `POST /__admin/state/<collection>` · `PUT /__admin/state/<collection>/<id>` · `PATCH /__admin/state/<collection>/<id>` · `DELETE /__admin/state/<collection>/<id>` |
| Do all of it in a browser | `GET /__admin/ui` · `/__admin/ui#journal` · `/__admin/ui#state` · `/__admin/ui#overview` |
| In process | `runtime.journal` · `runtime.metrics` · `runtime.state(key?)` |
| Admin page | **Journal**, **State** and **Overview**. The other screens are on their own pages |

## Manual retry verification

**Manual controls** (`/__admin/ui#manual`) combines request targeting, bounded delay/timeout/503
faults, and a live filtered journal. **Journal** (`/__admin/ui#journal`) also shows attempt counts
grouped by method, path and operation, with first and latest statuses. Both refresh every
1.5 seconds and have a Live/Paused switch. A new row after clicking Retry demonstrates another
request reached the emulator; counts alone cannot distinguish retries from background polling.
Requests appear when they finish or fail. Status `0` means a dropped connection.

## The journal

### `GET /__admin/requests`

One entry per vendor request the namespace received, oldest first. Admin calls are not journaled. Bodies are never recorded.

```bash
curl 'localhost:8787/__admin/requests?operationId=CreateCharge&status=503'
```

```jsonc
{
  "size": 1000,
  "requests": [
    {
      "service": "stripe",
      "namespace": "default",
      "operationId": "CreateCharge",
      "method": "POST",
      "path": "/v1/charges",
      "status": 503,
      "durationMs": 2000,
      "unmatched": false,
      "faultId": "fault_1",
      "delayMs": 2000,
      "at": "2030-01-01T00:00:02.000Z"
    }
  ]
}
```

| Query | Keeps |
| --- | --- |
| `operationId` | Requests to this operation |
| `method` | This HTTP method, case-insensitive |
| `path` | This exact path |
| `status` | This response status. `0` is a dropped or timed-out connection |
| `faultId` | Requests this fault rule answered or shaped |
| `since` | Entries at or after this instant |
| `limit` | At most this many, the most recent |
| `all=1` | Every namespace, not only the calling one |

| Entry field | Meaning |
| --- | --- |
| `service` · `namespace` | Which emulator and key handled it |
| `operationId` | The vendor operation it matched. Absent when none did |
| `method` · `path` | The request line |
| `status` | The response status. `0` when the connection was dropped |
| `durationMs` | How long it took. With [virtual time](LATENCY_AND_TIMEOUTS.md#virtual-time), exactly the injected wait |
| `unmatched` | True when no operation of the vendor contract matched |
| `at` | The namespace clock when it was handled, ISO-8601 |
| `faultId` | The fault rule that answered or shaped it, or `request` for a fault sent in a header |
| `delayMs` | The latency and delay injected |
| `checkpoint` | The checkpoint a successful write was filed under |
| `ids` | Ids the request created, by kind, when the emulator reports them |
| `request` · `issues` | Why a request was rejected: its content type and size, and the body fields at fault |

`size` is how many entries each namespace keeps (`journalSize`, default `1000`); the oldest fall off.

### `DELETE /__admin/requests`

Clear the namespace's journal. `?all=1` clears every namespace's.

```bash
curl -X DELETE localhost:8787/__admin/requests
```

```json
{ "status": "ok" }
```

## Metrics

### `GET /__admin/metrics`

Totals for every namespace, or for one with `?namespace=<key>` or the namespace header.

```bash
curl localhost:8787/__admin/metrics
```

```json
{ "requests": 0, "byOperation": {}, "unmatched": [], "faults": 0, "totalDurationMs": 0 }
```

| Field | Meaning |
| --- | --- |
| `requests` | Vendor requests handled |
| `byOperation` | Counts keyed by `"<operationId> <status>"`, such as `"CreateCharge 503"` |
| `unmatched` | `{method, path, count}` for each path no operation matched: what the emulator does not cover |
| `faults` | Requests a fault rule answered or shaped |
| `totalDurationMs` | The sum of every request's `durationMs` |

### `DELETE /__admin/metrics`

Clear them. Answers `{"status": "ok"}`.

```bash
curl -X DELETE localhost:8787/__admin/metrics
```

## State

Stored rows, without going through the vendor API. Use it to seed a record a test needs, or to assert on what a request wrote. Collection names and row shapes are the emulator's own.

### `POST /__admin/state/<collection>`

Create a row.

| Body field | Type | Meaning |
| --- | --- | --- |
| `value` | object | The row |
| `id` | string, optional | The row's id. Without it the id is `<collection>_1`, `<collection>_2`, … |

```bash
curl -X POST localhost:8787/__admin/state/customers \
  -d '{"id": "cus_1", "value": {"id": "cus_1", "email": "ada@example.com"}}'
```

```json
{ "id": "cus_1", "seq": 1, "value": { "id": "cus_1", "email": "ada@example.com" } }
```

Status `201`. `seq` is the row's position in its collection.

### `GET /__admin/state`

The namespace's collections, with the fields their rows hold.

```bash
curl localhost:8787/__admin/state
```

```json
{
  "namespace": "default",
  "collections": [{ "name": "customers", "label": "Customers", "count": 1 }]
}
```

Each collection also lists its `fields` (`{name, kind, optional}`) and whether its shape was declared by the emulator or `inferred` from the rows.

### `GET /__admin/state/<collection>`

A page of rows. `?limit=` (default `50`, at most `200`) and `?offset=` page through them; `next` is the offset of the next page, or `null`.

```bash
curl localhost:8787/__admin/state/customers
```

```json
{
  "collection": "customers",
  "count": 1,
  "records": [{ "id": "cus_1", "seq": 1, "value": { "id": "cus_1", "email": "ada@example.com" } }],
  "next": null
}
```

### `GET /__admin/state/<collection>/<id>`

One row, as `{id, seq, value}`.

```bash
curl localhost:8787/__admin/state/customers/cus_1
```

### `PUT /__admin/state/<collection>/<id>` · `PATCH /__admin/state/<collection>/<id>`

`PUT` replaces the row with `{"value": …}`. `PATCH` shallow-merges `{"value": …}` into it.

```bash
curl -X PATCH localhost:8787/__admin/state/customers/cus_1 -d '{"value": {"name": "Ada"}}'
```

```json
{ "id": "cus_1", "value": { "id": "cus_1", "email": "ada@example.com", "name": "Ada" } }
```

### `DELETE /__admin/state/<collection>/<id>`

Delete a row. Answers its id.

```bash
curl -X DELETE localhost:8787/__admin/state/customers/cus_1
```

```json
{ "id": "cus_1" }
```

A state edit is a write like any other: it files a [checkpoint](CHECKPOINTS_AND_BRANCHES.md). `PUT`, `PATCH` and `DELETE` answer `404` for a row that is not there. To load many rows at once, [import a snapshot document](SNAPSHOT_AND_RESTORE.md#the-snapshot-document).

## The admin page

`GET /__admin/ui` and `GET /__admin/ui/` serve the page. Open `http://localhost:8787/__admin/ui`. `GET /__admin/ui/manifest` lists the emulator's own panels beside the shared screens. The map of every shared screen is on [Reference](REFERENCE.md#admin-page). **Jump** (`⌘K` or `Ctrl+K`) searches their names.

| Screen | Hash | What you do there |
| --- | --- | --- |
| Overview | `#overview` | Service, collection count, record count, clock, seed, virtual time, latency, the latest requests, and [Reset namespace](RESET.md#admin-page) |
| State | `#state` | Pick a collection. **New record** opens a Record ID and a JSON value (`POST /__admin/state/<collection>`). The edit button replaces a row (`PUT`) or deletes it. Previous and Next page the rows. A SQL emulator tells you to edit rows from its SQL panel |
| Journal | `#journal` | The latest 1,000 requests. **Clear journal** is `DELETE /__admin/requests` |

Snapshot restore is not on these screens. It is **Snapshot & restore**, [its own page](SNAPSHOT_AND_RESTORE.md#admin-page).

## In process

```ts
runtime.journal.list({ namespace: "default", operationId: "CreateCharge", status: 503 })
runtime.journal.clear("default")
runtime.metrics.report()            // every namespace
runtime.metrics.report("worker-3")
runtime.state("worker-3")           // { namespace, collections }
```

## Rules

- **A namespace's journal and metrics are its own.** [Reset](RESET.md) empties both. Restoring a [snapshot](SNAPSHOT_AND_RESTORE.md) leaves them: what happened is not undone.
- **A faulted request is journaled** with its `faultId`, and a dropped one with status `0`.

## Errors

| Status | When |
| --- | --- |
| `400` | `status`, `since` or `limit` cannot be read, or a state body has no `value` |
| `404` | No row of that id in the collection |
| `401` | The emulator has an admin key and the request did not carry it |

## Related

- [Faults](FAULTS.md) for the rules a `faultId` names.
- [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) to save and load whole namespaces of rows.
