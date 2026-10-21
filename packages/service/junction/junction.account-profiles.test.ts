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

test("best-guess NY/NJ explicit client billing preserves the selected nondelegated account and advertised inventory (#441)", async () => {
  for (const profile of ["sandbox-observed", "observed"] as const) {
    const allowed_billing = { patient_bill_passthrough: ["NY", "NJ"] }
    const mock = runtime([account(other, { delegated_flow: "not_delegated", allowed_billing })], {
      profile,
      ...(profile === "observed" ? { oracle: "sandbox" as const } : {}),
      accounts: { [other]: { allowBilling: { client_bill: ["NY", "NJ"] } } },
    })
    mock.instance().defaultBillingTypes = { bioreference: "patient_bill_passthrough" }
    const listedAccount = async () => {
      const response = await call(mock, "GET", "/v3/lab_test/lab_account")
      expect(response.status).toBe(200)
      return (await response.json()).data.find((entry: { id: string }) => entry.id === other)
    }
    expect(await listedAccount()).toMatchObject({
      id: other,
      delegated_flow: "not_delegated",
      allowed_billing,
    })
    for (const state of ["NY", "NJ"]) {
      const patient_address = {
        first_line: "1 Example St",
        city: state === "NY" ? "New York" : "Newark",
        state,
        zip: state === "NY" ? "10001" : "07102",
        country: "US",
      }
      // Explicit client billing must place the order with this account, even
      // though the fixture advertises only passthrough and that is the default.
      const created = await order(mock, { lab_account_id: other, patient_address })
      expect(created.status).toBe(200)
      expect(created.body.order).toMatchObject({
        lab_account_id: other,
        billing_type: "client_bill",
      })
      const response = await call(mock, "GET", `/v3/order/${created.body.order.id}`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        lab_account_id: other,
        billing_type: "client_bill",
      })
      const omitted = await order(mock, {
        lab_account_id: other,
        patient_address,
        billing_type: undefined,
      })
      expect(omitted.status).toBe(200)
      expect(omitted.body.order).toMatchObject({
        lab_account_id: other,
        billing_type: "patient_bill_passthrough",
      })
    }
    // An order-specific exception must not rewrite the advertised account contract.
    expect((await listedAccount()).allowed_billing).toEqual(allowed_billing)
  }
})

test("best-guess client billing acceptance stays scoped to explicit account/state fixtures and preserves strict defaults (#441)", async () => {
  const unconfigured = "77777777-7777-4777-8777-777777777777"
  const allowed_billing = { patient_bill_passthrough: ["NY", "NJ"] }
  const accounts = [
    account(other, { delegated_flow: "not_delegated", allowed_billing }),
    account(unconfigured, { delegated_flow: "not_delegated", allowed_billing }),
    account(customer, { delegated_flow: "order_delegated", allowed_billing }),
  ]
  const policies = {
    [other]: { allowBilling: { client_bill: ["NY", "NJ"] } },
    [customer]: {
      rejectBilling: {
        client_bill: "Lab 13 does not support billing type patient_bill_passthrough",
      },
    },
  }
  const mock = runtime(accounts, { profile: "sandbox-observed", accounts: policies })
  const ny = {
    first_line: "1 Example St",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US",
  }
  const controls = [
    {
      extra: { lab_account_id: other },
      detail:
        "Billing type client_bill is not available in state AZ for the lab account used for this order",
    },
    {
      extra: { lab_account_id: unconfigured, patient_address: ny },
      detail: "Billing type client_bill is not supported by the lab account used for this order",
    },
    {
      extra: { lab_account_id: customer, patient_address: ny },
      detail: "Lab 13 does not support billing type patient_bill_passthrough",
    },
    {
      extra: { lab_account_id: other, patient_address: ny, billing_type: undefined },
      detail: "Lab 13 does not support billing type client_bill",
    },
    {
      extra: { lab_account_id: other, patient_address: ny, billing_type: "patient_bill" },
      detail: "Billing type patient_bill is not supported by the lab account used for this order",
    },
  ]
  for (const { extra, detail } of controls) {
    const refused = await order(mock, extra)
    expect(refused.status).toBe(400)
    expect<unknown>(refused.body).toEqual({ detail })
  }
  expect((await (await call(mock, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
  expect(mock.instance().webhookEvents()).toHaveLength(0)

  for (const profile of ["native", "expected-contract"] as const) {
    // Merely attaching fixture exceptions must not enable them in strict profiles.
    const strict = runtime(accounts, { profile, accounts: policies })
    const refused = await order(strict, { lab_account_id: other, patient_address: ny })
    expect(refused.status).toBe(400)
    expect<unknown>(refused.body).toEqual({
      detail: "Billing type client_bill is not supported by the lab account used for this order",
    })
    expect((await (await call(strict, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
    expect(strict.instance().webhookEvents()).toHaveLength(0)
  }
})

test("best-guess account refusal stays explicit with a physician present and omitted billing stays independent (#440)", async () => {
  for (const oracle of ["sandbox", "production"] as const) {
    const detail = `Lab ${oracle === "sandbox" ? 13 : 14} does not support billing type patient_bill_passthrough`
    const mock = runtime(
      [
        account(customer, { delegated_flow: "order_delegated" }),
        account(other, { delegated_flow: "order_delegated" }),
      ],
      {
        profile: "observed",
        oracle,
        accounts: { [customer]: { rejectBilling: { client_bill: detail } } },
      },
    )
    // The shape matches ClientFacingPhysician and the synthetic order physician.
    // This only tests that a physician cannot bypass the billing control; physician
    // selection/validation is not modelled by this profile.
    const physician = { first_name: "Synthetic", last_name: "Physician", npi: "0000000000" }
    const refused = await order(mock, { lab_account_id: customer, physician })
    expect(refused.status).toBe(400)
    expect<unknown>(refused.body).toEqual({ detail })
    expect((await (await call(mock, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
    expect(mock.instance().webhookEvents()).toHaveLength(0)

    // No global delegated-account rule: the same request on an unconfigured
    // delegated account still follows that account's listed billing.
    const unconfigured = await order(mock, { lab_account_id: other, physician })
    expect(unconfigured.status).toBe(200)
    expect(unconfigured.body.order.lab_account_id).toBe(other)

    // This is the chosen fallback contract, not a vendor omission observation:
    // explicit-only rejectBilling must not reject an omitted default client_bill.
    const omitted = await order(mock, { lab_account_id: customer, billing_type: undefined })
    expect(omitted.status).toBe(200)
    expect(omitted.body.order.billing_type).toBe("client_bill")
    expect(omitted.body.order.lab_account_id).toBe(customer)
    const read = await (await call(mock, "GET", `/v3/order/${omitted.body.order.id}`)).json()
    expect(read.billing_type).toBe("client_bill")
    expect(read.lab_account_id).toBe(customer)

    mock.instance().defaultBillingTypes = { bioreference: "patient_bill_passthrough" }
    const omittedWithDefault = await order(mock, {
      lab_account_id: customer,
      billing_type: undefined,
    })
    expect(omittedWithDefault.status).toBe(400)
    expect<unknown>(omittedWithDefault.body).toEqual({
      detail: "Lab 13 does not support billing type patient_bill_passthrough",
    })
    // An explicit client_bill still hits the account-owned refusal after changing the default.
    const explicitWithDefault = await order(mock, { lab_account_id: customer, physician })
    expect(explicitWithDefault.status).toBe(400)
    expect<unknown>(explicitWithDefault.body).toEqual({ detail })
  }
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

const ny = {
  first_line: "1 Example St",
  city: "New York",
  state: "NY",
  zip: "10001",
  country: "US",
}

test("sandbox-observed refuses an explicit Junction-owned account in a state it does not cover (#494)", async () => {
  const accounts = [
    account(house, { allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] } }),
    account(customer, { allowed_billing: { client_bill: ["AZ"] } }),
  ]
  for (const behavior of [
    { profile: "sandbox-observed" as const, accounts: {} },
    { profile: "observed" as const, oracle: "sandbox" as const, accounts: {} },
  ]) {
    const mock = runtime(accounts, behavior)
    const refused = await order(mock, { lab_account_id: house })
    expect(refused.status).toBe(400)
    // The state rule is separate from the billing-type rule.
    expect<unknown>(refused.body).toEqual({ detail: "Lab BioReference does not support state AZ" })
    // Refusals create nothing and publish nothing.
    expect((await (await call(mock, "GET", "/v3/orders")).json()).orders).toHaveLength(0)
    expect(mock.instance().webhookEvents()).toHaveLength(0)
    // A covered state with an unlisted billing type keeps the billing refusal.
    const billing = await order(mock, {
      lab_account_id: house,
      billing_type: "client_bill",
      patient_address: ny,
    })
    expect(billing.status).toBe(400)
    expect(billing.body.detail).not.toContain("does not support state")
    // The covered state and billing type are accepted and keep the account identity.
    const covered = await order(mock, {
      lab_account_id: house,
      billing_type: "patient_bill_passthrough",
      patient_address: ny,
    })
    expect(covered.status).toBe(200)
    expect(covered.body.order.lab_account_id).toBe(house)
    // A customer-owned account that covers the state is unaffected.
    expect((await order(mock, { lab_account_id: customer })).body.order.lab_account_id).toBe(
      customer,
    )
    // An unlisted Junction-owned account still falls back to the platform account (#439).
    const unknown = await order(mock, { lab_account_id: "99999999-9999-4999-8999-999999999999" })
    expect(unknown.body.order.lab_account_id).toBeNull()
  }
})

test("the Junction-owned state refusal is profile- and account-scoped (#494)", async () => {
  const accounts = [
    account(house, { allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] } }),
    account(customer, { allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] } }),
  ]
  // Customer-owned accounts keep the listed billing/state message.
  const sandbox = runtime(accounts, { profile: "sandbox-observed", accounts: {} })
  const customerRefused = await order(sandbox, { lab_account_id: customer })
  expect(customerRefused.status).toBe(400)
  expect(customerRefused.body.detail).not.toBe("Lab BioReference does not support state AZ")
  // Other profiles keep their messages: the rule is a sandbox observation.
  for (const behavior of [
    { profile: "native" as const, accounts: {} },
    { profile: "expected-contract" as const, accounts: {} },
    { profile: "observed" as const, oracle: "production" as const, accounts: {} },
  ]) {
    const result = await order(runtime(accounts, behavior), { lab_account_id: house })
    expect(result.status).toBe(400)
    expect(result.body.detail).not.toBe("Lab BioReference does not support state AZ")
  }
  // A configured account-owned exception makes the state covered.
  const exception = runtime(accounts, {
    profile: "sandbox-observed",
    accounts: { [house]: { allowBilling: { client_bill: ["AZ"] } } },
  })
  const accepted = await order(exception, { lab_account_id: house })
  expect(accepted.status).toBe(200)
  expect(accepted.body.order.lab_account_id).toBe(house)
})

test("the production oracle places an omitted-account order on the house account without changing the listing (#495)", async () => {
  const accounts = [
    account(customer, { delegated_flow: "order_delegated", allowed_billing: { client_bill: [] } }),
    account(house, { allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] } }),
  ]
  const listing = async (mock: ReturnType<typeof runtime>) =>
    (
      (await (await call(mock, "GET", "/v3/lab_test/lab_account")).json()) as {
        data: { id: string; allowed_billing: Record<string, string[]> }[]
      }
    ).data
  const production = runtime(accounts, { profile: "observed", oracle: "production", accounts: {} })
  const before = await listing(production)
  const placed = await order(production)
  expect(placed.status).toBe(200)
  expect(placed.body.order.lab_account_id).toBe(house)
  expect(placed.body.order.billing_type).toBe("client_bill")
  const read = await (await call(production, "GET", `/v3/order/${placed.body.order.id}`)).json()
  expect(read.lab_account_id).toBe(house)
  expect(
    await (
      await call(production, "GET", `/v3/order/${placed.body.order.id}/requisition/pdf`)
    ).text(),
  ).toContain("Account number: MOCK-HOUSE")
  // The listing is untouched: the house account still lists client_bill for no state.
  expect(await listing(production)).toEqual(before)
  expect(before.find((a) => a.id === house)?.allowed_billing).toEqual({
    patient_bill_passthrough: ["NJ", "NY"],
  })
  // Explicit selection of the house account keeps the listed policy.
  expect((await order(production, { lab_account_id: house })).status).toBe(400)
  // The default is visible, overridable and survives a round trip.
  const behavior = (await (
    await call(production, "GET", "/__admin/lab-account-behavior")
  ).json()) as {
    omittedAccountBilling: Record<string, string>
  }
  expect(behavior.omittedAccountBilling).toEqual({ bioreference: "unchecked" })
  const strict = runtime(accounts, {
    profile: "observed",
    oracle: "production",
    accounts: {},
    omittedAccountBilling: { bioreference: "listed" },
  })
  expect((await order(strict)).status).toBe(400)
  // The sandbox oracle and the other profiles keep their own omission behavior.
  const sandbox = runtime(accounts, { profile: "sandbox-observed", accounts: {} })
  expect((await order(sandbox)).body.order.lab_account_id).toBeNull()
  for (const profile of ["native", "expected-contract"] as const)
    expect((await order(runtime(accounts, { profile, accounts: {} }))).status).toBe(400)
})
