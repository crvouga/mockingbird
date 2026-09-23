import { expect, test } from "bun:test"
import { ResourceTable } from "@crvouga/mockingbird-model"
import { compareStripeWebhooks } from "./webhook-oracle.js"

const event = (type: string, id: string, status: string) => ({
  id: `evt_${id}`,
  type,
  created: Date.now(),
  data: { object: { object: "customer", id, status, metadata: { source: "parity" } } },
})

test("matches reordered Stripe events across independent IDs and timestamps", () => {
  const table = new ResourceTable()
  table.register("customer", { real: "cus_real_1", mock: "cus_mock_1" })
  table.register("customer", { real: "cus_real_2", mock: "cus_mock_2" })
  const real = [
    event("customer.created", "cus_real_1", "active"),
    event("customer.updated", "cus_real_2", "inactive"),
  ]
  const mock = [
    event("customer.updated", "cus_mock_2", "inactive"),
    event("customer.created", "cus_mock_1", "active"),
  ]
  expect(compareStripeWebhooks(real, mock, table)).toBeUndefined()
  expect(
    compareStripeWebhooks(
      real,
      [mock[0], event("customer.created", "cus_mock_1", "inactive")],
      table,
    ),
  ).toContain("event signature differs")
  expect(compareStripeWebhooks(real, mock.slice(1), table)).toContain("event count")
})
