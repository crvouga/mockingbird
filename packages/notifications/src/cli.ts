#!/usr/bin/env node
/// <reference types="node" />
import { parseArgs } from "node:util"
import type { ServiceInput } from "./discovery.js"
import { createServer, DEFAULT_PORT } from "./server.js"

const HELP = `mockingbird-notifications — see every SMS, email and push your app sends through Mockingbird

Usage:
  mockingbird-notifications serve [options]

Where the emulators are (pick one or combine):
  --fleet <url>        Running fleet controller adminBase, e.g. http://127.0.0.1:9000/__admin/fleet
  --manifest <file>    The fleet's --ready-file (re-read on every sync, so restarts are followed)
  --service <n=url>    An emulator by name, e.g. --service twilio=http://127.0.0.1:8798 (repeatable)

Options:
  --port <n>           Listen port (default ${DEFAULT_PORT}; 0 picks a free one)
  --host <host>        Listen host (default 127.0.0.1)
  --namespace <name>   Namespace to watch in the background (repeatable; default "default",
                       or every fleet namespace with --fleet)
  --poll <ms>          Background poll interval (default 750; 0 reads only on demand)
  --admin-key-env <V>  Environment variable holding the admin key (default MOCKINGBIRD_ADMIN_KEY)
  --tab <name>         Tab the page opens on: notifications (default) or emulators
  --no-emulators       Serve the notifications UI alone, without the Emulators tab
  --ready-json         Print {"url": …} as one JSON line once listening
  -h, --help           Show this help
`

const main = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      fleet: { type: "string" },
      manifest: { type: "string" },
      service: { type: "string", multiple: true },
      port: { type: "string" },
      host: { type: "string" },
      namespace: { type: "string", multiple: true },
      poll: { type: "string" },
      "admin-key-env": { type: "string" },
      tab: { type: "string" },
      "no-emulators": { type: "boolean" },
      "ready-json": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (values.help || positionals[0] !== "serve") {
    process.stdout.write(HELP)
    return values.help ? 0 : 2
  }
  const services: Record<string, ServiceInput> = {}
  for (const entry of values.service ?? []) {
    const eq = entry.indexOf("=")
    if (eq <= 0) throw new Error(`--service ${entry}: expected name=url`)
    services[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  if (!values.fleet && !values.manifest && Object.keys(services).length === 0) {
    process.stderr.write("mockingbird-notifications: pass --fleet, --manifest or --service\n\n")
    process.stderr.write(HELP)
    return 2
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("--port: expected 0–65535")
  const poll = values.poll === undefined ? undefined : Number(values.poll)
  if (poll !== undefined && (!Number.isFinite(poll) || poll < 0))
    throw new Error("--poll: expected milliseconds")
  if (values.tab !== undefined && values.tab !== "emulators" && values.tab !== "notifications")
    throw new Error("--tab: expected emulators or notifications")
  const adminKey = process.env[values["admin-key-env"] ?? "MOCKINGBIRD_ADMIN_KEY"]
  const server = await createServer({
    port,
    ...(values.host ? { host: values.host } : {}),
    ...(values.fleet ? { fleet: values.fleet } : {}),
    ...(values.manifest ? { manifest: values.manifest } : {}),
    ...(Object.keys(services).length ? { services } : {}),
    ...(values.namespace?.length ? { namespaces: values.namespace } : {}),
    ...(poll !== undefined ? { pollIntervalMs: poll } : {}),
    ...(adminKey ? { adminKey } : {}),
    ...(values.tab ? { defaultTab: values.tab } : {}),
    ...(values["no-emulators"] ? { admin: false as const } : {}),
  })
  if (values["ready-json"]) process.stdout.write(`${JSON.stringify({ url: server.url })}\n`)
  else process.stdout.write(`Notifications harness: ${server.url}\n`)
  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  await server.close()
  return 0
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(
      `mockingbird-notifications: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  },
)
