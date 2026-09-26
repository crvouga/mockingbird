#!/usr/bin/env node
/// <reference types="node" />
import {
  type CliCommand,
  type CliValues,
  runCli,
  serveCommand,
} from "@crvouga/mockingbird-adapter-node"
import type { RequestLog } from "@crvouga/mockingbird-service"
import { listenH2c } from "./h2c.js"
import { serveTarget } from "./server.js"

const text = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

const logger = (format: string): ((entry: RequestLog) => void) | undefined => {
  if (format === "off") return undefined
  if (format === "json") return (entry) => console.log(JSON.stringify(entry))
  return (entry) => {
    const op = entry.operationId ?? (entry.unmatched ? "UNMATCHED" : "-")
    const ns = entry.namespace === "default" ? "" : ` [${entry.namespace}]`
    const fault = entry.faultId ? ` fault=${entry.faultId}` : ""
    console.log(
      `bedrock ${entry.method} ${entry.path} ${entry.status} ${op} ${entry.durationMs}ms${ns}${fault}`,
    )
  }
}

/**
 * `serve`, listening with h2c and HTTP/1.1 on one port (the AWS SDK defaults to HTTP/2).
 * `--config` falls back to the shared multi-service serve, which listens over HTTP/1.1.
 */
const standard = serveCommand(serveTarget)
const serve: CliCommand = {
  ...standard,
  async run(values: CliValues, positionals: string[]) {
    if (text(values.config) !== undefined) return standard.run(values, positionals)
    const format = values["log-requests"] === true ? "json" : (text(values.log) ?? "pretty")
    if (!["pretty", "json", "off"].includes(format)) {
      console.error(`--log must be pretty, json or off (got ${format})`)
      return 2
    }
    const adminKey = text(values["admin-key"]) ?? process.env.MOCKINGBIRD_ADMIN_KEY
    const seed = text(values.seed)
    const port = text(values.port)
    try {
      const runtime = await serveTarget.create(values, {
        adminKey,
        seed,
        onLog: logger(format),
      })
      const listening = await listenH2c(runtime, {
        port: port === undefined ? serveTarget.defaultPort : Number.parseInt(port, 10),
        host: text(values.host) ?? "127.0.0.1",
      })
      console.log(`bedrock mock listening on ${listening.url} (h2c + HTTP/1.1)`)
      console.log(`bedrock health: GET ${listening.url}/health`)
      console.log(
        `bedrock admin: ${listening.url}/__admin (${adminKey ? "x-mockingbird-admin-key required" : "open — pass --admin-key to lock"})`,
      )
      for (const line of serveTarget.banner?.(runtime) ?? []) console.log(`bedrock ${line}`)
      return await new Promise<number>((resolve) => {
        const stop = async () => {
          await listening.close()
          resolve(0)
        }
        process.once("SIGINT", stop)
        process.once("SIGTERM", stop)
      })
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      return 1
    }
  },
}

const code = await runCli(
  {
    bin: "mockingbird-bedrock",
    description: "stateful, scriptable AWS Bedrock Runtime + AgentCore mock",
    commands: { serve },
  },
  process.argv.slice(2),
)
if (code !== 0) process.exitCode = code
