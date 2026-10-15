import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FleetClient, type ConnectionManifest } from "./fleet-client.js"
import { validateArchive } from "./fleet-archive.js"
import type { EndpointManifest } from "./fleet-manifest.js"
import type { MockingbirdConfig } from "./cli.js"

export type FleetSubject = { manifest: EndpointManifest; connections: ConnectionManifest; client: FleetClient; close(): Promise<void> }
/** Launches a caller-selected installed service CLI without a shell or private workspace imports. */
export async function launchFleet(command: readonly string[], config: MockingbirdConfig, options: { cwd?: string; timeoutMs?: number } = {}): Promise<FleetSubject> {
  if (!command.length) throw new Error("installed fleet CLI command required")
  const directory = await mkdtemp(join(tmpdir(), "fleet-conformance-")), configFile = join(directory, "config.json"), readyFile = join(directory, "ready.json"), connectionFile = join(directory, "connections.json")
  await writeFile(configFile, JSON.stringify({ ...config, log: "off" }), { mode: 0o600 })
  const child = spawn(command[0] as string, [...command.slice(1), "serve", "--config", configFile, "--ready-file", readyFile, "--connections-file", connectionFile, "--ready-json"], { cwd: options.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.resume(); child.stderr.resume()
  let spawnFailure: Error | undefined
  child.on("error", (error) => { spawnFailure = error })
  const exited = new Promise<number | null>((resolve) => { child.once("exit", resolve); child.once("error", () => resolve(-1)) })
  let closing: Promise<void> | undefined
  const close = () => {
    if (closing) return closing
    closing = (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 5000) })]); await exited }
      finally { clearTimeout(timer); await rm(directory, { recursive: true, force: true }) }
      if (child.exitCode !== 0) throw new Error(`fleet subprocess shutdown failed (${child.exitCode ?? child.signalCode})`)
    })()
    return closing
  }
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 10000)
    let manifest: EndpointManifest | undefined
    while (Date.now() < deadline) {
      if (spawnFailure) throw new Error("could not launch installed fleet CLI", { cause: spawnFailure })
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fleet subprocess exited before readiness (${child.exitCode ?? child.signalCode})`)
      try { manifest = JSON.parse(await readFile(readyFile, "utf8")) as EndpointManifest; break } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!manifest) throw new Error("fleet subprocess readiness deadline exceeded")
    const connections = JSON.parse(await readFile(connectionFile, "utf8")) as ConnectionManifest
    const key = config.adminKey ?? process.env.MOCKINGBIRD_ADMIN_KEY
    return { manifest, connections, client: new FleetClient(manifest.adminBase, key ? { adminKey: key } : {}), close }
  } catch (error) { await close().catch(() => {}); throw error }
}
export type ConformanceProbe = {
  declaredState: string[]
  excludedState: string[]
  populate(subject: FleetSubject, namespace: string): Promise<void>
  observe(subject: FleetSubject, namespace: string): Promise<unknown>
  continue(subject: FleetSubject, namespace: string): Promise<unknown>
  injectFailure?(subject: FleetSubject, boundary: "capture" | "restore" | "rollback"): Promise<{ request(): Promise<unknown>; verify(): Promise<void>; clear(): Promise<void> }>
}
/** Checks real public controls, deterministic continuation and namespace isolation across processes. */
export async function participantConformance(factory: () => Promise<FleetSubject>, probe: ConformanceProbe, options: { requireFreshProcess?: boolean } = {}) {
  const checks: string[] = [], exclusions = [...probe.excludedState]
  const first = await factory(); let fresh: FleetSubject | undefined; let primaryFailure: unknown
  try {
    for (const ns of ["conformance-alpha", "conformance-beta"]) { await first.client.createNamespace(ns); await probe.populate(first, ns) }
    const alpha = await probe.observe(first, "conformance-alpha"), beta = await probe.observe(first, "conformance-beta")
    const archive = validateArchive(await first.client.exportArchive(undefined, true))
    const next = await probe.continue(first, "conformance-alpha")
    assert.deepEqual(await probe.observe(first, "conformance-beta"), beta); checks.push("namespace mutation isolation")
    await first.client.reset("conformance-alpha")
    assert.deepEqual(await probe.observe(first, "conformance-beta"), beta); checks.push("namespace reset isolation")
    for (const boundary of ["capture", "restore", "rollback"] as const) {
      if (!probe.injectFailure) continue
      const failure = await probe.injectFailure(first, boundary)
      try { await assert.rejects(() => failure.request()); await failure.verify(); checks.push(`${boundary} failure/fence contract`) } finally { await failure.clear() }
    }
    if (!probe.injectFailure) exclusions.push("failure injection was not configured; rollback/fence certification is not claimed")
    await first.close()
    fresh = await factory()
    const freshProcess = first.manifest.pid !== fresh.manifest.pid && first.manifest.pid !== process.pid && fresh.manifest.pid !== process.pid
    if (options.requireFreshProcess !== false) assert.equal(freshProcess, true, "portable conformance requires distinct fresh subprocesses")
    await fresh.client.importArchive(archive)
    assert.deepEqual(await probe.observe(fresh, "conformance-alpha"), alpha); checks.push("fresh portable state")
    assert.deepEqual(await probe.continue(fresh, "conformance-alpha"), next); checks.push("deterministic continuation")
    assert.deepEqual(await probe.observe(fresh, "conformance-beta"), beta); checks.push("restore isolation")
    return { version: 1, passed: true, freshProcess, sourcePid: first.manifest.pid, destinationPid: fresh.manifest.pid, archive: archive.sha256, declaredState: probe.declaredState, exclusions, checks }
  } catch (error) { primaryFailure = error; throw error }
  finally {
    const results = await Promise.allSettled([first.close(), fresh?.close()])
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError([...(primaryFailure !== undefined ? [primaryFailure] : []), ...failures], "conformance or cleanup failed")
  }
}
