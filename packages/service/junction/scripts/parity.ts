import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Scope } from "@crvouga/mockingbird-commands"
import type { FetchAPI } from "@crvouga/mockingbird-core"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity, seedParity } from "@crvouga/mockingbird-parity"
import { DEFAULT_PARITY_STEPS, DEFAULT_PROPERTY_RUNS } from "@crvouga/mockingbird-testing"
import { document, JunctionAPI } from "../src/index.js"
import { PARITY_SEEDS } from "../src/seeds.js"

/** Docs: https://docs.junction.com/api-details/junction-api — Geviti QA uses tryvital.io */
const DEFAULT_JUNCTION_HOST = "api.sandbox.tryvital.io"
const FAILURE_STATE_DIR = ".parity-artifacts/junction"
const LAST_FAILED_SEED_PATH = `${FAILURE_STATE_DIR}/last-failed-seed`
const FAILURE_REGISTRY_PATH = join(import.meta.dir, "../../../../PARITY_FAILURE_SEED_REGISTRY.json")
const TEST_KEY_PREFIXES = ["sk_us_", "sk_eu_"]
const DEFAULT_MIN_INTERVAL_MS = 50
const DEFAULT_WARMUP = 15

type ParityMode = "seed" | "empty"

type ParityCLIOptions = {
  runs?: number
  steps?: number
  warmup?: number
  compare?: number
  mode: ParityMode
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
    if (
      flag !== "--runs" &&
      flag !== "--steps" &&
      flag !== "--warmup" &&
      flag !== "--compare"
    ) {
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

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

const credentials = await loadCredentials(
  {
    provider: "junction",
    fields: { MOCKINGBIRD_JUNCTION_API_KEY: "MOCKINGBIRD_JUNCTION_API_KEY" },
  },
  { env: Bun.env, readTokenFile },
)
const apiKey = credentials.values.MOCKINGBIRD_JUNCTION_API_KEY
if (!TEST_KEY_PREFIXES.some((prefix) => apiKey.startsWith(prefix))) {
  console.error("junction parity: refusing to run with a key that is not a sandbox team key")
  process.exit(2)
}

const baseUrl = Bun.env.MOCKINGBIRD_JUNCTION_BASE_URL ?? `https://${DEFAULT_JUNCTION_HOST}`
const webhookReceiverUrl = Bun.env.MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL?.replace(/\/$/, "")
const webhookParity =
  webhookReceiverUrl === undefined
    ? undefined
    : {
        collectReal: async (scope: Scope) => {
          const response = await fetch(`${webhookReceiverUrl}/events/${scope.runId}`)
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

/** Ops with parity.enabled=false that seedParity still exercises after observation seeding. */
const QA_FORCE_INCLUDE = [
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get",
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "get_result_raw_v3_order__order_id__result_get",
] as const

const QA_WEIGHTED_OPS = [
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
  "list_order_set_markers_v3_lab_tests_list_order_set_markers_post",
  "create_order_v3_order_post",
  "get_order_v3_order__order_id__get",
  "cancel_order_v3_order__order_id__cancel_post",
  "simulate_order_v3_order__order_id__test_post",
  "get_result_metadata_v3_order__order_id__result_metadata_get",
  "get_result_raw_v3_order__order_id__result_get",
  "get_orders_v3_orders_get",
  "get_area_info_v3_order_area_info_get",
  "get_psc_info_v3_order_psc_info_get",
  "get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post",
  "get_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_get",
  "book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post",
  "get_phlebotomy_appointment_cancellation_reason_v3_order_phlebotomy_appointment_cancellation_reasons_get",
  "get_psc_appointment_cancellation_reason_v3_order_psc_appointment_cancellation_reasons_get",
] as const

const QA_WEIGHTS: Record<string, number> = {
  create_user_v2_user_post: 3,
  create_order_v3_order_post: 4,
  get_order_v3_order__order_id__get: 3,
  get_area_info_v3_order_area_info_get: 4,
  get_psc_info_v3_order_psc_info_get: 4,
  simulate_order_v3_order__order_id__test_post: 3,
  get_orders_v3_orders_get: 2,
  delete_user_v2_user__user_id__delete: 2,
  cancel_order_v3_order__order_id__cancel_post: 2,
  get_phlebotomy_appointment_availability_v3_order_phlebotomy_appointment_availability_post: 3,
  book_phlebotomy_appointment_v3_order__order_id__phlebotomy_appointment_book_post: 3,
  get_result_raw_v3_order__order_id__result_get: 2,
}

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

const runSeed = async (seed: number | undefined) => {
  try {
    if (webhookReceiverUrl) {
      console.log(`junction webhook parity: enabled (${webhookReceiverUrl})`)
    } else {
      console.warn(
        "junction webhook parity: skipped; configure MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL with a deployed receiver URL, then register the webhook URL in the Junction sandbox dashboard using `bun run webhook:register`",
      )
    }
    console.log(`junction parity mode=${cliOptions.mode} oracle=${baseUrl}`)
    await clearSandboxUsers()
    await Bun.sleep(DEFAULT_MIN_INTERVAL_MS * 4)

    const shared = {
      provider: "junction",
      spec: document,
      env: Bun.env,
      numRuns: cliOptions.runs ?? DEFAULT_PROPERTY_RUNS,
      maxCommands: cliOptions.steps ?? DEFAULT_PARITY_STEPS,
      latencyToleranceMs: 500,
      only: [...QA_WEIGHTED_OPS],
      forceInclude: [...QA_FORCE_INCLUDE],
      weights: QA_WEIGHTS,
      coverageBias: 5,
      real: {
        baseUrl,
        allowedHosts: [new URL(baseUrl).host],
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
      await parity(shared)
    } else {
      await seedParity({
        ...shared,
        warmupCommands: cliOptions.warmup ?? DEFAULT_WARMUP,
        compareCommands: cliOptions.compare ?? cliOptions.steps ?? DEFAULT_PARITY_STEPS,
        seedMock: async ({ mock, real, getCache }) => {
          const api = mock as JunctionAPI
          await api.seedFrom(
            {
              fetch: (request) => real.fetch(request),
              baseUrl: real.baseUrl,
              headers: await real.headers(),
            },
            { getCache },
          )
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
