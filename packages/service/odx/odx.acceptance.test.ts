import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { createRuntime, ELEMENTS, ODX_PRESETS, SIGNATURE_HEADER } from "./src/index.js"
import { createServer } from "./src/server.js"
import {
  BadRequestException,
  type OdxHl7Request,
  type OdxPatientData,
  OptimalDxConsumer,
  receiveWebhook,
} from "./test/consumer.js"

const params = fcParameters(process.env)
const ODX = "http://odx.mock"
const BACKEND = "http://backend.local"
const WEBHOOK_URL = `${BACKEND}/odx/webhook`
const PRACTICE = "3f0c0c43-7d2b-4b8e-9a50-9c1f0c6c0001"
const API_KEY = "odx-api-key"

/** QA's phenotypic-age baseline (`packages/qa/src/world/http/odx-client.ts` PHENO_AGE_BASELINE). */
const PHENO_AGE_BASELINE = [
  { elementId: 506, value: 4.2 },
  { elementId: 496, value: 1.1 },
  { elementId: 494, value: 95 },
  { elementId: 537, value: 2.5 },
  { elementId: 571, value: 28 },
  { elementId: 564, value: 90 },
  { elementId: 568, value: 13.5 },
  { elementId: 511, value: 75 },
  { elementId: 556, value: 6.5 },
]

type Element = {
  elementId: number
  elementName: string
  cuUnit: string
  elementReferences: { elementCode: string }[]
}

/** QA's `buildHl7Message`, verbatim in format: codes come from `GET /v1/elements/{labId}`. */
const buildHl7Message = (
  results: { elementId: number; value: number | string }[],
  lookup: Map<number, Element>,
  testDate: string,
  msgId: string,
  sex: string,
) => {
  const cr = "\r"
  const dateCompact = testDate.replace(/-/g, "")
  const msh = `MSH|^~\\&|LAB|AHA|GEVITI|GEVITI|20250101000000||ORU^R01|${msgId}|P|2.3`
  const pid = `PID|1||E2E-900001||ODX Webhook Dedup Test^QA Test User -||19800101|${sex}`
  const obr = `OBR|1|||^^^Geviti|||${dateCompact}`
  const obx = results.map((r, i) => {
    const elem = lookup.get(r.elementId)
    const code = elem?.elementReferences[0]?.elementCode ?? `EL${r.elementId}`
    const name = elem?.elementName ?? `Element${r.elementId}`
    return `OBX|${i + 1}|NM|${code}^${name}||${r.value}|${elem?.cuUnit ?? ""}||N|||F|||${dateCompact}`
  })
  return [msh, pid, obr, ...obx].join(cr) + cr
}

type Delivery = { url: string; headers: Headers; rawBody: string }

const harness = () => {
  const deliveries: Delivery[] = []
  const runtime = createRuntime({
    settings: { apiKeys: [API_KEY] },
    fetch: async (request) => {
      deliveries.push({ url: request.url, headers: request.headers, rawBody: await request.text() })
      return Response.json({ success: true }, { status: 201 })
    },
  })
  const consumer = new OptimalDxConsumer(ODX, API_KEY, PRACTICE, (r) => runtime.fetch(r), BACKEND)
  const received = async () => {
    await runtime.webhooks.idle()
    return deliveries.splice(0)
  }
  const admin = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    runtime.fetch(
      new Request(`http://odx.mock/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, consumer, received, admin }
}

const patientReq = {
  firstName: "QA Test User -",
  lastName: "ODX Webhook Dedup Test",
  dateOfBirth: "1980-01-01",
  gender: "male",
  email: "qa+odx@example.com",
  userId: "0",
  workspaceId: 0,
}

/** Create a patient, link it, and import the pheno-age baseline as HL7 (QA's registerResults). */
const importBaseline = async (consumer: OptimalDxConsumer) => {
  const patient = await consumer.createOdxPatient(patientReq)
  const elements = (await consumer.getOdxLabsBiomarkers("1")) as Element[]
  const lookup = new Map(elements.map((e) => [e.elementId, e]))
  const request: OdxHl7Request = {
    labProfileId: 1,
    labId: 1,
    testDate: "2025-01-15T00:00:00.000Z",
    unitType: "ConventionalUS",
    userId: "0",
    externalReference: "E2E",
    externalPatientTestId: "e2e-baseline-001",
    menstrualPhase: "Unknown",
    isFasting: true,
    hl7: buildHl7Message(PHENO_AGE_BASELINE, lookup, "2025-01-15", "BL-001", "M"),
  }
  const test = await consumer.postHL7File(patient.patientId, request)
  return { patient, test, request, lookup }
}

const reportRequest = (
  patientId: number,
  patientTestId: number,
  outputType: string,
): OdxPatientData => ({
  patientTestId,
  unitType: "ConventionalUS",
  practiceId: PRACTICE,
  patientId,
  outputType,
  theme: "Geviti",
  themeId: 21,
  recipientId: "15",
  cultureCode: "en-US",
  reports: outputType === "Json" ? ["1", "2", "3"] : ["4"],
  addMarginForBinding: false,
  userId: "0",
})

describe("S24 acceptance: our ODX client and webhook guard against the mock", () => {
  test("labs and elements: the lab list and the codes HL7 imports map by", async () => {
    const { consumer } = harness()
    const labs = await consumer.getOdxLabs()
    expect(labs?.map((l: { name: string }) => l.name)).toContain("Access Health Alliance (AHA)")
    const elements = (await consumer.getOdxLabsBiomarkers("1")) as Element[]
    for (const { elementId } of PHENO_AGE_BASELINE) {
      expect(elements.some((e) => e.elementId === elementId)).toBe(true)
    }
    await expect(consumer.getOdxLabsBiomarkers("999")).rejects.toThrow("Lab 999 not found.")
  })

  test("patients: create → partner link → update → search finds; search-none is null via ignore404", async () => {
    const { consumer, admin } = harness()
    const created = await consumer.createOdxPatient(patientReq)
    expect(created).toMatchObject({
      patientId: 100001,
      practiceId: PRACTICE,
      firstName: "QA Test User -",
      dateOfBirth: "1980-01-01T00:00:00",
      gender: "Male",
      email: "qa+odx@example.com",
      workspaceId: 0,
    })
    expect(await consumer.updateOdxPatientAddExternalId(created.patientId, 4242)).toEqual({
      msg: "Data Updated Successfully",
    })
    const linked = (await (await admin("/patients")).json()) as {
      patients: { partnerUserId: string }[]
    }
    expect(linked.patients[0]?.partnerUserId).toBe("4242")
    const updated = await consumer.updateOdxPatient(created.patientId, {
      ...patientReq,
      lastName: "Renamed",
    })
    expect(updated.lastName).toBe("Renamed")
    expect(
      await consumer.searchForPatient(
        "qa+odx@example.com",
        "QA Test User -",
        "Renamed",
        "1980-01-01",
      ),
    ).toHaveLength(1)
    expect(await consumer.searchForPatient("nobody@example.com", "", "", "")).toBeNull()
    expect(await consumer.getAllOdxPatients()).toHaveLength(1)
    // createOdxPatient swallows failures (returns undefined), as our migrateUsers relies on.
    expect(await consumer.createOdxPatient({ ...patientReq, email: "" })).toBeUndefined()
    await expect(consumer.updateOdxPatient(999999, patientReq)).rejects.toThrow(
      "Patient not found.",
    )
  })

  test("HL7 import → signed Created webhook → our guard verifies with the key from GET /v1/webhooks → JSON and PDF reports", async () => {
    const { consumer, received } = harness()
    expect(await consumer.manageWebhooks()).toEqual({ success: true })
    const { patient, test } = await importBaseline(consumer)
    expect(test.patientId).toBe(patient.patientId)
    expect(test.results.map((r: { elementId: number }) => r.elementId).sort()).toEqual(
      PHENO_AGE_BASELINE.map((r) => r.elementId).sort(),
    )
    expect(test.results.find((r: { elementId: number }) => r.elementId === 506)).toMatchObject({
      elementName: "Albumin",
      elementValue: 4.2,
      comparison: "",
      unit: "g/dL",
    })
    expect(test.importLogs.every((l: { status: string }) => l.status === "Imported")).toBe(true)
    expect(await consumer.getAllPatientTests(patient.patientId)).toHaveLength(1)

    const [delivery] = await received()
    expect(delivery?.url).toBe(WEBHOOK_URL)
    const outcome = await receiveWebhook(
      consumer,
      WEBHOOK_URL,
      delivery?.headers as Headers,
      delivery?.rawBody as string,
    )
    expect(outcome.status).toBe(201)
    // The payload satisfies our receiver's zod DTO (comparison is a string, never null).
    expect(outcome.issues).toEqual([])
    const body = JSON.parse(delivery?.rawBody as string)
    expect(body).toMatchObject({
      entityType: "PatientTest",
      eventType: "Created",
      data: {
        patientTestId: test.patientTestId,
        patientId: patient.patientId,
        externalPatientTestId: "e2e-baseline-001",
      },
    })
    // Independent check of the scheme: UPPERCASE hex HMAC-SHA256 under the signing key.
    const [hook] = (await consumer.getRegisteredWebhooks()) ?? []
    expect(delivery?.headers.get(SIGNATURE_HEADER)).toBe(
      createHmac("sha256", hook?.signingKey as string)
        .update(delivery?.rawBody as string)
        .digest("hex")
        .toUpperCase(),
    )

    const report = await consumer.generateFunctionalHealthReport(
      reportRequest(patient.patientId, test.patientTestId, "Json"),
    )
    expect("metadata" in report).toBe(true)
    expect(report.metadata).toEqual({
      practiceId: PRACTICE,
      patientId: patient.patientId,
      patientTestId: test.patientTestId,
      recipient: "Patient (Geviti)",
      reports: ["1", "2", "3"],
      unitType: "ConventionalUS",
    })
    expect(report.labs[0].name).toBe("Access Health Alliance (AHA)")
    expect(
      report.sections.flatMap((s: { reports: { name: string }[] }) => s.reports.map((r) => r.name)),
    ).toContain("Functional Body Systems")
    // Glucose 95 mg/dL is above the optimal 75-86 range.
    const above = report.sections[0].reports[0].content.aboveOptimal
    expect(above.map((a: { elementId: number }) => a.elementId)).toContain(494)
    const pdf = await consumer.generateFunctionalHealthReportPdf(
      reportRequest(patient.patientId, test.patientTestId, "Pdf"),
    )
    expect(pdf.mimetype).toBe("application/pdf")
    expect(new TextDecoder().decode(pdf.buffer.slice(0, 8))).toBe("%PDF-1.4")
  })

  test("re-import (PUT test) → an Updated webhook with identical ids (ODX's Created+Updated pair)", async () => {
    const { consumer, received } = harness()
    await consumer.manageWebhooks()
    const { patient, test, request } = await importBaseline(consumer)
    await received()
    const again = await consumer.updateHL7File(patient.patientId, test.patientTestId, request)
    expect(again.patientTestId).toBe(test.patientTestId)
    const [delivery] = await received()
    const body = JSON.parse(delivery?.rawBody as string)
    expect(body.eventType).toBe("Updated")
    expect(body.data.patientTestId).toBe(test.patientTestId)
    expect(
      (
        await receiveWebhook(
          consumer,
          WEBHOOK_URL,
          delivery?.headers as Headers,
          delivery?.rawBody as string,
        )
      ).status,
    ).toBe(201)
    await expect(consumer.updateHL7File(patient.patientId, 999999, request)).rejects.toThrow(
      "Patient test not found.",
    )
  })

  test("wrong_length_signature: our guard's timingSafeEqual throws → 500 (known consumer bug); bad_signature → 403", async () => {
    const { runtime, consumer, received } = harness()
    await consumer.manageWebhooks()
    runtime.applyPreset("wrong_length_signature", "default", { count: 1 })
    await importBaseline(consumer)
    const [short] = await received()
    expect(short?.headers.get(SIGNATURE_HEADER)).toHaveLength(32)
    const crashed = await receiveWebhook(
      consumer,
      WEBHOOK_URL,
      short?.headers as Headers,
      short?.rawBody as string,
    )
    expect(crashed.status).toBe(500)
    expect(String(crashed.body.error)).toContain("RangeError")

    runtime.applyPreset("bad_signature", "default", { count: 1 })
    await importBaseline(consumer)
    const [bad] = await received()
    expect(bad?.headers.get(SIGNATURE_HEADER)).toHaveLength(64)
    expect(
      (await receiveWebhook(consumer, WEBHOOK_URL, bad?.headers as Headers, bad?.rawBody as string))
        .status,
    ).toBe(403)
    // A webhook for a URL our guard did not register is rejected too.
    expect(
      (
        await receiveWebhook(
          consumer,
          `${BACKEND}/other`,
          bad?.headers as Headers,
          bad?.rawBody as string,
        )
      ).status,
    ).toBe(403)
  })

  test("manageWebhooks registers once and is idempotent; a stale URL is updated", async () => {
    const { runtime, consumer } = harness()
    await consumer.manageWebhooks()
    await consumer.manageWebhooks()
    const hooks = (await consumer.getRegisteredWebhooks()) ?? []
    expect(hooks).toHaveLength(1)
    expect(hooks[0]).toMatchObject({
      webhookUrl: WEBHOOK_URL,
      entityEvents: { PatientTest: ["Created", "Updated", "Deleted"] },
    })
    const other = new OptimalDxConsumer(
      ODX,
      API_KEY,
      PRACTICE,
      (r) => runtime.fetch(r),
      "http://new-backend.local",
    )
    await other.manageWebhooks()
    const after = (await other.getRegisteredWebhooks()) ?? []
    expect(after.map((h) => h.webhookUrl)).toEqual([
      WEBHOOK_URL,
      "http://new-backend.local/odx/webhook",
    ])
  })

  test("structured testresults import, Deleted via admin, and the client's error branches", async () => {
    const { runtime, consumer, received, admin } = harness()
    await consumer.manageWebhooks()
    const patient = await consumer.createOdxPatient({ ...patientReq, gender: "female" })
    const test = await consumer.regLabResultsInOdx(String(patient.patientId), {
      labProfileId: 2,
      labId: "1",
      testDate: "2025-06-15",
      unitType: "SI",
      userId: "0",
      menstrualPhase: "Luteal",
      isFasting: false,
      results: [
        { elementId: 494, value: 5.2, comparison: null },
        { elementId: 12345, value: 1 },
      ],
    })
    expect(test.results).toEqual([
      expect.objectContaining({
        elementId: 494,
        unit: "mmol/L",
        comparison: "",
        elementValue: 5.2,
      }),
    ])
    expect(test.importLogs.map((l: { status: string }) => l.status)).toEqual([
      "Imported",
      "NotMapped",
    ])
    await received()
    expect((await admin(`/tests/${test.patientTestId}`, undefined, "DELETE")).status).toBe(200)
    const [deleted] = await received()
    expect(JSON.parse(deleted?.rawBody as string).eventType).toBe("Deleted")
    expect(await consumer.getAllPatientTests(patient.patientId)).toEqual([])

    runtime.applyPreset("no_content", "default", { count: 1 })
    await expect(consumer.registerWebhook(WEBHOOK_URL)).rejects.toThrow("204 No Content response")
    runtime.applyPreset("empty_success", "default", { count: 1 })
    await expect(consumer.registerWebhook(WEBHOOK_URL)).rejects.toThrow(
      "Empty success response received",
    )
    runtime.applyPreset("server_error", "default", { count: 1 })
    await expect(consumer.getOdxLabs()).rejects.toThrow("An error has occurred.")
    // An HL7 body with no MSH is a validation problem; our client surfaces the raw text.
    await expect(
      consumer.postHL7File(patient.patientId, {
        labProfileId: 1,
        labId: 1,
        testDate: "2025-01-15",
        unitType: "ConventionalUS",
        userId: "0",
        externalReference: "E2E",
        externalPatientTestId: "x",
        menstrualPhase: "Unknown",
        isFasting: true,
        hl7: "not hl7",
      }),
    ).rejects.toThrow("MSH")
    // A wrong ApiKey is API Management's 401 {statusCode, message}.
    const stranger = new OptimalDxConsumer(ODX, "wrong", PRACTICE, (r) => runtime.fetch(r))
    const error = await stranger.getOdxLabs().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BadRequestException)
    expect((error as Error).message).toContain("invalid subscription key")
  })

  test("every mapped element round-trips through HL7 by its lab code (property)", async () => {
    const { consumer } = harness()
    const patient = await consumer.createOdxPatient(patientReq)
    const elements = (await consumer.getOdxLabsBiomarkers("1")) as Element[]
    const lookup = new Map(elements.map((e) => [e.elementId, e]))
    const maleIds = ELEMENTS.filter((e) => e.elementGenderType !== "Female").map((e) => e.elementId)
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...maleIds), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 999 }),
        async (ids, raw) => {
          const results = ids.map((elementId) => ({ elementId, value: raw / 10 }))
          const test = await consumer.postHL7File(patient.patientId, {
            labProfileId: 1,
            labId: 1,
            testDate: "2025-01-15T00:00:00.000Z",
            unitType: "ConventionalUS",
            userId: "0",
            externalReference: "E2E",
            externalPatientTestId: "prop",
            menstrualPhase: "Unknown",
            isFasting: true,
            hl7: buildHl7Message(results, lookup, "2025-01-15", "P-1", "M"),
          })
          expect(
            test.results.map((r: { elementId: number; elementValue: number }) => [
              r.elementId,
              r.elementValue,
            ]),
          ).toEqual(results.map((r) => [r.elementId, r.value]))
        },
      ),
      { ...params, numRuns: params.numRuns ?? 20 },
    )
  }, 60_000)

  test("namespaces by ApiKey isolate parallel suites; the journal holds no HL7 or names", async () => {
    const runtime = createRuntime()
    await runtime.fetch(
      new Request("http://odx.mock/__admin/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { "key-a": "a", "key-b": "b" } }),
      }),
    )
    const a = new OptimalDxConsumer(ODX, "key-a", PRACTICE, (r) => runtime.fetch(r))
    const b = new OptimalDxConsumer(ODX, "key-b", PRACTICE, (r) => runtime.fetch(r))
    await importBaseline(a)
    expect(await a.getAllOdxPatients()).toHaveLength(1)
    expect(await b.getAllOdxPatients()).toEqual([])
    const journal = JSON.stringify(
      await (
        await runtime.fetch(new Request("http://odx.mock/__admin/requests?namespace=a"))
      ).json(),
    )
    expect(journal).toContain("CreatePatientTest")
    expect(journal).not.toContain("ODX Webhook Dedup Test")
    expect(journal).not.toContain("OBX")
  })

  test("every documented preset is registered", () => {
    expect(Object.keys(ODX_PRESETS)).toEqual(
      expect.arrayContaining([
        "wrong_length_signature",
        "bad_signature",
        "server_error",
        "empty_success",
        "no_content",
        "not_found",
        "slow",
        "webhook_duplicate",
        "webhook_reorder",
        "webhook_drop",
      ]),
    )
  })
})

describe("served over HTTP", () => {
  test("a pre-registered webhook (--webhook-url) reaches a real sink, signed, and our guard accepts it", async () => {
    const received: Delivery[] = []
    const sink = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push({ url: request.url, headers: request.headers, rawBody: await request.text() })
        return Response.json({ success: true }, { status: 201 })
      },
    })
    const url = `http://127.0.0.1:${sink.port}/odx/webhook`
    const server = await createServer({ webhook: { url, signingKey: "served-signing-key" } })
    try {
      const consumer = new OptimalDxConsumer(server.url, "any-key", PRACTICE, (r) => fetch(r))
      const { test } = await importBaseline(consumer)
      const deadline = Date.now() + 3_000
      while (received.length < 1 && Date.now() < deadline) await Bun.sleep(25)
      const [delivery] = received
      expect(JSON.parse(delivery?.rawBody as string).data.patientTestId).toBe(test.patientTestId)
      expect(
        (
          await receiveWebhook(
            consumer,
            url,
            delivery?.headers as Headers,
            delivery?.rawBody as string,
          )
        ).status,
      ).toBe(201)
      const health = await fetch(`${server.url}/health`)
      expect(health.headers.get("x-mockingbird")).toMatch(/^odx@/)
    } finally {
      await server.close()
      sink.stop(true)
    }
  })
})
