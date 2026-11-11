#!/usr/bin/env node
import type { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import {
  createInstalledServiceLoader,
  fleetCommands,
  isDeclaration,
  localFleetConfig,
  type MockingbirdConfig,
  parseDeclaration,
  runCli,
} from "@crvouga/mockingbird-adapter-node"
import { parse as parseYaml } from "yaml"
import { DASHBOARD_PORT } from "./dashboard.js"
import { startFleet } from "./index.js"

const projectRoot = process.cwd()

/** A configuration file as data: YAML or JSON (YAML is a superset, so one parser reads both). */
const readDocument = async (path: string): Promise<unknown> =>
  parseYaml(await readFile(path, "utf8"))

/**
 * The fleet to run locally. `mockingbird.yaml` (a declaration of an organization's fleets, the
 * file Fleet Cloud applies) and a plain local fleet configuration are both accepted.
 */
async function localConfig(path: string, fleet: unknown): Promise<MockingbirdConfig> {
  const document = await readDocument(path)
  if (!isDeclaration(document)) {
    if (fleet !== undefined) throw new Error("--fleet applies to a mockingbird.yaml declaration")
    return document as MockingbirdConfig
  }
  return localFleetConfig(parseDeclaration(document), typeof fleet === "string" ? fleet : undefined)
}

type Change = { action: string; kind: string; name: string; detail?: string }

/** Send `mockingbird.yaml` to Fleet Cloud and print what changed, or would. */
async function sendDeclaration(values: Record<string, unknown>, dryRun: boolean): Promise<number> {
  const file = typeof values.file === "string" ? values.file : "mockingbird.yaml"
  const url = (
    typeof values.url === "string" ? values.url : process.env.MOCKINGBIRD_FLEET_URL
  )?.replace(/\/+$/, "")
  const token =
    process.env[
      typeof values["token-env"] === "string" ? values["token-env"] : "MOCKINGBIRD_FLEET_TOKEN"
    ]
  if (!url) throw new Error("Fleet Cloud URL required: --url or MOCKINGBIRD_FLEET_URL")
  if (!token)
    throw new Error(
      "Credential required: set MOCKINGBIRD_FLEET_TOKEN to a personal token or an admin API key",
    )
  // Checked here first, so a typo is reported with its path before anything is sent.
  const declaration = parseDeclaration(await readDocument(file))
  const query = new URLSearchParams({
    ...(dryRun ? { dryRun: "true" } : {}),
    ...(values.prune ? { prune: "true" } : {}),
  })
  const response = await fetch(`${url}/api/v1/manifest?${query}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(declaration),
  }).catch((error: unknown) => {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    throw new Error(
      `Could not reach Fleet Cloud at ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  })
  const body = (await response.json().catch(() => ({}))) as {
    changes?: Change[]
    applied?: boolean
    error?: { message?: string }
  }
  const changes = (body.changes ?? []).filter((change) => change.action !== "unchanged")
  // With --json, standard output is the result and nothing else, so it can be piped to a parser.
  if (!(values.json && response.ok))
    for (const change of changes)
      console.log(
        `${{ create: "+", update: "~", delete: "-" }[change.action] ?? "?"} ${change.kind} ${change.name}${change.detail ? `  (${change.detail})` : ""}`,
      )
  if (!response.ok) {
    console.error(body.error?.message ?? `Fleet Cloud answered HTTP ${response.status}`)
    return 1
  }
  if (values.json) console.log(JSON.stringify(body))
  else if (changes.length === 0) console.log(`${file}: nothing to change`)
  else
    console.log(
      `${file}: ${changes.length} change${changes.length === 1 ? "" : "s"} ${dryRun ? "planned" : "applied"}`,
    )
  return 0
}

const declarationOptions = {
  file: { type: "string", description: "Declaration file (default: mockingbird.yaml)" },
  url: { type: "string", description: "Fleet Cloud origin (env MOCKINGBIRD_FLEET_URL)" },
  "token-env": {
    type: "string",
    description: "Variable holding the credential (default MOCKINGBIRD_FLEET_TOKEN)",
  },
  prune: {
    type: "boolean",
    description: "Also delete projects, fleets and emulators the file no longer declares",
  },
  json: { type: "boolean", description: "Print the full result as JSON" },
} as const
const load = (name: string) => createInstalledServiceLoader({ projectRoot, services: [name] })(name)
const main = () =>
  runCli(
    {
      bin: "mockingbird-fleet",
      description: "Run and manage installed Mockingbird emulators",
      commands: {
        ...fleetCommands(load),
        plan: {
          summary: "Show what applying mockingbird.yaml to Fleet Cloud would change",
          options: declarationOptions,
          run: (values) => sendDeclaration(values, true),
        },
        apply: {
          summary: "Make Fleet Cloud match mockingbird.yaml",
          options: declarationOptions,
          run: (values) => sendDeclaration(values, false),
        },
        serve: {
          summary: "Start a fleet locally from mockingbird.yaml or a fleet configuration",
          options: {
            config: {
              type: "string",
              description: "mockingbird.yaml, or a fleet configuration in YAML or JSON (required)",
            },
            fleet: {
              type: "string",
              description: "Which fleet of mockingbird.yaml to run, when it declares several",
            },
            "project-root": { type: "string", description: "Consumer package root (default: cwd)" },
            "ready-json": { type: "boolean", description: "Print public readiness JSON" },
            "ready-file": { type: "string", description: "Atomic public readiness file" },
            "connections-file": { type: "string", description: "Private connection file (0600)" },
            dashboard: {
              type: "boolean",
              description:
                "Also serve the dashboard: every emulator's admin UI and the notifications UI on one page",
            },
            "dashboard-port": {
              type: "string",
              description: `Dashboard port (default ${DASHBOARD_PORT}; 0 picks a free one). Implies --dashboard`,
            },
          },
          async run(values) {
            if (typeof values.config !== "string") throw new Error("--config required")
            const config = await localConfig(values.config, values.fleet)
            if (!config.adminKey && process.env.MOCKINGBIRD_ADMIN_KEY)
              config.adminKey = process.env.MOCKINGBIRD_ADMIN_KEY
            const dashboardPort =
              values["dashboard-port"] === undefined ? undefined : Number(values["dashboard-port"])
            if (
              dashboardPort !== undefined &&
              (!Number.isInteger(dashboardPort) || dashboardPort < 0 || dashboardPort > 65535)
            )
              throw new Error("--dashboard-port: expected 0-65535")
            // Flags win over the file: the port alone turns the dashboard on.
            if (values.dashboard || dashboardPort !== undefined)
              config.dashboard = {
                ...(typeof config.dashboard === "object" ? config.dashboard : {}),
                ...(dashboardPort !== undefined ? { port: dashboardPort } : {}),
              }
            const fleet = await startFleet(config, {
              load: createInstalledServiceLoader({
                projectRoot:
                  typeof values["project-root"] === "string" ? values["project-root"] : projectRoot,
                services: Object.entries(config.services).map(
                  ([name, entry]) => entry.target ?? name,
                ),
              }),
              ...(typeof values["ready-file"] === "string"
                ? { readyFile: values["ready-file"] }
                : {}),
              ...(typeof values["connections-file"] === "string"
                ? { connectionsFile: values["connections-file"] }
                : {}),
              onReady(manifest) {
                if (values["ready-json"]) console.log(JSON.stringify(manifest))
                else {
                  console.log(`fleet ready: ${manifest.adminBase}`)
                  if (manifest.dashboard) console.log(`dashboard:   ${manifest.dashboard}`)
                }
              },
            })
            return await new Promise<number>((resolve, reject) => {
              const stop = () => {
                ;(process as EventEmitter).removeListener("SIGINT", stop)
                ;(process as EventEmitter).removeListener("SIGTERM", stop)
                void fleet.close().then(() => resolve(0), reject)
              }
              process.once("SIGINT", stop)
              process.once("SIGTERM", stop)
            })
          },
        },
      },
    },
    process.argv.slice(2),
  )
// A mistake in a file, a flag or the environment is a message and exit code 1, not a stack trace.
process.exitCode = await main().catch((error: unknown) => {
  console.error(`mockingbird-fleet: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
