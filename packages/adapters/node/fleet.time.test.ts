import { expect, test } from "bun:test"
import { createRuntime } from "@crvouga/mockingbird-service"
import { startFleet, type FleetTarget } from "./src/fleet.js"

test("bounded settlement rechecks cross-participant due events with deterministic order (#414)", async () => {
  const execute = async () => {
    const pending: { early?: number; late?: number } = { early: 10, late: 20 }, events: string[] = []
    const fleet = await startFleet({ adminControls: { clock: { now: 0, frozen: true } }, services: { early: { port: 0 }, late: { port: 0 } } }, { load: async (name): Promise<FleetTarget> => ({ name, defaultPort: 0, create(_v, common) { return createRuntime({ name, ...(common.adminControls ? { adminControls: common.adminControls } : {}), create(ctx) { return { reset: async () => {}, fetch: async () => Response.json(events), nextEvent: () => pending[name as "early" | "late"], tick() { const due = pending[name as "early" | "late"]; if (due !== undefined && ctx.clock.now() >= due) { delete pending[name as "early" | "late"]; events.push(`${name}:${ctx.clock.now()}`); if (name === "early") pending.late = 15 } } } } }) } }) })
    try { const response = await fleet.fetch(new Request(`${fleet.manifest.adminBase}/time/run-until`, { method: "POST", body: JSON.stringify({ maxEvents: 5, timeoutMs: 1000 }) })); expect(response.ok).toBe(true); expect(await response.json()).toMatchObject({ status: "settled", steps: [{ now: 10, processed: ["early"] }, { now: 15, processed: ["late"] }] }); return events }
    finally { await fleet.close() }
  }
  expect(await execute()).toEqual(["early:10", "late:15"])
  expect(await execute()).toEqual(["early:10", "late:15"])
})
