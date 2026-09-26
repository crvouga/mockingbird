/// <reference types="node" />
import { readFile } from "node:fs/promises"
import {
  type CliValues,
  type Listening,
  listen,
  type ServeTarget,
} from "@crvouga/mockingbird-adapter-node"
import { defaultCorpus } from "./corpus.js"
import { pullCorpus } from "./corpus-tools.js"
import { IDENTITY_MODES, type IdentityMode, type JunctionFixtures } from "./fixtures.js"
import type { LabAccountLayout } from "./lab-account-presets.js"
import { type BillingType, defaultBillingTypesFrom } from "./lab-accounts.js"
import { createRuntime, type JunctionRuntime, type JunctionRuntimeOptions } from "./runtime.js"
import { parseSealedCorpus, type SealedCorpus } from "./sealed-corpus.js"
import type { GeoMode } from "./state.js"

/** Port `mockingbird-junction serve` listens on when none is given. */
export const DEFAULT_PORT = 8787

/** A corpus to serve: the shipped one, none (synthetic), a file path, or a loaded corpus. */
export type CorpusSource = "default" | "none" | (string & {}) | SealedCorpus

export type JunctionServerOptions = Omit<JunctionRuntimeOptions, "corpus"> & {
  /** Default `0`: the OS picks a free port (read it from `url` / `port`). */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
  /** Default `"default"`: the corpus shipped with this package. */
  corpus?: CorpusSource
}

export type JunctionServer = Listening & { runtime: JunctionRuntime }

/** Resolve a {@link CorpusSource} to a corpus, or `undefined` for synthetic data. */
export const loadCorpus = async (source: CorpusSource): Promise<SealedCorpus | undefined> => {
  if (typeof source !== "string") return source
  if (source === "none") return undefined
  if (source === "default") return defaultCorpus
  const raw = await readFile(source, "utf8").catch(() => undefined)
  if (raw === undefined) throw new Error(`junction mock corpus not found: ${source}`)
  return parseSealedCorpus(JSON.parse(raw))
}

/**
 * Serve the Junction mock over `node:http`. Resolves once it is listening.
 *
 *   const server = await createServer()
 *   // point the Vital SDK at server.url; await server.close() when done
 */
export const createServer = async (
  options: JunctionServerOptions = {},
): Promise<JunctionServer> => {
  const { port, host, corpus: source, ...rest } = options
  const corpus = await loadCorpus(source ?? "default")
  const runtime = createRuntime({ ...rest, ...(corpus ? { corpus } : {}) })
  const listening = await listen(runtime, {
    port: port ?? 0,
    ...(host !== undefined ? { host } : {}),
  })
  return { ...listening, runtime }
}

const asString = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const count = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a non-negative integer (got ${value})`)
  return Number.parseInt(value, 10)
}

const readJson = async <T>(path: string): Promise<T> => {
  const raw = await readFile(path, "utf8").catch(() => undefined)
  if (raw === undefined) throw new Error(`junction mock: file not found: ${path}`)
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`junction mock: ${path} is not JSON (${(error as Error).message})`)
  }
}

const retryDelays = (value: string | undefined): number[] | undefined => {
  if (value === undefined) return undefined
  const delays = value.split(",").map((part) => Number.parseInt(part.trim(), 10))
  if (delays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error(`--webhook-retry-delays must be comma-separated milliseconds (got ${value})`)
  }
  return delays
}

/** `--default-billing-type bioreference=patient_bill_passthrough,quest=client_bill`. */
const billingDefaults = (value: string | undefined): Record<string, BillingType> | undefined => {
  if (value === undefined) return undefined
  const entries = value.split(",").map((part) => part.split("=").map((side) => side.trim()))
  if (entries.some((entry) => entry.length !== 2 || !entry[0] || !entry[1])) {
    throw new Error(`--default-billing-type must be lab=billing_type pairs (got ${value})`)
  }
  try {
    return defaultBillingTypesFrom(Object.fromEntries(entries))
  } catch (error) {
    throw new Error(`--default-billing-type: ${(error as Error).message}`)
  }
}

/** How `serve` (and `serve --config`) builds the Junction mock from flags. */
export const serveTarget: ServeTarget = {
  name: "junction",
  defaultPort: DEFAULT_PORT,
  options: {
    corpus: {
      type: "string",
      value: "<default|none|file>",
      description: "Corpus to serve: the shipped one, none (synthetic), or a pulled file",
      default: "default",
    },
    geo: {
      type: "string",
      value: "<corpus|synthetic>",
      description: "Unknown ZIPs: refuse (corpus) or invent coverage (synthetic)",
    },
    "lab-accounts": {
      type: "string",
      value: "<file>",
      description:
        'Lab accounts to route orders through: a JSON array, or { "presets": [...], "accounts": [...] }',
    },
    "team-id": {
      type: "string",
      value: "<uuid>",
      description: "Team the mock answers as (default: the corpus's recorded team)",
    },
    "max-users": {
      type: "string",
      value: "<n>",
      description: "Enforce the sandbox's live-user cap (default: unlimited)",
    },
    identity: {
      type: "string",
      value: "<strict|adopt-users>",
      description: "Unknown user ids: 404 (strict) or create on first use",
      default: "strict",
    },
    "default-billing-type": {
      type: "string",
      value: "<lab=type,…>",
      description:
        "billing_type an order for that lab gets when it omits one (default: client_bill), e.g. bioreference=patient_bill_passthrough",
    },
    fixtures: {
      type: "string",
      value: "<file>",
      description:
        'Users and orders every namespace starts with: { "users": [...], "orders": [...] }',
    },
    "journal-size": {
      type: "string",
      value: "<n>",
      description: "Requests each namespace's journal keeps (GET /__admin/requests)",
      default: "1000",
    },
    "seed-url": {
      type: "string",
      value: "<url>",
      description: "Pull a corpus from this Junction team at boot (prefer a committed corpus)",
    },
    "seed-key": {
      type: "string",
      value: "<key>",
      description: "API key for --seed-url (env MOCKINGBIRD_JUNCTION_SEED_KEY)",
    },
    "webhook-url": { type: "string", value: "<url>", description: "Deliver signed webhooks here" },
    "webhook-secret": {
      type: "string",
      value: "<whsec_…>",
      description: "Svix signing secret (env MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET)",
    },
    "webhook-retry-delays": {
      type: "string",
      value: "<ms,ms,…>",
      description: "Delay before each delivery attempt (default: Svix's schedule)",
    },
    "webhook-scope": {
      type: "string",
      value: "<scope>",
      description: "Sent as x-mockingbird-scope on every delivery",
    },
  },
  async create(values: CliValues, common) {
    const seedUrl = asString(values["seed-url"])
    const seedKey = asString(values["seed-key"]) ?? process.env.MOCKINGBIRD_JUNCTION_SEED_KEY
    let corpus: SealedCorpus | undefined
    if (seedUrl !== undefined) {
      if (seedKey === undefined) throw new Error("--seed-url needs --seed-key")
      console.log(
        `junction pulling a corpus from ${seedUrl} (commit one with \`corpus pull\` to skip this)`,
      )
      corpus = await pullCorpus({ baseUrl: seedUrl, apiKey: seedKey })
    } else {
      corpus = await loadCorpus(asString(values.corpus) ?? "default")
    }
    const geo = asString(values.geo)
    if (geo !== undefined && geo !== "corpus" && geo !== "synthetic") {
      throw new Error(`--geo must be corpus or synthetic (got ${geo})`)
    }
    const accountsFile = asString(values["lab-accounts"])
    const labAccounts =
      accountsFile === undefined ? undefined : await readJson<LabAccountLayout>(accountsFile)
    const fixturesFile = asString(values.fixtures)
    const fixtures =
      fixturesFile === undefined ? undefined : await readJson<JunctionFixtures>(fixturesFile)
    const teamId = asString(values["team-id"])
    if (teamId !== undefined && !UUID.test(teamId)) {
      throw new Error(`--team-id must be a UUID (got ${teamId})`)
    }
    const maxUsers = count(asString(values["max-users"]), "--max-users")
    const journalSize = count(asString(values["journal-size"]), "--journal-size")
    const identity = asString(values.identity)
    if (identity !== undefined && !IDENTITY_MODES.includes(identity as IdentityMode)) {
      throw new Error(`--identity must be one of ${IDENTITY_MODES.join(", ")} (got ${identity})`)
    }
    const defaultBillingTypes = billingDefaults(asString(values["default-billing-type"]))
    const webhookUrl = asString(values["webhook-url"])
    const webhookSecret =
      asString(values["webhook-secret"]) ?? process.env.MOCKINGBIRD_JUNCTION_WEBHOOK_SECRET
    if (webhookUrl !== undefined && webhookSecret === undefined) {
      throw new Error("--webhook-url needs --webhook-secret (the whsec_… your receiver verifies)")
    }
    const delays = retryDelays(asString(values["webhook-retry-delays"]))
    const scope = asString(values["webhook-scope"])
    return createRuntime({
      ...(corpus ? { corpus } : {}),
      ...(geo ? { geo: geo as GeoMode } : {}),
      ...(labAccounts ? { labAccounts } : {}),
      ...(fixtures ? { fixtures } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
      ...(maxUsers !== undefined ? { limits: { maxUsers } } : {}),
      ...(identity !== undefined ? { identity: identity as IdentityMode } : {}),
      ...(defaultBillingTypes ? { defaultBillingTypes } : {}),
      ...(journalSize !== undefined ? { journalSize } : {}),
      ...(webhookUrl !== undefined && webhookSecret !== undefined
        ? {
            webhooks: {
              url: webhookUrl,
              secret: webhookSecret,
              ...(delays ? { retryDelaysMs: delays } : {}),
              ...(scope ? { headers: { "x-mockingbird-scope": scope } } : {}),
            },
          }
        : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner(runtime) {
    const junction = runtime as JunctionRuntime
    const api = junction.instance()
    const info = api.corpusInfo()
    return [
      info
        ? `corpus ${info.label}: ${info.observations} observations, ${info.zips} ZIPs, ${info.labTests} lab tests, ${info.labAccounts} lab accounts (recorded ${info.recordedAt} from ${info.source})`
        : "corpus none: synthetic catalog and coverage",
      `geo ${api.geoMode}${api.geoMode === "corpus" ? " (unknown ZIPs answer 424 MOCKINGBIRD_UNKNOWN_ZIP)" : ""}`,
      `team ${api.teamId}`,
      `lab accounts: ${api.labAccounts().length}`,
      `limits: ${
        Object.entries(api.limits)
          .filter(([, value]) => value !== null && value !== false)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(", ") || "none (sandbox caps off)"
      }`,
      `identity ${api.identity}`,
      `webhooks: ${junction.webhooks ? "signed delivery on" : "off"}`,
      "auth: any x-vital-api-key value (e.g. sk_us_mockingbird)",
    ]
  },
}
