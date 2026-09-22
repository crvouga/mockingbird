# Interactive Documentation: Examples & WIP Status

The Mockingbird documentation site now includes **runnable, isomorphic examples** for every service, plus clear status indicators for work-in-progress implementations.

## What's New

### 1. Live Examples on Every Service Page

Each service detail page (`/service/<name>`) now displays:

- **Code block** with the first TypeScript/JavaScript example from the service's README
- **Copy button** — copy code to clipboard
- **RunKit button** — run the code immediately in an online sandbox
- **Install button** — jump to installation instructions

Example on `/service/stripe`:

```typescript
import { StripeAPI } from "@crvouga/mockingbird-service-stripe";

const stripe = new StripeAPI();
const res = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: { authorization: "Bearer sk_test_mockingbird" },
    body: "description=ACME Inc",
  })
);
```

→ Click "Copy" to copy it
→ Click "Try in RunKit" to execute it instantly (in browser)
→ Click "Install" to see npm installation

### 2. Service Status Badges

Three status levels:

| Badge | Meaning | Appears On |
| --- | --- | --- |
| **Implemented** (green) | Complete, fully tested | All 41 current services |
| **Experimental** (orange) | Partial implementation or unstable API | (none currently) |
| **Work in Progress** (red) | Not yet complete, breaking changes expected | Any service with "WIP" marker |

Status badges appear:
- On every service card in `/services` grid
- In the title of each service detail page
- With an alert banner if WIP (explains what's missing)

### 3. Isomorphic Examples

All examples run in:
- **Node.js** — `node example.mjs`
- **Bun** — `bun example.ts`
- **Browsers** — RunKit sandbox or bundled with your frontend
- **Workers** — Cloudflare Workers, etc. (portable runtime)

No examples are tied to a specific runtime. They all use `fetch(Request) → Response`.

## How Examples Are Generated

Docs examples **never drift** because they're auto-extracted:

```
README.md (first code block)
  ↓
scripts/generate-docs.ts (parses and extracts)
  ↓
catalog.json (stores as .example)
  ↓
Astro site (renders with copy/run buttons)
```

**Update a README example** → next `bun run docs:generate` → site updates automatically. No sync step.

## How Status Detection Works

Services are marked as WIP if:

1. README contains **"work in progress"**, **"wip"**, or **"not yet implemented"** (case-insensitive)
2. `package.json` has `"mockingbird": { "status": "wip" }`
3. README contains **"TODO"** and the service is not Stripe (blanket TODOs)

**To mark a service as WIP:**

```markdown
# My Service

**Status:** Work in progress

This service is not yet complete. The following are missing:
- [ ] Webhook signing
- [ ] Rate limiting
- [ ] Error responses
```

Or in `package.json`:

```json
{
  "mockingbird": {
    "status": "wip",
    "layer": "service"
  }
}
```

Next `bun run docs:generate` → service marked WIP automatically.

## Example Extraction Rules

The system looks for TypeScript or JavaScript code blocks and extracts the **first one**:

```markdown
## Usage

```typescript
import { MyAPI } from "@crvouga/mockingbird-service-myservice";

const api = new MyAPI();
const res = await api.fetch(new Request(...));
```
```

This becomes the example shown on the service page.

**Best practices:**
- Put a self-contained, runnable example first in the README
- Imports should use the npm package name: `@crvouga/mockingbird-service-*`
- It should work in both Node and browsers (isomorphic)
- Keep it concise (10-20 lines) — long examples get truncated in UI

## For Service Authors

When adding a new service or updating one:

### Add an Example

Include a TypeScript code block in your README's `## Usage` section:

```markdown
## Usage

```typescript
import { MyAPI } from "@crvouga/mockingbird-service-myservice";

const api = new MyAPI();
const res = await api.fetch(
  new Request("https://api.myservice.com/v1/resource", {
    method: "POST",
    headers: { authorization: "Bearer sk_test" },
    body: JSON.stringify({ name: "example" }),
  })
);
console.log(await res.json());
```
```

### Mark as WIP

If your service isn't ready:

```markdown
# My Service

**Status:** Work in progress

This service is still under development. Not yet released.

## Roadmap

- [ ] Basic CRUD operations
- [ ] Webhook support
- [ ] Event subscriptions
```

Then run `bun run docs:generate` and the service will be marked WIP with an alert banner.

### View the Generated Page

After running `bun run docs:generate && bun run --cwd sites/docs dev`, visit:
- `http://localhost:3000/services` — see your service in the grid with example and status
- `http://localhost:3000/service/[name]` — see your service detail page with runnable example

## For Agents (Claude, etc.)

When reading service documentation:

1. **Check status first** — if WIP, the service is incomplete
2. **Read the example** — it shows the canonical import and usage pattern
3. **Run it via RunKit** — verify behavior before integrating
4. **Follow the README** — example is condensed; README has full API

Agents can use `catalog.json` to see `example.code` directly:

```json
{
  "services": [
    {
      "name": "stripe",
      "example": {
        "code": "import { StripeAPI } from \"@crvouga/mockingbird-service-stripe\";...",
        "description": "Live example for stripe"
      }
    }
  ]
}
```

## RunKit Integration

The "Try in RunKit" button links to:

```
https://runkit.com/?source=[URL_ENCODED_CODE]
```

RunKit automatically:
- Installs npm packages (finds `npm install` comments in code)
- Runs the code
- Shows output in the console
- Lets you modify and re-run

**To make your example RunKit-compatible:**

```typescript
// Install @crvouga/mockingbird-service-stripe
import { StripeAPI } from "@crvouga/mockingbird-service-stripe";

// ... example code ...
```

The "Install" comment tells RunKit to fetch the package. Our examples don't need this because they're short demos.

## File Structure

```
sites/docs/src/
├── components/
│   ├── ServiceExample.astro     ← displays code + copy/run buttons
│   └── StatusBadge.astro        ← Implemented | Experimental | WIP
├── pages/
│   ├── index.astro              ← home
│   ├── services.astro           ← service grid (with status badges)
│   ├── service/[name].astro     ← detail (with example)
│   └── compatibility.astro      ← feature matrix
└── data/
    └── catalog.json             ← generated (includes examples + status)
```

## Future Enhancements

Possible additions (all auto-generated):

- **Multi-language examples** — TypeScript, JavaScript, Python, Go
- **Error handling examples** — how to catch and handle API errors
- **Webhook examples** — registering and handling webhooks
- **State mutations** — showing before/after state changes
- **Benchmarks** — performance metrics per service
- **Coverage metrics** — which API operations are mocked

All would be extracted from code or test metadata, never hand-written.
