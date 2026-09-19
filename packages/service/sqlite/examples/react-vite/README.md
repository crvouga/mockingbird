# sqlite-mem React playground

Client-side SQL playground using [`@crvouga/sqlite-mem`](../..) in the browser. No WASM, workers, or filesystem.

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

Vite aliases `@crvouga/sqlite-mem` to the library source, so you do not need to `bun run build` first.

## What it shows

- Synchronous `Database` / `Statement` API
- `prepare().result()` including empty result-set column names
- `SqliteError.category`
- `snapshot().encode()` / `Snapshot.decode(bytes).open()` persisted in `localStorage` (SQLM bytes, not a `.sqlite` file)
- Live `'now'` via `new Database({ now: () => new Date() })` — the library default is a fixed year-2000 clock
