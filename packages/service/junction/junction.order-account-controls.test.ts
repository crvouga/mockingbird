import { expect, test } from "bun:test"
import { defaultCorpus } from "./src/corpus.js"
import type { LabAccountBehavior } from "./src/lab-account-behavior.js"
import { LAB_ACCOUNT_PRESETS, presetAccountId } from "./src/lab-account-presets.js"
import type { LabAccountInput } from "./src/lab-accounts.js"
import { createRuntime } from "./src/runtime.js"
import type { LabTestRecord } from "./src/state.js"

const customer = "11111111-1111-4111-8111-111111111111"
const delegated = "22222222-2222-4222-8222-222222222222"
const house = "33333333-3333-4333-8333-333333333333"
const labTest = {
  ...(defaultCorpus.catalog.labTests.find(
    (t) => t.method === "at_home_phlebotomy",
  ) as LabTestRecord),
  id: "44444444-4444-4444-8444-444444444444",
  markers: [],
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
const customerOwned = "55555555-5555-4555-8555-555555555555"
const accounts = (): LabAccountInput[] => [
  {
    id: house,
    lab: "bioreference",
    provider_account_id: "MOCK-HOUSE",
    org_id: null,
    allowed_billing: { patient_bill_passthrough: ["NY", "NJ"] },
  },
  {
    id: customer,
    lab: "bioreference",
    provider_account_id: "MOCK-CUSTOMER",
    org_id: customerOwned,
    states: ["AZ"],
  },
  {
    id: delegated,
    lab: "bioreference",
    provider_account_id: "MOCK-DELEGATED",
    org_id: customerOwned,
    delegated_flow: "order_delegated",
    states: ["AZ"],
  },
]
const runtime = (
  behavior: Partial<LabAccountBehavior> = { profile: "expected-contract" },
  extra: Partial<Parameters<typeof createRuntime>[0]> = {},
) =>
  createRuntime({
    corpus,
    labAccounts: accounts(),
    geo: "synthetic",
    identity: "adopt-users",
    labAccountBehavior: behavior,
    ...extra,
  })
type Mock = ReturnType<typeof runtime>
const call = (mock: Mock, method: string, path: string, body?: unknown, ns = "default") =>
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
const order = async (mock: Mock, extra: object = {}, ns = "default") => {
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
      order: { id: string; lab_account_id?: string | null; billing_type?: string; status?: string }
      detail?: string
    },
  }
}
const getOrder = async (mock: Mock, id: string) =>
  (await (await call(mock, "GET", `/v3/order/${id}`)).json()) as Record<string, unknown> & {
    events: { status: string; created_at: string }[]
  }
const adminOrders = async (mock: Mock, ns = "default") =>
  (
    (await (await call(mock, "GET", "/__admin/orders", undefined, ns)).json()) as {
      orders: {
        id: string
        lab_account_id: string | null
        lab_account_request: {
          labAccountId: string | null
          nestedLabAccountId: string | null
        } | null
        status: string
      }[]
    }
  ).orders

test("omitted account on a house account can skip its listed billing per lab, explicit house keeps its policy (#467)", async () => {
  // Default: the house account's NY/NJ passthrough listing refuses AZ client_bill.
  const strict = runtime()
  const refused = await order(strict)
  expect(refused.status).toBe(400)
  expect(refused.body.detail).toContain("not supported by the lab account")

  const behavior: Partial<LabAccountBehavior> = {
    profile: "expected-contract",
    omittedAccountBilling: { BioReference: "unchecked" },
    accounts: {},
  }
  const mock = runtime(behavior)
  expect(mock.instance().labAccountBehavior.omittedAccountBilling).toEqual({
    bioreference: "unchecked",
  })
  const placed = await order(mock)
  expect(placed.status).toBe(200)
  // The order is on the house account (its identity is kept, not nulled) ...
  expect(placed.body.order.lab_account_id).toBe(house)
  expect(placed.body.order.billing_type).toBe("client_bill")
  expect((await getOrder(mock, placed.body.order.id)).lab_account_id).toBe(house)
  expect(
    await (await call(mock, "GET", `/v3/order/${placed.body.order.id}/requisition/pdf`)).text(),
  ).toContain("Account number: MOCK-HOUSE")
  // ... a nested-only id is still an omitted root, so the same path applies.
  const nested = await order(mock, {
    order_set: { lab_test_ids: [labTest.id], lab_account_id: customer },
  })
  expect(nested.status).toBe(200)
  expect(nested.body.order.lab_account_id).toBe(house)
  // Explicit house selection keeps the listed policy, and a customer account keeps its own.
  expect((await order(mock, { lab_account_id: house })).status).toBe(400)
  const explicitCustomer = await order(mock, { lab_account_id: customer })
  expect(explicitCustomer.body.order.lab_account_id).toBe(customer)
  expect(
    (
      await order(mock, {
        lab_account_id: customer,
        patient_address: {
          first_line: "1 Example St",
          city: "New York",
          state: "NY",
          zip: "10001",
          country: "US",
        },
      })
    ).status,
  ).toBe(400)
  // Other labs and other namespaces are untouched.
  const isolated = await order(mock, {}, "isolated")
  expect(isolated.status).toBe(200) // constructor option applies to every namespace
  await call(mock, "PUT", "/__admin/lab-account-behavior", { profile: "expected-contract" })
  expect((await order(mock)).status).toBe(400)
  expect((await order(mock, {}, "isolated")).status).toBe(200)
  // Invalid policies are refused.
  for (const bad of [{ bioreference: "skip" }, { "": "unchecked" }, []])
    expect(
      (
        await call(mock, "PUT", "/__admin/lab-account-behavior", {
          profile: "expected-contract",
          omittedAccountBilling: bad,
        })
      ).status,
    ).toBe(400)
})

test("the unchecked omission only applies to Junction-owned accounts (#467)", async () => {
  const mock = createRuntime({
    corpus,
    geo: "synthetic",
    identity: "adopt-users",
    labAccounts: [
      {
        id: customer,
        lab: "bioreference",
        provider_account_id: "MOCK-CUSTOMER",
        org_id: customerOwned,
        allowed_billing: { patient_bill_passthrough: ["NY", "NJ"] },
      },
    ],
    labAccountBehavior: {
      profile: "expected-contract",
      omittedAccountBilling: { bioreference: "unchecked" },
    },
  })
  // The only linked account is customer-owned: its listing still decides.
  expect((await order(mock)).status).toBe(400)
})

test("observed profile labels its oracle; sandbox-observed is the sandbox alias (#468)", async () => {
  const policies = {
    [delegated]: {
      rejectBilling: {
        client_bill: "Lab 14 does not support billing type patient_bill_passthrough",
      },
    },
  }
  const production = runtime({ profile: "observed", oracle: "production", accounts: policies })
  const read = async (mock: Mock) =>
    (await (await call(mock, "GET", "/__admin/lab-account-behavior")).json()) as LabAccountBehavior
  expect(await read(production)).toMatchObject({ profile: "observed", oracle: "production" })
  // Refusals stay per account: the delegated account refuses, the other customer account does not.
  const refused = await order(production, { lab_account_id: delegated })
  expect(refused.status).toBe(400)
  expect(refused.body.detail).toBe("Lab 14 does not support billing type patient_bill_passthrough")
  const accepted = await order(production, { lab_account_id: customer })
  expect(accepted.body.order.lab_account_id).toBe(customer)
  // The sandbox omission recordings (#439) are sandbox observations: production keeps the house account.
  const omittedProduction = await order(runtime({ profile: "observed", oracle: "production" }), {
    billing_type: "patient_bill_passthrough",
    patient_address: {
      first_line: "1 Example St",
      city: "New York",
      state: "NY",
      zip: "10001",
      country: "US",
    },
  })
  expect(omittedProduction.body.order.lab_account_id).toBe(house)
  const sandbox = runtime({ profile: "observed", oracle: "sandbox", accounts: policies })
  expect((await order(sandbox, { lab_account_id: delegated })).status).toBe(400)
  expect((await order(sandbox)).body.order.lab_account_id).toBeNull()
  // The old name still works and reports the sandbox oracle.
  const alias = runtime({ profile: "sandbox-observed", accounts: policies })
  expect(await read(alias)).toMatchObject({ profile: "sandbox-observed", oracle: "sandbox" })
  expect((await order(alias, { lab_account_id: delegated })).status).toBe(400)
  expect((await order(alias)).body.order.lab_account_id).toBeNull()
  // Round-trip through the admin API, and refuse inconsistent labels.
  const put = await call(production, "PUT", "/__admin/lab-account-behavior", {
    profile: "observed",
    oracle: "sandbox",
  })
  expect(await put.json()).toMatchObject({ profile: "observed", oracle: "sandbox" })
  for (const bad of [
    { profile: "observed" },
    { profile: "observed", oracle: "staging" },
    { profile: "sandbox-observed", oracle: "production" },
    { profile: "expected-contract", oracle: "sandbox" },
    { profile: "native", oracle: "production" },
  ])
    expect((await call(production, "PUT", "/__admin/lab-account-behavior", bad)).status).toBe(400)
  expect(() => runtime({ profile: "observed" })).toThrow("oracle")
})

test("the admin order view records where lab_account_id was sent (#473)", async () => {
  const mock = runtime({
    profile: "expected-contract",
    omittedAccountBilling: { bioreference: "unchecked" },
  })
  const unknown = "99999999-9999-4999-8999-999999999999"
  const cases: [
    string,
    object,
    { labAccountId: string | null; nestedLabAccountId: string | null },
  ][] = [
    ["root", { lab_account_id: customer }, { labAccountId: customer, nestedLabAccountId: null }],
    [
      "nested",
      { order_set: { lab_test_ids: [labTest.id], lab_account_id: customer } },
      { labAccountId: null, nestedLabAccountId: customer },
    ],
    [
      "both",
      {
        lab_account_id: customer,
        order_set: { lab_test_ids: [labTest.id], lab_account_id: unknown },
      },
      { labAccountId: customer, nestedLabAccountId: unknown },
    ],
  ]
  const ids: string[] = []
  for (const [, extra] of cases) {
    const placed = await order(mock, extra)
    expect(placed.status).toBe(200)
    ids.push(placed.body.order.id)
  }
  // Absent: the house account is chosen by routing, with nothing sent.
  const absent = await order(mock, {
    billing_type: "patient_bill_passthrough",
    patient_address: {
      first_line: "1 Example St",
      city: "New York",
      state: "NY",
      zip: "10001",
      country: "US",
    },
  })
  expect(absent.status).toBe(200)
  const views = new Map((await adminOrders(mock)).map((view) => [view.id, view]))
  cases.forEach(([name, , expected], index) => {
    expect({ name, request: views.get(ids[index] as string)?.lab_account_request }).toEqual({
      name,
      request: expected,
    })
  })
  expect(views.get(absent.body.order.id)?.lab_account_request).toEqual({
    labAccountId: null,
    nestedLabAccountId: null,
  })
  // The resolved account is unchanged beside it: nested-only is ignored (routed to the house account).
  expect(views.get(ids[1] as string)?.lab_account_id).toBe(house)
  expect(views.get(ids[0] as string)?.lab_account_id).toBe(customer)
  // Orders seeded by a fixture were not requests.
  const seeded = runtime(
    { profile: "expected-contract" },
    {
      fixtures: {
        users: [
          { client_user_id: "fixture-user", user_id: "77777777-7777-4777-8777-777777777777" },
        ],
        orders: [
          {
            order_id: "88888888-8888-4888-8888-888888888888",
            user_id: "77777777-7777-4777-8777-777777777777",
            lab_test_id: labTest.id,
            lab_account_id: customer,
          },
        ],
      } as never,
    },
  )
  const [fixtureView] = await adminOrders(seeded)
  expect(fixtureView?.lab_account_request).toBeNull()
  // A frozen requisition number edit keeps the recorded request.
  await call(mock, "PUT", `/__admin/requisitions/${ids[0]}`, { provider_account_id: "CHANGED" })
  expect((await adminOrders(mock)).find((view) => view.id === ids[0])?.lab_account_request).toEqual(
    {
      labAccountId: customer,
      nestedLabAccountId: null,
    },
  )
})

const setClock = (mock: Mock, body: object) => call(mock, "POST", "/__admin/clock", body)

test("opt-in same-second cancel quirk records the event but leaves status received (#474)", async () => {
  const mock = runtime({ profile: "expected-contract" })
  // Default: cancel always reads back cancelled, even in the creation second.
  await setClock(mock, { set: "2026-03-01T00:00:00Z", freeze: true })
  const normal = await order(mock, { lab_account_id: customer })
  await call(mock, "POST", `/v3/order/${normal.body.order.id}/cancel`)
  expect((await getOrder(mock, normal.body.order.id)).status).toBe("cancelled")

  expect(
    (await call(mock, "PUT", "/__admin/quirks", { quirks: { sameSecondCancelStatus: true } }))
      .status,
  ).toBe(200)
  expect(await (await call(mock, "GET", "/__admin/quirks")).json()).toEqual({
    quirks: { sameSecondCancelStatus: true },
  })
  const same = await order(mock, { lab_account_id: customer })
  const id = same.body.order.id
  const first = await call(mock, "POST", `/v3/order/${id}/cancel`)
  expect(first.status).toBe(200)
  const stale = await getOrder(mock, id)
  expect(stale.status).toBe("received")
  expect(stale.events.map((e) => e.status)).toEqual([
    "received.at_home_phlebotomy.ordered",
    "cancelled.at_home_phlebotomy.cancelled",
  ])
  expect(stale.events[0]?.created_at).toBe(stale.events[1]?.created_at)
  expect(stale.updated_at).toBe(stale.created_at)
  expect((await adminOrders(mock)).find((view) => view.id === id)?.status).toBe(
    "received.at_home_phlebotomy.ordered",
  )
  const listed = (await (await call(mock, "GET", "/v3/orders")).json()) as {
    orders: { id: string; status: string }[]
  }
  expect(listed.orders.find((entry) => entry.id === id)?.status).toBe("received")
  // A second cancel is a no-op; the status stays stale and no event is added.
  await setClock(mock, { advance: "5s" })
  const again = await call(mock, "POST", `/v3/order/${id}/cancel`)
  expect(again.status).toBe(200)
  const afterAgain = await getOrder(mock, id)
  expect(afterAgain.status).toBe("received")
  expect(afterAgain.events).toHaveLength(2)
  // Cancelling at least a second after creation reads back cancelled.
  const later = await order(mock, { lab_account_id: customer })
  await setClock(mock, { advance: "1s" })
  await call(mock, "POST", `/v3/order/${later.body.order.id}/cancel`)
  const settled = await getOrder(mock, later.body.order.id)
  expect(settled.status).toBe("cancelled")
  expect(settled.events.map((e) => e.status)).toEqual([
    "received.at_home_phlebotomy.ordered",
    "cancelled.at_home_phlebotomy.cancelled",
  ])
  // Per namespace, validated, and settable by option.
  const other = await call(mock, "GET", "/__admin/quirks", undefined, "other")
  expect(await other.json()).toEqual({ quirks: {} })
  for (const bad of [{ typo: true }, { sameSecondCancelStatus: "yes" }])
    expect((await call(mock, "PUT", "/__admin/quirks", { quirks: bad })).status).toBe(400)
  expect(() => runtime({ profile: "native" }, { quirks: { bogus: true } as never })).toThrow(
    "quirk",
  )
  expect(
    runtime({ profile: "native" }, { quirks: { sameSecondCancelStatus: true } }).instance().quirks,
  ).toEqual({ sameSecondCancelStatus: true })
})

test("current presets follow the reported team listings and the old ones are unchanged (#475)", () => {
  const states47 = LAB_ACCOUNT_PRESETS.quest_platform?.allowed_billing?.client_bill ?? []
  expect(states47).toHaveLength(47)
  for (const state of ["NY", "NJ", "RI", "DC"]) expect(states47).not.toContain(state)
  expect(LAB_ACCOUNT_PRESETS.bioreference_current_platform).toMatchObject({
    lab: "bioreference",
    org_id: null,
    team_id_allowlist: [],
    allowed_billing: { patient_bill_passthrough: ["NJ", "NY"] },
  })
  expect(LAB_ACCOUNT_PRESETS.quest_sandbox_platform?.allowed_billing).toEqual({
    client_bill: states47,
    commercial_insurance: expect.arrayContaining(["NY", "AZ"]),
  })
  expect(
    LAB_ACCOUNT_PRESETS.quest_sandbox_platform?.allowed_billing?.commercial_insurance,
  ).toHaveLength(50)
  expect(LAB_ACCOUNT_PRESETS.sonora_quest_production_platform).toMatchObject({
    lab: "sonora_quest",
    org_id: null,
    allowed_billing: { client_bill: states47 },
  })
  // The September recording is untouched: suites that pinned it keep working.
  expect(LAB_ACCOUNT_PRESETS.bioreference_platform?.allowed_billing).toEqual({
    client_bill: states47,
  })
  expect(presetAccountId("bioreference_current_platform")).not.toBe(
    presetAccountId("bioreference_platform"),
  )
})

test("a house preset with the current listing refuses omitted client_bill unless the lab is unchecked (#475, #467)", async () => {
  const layout = { presets: ["bioreference_current_platform"] }
  const strict = createRuntime({
    corpus,
    geo: "synthetic",
    identity: "adopt-users",
    labAccounts: layout,
    labAccountBehavior: { profile: "expected-contract" },
  })
  expect((await order(strict)).status).toBe(400)
  const relaxed = createRuntime({
    corpus,
    geo: "synthetic",
    identity: "adopt-users",
    labAccounts: layout,
    labAccountBehavior: {
      profile: "expected-contract",
      omittedAccountBilling: { bioreference: "unchecked" },
    },
  })
  const placed = await order(relaxed)
  expect(placed.status).toBe(200)
  expect(placed.body.order.lab_account_id).toBe(presetAccountId("bioreference_current_platform"))
})

test("the synthetic requisition prints the order and the account number as separate text lines (#464)", async () => {
  const mock = runtime({ profile: "expected-contract" })
  const placed = await order(mock, { lab_account_id: customer })
  const id = placed.body.order.id
  const text = await (await call(mock, "GET", `/v3/order/${id}/requisition/pdf`)).text()
  const shown = [...text.matchAll(/\(((?:[^()\\]|\\.)*)\) Tj/g)].map((m) => m[1])
  expect(shown).toEqual([`Requisition ${id}`, "Account number: MOCK-CUSTOMER"])
  // Each is its own line: the content stream moves to the next line between them.
  expect(text).toContain(`(Requisition ${id}) Tj T* (Account number: MOCK-CUSTOMER) Tj`)
  expect(text).not.toContain(" - Account number")
  // Changing the account afterwards leaves the printed number frozen.
  await call(mock, "PUT", "/__admin/lab-accounts", {
    accounts: [{ id: customer, lab: "bioreference", provider_account_id: "CHANGED" }],
  })
  expect(await (await call(mock, "GET", `/v3/order/${id}/requisition/pdf`)).text()).toContain(
    "(Account number: MOCK-CUSTOMER) Tj",
  )
  // The platform account prints its own (unknown) number; never the intended customer's.
  const plain = createRuntime({
    corpus,
    geo: "synthetic",
    identity: "adopt-users",
    labAccounts: [],
  })
  const platform = await order(plain)
  const platformText = await (
    await call(plain, "GET", `/v3/order/${platform.body.order.id}/requisition/pdf`)
  ).text()
  expect(platformText).not.toContain("MOCK-CUSTOMER")
  expect(platformText).toContain("(Account number: unknown) Tj")
  expect(
    (await call(mock, "GET", "/v3/order/99999999-9999-4999-8999-999999999999/requisition/pdf"))
      .status,
  ).toBe(404)
  expect(
    (await call(mock, "GET", `/v3/order/${id}/requisition/pdf`, undefined, "isolated")).status,
  ).toBe(404)
})
