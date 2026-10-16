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
const runtime = (accounts: LabAccountInput[]) =>
  createRuntime({ corpus, labAccounts: accounts, geo: "synthetic", identity: "adopt-users" })
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
      order: { id: string; lab_account_id?: string }
      detail?: string
    },
  }
}

test("ready-to-launch accounts work explicitly, alone, and alongside unorderable accounts (#436)", async () => {
  for (const accounts of [
    [account(customer, { status: "ready_to_launch" })],
    [
      account(other, { status: "pending" }),
      account(customer, { status: "ready_to_launch" }),
      account(house, { status: "suspended" }),
    ],
  ]) {
    const mock = runtime(accounts)
    for (const extra of [{}, { lab_account_id: customer }]) {
      const result = await order(mock, extra)
      expect(result.status).toBe(200)
      expect(mock.instance().orderLabAccount(result.body.order.id)).toBe(customer)
    }
  }
})

test("multiple accounts route to platform regardless of listing order or customer state limits (#435, #436)", async () => {
  const accounts: [LabAccountInput, LabAccountInput, LabAccountInput] = [
    account(customer, { states: ["NY", "NJ"], status: "ready_to_launch" }),
    account(other),
    account(house),
  ]
  for (const layout of [
    accounts,
    [...accounts].reverse(),
    [accounts[1], accounts[0], accounts[2]],
  ]) {
    const mock = runtime(layout)
    const result = await order(mock)
    expect(result.status).toBe(200)
    expect(mock.instance().orderLabAccount(result.body.order.id)).toBe(house)
    const pdf = await call(mock, "GET", `/v3/order/${result.body.order.id}/requisition/pdf`)
    expect(await pdf.text()).toContain("Account number: MOCK-HOUSE")
  }
})

test("explicit delegated selection and immutable requisition evidence (#435, #437)", async () => {
  const mock = runtime([
    account(customer, { delegated_flow: "order_delegated" }),
    account(other),
    account(house),
  ])
  const result = await order(mock, { lab_account_id: customer })
  expect(result.status).toBe(200)
  expect(result.body.order.lab_account_id).toBeUndefined()
  const id = result.body.order.id
  await call(mock, "PUT", "/__admin/lab-accounts", { accounts: [account(house)] })
  const pdf = await call(mock, "GET", `/v3/order/${id}/requisition/pdf`)
  expect(pdf.headers.get("content-type")).toBe("application/pdf")
  const text = await pdf.text()
  expect(text.startsWith("%PDF-1.4")).toBe(true)
  expect(text).toContain("Account number: MOCK-CUSTOMER")
  expect(text).toContain("%%EOF")
  expect(
    (await call(mock, "GET", `/v3/order/${id}/requisition/pdf`, undefined, "isolated")).status,
  ).toBe(404)
  expect(
    (await call(mock, "PUT", `/__admin/requisitions/${id}`, { provider_account_id: null })).status,
  ).toBe(200)
  expect(await (await call(mock, "GET", `/v3/order/${id}/requisition/pdf`)).text()).toContain(
    "Account number: unknown",
  )
  expect(
    (await call(mock, "PUT", "/__admin/requisitions/missing", { provider_account_id: "MOCK" }))
      .status,
  ).toBe(404)
  await mock.instance().reset()
  expect((await call(mock, "GET", `/v3/order/${id}/requisition/pdf`)).status).toBe(404)
})

test("omission policy is configurable and namespace isolated; linked unorderable accounts never fall back (#435)", async () => {
  const mock = runtime([account(customer), account(other), account(house)])
  expect(
    (
      await call(mock, "PUT", "/__admin/lab-account-omission-policies", {
        policies: { bioreference: "reject" },
      })
    ).status,
  ).toBe(200)
  expect((await order(mock)).status).toBe(400)
  expect((await order(mock, {}, "isolated")).status).toBe(200)
  expect((await order(mock, { lab_account_id: customer })).status).toBe(200)

  for (const status of ["pending", "suspended"] as const) {
    const blocked = runtime([account(customer, { status })])
    expect((await order(blocked)).status).toBe(400)
  }
  const empty = runtime([])
  const result = await order(empty)
  expect(result.status).toBe(200)
  expect(
    await (await call(empty, "GET", `/v3/order/${result.body.order.id}/requisition/pdf`)).text(),
  ).toContain("Account number: unknown")
})
