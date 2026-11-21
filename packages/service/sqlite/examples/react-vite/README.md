# sqlite-mem React playground

Client-side SQL playground using [`@crvouga/mockingbird-service-sqlite`](../..) in the browser. No WASM, workers, or filesystem.

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

Vite aliases `@crvouga/mockingbird-service-sqlite` to the library source, and `@crvouga/mockingbird-ui` (Mockingbird's
design system) to [`packages/ui/src`](../../../../ui), so neither needs a `bun run build` first. React, HeroUI and
Tailwind CSS come from this example's own `node_modules` (`resolve.dedupe`), so there is one copy of each.

## UI

React and [HeroUI v3](https://heroui.com/docs/react/getting-started) with the Mockingbird theme, like every other
Mockingbird UI ([`packages/ui`](../../../../ui/README.md)): the shared `AppShell`, `PageHeader`, `ThemeSwitch`,
`KeyValueList`, `EmptyState`, `ErrorState` and `StatusChip`, and HeroUI's `TagGroup` (samples), `TextArea`, `Button`,
`Alert` and `Table`. `src/app.css` compiles Tailwind CSS v4 with `@crvouga/mockingbird-ui/theme.css` through
`@tailwindcss/vite`; there is no hand-written CSS. Light, dark and system follow the visitor's choice (`mb:theme` in
`localStorage`, shared with the docs site).

## What it shows

- Synchronous `Database` / `Statement` API
- `prepare().result()` including empty result-set column names
- `SqliteError.category`
- `snapshot().encode()` / `Snapshot.decode(bytes).open()` persisted in `localStorage` (SQLM bytes, not a `.sqlite` file)
- Live `'now'` via `new Database({ now: () => new Date() })` — the library default is a fixed year-2000 clock
