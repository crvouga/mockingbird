import type { Clock } from "@crvouga/mockingbird-service"
import type { FleetChild } from "./fleet.js"

export type ClockSynchronization = (context: {
  namespace: string
  services: string[]
  now: number
  signal: AbortSignal
}) => Promise<void>
export class FleetTimeController {
  constructor(
    private readonly context: {
      clock(namespace: string): Clock
      transaction(
        namespace: string,
        selected: Map<string, FleetChild>,
        run: (name: string, child: FleetChild) => Promise<unknown>,
      ): Promise<Response>
      phase(namespace: string, phase: string, completed?: number, total?: number): void
      synchronize?: ClockSynchronization
      recovery: Map<string, (() => void)[]>
    },
  ) {}
  async run(
    namespace: string,
    selected: Map<string, FleetChild>,
    body: Record<string, unknown>,
    single: boolean,
  ) {
    const condition = body.condition ?? "no-events",
      maxEvents = single ? 1 : (body.maxEvents ?? 100),
      maxAdvanceMs = body.maxAdvanceMs ?? 86400000,
      timeoutMs = body.timeoutMs ?? 5000
    if (
      !["no-events", "idle", "checkpoint-ready"].includes(String(condition)) ||
      typeof maxEvents !== "number" ||
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents > 10000 ||
      typeof maxAdvanceMs !== "number" ||
      !Number.isFinite(maxAdvanceMs) ||
      maxAdvanceMs < 0 ||
      typeof timeoutMs !== "number" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000
    )
      throw new Error("invalid bounded time-control condition or budgets")
    const unsupported = [...selected].filter(([, child]) => !child.nextEvent).map(([name]) => name)
    if (unsupported.length)
      throw new Error(`next-event inspection unsupported for ${unsupported.join(", ")}`)
    const clocks = [...selected.values()].map((child) => child.clock(namespace).state())
    if (clocks.some((clock) => !clock.frozen || clock.now !== clocks[0]?.now))
      throw new Error("freeze and align selected participant clocks before event stepping")
    const start = clocks[0]?.now ?? this.context.clock(namespace).now(),
      deadline = Date.now() + timeoutMs
    const steps: { now: number; processed: string[] }[] = []
    const diagnostics = () =>
      Object.fromEntries([...selected].map(([name, child]) => [name, child.diagnostics(namespace)]))
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(
                    new Error("time-control host budget exceeded; recovery may be required"),
                    { code: "MOCKINGBIRD_WORKLOAD_UNCERTAIN" },
                  ),
                ),
              Math.max(1, deadline - Date.now()),
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    for (;;) {
      const due = await bounded(
        Promise.all(
          [...selected].map(
            async ([name, child]) => [name, await child.nextEvent?.(namespace)] as const,
          ),
        ),
      )
      if (due.some(([, time]) => time !== undefined && !Number.isFinite(time)))
        throw new Error("participant returned an invalid event time")
      const services = diagnostics(),
        states = Object.values(services)
      const ready =
        condition === "checkpoint-ready"
          ? states.every(
              (d) =>
                d.activeRequests + d.blockedCommands + d.pendingWebhooks + (d.activeJobs ?? 0) ===
                0,
            )
          : condition === "idle"
            ? states.every(
                (d) =>
                  d.activeRequests + d.blockedCommands + d.pendingWebhooks + d.pendingJobs === 0,
              )
            : due.every(([, time]) => time === undefined)
      if (!single && ready)
        return Response.json({ status: "settled", namespace, condition, steps, services })
      const times = due.flatMap(([, time]) => (time === undefined ? [] : [time]))
      if (!times.length)
        return Response.json({
          status: "no-events",
          namespace,
          condition,
          settled: ready,
          steps,
          services,
        })
      const current = [...selected.values()][0]?.clock(namespace).now() ?? start,
        target = Math.max(current, Math.min(...times))
      if (Date.now() >= deadline || steps.length >= maxEvents || target - start > maxAdvanceMs)
        return Response.json(
          { status: "budget-exhausted", namespace, condition, steps, services },
          { status: 409 },
        )
      const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
      const response = await this.context.transaction(namespace, selected, async (_name, child) => {
        child.clock(namespace).set(target)
        if (child.settle) await bounded(child.settle(namespace, signal))
      })
      if (!response.ok) return response
      this.context.clock(namespace).freeze()
      this.context.clock(namespace).set(target)
      try {
        if (this.context.synchronize)
          await bounded(
            this.context.synchronize({
              namespace,
              services: [...selected.keys()],
              now: target,
              signal,
            }),
          )
      } catch (error) {
        const fences: (() => void)[] = []
        for (const child of selected.values())
          try {
            fences.push(child.lock(namespace))
          } catch {}
        this.context.recovery.set(namespace, fences)
        throw error
      }
      const processed = due
        .filter(([, time]) => time !== undefined && time <= target)
        .map(([name]) => name)
      steps.push({ now: target, processed })
      this.context.phase(namespace, "stepping", steps.length, steps.length)
      if (single)
        return Response.json({
          status: "stepped",
          namespace,
          steps,
          services: diagnostics(),
          clientClockSynchronization: this.context.synchronize
            ? "hook-invoked"
            : "external worker clocks are unchanged",
        })
    }
  }
}
