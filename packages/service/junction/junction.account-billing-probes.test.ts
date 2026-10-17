import { expect, test } from "bun:test"
import { probeAccountBilling } from "./scripts/account-billing-probes.js"
import type { SimulationProbeCall } from "./scripts/simulation-probes.js"

test("billing oracle probes compare independent persisted identity and clean only their own synthetic resources", async () => {
  const calls: string[] = []
  const privateAccount = "synthetic-account-inventory-id"
  let count = 0
  const call: SimulationProbeCall = async (method, path, body) => {
    calls.push(`${method} ${path}`)
    if (path === "/v3/lab_test/lab_account")
      return {
        status: 200,
        body: {
          data: [
            {
              id: privateAccount,
              lab: "bioreference",
              org_id: "synthetic-org",
              status: "active",
              delegated_flow: "not_delegated",
              allowed_billing: { patient_bill_passthrough: ["NY"] },
            },
          ],
        },
      }
    if (path === "/v3/lab_test")
      return {
        status: 200,
        body: {
          data: [
            {
              id: "synthetic-panel",
              lab: { slug: "bioreference" },
              method: "at_home_phlebotomy",
              is_active: true,
            },
          ],
        },
      }
    if (path === "/v2/user" && method === "POST")
      return { status: 200, body: { user_id: "synthetic-owned-user" } }
    if (path === "/v3/order") {
      const input = body as Record<string, unknown>
      return {
        status: 200,
        body: {
          order: {
            id: `synthetic-order-${++count}`,
            lab_account_id: input.lab_account_id ?? null,
            billing_type: input.billing_type,
          },
        },
      }
    }
    if (method === "GET" && path.startsWith("/v3/order/"))
      return { status: 200, body: { lab_account_id: null } }
    return { status: 200, body: {} }
  }
  const report = await probeAccountBilling(call, "synthetic-run")
  expect(report.complete).toBe(true)
  expect(report.observations).toHaveLength(4)
  expect(report.observations[0]).toMatchObject({ postSelected: true, getSelected: false })
  expect(JSON.stringify(report)).not.toContain(privateAccount)
  expect(JSON.stringify(report)).not.toContain("synthetic-owned-user")
  expect(report.cleanup).toHaveLength(5)
  expect(calls.filter((c) => c.includes("/cancel"))).toHaveLength(4)
  expect(calls.at(-1)).toBe("DELETE /v2/user/synthetic-owned-user")
})
