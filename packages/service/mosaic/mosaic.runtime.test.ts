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

test.each([
  ["winter", "2025-01-01T12:00:00.321Z", "2025-01-01T06:00:00", "2025-01-08T06:00:00"],
  ["summer", "2025-07-01T12:00:00.321Z", "2025-07-01T07:00:00", "2025-07-08T07:00:00"],
])(
  "lab transition accepts every status and publishes Central lifecycle dates in %s",
  async (_season, instant, stamp, estimatedCompletion) => {
    const { admin, client, order } = harness()
    expect((await admin("/clock", "POST", { now: instant, frozen: true })).status).toBe(200)
    const { orderId, lineId } = await order()
    expect((await (await client.getOrder(orderId)).json()).data.dateCreated).toBe(`${stamp}.321`)
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
      expect(line.salesOrderDateCreated).toBe(stamp)
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
          estimatedCompletion,
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
    const second = instant.replace(".321", "")
    const filters = {
      OrderIdFrom: orderId,
      OrderIdTo: orderId,
      PractitionerAccountId: patientBody.practitionerAccountId,
      TestTypeId: 263,
      SalesOrderLineStatusId: 15,
      ReceivedDateFrom: second,
      ReceivedDateTo: second,
      CompletedDateFrom: second,
      CompletedDateTo: second,
    }
    expect((await (await client.lines(filters)).json()).totalRecords).toBe(1)
    const centralFilters = {
      ...filters,
      ReceivedDateFrom: stamp,
      ReceivedDateTo: stamp,
      CompletedDateFrom: stamp,
      CompletedDateTo: stamp,
    }
    expect((await (await client.lines(centralFilters)).json()).totalRecords).toBe(1)
    for (const field of ["ReceivedDateFrom", "CompletedDateFrom"]) {
      expect(
        (await (await client.lines({ ...centralFilters, [field]: second.slice(0, 19) })).json())
          .totalRecords,
      ).toBe(0)
    }
    const day = stamp.slice(0, 10)
    const nextWeek = estimatedCompletion.slice(0, 10)
    for (const mismatch of [
      { PractitionerAccountId: 0 },
      { TestTypeId: 289 },
      { SalesOrderLineStatusId: 2 },
      { ReceivedDateFrom: nextWeek },
      { ReceivedDateTo: day },
      { CompletedDateFrom: nextWeek },
      { CompletedDateTo: day },
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
  },
)

test("transition date overrides and filters agree across daylight-saving changes", async () => {
  const { admin, client, order } = harness()
  const { orderId, lineId } = await order()
  const path = `/lines/${lineId}/transition`
  const response = await admin(path, "POST", {
    statusId: 1,
    shippedDate: "2025-03-09",
    receivedDate: "2025-03-09T02:30:00",
    estimatedCompletion: "2025-11-02T01:30:00",
    completedDate: "2025-11-02T01:30:00-06:00",
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    shippedDate: "2025-03-09T00:00:00",
    receivedDate: "2025-03-09T03:30:00",
    estimatedCompletion: "2025-11-02T01:30:00",
    completedDate: "2025-11-02T01:30:00",
  })
  expect((await (await client.getOrder(orderId)).json()).data.sampleReceivedDate).toBe(
    "2025-03-09T03:30:00",
  )
  const count = async (received: string, completed: string) =>
    (
      await (
        await client.lines({
          ReceivedDateFrom: received,
          ReceivedDateTo: received,
          CompletedDateFrom: completed,
          CompletedDateTo: completed,
        })
      ).json()
    ).totalRecords
  expect(await count("2025-03-09T08:30:00Z", "2025-11-02T07:30:00Z")).toBe(1)
  expect(await count("2025-03-09T02:30:00", "2025-11-02T01:30:00-06:00")).toBe(1)
  expect(await count("2025-03-09T02:30:00", "2025-11-02T01:30:00")).toBe(0)

  expect(
    (await admin(path, "POST", { statusId: 1, completedDate: "2025-11-02T01:30:00" })).status,
  ).toBe(200)
  expect(await count("2025-03-09T03:30:00", "2025-11-02T06:30:00Z")).toBe(1)
  expect(await count("2025-03-09T03:30:00", "2025-11-02T07:30:00Z")).toBe(0)
})

test("patient birth dates and calendar filters use Central time", async () => {
  const { admin, client } = harness()
  expect(
    (await admin("/clock", "POST", { now: "2025-05-22T03:00:00Z", frozen: true })).status,
  ).toBe(200)
  const patientId = await client.id(
    await client.createPatient({ ...patientBody, birthDate: "1985-05-22" }),
  )
  const getPatient = async () => (await (await client.getPatient(patientId)).json()).data
  expect(await getPatient()).toMatchObject({ birthDate: "1985-05-22T00:00:00", age: 39 })

  const update = await client.updatePatient({
    patientAccountId: patientId,
    birthDate: "1985-05-23T02:30:00Z",
  })
  expect(update.status).toBe(200)
  expect(await update.json()).toMatchObject({ birthDate: "1985-05-22T21:30:00", age: 39 })
  for (const birthDate of ["1985-05-22", "1985-05-23T02:30:00Z"]) {
    const patients = await (await client.listPatients({ BirthDate: birthDate })).json()
    expect(
      patients.data.map((patient: { patientAccountId: number }) => patient.patientAccountId),
    ).toEqual([patientId])
  }
  expect((await (await client.listPatients({ BirthDate: "1985-05-23" })).json()).data).toEqual([])
})

test("stored UTC timestamps from older snapshots keep their original instants", async () => {
  const { runtime, client, order } = harness()
  const { orderId, lineId } = await order()
  const state = runtime.instance().state
  const oldOrder = state.orders.get(String(orderId))
  const oldLine = state.lines.get(lineId)
  if (!oldOrder || !oldLine) throw new Error("Expected the placed order and line to be stored")
  state.orders.update(String(orderId), { ...oldOrder, dateCreated: "2025-01-01T12:00:00.321" })
  state.lines.update(lineId, { ...oldLine, receivedDate: "2025-07-01T12:00:00" })

  expect((await (await client.getOrder(orderId)).json()).data).toMatchObject({
    dateCreated: "2025-01-01T06:00:00.321",
    sampleReceivedDate: "2025-07-01T07:00:00",
  })
  const page = await (
    await client.lines({
      ReceivedDateFrom: "2025-07-01T07:00:00",
      ReceivedDateTo: "2025-07-01T12:00:00Z",
    })
  ).json()
  expect(page.totalRecords).toBe(1)
  expect(page.data[0]).toMatchObject({
    salesOrderDateCreated: "2025-01-01T06:00:00",
    receivedDate: "2025-07-01T07:00:00",
  })
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
    estimatedCompletion: "2025-07-08T07:00:00",
    completedDate: "2025-07-01T07:00:00",
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
