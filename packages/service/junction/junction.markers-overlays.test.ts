/**
 * #470 (a-la-carte markers, pricing estimate, add-on result lines) and #471 (catalog overlays).
 * The request and response shapes are the ones documented at
 * https://docs.junction.com/api-reference/lab-testing/biomarkers and
 * https://docs.junction.com/api-reference/lab-testing/estimate-order-set-pricing.
 */
import { expect, test } from "bun:test"
import { defaultCorpus } from "./src/corpus.js"
import { createRuntime, type JunctionRuntimeOptions } from "./src/index.js"

const KEY = { "x-vital-api-key": "sk_us_test", "content-type": "application/json" }

// biome-ignore lint/suspicious/noExplicitAny: the tests read loosely typed JSON response bodies
type Json = Record<string, any>

const call = async (
  mock: { fetch(request: Request): Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
  namespace = "default",
) => {
  const response = await mock.fetch(
    new Request(`http://mock.local${path}`, {
      method,
      headers: { ...KEY, "x-mockingbird-namespace": namespace },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const text = await response.text()
  let parsed: Json = {}
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

const LIPID = "b439efda-1e07-4d2c-8afb-51771c7cc0cb"
const FEMALE_WELLNESS = "0cb9f34f-c3df-4a13-8ca1-19429a82611b"

const catalog: NonNullable<JunctionRuntimeOptions["markerCatalog"]> = [
  {
    id: 9001,
    name: "Vitamin D, 25-Hydroxy",
    provider_id: "081950",
    lab_id: 6,
    price: "12.50",
    a_la_carte_enabled: true,
    aoe: {
      questions: [
        {
          id: 7,
          required: true,
          code: "FASTING",
          value: "Fasting?",
          type: "choice",
          sequence: 1,
          answers: [{ id: 1, code: "Y", value: "Yes" }],
          constraint: null,
          default: null,
        },
      ],
    },
    expected_results: [
      {
        id: 91,
        name: "Vitamin D",
        slug: "vitamin-d",
        lab_id: 6,
        provider_id: "081950",
        required: true,
        loinc: null,
      },
    ],
  },
  {
    id: 9002,
    name: "Reverse T3",
    lab_id: 6,
    provider_id: "070127",
    price: 31,
    a_la_carte_enabled: true,
  },
  { id: 9003, name: "Panel Only", lab_id: 6, price: "N/A", a_la_carte_enabled: false },
  {
    id: 9004,
    name: "Contract Priced",
    lab_id: 6,
    a_la_carte_enabled: true,
    pricing: { unspecified: "refer_to_contract" },
  },
]

test("#470: GET /v3/lab_tests/markers lists markers, filters a_la_carte_enabled and pages", async () => {
  const mock = createRuntime({ markerCatalog: catalog })
  const all = await call(mock, "GET", "/v3/lab_tests/markers?size=100")
  expect(all.status).toBe(200)
  const ids = all.body.markers.map((marker: Json) => marker.id)
  expect(ids).toEqual(expect.arrayContaining([1975, 2075, 9001, 9002, 9003, 9004]))
  expect(all.body).toMatchObject({ page: 1, size: 100, pages: 1 })
  expect(all.body.pricing).toBeUndefined()

  const onlyCarte = await call(
    mock,
    "GET",
    "/v3/lab_tests/markers?a_la_carte_enabled=true&size=100",
  )
  expect(onlyCarte.body.markers.map((m: Json) => m.id)).not.toContain(9003)
  const notCarte = await call(mock, "GET", "/v3/lab_tests/markers?a_la_carte_enabled=false")
  expect(notCarte.body.markers.map((m: Json) => m.id)).toEqual([9003])

  const vitamin = (await call(mock, "GET", "/v3/lab_tests/markers?name=vitamin")).body.markers
  expect(vitamin).toHaveLength(1)
  expect(vitamin[0]).toMatchObject({
    id: 9001,
    slug: "vitamin-d-25-hydroxy",
    price: "12.50",
    provider_id: "081950",
    a_la_carte_enabled: true,
  })
  expect(vitamin[0].aoe.questions[0].code).toBe("FASTING")
  expect(vitamin[0].expected_results[0].slug).toBe("vitamin-d")
  // The provider test code finds it too.
  expect((await call(mock, "GET", "/v3/lab_tests/markers?name=070127")).body.markers[0].id).toBe(
    9002,
  )

  const first = await call(mock, "GET", "/v3/lab_tests/markers?size=2")
  const second = await call(mock, "GET", "/v3/lab_tests/markers?size=2&page=2")
  expect(first.body.markers).toHaveLength(2)
  expect(second.body.markers[0].id).not.toBe(first.body.markers[0].id)
  expect(first.body.pages).toBe(Math.ceil(all.body.markers.length / 2))
  expect((await call(mock, "GET", "/v3/lab_tests/markers?size=101")).status).toBe(422)
  expect((await call(mock, "GET", "/v3/lab_tests/markers?a_la_carte_enabled=maybe")).status).toBe(
    422,
  )
  expect((await call(mock, "GET", "/v3/lab_tests/markers?lab_id=x")).status).toBe(422)
  expect((await call(mock, "GET", "/v3/lab_tests/markers?lab_account_id=nope")).status).toBe(422)
})

test("#470: lab_id and lab_slug narrow the markers; lab_slug wins", async () => {
  const mock = createRuntime({
    markerCatalog: [...catalog, { id: 9100, name: "Other Lab", lab_id: 3 }],
  })
  const labcorp = await call(mock, "GET", "/v3/lab_tests/markers?lab_id=6&size=100")
  expect(labcorp.body.markers.every((m: Json) => m.lab_id === 6)).toBe(true)
  expect(labcorp.body.markers.map((m: Json) => m.id)).not.toContain(9100)
  const ussl = await call(mock, "GET", "/v3/lab_tests/markers?lab_slug=ussl&lab_id=6")
  expect(ussl.body.markers.map((m: Json) => m.id)).toEqual([9100])
  expect(
    (await call(mock, "GET", "/v3/lab_tests/markers?lab_slug=nonexistent")).body.markers,
  ).toEqual([])
})

test("#470: include_pricing adds pricing keyed by marker id for the page", async () => {
  const mock = createRuntime({ markerCatalog: catalog })
  const res = await call(mock, "GET", "/v3/lab_tests/markers?include_pricing=true&size=100")
  expect(res.body.pricing.currency).toBe("USD")
  expect(res.body.pricing.data["9001"]).toEqual({ base_amount_minor: 1250 })
  expect(res.body.pricing.data["9002"]).toEqual({ base_amount_minor: 3100 })
  expect(res.body.pricing.data["9003"]).toEqual({ unspecified: "price_unavailable" })
  expect(res.body.pricing.data["9004"]).toEqual({ unspecified: "refer_to_contract" })
  // Only the page's markers are priced.
  const page = await call(mock, "GET", "/v3/lab_tests/markers?include_pricing=true&size=1")
  expect(Object.keys(page.body.pricing.data)).toEqual([String(page.body.markers[0].id)])
})

test("#470: inactive lab tests and non-orderable markers are not offered", async () => {
  const mock = createRuntime({
    markerCatalog: [{ id: 9200, name: "Hidden", lab_id: 6, is_orderable: false }],
  })
  const res = await call(mock, "GET", "/v3/lab_tests/markers?size=100")
  expect(res.body.markers.map((m: Json) => m.id)).not.toContain(9200)
})

test("#470: estimate_order_set_pricing prices lab tests and add-on markers", async () => {
  const mock = createRuntime({ markerCatalog: catalog })
  const path = "/v3/lab_test/estimate_order_set_pricing"
  const res = await call(mock, "POST", path, {
    order_sets: [
      { lab_test_ids: [FEMALE_WELLNESS] },
      { add_on: { marker_ids: [9001], provider_ids: ["070127"] } },
      { lab_test_ids: [FEMALE_WELLNESS], add_on: { marker_ids: [9003] } },
    ],
    modality: "testkit",
    us_state: "NJ",
  })
  expect(res.status).toBe(200)
  expect(res.body.currency).toBe("USD")
  expect(res.body.data).toHaveLength(3)
  expect(res.body.data[0]).toEqual({
    aggregate_pricing: { base_amount_minor: 4500 },
    components: [
      { id: "lab_charge", pricing: { base_amount_minor: 4500 }, marker_breakdown: null },
    ],
  })
  expect(res.body.data[1].aggregate_pricing).toEqual({ base_amount_minor: 4350 })
  expect(res.body.data[1].components[0].marker_breakdown).toEqual({
    "9001": { base_amount_minor: 1250 },
    "9002": { base_amount_minor: 3100 },
  })
  // One unpriced marker makes the whole estimate unavailable, and says which one.
  expect(res.body.data[2].aggregate_pricing).toEqual({ unspecified: "price_unavailable" })
  expect(res.body.data[2].components[0].marker_breakdown["9003"]).toEqual({
    unspecified: "price_unavailable",
  })
})

test("#470: estimate_order_set_pricing validates its body", async () => {
  const mock = createRuntime({ markerCatalog: catalog })
  const path = "/v3/lab_test/estimate_order_set_pricing"
  const bad = async (body: unknown) => (await call(mock, "POST", path, body)).status
  expect(await bad({})).toBe(422)
  expect(await bad({ order_sets: [], modality: "testkit", us_state: "NJ" })).toBe(422)
  expect(await bad({ order_sets: [{ lab_test_ids: [LIPID] }], us_state: "NJ" })).toBe(422)
  expect(
    await bad({
      order_sets: [{ lab_test_ids: [LIPID] }],
      modality: "carrier_pigeon",
      us_state: "NJ",
    }),
  ).toBe(422)
  expect(await bad({ order_sets: [{ lab_test_ids: [LIPID] }], modality: "testkit" })).toBe(422)
  expect(
    await bad({
      order_sets: [{ lab_test_ids: [LIPID] }],
      modality: "testkit",
      us_state: "NJ",
      billing: "barter",
    }),
  ).toBe(422)
  // Well-formed, but names nothing that exists.
  expect(await bad({ order_sets: [{}], modality: "testkit", us_state: "NJ" })).toBe(400)
  expect(
    await bad({
      order_sets: [{ lab_test_ids: ["00000000-0000-4000-8000-000000000000"] }],
      modality: "testkit",
      us_state: "NJ",
    }),
  ).toBe(400)
  expect(
    await bad({
      order_sets: [{ add_on: { marker_ids: [424242] } }],
      modality: "testkit",
      us_state: "NJ",
      billing: "client_bill",
    }),
  ).toBe(400)
})

const ACCOUNT = "11111111-1111-4111-8111-111111111111"
const USER = "66666666-6666-4666-8666-666666666666"

const placeAddOnOrder = async (mock: ReturnType<typeof createRuntime>) => {
  const placed = await call(mock, "POST", "/v3/order", {
    user_id: USER,
    lab_account_id: ACCOUNT,
    order_set: { add_on: { provider_ids: ["303756"] } },
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
  })
  expect(placed.status).toBe(200)
  const id = placed.body.order.id as string
  const moved = await call(mock, "POST", `/__admin/orders/${id}/transition`, { to: "completed" })
  expect(moved.status).toBe(200)
  return (await call(mock, "GET", `/v3/order/${id}/result`)).body
}

test("#470: add-on result lines name their source markers only when asked to", async () => {
  const options = {
    corpus: defaultCorpus,
    geo: "synthetic",
    identity: "adopt-users",
    labAccounts: [
      {
        id: ACCOUNT,
        lab: "labcorp",
        provider_account_id: "MOCK-1",
        org_id: "55555555-5555-4555-8555-555555555555",
        states: ["AZ"],
      },
    ],
    labAccountBehavior: { profile: "expected-contract", accounts: {} },
  } satisfies JunctionRuntimeOptions
  const plain = await placeAddOnOrder(createRuntime(options))
  expect(plain.results.length).toBeGreaterThan(0)
  expect(plain.results[0].source_markers).toBeUndefined()

  const named = await placeAddOnOrder(createRuntime({ ...options, addOnSourceMarkers: true }))
  const line = named.results.find((entry: Json) => entry.provider_id === "303756")
  expect(line.source_markers).toEqual([
    { marker_id: 1975, name: "Lipid Panel", slug: "lipid-panel", provider_id: "303756" },
  ])
})

const OVERLAY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const OVERLAY_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

test("#471: catalog overlays clone a lab test under a new id, name, slug and lab", async () => {
  const mock = createRuntime({
    catalogOverlays: [
      {
        from: "lipid_panel_athome",
        id: OVERLAY_ID,
        name: "Lipid Panel: Quest",
        lab: "sonora_quest",
        stripAoe: true,
        autoGenerated: true,
      },
    ],
  })
  const read = await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID}`)
  expect(read.status).toBe(200)
  expect(read.body).toMatchObject({
    id: OVERLAY_ID,
    name: "Lipid Panel: Quest",
    slug: "lipid_panel_quest",
    auto_generated: true,
    method: "at_home_phlebotomy",
  })
  expect(read.body.lab.slug).toBe("sonora_quest")
  expect(read.body.markers[0].lab_id).toBe(read.body.lab.id)
  expect(read.body.markers[0].aoe).toBeNull()
  // The source is untouched, and still has its questions.
  const source = (await call(mock, "GET", `/v3/lab_tests/${LIPID}`)).body
  expect(source.markers[0].aoe.questions).toHaveLength(1)
  expect(source.lab.slug).toBe("labcorp")
  // Auto-generated tests list with generation_method=auto, not by default.
  const manual = (await call(mock, "GET", "/v3/lab_tests")).body.map((t: Json) => t.id)
  expect(manual).not.toContain(OVERLAY_ID)
  const auto = (await call(mock, "GET", "/v3/lab_tests?generation_method=auto")).body.map(
    (t: Json) => t.id,
  )
  expect(auto).toContain(OVERLAY_ID)
  // Expected results come along, so the markers endpoint and results work.
  const markers = await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID}/markers`)
  expect(markers.body.markers[0].expected_results.length).toBeGreaterThan(0)
  expect(markers.body.markers[0].expected_results[0].lab_id).toBe(read.body.lab.id)
})

test("#471: overlays reach every namespace and survive reset; later ones can clone earlier ones", async () => {
  const mock = createRuntime({
    catalogOverlays: [
      { from: LIPID, id: OVERLAY_ID, name: "First" },
      {
        from: OVERLAY_ID,
        id: OVERLAY_ID_2,
        slug: "second",
        price: 19.5,
        lab: { id: 99, slug: "acme", name: "Acme" },
      },
    ],
  })
  for (const namespace of ["default", "other"]) {
    const read = await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID_2}`, undefined, namespace)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ slug: "second", price: 19.5 })
    expect(read.body.lab.slug).toBe("acme")
  }
  const labs = await call(mock, "GET", "/v3/lab_tests/labs")
  expect(labs.body.some((lab: Json) => lab.slug === "acme")).toBe(true)
  await mock.reset("default")
  expect((await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID}`)).status).toBe(200)
  expect((await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID_2}`)).status).toBe(200)
})

test("#471: overlays also apply on top of a corpus and can be ordered", async () => {
  const mock = createRuntime({
    corpus: defaultCorpus,
    geo: "synthetic",
    catalogOverlays: [{ from: LIPID, id: OVERLAY_ID, name: "Derived", stripAoe: true }],
  })
  expect((await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID}`)).status).toBe(200)
  await mock.reset("default")
  expect((await call(mock, "GET", `/v3/lab_tests/${OVERLAY_ID}`)).status).toBe(200)
})

test("#471: a bad overlay fails at boot, naming the field", () => {
  const boot = (overlay: Record<string, unknown>) => () =>
    createRuntime({ catalogOverlays: [overlay as never] }).instance()
  expect(boot({ from: "nope", id: OVERLAY_ID })).toThrow("catalogOverlays[0].from")
  expect(boot({ from: LIPID, id: "not-a-uuid" })).toThrow("catalogOverlays[0].id")
  expect(boot({ from: LIPID, id: LIPID })).toThrow("already exists")
  expect(boot({ from: LIPID, id: OVERLAY_ID, lab: "no_such_lab" })).toThrow(
    "catalogOverlays[0].lab",
  )
  expect(boot({ from: LIPID, id: OVERLAY_ID, price: -1 })).toThrow("price")
})
