import { expect, test } from "bun:test"
import { createRuntime } from "./src/index.js"
import { consumer, orderBody, patientBody } from "./test/consumer.js"

const harness = (prefix = "/__admin") => {
  const runtime = createRuntime({ adminPrefix: prefix })
  const client = consumer(runtime.fetch)
  const admin = (path: string, method = "GET", body?: unknown, namespace?: string) =>
    consumer(
      runtime.fetch,
      "http://mosaic.local",
      namespace ? { "x-mockingbird-namespace": namespace } : {},
    ).request(`${prefix}${path}`, method, body)
  const order = async () => {
    const patientId = await client.id(await client.createPatient())
    const orderId = await client.id(await client.createOrder(orderBody(patientId)))
    return { orderId, lineId: `${orderId}-1` }
  }
  return { runtime, client, admin, order }
}

test("lab transition accepts every status and publishes lifecycle fields on the injected clock", async () => {
  const { admin, client, order } = harness()
  const { orderId, lineId } = await order()
  const stamp = "2025-07-01T12:00:00"
  expect((await admin("/clock", "POST", { now: `${stamp}Z`, frozen: true })).status).toBe(200)
  const transition = (statusId: number, details = {}) =>
    admin(`/lines/${lineId}/transition`, "POST", { statusId, ...details })
  let requisitionNumber: number | undefined
  let dropShipId: number | undefined
  for (const status of [4, 7, 14, 2, 1, 10, 8, 6, 9, 11, 13, 12, 15]) {
    const response = await transition(
      status,
      status === 7 ? { trackingNumber: "SYNTHETIC-TRACK", courier: "Sample Courier" } : {},
    )
    expect(response.status).toBe(200)
    const line = await response.json()
    expect(line.statusId).toBe(status)
    const page = await (await client.lines({ OrderIdFrom: orderId, OrderIdTo: orderId })).json()
    expect(line).toEqual(page.data[0])
    if (status === 4)
      expect((await (await client.getOrder(orderId)).json()).data.dropShipId).toBeNull()
    if (status === 7) {
      expect(line).toMatchObject({
        status: "Shipped to Patient",
        trackingNumber: "SYNTHETIC-TRACK",
        courier: "Sample Courier",
        shippedDate: stamp,
      })
      dropShipId = (await (await client.getOrder(orderId)).json()).data.dropShipId
      expect(dropShipId).toEqual(expect.any(Number))
    }
    if (status === 2) {
      requisitionNumber = line.requisitionNumber
      expect(line).toMatchObject({
        receivedDate: stamp,
        estimatedCompletion: "2025-07-08T12:00:00",
      })
      expect(requisitionNumber).toBeGreaterThan(999_999_999)
      expect(orderId).toBeLessThanOrEqual(999_999_999)
    }
    if (status === 1)
      expect(line).toMatchObject({
        completedDate: stamp,
        resultFileName: `result-${lineId}.pdf`,
        fileName: `result-${lineId}.pdf`,
      })
  }
  const filters = {
    OrderIdFrom: orderId,
    OrderIdTo: orderId,
    PractitionerAccountId: patientBody.practitionerAccountId,
    TestTypeId: 263,
    SalesOrderLineStatusId: 15,
    ReceivedDateFrom: "2025-07-01T12:00:00Z",
    ReceivedDateTo: "2025-07-01T12:00:00Z",
    CompletedDateFrom: "2025-07-01T12:00:00Z",
    CompletedDateTo: "2025-07-01T12:00:00Z",
  }
  expect((await (await client.lines(filters)).json()).totalRecords).toBe(1)
  for (const mismatch of [
    { PractitionerAccountId: 0 },
    { TestTypeId: 289 },
    { SalesOrderLineStatusId: 2 },
    { ReceivedDateFrom: "2025-07-02" },
    { ReceivedDateTo: "2025-06-30" },
    { CompletedDateFrom: "2025-07-02" },
    { CompletedDateTo: "2025-06-30" },
    { OrderIdFrom: orderId + 1 },
    { OrderIdTo: orderId - 1 },
  ]) {
    expect((await (await client.lines({ ...filters, ...mismatch })).json()).totalRecords).toBe(0)
  }
  expect((await (await client.getOrder(orderId)).json()).data).toMatchObject({
    requisitionNumber,
    dropShipId,
    sampleReceivedDate: stamp,
  })
  expect((await transition(100)).status).toBe(400)
  expect((await transition(7, { shippedDate: "not a date" })).status).toBe(400)
  expect((await admin("/lines/missing/transition", "POST", { statusId: 1 })).status).toBe(404)
})

test("result controls merge PDF, report, and alternate result test type for the same file", async () => {
  const { admin, client, order } = harness()
  const { orderId, lineId } = await order()
  const alternateId = 289
  await admin("/clock", "POST", { now: "2025-07-01T12:00:00Z", frozen: true })
  const transition = await admin(`/lines/${orderId}/263/transition`, "POST", {
    statusId: 1,
    fileName: "custom.pdf",
  })
  expect(transition.status).toBe(200)
  const line = await transition.json()
  expect(line).toMatchObject({
    status: "Results Completed",
    portalTestTypeId: 263,
    estimatedCompletion: "2025-07-08T12:00:00",
    completedDate: "2025-07-01T12:00:00",
  })
  const reqNum = line.requisitionNumber
  expect((await (await client.listResults(orderId)).json()).data).toEqual([
    { portalTestTypeId: 263, fileName: "custom.pdf" },
  ])
  const defaultPdf = await (await client.pdf("custom.pdf")).text()
  const pdf = defaultPdf.replace("synthetic lab result", "synthetic PDF result")
  const reportJson = '{"synthetic": true, "measurements": []}'
  const path = `/lines/${lineId}/result`
  expect((await admin(path, "PUT", { pdfBase64: "invalid", reportJson })).status).toBe(400)
  expect((await admin(path, "PUT", { reportJson: "{bad" })).status).toBe(400)
  expect((await admin(path, "PUT", { portalTestTypeId: "289" })).status).toBe(400)
  const stored = await admin(path, "PUT", { pdfBase64: btoa(pdf), portalTestTypeId: alternateId })
  expect(stored.status).toBe(200)
  const updated = await admin(`/lines/${orderId}/263/result`, "PUT", { reportJson })
  expect(updated.status).toBe(200)
  expect(await updated.json()).toEqual({ lineId, hasReportJson: true })
  expect((await (await client.listResults(orderId)).json()).data).toEqual([
    { portalTestTypeId: alternateId, fileName: "custom.pdf" },
  ])
  expect(
    (await (await client.lines({ OrderIdFrom: orderId })).json()).data[0].portalTestTypeId,
  ).toBe(263)
  expect((await (await client.getOrder(orderId)).json()).data.portalTestTypeIds).toEqual([263])
  expect(await (await client.pdf("custom.pdf")).text()).toBe(pdf)
  expect(await (await client.report(alternateId, reqNum)).json()).toEqual({
    data: reportJson,
    error: null,
    success: true,
  })
  expect(await (await client.report(263, reqNum)).json()).toEqual({
    data: "",
    error: null,
    success: false,
  })
  expect(await (await client.report(alternateId, orderId)).json()).toEqual({
    data: "",
    error: null,
    success: false,
  })
})

test("namespaces work by header, prefix and credential, and reset restores only the selected namespace", async () => {
  const { runtime, client, admin } = harness("/_control/mosaic")
  const byHeader = consumer(runtime.fetch, "http://mosaic.local", {
    ApiKey: "mockingbird",
    "x-mockingbird-namespace": "suite-a",
  })
  const byPath = consumer(runtime.fetch, "http://mosaic.local/_control/mosaic/ns/suite-a")
  const byKey = consumer(runtime.fetch, "http://mosaic.local", { ApiKey: "suite-b-fixture" })
  expect(
    (await admin("/credentials", "PUT", { credentials: { "suite-b-fixture": "suite-b" } })).status,
  ).toBe(200)
  const id = await byHeader.id(await byHeader.createPatient())
  expect((await (await byPath.getPatient(id)).json()).data.patientAccountId).toBe(id)
  expect((await (await client.getPatient(id)).json()).data).toBeNull()
  expect((await (await byKey.getPatient(id)).json()).data).toBeNull()
  const otherId = await byKey.id(await byKey.createPatient())
  const testTypes = [
    {
      testTypeId: 999,
      testName: "Fixture Panel",
      sampleTypeName: "Urine",
      kitTypeIds: [],
      price: 5,
    },
  ]
  expect((await admin("/test-types", "PUT", { testTypes }, "suite-a")).status).toBe(200)
  expect(await (await byPath.testTypes()).json()).toEqual(testTypes)
  expect(await (await admin("/test-types", "GET", undefined, "suite-a")).json()).toEqual({
    testTypes,
  })
  const orderId = await byPath.id(await byPath.createOrder(orderBody(id, [999])))
  const response = await byPath.lines({ OrderIdFrom: orderId, OrderIdTo: orderId })
  expect((await response.json()).data[0]).toMatchObject({ testTypeName: "Fixture Panel", price: 5 })
  expect(await (await byKey.testTypes()).json()).not.toEqual(testTypes)
  expect((await admin("/reset", "POST", undefined, "suite-a")).ok).toBe(true)
  expect((await (await byPath.getPatient(id)).json()).data).toBeNull()
  expect((await (await byPath.getOrder(orderId)).json()).data).toBeNull()
  expect(await (await byPath.testTypes()).json()).toEqual(await (await client.testTypes()).json())
  expect((await (await byKey.getPatient(otherId)).json()).data.patientAccountId).toBe(otherId)
})

test("the journal records operation, outcome and ids while omitting bodies, query values and credentials", async () => {
  const { runtime, admin } = harness()
  const client = consumer(runtime.fetch, "http://mosaic.local", {
    ApiKey: "journal-test-marker",
    "x-mockingbird-namespace": "suite-a",
  })
  const id = await client.id(await client.createPatient())
  await client.listPatients({ Email: patientBody.email })
  expect(
    (await client.request("/api/salesorders/PatientOrder/Create", "POST", { patientAccountId: id }))
      .status,
  ).toBe(400)
  const journal = await (await admin("/requests", "GET", undefined, "suite-a")).json()
  expect(journal.requests).toMatchObject([
    { operationId: "CreatePatient", status: 200, ids: { patientAccountId: String(id) } },
    { operationId: "ListPatients", status: 200, path: "/api/patient" },
    {
      operationId: "CreateOrder",
      status: 400,
      request: { contentType: "application/json" },
      issues: expect.any(Array),
    },
  ])
  const serialized = JSON.stringify(journal)
  for (const marker of [
    patientBody.email,
    patientBody.customerPatientId,
    patientBody.address,
    "journal-test-marker",
  ]) {
    expect(serialized).not.toContain(marker)
  }
  expect((await (await admin("/requests")).json()).requests).toEqual([])
})

test("all four vendor fault presets apply once to the selected namespace", async () => {
  const { admin, client } = harness()
  const presets = await (await admin("/faults/presets")).text()
  for (const preset of ["rate_limited", "server_error", "timeout", "unsuccessful"]) {
    expect(presets).toContain(`"${preset}"`)
    expect((await admin("/faults", "POST", { preset })).ok).toBe(true)
    if (preset === "timeout") {
      await expect(client.testTypes()).rejects.toBeInstanceOf(TypeError)
    } else {
      const response = await client.testTypes()
      if (preset === "rate_limited") {
        expect(response.status).toBe(429)
        expect(response.headers.get("retry-after")).toBe("1")
      }
      if (preset === "server_error") {
        expect(response.status).toBe(500)
        const first = await response.json()
        expect((await admin("/faults", "POST", { preset })).ok).toBe(true)
        const repeated = await client.request("/API/PORTALTESTTYPE")
        expect(repeated.status).toBe(500)
        expect((await repeated.json()).traceId).not.toBe(first.traceId)
      }
      if (preset === "unsuccessful") {
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ data: null, success: false })
      }
    }
    expect(Array.isArray(await (await client.testTypes()).json())).toBe(true)
  }
})

test("the order and test-type address requires an unambiguous line", async () => {
  const { client, admin } = harness()
  const patientId = await client.id(await client.createPatient())
  const orderId = await client.id(await client.createOrder(orderBody(patientId, [263, 263])))
  expect((await admin(`/lines/${orderId}/263/transition`, "POST", { statusId: 1 })).status).toBe(
    409,
  )
  expect((await admin(`/lines/${orderId}/263/result`, "PUT", {})).status).toBe(409)
  expect((await admin(`/lines/${orderId}/289/result`, "PUT", {})).status).toBe(404)
  expect((await admin(`/lines/${orderId}-2/transition`, "POST", { statusId: 1 })).status).toBe(200)
})

test("generated patient, order, and requisition ids honor the runtime id base", async () => {
  const idsFor = async (base: number) => {
    const { runtime, client, admin, order } = harness()
    runtime.setIdBase(base)
    const first = await order()
    const second = await order()
    const firstLine = await (
      await admin(`/lines/${first.lineId}/transition`, "POST", { statusId: 1 })
    ).json()
    const secondLine = await (
      await admin(`/lines/${second.lineId}/transition`, "POST", { statusId: 2 })
    ).json()
    const { data } = await (await client.listPatients({ Email: patientBody.email })).json()
    expect(firstLine.requisitionNumber).not.toBe(secondLine.requisitionNumber)
    for (const line of [firstLine, secondLine]) {
      expect(line.requisitionNumber).toBeGreaterThan(999_999_999)
    }
    return [first.orderId, data[0].id, data[0].patientAccountId, firstLine.requisitionNumber]
  }
  expect(await idsFor(12)).toEqual(await idsFor(12))
  const earlier = await idsFor(12)
  expect((await idsFor(13)).every((id) => !earlier.includes(id))).toBe(true)
})
