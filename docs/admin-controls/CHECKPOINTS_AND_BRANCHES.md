# Checkpoints and branches

Every successful write checkpoints the namespace. Read the namespace as it was at any checkpoint, or branch from one and take a different path, without touching the main line.

<!-- search: history timeline checkpoint branch fork checkout rewind undo what-if time travel state at -->

## Interface

| Carrier | How |
| --- | --- |
| Request header | `x-mockingbird-at: <checkpoint>` · `x-mockingbird-branch: <name>` |
| Response header | `x-mockingbird-checkpoint: <checkpoint>` on every successful write |
| Admin API | `GET /__admin/timeline` · `POST /__admin/checkpoints` · `POST /__admin/branches/<name>` · `POST /__admin/branches/<name>/checkout` |
| In process | `runtime.checkpoint()` · `runtime.branch()` · `runtime.checkout()` · `runtime.timeline()` |
| Admin page | **Checkpoints** at `/__admin/ui#checkpoints`. Its Restore button checks out a checkpoint, which is not a snapshot restore |

A checkpoint holds the namespace's records, its clock and the emulator's random stream. For a named save that also holds faults and latency and can be exported, use a [snapshot](SNAPSHOT_AND_RESTORE.md).

## Admin page

Open `http://localhost:8787/__admin/ui#checkpoints`.

| Control | Does |
| --- | --- |
| Branch | Which branch the buttons below act on. `main` exists from the start |
| Create checkpoint | `POST /__admin/checkpoints` for that branch |
| New branch name, then Create branch | `POST /__admin/branches/<name>` |
| Restore on a checkpoint row | `POST /__admin/branches/<name>/checkout` with `{"checkpoint": "<id>"}`. Moves that branch to the checkpoint |

This Restore is not [snapshot restore](SNAPSHOT_AND_RESTORE.md#admin-page). A snapshot is a named copy of records, the clock, faults and latency. A checkpoint is the history written after each successful write.

## Request headers

| Header | On a read | On a write |
| --- | --- | --- |
| `x-mockingbird-at: <checkpoint>` | Answer from the namespace as it was at that checkpoint | Move `main` back to that checkpoint, then write |
| `x-mockingbird-branch: <name>` | Read the branch | Write to the branch. `main` is untouched |
| Both | Read the branch, started at that checkpoint | Start the branch at that checkpoint, then write to it |

```bash
# A write answers with the checkpoint it was filed under.
curl -i -X POST localhost:8787/v1/customers -d email=ada@example.com \
  -H 'authorization: Bearer sk_test_mockingbird'
# x-mockingbird-checkpoint: cp_00000002

# Read the namespace as it was then, whatever has happened since.
curl localhost:8787/v1/customers -H 'x-mockingbird-at: cp_00000002' \
  -H 'authorization: Bearer sk_test_mockingbird'

# Try something else from that point, on a branch.
curl -X POST localhost:8787/v1/customers -d email=grace@example.com \
  -H 'x-mockingbird-branch: what-if' -H 'x-mockingbird-at: cp_00000002' \
  -H 'authorization: Bearer sk_test_mockingbird'
```

A response from a branch carries `x-mockingbird-branch`; one read at a checkpoint carries `x-mockingbird-at`.

A write with `x-mockingbird-at` on `main` rewinds `main`. That changes the namespace, so it needs the admin key when the emulator has one. Reads, and writes on a branch, need none.

## Admin API

### `POST /__admin/checkpoints`

Checkpoint a branch now. Vendor writes and `/__admin/state` edits do this on their own; use it to mark a point you want to come back to.

| Body field | Type | Meaning |
| --- | --- | --- |
| `branch` | string, optional | The branch to checkpoint. Default `main` |

```bash
curl -X POST localhost:8787/__admin/checkpoints
```

```json
{ "id": "cp_00000002", "branch": "main", "parent": "cp_00000001", "at": 1893456000000, "records": 0 }
```

Status `201`.

### `POST /__admin/branches/<name>`

Create a branch. A name matches `[A-Za-z0-9_.-]{1,64}`. Naming a branch that exists moves it to `at`, or leaves it where it is without one.

| Body field | Type | Meaning |
| --- | --- | --- |
| `at` | checkpoint id, optional | Where the branch starts. Default: the head of `main`, now |

Answers the checkpoint the branch starts at.

```bash
curl -X POST localhost:8787/__admin/branches/what-if -d '{"at": "cp_00000002"}'
```

```json
{ "id": "cp_00000002", "branch": "main", "parent": "cp_00000001", "at": 1893456000000 }
```

Status `201`.

### `POST /__admin/branches/<name>/checkout`

Move a branch to a checkpoint: records, clock and random stream go back to it. `main` is a branch like any other.

| Body field | Type | Meaning |
| --- | --- | --- |
| `checkpoint` | checkpoint id | Required |

```bash
curl -X POST localhost:8787/__admin/branches/main/checkout -d '{"checkpoint": "cp_00000002"}'
```

```json
{ "status": "ok", "branch": "main", "checkpoint": "cp_00000002" }
```

### `GET /__admin/timeline`

Every retained checkpoint, and the checkpoint each branch is at.

```bash
curl localhost:8787/__admin/timeline
```

```json
{
  "branches": { "main": "cp_00000002", "what-if": "cp_00000002" },
  "checkpoints": [
    { "id": "cp_00000001", "branch": "main", "parent": null, "at": 1893456000000 },
    { "id": "cp_00000002", "branch": "main", "parent": "cp_00000001", "at": 1893456000000 }
  ]
}
```

## In process

```ts
const point = runtime.checkpoint()                      // → { id, branch, parent, at, value }
runtime.branch("what-if", { at: point.id })
runtime.checkout(point.id)                               // main back to that checkpoint
runtime.checkout(point.id, { branch: "what-if", namespace: "worker-3" })
runtime.timeline().head("main")?.id
runtime.timeline().branches()                            // { main: "cp_…", "what-if": "cp_…" }
```

## Rules

- **History only grows.** [Restoring a snapshot](SNAPSHOT_AND_RESTORE.md) adds a checkpoint instead of rewriting one, so the same write afterwards is the same response under a later id.
- **The newest 1,000 checkpoints are kept** per namespace. Branch heads are never dropped.
- **[Reset](RESET.md) discards history**: checkpoint ids start again from `cp_00000001`.
- Checkpoints and branches belong to their namespace.

## Errors

| Status | When |
| --- | --- |
| `400` | `checkout` has no `checkpoint` |
| `401` | A write carried `x-mockingbird-at` on `main` without the admin key the emulator requires |
| `409` | The checkpoint does not exist, or a branch name does not match `[A-Za-z0-9_.-]{1,64}` |

A request whose `x-mockingbird-at` names a checkpoint that is not there answers `409` and changes nothing.

## Related

- [Snapshot and restore](SNAPSHOT_AND_RESTORE.md) for named, exportable saves.
- [Clock](CLOCK.md) to move time instead of state.
