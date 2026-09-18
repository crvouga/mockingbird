import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { JunctionAPI } from "./src/index.js"
import {
  BILLING_TYPES,
  LAB_ACCOUNT_STATUSES,
  type LabAccountRecord,
  TEAM_LAB_ACCOUNTS,
  US_STATES,
} from "./src/lab-accounts.js"
import type { SeedSource } from "./src/seed-from.js"
import { deterministicUuid, MOCK_TEAM_ID } from "./src/state.js"

const params = fcParameters(process.env)
const AUTH = { "x-vital-api-key": "sk_us_mockingbird" }
const HOST = "https://junction.test"
const now = () => 1_700_000_000_000

/** The documented `Labs`, `LabAccountDelegatedFlow` and `ClientFacingLabAccount` contracts. */
const DOCUMENTED_LABS = [
  "ayumetrix",
  "spiriplex",
  "ussl",
  "quest",
  "sonora_quest",
  "labcorp",
  "bioreference",
  "us_biotek",
  "manual",
  "sanocardio",
  "ihd",
  "nexus",
  "my_uti",
  "crl",
  "mtl",
]
const DOCUMENTED_FLOWS = ["order_delegated", "result_delegated", "fully_delegated", "not_delegated"]
const DOCUMENTED_KEYS = [
  "account_name",
  "allowed_billing",
  "business_units",
  "default_clinical_notes",
  "delegated_flow",
  "id",
  "lab",
  "org_id",
  "provider_account_id",
  "status",
  "team_id_allowlist",
]

const MULTIPLE_ACTIVE =
  "Multiple active lab accounts are linked to your team for this lab; provide lab_account_id"
const NO_ACTIVE = "No active lab account is available for this lab"

/** Labs with no shipped catalog test: branch fixtures need a synthetic one to order against. */
const SYNTHETIC_LABS: Readonly<Record<string, { labId: number; method: string }>> = {
  quest: { labId: 4, method: "walk_in_test" },
  nexus: { labId: 22, method: "testkit" },
  mtl: { labId: 27, method: "testkit" },
  manual: { labId: 99, method: "walk_in_test" },
}

const syntheticLabTestId = (lab: string): string =>
  deterministicUuid(`junction:lab-account-test:${lab}`)

const syntheticLabTest = (lab: string): Record<string, unknown> => {
  const spec = SYNTHETIC_LABS[lab] as { labId: number; method: string }
  return {
    id: syntheticLabTestId(lab),
    slug: `${lab}_panel`,
    name: `${lab} panel`,
    sample_type: "serum",
    method: spec.method,
    price: 0,
    is_active: true,
    status: "active",
    fasting: false,
    lab: {
      id: spec.labId,
      slug: lab,
      name: lab,
      first_line_address: "n/a",
      city: "n/a",
      zipcode: "00000",
      collection_methods: [spec.method],
      sample_types: ["serum"],
      logo_url: null,
    },
  }
}

/** A SeedSource backed by the synthetic lab-test table — no network. */
const seedSource = (): SeedSource => ({
  baseUrl: "https://seed.junction.local",
  headers: {},
  fetch: async (request: Request) => {
    const id = new URL(request.url).pathname.match(/^\/v3\/lab_tests\/([^/]+)$/)?.[1]
    const lab = Object.keys(SYNTHETIC_LABS).find((slug) => syntheticLabTestId(slug) === id)
    if (lab === undefined) return new Response("not found", { status: 404 })
    return Response.json(syntheticLabTest(lab))
  },
})

const seededApi = async (): Promise<JunctionAPI> => {
  const api = new JunctionAPI({ now })
  await api.ensureLabTests(seedSource(), Object.keys(SYNTHETIC_LABS).map(syntheticLabTestId))
  return api
}

const request = (api: JunctionAPI, path: string, init: RequestInit = {}) =>
  api.fetch(new Request(`${HOST}${path}`, { ...init, headers: { ...AUTH, ...init.headers } }))

type LabAccountBody = { data: Array<Record<string, unknown>> }

const listing = async (api: JunctionAPI, query = ""): Promise<LabAccountBody> => {
  const response = await request(api, `/v3/lab_test/lab_account${query}`)
  expect(response.status).toBe(200)
  return (await response.json()) as LabAccountBody
}

const teamAccounts = (): LabAccountRecord[] =>
  TEAM_LAB_ACCOUNTS.filter((entry) => entry.team_id_allowlist.includes(MOCK_TEAM_ID))

/** The Nth fixture account for a lab, in listing order. */
const accountId = (lab: string, index = 0): string =>
  (TEAM_LAB_ACCOUNTS.filter((entry) => entry.lab === lab)[index] as LabAccountRecord).id

let userSeq = 0
const createUser = async (api: JunctionAPI): Promise<string> => {
  const response = await request(api, "/v2/user", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_user_id: `lab-account-user-${++userSeq}` }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { user_id: string }).user_id
}

const orderBody = (
  userId: string,
  labTestId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  user_id: userId,
  patient_details: {
    first_name: "Ada",
    last_name: "Lovelace",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155551234",
    email: "ada@example.com",
  },
  patient_address: {
    first_line: "1 Main St",
    city: "San Diego",
    state: "CA",
    zip: "92101",
    country: "US",
  },
  order_set: { lab_test_ids: [labTestId] },
  ...extra,
})

const postOrder = (api: JunctionAPI, body: Record<string, unknown>) =>
  request(api, "/v3/order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const errorDetail = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { detail: unknown }).detail

describe("Junction team lab accounts", () => {
  test("listing exposes exactly the team-linked accounts with the documented shape", async () => {
    const api = await seededApi()
    const body = await listing(api)
    const linked = teamAccounts()

    expect(body.data.map((entry) => entry.id)).toEqual(linked.map((entry) => entry.id))
    expect(body.data.some((entry) => entry.id === accountId("ihd"))).toBe(false)

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...body.data),
        fc.constantFrom(...US_STATES),
        async (entry, state) => {
          expect(Object.keys(entry).sort()).toEqual(DOCUMENTED_KEYS)
          expect(DOCUMENTED_LABS).toContain(String(entry.lab))
          expect(DOCUMENTED_FLOWS).toContain(String(entry.delegated_flow))
          expect(LAB_ACCOUNT_STATUSES as readonly string[]).toContain(String(entry.status))
          expect(typeof entry.provider_account_id).toBe("string")
          expect(entry.provider_account_id as string).not.toHaveLength(0)
          expect(typeof entry.id).toBe("string")
          expect(entry.team_id_allowlist as string[]).toContain(MOCK_TEAM_ID)
          expect(entry.org_id === null || typeof entry.org_id === "string").toBe(true)
          expect(entry.account_name === null || typeof entry.account_name === "string").toBe(true)
          expect(entry.business_units === null || Array.isArray(entry.business_units)).toBe(true)
          const billing = entry.allowed_billing as Record<string, string[]>
          expect(Object.keys(billing).length).toBeGreaterThan(0)
          for (const [type, states] of Object.entries(billing)) {
            expect(BILLING_TYPES as readonly string[]).toContain(type)
            expect(states.length).toBeGreaterThan(0)
            for (const entryState of states) expect(US_STATES).toContain(entryState)
          }
          // Every fixture account bills `client_bill` in every published state.
          expect(billing.client_bill).toContain(state)
        },
      ),
      params,
    )
  })

  test("listing filters by lab_account_id and status", async () => {
    const api = await seededApi()
    const linked = teamAccounts()

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...linked), async (account) => {
        const byId = await listing(api, `?lab_account_id=${account.id}`)
        expect(byId.data).toHaveLength(1)
        expect(byId.data[0]?.id).toBe(account.id)
        expect(byId.data[0]?.lab).toBe(account.lab)
      }),
      params,
    )

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("active", "pending", "suspended", "ready_to_launch"),
        async (status) => {
          const filtered = await listing(api, `?status=${status}`)
          const expected = linked.filter((entry) => entry.status === status)
          expect(filtered.data.map((entry) => entry.id)).toEqual(expected.map((entry) => entry.id))
        },
      ),
      params,
    )

    await fc.assert(
      fc.asyncProperty(fc.uuid({ version: 4 }), async (id) => {
        fc.pre(!TEAM_LAB_ACCOUNTS.some((entry) => entry.id === id))
        expect((await listing(api, `?lab_account_id=${id}`)).data).toEqual([])
      }),
      params,
    )
  })

  test("listing rejects a malformed lab_account_id and an unknown status", async () => {
    const api = await seededApi()

    const badId = await request(api, "/v3/lab_test/lab_account?lab_account_id=nope")
    expect(badId.status).toBe(422)
    expect(await errorDetail(badId)).toEqual([
      expect.objectContaining({
        type: "uuid_parsing",
        loc: ["query", "lab_account_id"],
        input: "nope",
      }),
    ])

    const badStatus = await request(api, "/v3/lab_test/lab_account?status=bogus")
    expect(badStatus.status).toBe(422)
    expect(await errorDetail(badStatus)).toEqual([
      {
        type: "enum",
        loc: ["query", "status"],
        msg: "Input should be 'active', 'pending', 'suspended' or 'ready_to_launch'",
        input: "bogus",
        ctx: { expected: "'active', 'pending', 'suspended' or 'ready_to_launch'" },
      },
    ])
  })
})

describe("Junction order lab-account routing", () => {
  test("selects the documented account for every branch", async () => {
    const cases: Array<{ lab: string; id: string | null; status: number; detail?: string }> = [
      { lab: "nexus", id: null, status: 400, detail: MULTIPLE_ACTIVE },
      { lab: "nexus", id: accountId("nexus", 1), status: 200 },
      { lab: "mtl", id: null, status: 400, detail: NO_ACTIVE },
      { lab: "mtl", id: accountId("mtl"), status: 400, detail: "Lab account is not active" },
      { lab: "quest", id: null, status: 200 },
      { lab: "quest", id: accountId("quest", 1), status: 400, detail: "Lab account is not active" },
      { lab: "quest", id: accountId("quest"), status: 200 },
      { lab: "labcorp", id: null, status: 200 },
      {
        lab: "labcorp",
        id: accountId("quest"),
        status: 400,
        detail: "Lab account is not associated with lab labcorp",
      },
      {
        lab: "manual",
        id: null,
        status: 400,
        detail: "No active lab account is available for lab manual",
      },
      {
        lab: "nexus",
        id: accountId("ihd"),
        status: 400,
        detail: "Lab account is not linked to your team",
      },
      {
        lab: "quest",
        id: accountId("nexus"),
        status: 400,
        detail: "Lab account is not associated with lab quest",
      },
    ]

    const api = await seededApi()
    const unknownId = deterministicUuid("junction:lab-account:does-not-exist")

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...cases), async (testCase) => {
        const userId = await createUser(api)
        const labTestId =
          testCase.lab === "labcorp"
            ? "c533549c-1e62-4afe-9a0e-0567a9b2bcc2"
            : syntheticLabTestId(testCase.lab)
        const response = await postOrder(
          api,
          orderBody(userId, labTestId, { lab_account_id: testCase.id }),
        )
        expect(response.status).toBe(testCase.status)
        if (testCase.status === 200) {
          const { order } = (await response.json()) as { order: Record<string, unknown> }
          expect(order.billing_type).toBe("client_bill")
          // A requested account id round-trips; an implicitly routed order omits the field.
          expect(order.lab_account_id).toBe(testCase.id ?? undefined)
        } else {
          expect(await errorDetail(response)).toBe(testCase.detail)
        }
      }),
      params,
    )

    const userId = await createUser(api)
    const unknown = await postOrder(
      api,
      orderBody(userId, syntheticLabTestId("quest"), { lab_account_id: unknownId }),
    )
    expect(unknown.status).toBe(400)
    expect(await errorDetail(unknown)).toBe("Lab account does not exist")
  })

  test("an unknown lab account id is rejected for any random UUID", async () => {
    const api = await seededApi()
    await fc.assert(
      fc.asyncProperty(fc.uuid({ version: 4 }), async (id) => {
        fc.pre(!TEAM_LAB_ACCOUNTS.some((entry) => entry.id === id))
        const userId = await createUser(api)
        const response = await postOrder(
          api,
          orderBody(userId, syntheticLabTestId("quest"), { lab_account_id: id }),
        )
        expect(response.status).toBe(400)
        expect(await errorDetail(response)).toBe("Lab account does not exist")
      }),
      params,
    )
  })
})

describe("Junction order billing rules", () => {
  test("platform accounts accept every billing type in every state", async () => {
    const api = await seededApi()
    // `ussl` uses Junction's platform account and has no lab-level state restriction.
    const labTestId = "0cb9f34f-c3df-4a13-8ca1-19429a82611b"

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...BILLING_TYPES),
        fc.constantFrom(...US_STATES),
        async (billingType, state) => {
          const userId = await createUser(api)
          const response = await postOrder(
            api,
            orderBody(userId, labTestId, {
              billing_type: billingType,
              icd_codes: billingType === "commercial_insurance" ? ["E11.9"] : null,
              patient_address: {
                first_line: "1 Main St",
                city: "San Diego",
                state,
                zip: "92101",
                country: "US",
              },
            }),
          )
          expect(response.status).toBe(200)
        },
      ),
      { ...params, numRuns: 40 },
    )
  })

  test("a linked account only supports its allowed_billing types and states", async () => {
    const api = await seededApi()
    // `quest-primary`: client_bill everywhere, commercial_insurance in AZ/CA only.
    const labTestId = syntheticLabTestId("quest")
    const linkedId = accountId("quest")

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...US_STATES), async (state) => {
        const userId = await createUser(api)
        const response = await postOrder(
          api,
          orderBody(userId, labTestId, {
            lab_account_id: linkedId,
            billing_type: "client_bill",
            patient_address: {
              first_line: "1 Main St",
              city: "San Diego",
              state,
              zip: "92101",
              country: "US",
            },
          }),
        )
        expect(response.status).toBe(200)
      }),
      { ...params, numRuns: 25 },
    )

    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...US_STATES), fc.boolean(), async (state, withIcdCodes) => {
        const userId = await createUser(api)
        const response = await postOrder(
          api,
          orderBody(userId, labTestId, {
            lab_account_id: linkedId,
            billing_type: "commercial_insurance",
            icd_codes: withIcdCodes ? ["E11.9"] : null,
            patient_address: {
              first_line: "1 Main St",
              city: "San Diego",
              state,
              zip: "92101",
              country: "US",
            },
          }),
        )
        const inState = state === "AZ" || state === "CA"
        if (inState && withIcdCodes) {
          expect(response.status).toBe(200)
          const { order } = (await response.json()) as { order: Record<string, unknown> }
          expect(order.billing_type).toBe("commercial_insurance")
          expect(order.icd_codes).toEqual(["E11.9"])
          return
        }
        expect(response.status).toBe(400)
        expect(await errorDetail(response)).toBe(
          inState
            ? "Commercial insurance orders require at least one ICD code in icd_codes"
            : `Billing type commercial_insurance is not available in state ${state} for the lab account used for this order`,
        )
      }),
      { ...params, numRuns: 30 },
    )

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...BILLING_TYPES.filter((type) => type !== "client_bill")),
        async (billingType) => {
          if (billingType === "commercial_insurance") return
          const userId = await createUser(api)
          const response = await postOrder(
            api,
            orderBody(userId, labTestId, { lab_account_id: linkedId, billing_type: billingType }),
          )
          expect(response.status).toBe(400)
          expect(await errorDetail(response)).toBe(
            `Billing type ${billingType} is not supported by the lab account used for this order`,
          )
        },
      ),
      params,
    )

    // `nexus-a` supports client_bill only.
    const nexusId = accountId("nexus")
    const nexusUserId = await createUser(api)
    const nexusPatientBill = await postOrder(
      api,
      orderBody(nexusUserId, syntheticLabTestId("nexus"), {
        lab_account_id: nexusId,
        billing_type: "patient_bill",
      }),
    )
    expect(nexusPatientBill.status).toBe(400)
    expect(await errorDetail(nexusPatientBill)).toBe(
      "Billing type patient_bill is not supported by the lab account used for this order",
    )
    const nexusClientBill = await postOrder(
      api,
      orderBody(await createUser(api), syntheticLabTestId("nexus"), { lab_account_id: nexusId }),
    )
    expect(nexusClientBill.status).toBe(200)
  })

  test("created orders persist billing_type and icd_codes", async () => {
    const api = await seededApi()
    const labTestId = syntheticLabTestId("quest")

    const clientBillResponse = await postOrder(api, orderBody(await createUser(api), labTestId))
    expect(clientBillResponse.status).toBe(200)
    const clientBill = (await clientBillResponse.json()) as { order: Record<string, unknown> }
    expect(clientBill.order.billing_type).toBe("client_bill")
    expect(clientBill.order.icd_codes).toBeNull()

    const insuranceResponse = await postOrder(
      api,
      orderBody(await createUser(api), labTestId, {
        billing_type: "commercial_insurance",
        icd_codes: ["E11.9", "I10"],
        patient_address: {
          first_line: "1 Main St",
          city: "San Diego",
          state: "AZ",
          zip: "85004",
          country: "US",
        },
      }),
    )
    expect(insuranceResponse.status).toBe(200)
    const insurance = (await insuranceResponse.json()) as { order: Record<string, unknown> }
    expect(insurance.order.billing_type).toBe("commercial_insurance")
    expect(insurance.order.icd_codes).toEqual(["E11.9", "I10"])

    const stored = await request(api, `/v3/order/${String(insurance.order.id)}`)
    expect(stored.status).toBe(200)
    const storedOrder = (await stored.json()) as Record<string, unknown>
    expect(storedOrder.billing_type).toBe("commercial_insurance")
    expect(storedOrder.icd_codes).toEqual(["E11.9", "I10"])
  })

  test("ordering shipped lab tests without a lab account is unchanged", async () => {
    const api = await seededApi()
    for (const labTestId of [
      "c533549c-1e62-4afe-9a0e-0567a9b2bcc2",
      "0cb9f34f-c3df-4a13-8ca1-19429a82611b",
    ]) {
      const response = await postOrder(api, orderBody(await createUser(api), labTestId))
      expect(response.status).toBe(200)
      const { order } = (await response.json()) as { order: Record<string, unknown> }
      expect(order.billing_type).toBe("client_bill")
      expect(order.icd_codes).toBeNull()
    }
  })
})

describe("Junction area info lab-account scope", () => {
  test("scopes central_labs to the requested account and leaves the default response alone", async () => {
    const api = await seededApi()

    const unscoped = await request(api, "/v3/order/area/info?zip_code=85004")
    expect(unscoped.status).toBe(200)
    const baseline = (await unscoped.json()) as { central_labs: Record<string, unknown> }
    expect(Object.keys(baseline.central_labs)).toEqual([
      "sonora_quest",
      "labcorp",
      "bioreference",
      "quest",
    ])

    const scoped = await request(
      api,
      `/v3/order/area/info?zip_code=85004&lab_account_id=${accountId("quest")}`,
    )
    expect(scoped.status).toBe(200)
    const scopedBody = (await scoped.json()) as {
      central_labs: Record<string, { supported_bill_types: string[] }>
    }
    expect(Object.keys(scopedBody.central_labs)).toEqual(["quest"])
    expect(scopedBody.central_labs.quest?.supported_bill_types).toEqual([
      "client_bill",
      "commercial_insurance",
    ])

    const unknown = await request(api, "/v3/order/area/info?zip_code=85004&lab_account_id=nope")
    expect(unknown.status).toBe(422)
    expect(await errorDetail(unknown)).toEqual([
      expect.objectContaining({ type: "uuid_parsing", loc: ["query", "lab_account_id"] }),
    ])

    const missing = await request(
      api,
      `/v3/order/area/info?zip_code=85004&lab_account_id=${deterministicUuid("junction:lab-account:missing")}`,
    )
    expect(missing.status).toBe(404)
    expect(await errorDetail(missing)).toBe("Lab account does not exist")

    const inactive = await request(
      api,
      `/v3/order/area/info?zip_code=85004&lab_account_id=${accountId("mtl")}`,
    )
    expect(inactive.status).toBe(400)
    expect(await errorDetail(inactive)).toBe("Lab account is not active")
  })
})
