/**
 * Live parity against Gene by Gene (Nucleus API v2), staging by default. Credentials come from
 * the environment (`.env.local` locally, repo secrets in the Parity workflow):
 *
 *   MOCKINGBIRD_GENEBYGENE_CLIENT_ID      (or GENE_BY_GENE_CLIENT_ID, the repo secret's name)
 *   MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET  (or GENE_BY_GENE_CLIENT_SECRET)
 *   MOCKINGBIRD_GENEBYGENE_API_URL    optional, default https://staging-api.genebygene.com
 *                                     (MOCKINGBIRD_GENEBYGENE_BASE_URL is the older name)
 *   MOCKINGBIRD_GENEBYGENE_TOKEN_URL  optional, default https://staging-auth.genebygene.com/connect/token
 *   MOCKINGBIRD_GENEBYGENE_UNSAFE=1   also place (and cancel) real orders; demo/staging only
 *
 * Without credentials it prints the missing variable names and exits 2. It never prints a
 * secret value. What it checks:
 *
 * 1. Token, then `GET /api/v2/products`, `/attributes`, `/eventTypes`: status, and for products
 *    the id set. Live ids win when staging has drifted: a redacted diff (ids and names only) is
 *    written to `corpus/products-diff.json` for a human to commit.
 * 2. The synthetic address corpus quoted against the deluxe bundle (or the staging standard
 *    bundle when staging lacks it): status, whether `errorMessages` is empty, and the SET of
 *    courier codes — never prices or dates (volatile live, deterministic only in the mock). A
 *    live code set that contradicts the zone table fails the run and names the ZIP3.
 * 3. The structural cases (long line, PO Box, non-US, the not-found street) are recorded into
 *    `corpus/address-parity.json` (`recorded: true`); the acceptance suite replays that file.
 * 4. A random walk over the other safe operations, mock vs live.
 * 5. With MOCKINGBIRD_GENEBYGENE_UNSAFE=1 (never against production): one order to
 *    `1445 N Loop W`, canceled in the same run, and one to `501 N 5th St`, which must answer the
 *    Address Not Found 400. Responses are redacted to status, message and id shape.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import { parity } from "@crvouga/mockingbird-parity"
import { DELUXE_BUNDLE_ID } from "../src/corpus.js"
import { document, GeneByGeneAPI, supportedOperationIds } from "../src/index.js"
import { ADDRESS_CORPUS, menuFor, zoneFor } from "../src/shipping.js"

const STAGING_STANDARD_ID = "0d52219e-30a5-4a0d-b96d-0fe9a46d95e5"
const CORPUS_DIR = join(import.meta.dir, "..", "corpus")

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "genebygene",
      fields: {
        MOCKINGBIRD_GENEBYGENE_CLIENT_ID: "MOCKINGBIRD_GENEBYGENE_CLIENT_ID",
        MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET: "MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET",
      },
    },
    {
      env: {
        MOCKINGBIRD_GENEBYGENE_CLIENT_ID:
          process.env.MOCKINGBIRD_GENEBYGENE_CLIENT_ID || process.env.GENE_BY_GENE_CLIENT_ID,
        MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET:
          process.env.MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET ||
          process.env.GENE_BY_GENE_CLIENT_SECRET,
      },
    },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(
      `genebygene parity: no credentials. ${error.message} (or GENE_BY_GENE_CLIENT_ID / GENE_BY_GENE_CLIENT_SECRET)`,
    )
    process.exit(2)
  }
  throw error
}

const tokenUrl =
  process.env.MOCKINGBIRD_GENEBYGENE_TOKEN_URL ??
  "https://staging-auth.genebygene.com/connect/token"
const baseUrl = (
  process.env.MOCKINGBIRD_GENEBYGENE_API_URL ??
  process.env.MOCKINGBIRD_GENEBYGENE_BASE_URL ??
  "https://staging-api.genebygene.com"
).replace(/\/$/, "")
const unsafe = process.env.MOCKINGBIRD_GENEBYGENE_UNSAFE === "1"
if (unsafe && /(^|\/\/)api\.genebygene\.com/.test(baseUrl)) {
  console.error("genebygene parity: MOCKINGBIRD_GENEBYGENE_UNSAFE never runs against production")
  process.exit(2)
}

const requestToken = (
  target: (request: Request) => Promise<Response>,
  clientId: string,
  secret: string,
) =>
  target(
    new Request(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: secret,
      }),
    }),
  )

const tokenResponse = await requestToken(
  (r) => fetch(r),
  credentials.values.MOCKINGBIRD_GENEBYGENE_CLIENT_ID ?? "",
  credentials.values.MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET ?? "",
)
if (!tokenResponse.ok) {
  console.error(`genebygene parity: token request failed (${tokenResponse.status})`)
  process.exit(2)
}
const realToken = ((await tokenResponse.json()) as { access_token: string }).access_token
const redact = createRedactor([...credentials.secrets, realToken])

// The mock answers the staging catalog, the host this script talks to by default.
const mockApi = new GeneByGeneAPI({ settings: { catalog: "staging" } })
const mockToken = (
  (await (await requestToken((r) => mockApi.fetch(r), "parity", "parity")).json()) as {
    access_token: string
  }
).access_token

type Json = Record<string, unknown>
const call = async (target: "live" | "mock", method: string, path: string, body?: unknown) => {
  const init: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${target === "live" ? realToken : mockToken}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  const response =
    target === "live"
      ? await fetch(new Request(`${baseUrl}${path}`, init))
      : await mockApi.fetch(new Request(`https://mock.genebygene.local${path}`, init))
  const text = await response.text()
  let json: unknown
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  // Stay under our client's own 2 rps budget on the shared tenant.
  if (target === "live") await Bun.sleep(500)
  return { status: response.status, json }
}

const failures: string[] = []
const fail = (message: string) => {
  failures.push(message)
  console.error(`  ✗ ${redact(message)}`)
}

// 1. catalog, attributes, event types --------------------------------------------------------------
console.log("genebygene parity: catalog")
for (const path of ["/api/v2/products", "/api/v2/attributes", "/api/v2/eventTypes"]) {
  const [live, mock] = [await call("live", "GET", path), await call("mock", "GET", path)]
  if (live.status !== mock.status) fail(`${path}: live ${live.status}, mock ${mock.status}`)
}
const liveProducts = ((await call("live", "GET", "/api/v2/products")).json ?? []) as Json[]
const mockProducts = ((await call("mock", "GET", "/api/v2/products")).json ?? []) as Json[]
const ids = (rows: Json[]) => new Set(rows.map((p) => String(p.id)))
const [liveIds, mockIds] = [ids(liveProducts), ids(mockProducts)]
const added = liveProducts.filter((p) => !mockIds.has(String(p.id)))
const removed = mockProducts.filter((p) => !liveIds.has(String(p.id)))
if (added.length > 0 || removed.length > 0) {
  const diff = {
    host: new URL(baseUrl).host,
    added: added.map((p) => ({ id: p.id, name: p.name })),
    removed: removed.map((p) => ({ id: p.id, name: p.name })),
  }
  await writeFile(join(CORPUS_DIR, "products-diff.json"), `${JSON.stringify(diff, null, 2)}\n`)
  fail(`product ids drifted (+${added.length} / -${removed.length}); see corpus/products-diff.json`)
}

// 2 + 3. the address corpus ---------------------------------------------------------------------
console.log("genebygene parity: address corpus")
const productId = liveIds.has(DELUXE_BUNDLE_ID) ? DELUXE_BUNDLE_ID : STAGING_STANDARD_ID
const address = (over: Json): Json => ({
  isCommercial: false,
  recipientName: "Mockingbird Test",
  addressLine1: "",
  addressLine2: null,
  addressLine3: null,
  city: "",
  stateOrRegion: "",
  postalCode: "",
  countryCode: "US",
  email: "test@example.com",
  phone: "+15555550100",
  shippingInstruction: null,
  referenceId: null,
  ...over,
})
const quote = (target: "live" | "mock", shippingAddress: Json) =>
  call(target, "POST", "/api/v2/fulfillments/actions/getShippingOptions", {
    shippingAddress,
    quantity: 1,
    productId,
  })
const codes = (json: unknown) =>
  ((json as { shippingOptions?: { courierServiceCode: string }[] })?.shippingOptions ?? [])
    .map((o) => o.courierServiceCode)
    .sort()
const errorMessages = (json: unknown) =>
  ((json as { errorMessages?: string[] })?.errorMessages ?? []).map(String)

for (const row of ADDRESS_CORPUS) {
  const { kind: _kind, note: _note, ...street } = row
  const sent = address(street)
  const [live, mock] = [await quote("live", sent), await quote("mock", sent)]
  const zip3 = row.postalCode.slice(0, 3)
  if (live.status !== mock.status) fail(`quote ${zip3}: live ${live.status}, mock ${mock.status}`)
  if ((errorMessages(live.json).length === 0) !== (errorMessages(mock.json).length === 0)) {
    fail(`quote ${zip3}: errorMessages empty live=${errorMessages(live.json).length === 0}`)
  }
  const zone = zoneFor(zip3)
  const expected =
    zone === undefined
      ? []
      : menuFor(zone)
          .map((s) => s.courierServiceCode)
          .sort()
  if (live.status === 200 && JSON.stringify(codes(live.json)) !== JSON.stringify(expected)) {
    fail(`ZIP3 ${zip3}: live codes ${codes(live.json).join(",")} contradict the zone table`)
  }
}

type Case = {
  name: string
  operation: "quote" | "place"
  address: Json
  courierServiceCode?: string
  status: number
  errorMessages?: string[]
  courierServiceCodes?: string[]
  message?: string
  error?: unknown
  options?: Json[]
}
const file = join(CORPUS_DIR, "address-parity.json")
const recording = JSON.parse(await readFile(file, "utf8")) as { cases: Case[] } & Json
const recorded: Case[] = []
for (const c of recording.cases) {
  if (c.operation === "place" && !unsafe) {
    recorded.push(c)
    continue
  }
  if (c.operation === "quote") {
    const live = await quote("live", address(c.address))
    // The mock must answer what staging answers: status, errorMessages, the menu in order (codes
    // and names, never prices or dates), and a refusal's validation errors or message.
    const [liveClass, mockClass] = [live, await quote("mock", address(c.address))].map((r) =>
      JSON.stringify({
        status: r.status,
        errorMessages: errorMessages(r.json),
        menu: ((r.json as { shippingOptions?: Json[] } | undefined)?.shippingOptions ?? []).map(
          (o) => `${o.courierServiceCode}:${o.courierServiceDisplayName}`,
        ),
        errors: (r.json as Json | undefined)?.errors,
        message: r.status >= 400 ? (r.json as Json | undefined)?.message : undefined,
      }),
    )
    if (liveClass !== mockClass) fail(`quote "${c.name}": live ${liveClass}, mock ${mockClass}`)
    const next: Case = { ...c, status: live.status, errorMessages: errorMessages(live.json) }
    // A refusal's body is the vendor's validation text about a synthetic street: keep it so the
    // mock can answer the same bytes. A 200's body carries prices and dates, which drift.
    if (live.status === 200) {
      delete next.error
      // The menu without prices and dates (volatile live, deterministic only in the mock).
      next.options = (
        (live.json as { shippingOptions?: Json[] } | undefined)?.shippingOptions ?? []
      ).map((o) => ({
        courierName: o.courierName,
        courierServiceCode: o.courierServiceCode,
        courierServiceDisplayName: o.courierServiceDisplayName,
      }))
    } else {
      const error = JSON.parse(redact(JSON.stringify(live.json ?? null))) as Json | null
      // A problem-details traceId differs on every request.
      next.error = error && "traceId" in error ? { ...error, traceId: "<volatile>" } : error
    }
    if (c.courierServiceCodes) next.courierServiceCodes = codes(live.json)
    recorded.push(next)
    continue
  }
  const live = await call("live", "POST", "/api/v2/orders", {
    items: [
      {
        productId,
        placerOrderNumber: `mockingbird-parity:${Date.now()}`,
        shipments: [
          { quantity: 1, address: address(c.address), courierServiceCode: c.courierServiceCode },
        ],
      },
    ],
  })
  const message = String((live.json as Json | undefined)?.message ?? "")
  recorded.push({ ...c, status: live.status, message })
  if (live.status === 200) {
    fail(`${c.name}: live placed an order (cancel ${String((live.json as Json).id)} by hand)`)
  }
}
await writeFile(
  file,
  `${JSON.stringify({ ...recording, source: new URL(baseUrl).host, recorded: true, cases: recorded }, null, 2)}\n`,
)
console.log("  wrote corpus/address-parity.json")

// 5. unsafe: one real place + cancel -----------------------------------------------------------
if (unsafe) {
  console.log("genebygene parity: unsafe place + cancel")
  const placed = await call("live", "POST", "/api/v2/orders", {
    items: [
      {
        productId,
        placerOrderNumber: `mockingbird-parity:${Date.now()}`,
        shipments: [
          {
            quantity: 1,
            address: address({
              addressLine1: "1445 N Loop W",
              city: "Houston",
              stateOrRegion: "TX",
              postalCode: "77008",
            }),
            courierServiceCode: "DHL_DOMESTIC_RETURN",
          },
        ],
      },
    ],
  })
  if (placed.status !== 200) fail(`place 1445 N Loop W: ${placed.status}`)
  const order = placed.json as { id?: string; orderLines?: Json[] } | undefined
  for (const line of order?.orderLines ?? []) {
    for (const f of (line.fulfillments as Json[] | null) ?? []) {
      await call("live", "DELETE", `/api/v2/fulfillments/${f.id}`)
    }
    for (const kit of (line.kitNumbers as string[] | null) ?? []) {
      await call("live", "DELETE", `/api/v2/kits/${kit}/orderLines`)
    }
    await call("live", "DELETE", `/api/v2/orderLines/${line.id}`)
  }
  console.log(`  placed and canceled an order (id ${order?.id ? "uuid" : "missing"})`)
}

// 3b. vendor catalogs and error shapes ------------------------------------------------------------
// Only the tenant-independent catalogs and the answers for ids that cannot exist: list
// endpoints on the shared tenant can hold other callers' orders, so they are never written.
console.log("genebygene parity: catalogs and error shapes")
const ZERO = "00000000-0000-0000-0000-000000000000"
const probe = async (method: string, path: string, token = realToken) => {
  const response = await fetch(
    new Request(`${baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    }),
  )
  const text = await response.text()
  await Bun.sleep(500)
  let body: unknown = text
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {}
  return {
    method,
    path,
    status: response.status,
    contentType: response.headers.get("content-type"),
    wwwAuthenticate: response.headers.get("www-authenticate"),
    body: JSON.parse(redact(JSON.stringify(body))),
  }
}
const catalogs = {
  source: new URL(baseUrl).host,
  note: "Recorded by scripts/parity.ts from the live tenant: the event types and attribute definitions it lists. Vendor catalog metadata only, no tenant data.",
  eventTypes: (await probe("GET", "/api/v2/eventTypes")).body,
  attributes: (await probe("GET", "/api/v2/attributes")).body,
}
const shapes = {
  source: new URL(baseUrl).host,
  note: "Recorded by scripts/parity.ts: the live answers for ids that cannot exist. No tenant data.",
  errors: [
    await probe("GET", "/api/v2/products", "not-a-token"),
    await probe("GET", "/api/v2/kits/WB000000"),
    await probe("GET", "/api/v2/kits/WB000000/results"),
    await probe("GET", `/api/v2/orders/${ZERO}`),
    await probe("GET", "/api/v2/orders/not-a-guid"),
    await probe("GET", `/api/v2/orderLines/${ZERO}`),
    await probe("GET", `/api/v2/notificationSubscriptions/${ZERO}`),
    await probe("GET", "/api/v2/results/results/presignedUrl?kitNumber=WB000000&resultType=x"),
  ],
}
// Query validation: each list parameter with a junk value, and the candidate values of the
// ones the vendor validates as enums. Only the status and the validation errors are kept: a 200
// page on the shared tenant can hold other callers' rows, so its body is never written.
const QUERY_PROBES: readonly [string, Record<string, string>][] = [
  ...(
    [
      ["/api/v2/attributes", ["entityType"]],
      ["/api/v2/eventTypes", ["name"]],
      ["/api/v2/fulfillments", ["orderLineId", "orderId", "fulfillmentId", "offset", "pageSize"]],
      [
        "/api/v2/kitorderlines",
        [
          "kitNumbers",
          "orderId",
          "orderLineId",
          "status",
          "attributeTerm",
          "attributesToSearch",
          "attributesFilter",
          "offset",
          "pageSize",
          "orderBy",
          "productType",
          "orderByAsc",
        ],
      ],
      ["/api/v2/kitorderlines/kits", ["orderId", "status", "orderBy", "productType", "orderByAsc"]],
      ["/api/v2/kits", ["kitNumber", "orderNumber", "status", "offset", "pageSize"]],
      ["/api/v2/notificationSubscriptions", ["type"]],
      [
        "/api/v2/orders",
        ["orderId", "orderDateMin", "orderDateMax", "productName", "offset", "pageSize"],
      ],
      ["/api/v2/products", ["productCode", "productId", "productType"]],
      ["/api/v2/results", ["kitNumber", "offset", "pageSize"]],
      [
        "/api/v2/results/search",
        ["kitNumbers", "dateOfBirth", "resultTypeName", "orderBy", "orderByAsc", "resultDateYear"],
      ],
      ["/api/v2/results/results/presignedUrl", ["resultId", "kitNumber", "resultType"]],
    ] as const
  ).flatMap(([path, names]) =>
    names.map((name) => [path, { [name]: "a" }] as [string, Record<string, string>]),
  ),
  ...[
    "Materials",
    "materials",
    "Bundle",
    "DigitalProduct",
    "Digital Product",
    "LabServices",
    "Lab Services",
    "0",
    "1",
  ].flatMap((productType) => [
    ["/api/v2/kitorderlines/kits", { productType, orderId: ZERO }] as [
      string,
      Record<string, string>,
    ],
    ["/api/v2/products", { productType }] as [string, Record<string, string>],
  ]),
  ...["Shipped", "Canceled", "Received", "Completed", "Pending", "1"].flatMap((status) => [
    ["/api/v2/kitorderlines/kits", { status, orderId: ZERO }] as [string, Record<string, string>],
    ["/api/v2/kits", { status, kitNumber: "WB000000" }] as [string, Record<string, string>],
  ]),
  ["/api/v2/kitorderlines/kits", { orderBy: "kitNumber", orderId: ZERO }],
  ["/api/v2/kitorderlines/kits", { orderBy: "KitNumber", orderId: ZERO }],
  ["/api/v2/notificationSubscriptions", { type: "Webhook" }],
  ["/api/v2/notificationSubscriptions", { type: "webhook" }],
  ["/api/v2/attributes", { entityType: "Kit" }],
  ["/api/v2/attributes", { entityType: "1" }],
  ["/api/v2/kits", { kitNumber: "WB000000", pageSize: "0" }],
  ["/api/v2/kits", { kitNumber: "WB000000", pageSize: "-1" }],
  ["/api/v2/kits", { kitNumber: "WB000000", pageSize: "501" }],
  ["/api/v2/kits", { kitNumber: "WB000000", offset: "-1" }],
  ["/api/v2/orders", { orderId: ZERO, pageSize: "0" }],
  ["/api/v2/orders", { orderId: ZERO, offset: "-1" }],
]
const queries: Json[] = []
for (const [path, params] of QUERY_PROBES) {
  const answer = await probe("GET", `${path}?${new URLSearchParams(params)}`)
  const body = answer.body as Json | null
  queries.push({
    path,
    params,
    status: answer.status,
    ...(answer.status === 200
      ? {}
      : { errors: body?.errors, message: body && "message" in body ? body.message : undefined }),
  })
}
;(shapes as Json).queries = queries

// The mock serves these catalogs (src/corpus/live-catalogs.json); the walk compares them.
await writeFile(
  join(import.meta.dir, "..", "src", "corpus", "live-catalogs.json"),
  `${JSON.stringify(catalogs, null, 2)}\n`,
)
await writeFile(join(CORPUS_DIR, "live-errors.json"), `${JSON.stringify(shapes, null, 2)}\n`)
console.log("  wrote src/corpus/live-catalogs.json and corpus/live-errors.json")

/**
 * The staging tenant is shared: its list pages hold thousands of kits and orders no walk
 * created, which a fresh mock can never have. A safe walk creates nothing, so the tenant view it
 * should see is empty: drop the rows of a live 200 list page (and zero its count) before the
 * comparison. Status, page metadata, validation errors and every other body stay exact.
 */
const withoutTenantRows = async (request: Request, response: Response): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (request.method !== "GET" || response.status !== 200 || !LIST_PATHS.has(path)) return response
  const body = (await response.json()) as unknown
  const emptied = Array.isArray(body)
    ? []
    : { ...(body as Json), items: [], ...("totalCount" in (body as Json) ? { totalCount: 0 } : {}) }
  return new Response(JSON.stringify(emptied), { status: 200, headers: response.headers })
}
const LIST_PATHS: ReadonlySet<string> = new Set([
  "/api/v2/orders",
  "/api/v2/kits",
  "/api/v2/fulfillments",
  "/api/v2/kitorderlines",
  "/api/v2/kitorderlines/kits",
  "/api/v2/results",
  "/api/v2/results/search",
  "/api/v2/notificationSubscriptions",
])

// 4. the random walk over the remaining safe operations ------------------------------------------
const walked = supportedOperationIds.filter(
  (id) => id !== "GetShippingOptions" && id !== "GetResultBlob",
)
try {
  await parity({
    provider: "genebygene",
    spec: document,
    env: process.env,
    only: walked,
    includeUnsafe: unsafe,
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host, new URL(tokenUrl).host],
      headers: () => ({ authorization: `Bearer ${realToken}`, accept: "application/json" }),
      minIntervalMs: 500,
      fetch: async (request) => {
        // The token operation lives on the auth host.
        const url = new URL(request.url)
        if (url.pathname.endsWith("/connect/token")) return fetch(new Request(tokenUrl, request))
        const response = await fetch(request)
        return unsafe ? response : withoutTenantRows(request, response)
      },
    },
    mock: {
      create: () => new GeneByGeneAPI({ settings: { catalog: "staging" } }),
      headers: () => ({ authorization: `Bearer ${mockToken}`, accept: "application/json" }),
    },
    redact,
  })
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (failures.length > 0) {
  console.error(`\ngenebygene parity: ${failures.length} failure(s)`)
  process.exit(1)
}
console.log("genebygene parity: ok")
