import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Vital, VitalClient, VitalError } from "@tryvital/vital-node"
import fc from "fast-check"
import { parseSealedCorpus } from "./src/index.js"

const packageDir = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(packageDir, "corpus/sandbox-sealed.json")
const corpus = parseSealedCorpus(JSON.parse(readFileSync(corpusPath, "utf8")))
const apiKey = "sk_us_mockingbird"

const queryOf = (key: string): URLSearchParams =>
  new URLSearchParams(key.slice(key.indexOf("?") + 1))

const areaKey = "GET /v3/order/area/info?radius=100&zip_code=85004"
const areaBody = corpus.observations[areaKey]?.body as
  | {
      central_labs?: Record<string, unknown>
      phlebotomy?: { providers?: Array<{ name?: string }> }
    }
  | undefined
const areaZip = queryOf(areaKey).get("zip_code") ?? "85004"
const centralLabKeys = Object.keys(areaBody?.central_labs ?? {}).sort()
const providerNames = (areaBody?.phlebotomy?.providers ?? [])
  .map((provider) => provider.name)
  .filter((name): name is string => typeof name === "string")

const pscKeys = Object.keys(corpus.observations).filter(
  (key) =>
    key.startsWith("GET /v3/order/psc/info?") &&
    key.includes("radius=100") &&
    ((corpus.observations[key]?.body as { patient_service_centers?: unknown[] } | undefined)
      ?.patient_service_centers?.length ?? 0) > 0,
)
const pscIndex = fc.integer({ min: 0, max: pscKeys.length - 1 })
const pscKey = (index: number): string => {
  const key = pscKeys[index]
  if (key === undefined) throw new Error("no sealed psc observation sampled")
  return key
}

const atHomeTest =
  corpus.catalog.labTests.find((test) => test.method === "at_home_phlebotomy") ??
  corpus.catalog.labTests[0]
if (atHomeTest === undefined) throw new Error("corpus has no lab tests")

const children: Array<{ kill: () => void }> = []
let base = ""
let client: VitalClient

beforeAll(async () => {
  const child = Bun.spawn(["bun", "scripts/server.ts"], {
    cwd: packageDir,
    env: { ...process.env, PORT: "0", MOCKINGBIRD_JUNCTION_CORPUS: corpusPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(child)
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not report a port: ${buffer}`)),
      20_000,
    )
    ;(async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const match = buffer.match(/listening on http:\/\/[^:]+:(\d+)/)
        if (match?.[1]) {
          clearTimeout(timer)
          resolve(Number(match[1]))
          return
        }
      }
      clearTimeout(timer)
      reject(new Error(`server exited before listening: ${buffer}`))
    })().catch(reject)
  })
  base = `http://127.0.0.1:${port}`
  client = new VitalClient({ apiKey, environment: base })
})

afterAll(() => {
  for (const child of children) child.kill()
})

const patientDetails = {
  firstName: "Ada",
  lastName: "Lovelace",
  dob: "1990-01-01",
  gender: "female" as Vital.Gender,
  phoneNumber: "+14155551234",
  email: "ada@example.com",
}
const patientAddress = {
  firstLine: "1 N Central Ave",
  city: "Phoenix",
  state: "AZ",
  zip: areaZip,
  country: "US",
}
const orderRequest = (userId: string): Vital.CreateOrderRequestCompatible => ({
  userId,
  patientDetails,
  patientAddress,
  orderSet: { labTestIds: [String(atHomeTest.id)] },
})

const expectVital404 = async (run: () => Promise<unknown>) => {
  try {
    await run()
    throw new Error("expected a VitalError")
  } catch (error) {
    expect(error).toBeInstanceOf(VitalError)
    expect((error as VitalError).statusCode).toBe(404)
  }
}

describe("junction SDK drop-in", () => {
  test("user.create round-trips through getByClientUserId", async () => {
    const created = await client.user.create({ clientUserId: "sdk-user-1" })
    const fetched = await client.user.getByClientUserId("sdk-user-1")
    expect(fetched.userId).toBe(created.userId)
    await expectVital404(() => client.user.getByClientUserId("sdk-user-missing"))
  })

  test("area info mirrors the sealed corpus central labs", async () => {
    const area = await client.labTests.getAreaInfo({
      zipCode: areaZip,
      radius: "100" as Vital.AllowedRadius,
    })
    expect(Object.keys(area.centralLabs).sort()).toEqual(centralLabKeys)
    if (providerNames.length > 0) {
      const names = area.phlebotomy.providers.map((provider) => provider.name)
      expect(names).toEqual(expect.arrayContaining(providerNames))
    }
  })

  test("psc info distances match the sealed corpus exactly", async () => {
    await fc.assert(
      fc.asyncProperty(pscIndex, async (index) => {
        const key = pscKey(index)
        const query = queryOf(key)
        const body = corpus.observations[key]?.body as {
          patient_service_centers?: Array<{ distance: number }>
        }
        const expected = (body.patient_service_centers ?? []).map((center) => center.distance)
        const psc = await client.labTests.getPscInfo({
          zipCode: query.get("zip_code") ?? "",
          labId: Number(query.get("lab_id") ?? 0),
          radius: "100" as Vital.AllowedRadius,
        })
        expect(psc.patientServiceCenters.map((center) => center.distance)).toEqual(expected)
      }),
      { numRuns: 15 },
    )
  })

  test("orders carry lab_account_id without a UUID constraint", async () => {
    const user = await client.user.create({ clientUserId: "sdk-user-order" })
    const withAccount = await client.labTests.createOrder({
      ...orderRequest(user.userId),
      labAccountId: "sdk-opaque-account",
    })
    expect(withAccount.order.labTest.lab?.slug).toBeTruthy()
    expect(withAccount.order.labTest.method).toBeTruthy()

    const readBack = (await (
      await fetch(`${base}/v3/order/${withAccount.order.id}`, {
        headers: { "x-vital-api-key": apiKey },
      })
    ).json()) as { lab_account_id?: string | null }
    expect(readBack.lab_account_id).toBe("sdk-opaque-account")

    const withoutAccount = await client.labTests.createOrder(orderRequest(user.userId))
    const readNull = (await (
      await fetch(`${base}/v3/order/${withoutAccount.order.id}`, {
        headers: { "x-vital-api-key": apiKey },
      })
    ).json()) as { lab_account_id?: string | null }
    expect(readNull.lab_account_id).toBeUndefined()
  })

  test("phlebotomy availability books and round-trips an appointment", async () => {
    const user = await client.user.create({ clientUserId: "sdk-user-scheduling" })
    const availability = await client.labTests.getPhlebotomyAppointmentAvailability({
      startDate: "2099-06-15",
      body: {
        firstLine: patientAddress.firstLine,
        city: patientAddress.city,
        state: patientAddress.state,
        zipCode: areaZip,
      },
    })
    const slot = availability.slots
      .flatMap((day) => day.slots)
      .find((entry) => typeof entry.bookingKey === "string")
    if (slot?.bookingKey === undefined) throw new Error("no bookable slot returned")

    const order = await client.labTests.createOrder(orderRequest(user.userId))
    await client.labTests.simulateOrderProcess(order.order.id, {
      finalStatus: "received.at_home_phlebotomy.requisition_created",
    })
    // vital-node@3.1.511 serializes the booking request flat (its .d.ts still wraps it in
    // `body`), so pass the bare AppointmentBookingRequest the runtime actually expects.
    const booked = await client.labTests.bookPhlebotomyAppointment(order.order.id, {
      bookingKey: slot.bookingKey,
    } as unknown as Vital.BookPhlebotomyAppointmentLabTestsRequest)
    expect(booked.orderId).toBe(order.order.id)
    const fetched = await client.labTests.getPhlebotomyAppointment(order.order.id)
    expect(fetched.id).toBe(booked.id)
  })

  test("getOrder rejects unknown ids with a 404 VitalError", async () => {
    await expectVital404(() => client.labTests.getOrder("00000000-0000-4000-8000-000000000000"))
  })
})
