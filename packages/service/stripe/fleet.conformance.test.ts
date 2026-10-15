import { expect, test } from "bun:test"
import { join } from "node:path"
import type { FleetSubject } from "./src/fleet.js"

const publicEntry = "./dist/fleet.js"
const { launchFleet, participantConformance } = (await import(
  publicEntry
)) as typeof import("./src/fleet.js")

const customerRequest = async (subject: FleetSubject, namespace: string, method = "GET") => {
  const response = await fetch(`${subject.manifest.services.stripe?.url}/v1/customers`, {
    method,
    headers: {
      authorization: "Bearer sk_test_mockingbird",
      "x-mockingbird-namespace": namespace,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST"
      ? { body: `email=${encodeURIComponent(`${namespace}@example.test`)}` }
      : {}),
  })
  if (!response.ok) throw new Error(`synthetic customer request failed ${response.status}`)
  return (await response.json()) as { id: string; data: { id: string; email: string }[] }
}

test("public conformance harness destroys and restores distinct CLI processes with deterministic continuation (#415)", async () => {
  const factory = () =>
    launchFleet(["bun", join(import.meta.dir, "dist/cli.js")], {
      adminKey: "synthetic-admin-only",
      adminControls: { clock: { now: 0, frozen: true } },
      services: { stripe: { port: 0, seed: "synthetic-conformance" } },
    })
  const report = await participantConformance(factory, {
    declaredState: ["HTTP records", "clock", "random IDs"],
    excludedState: ["live outbound work"],
    populate: async (subject, namespace) => {
      await customerRequest(subject, namespace, "POST")
    },
    observe: async (subject, namespace) => ({
      records: (await customerRequest(subject, namespace)).data.map(({ id, email }) => ({
        id,
        email,
      })),
      clock: await subject.client.request("clock", { namespace }),
    }),
    continue: async (subject, namespace) => (await customerRequest(subject, namespace, "POST")).id,
  })
  expect(report.passed).toBe(true)
  expect(report.freshProcess).toBe(true)
  expect(report.sourcePid).not.toBe(report.destinationPid)
  expect(report.checks).toContain("deterministic continuation")
  expect(report.exclusions).toContain(
    "failure injection was not configured; rollback/fence certification is not claimed",
  )
}, 20000)
