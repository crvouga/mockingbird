import { createRuntime, type LifeFileV2Runtime } from "../src/index.js"
import { consumer, orderBody } from "./consumer.js"

export type SoakOptions = {
  durationMs: number
  testsPerMinute: number
  windows: number
  idleLeftoverEvery: number
  namespaceIdleMs: number
  sleep: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export type SoakWindow = {
  window: number
  tests: number
  calls: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  pushP95Ms: number
  pushes: number
  heapMb: number
  namespaces: number
  records: number
  journalEntries: number
  webhooksPending: number
}

export type SoakReport = {
  options: Omit<SoakOptions, "sleep" | "log">
  windows: SoakWindow[]
  verdict: {
    p95DriftPct: number
    p95DriftMs: number
    p99Ms: number
    heapGrowthMb: number
    pushP95Ms: number
    maxNamespaces: number
    pass: boolean
    reasons: string[]
  }
}

const percentile = (values: readonly number[], p: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number
}

const heapMb = () => {
  const gc = (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc
  gc?.(true)
  return process.memoryUsage().heapUsed / 1_048_576
}

const BASE = "http://lifefile.soak"

export const runSoak = async (options: SoakOptions): Promise<SoakReport> => {
  const pushSent = new Map<string, number>()
  const pushLatencies: number[] = []
  let pushes = 0
  const runtime: LifeFileV2Runtime = createRuntime({
    latency: "none",
    namespaceIdleMs: options.namespaceIdleMs,
    maxRecords: 2_000,
    maxSnapshots: 20,
    push: {
      url: "http://receiver.soak/push",
      username: "soak",
      password: "soak",
      retryDelaysMs: [0, 50],
      fetch: async (request) => {
        const body = (await request.json()) as { orderId: number; status: { id: string } }
        const sent = pushSent.get(`${body.orderId}:${body.status.id}`)
        if (sent !== undefined) pushLatencies.push(performance.now() - sent)
        pushes++
        return new Response(null, { status: 200 })
      },
    },
  })
  const timed = async (latencies: number[], run: () => Promise<unknown>) => {
    const started = performance.now()
    const result = await run()
    latencies.push(performance.now() - started)
    return result
  }
  const fetch = (request: Request) => runtime.fetch(request)
  const windowMs = options.durationMs / options.windows
  const intervalMs = 60_000 / options.testsPerMinute
  const windows: SoakWindow[] = []
  const started = performance.now()
  let testNumber = 0
  for (let w = 0; w < options.windows; w++) {
    const latencies: number[] = []
    const windowPushLatencyStart = pushLatencies.length
    const windowPushStart = pushes
    let tests = 0
    const windowEnd = started + (w + 1) * windowMs
    while (performance.now() < windowEnd) {
      const tick = performance.now()
      testNumber++
      tests++
      const namespace = `soak-${testNumber}`
      const client = consumer(`${BASE}/__admin/ns/${namespace}`, fetch)
      const uuid = crypto.randomUUID()
      const created = (await timed(latencies, () =>
        client.createOrder(orderBody({ uuid })),
      )) as Awaited<ReturnType<typeof client.createOrder>>
      if (created.ok) {
        const id = created.data.orderId
        await timed(latencies, () => client.findByRxUuid(uuid))
        await timed(latencies, () => client.order(id))
        await timed(latencies, () => client.status(id))
        await timed(latencies, () => client.setStatus(id, "pen"))
        pushSent.set(`${id}:pro`, performance.now())
        await timed(latencies, () =>
          fetch(
            new Request(`${BASE}/__admin/orders/${id}/status`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
              body: JSON.stringify({ status: "pro" }),
            }),
          ),
        )
        if (testNumber % 5 === 0) {
          await fetch(
            new Request(`${BASE}/__admin/faults`, {
              method: "POST",
              headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
              body: JSON.stringify({ preset: "server_error", count: 1 }),
            }),
          )
          await timed(latencies, () => client.shipping(id))
        }
        if (testNumber % 7 === 0) await timed(latencies, () => client.cancel(id))
      }
      await runtime.webhooks.idle(namespace)
      if (testNumber % options.idleLeftoverEvery !== 0) {
        await fetch(new Request(`${BASE}/__admin/namespaces/${namespace}`, { method: "DELETE" }))
      }
      const spent = performance.now() - tick
      if (spent < intervalMs) await options.sleep(intervalMs - spent)
    }
    const resources = runtime.resources()
    const windowPushLatencies = pushLatencies.slice(windowPushLatencyStart)
    const row: SoakWindow = {
      window: w + 1,
      tests,
      calls: latencies.length,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
      p99Ms: percentile(latencies, 99),
      maxMs: Math.max(0, ...latencies),
      pushP95Ms: percentile(windowPushLatencies, 95),
      pushes: pushes - windowPushStart,
      heapMb: heapMb(),
      namespaces: resources.namespaces,
      records: resources.records,
      journalEntries: resources.journalEntries,
      webhooksPending: resources.webhooksPending,
    }
    windows.push(row)
    options.log?.(JSON.stringify(row))
  }
  runtime.stop?.()
  const baseline = windows[Math.min(1, windows.length - 1)] as SoakWindow
  const last = windows.at(-1) as SoakWindow
  const p95DriftMs = last.p95Ms - baseline.p95Ms
  const p95DriftPct = baseline.p95Ms > 0 ? (p95DriftMs / baseline.p95Ms) * 100 : 0
  const heapGrowthMb = last.heapMb - baseline.heapMb
  const p99Ms = Math.max(...windows.slice(1).map((w) => w.p99Ms), 0)
  const pushP95Ms = Math.max(...windows.map((w) => w.pushP95Ms))
  const maxNamespaces = Math.max(...windows.map((w) => w.namespaces))
  const reasons: string[] = []
  if (p95DriftPct > 10 && p95DriftMs > 2)
    reasons.push(`p95 drifted ${p95DriftPct.toFixed(1)}% (${p95DriftMs.toFixed(2)} ms)`)
  if (p99Ms > 50) reasons.push(`p99 ${p99Ms.toFixed(1)} ms is over 50 ms`)
  if (heapGrowthMb > 50) reasons.push(`heap grew ${heapGrowthMb.toFixed(1)} MB after warm-up`)
  if (pushP95Ms > 1_000) reasons.push(`push p95 ${pushP95Ms.toFixed(0)} ms is over 1 s`)
  const leftoverBound =
    Math.ceil(options.namespaceIdleMs / intervalMs / options.idleLeftoverEvery) + 3
  if (maxNamespaces > leftoverBound) {
    reasons.push(
      `${maxNamespaces} live namespaces, more than the ${leftoverBound} running or idling`,
    )
  }
  return {
    options: {
      durationMs: options.durationMs,
      testsPerMinute: options.testsPerMinute,
      windows: options.windows,
      idleLeftoverEvery: options.idleLeftoverEvery,
      namespaceIdleMs: options.namespaceIdleMs,
    },
    windows,
    verdict: {
      p95DriftPct,
      p95DriftMs,
      p99Ms,
      heapGrowthMb,
      pushP95Ms,
      maxNamespaces,
      pass: reasons.length === 0,
      reasons,
    },
  }
}
