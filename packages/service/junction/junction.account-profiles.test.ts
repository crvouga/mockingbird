import { expect, test } from "bun:test"
import { defaultCorpus } from "./src/corpus.js"
import type { LabAccountInput } from "./src/lab-accounts.js"
import { createRuntime } from "./src/runtime.js"
import type { LabTestRecord } from "./src/state.js"

const customer = "11111111-1111-4111-8111-111111111111"
const other = "22222222-2222-4222-8222-222222222222"
const house = "33333333-3333-4333-8333-333333333333"
const labTest = {
  ...(defaultCorpus.catalog.labTests.find(
    (t) => t.method === "at_home_phlebotomy",
  ) as LabTestRecord),
  id: "44444444-4444-4444-8444-444444444444",
  markers: [
    {
      id: 12345,
      provider_id: "synthetic-marker",
      name: "Synthetic Marker",
      slug: "synthetic_marker",
      description: null,
      lab_id: 13,
      type: null,
      unit: null,
      price: null,
      aoe: null,
      a_la_carte_enabled: true,
      common_tat_days: null,
      worst_case_tat_days: null,
      is_orderable: true,
    },
  ],
  lab: {
    ...defaultCorpus.catalog.labTests[0]?.lab,
    id: 13,
    slug: "bioreference",
    name: "BioReference",
  },
}
const corpus = {
  ...defaultCorpus,
  catalog: { ...defaultCorpus.catalog, labTests: [...defaultCorpus.catalog.labTests, labTest] },
}
const account = (id: string, fields: Partial<LabAccountInput> = {}): LabAccountInput => ({
  id,
  lab: "bioreference",
  provider_account_id: id === house ? "MOCK-HOUSE" : "MOCK-CUSTOMER",
  org_id: id === house ? null : "55555555-5555-4555-8555-555555555555",
  states: ["AZ"],
  ...fields,
})
const runtime = (
  accounts: LabAccountInput[],
  behavior: import("./src/lab-account-behavior.js").LabAccountBehavior = {
    profile: "expected-contract",
    accounts: {},
  },
) =>
  createRuntime({
    corpus,
    labAccounts: accounts,
    geo: "synthetic",
    identity: "adopt-users",
    labAccountBehavior: behavior,
  })
const call = (
  mock: ReturnType<typeof runtime>,
  method: string,
  path: string,
  body?: unknown,
  ns = "default",
) =>
  mock.fetch(
    new Request(`http://mock${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-vital-api-key": "local-audit-fake",
        "x-mockingbird-namespace": ns,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
const order = async (mock: ReturnType<typeof runtime>, extra = {}, ns = "default") => {
  const response = await call(
    mock,
    "POST",
    "/v3/order",
    {
      user_id: "66666666-6666-4666-8666-666666666666",
      order_set: { lab_test_ids: [labTest.id] },
      collection_method: "at_home_phlebotomy",
      billing_type: "client_bill",
      patient_details: {
        first_name: "Synthetic",
        last_name: "Tester",
        dob: "1990-01-01",
        gender: "female",
        phone_number: "+15005550006",
        email: "synthetic@example.com",
      },
      patient_address: {
        first_line: "1 Example St",
        city: "Phoenix",
        state: "AZ",
        zip: "85004",
        country: "US",
        phone_number: "+15005550006",
      },
      ...extra,
    },
    ns,
  )
  return {
    status: response.status,
    body: (await response.json()) as {
      order: { id: string; lab_account_id?: string | null; billing_type?: string }
      detail?: string
    },
  }
}

test("expected contract returns persisted selected accounts, validates explicit IDs and keeps requisition identity (#444)", async () => {
  const mock = runtime([
    account(customer, { delegated_flow: "order_delegated" }),
    account(other),
    account(house),
  ])
  const created = await order(mock, {
    lab_account_id: customer,
    idempotency_key: "synthetic-replay",
  })
  expect(created.status).toBe(200)
  expect(created.body.order.lab_account_id).toBe(customer)
  const id = created.body.order.id
  expect((await (await call(mock, "GET", `/v3/order/${id}`)).json()).lab_account_id).toBe(customer)
  expect(await (await call(mock, "GET", `/v3/order/${id}/requisition/pdf`)).text()).toContain(
    "MOCK-CUSTOMER",
  )
  expect(
    (await order(mock, { lab_account_id: customer, idempotency_key: "synthetic-replay" })).body
      .order.id,
  ).toBe(id)
  const nested = await order(mock, {
    order_set: { lab_test_ids: [labTest.id], lab_account_id: customer },
  })
  expect(nested.status).toBe(200)
  expect(nested.body.order.lab_account_id).toBe(house)
  expect(nested.body.order.lab_account_id).not.toBe(customer)
  for (const extra of [
    { lab_account_id: "99999999-9999-4999-8999-999999999999" },
    { lab_account_id: customer, billing_type: "patient_bill_passthrough" },
    {
      lab_account_id: customer,
      patient_address: {
        first_line: "1 Example St",
        city: "New York",
        state: "NY",
        zip: "10001",
        country: "US",
      },
    },
  ])
    expect((await order(mock, extra)).status).toBe(400)
  const wrongLab = runtime([account(other, { lab: "quest" })])
  expect((await order(wrongLab, { lab_account_id: other })).status).toBe(400)
})

test("sandbox billing exceptions are fixture-owned, explicit and independent of omission defaults (#440, #441, #444)", async () => {
  const behavior: import("./src/lab-account-behavior.js").LabAccountBehavior = {
    profile: "sandbox-observed",
    accounts: {
      [customer]: {
        rejectBilling: {
          client_bill: "Lab 13 does not support billing type patient_bill_passthrough",
        },
      },
      [other]: { allowBilling: { client_bill: ["NY", "NJ"] } },
    },
  }
  const accounts = [
    account(customer, { delegated_flow: "order_delegated" }),
    account(other, { allowed_billing: { patient_bill_passthrough: ["NY", "NJ"] } }),
    account(house),
  ]
  const mock = runtime(accounts, behavior)
  const refused = await order(mock, { lab_account_id: customer })
  expect(refused.status).toBe(400)
  expect(refused.body.detail).toBe("Lab 13 does not support billing type patient_bill_passthrough")
  expect((await (await call(mock, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
  mock.instance().defaultBillingTypes = { bioreference: "patient_bill_passthrough" }
  expect((await order(mock, { lab_account_id: customer })).status).toBe(400)
  expect((await order(mock, { lab_account_id: customer, billing_type: undefined })).status).toBe(
    400,
  )
  const ny = {
    first_line: "1 Example St",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US",
  }
  const accepted = await order(mock, { lab_account_id: other, patient_address: ny })
  expect(accepted.status).toBe(200)
  expect(accepted.body.order.lab_account_id).toBe(other)
  expect(accepted.body.order.billing_type).toBe("client_bill")
  const read = await (await call(mock, "GET", `/v3/order/${accepted.body.order.id}`)).json()
  expect(read.lab_account_id).toBe(other)
  expect(read.billing_type).toBe("client_bill")
  expect((await order(mock, { lab_account_id: customer }, "isolated")).status).toBe(400)
  await call(mock, "PUT", "/__admin/lab-account-behavior", { profile: "expected-contract" })
  expect((await order(mock, { lab_account_id: customer })).status).toBe(200)
  expect((await order(mock, { lab_account_id: customer }, "isolated")).status).toBe(400)
  await mock.reset("default")
  expect((await order(mock, { lab_account_id: customer }, "isolated")).status).toBe(400)
  expect(
    (await call(mock, "PUT", "/__admin/lab-account-behavior", { profile: "typo" })).status,
  ).toBe(400)
  expect(() => runtime(accounts, { profile: "typo" } as never)).toThrow("profile")
})

test("profiles apply to panel/add-on and home/walk-in consistently, keeping rejected orders/webhooks absent (#444)", async () => {
  for (const collection_method of ["at_home_phlebotomy", "walk_in_test"]) {
    for (const order_set of [
      { lab_test_ids: [labTest.id] },
      { add_on: { provider_ids: ["synthetic-marker"] } },
    ]) {
      const mock = runtime([account(customer, { delegated_flow: "order_delegated" })])
      const created = await order(mock, { lab_account_id: customer, order_set, collection_method })
      expect(created.status).toBe(200)
      expect(created.body.order.lab_account_id).toBe(customer)
      const sandbox = runtime([account(customer, { delegated_flow: "order_delegated" })], {
        profile: "sandbox-observed",
        accounts: {
          [customer]: {
            rejectBilling: {
              client_bill: "Lab 13 does not support billing type patient_bill_passthrough",
            },
          },
        },
      })
      expect(
        (await order(sandbox, { lab_account_id: customer, order_set, collection_method })).status,
      ).toBe(400)
      expect((await (await call(sandbox, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
      expect(sandbox.journal.list().length).toBeGreaterThan(0)
    }
  }
})

test("explicit profiles refuse malformed, unresolved and combined panel/add-on input without orders or webhooks (#444)", async () => {
  for (const profile of ["expected-contract", "sandbox-observed"] as const) {
    const mock = runtime([account(customer)], { profile, accounts: {} })
    for (const add_on of [
      null,
      "invalid",
      [],
      { provider_ids: [123] },
      { provider_ids: ["unknown-marker"] },
      { provider_ids: ["synthetic-marker"] },
    ]) {
      const result = await order(mock, {
        lab_account_id: customer,
        order_set: { lab_test_ids: [labTest.id], add_on },
      })
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.status).toBeLessThan(500)
      expect((await (await call(mock, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
      expect(mock.instance().webhookEvents()).toHaveLength(0)
    }
    for (const add_on of [
      null,
      "invalid",
      [],
      { provider_ids: [123] },
      { provider_ids: ["unknown-marker"] },
    ]) {
      const result = await order(mock, { lab_account_id: customer, order_set: { add_on } })
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(result.status).toBeLessThan(500)
      expect((await (await call(mock, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
      expect(mock.instance().webhookEvents()).toHaveLength(0)
    }
  }
})

test("sandbox-observed omission and negative controls place the order on the platform account with a null association (#439)", async () => {
  const ny = {
    first_line: "1 Example St",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US",
  }
  const mock = runtime(
    [
      account(customer, { delegated_flow: "order_delegated" }),
      account(other, { allowed_billing: { patient_bill_passthrough: ["NY", "NJ"] } }),
      account(house, { allowed_billing: { patient_bill_passthrough: ["NY", "NJ"] } }),
    ],
    { profile: "sandbox-observed", accounts: {} },
  )
  const ids = (extra: object) => async () => {
    const created = await order(mock, extra)
    const read =
      created.status === 200
        ? await (await call(mock, "GET", `/v3/order/${created.body.order.id}`)).json()
        : undefined
    return {
      status: created.status,
      post: created.body.order?.lab_account_id,
      get: read?.lab_account_id,
    }
  }
  const unknown = "99999999-9999-4999-8999-999999999999"
  const controls = {
    "omitted root": {},
    "delegated id only nested": {
      order_set: { lab_test_ids: [labTest.id], lab_account_id: customer },
    },
    "unknown id only nested": {
      order_set: { lab_test_ids: [labTest.id], lab_account_id: unknown },
    },
    "wrong-state id only nested": {
      order_set: { lab_test_ids: [labTest.id], lab_account_id: other },
    },
    "unknown explicit root": { lab_account_id: unknown },
    "customer id only nested, NY passthrough": {
      order_set: { lab_test_ids: [labTest.id], lab_account_id: other },
      billing_type: "patient_bill_passthrough",
      patient_address: ny,
    },
  }
  for (const [name, extra] of Object.entries(controls))
    expect({ name, ...(await ids(extra)()) }).toEqual({
      name,
      status: 200,
      post: null,
      get: null,
    })
  // Positive control: a valid root-selected customer account keeps its identity.
  const selected = await ids({
    lab_account_id: other,
    billing_type: "patient_bill_passthrough",
    patient_address: ny,
  })()
  expect(selected).toEqual({ status: 200, post: other, get: other })
  // The expected-contract profile still reflects the account the order was routed to.
  await call(mock, "PUT", "/__admin/lab-account-behavior", { profile: "expected-contract" })
  expect((await order(mock, { lab_account_id: unknown })).status).toBe(400)
})
