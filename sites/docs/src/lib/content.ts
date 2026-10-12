/**
 * The copy the repo README and the docs site both show. `scripts/readme.ts` renders it into
 * README.md (CI fails when README.md is stale); the site renders it on the landing page. Inline
 * markdown only: backticks, **bold** and [links](url).
 */

import { CHECKOUT } from "./quick-start.ts"

const DOCS_PUBLIC = "sites/docs/public/"
const HOME = "https://github.com/crvouga/mockingbird"

/** Emoji SVG used for the docs favicon. */
export const MARK_REPO_PATH = `${DOCS_PUBLIC}identity/mockingbird.svg`

function docsPublicHref(repoFile: string): string {
  if (!repoFile.startsWith(DOCS_PUBLIC)) {
    throw new Error(`identity art must live under ${DOCS_PUBLIC}`)
  }
  return `/${repoFile.slice(DOCS_PUBLIC.length)}`
}

/** Path the docs site serves for `MARK_REPO_PATH`. */
export const MARK_HREF = docsPublicHref(MARK_REPO_PATH)

/** Shared identity for the site, GitHub and the READMEs published to npm. */
export const IDENTITY = {
  name: "Mockingbird",
  icon: "🐦‍⬛",
  tagline: "Local emulators. Real API contracts.",
  note: "Run the APIs and databases your application depends on, inside your own process. Deterministic state, vendor-compatible requests, and explicit coverage.",
  guide: `${HOME}/blob/main/docs/DESIGN.md`,
  home: HOME,
  /** Public docs site, including the service catalog at `/services`. */
  docs: "https://mockingbird.chrisvouga.dev",
}

/**
 * The card a link preview shows for every page (X, Slack, iMessage, LinkedIn). A raster, because
 * X does not render SVG; a screenshot of `/identity/social-card`, which draws it from this copy.
 */
export const SOCIAL_CARD = {
  href: docsPublicHref(`${DOCS_PUBLIC}identity/social-card.png`),
  width: 1200,
  height: 630,
  alt: `${IDENTITY.name}. ${IDENTITY.tagline}`,
}

/** Opening line of every published package README. `pack:check` requires it verbatim. */
export const EPIGRAPH = `> ${IDENTITY.tagline} Part of [${IDENTITY.name}](${IDENTITY.home}).`

/**
 * Single toggle for the "use at your own risk" banner shown at the top of the README and every
 * docs site page. Flip `enabled` to `false` once the project is stable enough to drop it.
 */
export const RISK_DISCLAIMER = {
  enabled: false,
  text: "**Use at your own risk.** Mockingbird is under active development — APIs, behavior and package names may change without notice.",
}

export const HEADLINE = {
  lead: "Local emulators.",
  accent: "Real API contracts.",
}

export const PITCH =
  "Mockingbird provides stateful emulators for third-party APIs and SQL databases. Use vendor-compatible request and response shapes, persistent in-memory state, and deterministic controls in Node, Bun, browsers, and Workers."

export const FEATURES = [
  {
    icon: "plug",
    title: "The vendor's real surface",
    body: "Each emulator answers the provider's own paths, headers, status codes and error envelopes through `fetch(Request) → Response`. Point the official SDK at it.",
  },
  {
    icon: "layers",
    title: "State that behaves",
    body: "Records persist in an in-memory SQL engine. Created customers can be listed, orders move through their lifecycle, webhooks fire, and reset or snapshot takes one call.",
  },
  {
    icon: "shield",
    title: "Checked against the real thing",
    body: "Random walks generated from each vendored OpenAPI contract run against two emulator instances in CI, and against the live sandbox when credentials exist.",
  },
  {
    icon: "zap",
    title: "No network, no waiting",
    body: "Everything runs in your test process. No sandbox keys, rate limits, shared test accounts or flaky round trips.",
  },
  {
    icon: "globe",
    title: "Runs anywhere JavaScript runs",
    body: "Every emulator is isomorphic: the same package runs in Node, Bun, browsers, and Workers. The playgrounds on this site run that package in your browser tab.",
  },
  {
    icon: "terminal",
    title: "One set of controls for every service",
    body: "Every HTTP emulator takes the same admin controls: isolation by key, reset, snapshot and restore, time travel, faults, latency and timeouts, all replayed from a seed. Set them at boot, through `/__admin`, or in a request header.",
  },
] as const

/** The site and generated README share an executable Data → API → Client checkout. */
export const QUICK_START = {
  package: "@crvouga/mockingbird-service-stripe",
  ...CHECKOUT,
}

/**
 * The admin controls, as the landing page and the README present them. The guide is
 * `docs/ADMIN_CONTROLS.md`, with a page per control in `docs/admin-controls/`; a test keeps the
 * routes and headers named here real.
 */
export const ADMIN_CONTROLS = {
  title: "Put any emulator in any state. Then do it again.",
  intro:
    "Every HTTP emulator answers the same admin controls. Isolate state by key, reset it, snapshot and restore it, move the clock, and inject faults, latency and timeouts. Each one is a field in a single document that means the same thing at boot, over `/__admin`, and in a request header, and all of it replays from a seed.",
  guide: "docs/ADMIN_CONTROLS.md",
  /** Where each control's own page lives: `<pages>/<page>.md`, served at `/docs/admin-controls/<page>`. */
  pages: "docs/admin-controls",
  controls: [
    {
      icon: "key",
      title: "Isolation by key",
      page: "NAMESPACES",
      body: "`x-mockingbird-namespace: worker-3` gives a request its own records, clock, random streams, faults, latency, journal and snapshots. Parallel workers share one process and never see each other.",
    },
    {
      icon: "reset",
      title: "Reset",
      page: "RESET",
      body: "`POST /__admin/reset` returns a namespace to its boot state: seed data, clock, faults and ids. A reset namespace cannot be told apart from a new one.",
    },
    {
      icon: "layers",
      title: "Snapshot and restore",
      page: "SNAPSHOT_AND_RESTORE",
      body: "`POST /__admin/snapshots` captures records, the clock, the random streams and the fault counters. Restore it, export it as JSON, commit it, or boot another process from it.",
    },
    {
      icon: "activity",
      title: "Time travel",
      page: "CLOCK",
      body: "Freeze the clock, set it, or advance it by `15m`. Expiries and retry windows arrive in milliseconds. Read state as it was at any checkpoint, or branch from one.",
    },
    {
      icon: "zap",
      title: "Faults",
      page: "FAULTS",
      body: "Answer `503`, drop the connection, or cut a response off mid-body. Match by operation, path or header; fire on the third request, every fifth, for the next five minutes, or at a seeded rate.",
    },
    {
      icon: "terminal",
      title: "Latency and timeouts",
      page: "LATENCY_AND_TIMEOUTS",
      body: "Give every response a delay with seeded jitter, or make one request hang. With `virtualTime` the wait is spent on the mock clock, so a thirty-second timeout costs no test time.",
    },
  ],
  carriers: [
    {
      label: "At boot",
      file: "stripe.test.ts",
      lang: "ts",
      code: `const stripe = createRuntime({
  seed: 7,
  adminControls: {
    clock: {
      now: "2030-01-01T00:00:00Z",
      frozen: true,
    },
    latency: "40ms",
    faults: [{ preset: "rate_limited" }],
  },
})`,
    },
    {
      label: "Over /__admin",
      file: "terminal",
      lang: "bash",
      code: `curl -X POST :8787/__admin/snapshots \\
  -d '{"name": "base"}'
curl -X POST :8787/__admin/clock \\
  -d '{"advance": "15m"}'
curl -X POST :8787/__admin/faults \\
  -d '{"status": 503, "count": 2}'
curl -X POST :8787/__admin/snapshots/base/restore`,
    },
    {
      label: "In a request header",
      file: "request",
      lang: "http",
      code: `POST /v1/charges
x-mockingbird-namespace: worker-3
x-mockingbird-time: 2030-01-01T00:00:00Z
x-mockingbird-fault: status=503; delay=2s`,
    },
  ],
  determinism:
    "The same seed and the same requests give the same bytes: ids, timestamps, which requests a `rate` fault hits, and the request journal. Reset and restore rewind the random streams with the state, so a test passes or fails the same way whether it runs first or last, alone or beside forty workers.",
} as const

export const CONTRACT = {
  intro:
    "Every HTTP service ships an in-process `fetch`, a Node server and a CLI, and all answer the same control surface, so a stack learns it once. Every internal path is under `/__admin` by default. Set `adminPrefix` or `serve --admin-prefix` (`MOCKINGBIRD_ADMIN_PREFIX`) to relocate the entire tree; `/health` and `/ns` aliases are removed.",
  serve: `npx mockingbird-junction serve --port 8787                # one service
npx mockingbird-junction serve --config mockingbird.json  # every service in the config`,
  rows: [
    [
      "`createRuntime()` · `createServer()` (`./server`) · `mockingbird-<service> serve`",
      "The emulator as one runtime-neutral `fetch`, or a listening server from Node or the CLI",
    ],
    ["`GET /__admin/health`", "Unauthenticated readiness probe, outside the vendor's auth gate"],
    [
      "`/__admin/*` (`x-mockingbird-admin-key` optional)",
      "The [admin controls](docs/ADMIN_CONTROLS.md): reset, snapshot and restore, clock, faults, latency, a request journal, metrics with unmatched-route counts, plus service-specific routes. `GET /__admin` lists every route and header",
    ],
    [
      "`GET /__admin/state`",
      "The collections in the selected namespace: declared shape, live `Collection` fields, and stored rows. Create, replace, merge, and delete records through the same paths on every emulator",
    ],
    [
      "`GET /__admin/ui`",
      "The shared admin UI. An emulator can add panels or replace the document; the shell still reads the same state API. Its header fetches that service's logo, website, and docs from the docs site when the page opens",
    ],
    [
      "`x-mockingbird-namespace`",
      "Per-request isolation: parallel workers share one process without sharing data, clocks, faults or ids",
    ],
    [
      "`adminControls` · `--admin-controls` · `x-mockingbird-*`",
      "The same control document at boot, on the command line, and in request headers",
    ],
    [
      "`--seed`, a frozen clock, `virtualTime`",
      "Seeded randomness, a clock that moves only when told to, and waits that cost no time, so a run replays byte for byte",
    ],
    [
      "`--log json`",
      "One structured line per request: operation id, status, duration, namespace, fault",
    ],
  ] as [string, string][],
  config: `{
  "services": {
    "junction": { "port": 8787, "options": { "corpus": "./test/junction-corpus.json" } },
    "stripe": { "port": 0 },
    "postgres": { "protocol": "postgres", "port": 0 },
    "redis": { "protocol": "redis", "port": 0 }
  }
}`,
  configNote:
    "`mockingbird.json` names services by their package suffix. HTTP services, PostgreSQL and Redis share a supervisor with ephemeral ports, readiness discovery and namespace controls. Use `--ready-file` or `--ready-json` to discover endpoints; see [Fleets](docs/FLEETS.md). SQLite remains an in-process engine.",
}

export const AGENTS =
  "Every npm package ships an agent index at `node_modules/<package>/DISCOVERY.md`. It points to the local behavior guide, exact capability matrix, machine-readable contract or compatibility evidence, public types, parity oracle, runtime introspection, and issue-reporting contract. [`llms.txt`](llms.txt) indexes those files with the parity each service declares, and the docs site publishes the same source material as markdown and JSON. When an emulator diverges from the real API, lacks a feature you call, or the vendor you need is not in the catalog, file an issue: [the filing guide](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md) gives the title format, templates and the behavior spec for feature and service requests."

/**
 * The pages of a guide that has them: `docs/ADMIN_CONTROLS.md` is the hub, and each control is
 * a file in `docs/admin-controls/`. Listed in reading order: the controls, then the ways to
 * apply them, then what to look at afterwards.
 */
export const GUIDE_CHILDREN = {
  ADMIN_CONTROLS: [
    "NAMESPACES",
    "RESET",
    "SNAPSHOT_AND_RESTORE",
    "CLOCK",
    "CHECKPOINTS_AND_BRANCHES",
    "FAULTS",
    "LATENCY_AND_TIMEOUTS",
    "SEED_AND_DETERMINISM",
    "CONTROL_DOCUMENT",
    "BOOT",
    "REQUEST_HEADERS",
    "JOURNAL_AND_STATE",
    "REFERENCE",
  ],
} as const satisfies Record<string, readonly string[]>

/**
 * The admin-control pages, grouped the way a reader looks for one. `call` is the interface
 * line shown beside the page; it is a string that page already defines.
 */
export const CONTROL_GROUPS = [
  {
    title: "State",
    controls: [
      { page: "NAMESPACES", call: "x-mockingbird-namespace: <key>" },
      { page: "RESET", call: "POST /__admin/reset" },
      { page: "SNAPSHOT_AND_RESTORE", call: "POST /__admin/snapshots/<id>/restore" },
    ],
  },
  {
    title: "Time",
    controls: [
      { page: "CLOCK", call: "POST /__admin/clock" },
      { page: "CHECKPOINTS_AND_BRANCHES", call: "x-mockingbird-at: <checkpoint>" },
    ],
  },
  {
    title: "Failure",
    controls: [
      { page: "FAULTS", call: "POST /__admin/faults" },
      { page: "LATENCY_AND_TIMEOUTS", call: "PUT /__admin/latency" },
    ],
  },
  {
    title: "Set them",
    controls: [
      { page: "SEED_AND_DETERMINISM", call: "--seed <seed>" },
      { page: "CONTROL_DOCUMENT", call: "PUT /__admin/controls" },
      { page: "BOOT", call: "adminControls" },
      { page: "REQUEST_HEADERS", call: "x-mockingbird-fault" },
    ],
  },
  {
    title: "Inspect",
    controls: [
      { page: "JOURNAL_AND_STATE", call: "GET /__admin/ui" },
      { page: "REFERENCE", call: "GET /__admin" },
    ],
  },
] as const

/** Guides in `docs/`, in the order the README and the site list them. Others follow by name. */
export const GUIDE_ORDER = [
  "GETTING_STARTED",
  "ADMIN_CONTROLS",
  "WHY",
  "TESTING",
  "AUTHORING_A_SERVICE",
  "DEVELOPMENT",
  "DESIGN",
  "REPORTING_ISSUES",
  "RELEASING",
  "SECRETS",
]
