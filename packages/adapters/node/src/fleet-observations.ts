import { createHash, randomUUID } from "node:crypto"
import { digest, validateArchive, type FleetArchive } from "./fleet-archive.js"
import type { FleetDiagnostics } from "./fleet.js"
import type { FleetSubject } from "./fleet-conformance.js"

export type Observation = { id: number; namespace: string; service: string; kind: "http" | "webhook"; method?: string; pathFingerprint?: string; operationId?: string; status?: number; unmatched?: boolean; fault?: boolean; deliveryState?: string }
export type AssertionAllowance = { kind: "unmatched" | "rejected" | "fault"; service: string; pathFingerprint?: string; operationId?: string; status?: number; maxCount: number }
export type TraceEvent = { sequence: number; kind: "http" | "control"; service?: string; method?: string; path?: string; body?: string; contentType?: string; status?: number; responseHash?: string; action?: "clock" | "reset"; controls?: Record<string, unknown>; omitted: string[] }
export type FleetTrace = { format: "mockingbird.trace/v1"; sourceProcess: string; namespace: string; baseline: FleetArchive; events: TraceEvent[]; limitations: string[]; truncated: boolean; active: boolean }
type TraceToken = { artifact: FleetTrace; event: TraceEvent; body: Promise<{ text?: string; omitted: string[] }> }
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const boundedText = async (stream: ReadableStream<Uint8Array> | null, max: number) => {
  if (!stream) return ""
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let bytes = 0, timedOut = false
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, 100)
  try { for (;;) { const result = await reader.read(); if (result.done) break; bytes += result.value.length; if (bytes > max) throw new Error("capture byte limit"); chunks.push(result.value) }; if (timedOut) throw new Error("capture deadline"); return Buffer.concat(chunks).toString("utf8") }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock() }
}
export class FleetObservations {
  private sequence = 0
  private readonly entries: Observation[] = []
  private readonly baselines = new Map<string, { namespace: string; services: string[]; sequence: number }>()
  private readonly traces = new Map<string, { artifact: FleetTrace; includeBodies: boolean; bytes: number; inFlight: number; next: number }>()
  constructor(private readonly processId: string, private readonly limits = { events: 500, traceEvents: 200, traceBytes: 1024 * 1024 }) {}
  record(event: Omit<Observation, "id">) { this.entries.push({ ...event, id: ++this.sequence }); if (this.entries.length > this.limits.events) this.entries.shift() }
  baseline(namespace: string, services: string[]) { const id = randomUUID(); this.baselines.set(id, { namespace, services, sequence: this.sequence }); while (this.baselines.size > 200) this.baselines.delete(this.baselines.keys().next().value as string); return { id, namespace, services, sequence: this.sequence } }
  assertClean(id: string, namespace: string, diagnostics: Record<string, FleetDiagnostics>, options: { allowances?: AssertionAllowance[]; allowCheckpointablePending?: boolean } = {}) {
    const baseline = this.baselines.get(id)
    if (!baseline || baseline.namespace !== namespace) throw new Error("assertion baseline not found in this namespace")
    const allowances = options.allowances ?? []
    if (!Array.isArray(allowances) || allowances.some((a) => !["unmatched", "rejected", "fault"].includes(a.kind) || !a.service || !a.pathFingerprint && !a.operationId || !Number.isSafeInteger(a.maxCount) || a.maxCount < 1)) throw new Error("allowances must identify a service and exact operation or path fingerprint with a bounded count")
    const consumed = new Map<AssertionAllowance, number>(), failures: unknown[] = []
    if (this.entries.length && baseline.sequence < (this.entries[0]?.id ?? 0) - 1) failures.push({ kind: "evidence_truncated" })
    for (const entry of this.entries) {
      if (entry.id <= baseline.sequence || entry.namespace !== namespace || !baseline.services.includes(entry.service)) continue
      const kinds = entry.kind === "webhook" ? entry.deliveryState === "failed" || entry.deliveryState === "dropped" ? ["failed_delivery"] : [] : entry.fault ? ["fault"] : entry.unmatched ? ["unmatched"] : (entry.status ?? 0) >= 400 ? ["rejected"] : []
      for (const kind of kinds) {
        const allowed = allowances.find((a) => a.kind === kind && a.service === entry.service && (!a.pathFingerprint || a.pathFingerprint === entry.pathFingerprint) && (!a.operationId || a.operationId === entry.operationId) && (a.status === undefined || a.status === entry.status) && (consumed.get(a) ?? 0) < a.maxCount)
        if (allowed) consumed.set(allowed, (consumed.get(allowed) ?? 0) + 1)
        else failures.push({ kind, service: entry.service, method: entry.method, pathFingerprint: entry.pathFingerprint, operationId: entry.operationId, status: entry.status, journalReference: entry.id })
      }
    }
    for (const service of baseline.services) {
      const d = diagnostics[service]
      if (!d) throw new Error(`missing assertion diagnostics for ${service}`)
      if (d.activeRequests + d.activeConnections + d.blockedCommands + d.pendingWebhooks + (d.activeJobs ?? 0) > 0 || !options.allowCheckpointablePending && d.pendingJobs > 0) failures.push({ kind: "leftover_work", service, diagnostics: d })
    }
    return { format: "mockingbird.assertions/v1", clean: failures.length === 0, namespace, baseline: id, failures: failures.slice(0, 100), truncated: failures.length > 100, inspectedThrough: this.sequence }
  }
  startTrace(namespace: string, input: unknown, includeBodies = false, limitations: string[] = []) {
    const baseline = validateArchive(input)
    if (!baseline.namespaces[namespace]) throw new Error("trace baseline lacks selected namespace")
    if (Buffer.byteLength(JSON.stringify(baseline)) > 8 * 1024 * 1024) throw new Error("trace baseline exceeds 8 MiB limit")
    if (this.traces.size >= 4 && !this.traces.has(namespace)) throw new Error("trace capacity reached")
    const artifact: FleetTrace = { format: "mockingbird.trace/v1", sourceProcess: this.processId, namespace, baseline: structuredClone(baseline), events: [], limitations: [...limitations], truncated: false, active: true }
    this.traces.set(namespace, { artifact, includeBodies, bytes: 0, inFlight: 0, next: 0 }); return structuredClone(artifact)
  }
  private limitation(artifact: FleetTrace, limitation: string) { if (!artifact.limitations.includes(limitation)) artifact.limitations.push(limitation) }
  beginHTTP(namespace: string, service: string, request: Request, logicalPath?: string): TraceToken | undefined {
    const trace = this.traces.get(namespace); if (!trace?.artifact.active) return undefined
    const url = new URL(request.url), omitted: string[] = []
    if (logicalPath) url.pathname = logicalPath
    for (const key of [...url.searchParams.keys()]) if (/(token|key|password|secret|signature|credential)/i.test(key)) { url.searchParams.set(key, "[redacted]"); omitted.push("sensitive query fields redacted") }
    if ([...request.headers.keys()].some((h) => /authorization|api-key|token|secret|cookie/i.test(h))) omitted.push("credential headers require explicit replay bindings")
    const event: TraceEvent = { sequence: ++trace.next, kind: "http", service, method: request.method, path: `${url.pathname}${url.search}`, contentType: request.headers.get("content-type") ?? "", omitted }
    if (trace.inFlight++) this.limitation(trace.artifact, "concurrent interactions are not certified for serial replay")
    let body: TraceToken["body"] = Promise.resolve({ omitted: [] })
    if (request.body) {
      if (!trace.includeBodies) body = Promise.resolve({ omitted: ["request body omitted"] })
      else {
        body = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            let text = await Promise.race([boundedText(request.clone().body, 65536), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("capture deadline")), 100) })])
            const removed: string[] = []
            if (event.contentType?.includes("json")) {
              text = JSON.stringify(JSON.parse(text), (key, value: unknown) => { if (/(token|password|secret|credential|authorization|api.?key)/i.test(key)) { removed.push("sensitive JSON body fields redacted"); return "[redacted]" }; return value })
            } else if (event.contentType?.includes("x-www-form-urlencoded")) {
              const form = new URLSearchParams(text)
              for (const key of [...form.keys()]) if (/(token|password|secret|credential|api.?key)/i.test(key)) { form.set(key, "[redacted]"); removed.push("sensitive form fields redacted") }
              text = form.toString()
            }
            return { text, omitted: removed }
          } catch { return { omitted: ["request body capture truncated or unavailable"] } } finally { clearTimeout(timeout) }
        })()
      }
    }
    return { artifact: trace.artifact, event, body }
  }
  async finishHTTP(token: TraceToken | undefined, response: Response) {
    if (!token) return
    const trace = this.traces.get(token.artifact.namespace)
    if (!trace || trace.artifact !== token.artifact) return
    const captured = await token.body
    token.event.status = response.status; token.event.omitted.push(...captured.omitted)
    if (captured.text !== undefined) token.event.body = captured.text
    if (response.headers.get("content-type")?.includes("text/event-stream")) token.event.omitted.push("streaming responses are unsupported")
    else {
      try { const text = await boundedText(response.clone().body, 65536); token.event.responseHash = hash(text) } catch { token.event.omitted.push("response hash unavailable or truncated") }
    }
    trace.inFlight--
    for (const omitted of token.event.omitted) this.limitation(trace.artifact, omitted)
    this.append(trace, token.event)
  }
  private append(trace: { artifact: FleetTrace; bytes: number }, event: TraceEvent) {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (trace.artifact.events.length >= this.limits.traceEvents || trace.bytes + bytes > this.limits.traceBytes) { trace.artifact.truncated = true; trace.artifact.active = false; this.limitation(trace.artifact, "recording limits reached"); return }
    trace.bytes += bytes; trace.artifact.events.push(event); trace.artifact.events.sort((a, b) => a.sequence - b.sequence)
  }
  unsupportedControl(namespace: string, action: string) { const trace = this.traces.get(namespace); if (trace?.artifact.active) this.limitation(trace.artifact, `control not replayable: ${action}`) }
  control(namespace: string, action: "clock" | "reset", controls: Record<string, unknown>) { const trace = this.traces.get(namespace); if (trace?.artifact.active) this.append(trace, { sequence: ++trace.next, kind: "control", action, controls: structuredClone(controls), omitted: [] }) }
  trace(namespace: string, stop = false) { const trace = this.traces.get(namespace); if (!trace) throw new Error("trace not started"); if (stop) trace.artifact.active = false; if (trace.inFlight) this.limitation(trace.artifact, "requests still in flight when inspected"); return structuredClone(trace.artifact) }
}

/** Replays only to discovered, explicitly selected synthetic endpoints in a different fleet. */
export async function replayFleetTrace(trace: FleetTrace, subject: FleetSubject, options: { allowIncomplete?: boolean; vendorHeaders?: Record<string, string>; allowedSyntheticOrigins?: string[] } = {}) {
  if (!trace || trace.format !== "mockingbird.trace/v1" || trace.sourceProcess === subject.manifest.id) throw new Error("trace replay requires a separate explicitly selected synthetic fleet")
  validateArchive(trace.baseline)
  if (!Array.isArray(trace.events) || trace.events.length > 10000 || !trace.baseline.namespaces[trace.namespace] || !Array.isArray(trace.limitations)) throw new Error("invalid trace artifact")
  let previous = 0
  for (const event of trace.events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous || !["http", "control"].includes(event.kind) || event.body !== undefined && (typeof event.body !== "string" || Buffer.byteLength(event.body) > 65536)) throw new Error("unsupported or malformed trace event")
    previous = event.sequence
    if (event.kind === "control" && (!event.action || !["clock", "reset"].includes(event.action) || !event.controls || Object.keys(event.controls).some((key) => !(event.action === "clock" ? ["services", "set", "advance", "freeze"] : ["services"]).includes(key)))) throw new Error("unsupported trace control")
    if (event.kind === "http" && (!event.method || !["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(event.method))) throw new Error("unsupported trace HTTP method")
  }
  if ((trace.truncated || trace.limitations.length) && !options.allowIncomplete) throw new Error("trace has declared replay limitations; supply explicit incomplete-replay policy/bindings")
  const endpoints = new Map<string, URL>()
  for (const event of trace.events) if (event.kind === "http") {
    const service = event.service as string, child = subject.manifest.services[service]
    if (!child || child.protocol !== "http" || !event.path?.startsWith("/") || event.path.startsWith("//")) throw new Error("unsupported trace service or path")
    const base = new URL(subject.connections.services[service]?.url ?? child.url)
    const allowed = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || options.allowedSyntheticOrigins?.includes(base.origin)
    const adminPath = new URL(child.adminUrl).pathname
    if (!allowed || base.username || base.password || decodeURIComponent(event.path).includes(adminPath)) throw new Error("trace endpoint is not an admitted synthetic vendor target")
    endpoints.set(service, base)
  }
  await subject.client.importArchive(trace.baseline)
  const outcomes: { sequence: number; status?: number; matched: boolean }[] = []
  for (const event of trace.events) {
    if (event.kind === "control") {
      if (event.action === "clock") await subject.client.request("clock", { namespace: trace.namespace, body: event.controls ?? {} })
      else if (event.action === "reset") await subject.client.reset(trace.namespace, { ...(Array.isArray(event.controls?.services) ? { services: event.controls.services as string[] } : {}) })
      else throw new Error("unsupported trace control")
      outcomes.push({ sequence: event.sequence, matched: true }); continue
    }
    const headers = new Headers(options.vendorHeaders); headers.delete("x-mockingbird-admin-key"); headers.set("x-mockingbird-namespace", trace.namespace)
    if (event.contentType) headers.set("content-type", event.contentType)
    const response = await fetch(new URL(event.path as string, endpoints.get(event.service as string)), { method: event.method ?? "GET", headers, ...(event.body !== undefined && event.method !== "GET" && event.method !== "HEAD" ? { body: event.body } : {}), redirect: "manual", signal: AbortSignal.timeout(5000) })
    const body = await boundedText(response.body, 65536)
    outcomes.push({ sequence: event.sequence, status: response.status, matched: event.status === response.status && (event.responseHash === undefined || event.responseHash === hash(body)) })
  }
  return { version: 1, matched: outcomes.every((o) => o.matched), complete: !trace.truncated && trace.limitations.length === 0, limitations: trace.limitations, outcomes, baseline: trace.baseline.sha256 }
}
