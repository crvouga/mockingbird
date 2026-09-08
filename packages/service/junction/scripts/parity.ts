import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { DEFAULT_PARITY_STEPS, DEFAULT_PROPERTY_RUNS } from "@crvouga/mockingbird-testing"
import { document, JunctionAPI } from "../src/index.js"

/** Docs: https://docs.junction.com/api-details/junction-api */
const JUNCTION_HOST = "api.sandbox.us.junction.com"
const TEST_KEY_PREFIXES = ["sk_us_", "sk_eu_"]
const DEFAULT_MIN_INTERVAL_MS = 50

type ParityCLIOptions = {
  runs?: number
  steps?: number
}

const parsePositiveInteger = (value: string, name: string): number => {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer, got ${value}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer, got ${value}`)
  return parsed
}

const parseCLIOptions = (args: readonly string[]): ParityCLIOptions => {
  const options: ParityCLIOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag !== "--runs" && flag !== "--steps") {
      throw new Error(`unknown parity option ${flag ?? ""}`)
    }
    const value = args[index + 1]
    if (value === undefined) throw new Error(`${flag} requires a value`)
    const parsed = parsePositiveInteger(value, flag)
    if (flag === "--runs") options.runs = parsed
    else options.steps = parsed
    index += 1
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

const baseUrl = Bun.env.MOCKINGBIRD_JUNCTION_BASE_URL ?? `https://${JUNCTION_HOST}`
const authHeaders = { "x-vital-api-key": apiKey }

const runSeed = async (seed: number | undefined) => {
  try {
    await parity({
      provider: "junction",
      spec: document,
      env: Bun.env,
      numRuns: cliOptions.runs ?? DEFAULT_PROPERTY_RUNS,
      maxCommands: cliOptions.steps ?? DEFAULT_PARITY_STEPS,
      only: [
        "create_user_v2_user_post",
        "get_user_v2_user__user_id__get",
        "delete_user_v2_user__user_id__delete",
        "get_user_by_client_user_id_v2_user_resolve__client_user_id__get",
        "patch_user_v2_user__user_id__patch",
        "get_paginated_lab_tests_for_team_v3_lab_test_get",
        "get_lab_test_for_team_v3_lab_tests__lab_test_id__get",
        "create_order_v3_order_post",
        "get_order_v3_order__order_id__get",
        "get_orders_v3_orders_get",
      ],
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
      webhooks: {
        collectReal: async (scope) => {
          const receiverUrl = Bun.env.MOCKINGBIRD_JUNCTION_WEBHOOK_RECEIVER_URL
          if (!receiverUrl) return []
          const response = await fetch(`${receiverUrl.replace(/\/$/, "")}/events/${scope.runId}`)
          if (!response.ok) throw new Error(`webhook receiver returned ${response.status}`)
          return (await response.json()) as readonly unknown[]
        },
        collectMock: async (mock) => (mock instanceof JunctionAPI ? mock.webhookEvents() : []),
      },
      redact: createRedactor(credentials.secrets),
      shrink: false,
      cleanup: async ({ table, real, scope }) => {
        for (const resource of table.all()) {
          const id = resource.ids.real
          if (id === undefined || resource.type !== "user") continue
          await real.fetch(
            new Request(`${real.baseUrl}/v2/user/${id}`, {
              method: "DELETE",
              headers: { ...authHeaders, "x-mockingbird-scope": scope.runId },
            }),
          )
        }
      },
      ...(seed === undefined ? {} : { seed }),
    })
    return true
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`)
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

const ok = await runSeed(envSeed)
if (!ok) process.exit(1)
