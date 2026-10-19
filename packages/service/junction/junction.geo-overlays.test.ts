/** #472: `corpus+synthetic` geo, ZIP aliases and per-ZIP overrides. */
import { expect, test } from "bun:test"
import { defaultCorpus } from "./src/corpus.js"
import { createRuntime, UNKNOWN_ZIP_STATUS } from "./src/index.js"

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
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json }
}

const covered = [
  ...new Set(
    Object.keys(defaultCorpus.observations).flatMap((key) => {
      const zip = /\/v3\/order\/area\/info\?.*zip_code=(\d{5})/.exec(key)?.[1]
      return zip ? [zip] : []
    }),
  ),
]
const known = covered[0] as string
// A ZIP no recording mentions.
const uncovered = "07105"
const NOT_SERVED = ["10118", "11201", "12207", "07030", "07601"].filter(
  (zip) => !covered.includes(zip),
)

test("#472: corpus+synthetic replays covered ZIPs and synthesizes the rest", async () => {
  expect(covered).not.toContain(uncovered)
  const hybrid = createRuntime({ corpus: defaultCorpus, geo: "corpus+synthetic" })
  const strict = createRuntime({ corpus: defaultCorpus, geo: "corpus" })
  const recorded =
    defaultCorpus.observations[`GET /v3/order/area/info?radius=100&zip_code=${known}`]
  const replayed = await call(hybrid, "GET", `/v3/order/area/info?zip_code=${known}&radius=100`)
  expect(replayed.status).toBe(200)
  expect(replayed.body).toEqual(recorded?.body as Json)

  const refused = await call(strict, "GET", `/v3/order/area/info?zip_code=${uncovered}`)
  expect(refused.status).toBe(UNKNOWN_ZIP_STATUS)
  const synthesized = await call(hybrid, "GET", `/v3/order/area/info?zip_code=${uncovered}`)
  expect(synthesized.status).toBe(200)
  expect(synthesized.body.zip_code).toBe(uncovered)
  const psc = await call(hybrid, "GET", `/v3/order/psc/info?zip_code=${uncovered}&lab_id=4`)
  expect(psc.status).toBe(200)
  const slots = await call(hybrid, "POST", "/v3/order/phlebotomy/appointment/availability", {
    zip_code: "85004",
    first_line: "1 Example St",
    city: "Phoenix",
    state: "AZ",
  })
  expect([200, 404]).toContain(slots.status)
  expect((await call(hybrid, "GET", "/__admin/corpus")).body.geo).toBe("corpus+synthetic")
})

test("#472: a covered ZIP's unrecorded read still refuses in corpus+synthetic", async () => {
  // Drop every area/info recording of one covered ZIP but keep its PSC recordings.
  const observations = Object.fromEntries(
    Object.entries(defaultCorpus.observations).filter(
      ([key]) => !(key.includes("/v3/order/area/info?") && key.includes(`zip_code=${known}`)),
    ),
  )
  const hybrid = createRuntime({
    corpus: { ...defaultCorpus, observations },
    geo: "corpus+synthetic",
  })
  const res = await call(hybrid, "GET", `/v3/order/area/info?zip_code=${known}`)
  expect(res.status).toBe(UNKNOWN_ZIP_STATUS)
})

test("#472: the synthetic model does not report the verified unserved ZIPs as served", async () => {
  const mock = createRuntime({ geo: "synthetic" })
  for (const zip of NOT_SERVED) {
    const res = await call(mock, "GET", `/v3/order/area/info?zip_code=${zip}`)
    expect(res.body.phlebotomy.is_served).toBe(false)
    expect(res.body.phlebotomy.providers).toEqual([])
  }
})

test("#472: ZIP overrides set phlebotomy.is_served and empty the PSC list", async () => {
  const mock = createRuntime({
    geo: "synthetic",
    zipOverlays: {
      overrides: {
        "07105": { phlebotomy_served: true },
        "85004": { phlebotomy_served: false, no_pscs: true },
      },
    },
  })
  const served = await call(mock, "GET", "/v3/order/area/info?zip_code=07105")
  expect(served.body.phlebotomy.is_served).toBe(true)
  expect(served.body.phlebotomy.providers[0].name).toBe("getlabs")
  const off = await call(mock, "GET", "/v3/order/area/info?zip_code=85004")
  expect(off.body.phlebotomy).toEqual({ is_served: false, providers: [] })
  for (const lab of Object.values(off.body.central_labs as Json)) {
    expect(lab.patient_service_centers.within_radius).toBe(0)
  }
  const pscOff = await call(mock, "GET", "/v3/order/psc/info?zip_code=85004&lab_id=4")
  expect(pscOff.status).toBe(200)
  expect(pscOff.body.patient_service_centers).toEqual([])
  // A ZIP with no override is untouched.
  const plain = createRuntime({ geo: "synthetic" })
  const before = await call(plain, "GET", "/v3/order/psc/info?zip_code=90001&lab_id=4")
  const after = await call(mock, "GET", "/v3/order/psc/info?zip_code=90001&lab_id=4")
  expect(after.body).toEqual(before.body)
})

test("#472: a ZIP alias answers as its target and echoes the requested ZIP", async () => {
  const mock = createRuntime({
    corpus: defaultCorpus,
    geo: "corpus",
    zipOverlays: { aliases: { "07105": known } },
  })
  const aliased = await call(mock, "GET", "/v3/order/area/info?zip_code=07105&radius=100")
  expect(aliased.status).toBe(200)
  const target = await call(mock, "GET", `/v3/order/area/info?zip_code=${known}&radius=100`)
  expect(aliased.body).toEqual({ ...target.body, zip_code: "07105" })
  // Unaliased unknown ZIPs still refuse.
  expect((await call(mock, "GET", "/v3/order/area/info?zip_code=07601")).status).toBe(
    UNKNOWN_ZIP_STATUS,
  )
  // An override keyed by the alias wins over the target's answer.
  const both = createRuntime({
    corpus: defaultCorpus,
    geo: "corpus",
    zipOverlays: {
      aliases: { "07105": known },
      overrides: { "07105": { phlebotomy_served: true } },
    },
  })
  expect(
    (await call(both, "GET", "/v3/order/area/info?zip_code=07105&radius=100")).body.phlebotomy
      .is_served,
  ).toBe(true)
})

test("#472: overlays are set per namespace through PUT /__admin/geo and validated", async () => {
  const mock = createRuntime({ geo: "synthetic" })
  const set = await call(mock, "PUT", "/__admin/geo", {
    mode: "corpus+synthetic",
    overlays: { overrides: { "07105": { phlebotomy_served: true } } },
  })
  expect(set.status).toBe(200)
  expect(set.body.geo).toBe("corpus+synthetic")
  expect(
    (await call(mock, "GET", "/v3/order/area/info?zip_code=07105")).body.phlebotomy.is_served,
  ).toBe(true)
  // Another namespace is unaffected.
  expect(
    (await call(mock, "GET", "/v3/order/area/info?zip_code=07105", undefined, "other")).body
      .phlebotomy.is_served,
  ).toBe(false)
  for (const overlays of [
    { aliases: { "7105": "85004" } },
    { overrides: { "07105": { phlebotomy_served: "yes" } } },
    { overrides: { "07105": { served: true } } },
  ]) {
    expect((await call(mock, "PUT", "/__admin/geo", { overlays })).status).toBe(400)
  }
  expect((await call(mock, "PUT", "/__admin/geo", { mode: "everything" })).status).toBe(400)
  expect(() => createRuntime({ zipOverlays: { aliases: { x: "y" } } }).instance()).toThrow(
    "zipOverlays",
  )
})
