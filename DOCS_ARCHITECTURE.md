# Mockingbird Documentation Architecture

## Overview

Mockingbird's documentation is **generated from code, not written by hand**. This ensures perfect parity between documentation and actual service behavior.

### The No-Drift Guarantee

Documentation drift (outdated docs) is **impossible** because:

1. **Source of truth is code** — service metadata lives in `package.json` files
2. **Generation is deterministic** — `scripts/generate-docs.ts` reads code, writes JSON
3. **Static build chain** — every deployment runs: read → generate → build → deploy
4. **No manual sync** — nothing is hand-edited

If a service's package.json changes, the docs change. No manual step required.

## Architecture

```
packages/service/*/package.json
  ↓ (metadata: name, description, runtime, keywords, entries)
scripts/generate-docs.ts
  ├→ sites/docs/src/data/catalog.json
  ├→ sites/docs/src/data/compatibility.json
  └→ sites/docs/src/data/agent-index.md
       ↓
  sites/docs/ (Astro static site)
       ├→ /index.html (home + rationale)
       ├→ /services/index.html (service listing)
       ├→ /service/[name]/index.html (41 service detail pages)
       └→ /compatibility/index.html (feature matrix)
```

## Generated Artifacts

### 1. `catalog.json` (47 KB)

Machine-readable catalog of all 41 services:

```json
{
  "generated": "2025-09-21T16:57:00.000Z",
  "version": "1.0.0",
  "rationale": "Why Mockingbird exists...",
  "services": [
    {
      "name": "stripe",
      "packageName": "@crvouga/mockingbird-service-stripe",
      "description": "Stateful mock of Stripe API...",
      "runtime": "portable",
      "surfaces": ["Fetch API", "Node Server", "CLI"],
      "entries": {
        "default": "portable",
        "server": "node"
      },
      "npmUrl": "...",
      "readmeUrl": "...",
      "supportUrl": "..."
    }
    // ... 40 more services
  ]
}
```

**For agents:** This is the single source of truth for service discovery and integration.

### 2. `compatibility.json` (7 KB)

Feature matrix: which services support which surfaces.

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
  // ... 40 more services
}
```

### 3. `agent-index.md` (auto-generated list)

Human & agent-readable index of all services with:
- Package name (npm import path)
- Surfaces (Fetch API, server, CLI, etc.)
- Runtime target (portable, node, bun)
- Entry points with runtime info
- README link
- Integration verb (what the service does)

## For AI Agents

When Claude or another agent needs to integrate a Mockingbird service:

1. **Read** `catalog.json` to discover services
2. **Check** `compatibility.json` to see if the needed surface is available
3. **Get entry points** from catalog to know import paths
4. **Follow README link** for full API documentation
5. **Implement** the integration

Example:

```typescript
// Agent reads catalog.json
const stripe = catalog.services.find(s => s.name === "stripe");

// Agent checks surfaces
console.log(stripe.surfaces); // ["Fetch API", "Node Server", "CLI"]

// Agent gets import path
console.log(stripe.entries); // { default: "portable", server: "node" }

// Agent follows README
console.log(stripe.readmeUrl); // https://github.com/crvouga/mockingbird/blob/main/...

// Agent generates code
const code = `import { StripeAPI } from "${stripe.packageName}";`;
```

## For Humans

The static site at `sites/docs/dist/` is browseable HTML:

- **/** — home with rationale (why Mockingbird)
- **/services** — all 41 services in a grid
- **/service/[name]** — per-service page with metadata, entry points, keywords
- **/compatibility** — feature matrix showing surface support

## Usage

### Generate docs (CI step)

```bash
bun run docs:generate
```

Reads `packages/service/*/package.json`, writes:
- `sites/docs/src/data/catalog.json`
- `sites/docs/src/data/compatibility.json`
- `sites/docs/src/data/agent-index.md`

### Build static site

```bash
bun run docs:build
```

Runs `docs:generate` then builds Astro → `sites/docs/dist/`

### Develop locally

```bash
bun run docs:dev
```

Astro dev server at http://localhost:3000

### Part of CI

The docs are generated as part of the full check:

```bash
bun run check  # includes docs:generate
```

## Colocation Strategy

Every service owns its documentation:

```
packages/service/stripe/
├── package.json       ← metadata (name, description, runtime, keywords, entries)
├── README.md          ← full integration guide (sourced by agents)
├── SUPPORT.md         ← vendor-specific quirks
└── src/
```

The docs site **reads** this; it never creates truth. Result:

- No manual README → JSON sync
- No forgotten updates
- Service changes → docs auto-update (once generation runs)

## Adding a Service

1. Create `packages/service/<name>/` with package.json and README
2. Ensure package.json has:
   ```json
   {
     "mockingbird": {
       "runtime": "portable",      // portable | node | bun
       "entries": {
         "default": "portable",    // entry point → runtime
         "server": "node"
       },
       "layer": "service"
     }
   }
   ```
3. Run `bun run docs:generate`
4. Service appears in catalog, gets a detail page, shows in compatibility matrix

**No docs changes needed.** The site updates automatically.

## Tech Stack

- **Astro 4.x** — static site generation (zero JS)
- **TypeScript** — type-safe data loading
- **CSS** — inline, minimal (no framework)

Each page is a static HTML file with inline CSS. No JS runtime, no build complexity.

## Rationale

Why this approach?

1. **Perfect parity** — docs ≠ reality is impossible (docs are generated from reality)
2. **Agent-friendly** — structured JSON makes it easy for AI to discover and integrate
3. **No manual overhead** — add a service, it's documented (no separate PR for docs)
4. **Static & fast** — 44 pages, pure HTML, works everywhere
5. **Colocation** — metadata lives with code, not in a separate wiki

The cost is structure: every service must follow the same pattern (package.json + README). The benefit is that agents and humans always see consistent, up-to-date information.

## Future Enhancements

Possible additions (all derivable from code):

- OpenAPI contract summary (parsed from service specs)
- Example requests/responses (extracted from test corpus)
- Event/webhook listings (from service implementation)
- Performance benchmarks (from test suites)
- Coverage metrics (from test reports)

All would be auto-generated and committed to avoid drift.
