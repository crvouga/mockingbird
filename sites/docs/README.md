# Mockingbird Docs

Agent-friendly, drift-free documentation site for Mockingbird mock services.

## Architecture

This is a **static Astro site** with docs **generated from code**, ensuring zero drift between documentation and reality.

### Generation Pipeline

```
packages/service/*/package.json
  └─> scripts/generate-docs.ts
      ├─> catalog.json (service metadata)
      └─> compatibility.json (feature matrix)
        └─> Astro static build
            └─> 44 static HTML pages
```

**Key principle:** Docs are derived from code, not maintained manually.

## Colocation Strategy

Every service lives in `packages/service/<name>/` with:

- `package.json` — service metadata (name, description, runtime, keywords)
- `README.md` — full integration guide (sourced by agents)
- `SUPPORT.md` — vendor-specific quirks

The docs site **reads** this metadata; it never creates sources of truth.

## Agent-Friendly Format

### Catalog (`sites/docs/src/data/catalog.json`)

Each service entry includes:

```json
{
  "name": "stripe",
  "packageName": "@crvouga/mockingbird-service-stripe",
  "description": "Stateful mock of Stripe API...",
  "provider": "stripe",
  "runtime": "portable",
  "keywords": ["stripe", "payments", "webhooks"],
  "npmUrl": "https://www.npmjs.com/package/@crvouga/mockingbird-service-stripe",
  "readmeUrl": "https://github.com/crvouga/mockingbird/blob/main/packages/service/stripe/README.md",
  "surfaces": ["Fetch API", "Node Server", "CLI"],
  "entries": {
    "default": "portable",
    "server": "node"
  }
}
```

**Why this format:**
- Flat, unambiguous structure (no nesting)
- Every field is self-contained, no references
- Machine-parseable by agents (JSON)
- Unambiguous download/import instructions

### Compatibility Matrix (`sites/docs/src/data/compatibility.json`)

Feature support at a glance:

```json
{
  "stripe": {
    "Fetch API": true,
    "Node Server": true,
    "CLI": true,
    "GraphQL": false,
    "WebSocket": false,
    "HTTP/2": false
  }
}
```

## Building

```bash
# Generate catalog and compatibility matrix from service metadata
bun run docs:generate

# Build the static site
bun run docs:build

# Develop locally
bun run docs:dev
```

The docs site is **part of CI checks**:

```bash
bun run check  # includes docs:generate verification
```

## Pages

- `/` — Home with rationale (why Mockingbird exists)
- `/services` — Catalog of all 41 services
- `/service/<name>` — Per-service page with entry points, surfaces, keywords
- `/compatibility` — Feature matrix

## How Agents Use This

1. **Discovery:** Agent calls `GET /` or reads `catalog.json` to find available services
2. **Service selection:** Agent queries compatibility matrix to pick the right surface (Fetch vs. Server vs. CLI)
3. **Integration:** Agent reads `entries` to know import paths, then follows the README link for full API docs
4. **Validation:** Agent checks `surfaces` and `runtime` before generating code

Example agent flow:

```
Agent: "I need to mock Stripe"
  → Reads catalog.json
  → Finds @crvouga/mockingbird-service-stripe
  → Checks surfaces: ["Fetch API", "Node Server", "CLI"]
  → Reads entry points: default (portable), server (node)
  → Fetches README from readmeUrl
  → Generates code: import { StripeAPI } from "@crvouga/mockingbird-service-stripe"
```

## No Drift Guarantee

Documentation drift (docs ≠ reality) is **impossible** here because:

1. **Source of truth is code.** Service metadata lives in `package.json`, not docs.
2. **Generation is deterministic.** `scripts/generate-docs.ts` reads code, writes JSON.
3. **No manual sync.** Docs site pulls from generated JSON; nothing is hand-edited.
4. **Static build.** Every deploy runs generation → build; stale data is rejected.

If a service's package.json changes, the catalog changes. No manual update needed.

## Adding a Service

1. Create `packages/service/<name>/` with `package.json` and README
2. Run `bun run docs:generate` — catalog auto-updates
3. The service appears on `/services`, gets a detail page at `/service/<name>`, and shows up in the compatibility matrix

No docs changes needed.

## Tech Stack

- **Astro 4.x** — static site generation
- **TypeScript** — type-safe data loading
- **Pure CSS** — no frameworks, minimal surface

No build complexity. Pages are HTML + inline CSS.
