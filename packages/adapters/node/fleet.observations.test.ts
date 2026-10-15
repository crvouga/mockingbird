import { expect, test } from "bun:test"
import { FleetObservations, replayFleetTrace } from "./src/fleet-observations.js"
import { sealArchive } from "./src/fleet-archive.js"

const empty = { activeRequests: 0, activeConnections: 0, blockedCommands: 0, pendingJobs: 0, pendingWebhooks: 0, unmatchedRequests: 0 }
const archive = () => sealArchive({ format: "mockingbird.fleet/v1", sourceId: "synthetic-source", createdAt: new Date(0).toISOString(), namespaces: { alpha: { clock: { now: 0, frozen: true }, services: { fixture: { protocol: "http", version: 1, state: { records: [] } } } } } })

test("run assertions use only post-baseline namespace evidence and narrowly bounded allowances (#416)", () => {
  const observed = new FleetObservations("synthetic")
  observed.record({ namespace: "alpha", service: "fixture", kind: "http", status: 404, unmatched: true, pathFingerprint: "earlier" })
  const baseline = observed.baseline("alpha", ["fixture"])
  observed.record({ namespace: "beta", service: "fixture", kind: "http", status: 500 })
  expect(observed.assertClean(baseline.id, "alpha", { fixture: empty }).clean).toBe(true)
  observed.record({ namespace: "alpha", service: "fixture", kind: "http", status: 404, unmatched: true, pathFingerprint: "synthetic-path" })
  const failed = observed.assertClean(baseline.id, "alpha", { fixture: empty })
  expect(failed.clean).toBe(false); expect(failed.failures[0]).toMatchObject({ kind: "unmatched", journalReference: 3 })
  const allowances = [{ kind: "unmatched" as const, service: "fixture", pathFingerprint: "synthetic-path", status: 404, maxCount: 1 }]
  expect(observed.assertClean(baseline.id, "alpha", { fixture: empty }, { allowances }).clean).toBe(true)
  expect(() => observed.assertClean(baseline.id, "alpha", { fixture: empty }, { allowances: [{ kind: "rejected", service: "fixture", maxCount: 100 }] })).toThrow("exact operation")
  expect(observed.assertClean(baseline.id, "alpha", { fixture: { ...empty, pendingJobs: 1 } }, { allowances }).clean).toBe(false)
  expect(observed.assertClean(baseline.id, "alpha", { fixture: { ...empty, pendingJobs: 1 } }, { allowances, allowCheckpointablePending: true }).clean).toBe(true)
  observed.record({ namespace: "alpha", service: "fixture", kind: "webhook", deliveryState: "failed" })
  expect(observed.assertClean(baseline.id, "alpha", { fixture: empty }, { allowances }).clean).toBe(false)
})

test("trace capture redacts credentials, bounds recording, and refuses source-fleet replay (#422)", async () => {
  const observed = new FleetObservations("synthetic-source", { events: 10, traceEvents: 1, traceBytes: 10000 })
  observed.startTrace("alpha", archive(), true)
  const request = new Request("http://synthetic/thing?token=synthetic-query", { method: "POST", headers: { "content-type": "application/json", authorization: "synthetic-header" }, body: JSON.stringify({ secret: "synthetic-body", data: "retained" }) })
  const token = observed.beginHTTP("alpha", "fixture", request)
  await observed.finishHTTP(token, Response.json({ ok: true }))
  const artifact = observed.trace("alpha")
  expect(JSON.stringify(artifact)).not.toContain("synthetic-query")
  expect(JSON.stringify(artifact)).not.toContain("synthetic-header")
  expect(JSON.stringify(artifact)).not.toContain("synthetic-body")
  expect(artifact.limitations).toContain("sensitive JSON body fields redacted")
  observed.control("alpha", "clock", { advance: 1 })
  expect(observed.trace("alpha").truncated).toBe(true)
  await expect(replayFleetTrace(artifact, { manifest: { id: "synthetic-source" } } as never)).rejects.toThrow("separate")
})
