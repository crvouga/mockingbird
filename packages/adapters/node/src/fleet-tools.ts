import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { type Fleet, type FleetOptions, startFleet } from "./fleet.js"
import { type FleetArchive, validateArchive } from "./fleet-archive.js"
import {
  type ConnectionManifest,
  type ConnectionMapping,
  FleetClient,
  renderConnections,
  writeConnections,
} from "./fleet-client.js"
import { preflightFleet } from "./fleet-preflight.js"
import type { CliCommand, FleetTarget, MockingbirdConfig } from "./index.js"

export async function doctorFleet(
  config: MockingbirdConfig,
  options: FleetOptions,
  probes: { url: string; timeoutMs?: number }[] = [],
) {
  const findings: { check: string; ok: boolean; message: string }[] = []
  const plan: { service: string; protocol: string; port: number; version: string }[] = []
  try {
    const targets = await preflightFleet(config, options)
    const require = createRequire(resolve(process.cwd(), "package.json"))
    for (const [service, target] of targets) {
      let version = "development"
      try {
        version = (
          require(`@crvouga/mockingbird-service-${service}/package.json`) as { version: string }
        ).version
      } catch {}
      plan.push({
        service,
        protocol: "protocol" in target ? target.protocol : "http",
        port: config.services[service]?.port ?? target.defaultPort,
        version,
      })
    }
    findings.push({
      check: "configuration",
      ok: true,
      message: "all targets and control documents validated; no listeners opened",
    })
  } catch (error) {
    findings.push({
      check: "configuration",
      ok: false,
      message: error instanceof Error ? error.message : "configuration failed",
    })
  }
  for (const probe of probes) {
    try {
      const url = new URL(probe.url)
      if (url.username || url.password) throw new Error("probe URLs must not contain credentials")
      const response = await fetch(url, { signal: AbortSignal.timeout(probe.timeoutMs ?? 2000) })
      await response.body?.cancel()
      findings.push({
        check: "reachability",
        ok: response.ok,
        message: `endpoint returned HTTP ${response.status}`,
      })
    } catch {
      findings.push({
        check: "reachability",
        ok: false,
        message: "endpoint unreachable; verify the listener host, port and readiness",
      })
    }
  }
  return {
    version: 1,
    ok: findings.every((f) => f.ok),
    findings,
    plan,
    storageWritesPerformed: false,
  }
}

/** Boots a separate in-memory fleet on ephemeral ports; never uses source files or repositories. */
export async function rehearseFleet(
  config: MockingbirdConfig,
  options: Pick<FleetOptions, "load">,
  input: unknown,
  probes: ((fleet: Fleet, signal: AbortSignal) => Promise<void>)[] = [],
  timeoutMs = 30000,
) {
  const archive = validateArchive(input)
  const startedAt = new Date().toISOString()
  const isolated: MockingbirdConfig = {
    ...config,
    control: { host: "127.0.0.1", port: 0 },
    services: Object.fromEntries(
      Object.entries(config.services).map(([name, entry]) => [
        name,
        { ...entry, host: "127.0.0.1", port: 0 },
      ]),
    ),
  }
  let fleet: Fleet | undefined
  try {
    fleet = await startFleet(isolated, { load: options.load })
    const client = new FleetClient(fleet.manifest.adminBase, {
      ...(config.adminKey ? { adminKey: config.adminKey } : {}),
    })
    await client.importArchive(archive)
    const signal = AbortSignal.timeout(timeoutMs)
    for (const probe of probes)
      await Promise.race([
        probe(fleet, signal),
        new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("rehearsal probe timed out")), {
            once: true,
          }),
        ),
      ])
    return {
      version: 1,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceArchive: archive.sha256,
      rehearsalProcess: fleet.manifest.id,
      probes: probes.length,
    }
  } finally {
    await fleet?.close()
  }
}

export function fleetCommands(
  load: (name: string) => Promise<FleetTarget>,
): Record<string, CliCommand> {
  const parse = async (path: unknown) => {
    if (typeof path !== "string") throw new Error("file path required")
    return JSON.parse(await readFile(path, "utf8")) as unknown
  }
  return {
    "fleet control": {
      summary: "Call authenticated fleet controls using discovered adminBase",
      options: {
        base: { type: "string", description: "Discovered adminBase URL" },
        action: { type: "string", description: "Relative control route" },
        method: { type: "string", description: "HTTP method" },
        body: { type: "string", description: "JSON request file" },
        namespace: { type: "string", description: "Selected namespace" },
        "key-env": {
          type: "string",
          description: "Admin-key environment variable name",
          default: "MOCKINGBIRD_ADMIN_KEY",
        },
        "idempotency-key": { type: "string", description: "Retry identity" },
      },
      async run(values) {
        try {
          if (typeof values.base !== "string" || typeof values.action !== "string")
            throw new Error("--base and --action required")
          const key = process.env[String(values["key-env"] ?? "MOCKINGBIRD_ADMIN_KEY")]
          const client = new FleetClient(values.base, {
            ...(key ? { adminKey: key } : {}),
            ...(typeof values.namespace === "string" ? { namespace: values.namespace } : {}),
          })
          console.log(
            JSON.stringify(
              await client.request(values.action, {
                ...(typeof values.method === "string" ? { method: values.method } : {}),
                ...(values.body ? { body: await parse(values.body) } : {}),
                ...(typeof values["idempotency-key"] === "string"
                  ? { idempotencyKey: values["idempotency-key"] }
                  : {}),
              }),
            ),
          )
          return 0
        } catch (error) {
          console.error(error instanceof Error ? error.message : "fleet control failed")
          return 1
        }
      },
    },
    "fleet doctor": {
      summary: "Validate fleet configuration without starting or resetting services",
      options: {
        config: { type: "string", description: "Fleet configuration file" },
        json: { type: "boolean", description: "Machine-readable report" },
        endpoint: { type: "string", description: "Optional read-only reachability probe" },
        "ready-file": { type: "string", description: "Validate readiness destination" },
        "connections-file": { type: "string", description: "Validate private destination" },
      },
      async run(values) {
        try {
          const report = await doctorFleet(
            (await parse(values.config)) as MockingbirdConfig,
            {
              load,
              ...(typeof values["ready-file"] === "string"
                ? { readyFile: values["ready-file"] }
                : {}),
              ...(typeof values["connections-file"] === "string"
                ? { connectionsFile: values["connections-file"] }
                : {}),
            },
            typeof values.endpoint === "string" ? [{ url: values.endpoint }] : [],
          )
          console.log(
            values.json
              ? JSON.stringify(report)
              : report.findings
                  .map((f) => `${f.ok ? "PASS" : "FAIL"} ${f.check}: ${f.message}`)
                  .join("\n"),
          )
          return report.ok ? 0 : 1
        } catch (error) {
          console.error(error instanceof Error ? error.message : "doctor failed")
          return 1
        }
      },
    },
    "fleet render": {
      summary: "Render explicit application variables from private namespace discovery",
      options: {
        manifest: { type: "string", description: "Public ready manifest file" },
        connections: { type: "string", description: "Private connection manifest file" },
        mapping: { type: "string", description: "JSON variable-to-service mapping" },
        namespace: { type: "string", description: "Explicit namespace" },
        output: { type: "string", description: "Private destination file" },
        format: { type: "string", description: "json or dotenv", default: "json" },
      },
      async run(values) {
        try {
          if (
            typeof values.namespace !== "string" ||
            typeof values.output !== "string" ||
            !["json", "dotenv"].includes(String(values.format))
          )
            throw new Error("--namespace, --output and valid --format required")
          const manifest = (await parse(values.manifest)) as Parameters<
              typeof renderConnections
            >[0],
            connections = (await parse(values.connections)) as ConnectionManifest
          const output = renderConnections(
            manifest,
            connections,
            values.namespace,
            (await parse(values.mapping)) as ConnectionMapping,
          )
          await writeConnections(values.output, output, values.format as "json" | "dotenv")
          console.log(JSON.stringify({ written: values.output, variables: Object.keys(output) }))
          return 0
        } catch (error) {
          console.error(error instanceof Error ? error.message : "render failed")
          return 1
        }
      },
    },
    "fleet rehearse": {
      summary: "Restore an archive in an isolated ephemeral fleet, then close it",
      options: {
        config: { type: "string", description: "Fleet configuration file" },
        archive: { type: "string", description: "Saved fleet archive file" },
      },
      async run(values) {
        try {
          console.log(
            JSON.stringify(
              await rehearseFleet(
                (await parse(values.config)) as MockingbirdConfig,
                { load },
                (await parse(values.archive)) as FleetArchive,
              ),
            ),
          )
          return 0
        } catch (error) {
          console.error(error instanceof Error ? error.message : "rehearsal failed")
          return 1
        }
      },
    },
  }
}
