/**
 * The copy the repo README and the docs site both show. `scripts/readme.ts` renders it into
 * README.md (CI fails when README.md is stale); the site renders it on the landing page. Inline
 * markdown only: backticks, **bold** and [links](url).
 */

export const MASCOT = "🐦‍⬛"

export const HEADLINE = {
  lead: "Mock the APIs you depend on,",
  accent: "with the behavior they really have.",
}

export const PITCH =
  "Mockingbird is a catalog of stateful test doubles for third-party HTTP APIs and SQL databases. Each one speaks the vendor's real surface, keeps state, and runs in-process."

export const FEATURES = [
  {
    icon: "plug",
    title: "The vendor's real surface",
    body: "Each mock answers the provider's own paths, headers, status codes and error envelopes through `fetch(Request) → Response`. Point the official SDK at it.",
  },
  {
    icon: "layers",
    title: "State that behaves",
    body: "Records persist in an in-memory SQL engine. Created customers can be listed, orders move through their lifecycle, webhooks fire, and reset or snapshot takes one call.",
  },
  {
    icon: "shield",
    title: "Checked against the real thing",
    body: "Random walks generated from each vendored OpenAPI contract run against two mock instances in CI, and against the live sandbox when credentials exist.",
  },
  {
    icon: "zap",
    title: "No network, no waiting",
    body: "Everything runs in your test process. No sandbox keys, rate limits, shared test accounts or flaky round trips.",
  },
  {
    icon: "globe",
    title: "Runs anywhere JavaScript runs",
    body: "Most mocks are portable: Node, Bun, browsers and Workers. The docs site's playgrounds run the published packages in your browser tab.",
  },
  {
    icon: "terminal",
    title: "One contract for every service",
    body: "Every HTTP mock shares `/health`, `/__admin` reset, snapshots, clock control, fault injection, request journals and per-namespace isolation.",
  },
] as const

/** Executed against the real package during the docs build: it must log a 2xx status first. */
export const QUICK_START = {
  package: "@crvouga/mockingbird-service-stripe",
  file: "stripe.test.ts",
  code: `import { createRuntime } from "@crvouga/mockingbird-service-stripe"

const stripe = createRuntime()

const res = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    method: "POST",
    headers: {
      authorization: "Bearer sk_test_mockingbird",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "email=ada@example.com",
  }),
)

console.log(res.status) // 200
const customer = await res.json() // { id: "cus_…", object: "customer", email: "ada@example.com", … }

// State persists: the customer is there when you list customers.
const list = await stripe.fetch(
  new Request("https://api.stripe.com/v1/customers", {
    headers: { authorization: "Bearer sk_test_mockingbird" },
  }),
)
console.log((await list.json()).data[0].id === customer.id) // true`,
}

export const CONTRACT = {
  intro:
    "Every HTTP service ships an in-process `fetch`, a Node server and a CLI, and all answer the same control surface, so a stack learns it once.",
  serve: `npx mockingbird-junction serve --port 8787                # one service
npx mockingbird-junction serve --config mockingbird.json  # every service in the config`,
  rows: [
    [
      "`createRuntime()` · `createServer()` (`./server`) · `mockingbird-<service> serve`",
      "The mock as one runtime-neutral `fetch`, or a listening server from Node or the CLI",
    ],
    ["`GET /health`", "Unauthenticated readiness probe, outside the vendor's auth gate"],
    [
      "`/__admin/*` (`x-mockingbird-admin-key` optional)",
      "Reset, snapshot and restore, clock control, fault injection, a request journal, metrics with unmatched-route counts, plus service-specific routes",
    ],
    [
      "`x-mockingbird-namespace`",
      "Per-request isolation: parallel workers share one process without sharing data",
    ],
    [
      "`--seed`, clock control",
      "Seeded randomness and an injectable clock, so a run replays exactly",
    ],
    [
      "`--log json`",
      "One structured line per request: operation id, status, duration, namespace, fault",
    ],
  ] as [string, string][],
  config: `{
  "services": {
    "junction": { "port": 8787, "options": { "corpus": "./test/junction-corpus.json" } },
    "stripe": { "port": 12111 }
  }
}`,
  configNote:
    "`mockingbird.json` names services by their package suffix and takes each one's `serve` flags; any installed service's CLI can serve all of them. Medplum runs a real Medplum server and the database engines are not HTTP APIs, so they are outside this contract.",
}

export const AGENTS =
  "Every service README doubles as its integration guide and ships inside the npm tarball (`node_modules/<package>/README.md`). [`llms.txt`](llms.txt) indexes them by tier, and the docs site publishes the same content as markdown and JSON, rebuilt from the packages on every build."

/** Guides in `docs/`, in the order the README and the site list them. Others follow by name. */
export const GUIDE_ORDER = [
  "WHY",
  "TESTING",
  "AUTHORING_A_SERVICE",
  "CATALOG_COVERAGE",
  "DEVELOPMENT",
  "RELEASING",
  "SECRETS",
]
