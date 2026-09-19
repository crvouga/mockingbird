# postgres-mem React playground

Client-side SQL playground using [`@crvouga/postgres-mem`](../..) in the browser. No WASM, workers, or filesystem.

## Run

```bash
cd examples/react-vite
bun install
bun run dev
```

From the repo root (after the install above):

```bash
bun run example
```

Vite aliases `@crvouga/postgres-mem` to the library source, so you do not need to `bun run build` first.

## What it shows

- Synchronous `Database` / `Statement` API
- `prepare().result()` including empty result-set column names
- `PostgresError.category` + five-character SQLSTATE
- `snapshot().encode()` / `Snapshot.decode(bytes).open()` persisted in `localStorage` (PGMM bytes, not a PostgreSQL data directory)
- Live `now()` via `new Database({ now: "system" })` — the library default is a fixed year-2000 clock
- Postgres dialect features: serial / identity PKs, `INSERT ... RETURNING`, `ON CONFLICT` upsert, `DISTINCT ON`,
  `LATERAL`, arrays + `unnest`, `jsonb` operators, full-text search, window functions, recursive CTEs,
  `generate_series`
