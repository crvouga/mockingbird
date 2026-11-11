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

/**
 * The recommended way to run Mockingbird, and the quick start every doc leads with: one fleet.
 * `docs/FLEETS.md` is the guide. The same five steps open `docs/GETTING_STARTED.md`, `llms.txt`,
 * the fleet package README and each service's `DISCOVERY.md`; keep them in step with this.
 */
export const FLEET = {
  title: "One config. Every emulator on its own port. One dashboard.",
  intro:
    "A fleet is the recommended way to run Mockingbird. One `mockingbird.json` names the emulators your app needs, and one command starts each of them on its own isolated port, with one controller to reset, snapshot and namespace them together and one dashboard for every emulator's admin UI and every notification your app sent.",
  guide: "docs/FLEETS.md",
  package: "@crvouga/mockingbird-fleet",
  /** The fleet tool, then one package per emulator the config names. */
  packages: [
    "@crvouga/mockingbird-fleet",
    "@crvouga/mockingbird-service-stripe",
    "@crvouga/mockingbird-service-twilio",
    "@crvouga/mockingbird-service-resend",
  ],
  configFile: "mockingbird.json",
  config: `{
  "control": { "port": 9000 },
  "services": {
    "stripe": { "port": 9001 },
    "twilio": { "port": 9002 },
    "resend": { "port": 9003 }
  }
}`,
  serve: `npx mockingbird-fleet serve --config mockingbird.json --dashboard --ready-file ready.json
# fleet ready: http://127.0.0.1:9000/__admin/fleet
# dashboard:   http://127.0.0.1:8790`,
  control: `# Every emulator back to its boot state, in one call
curl -X POST http://127.0.0.1:9000/__admin/fleet/namespaces/default/reset`,
  steps: [
    {
      title: "Install",
      body: "The fleet tool and one package per emulator, as development dependencies.",
    },
    {
      title: "Declare",
      body: '`mockingbird.json` names each emulator by its package suffix and gives it a port. `"port": 0` takes a free one.',
    },
    {
      title: "Start",
      body: "One process starts every emulator, the controller, and with `--dashboard` the dashboard. Ctrl+C stops them all.",
    },
    {
      title: "Point your app at it",
      body: "Set each SDK's base URL to that emulator's `services.<name>.url` in `ready.json` (here `http://127.0.0.1:9001/` for Stripe). Each package README shows the SDK option to set.",
    },
    {
      title: "Open the dashboard",
      body: "`http://127.0.0.1:8790` has an **Emulators** tab, with every emulator's state, clock, faults and request journal, and a **Notifications** tab, with every SMS, WhatsApp message, email, push and chat message your app sent, on a phone, an inbox and a chat window.",
    },
  ],
  benefits: [
    {
      icon: "layers",
      title: "One config, one process",
      body: "`mockingbird.json` is the whole stack: HTTP emulators, PostgreSQL and Redis. One command starts it and Ctrl+C stops it; a failed boot names the service and closes the rest.",
    },
    {
      icon: "plug",
      title: "A port per emulator",
      body: 'Every emulator listens on its own port. Give it a fixed one, or `"port": 0` for a free one so two fleets never collide; `ready.json` lists the URLs that were actually bound.',
    },
    {
      icon: "terminal",
      title: "One controller",
      body: "`/__admin/fleet` resets, snapshots and restores a namespace across every emulator in one call, moves their clocks together, and waits until they are idle.",
    },
    {
      icon: "grid",
      title: "One dashboard",
      body: "`--dashboard` serves every emulator's admin UI from one origin, under an **Emulators** tab. Nothing else to install.",
    },
    {
      icon: "bell",
      title: "Notifications, with the same flag",
      body: "The **Notifications** tab shows what Twilio, Resend, FCM, SES, SNS, Customer.io, Mailosaur and Slack accepted, and tests read the same messages from the dashboard's JSON API.",
    },
  ],
  /** Everything else that works, for when a fleet is more than the job needs. */
  alternatives: [
    {
      title: "One emulator",
      body: "`npx mockingbird-stripe serve --port 8787` serves a single emulator with the same admin controls. Use it when the app talks to one vendor.",
    },
    {
      title: "In-process, in a test",
      body: "`createRuntime().fetch(request)` answers the SDK inside the test process, with no port and no server. See the checkout below.",
    },
    {
      title: "Mounted in your app",
      body: '`createRuntime().mount("/api/mock/google")` serves an emulator under your own origin. See [Getting started](docs/GETTING_STARTED.md#mount-an-emulator-inside-your-app).',
    },
    {
      title: "From code",
      body: "`startFleet(config, { load, dashboard: true })` from `@crvouga/mockingbird-fleet` starts the same fleet inside a test runner's global setup. See [Fleets](docs/FLEETS.md#dashboard).",
    },
    {
      title: "Hosted",
      body: `[Fleet Cloud](${HOME}/blob/main/sites/fleet/README.md) hosts fleets at stable URLs. \`mockingbird-fleet plan\` and \`apply\` send it a \`mockingbird.yaml\` declaration, and \`serve --config mockingbird.yaml\` runs the same file locally.`,
    },
  ],
} as const

/** The in-process alternative: the site and generated README share an executable Data → API → Client checkout. */
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

/**
 * The notifications harness: every SMS, email, push and chat message an application sends through the
 * messaging emulators, on lifelike devices. `docs/NOTIFICATIONS.md` is the hub and each topic
 * is a file in `docs/notifications/`.
 */
export const NOTIFICATIONS = {
  title: "See every text, email, push and chat message your app sends.",
  intro:
    "The notifications harness reads the Twilio, Resend, FCM, SES, SNS, Customer.io, Mailosaur and Slack emulators your app already sends through, and shows each message the way the person receiving it would: in a phone's Messages app or a WhatsApp chat, on a lock screen or notification shade, in a webmail inbox, and in a team chat window. Tests read the same messages through a JSON API, and every element carries a test id.",
  guide: "docs/NOTIFICATIONS.md",
  /** Where each topic's page lives: `<pages>/<page>.md`, served at `/docs/notifications/<page>`. */
  pages: "docs/notifications",
  package: "@crvouga/mockingbird-notifications",
  channels: [
    {
      icon: "message",
      title: "Text messages",
      services: "Twilio · SNS · Customer.io · Mailosaur",
      body: "Threads per sender, bubbles, and the one-time code offered above the keyboard. Twilio Verify codes included, and WhatsApp messages open as a WhatsApp chat.",
    },
    {
      icon: "bell",
      title: "Push",
      services: "Firebase Cloud Messaging",
      body: "An iOS lock screen or an Android notification shade, picked from the device token, with title, body, image, data, badge and sound.",
    },
    {
      icon: "mail",
      title: "Email",
      services: "Resend · SES · SNS · Customer.io · Mailosaur",
      body: "An inbox per recipient, to, cc and bcc, with the rendered HTML, attachments and headers. SES raw MIME is parsed.",
    },
    {
      icon: "message",
      title: "Chat",
      services: "Slack",
      body: "A team chat window: channels, bot messages with mrkdwn, Block Kit blocks, attachments and reactions, from chat.postMessage and incoming webhooks.",
    },
  ],
  topics: [
    {
      icon: "terminal",
      title: "Run against a fleet",
      page: "RUN_AGAINST_A_FLEET",
      body: "`mockingbird-fleet serve --config mockingbird.json --dashboard` starts the harness with the fleet. It finds the messaging emulators, follows every namespace, and skips the rest.",
    },
    {
      icon: "grid",
      title: "Devices",
      page: "DEVICES",
      body: "Four devices side by side, or one at a time behind channel tabs on a narrow screen, a timeline of everything, and links that open one recipient or one message for a screenshot.",
    },
    {
      icon: "check",
      title: "End-to-end tests",
      page: "END_TO_END_TESTS",
      body: "A ready signal, a `data-testid` on everything, and each message's fields as attributes, so Playwright finds the email by who it went to.",
    },
    {
      icon: "zap",
      title: "Client",
      page: "CLIENT",
      body: '`waitForCode("+12025550123")` returns the code the app just texted. Run the harness in the test process, with no server.',
    },
    {
      icon: "layers",
      title: "Embed the UI",
      page: "EMBED",
      body: "`mountNotifications(panel, { harness })` puts the devices in a tab of your own app, with scoped styles and no server.",
    },
    {
      icon: "plug",
      title: "HTTP API",
      page: "HTTP_API",
      body: "`GET /api/wait?to=ada@example.com` blocks until the message arrives. Server-sent events for live views.",
    },
  ],
  carriers: [
    {
      label: "With a fleet",
      file: "terminal",
      lang: "bash",
      code: `npx mockingbird-fleet serve \\
  --config mockingbird.json \\
  --dashboard
# dashboard: http://127.0.0.1:8790
# Emulators tab · Notifications tab`,
    },
    {
      label: "In a test",
      file: "signup.test.ts",
      lang: "ts",
      code: `const inbox = new NotificationClient(
  "http://127.0.0.1:8790",
)
const code = await inbox.waitForCode(
  "+12025550123",
)
await page.goto(inbox.link({
  channel: "email",
  to: "ada@example.com",
}))`,
    },
    {
      label: "In your app",
      file: "devtools.ts",
      lang: "ts",
      code: `const harness = createNotificationHarness({
  services: { twilio, resend, fcm },
})
mountNotifications(panel, {
  harness,
  title: "My app notifications",
})`,
    },
  ],
} as const

export const CONTRACT = {
  intro:
    "Every HTTP service ships an in-process `fetch`, a Node server and a CLI, runs in a fleet, and answers the same control surface in each, so a stack learns it once. Every internal path is under `/__admin` by default. Set `adminPrefix` or `serve --admin-prefix` (`MOCKINGBIRD_ADMIN_PREFIX`) to relocate the entire tree; `/health` and `/ns` aliases are removed.",
  serve: `npx mockingbird-fleet serve --config mockingbird.json --dashboard  # recommended: every service in the config
npx mockingbird-junction serve --port 8787                           # one service`,
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
    "`mockingbird.json` names services by their package suffix. HTTP services, PostgreSQL and Redis share a supervisor that gives each its own port (`0` picks a free one), readiness discovery and namespace controls. Use `--ready-file` or `--ready-json` to discover endpoints and `--dashboard` for the combined admin and notifications page; see [Fleets](docs/FLEETS.md). SQLite remains an in-process engine.",
}

export const AGENTS =
  "Run the emulators as a fleet: install `@crvouga/mockingbird-fleet` and the service packages, write `mockingbird.json`, and start `npx mockingbird-fleet serve --config mockingbird.json --dashboard --ready-file ready.json`; read each emulator's URL from `ready.json` rather than guessing a port. Every npm package ships an agent index at `node_modules/<package>/DISCOVERY.md`. It points to the local behavior guide, exact capability matrix, machine-readable contract or compatibility evidence, public types, parity oracle, runtime introspection, and issue-reporting contract. [`llms.txt`](llms.txt) indexes those files with the parity each service declares, and the docs site publishes the same source material as markdown and JSON. When an emulator diverges from the real API, lacks a feature you call, or the vendor you need is not in the catalog, file an issue: [the filing guide](https://github.com/crvouga/mockingbird/blob/main/docs/REPORTING_ISSUES.md) gives the title format, templates and the behavior spec for feature and service requests."

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
  NOTIFICATIONS: [
    "RUN_AGAINST_A_FLEET",
    "DEVICES",
    "END_TO_END_TESTS",
    "CLIENT",
    "EMBED",
    "HTTP_API",
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
  "FLEETS",
  "ADMIN_CONTROLS",
  "NOTIFICATIONS",
  "WHY",
  "TESTING",
  "AUTHORING_A_SERVICE",
  "DEVELOPMENT",
  "DESIGN",
  "REPORTING_ISSUES",
  "RELEASING",
  "SECRETS",
]
