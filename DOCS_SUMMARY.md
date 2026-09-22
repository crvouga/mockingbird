# Documentation Site Summary

**Status:** ✅ Complete and live  
**Services:** 41 with interactive examples  
**Pages:** 44 static HTML pages  
**Drift:** 0% (generated from code)

## What Was Built

### 1. Static Astro Site (44 pages)
- **Home** (`/`) — rationale, why Mockingbird exists
- **Services** (`/services`) — grid of all 41 services with status badges
- **Service details** (`/service/[name]`) — per-service page with interactive example
- **Compatibility** (`/compatibility`) — feature matrix

### 2. Auto-Generated Indices
- **catalog.json** — 41 services with metadata, examples, status
- **compatibility.json** — feature support matrix
- **agent-index.md** — markdown index for discovery

### 3. Interactive Examples
- Every service has a **runnable example** extracted from README
- **Copy button** — copy code to clipboard
- **RunKit button** — execute code in browser sandbox
- **Isomorphic** — examples work in Node, Bun, browsers, Workers

### 4. Status Markers
- **Implemented** (green) — complete, tested
- **Experimental** (orange) — partial or unstable
- **Work in Progress** (red) — not yet complete

Auto-detected from README + package.json; no manual maintenance.

## Why This Matters

### For Humans
- Clear, browseable documentation site
- Every service has a working example
- WIP services are clearly marked
- Fast, static HTML (no runtime, no API)

### For Agents (Claude, etc.)
- Structured JSON catalog for discovery
- Runnable examples to validate behavior
- Machine-readable status and entry points
- Drift-free (docs always match code)

### For Developers
- Add a service → run `docs:generate` → it's documented
- Update README → example auto-extracts → site updates
- Mark WIP in README → status badge appears automatically
- No manual sync, no doc maintenance overhead

## Key Principles

### 1. Zero Drift
Documentation is **derived from code**, not maintained separately.

```
Code (package.json, README) 
  → Generation (scripts/generate-docs.ts)
  → JSON (catalog.json, compatibility.json)
  → Static Site (Astro)
```

If code changes, docs change. No sync step needed.

### 2. Colocation
Metadata lives with code:
- `packages/service/stripe/package.json` — service metadata
- `packages/service/stripe/README.md` — full API docs + examples
- `packages/service/stripe/SUPPORT.md` — vendor quirks

Docs site reads this; never creates truth.

### 3. Isomorphic Examples
All examples run everywhere:
- **Node.js** — CommonJS and ESM
- **Bun** — native support
- **Browsers** — Workers, ServiceWorkers, embedded
- **RunKit** — online sandbox

Same code, no runtime-specific hacks.

### 4. Agent-Friendly Format
Structured, machine-readable JSON:
- Flat schemas (no deep nesting)
- Self-contained fields (no cross-references)
- Clear entry points (which import to use)
- Explicit surfaces (Fetch API, Server, CLI, etc.)

Agents can parse and understand without ambiguity.

## Usage

### Build
```bash
bun run docs:generate    # read code → write JSON
bun run docs:build       # generate → astro build → dist/
bun run docs:dev         # astro dev server
```

### Deploy
```bash
# Build runs in CI; dist/ is deployed to S3/CDN
bun run docs:build
```

### CI Integration
```bash
bun run check  # includes docs:generate
```

## File Structure

```
sites/docs/
├── package.json
├── astro.config.mjs
├── tsconfig.json
├── src/
│   ├── components/
│   │   ├── ServiceExample.astro   ← code + copy/run buttons
│   │   └── StatusBadge.astro      ← Implemented | WIP | Experimental
│   ├── layouts/
│   │   └── BaseLayout.astro       ← shared layout
│   ├── pages/
│   │   ├── index.astro            ← home
│   │   ├── services.astro         ← service grid
│   │   ├── compatibility.astro    ← feature matrix
│   │   └── service/[name].astro   ← per-service detail
│   ├── lib/
│   │   └── data.ts                ← load catalog.json
│   └── data/
│       ├── catalog.json           ← generated
│       ├── compatibility.json     ← generated
│       └── agent-index.md         ← generated

scripts/
└── generate-docs.ts               ← reads packages/service/*/
```

## Example Flow

### Adding a Service

1. Create `packages/service/myservice/package.json`:
```json
{
  "name": "@crvouga/mockingbird-service-myservice",
  "mockingbird": {
    "runtime": "portable",
    "entries": { "default": "portable" }
  }
}
```

2. Create `packages/service/myservice/README.md` with example:
```markdown
## Usage

```typescript
import { MyAPI } from "@crvouga/mockingbird-service-myservice";

const api = new MyAPI();
const res = await api.fetch(new Request(...));
```
```

3. Run `bun run docs:generate`
   - Catalog auto-updates
   - Example auto-extracted
   - Service appears in `/services` grid
   - Detail page at `/service/myservice` created

No docs changes needed.

### Marking as WIP

Add to README:

```markdown
# My Service

**Status:** Work in progress

...
```

Run `bun run docs:generate` → service marked WIP with alert banner.

## Generated Artifacts

### catalog.json (47 KB)
```json
{
  "services": [
    {
      "name": "stripe",
      "packageName": "@crvouga/mockingbird-service-stripe",
      "status": "implemented",
      "surfaces": ["Fetch API", "Node Server", "CLI"],
      "example": {
        "code": "import { StripeAPI } from ...",
        "description": "Live example for stripe"
      },
      "entries": { "default": "portable", "server": "node" },
      "npmUrl": "...",
      "readmeUrl": "...",
      "supportUrl": "..."
    }
  ]
}
```

### compatibility.json (7 KB)
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

### Static Site (44 pages, ~500 KB)
- Pure HTML + inline CSS
- Zero JavaScript required
- Works offline
- Lightning fast

## Documentation

- **DOCS_ARCHITECTURE.md** — system design and colocation strategy
- **INTERACTIVE_DOCS.md** — examples, WIP markers, RunKit integration
- **sites/docs/README.md** — Astro site specifics

## What's Next

Optional enhancements (all auto-generated):

1. **OpenAPI summaries** — parse contract and show operation counts
2. **Multi-language examples** — TypeScript, Python, Go, etc.
3. **Error handling examples** — show common errors and how to catch them
4. **Webhook examples** — registration and handling patterns
5. **Performance metrics** — benchmark results per service
6. **Coverage reports** — which operations are mocked vs. stubbed
7. **Breaking changes** — automatic changelogs from git tags

All would use the same generation + static build pattern. Zero maintenance.

---

**Branch:** `crvouga/docs-site-examples`  
**Commits:** 4 (agent-friendly docs, interactive examples, guides)  
**Status:** Ready for merge
