# Snapshot and restore

A snapshot is a saved copy of a whole namespace. Take one after setting up the state a test needs, and restore it before each test: the namespace goes back to exactly that state, so the requests that follow give the same responses every time.

<!-- search: snapshot snapshots restore save load rollback roll back baseline fixture seed data export import backup state dump admin page ui button -->

## Interface

| Carrier | How |
| --- | --- |
| Admin API | `POST /__admin/snapshots` · `GET /__admin/snapshots` · `GET /__admin/snapshots/<id>` · `PUT /__admin/snapshots/<id>` · `POST /__admin/snapshots/<id>/restore` · `DELETE /__admin/snapshots/<id>` |
| Request header | `x-mockingbird-snapshot: <name>` · `x-mockingbird-restore: <name>` |
| At boot | `adminControls.snapshot` · `--snapshot <file>` |
| In process | `runtime.snapshots.create()` · `.list()` · `.export()` · `.import()` · `.restore()` · `.delete()` |
| Admin page | **Snapshot & restore** at `/__admin/ui#snapshots`: Take snapshot, Import snapshot, and on each row View, Restore, Delete |

## Admin page

Open `http://localhost:8787/__admin/ui#snapshots`. The sidebar item is **Snapshot & restore**. On a narrow window the sidebar shows its icon; the label is on the tooltip. **Jump** (`⌘K` or `Ctrl+K`) finds the screen by "snapshot" or "restore".

The header **Namespace** select chooses which namespace the buttons act on.

| Control | Does |
| --- | --- |
| Name, then Take snapshot | `POST /__admin/snapshots`. The name is optional. A name already in use replaces that snapshot. With no name the id is `snap_1`, `snap_2`, … |
| Id and Snapshot document, then Import snapshot | `PUT /__admin/snapshots/<id>`. Stores the document under that id. Does not restore it |
| View | `GET /__admin/snapshots/<id>`, shown on the page. Download JSON saves that document |
| Restore | `POST /__admin/snapshots/<id>/restore`. Replaces this namespace with the snapshot: records, clock, fault rules and latency. The snapshot stays, so Restore can run again |
| Delete | `DELETE /__admin/snapshots/<id>` |

**Checkpoints** also has a button named Restore. That one checks out a [checkpoint](CHECKPOINTS_AND_BRANCHES.md#admin-page). It does not restore a snapshot.

## Quick start

```bash
# Save the namespace under a name.
curl -X POST localhost:8787/__admin/snapshots -d '{"name": "baseline"}'

# ... run a test that changes things ...

# Put it back.
curl -X POST localhost:8787/__admin/snapshots/baseline/restore
```

```json
{ "status": "ok", "id": "baseline", "namespace": "default" }
```

## What a snapshot holds

Everything the namespace is, so that restoring it replays what followed:

| Part | Restored to |
| --- | --- |
| Records and id counters | The same rows, and the next generated id is the same one |
| Clock | The same instant, frozen or running as it was |
| Seed and random streams | The same position, so a `rate` fault hits the same requests |
| Fault rules | The same rules, with their `hits`, `seen` and `remaining` counters |
| Latency and virtual time | The same settings |

Not in a snapshot: the journal and metrics (what happened is not undone), other snapshots, and anything outside the namespace.

## Admin API

A snapshot belongs to the namespace it was taken in. Its id is unique within that namespace.

### `POST /__admin/snapshots`

Take a snapshot now.

| Body field | Type | Meaning |
| --- | --- | --- |
| `name` | string, optional | The snapshot's id. Matches `[A-Za-z0-9_.-]{1,64}`. Taking a name again replaces that snapshot. Without it the id is `snap_1`, `snap_2`, … |

```bash
curl -X POST localhost:8787/__admin/snapshots -d '{"name": "baseline"}'
```

```json
{ "id": "baseline", "namespace": "default", "records": 0, "at": 1893456000000, "portable": true }
```

| Response field | Meaning |
| --- | --- |
| `id` | The name to restore it by |
| `namespace` | The namespace it belongs to |
| `records` | How many stored rows it holds |
| `at` | The namespace clock when it was taken, epoch ms |
| `portable` | Whether `GET /__admin/snapshots/<id>` can export it. Always `true` for HTTP emulators |

Status `201`.

### `GET /__admin/snapshots`

The namespace's snapshots, oldest first.

```bash
curl localhost:8787/__admin/snapshots
```

```json
{
  "snapshots": [
    { "id": "baseline", "namespace": "default", "records": 0, "at": 1893456000000, "portable": true }
  ]
}
```

### `POST /__admin/snapshots/<id>/restore`

Replace the namespace with the snapshot. No body. The snapshot stays, so it can be restored again.

```bash
curl -X POST localhost:8787/__admin/snapshots/baseline/restore
```

```json
{ "status": "ok", "id": "baseline", "namespace": "default" }
```

### `GET /__admin/snapshots/<id>`

Export the snapshot as a JSON document. Commit it beside a test suite, import it into another namespace, or boot another process from it.

```bash
curl localhost:8787/__admin/snapshots/baseline
```

```json
{
  "format": "mockingbird.snapshot/v1",
  "service": "stripe",
  "records": [],
  "sequences": [],
  "clock": { "now": 1893456000000, "frozen": true, "autoAdvanceMs": 0 },
  "seed": 0,
  "rng": { "state": 0, "faults": 0, "latency": 0 },
  "faults": { "rules": [], "nextId": 0 },
  "latency": { "delayMs": 0, "jitterMs": 0, "operations": {} },
  "virtualTime": false
}
```

### `PUT /__admin/snapshots/<id>`

Store a document as a snapshot under this id. Nothing in the namespace changes until it is restored.

```bash
curl -X PUT localhost:8787/__admin/snapshots/seeded -d '{
  "format": "mockingbird.snapshot/v1",
  "records": [
    { "collection": "customers", "id": "cus_1", "value": { "id": "cus_1", "email": "ada@example.com" } }
  ]
}'
```

```json
{ "id": "seeded", "namespace": "default", "records": 1, "at": 1893456000000, "portable": true }
```

Status `200`.

### `DELETE /__admin/snapshots/<id>`

Delete a snapshot. Answers `{"status": "ok"}`.

```bash
curl -X DELETE localhost:8787/__admin/snapshots/seeded
```

## The snapshot document

Only `format` and `records` are required, so a hand-written seed file is a valid snapshot.

| Field | Type | Meaning |
| --- | --- | --- |
| `format` | `"mockingbird.snapshot/v1"` | Required. Identifies the document |
| `service` | string | The emulator that wrote it. A document from another emulator is refused |
| `records` | list | Required. Each `{collection, id, value, seq?}`. `seq` orders a collection; without it rows keep their listed order |
| `sequences` | list of `{name, kind, value}` | Id counters, so generated ids continue where the snapshot left off |
| `clock` | `{now, frozen, autoAdvanceMs?}` | The namespace clock |
| `seed` | number or string | The namespace's seed |
| `rng` | `{state, faults?, latency?}` | Where each seeded stream stands |
| `faults` | `{rules, nextId}` | Fault rules with their counters |
| `latency` | `{delayMs, jitterMs, operations}` | Baseline latency |
| `virtualTime` | boolean | Whether waits are spent on the mock clock |

Collection names and row shapes are the emulator's own; read them from `GET /__admin/state`.

A document restores what it holds and leaves the rest of the namespace as it is. A file with only `records` replaces the records and touches no clock, fault or latency.

## Request headers

| Header | Does |
| --- | --- |
| `x-mockingbird-restore: <name>` | Restore the snapshot before the request is handled |
| `x-mockingbird-snapshot: <name>` | Take a snapshot after the request is handled. The response echoes the name in `x-mockingbird-snapshot` |

```bash
# Create a customer and save the result as "one-customer".
curl -X POST localhost:8787/v1/customers -H 'x-mockingbird-snapshot: one-customer' \
  -H 'authorization: Bearer sk_test_mockingbird' -d email=ada@example.com

# Later: go back to it, then list.
curl localhost:8787/v1/customers -H 'x-mockingbird-restore: one-customer' \
  -H 'authorization: Bearer sk_test_mockingbird'
```

A snapshot asked for in a header is taken only when there is a response to carry its name: not when the connection is dropped.

## At boot

Start every namespace from a document instead of the emulator's own seed data:

```bash
curl localhost:8787/__admin/snapshots/baseline > baseline.json
npx mockingbird-stripe serve --snapshot baseline.json
```

```ts
import baseline from "./baseline.json"

const stripe = createRuntime({ adminControls: { snapshot: baseline } })
```

[Reset](RESET.md) then returns to that document. A control named beside `snapshot` (a `clock`, a `seed`) wins over the one the snapshot carries.

## In process

```ts
runtime.snapshots.create({ name: "baseline" })           // → { id, namespace, records, at, portable }
runtime.snapshots.create({ name: "s", namespace: "w" })
runtime.snapshots.list("w")                               // → [{ id, … }]
runtime.snapshots.restore("baseline")
const document = runtime.snapshots.export("baseline")    // → SnapshotDocument
runtime.snapshots.import(document, { name: "copy", namespace: "w" })
runtime.snapshots.delete("baseline")                      // → true
```

`restore` and `export` throw a `RangeError` for a snapshot that is not there.

## Rules

- **Restoring adds to history.** It does not rewrite [checkpoints](CHECKPOINTS_AND_BRANCHES.md): the same write after a restore is the same response under a later checkpoint id.
- **A reset discards snapshots.** Export the ones you want to keep, or boot from them.
- **Imported rules land in the namespace they are restored into**, wherever the snapshot was taken.
- **Snapshots stay in the process.** They are gone when the emulator stops; an exported document is what persists.

## Errors

| Status | When |
| --- | --- |
| `400` | The name does not match `[A-Za-z0-9_.-]{1,64}`, or a document is malformed, repeats a row, or came from another emulator |
| `404` | No snapshot of that id in this namespace |
| `401` | The emulator has an admin key and the request did not carry it |

A request with `x-mockingbird-restore` naming a snapshot that is not there answers `404` and changes nothing.

## Related

- [Reset](RESET.md) returns to boot instead of to a snapshot.
- [Checkpoints and branches](CHECKPOINTS_AND_BRANCHES.md) are taken automatically after every write and are read with a header.
- [Journal, metrics and state](JOURNAL_AND_STATE.md) for the collection names a document's records use.
