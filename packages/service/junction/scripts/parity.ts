import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ExploreRng, ExploreState, LogicalCommand, Scope } from "@crvouga/mockingbird-commands"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-credentials"
import {
  DEFAULT_PROPERTY_RUNS,
  parity,
  type SeedCacheEntry,
  seedParity,
} from "@crvouga/mockingbird-parity"
import {
  COVERAGE_ZIPS,
  PHLEBOTOMY_AVAILABILITY_ZIPS,
  PSC_AVAILABILITY_ZIPS,
} from "../src/coverage-corpus.js"
import { document, JunctionAPI } from "../src/index.js"
import { prefetchCoverageObservations } from "../src/prefetch.js"
import { reshapeCoverageGeoCommand } from "../src/reshape.js"
import { PARITY_SEEDS } from "../src/seeds.js"

/** Docs: https://docs.junction.com/api-details/junction-api */
const DEFAULT_JUNCTION_HOST = "api.sandbox.tryvital.io"
const FAILURE_STATE_DIR = ".parity-artifacts/junction"
const LAST_FAILED_SEED_PATH = `${FAILURE_STATE_DIR}/last-failed-seed`
const FAILURE_REGISTRY_PATH = join(import.meta.dir, "../../../../PARITY_FAILURE_SEED_REGISTRY.json")
const TEST_KEY_PREFIXES = ["sk_us_", "sk_eu_"]
const DEFAULT_MIN_INTERVAL_MS = 50
const DEFAULT_WARMUP = 20
const DEFAULT_COMPARE = 40

type ParityMode = "seed" | "empty"

type ParityCLIOptions = {
  runs?: number
  steps?: number
  warmup?: number
  compare?: number
  mode: ParityMode
  /** Skip coverage-corpus ZIP prefetch (faster smoke). */
  skipPrefetch?: boolean
}

const parsePositiveInteger = (value: string, name: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer, got ${value}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer, got ${value}`)
  return parsed
}

const parseCLIOptions = (args: readonly string[]): ParityCLIOptions => {
  const options: ParityCLIOptions = { mode: "seed" }
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index] ?? ""
    const eq = raw.indexOf("=")
    const flag = eq >= 0 ? raw.slice(0, eq) : raw
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined
    if (flag === "--mode") {
      const value = inline ?? args[index + 1]
      if (inline === undefined) index += 1
      if (value !== "seed" && value !== "empty")
        throw new Error(`--mode must be seed or empty, got ${value ?? ""}`)
      options.mode = value
      continue
    }
    if (flag === "--skip-prefetch") {
      options.skipPrefetch = true
      continue
    }
    if (flag !== "--runs" && flag !== "--steps" && flag !== "--warmup" && flag !== "--compare") {
      throw new Error(`unknown parity option ${flag}`)
    }
    const value = inline ?? args[index + 1]
    if (inline === undefined) index += 1
    if (value === undefined) throw new Error(`${flag} requires a value`)
    const parsed = parsePositiveInteger(value, flag)
    if (flag === "--runs") options.runs = parsed
    else if (flag === "--steps") options.steps = parsed
    else if (flag === "--warmup") options.warmup = parsed
    else options.compare = parsed
  }
  return options
}

const cliOptions = parseCLIOptions(Bun.argv.slice(2))

const credentials = await loadCredentials(
  {
    provider: "junction",
    fields: { JUNCTION_API_KEY: "JUNCTION_API_KEY" },
  },
  { env: Bun.env },
)
const apiKey = credentials.values.JUNCTION_API_KEY
if (!TEST_KEY_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
  console.error("junction parity: refusing to run with a key that is not a sandbox team key")
  process.exit(2)
}

const baseUrl = Bun.env.JUNCTION_BASE_URL ?? `https://${DEFAULT_JUNCTION_HOST}`
const webhookReceiverUrl = Bun.env.JUNCTION_WEBHOOK_RECEIVER_URL?.replace(/\/$/, "")
const webhookParity =
  webhookReceiverUrl === undefined
    ? undefined
    : {
        collectReal: async (scope: Scope) => {
          const response = await fetch(
            `${webhookReceiverUrl}/events/${encodeURIComponent(scope.runId)}?service=junction`,
            {
              headers: Bun.env.WEBHOOK_READ_TOKEN
                ? { authorization: `Bearer ${Bun.env.WEBHOOK_READ_TOKEN}` }
                : {},
            },
          )
          if (!response.ok) throw new Error(`webhook receiver returned ${response.status}`)
          return (await response.json()) as readonly unknown[]
        },
        collectMock: async (mock: FetchAPI) => {
          const service = mock as unknown as JunctionAPI
          return service.webhookEvents()
        },
      }
const authHeaders = { "x-vital-api-key": apiKey }

const clearSandboxUsers = async () => {
  for (;;) {
    let response = await fetch(`${baseUrl}/v2/user?offset=0&limit=500`, {
      headers: authHeaders,
    })
    for (let attempt = 0; response.status === 503 && attempt < 5; attempt += 1) {
      await Bun.sleep(DEFAULT_MIN_INTERVAL_MS * (attempt + 2))
      response = await fetch(`${baseUrl}/v2/user?offset=0&limit=500`, {
        headers: authHeaders,
      })
    }
    if (!response.ok) throw new Error(`failed to list sandbox users: ${response.status}`)
    const payload = (await response.json()) as { users?: unknown[] }
    const users = payload.users ?? []
    if (users.length === 0) return
    for (const entry of users) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue
      const userId = (entry as Record<string, unknown>).user_id
      if (typeof userId !== "string") continue
      let deletion = await fetch(`${baseUrl}/v2/user/${userId}`, {
        method: "DELETE",
        headers: authHeaders,
      })
      for (let attempt = 0; deletion.status === 503 && attempt < 5; attempt += 1) {
        await Bun.sleep(DEFAULT_MIN_INTERVAL_MS * (attempt + 2))
        deletion = await fetch(`${baseUrl}/v2/user/${userId}`, {
          method: "DELETE",
          headers: authHeaders,
        })
      }
      if (!deletion.ok && deletion.status !== 404) {
        throw new Error(`failed to clear sandbox user: ${deletion.status}`)
      }
      await Bun.sleep(DEFAULT_MIN_INTERVAL_MS)
    }
  }
}

/**
 * Ops with parity.enabled=false that seedParity still exercises after observation seeding /
 * geo reshape. Expand until docs/drop-in.md is fully green.
 */
const FORCE_INCLUDE_OPS = [
  "get_result_raw_v3_order__order_id__result_get",
  "get_result_pdf_v3_order__order_id__result_pdf_get",
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "get_psc_appointment_availability_v3_order_psc_appointment_availability_post",
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get",
  "reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch",
  "cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch",
  "book_psc_appointment_v3_order__order_id__psc_appointment_book_post",
  "get_psc_appointment_v3_order__order_id__psc_appointment_get",
  "reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch",
  "cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch",
] as const

/** Full lab-testing surface — see docs/drop-in.md. */
const PARITY_OPS = [
  "create_user_v2_user_post",
  "get_teams_users_v2_user_get",
  "get_user_v2_user__user_id__get",
  "delete_user_v2_user__user_id__delete",
  "patch_user_v2_user__user_id__patch",
  "get_user_by_client_user_id_v2_user_resolve__client_user_id__get",
  "patch_user_info_v2_user__user_id__info_patch",
  "get_latest_user_info_user_v2_user__user_id__info_latest_get",
  "get_paginated_lab_tests_for_team_v3_lab_test_get",
  "get_lab_test_for_team_v3_lab_tests__lab_test_id__get",
  "get_labs_v3_lab_tests_labs_get",
  "get_markers_for_lab_test_v3_lab_tests__lab_test_id__markers_get",
  "create_order_v3_order_post",
  "get_order_v3_order__order_id__get",
  "cancel_order_v3_order__order_id__cancel_post",
  "simulate_order_v3_order__order_id__test_post",
  "get_result_metadata_v3_order__order_id__result_metadata_get",
  "get_result_raw_v3_order__order_id__result_get",
  "get_result_pdf_v3_order__order_id__result_pdf_get",
  "get_orders_v3_orders_get",
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "get_psc_appointment_availability_v3_order_psc_appointment_availability_post",
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get",
  "reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch",
  "cancel_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_cancel_patch",
  "book_psc_appointment_v3_order__order_id__psc_appointment_book_post",
  "get_psc_appointment_v3_order__order_id__psc_appointment_get",
  "reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch",
  "cancel_psc_appointment_v3_order__order_id__psc_appointment_cancel_patch",
  "get_phlebotomy_appointment_cancellation_reason_v3_order_phlebotomy_appointment_cancellation_reasons_get",
  "get_psc_appointment_cancellation_reason_v3_order_psc_appointment_cancellation_reasons_get",
] as const

const cleanup = async ({
  table,
  real,
  scope,
}: {
  table: { all: () => Array<{ type: string; ids: { real?: string } }> }
  real: { fetch: (request: Request) => Promise<Response>; baseUrl: string }
  scope: Scope
}) => {
  for (const resource of table.all()) {
    const id = resource.ids.real
    if (id === undefined) continue
    if (resource.type === "user") {
      await real.fetch(
        new Request(`${real.baseUrl}/v2/user/${id}`, {
          method: "DELETE",
          headers: { ...authHeaders, "x-mockingbird-scope": scope.runId },
        }),
      )
      await Bun.sleep(DEFAULT_MIN_INTERVAL_MS)
    }
  }
  await clearSandboxUsers()
}

const reshapeCommand = (
  command: LogicalCommand,
  state: ExploreState,
  rng: ExploreRng,
): LogicalCommand => reshapeCoverageGeoCommand(command, state, rng)

/**
 * The Vital sandbox intermittently answers 500/502/503/504 with a text body (documented
 * flake — `clearSandboxUsers` already retries 503). Retry the same way on the parity real
 * side so a transient sandbox blip doesn't fail a walk: up to 5 attempts with linear
 * backoff. GETs are always safe to retry. POST /v3/order/{id}/test is also safe: it is an
 * idempotent simulation driver (repeated /test calls are no-ops once requisitioned, probed
 * 2026-09), so a re-applied transition cannot double-mutate. Other mutations are not
 * retried — a retried POST/PATCH could double-execute.
 */
const SANDBOX_RETRY_STATUSES = new Set([500, 502, 503, 504])
const SIMULATE_TEST_PATH = /^\/v3\/order\/[^/]+\/test$/
const retryable = (request: Request): boolean => {
  if (request.method === "GET") return true
  if (request.method !== "POST") return false
  return SIMULATE_TEST_PATH.test(new URL(request.url).pathname)
}
const retrySandbox5xx = async (request: Request): Promise<Response> => {
  let response = await fetch(request.clone())
  for (
    let attempt = 0;
    retryable(request) && SANDBOX_RETRY_STATUSES.has(response.status) && attempt < 5;
    attempt += 1
  ) {
    console.warn(
      `junction parity: sandbox ${response.status} on ${request.method} ${new URL(request.url).pathname}, retry ${attempt + 1}/5`,
    )
    await Bun.sleep(DEFAULT_MIN_INTERVAL_MS * (attempt + 2))
    response = await fetch(request.clone())
  }
  return response
}

const runSeed = async (seed: number | undefined) => {
  try {
    if (webhookReceiverUrl) {
      console.log(`junction webhook parity: enabled (${webhookReceiverUrl})`)
    } else {
      console.warn(
        "junction webhook parity: skipped; configure JUNCTION_WEBHOOK_RECEIVER_URL with a deployed receiver URL, then register the webhook URL in the Junction sandbox dashboard using `bun run webhook:register`",
      )
    }
    console.log(
      `junction parity mode=${cliOptions.mode} explore=dynamic oracle=${baseUrl} zips=${COVERAGE_ZIPS.length}`,
    )
    await clearSandboxUsers()
    await Bun.sleep(DEFAULT_MIN_INTERVAL_MS * 4)

    let sharedGeoCache: Map<string, SeedCacheEntry> | undefined

    const shared = {
      provider: "junction",
      spec: document,
      env: Bun.env,
      numRuns: cliOptions.runs ?? DEFAULT_PROPERTY_RUNS,
      maxCommands: cliOptions.steps ?? DEFAULT_COMPARE,
      latencyToleranceMs: 500,
      only: [...PARITY_OPS],
      forceInclude: [...FORCE_INCLUDE_OPS],
      explore: "dynamic" as const,
      reshapeCommand,
      invalidProbability: 0,
      missingProbability: 0,
      deletedRefProbability: 0,
      deletionTypes: {
        delete_user_v2_user__user_id__delete: ["user"],
        book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: [
          "booking_key",
        ],
        book_psc_appointment_v3_order__order_id__psc_appointment_book_post: ["booking_key"],
        reschedule_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_reschedule_patch:
          ["booking_key"],
        reschedule_psc_appointment_v3_order__order_id__psc_appointment_reschedule_patch: [
          "booking_key",
        ],
      },
      real: {
        baseUrl,
        allowedHosts: [new URL(baseUrl).host],
        fetch: (request: Request) => retrySandbox5xx(request),
        headers: () => ({
          ...authHeaders,
          "x-mockingbird-scope": Bun.env.MOCKINGBIRD_SCOPE ?? "junction-parity",
        }),
        minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
      },
      mock: {
        create: () => new JunctionAPI(),
        headers: () => ({ "x-vital-api-key": "sk_us_mockingbird" }),
      },
      ...(webhookParity === undefined ? {} : { webhooks: webhookParity }),
      redact: createRedactor(credentials.secrets),
      shrink: false,
      cleanup,
      ...(seed === undefined ? {} : { seed }),
    }

    if (cliOptions.mode === "empty") {
      const { explore: _explore, reshapeCommand: _reshape, ...emptyShared } = shared
      await parity({
        ...emptyShared,
        weights: {
          create_user_v2_user_post: 3,
          create_order_v3_order_post: 4,
          get_order_v3_order__order_id__get: 3,
          simulate_order_v3_order__order_id__test_post: 3,
        },
        coverageBias: 5,
        forceInclude: ["get_result_raw_v3_order__order_id__result_get"],
        only: PARITY_OPS.filter(
          (id) =>
            !id.includes("area_info") &&
            !id.includes("psc_info") &&
            !id.includes("appointment") &&
            !id.includes("result_pdf"),
        ),
      })
    } else {
      await seedParity({
        ...shared,
        warmupCommands: cliOptions.warmup ?? DEFAULT_WARMUP,
        compareCommands: cliOptions.compare ?? cliOptions.steps ?? DEFAULT_COMPARE,
        ...(cliOptions.skipPrefetch
          ? {}
          : {
              prefetchObservations: async ({ real, getCache }) => {
                if (!sharedGeoCache) {
                  sharedGeoCache = new Map()
                  console.log(
                    `junction parity: prefetching the coverage corpus (${COVERAGE_ZIPS.length} area zips, ${PHLEBOTOMY_AVAILABILITY_ZIPS.length} phlebotomy, ${PSC_AVAILABILITY_ZIPS.length} psc scheduling)…`,
                  )
                  await prefetchCoverageObservations({
                    real,
                    getCache: sharedGeoCache,
                    schedulingZips: PSC_AVAILABILITY_ZIPS,
                    phlebotomyZips: PHLEBOTOMY_AVAILABILITY_ZIPS,
                    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
                    sleep: (ms) => Bun.sleep(ms),
                  })
                  console.log(
                    `junction parity: sealed ${sharedGeoCache.size} observation cache entries`,
                  )
                }
                // Seal-once: fill missing keys only. Walk-local warmup observations are
                // authoritative — their booking keys are the ones paired into the walk's
                // resource table, and the oracle rotates booking_key per serve, so a
                // prefetch copy of the same request must never clobber them.
                for (const [key, entry] of sharedGeoCache) {
                  if (!getCache.has(key)) getCache.set(key, entry)
                }
              },
            }),
        seedMock: async ({ mock, real, getCache, table }) => {
          const api = mock as JunctionAPI
          const source = {
            fetch: (request: Request) => real.fetch(request),
            baseUrl: real.baseUrl,
            headers: await real.headers(),
          }
          await api.seedFrom(source, { getCache })
          const labTestIds = table
            .all()
            .filter((resource) => resource.type === "lab_test")
            .map((resource) => resource.ids.real ?? resource.ids.mock)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
          await api.ensureLabTests(source, labTestIds)
          const orderIds = table
            .all()
            .filter((resource) => resource.type === "order")
            .map((resource) => resource.ids.real ?? resource.ids.mock)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
          await api.ensureOrders(source, orderIds)
          for (const resource of table.all()) {
            if (resource.type !== "user" || resource.status !== "deleted") continue
            const id = resource.ids.real ?? resource.ids.mock
            if (id) api.markUserDeleted(id)
          }
        },
      })
    }
    return true
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
    if (seed !== undefined) await recordFailedSeed(seed, error)
    return false
  }
}

const envSeedRaw = Bun.env.FC_SEED
const envSeed =
  envSeedRaw === undefined || envSeedRaw.trim() === "" ? undefined : Number(envSeedRaw)
if (envSeed !== undefined && !Number.isInteger(envSeed)) {
  console.error(`junction parity: FC_SEED must be an integer, got ${JSON.stringify(envSeedRaw)}`)
  process.exit(2)
}

const readLastFailedSeed = async () => {
  try {
    const value = (await readFile(LAST_FAILED_SEED_PATH, "utf8")).trim()
    const seed = Number(value)
    return Number.isSafeInteger(seed) ? seed : undefined
  } catch {
    return undefined
  }
}

const writeLastFailedSeed = async (seed: number) => {
  await mkdir(FAILURE_STATE_DIR, { recursive: true })
  await writeFile(LAST_FAILED_SEED_PATH, `${seed}\n`)
}

const recordFailedSeed = async (seed: number, error: unknown) => {
  const raw = await readFile(FAILURE_REGISTRY_PATH, "utf8")
  const registry = JSON.parse(raw) as {
    description: string
    entries: Array<{ provider: string; seed: number; status: string; failure: string }>
  }
  if (registry.entries.some((entry) => entry.provider === "junction" && entry.seed === seed)) return
  const failure =
    error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error)
  registry.entries.push({ provider: "junction", seed, status: "unfixed", failure })
  await writeFile(FAILURE_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`)
}

const clearLastFailedSeed = async () => {
  await rm(LAST_FAILED_SEED_PATH, { force: true })
}

// ── lab-account routing probes ───────────────────────────────────────────────────────────────
// What the sandbox does with an order that names another lab's account (#138), that omits
// `lab_account_id` while several active accounts are linked for the lab (#136), and that names
// an account with an empty `team_id_allowlist` (README open question). A control order through
// the test's own lab account shows the body itself is orderable. Every order is cancelled and
// the user deleted afterwards. Recorded (ids replaced) to corpus/lab-account-probes.json.
type ProbeAccount = {
  id: string
  lab: string
  status: string
  org_id: string | null
  team_id_allowlist: string[]
}
type ProbeTest = { id: string; lab?: { slug?: string }; is_active?: boolean; method?: string }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const probeLabAccounts = async () => {
  const redact = createRedactor(credentials.secrets)
  const scrub = (value: unknown): unknown =>
    JSON.parse(redact(JSON.stringify(value ?? null)).replace(UUID, "<uuid>"))
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...authHeaders,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let json: unknown = text
    try {
      json = text.length > 0 ? JSON.parse(text) : null
    } catch {}
    await Bun.sleep(DEFAULT_MIN_INTERVAL_MS * 4)
    return { status: response.status, body: json }
  }
  const accounts = (
    (await call("GET", "/v3/lab_test/lab_account")).body as { data?: ProbeAccount[] }
  ).data
  const tests = ((await call("GET", "/v3/lab_test")).body as { data?: ProbeTest[] }).data
  if (!Array.isArray(accounts) || !Array.isArray(tests)) {
    console.warn("junction lab-account probes: could not list lab accounts or lab tests")
    return
  }
  const active = accounts.filter((account) => account.status === "active")
  const labOf = (test: ProbeTest) => String(test.lab?.slug ?? "").toLowerCase()
  const orderable = tests.filter((test) => test.is_active !== false && labOf(test) !== "")
  const testFor = (lab: string) => orderable.find((test) => labOf(test) === lab)
  const byLab = new Map<string, ProbeAccount[]>()
  for (const account of active) {
    byLab.set(account.lab, [...(byLab.get(account.lab) ?? []), account])
  }
  const probes: {
    name: string
    issue: string | null
    lab: string
    account: { lab: string; org_id: string | null; team_id_allowlist: string[] } | null
    request: { lab_account_id: "<uuid>" | undefined }
    status: number
    body: unknown
  }[] = []
  const created = await call("POST", "/v2/user", {
    client_user_id: `mockingbird-lab-account-probe-${Date.now().toString(36)}`,
  })
  const userId = (created.body as { user_id?: string } | null)?.user_id
  if (typeof userId !== "string") {
    console.warn(`junction lab-account probes: could not create a user (${created.status})`)
    return
  }
  const orders: string[] = []
  const order = async (
    name: string,
    issue: string | null,
    test: ProbeTest,
    account: ProbeAccount | null,
    withId: boolean,
  ) => {
    const reply = await call("POST", "/v3/order", {
      user_id: userId,
      patient_details: {
        first_name: "Mockingbird",
        last_name: "Probe",
        dob: "1990-01-01",
        gender: "female",
        phone_number: "+14155551234",
        email: "probe@example.com",
      },
      patient_address: {
        first_line: "1 Main St",
        city: "San Diego",
        state: "CA",
        zip: "92101",
        country: "US",
      },
      order_set: { lab_test_ids: [test.id] },
      ...(withId && account ? { lab_account_id: account.id } : {}),
    })
    const id = (reply.body as { order?: { id?: unknown } } | null)?.order?.id
    if (typeof id === "string") orders.push(id)
    probes.push({
      name,
      issue,
      lab: labOf(test),
      account: account
        ? {
            lab: account.lab,
            org_id: account.org_id === null ? null : "<uuid>",
            team_id_allowlist: account.team_id_allowlist.map(() => "<uuid>"),
          }
        : null,
      request: { lab_account_id: withId ? "<uuid>" : undefined },
      status: reply.status,
      body: scrub(reply.body),
    })
    console.log(
      `junction lab-account probe: ${name} → ${reply.status} ${JSON.stringify(scrub(reply.body)).slice(0, 200)}`,
    )
  }
  try {
    // Control: the test's own lab account, named.
    const own = active
      .map((account) => [account, testFor(account.lab)] as const)
      .find(([, test]) => test)
    if (own?.[1]) await order("own-lab account by id", null, own[1], own[0], true)
    // #138: another lab's account named for this test.
    const cross = orderable
      .map((test) => [test, active.find((account) => account.lab !== labOf(test))] as const)
      .find(([, account]) => account)
    if (cross?.[1]) await order("another lab's account by id", "#138", cross[0], cross[1], true)
    // #136: id omitted while several active accounts are linked for the lab.
    const several = [...byLab.entries()].find(([lab, list]) => list.length > 1 && testFor(lab))
    if (several) {
      const test = testFor(several[0]) as ProbeTest
      await order(
        `id omitted with ${several[1].length} active accounts for ${several[0]}`,
        "#136",
        test,
        null,
        false,
      )
    }
    // Open question: an account with an empty allowlist, by id and with the id omitted.
    const open = active
      .filter((account) => account.team_id_allowlist.length === 0)
      .map((account) => [account, testFor(account.lab)] as const)
      .find(([, test]) => test)
    if (open?.[1]) {
      await order("empty-allowlist account by id", null, open[1], open[0], true)
      await order(
        `id omitted for ${open[0].lab} (${(byLab.get(open[0].lab) ?? []).length} active)`,
        null,
        open[1],
        open[0],
        false,
      )
    }
  } finally {
    for (const id of orders) await call("POST", `/v3/order/${id}/cancel`).catch(() => undefined)
    await call("DELETE", `/v2/user/${userId}`).catch(() => undefined)
  }
  const recorded = {
    source: new URL(baseUrl).host,
    note: "Recorded by scripts/parity.ts: how the sandbox routes create-order by lab account (ids replaced). Orders were cancelled and the user deleted in the same run.",
    accounts: active.map((account) => ({
      lab: account.lab,
      org_id: account.org_id === null ? null : "<uuid>",
      team_id_allowlist: account.team_id_allowlist.map(() => "<uuid>"),
    })),
    labs: [...new Set(orderable.map(labOf))].sort(),
    probes,
  }
  const corpusDir = join(import.meta.dir, "..", "corpus")
  await mkdir(corpusDir, { recursive: true })
  await writeFile(
    join(corpusDir, "lab-account-probes.json"),
    `${JSON.stringify(recorded, null, 2)}\n`,
  )
  console.log(
    `junction lab-account probes: wrote corpus/lab-account-probes.json (${probes.length} probes)`,
  )
}
try {
  await probeLabAccounts()
} catch (error) {
  console.warn(
    `junction lab-account probes: skipped (${error instanceof Error ? error.message : String(error)})`,
  )
}

const lastFailedSeed = envSeed === undefined ? await readLastFailedSeed() : undefined
const seeds =
  envSeed !== undefined ? [envSeed] : lastFailedSeed !== undefined ? [lastFailedSeed] : PARITY_SEEDS
let ok = true
for (const seed of seeds) {
  const passed = await runSeed(seed)
  if (!passed) {
    await writeLastFailedSeed(seed)
    await recordFailedSeed(seed, "parity failure")
    ok = false
    break
  }
  await clearLastFailedSeed()
}
if (!ok) process.exit(1)
