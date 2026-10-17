#!/usr/bin/env node
import type { EventEmitter } from "node:events"
import { readFile } from "node:fs/promises"
import {
  createInstalledServiceLoader,
  fleetCommands,
  type MockingbirdConfig,
  runCli,
  startFleet,
} from "@crvouga/mockingbird-adapter-node"

const projectRoot = process.cwd()
const load = (name: string) => createInstalledServiceLoader({ projectRoot, services: [name] })(name)
process.exitCode = await runCli(
  {
    bin: "mockingbird-fleet",
    description: "Run and manage installed Mockingbird emulators",
    commands: {
      ...fleetCommands(load),
      serve: {
        summary: "Start the declared fleet from a JSON configuration",
        options: {
          config: { type: "string", description: "Fleet JSON configuration (required)" },
          "project-root": { type: "string", description: "Consumer package root (default: cwd)" },
          "ready-json": { type: "boolean", description: "Print public readiness JSON" },
          "ready-file": { type: "string", description: "Atomic public readiness file" },
          "connections-file": { type: "string", description: "Private connection file (0600)" },
        },
        async run(values) {
          if (typeof values.config !== "string") throw new Error("--config required")
          const config = JSON.parse(await readFile(values.config, "utf8")) as MockingbirdConfig
          if (!config.adminKey && process.env.MOCKINGBIRD_ADMIN_KEY)
            config.adminKey = process.env.MOCKINGBIRD_ADMIN_KEY
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
              else console.log(`fleet ready: ${manifest.adminBase}`)
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
