#!/usr/bin/env node
/// <reference types="node" />
import { readFile, writeFile } from "node:fs/promises"
import { type CliValues, runCli, serveCommand } from "@crvouga/mockingbird-adapter-node"
import { defaultCorpus } from "./corpus.js"
import { DEFAULT_JUNCTION_BASE_URL, diffCorpus, isSandboxKey, pullCorpus } from "./corpus-tools.js"
import { createRuntime } from "./runtime.js"
import { parseSealedCorpus, type SealedCorpus } from "./sealed-corpus.js"
import { loadCorpus, serveTarget } from "./server.js"
import { verifyAgainstReal } from "./verify.js"

const asString = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const realKeyOf = (values: CliValues): string | undefined =>
  asString(values["real-key"]) ??
  asString(process.env.JUNCTION_API_KEY) ??
  asString(process.env.JUNCTION_API_KEY)

const readCorpus = async (source: string): Promise<SealedCorpus> =>
  source === "default"
    ? defaultCorpus
    : parseSealedCorpus(JSON.parse(await readFile(source, "utf8")))

const guardKey = (key: string | undefined, values: CliValues): string | undefined => {
  if (key === undefined) {
    console.error("missing --real-key (or env JUNCTION_API_KEY)")
    return undefined
  }
  if (!isSandboxKey(key) && values["allow-any-key"] !== true) {
    console.error(
      "refusing a key that is not a sandbox team key (sk_us_… / sk_eu_…); pass --allow-any-key to override",
    )
    return undefined
  }
  return key
}

const REAL_OPTIONS = {
  "real-key": {
    type: "string",
    value: "<key>",
    description: "Junction API key (env JUNCTION_API_KEY)",
  },
  "real-url": {
    type: "string",
    value: "<url>",
    description: "Junction API base URL",
    default: DEFAULT_JUNCTION_BASE_URL,
  },
  "allow-any-key": {
    type: "boolean",
    description: "Allow a key that is not a sandbox team key",
  },
} as const

const code = await runCli(
  {
    bin: "mockingbird-junction",
    description: "stateful Junction (Vital) API mock",
    commands: {
      serve: serveCommand(serveTarget),

      "corpus pull": {
        summary: "Record a corpus from a real Junction team (read-only GETs)",
        usage: "mockingbird-junction corpus pull --out <file> [--zip 10001,94105] [--base <file>]",
        options: {
          ...REAL_OPTIONS,
          out: { type: "string", value: "<file>", description: "Where to write the corpus" },
          zip: {
            type: "string",
            value: "<zip,zip,…>",
            description: "ZIPs to record coverage for (default: the shipped set)",
          },
          base: {
            type: "string",
            value: "<file|default>",
            description: "Only refresh --zip on top of this corpus",
          },
          "coverage-only": {
            type: "boolean",
            description: "Skip the team's catalog and lab accounts",
          },
        },
        async run(values) {
          const key = guardKey(realKeyOf(values), values)
          if (key === undefined) return 2
          const out = asString(values.out)
          if (out === undefined) {
            console.error("missing --out <file>")
            return 2
          }
          const zips = asString(values.zip)
            ?.split(",")
            .map((zip) => zip.trim())
            .filter(Boolean)
          if (zips?.some((zip) => !/^\d{5}$/.test(zip))) {
            console.error("--zip takes comma-separated 5-digit ZIPs")
            return 2
          }
          const baseSource = asString(values.base)
          const corpus = await pullCorpus({
            apiKey: key,
            baseUrl: asString(values["real-url"]) ?? DEFAULT_JUNCTION_BASE_URL,
            ...(zips ? { zips } : {}),
            ...(baseSource ? { base: await readCorpus(baseSource) } : {}),
            coverageOnly: values["coverage-only"] === true,
            onProgress: (message) => console.log(`corpus pull: ${message}`),
          })
          await writeFile(out, `${JSON.stringify(corpus, null, 2)}\n`)
          console.log(
            `corpus pull: wrote ${out} — ${Object.keys(corpus.observations).length} observations, ${corpus.catalog.labTests.length} lab tests, ${corpus.labAccounts.length} lab accounts, fingerprint ${corpus.fingerprint?.slice(0, 12)}`,
          )
          return 0
        },
      },

      "corpus diff": {
        summary: "Show what changed between two corpora (exit 1 when they differ)",
        usage: "mockingbird-junction corpus diff <before|default> <after|default> [--json]",
        options: { json: { type: "boolean", description: "Print the diff as JSON" } },
        async run(values, positionals) {
          const [beforePath, afterPath] = positionals
          if (beforePath === undefined || afterPath === undefined) {
            console.error("usage: mockingbird-junction corpus diff <before> <after>")
            return 2
          }
          const diff = diffCorpus(await readCorpus(beforePath), await readCorpus(afterPath))
          if (values.json === true) {
            console.log(JSON.stringify(diff, null, 2))
            return diff.identical ? 0 : 1
          }
          if (diff.identical) {
            console.log("corpora are identical")
            return 0
          }
          const section = (
            title: string,
            d: { added: string[]; removed: string[]; changed?: string[] },
          ) => {
            const total = d.added.length + d.removed.length + (d.changed?.length ?? 0)
            if (total === 0) return
            console.log(`${title}:`)
            for (const id of d.added) console.log(`  + ${id}`)
            for (const id of d.removed) console.log(`  - ${id}`)
            for (const id of d.changed ?? []) console.log(`  ~ ${id}`)
          }
          section("ZIPs", diff.zips)
          section("lab tests", diff.labTests)
          section("lab accounts", diff.labAccounts)
          const o = diff.observations
          console.log(
            `observations: +${o.added.length} -${o.removed.length} ~${o.changed.length} (--json lists them)`,
          )
          return 1
        },
      },

      verify: {
        summary: "Replay the corpus and a stateful scenario against real Junction and the mock",
        usage: "mockingbird-junction verify --real-key <sk_us_…> [--corpus <file>] [--orders]",
        options: {
          ...REAL_OPTIONS,
          corpus: {
            type: "string",
            value: "<default|file>",
            description: "Corpus the mock serves and drift is checked against",
            default: "default",
          },
          sample: {
            type: "string",
            value: "<n>",
            description: "Re-fetch at most n recorded observations (default: all)",
          },
          "skip-drift": { type: "boolean", description: "Only run the stateful scenario" },
          orders: {
            type: "boolean",
            description: "Also place and cancel an order on the real team",
          },
          json: { type: "boolean", description: "Print the report as JSON" },
        },
        async run(values) {
          const key = guardKey(realKeyOf(values), values)
          if (key === undefined) return 2
          const corpus = await loadCorpus(asString(values.corpus) ?? "default")
          if (!corpus) {
            console.error("verify needs a corpus (--corpus default or a file)")
            return 2
          }
          const sample = asString(values.sample)
          const report = await verifyAgainstReal({
            realKey: key,
            realUrl: asString(values["real-url"]) ?? DEFAULT_JUNCTION_BASE_URL,
            mock: createRuntime({ corpus }),
            corpus,
            ...(sample !== undefined ? { sample: Number.parseInt(sample, 10) } : {}),
            skipDrift: values["skip-drift"] === true,
            orders: values.orders === true,
            ...(values.json === true
              ? {}
              : { onProgress: (message: string) => console.log(`verify: ${message}`) }),
          })
          if (values.json === true) {
            console.log(JSON.stringify(report, null, 2))
          } else {
            for (const d of report.divergences) {
              console.log(`DIVERGED ${d.check} (${d.kind}${d.at ? ` at ${d.at}` : ""})`)
              console.log(`  real: ${JSON.stringify(d.real)?.slice(0, 400)}`)
              console.log(`  mock: ${JSON.stringify(d.mock)?.slice(0, 400)}`)
            }
            console.log(
              `verify: drift ${report.drift.stale}/${report.drift.checked} stale; scenario ${report.scenario.divergent}/${report.scenario.steps} divergent — ${report.ok ? "OK" : "DIVERGED"}`,
            )
          }
          return report.ok ? 0 : 1
        },
      },
    },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
