import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  createRuntime,
  JunctionAPI,
  type JunctionRuntime,
  LAB_ACCOUNT_PRESETS,
  MOCK_TEAM_ID,
  PLATFORM_ACCOUNT_STATES,
  parseSealedCorpus,
  presetAccountId,
  type SealedCorpus,
  TEAM_LAB_ACCOUNTS,
  US_STATES,
} from "./src/index.js"
import { LAB_TEST_CATALOG, type LabTestRecord, TEAM_LABS } from "./src/state.js"

const params = fcParameters(process.env)
const AUTH = { "x-vital-api-key": "sk_us_test" }
const HOST = "http://mock.local"

type Json = Record<string, unknown>

const TEAM = "54194c5d-7039-46ff-ac1a-e40da166721c"
const OTHER = "9d2b3f4e-1a5c-4d6e-8f70-112233445566"
const LINKED = "d0bca04b-3ec1-45ed-ae3e-21ae34a5b412"
const UNLINKED = "cb305104-b608-4499-ab29-5a76eb3cc85d"
const OPEN = "8c0631b3-4681-4532-8372-bca1bd4fbc06"

const labcorpTest = LAB_TEST_CATALOG[0] as LabTestRecord
const bioreferenceLab = TEAM_LABS.find((lab) => lab.slug === "bioreference") as Json
const BIOREFERENCE_TEST: LabTestRecord = {
  ...labcorpTest,
  id: "5f0b7a3e-2c1d-4e8f-9a6b-0c1d2e3f4a5b",
  slug: "bioreference_cmp",
  name: "BioReference CMP",
  method: "walk_in_test",
  lab: { ...bioreferenceLab },
}

const account = (id: string, allowlist: string[], extra: Json = {}): Json => ({
  id,
  lab: "bioreference",
  org_id: null,
  status: "active",
  delegated_flow: "not_delegated",
  provider_account_id: `provider-${id.slice(0, 8)}`,
  account_name: null,
  default_clinical_notes: null,
  business_units: null,
  allowed_billing: { client_bill: [...PLATFORM_ACCOUNT_STATES] },
  team_id_allowlist: allowlist,
  ...extra,
})

/** A recording of a BioReference-linked team: one linked, one foreign, one open account. */
const corpusOf = (version: 1 | 2, accounts: Json[] = []): SealedCorpus =>
  parseSealedCorpus({
    version,
    recordedAt: "2026-09-21T00:00:00.000Z",
    source: "https://api.sandbox.tryvital.io",
    ...(version === 2 ? { teamId: TEAM } : {}),
    observations: {},
    catalog: {
      labTests: [labcorpTest, BIOREFERENCE_TEST],
      labs: [...TEAM_LABS],
      expectedResults: {},
    },
    labAccounts: accounts,
  })

const teamCorpus = (version: 1 | 2 = 2) =>
  corpusOf(version, [
    account(LINKED, [TEAM], { delegated_flow: "order_delegated" }),
    account(UNLINKED, [OTHER]),
    account(OPEN, []),
  ])

const call = async (
  target: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {},
) => {
  const response = await target.fetch(
    new Request(`${HOST}${path}`, {
      method,
      headers: {
        ...AUTH,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  )
  const text = await response.text()
  let body: unknown = text
  try {
    body = text === "" ? null : JSON.parse(text)
  } catch {}
  return { status: response.status, body: body as Json }
}

let userSeq = 0
const createUser = async (target: { fetch(request: Request): Promise<Response> }, ns?: string) => {
  const res = await call(target, "POST", "/v2/user", {
    body: { client_user_id: `team-user-${++userSeq}` },
    ...(ns ? { headers: { "x-mockingbird-namespace": ns } } : {}),
  })
  expect(res.status).toBe(200)
  return res.body.user_id as string
}

const orderBody = (userId: string, labTestId: string, state: string, extra: Json = {}) => ({
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
    city: "Somewhere",
    state,
    zip: "07030",
    country: "US",
  },
  order_set: { lab_test_ids: [labTestId] },
  ...extra,
})

const areaInfo = (target: { fetch(request: Request): Promise<Response> }, id: string) =>
  call(target, "GET", `/v3/order/area/info?zip_code=10001&lab_account_id=${id}`)

const admin = (
  runtime: JunctionRuntime,
  method: string,
  path: string,
  body?: unknown,
  ns?: string,
) =>
  call(runtime, method, `/__admin${path}`, {
    ...(body !== undefined ? { body } : {}),
    ...(ns ? { headers: { "x-mockingbird-namespace": ns } } : {}),
  })

describe("M1: availability reads resolve lab accounts from the live list", () => {
  test("a configured account id is accepted by area info", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid({ version: 4 }), async (id) => {
        const api = new JunctionAPI({
          labAccounts: [{ id, lab: "bioreference", states: ["NY", "NJ"] }],
        })
        expect((await areaInfo(api, id)).status).toBe(200)
      }),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 30_000)

  test("an account only present in a loaded corpus is accepted", async () => {
    const api = new JunctionAPI({ corpus: teamCorpus(), geo: "synthetic" })
    expect((await areaInfo(api, LINKED)).status).toBe(200)
  })

  test("a built-in fixture id is unknown once the list is configured", async () => {
    const api = new JunctionAPI({ labAccounts: [{ id: LINKED, lab: "bioreference" }] })
    const builtin = TEAM_LAB_ACCOUNTS[0]?.id as string
    const res = await areaInfo(api, builtin)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ detail: "Lab account does not exist" })
  })
})

describe("M2: configurable team identity", () => {
  test("a version-2 corpus answers as its recorded team", async () => {
    const api = new JunctionAPI({ corpus: teamCorpus(), geo: "synthetic" })
    expect(api.teamId).toBe(TEAM)
    const userId = await createUser(api)
    expect((await call(api, "GET", `/v2/user/${userId}`)).body.team_id).toBe(TEAM)
  })

  test("an account linked only to another team is refused, one linked to the team orders", async () => {
    const api = new JunctionAPI({ corpus: teamCorpus(), geo: "synthetic" })
    const userId = await createUser(api)
    const refused = await call(api, "POST", "/v3/order", {
      body: orderBody(userId, BIOREFERENCE_TEST.id, "NJ", { lab_account_id: UNLINKED }),
    })
    expect(refused.status).toBe(400)
    expect(refused.body).toEqual({ detail: "Lab account is not linked to your team" })
    const placed = await call(api, "POST", "/v3/order", {
      body: orderBody(userId, BIOREFERENCE_TEST.id, "PA", { lab_account_id: LINKED }),
    })
    expect(placed.status).toBe(200)
    expect((placed.body.order as Json).team_id).toBe(TEAM)
  })

  test("the recorded allowlist is kept verbatim, and the listing omits another team's account", async () => {
    const api = new JunctionAPI({ corpus: teamCorpus(), geo: "synthetic" })
    const listed = (await call(api, "GET", "/v3/lab_test/lab_account")).body.data as Json[]
    expect(listed.map((entry) => entry.id).sort()).toEqual([LINKED, OPEN].sort())
    expect(listed.find((entry) => entry.id === OPEN)?.team_id_allowlist).toEqual([])
    expect(listed.find((entry) => entry.id === LINKED)?.team_id_allowlist).toEqual([TEAM])
  })

  test("a version-1 corpus still loads and links every account to the mock team, as 0.2.0 did", async () => {
    const api = new JunctionAPI({ corpus: teamCorpus(1), geo: "synthetic" })
    expect(api.teamId).toBe(MOCK_TEAM_ID)
    const listed = (await call(api, "GET", "/v3/lab_test/lab_account")).body.data as Json[]
    expect(listed).toHaveLength(3)
    for (const entry of listed) expect(entry.team_id_allowlist as string[]).toContain(MOCK_TEAM_ID)
    const userId = await createUser(api)
    const placed = await call(api, "POST", "/v3/order", {
      body: orderBody(userId, BIOREFERENCE_TEST.id, "PA", { lab_account_id: UNLINKED }),
    })
    expect(placed.status).toBe(200)
  })

  test("the teamId option wins, and GET /__admin/team reports it per namespace", async () => {
    const runtime = createRuntime({ corpus: teamCorpus(), geo: "synthetic", teamId: OTHER })
    expect((await admin(runtime, "GET", "/team")).body).toEqual({ teamId: OTHER })
    expect((await admin(runtime, "GET", "/team", undefined, "w1")).body).toEqual({ teamId: OTHER })
    expect(createRuntime({ corpus: teamCorpus() }).instance().teamId).toBe(TEAM)
    expect(createRuntime().instance().teamId).toBe(MOCK_TEAM_ID)
  })

  test("parseSealedCorpus accepts versions 1 and 2 and refuses others", () => {
    expect(() => corpusOf(1)).not.toThrow()
    expect(() => corpusOf(2)).not.toThrow()
    expect(() => parseSealedCorpus({ ...corpusOf(2), version: 3 })).toThrow(/version/)
    expect(() => parseSealedCorpus({ ...corpusOf(2), teamId: 7 })).toThrow(/teamId/)
  })
})

describe("M3: lab-account configuration ergonomics", () => {
  const bioreference = () =>
    createRuntime({ corpus: corpusOf(2), geo: "synthetic", labAccounts: [] })

  test("the NY/NJ delegated preset client-bills in NJ and refuses every other state", async () => {
    const runtime = bioreference()
    const added = await admin(runtime, "POST", "/lab-accounts/presets/bioreference_ny_nj_delegated")
    expect(added.status).toBe(201)
    const id = presetAccountId("bioreference_ny_nj_delegated")
    expect(added.body.id).toBe(id)
    const userId = await createUser(runtime)
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...US_STATES), async (state) => {
        const res = await call(runtime, "POST", "/v3/order", {
          body: orderBody(userId, BIOREFERENCE_TEST.id, state, { lab_account_id: id }),
        })
        if (state === "NY" || state === "NJ") expect(res.status).toBe(200)
        else {
          expect(res.status).toBe(400)
          expect(res.body).toEqual({
            detail: `Billing type client_bill is not available in state ${state} for the lab account used for this order`,
          })
        }
      }),
      { ...params, numRuns: params.numRuns ?? 30 },
    )
  }, 30_000)

  test("PATCH suspends an account, and ordering through it is refused", async () => {
    const runtime = bioreference()
    await admin(runtime, "POST", "/lab-accounts/presets/bioreference_ny_nj_delegated")
    const id = presetAccountId("bioreference_ny_nj_delegated")
    const patched = await admin(runtime, "PATCH", `/lab-accounts/${id}`, { status: "suspended" })
    expect(patched.status).toBe(200)
    expect(patched.body.status).toBe("suspended")
    const userId = await createUser(runtime)
    const res = await call(runtime, "POST", "/v3/order", {
      body: orderBody(userId, BIOREFERENCE_TEST.id, "NJ", { lab_account_id: id }),
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ detail: "Lab account is not active" })
  })

  test("PATCH states replaces only the client_bill states", async () => {
    const runtime = bioreference()
    const id = "0f1e2d3c-4b5a-4968-8776-655443322110"
    await admin(runtime, "POST", "/lab-accounts", {
      id,
      lab: "bioreference",
      allowed_billing: { client_bill: ["NY"], patient_bill: ["CA"] },
    })
    const patched = await admin(runtime, "PATCH", `/lab-accounts/${id}`, { states: ["TX"] })
    expect(patched.body.allowed_billing).toEqual({ client_bill: ["TX"], patient_bill: ["CA"] })
  })

  test("POST, PATCH and DELETE show up in GET /v3/lab_test/lab_account immediately", async () => {
    const runtime = bioreference()
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            op: fc.constantFrom("add", "patch", "delete"),
            index: fc.integer({ min: 0, max: 3 }),
            status: fc.constantFrom("active", "pending", "suspended", "ready_to_launch"),
          }),
          { maxLength: 12 },
        ),
        async (ops) => {
          await admin(runtime, "PUT", "/lab-accounts", { accounts: [] })
          const model = new Map<string, string>()
          const ids = [0, 1, 2, 3].map((n) => `0000000${n}-aaaa-4bbb-8ccc-dddddddddddd`)
          for (const { op, index, status } of ops) {
            const id = ids[index] as string
            if (op === "add") {
              const res = await admin(runtime, "POST", "/lab-accounts", {
                id,
                lab: "quest",
                status,
              })
              expect(res.status).toBe(model.has(id) ? 409 : 201)
              if (!model.has(id)) model.set(id, status)
            } else if (op === "patch") {
              const res = await admin(runtime, "PATCH", `/lab-accounts/${id}`, { status })
              expect(res.status).toBe(model.has(id) ? 200 : 404)
              if (model.has(id)) model.set(id, status)
            } else {
              const res = await admin(runtime, "DELETE", `/lab-accounts/${id}`)
              expect(res.status).toBe(model.has(id) ? 200 : 404)
              model.delete(id)
            }
            const listed = (await call(runtime, "GET", "/v3/lab_test/lab_account")).body
              .data as Json[]
            expect(Object.fromEntries(listed.map((entry) => [entry.id, entry.status]))).toEqual(
              Object.fromEntries(model),
            )
          }
        },
      ),
      { ...params, numRuns: params.numRuns ?? 25 },
    )
  }, 30_000)

  test("namespaces are isolated, and each keeps its layout across its own reset", async () => {
    const runtime = bioreference()
    await admin(runtime, "POST", "/lab-accounts/presets/quest_platform", undefined, "a")
    await admin(runtime, "POST", "/lab-accounts/presets/labcorp_platform", undefined, "b")
    const labsIn = async (ns: string) =>
      ((await admin(runtime, "GET", "/lab-accounts", undefined, ns)).body.data as Json[]).map(
        (entry) => entry.lab,
      )
    expect(await labsIn("a")).toEqual(["quest"])
    expect(await labsIn("b")).toEqual(["labcorp"])
    await call(runtime, "POST", "/__admin/reset?namespace=a")
    await call(runtime, "POST", "/__admin/reset?all=1")
    expect(await labsIn("a")).toEqual(["quest"])
    expect(await labsIn("b")).toEqual(["labcorp"])
  })

  test("GET presets lists every preset with its full record; unknown names 404", async () => {
    const runtime = bioreference()
    const res = await admin(runtime, "GET", "/lab-accounts/presets")
    const presets = res.body.presets as Record<string, Json>
    expect(Object.keys(presets).sort()).toEqual(Object.keys(LAB_ACCOUNT_PRESETS).sort())
    expect(presets.quest_platform?.allowed_billing).toEqual({
      client_bill: PLATFORM_ACCOUNT_STATES,
    })
    expect(presets.suspended_quest?.status).toBe("suspended")
    expect(presets.bioreference_ny_nj_delegated?.delegated_flow).toBe("order_delegated")
    expect((await admin(runtime, "POST", "/lab-accounts/presets/nope")).status).toBe(404)
    const custom = await admin(runtime, "POST", "/lab-accounts/presets/quest_platform", {
      id: "11111111-2222-4333-8444-555555555555",
    })
    expect(custom.body.id).toBe("11111111-2222-4333-8444-555555555555")
  })

  test("validation errors are 400s in the admin shape, naming the field", async () => {
    const runtime = bioreference()
    const cases: [Json, RegExp][] = [
      [{ id: "x", lab: "quest", states: ["ZZ"] }, /states: ZZ is not a US state code/],
      [{ id: "x", lab: "quest", status: "frozen" }, /status must be one of/],
      [{ id: "x", lab: "quest", delegated_flow: "sideways" }, /delegated_flow must be one of/],
      [{ id: "x", lab: "quest", allowed_billing: { barter: ["NY"] } }, /allowed_billing.barter/],
      [{ id: "x" }, /lab must be/],
      [{ lab: "quest" }, /non-empty id/],
    ]
    for (const [body, message] of cases) {
      const res = await admin(runtime, "POST", "/lab-accounts", body)
      expect(res.status).toBe(400)
      expect((res.body.error as Json).type).toBe("mockingbird_admin")
      expect((res.body.error as Json).message as string).toMatch(message)
    }
  })

  test("a layout of presets plus accounts is accepted as an option and by PUT", async () => {
    const runtime = createRuntime({
      corpus: corpusOf(2),
      geo: "synthetic",
      labAccounts: {
        presets: ["bioreference_ny_nj_delegated", { name: "quest_platform", id: OPEN }],
        accounts: [{ id: LINKED, lab: "labcorp" }],
      },
    })
    const ids = runtime
      .instance()
      .labAccounts()
      .map((entry) => entry.id)
    expect(ids).toEqual([presetAccountId("bioreference_ny_nj_delegated"), OPEN, LINKED])
    const put = await admin(runtime, "PUT", "/lab-accounts", { presets: ["suspended_labcorp"] })
    expect((put.body.data as Json[]).map((entry) => entry.status)).toEqual(["suspended"])
    expect(() => createRuntime({ labAccounts: { presets: ["bogus"] } }).instance()).toThrow(
      /no lab-account preset "bogus"/,
    )
  })
})

describe("M8: GET /v3/lab_tests serves the catalog as a bare array", () => {
  test("record-for-record equal to the loaded corpus", async () => {
    const corpus = corpusOf(2)
    const api = new JunctionAPI({ corpus, geo: "synthetic" })
    const res = await call(api, "GET", "/v3/lab_tests")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toEqual(corpus.catalog.labTests as unknown as Json)
    const paged = await call(api, "GET", "/v3/lab_test")
    expect(res.body).toEqual(paged.body.data as Json)
  })

  test("filters narrow the same records the unfiltered read returns", async () => {
    const api = new JunctionAPI()
    const all = (await call(api, "GET", "/v3/lab_tests")).body as unknown as LabTestRecord[]
    await fc.assert(
      fc.asyncProperty(
        fc.record(
          {
            lab_slug: fc.constantFrom("labcorp", "ussl", "quest"),
            collection_method: fc.constantFrom("walk_in_test", "testkit", "at_home_phlebotomy"),
            status: fc.constantFrom("active", "inactive"),
            name: fc.constantFrom("lipid", "CMP", "zzz"),
          },
          { requiredKeys: [] },
        ),
        async (filters) => {
          const query = new URLSearchParams(filters as Record<string, string>).toString()
          const res = await call(api, "GET", `/v3/lab_tests${query ? `?${query}` : ""}`)
          expect(res.status).toBe(200)
          const expected = all.filter(
            (test) =>
              (filters.lab_slug === undefined || test.lab.slug === filters.lab_slug) &&
              (filters.collection_method === undefined ||
                test.method === filters.collection_method) &&
              (filters.status === undefined || test.status === filters.status) &&
              (filters.name === undefined ||
                test.name.toLowerCase().includes(filters.name.toLowerCase())),
          )
          expect(res.body).toEqual(expected as unknown as Json)
        },
      ),
      { ...params, numRuns: params.numRuns ?? 40 },
    )
  }, 30_000)

  test("an out-of-enum filter is a 422", async () => {
    const res = await call(new JunctionAPI(), "GET", "/v3/lab_tests?generation_method=sometimes")
    expect(res.status).toBe(422)
    expect(((res.body.detail as Json[])[0] as Json).loc).toEqual(["query", "generation_method"])
  })
})
