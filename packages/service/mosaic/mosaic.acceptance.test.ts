import { expect, test } from "bun:test"
import { createRuntime, document } from "./src/index.js"
import { consumer, orderBody, patientBody } from "./test/consumer.js"

const scenario = (adminPrefix = "/__admin") => {
  const runtime = createRuntime({ adminPrefix })
  const client = consumer(runtime.fetch)
  const admin = (path: string, method = "GET", body?: unknown, namespace?: string) =>
    consumer(
      runtime.fetch,
      "http://mosaic.local",
      namespace ? { "x-mockingbird-namespace": namespace } : {},
    ).request(`${adminPrefix}${path}`, method, body)
  const place = async (types = [263]) => {
    const patientId = await client.id(await client.createPatient())
    const orderId = await client.id(await client.createOrder(orderBody(patientId, types)))
    return { patientId, orderId, lineId: `${orderId}-1` }
  }
  const line = async (orderId: number) => {
    const body = await (await client.lines({ OrderIdFrom: orderId, OrderIdTo: orderId })).json()
    expect(body.totalRecords).toBe(1)
    return body.data[0]
  }
  return { runtime, client, admin, place, line }
}

const expectProblem = async (
  response: Response,
  status: number,
  title: string,
  section: string,
) => {
  expect(response.status).toBe(status)
  expect(response.headers.get("content-type")).toBe("application/problem+json")
  const body = await response.json()
  expect(body).toMatchObject({
    type: `https://tools.ietf.org/html/rfc9110#section-${section}`,
    title,
    status,
    traceId: expect.stringMatching(/^00-[a-f0-9]{32}-[a-f0-9]{16}-00$/),
  })
  return body
}

test("#1 patient create returns the account id in an envelope", async () => {
  const response = await scenario().client.createPatient()
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toEqual({ data: expect.any(Number), error: null, success: true })
  expect(Number.isInteger(body.data)).toBe(true)
})

test("patient create rejects empty and practitioner-only JSON without an errors member", async () => {
  const { client, runtime } = scenario()
  const traceIds = new Set<string>()
  for (const body of [{}, { practitionerAccountId: patientBody.practitionerAccountId }]) {
    const problem = await expectProblem(
      await client.createPatient(body),
      400,
      "Bad Request",
      "15.5.1",
    )
    expect(Object.keys(problem).sort()).toEqual(["status", "title", "traceId", "type"])
    traceIds.add(problem.traceId)
  }
  expect(traceIds.size).toBe(2)
  expect(runtime.instance().state.patients.list()).toHaveLength(0)
})

test("#3 patient reads keep distinct ids and resolve Kansas by code", async () => {
  const { client } = scenario()
  const id = await client.id(await client.createPatient())
  const response = await client.getPatient(id)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(Number.isInteger(body.data.id)).toBe(true)
  expect(body.data.id).not.toBe(id)
  expect(body).toMatchObject({
    data: {
      patientAccountId: id,
      customerPatientId: patientBody.customerPatientId,
      stateId: 17,
      state: "KS",
      firstName: patientBody.firstName,
      lastName: patientBody.lastName,
      gender: patientBody.sex,
      email: patientBody.email,
      inactive: false,
    },
    error: null,
    success: true,
  })
})

test("#4 patient list filters by practitioner, email, and demographics", async () => {
  const { client } = scenario()
  const id = await client.id(await client.createPatient())
  await client.createPatient({ ...patientBody, practitionerAccountId: 702 })
  await client.createPatient({
    ...patientBody,
    email: "alternate@example.test",
    firstName: "Alternate",
  })
  const filters = {
    PractitionerAccountId: patientBody.practitionerAccountId,
    Email: patientBody.email,
    FirstName: patientBody.firstName,
    LastName: patientBody.lastName,
    BirthDate: patientBody.birthDate,
  }
  const response = await client.listPatients(filters)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toEqual({
    data: [(await (await client.getPatient(id)).json()).data],
    error: null,
    success: true,
  })
  for (const mismatch of [
    { FirstName: "Different" },
    { LastName: "Different" },
    { BirthDate: "1985-05-23" },
  ]) {
    expect((await (await client.listPatients({ ...filters, ...mismatch })).json()).data).toEqual([])
  }
})

test("#5 unknown patient returns the observed unsuccessful envelope", async () => {
  const response = await scenario().client.getPatient(0)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    data: null,
    error: "Object reference not set to an instance of an object.",
    success: false,
  })
})

test("#6 placed order and line expose the internal patient id and shipping fields", async () => {
  const { client, admin, line } = scenario()
  await admin("/clock", "POST", { now: "2025-07-01T12:00:00.000Z", freeze: true })
  const patientAccountId = await client.id(await client.createPatient())
  const orderResponse = await client.createOrder(orderBody(patientAccountId))
  expect(orderResponse.status).toBe(200)
  const created = await orderResponse.json()
  expect(created).toEqual({ data: expect.any(Number), error: null, success: true })
  expect(Number.isInteger(created.data)).toBe(true)
  const patientId = (await (await client.getPatient(patientAccountId)).json()).data.id
  const result = await client.getOrder(created.data)
  expect(result.status).toBe(200)
  expect(await result.json()).toMatchObject({
    data: {
      id: created.data,
      patientId,
      portalTestTypeIds: [263],
      requisitionNumber: null,
      dropShip: true,
      shippingCountryId: 105,
      shippingStateId: 17,
      shippingState: "KS",
      shippingAddress: patientBody.address,
      shippingCity: patientBody.city,
      shippingPostalCode: patientBody.postalCode,
      dateCreated: expect.any(String),
    },
    error: null,
    success: true,
  })
  expect(await line(created.data)).toMatchObject({
    orderId: created.data,
    patientId,
    portalTestTypeId: 263,
    testTypeName: "GI360 Profile",
    statusId: 4,
    status: "Order Placed",
    canCancel: true,
    canEdit: true,
    requisitionNumber: null,
    trackingNumber: null,
    courier: null,
    shippedDate: null,
    receivedDate: null,
    estimatedCompletion: null,
    completedDate: null,
    cancelReasonId: null,
    fileName: null,
    resultFileName: null,
    price: 473,
  })
})

test("#7 duplicate create requests place independent orders", async () => {
  const { client, line } = scenario()
  const patientId = await client.id(await client.createPatient())
  const body = orderBody(patientId)
  const first = await client.id(await client.createOrder(body))
  const second = await client.id(await client.createOrder(body))
  expect(first).not.toBe(second)
  expect((await line(first)).statusId).toBe(4)
  expect((await line(second)).statusId).toBe(4)
  const cancellation = await client.cancel(first, [263], 1)
  expect((await cancellation.lines?.json())?.data[0].statusId).toBe(6)
  expect((await line(second)).statusId).toBe(4)
})

test("#8 order lines use a flat page, filter by account, and paginate one line per entry", async () => {
  const { client, place } = scenario()
  const { patientId, orderId } = await place([263, 289, 263])
  await place()
  for (const [index, portalTestTypeId] of [263, 289, 263].entries()) {
    const pageIndex = index + 1
    const result = await client.lines({
      PatientAccountId: patientId,
      PageIndex: pageIndex,
      RecordsPerPage: 1,
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      totalRecords: 3,
      pageIndex,
      data: [expect.objectContaining({ orderId, portalTestTypeId })],
      error: null,
      success: true,
    })
  }
  const noMatch = await client.lines({ PatientAccountId: 0 })
  expect(noMatch.status).toBe(200)
  expect(await noMatch.json()).toEqual({
    totalRecords: 0,
    pageIndex: 1,
    data: [],
    error: null,
    success: true,
  })
})

test("#9 unknown order is a successful null", async () => {
  const result = await scenario().client.getOrder(0)
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({ data: null, error: null, success: true })
})

test("well-formed cancellations acknowledge missing and ineligible lines without changing them", async () => {
  const { client, admin, place } = scenario()
  const { orderId, lineId } = await place([263, 289, 276])
  await admin(`/lines/${lineId}/transition`, "POST", { statusId: 7 })
  const snapshot = await (await client.lines({ OrderIdFrom: orderId })).json()
  for (const attempt of [
    { order: 0, types: [263], reason: 3, expected: [] },
    { order: orderId, types: [149], reason: 3, expected: snapshot.data },
    { order: orderId, types: [263], reason: 3, expected: snapshot.data },
    { order: orderId, types: [], reason: 3, expected: snapshot.data },
  ]) {
    const { response, lines } = await client.cancel(attempt.order, attempt.types, attempt.reason)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: true, error: null, success: true })
    expect((await lines?.json())?.data).toEqual(attempt.expected)
  }
  for (const reason of [3, 999]) {
    const { response, lines } = await client.cancel(orderId, [289], reason)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: true, error: null, success: true })
    expect((await lines?.json())?.data).toEqual([
      snapshot.data[0],
      {
        ...snapshot.data[1],
        statusId: 6,
        status: "Cancelled",
        canCancel: false,
        canEdit: false,
        cancelReasonId: 3,
      },
      snapshot.data[2],
    ])
  }
})

test("cancel with no test-type array returns a validation problem for PortalTestTypeIds", async () => {
  const { client, place, line } = scenario()
  const { orderId } = await place()
  const response = await client.request("/api/salesorderlines/Cancel", "POST", {
    salesOrderId: orderId,
    cancelReasonId: 3,
  })
  const problem = await expectProblem(
    response,
    400,
    "One or more validation errors occurred.",
    "15.5.1",
  )
  expect(Object.keys(problem.errors)).toEqual(["PortalTestTypeIds"])
  expect(problem.errors.PortalTestTypeIds).toEqual([expect.any(String)])
  expect((await line(orderId)).statusId).toBe(4)
})

test("#11 download returns a PDF, moves 1 to 10, and is repeatable", async () => {
  const { client, admin, place, line } = scenario()
  const { orderId, lineId } = await place()
  expect((await admin(`/lines/${lineId}/result`, "PUT", {})).status).toBe(200)
  expect(
    (
      await admin(`/lines/${lineId}/transition`, "POST", {
        statusId: 1,
        resultFileName: "synthetic.pdf",
      })
    ).status,
  ).toBe(200)
  expect((await line(orderId)).statusId).toBe(1)
  let previous: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const pdf = await client.pdf("synthetic.pdf")
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get("content-type")).toBe("application/pdf")
    const bytes = await pdf.text()
    expect(bytes.startsWith("%PDF-")).toBe(true)
    expect(bytes).toContain("%%EOF")
    if (previous !== undefined) expect(bytes).toBe(previous)
    previous = bytes
    expect(await line(orderId)).toMatchObject({ statusId: 10, status: "Downloaded Results" })
  }
  await expectProblem(await client.pdf("missing.pdf"), 404, "Not Found", "15.5.5")
})

test("#12 results list returns one portal test type and file name per completed line", async () => {
  const { client, admin, place } = scenario()
  const { orderId } = await place([263, 289, 276])
  await admin(`/lines/${orderId}-1/transition`, "POST", {
    statusId: 1,
    resultFileName: "first.pdf",
  })
  await admin(`/lines/${orderId}-2/transition`, "POST", {
    statusId: 1,
    resultFileName: "second.pdf",
  })
  const result = await client.listResults(orderId)
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual({
    data: [
      { portalTestTypeId: 263, fileName: "first.pdf" },
      { portalTestTypeId: 289, fileName: "second.pdf" },
    ],
    error: null,
    success: true,
  })
})

test("#13 report without a structured result returns the empty unsuccessful envelope", async () => {
  const { client, admin, place } = scenario()
  const { lineId } = await place()
  await admin(`/lines/${lineId}/transition`, "POST", { statusId: 2, requisitionNumber: 62001 })
  const response = await client.report(263, 62001)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: "", error: null, success: false })
})

test("#14 test catalogue returns a bare array, ten named tests, and repeated ids", async () => {
  const response = await scenario().client.testTypes()
  expect(response.status).toBe(200)
  const data: { testTypeId: number; testName: string }[] = await response.json()
  expect([...new Map(data.map(({ testTypeId, testName }) => [testTypeId, testName]))]).toEqual([
    [263, "GI360 Profile"],
    [264, "GI360 Essentials Profile"],
    [265, "GI360 Microbiome Profile"],
    [289, "Organic Acids Test (OAT)"],
    [149, "MycoTOX Profile (Mold Exposure)"],
    [266, "TOXDetect Profile (includes glyphosate)"],
    [276, "Glyphosate Test"],
    [249, "Metals - Toxic Elements - Urine Random"],
    [273, "EnviroTOX Complete + Metals"],
    [123, "Hormones Comprehensive Plus Panel"],
  ])
  expect(data.filter((test) => test.testTypeId === 263)).toHaveLength(2)
  expect(data[0]).toMatchObject({
    sampleTypeName: expect.any(String),
    kitTypeIds: [expect.any(Number)],
    price: expect.any(Number),
  })
})

test("#15 all declared vendor operations reject a missing ApiKey in plain text", async () => {
  const { runtime } = scenario()
  const anon = consumer(runtime.fetch, "http://mosaic.local", {})
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(operations)) {
      if (method.startsWith("x-")) continue
      const result = await anon.request(path.replace(/\{[^}]+\}/g, "0"), method.toUpperCase())
      expect(result.status).toBe(401)
      expect(result.headers.get("content-type")).toStartWith("text/plain")
      expect(await result.text()).toBe("Api Key was not provided")
    }
  }
  expect(
    (await consumer(runtime.fetch, "http://mosaic.local", { ApiKey: "" }).testTypes()).status,
  ).toBe(401)
  expect(
    (
      await consumer(runtime.fetch, "http://mosaic.local", {
        ApiKey: "another-test-value",
      }).testTypes()
    ).status,
  ).toBe(200)
})

test("issue comments: order arrays are required, [] and [0] work, and ICD-10 is optional", async () => {
  const { client } = scenario()
  const id = await client.id(await client.createPatient())
  const valid = orderBody(id)
  const cases = [
    { body: { ...valid, kitIds: undefined }, keys: ["KitIds"] },
    { body: { ...valid, prepaidIds: undefined }, keys: ["PrepaidIds"] },
    {
      body: { ...valid, kitIds: undefined, prepaidIds: undefined },
      keys: ["KitIds", "PrepaidIds"],
    },
  ]
  for (const { body, keys } of cases) {
    const result = await client.request("/api/salesorders/PatientOrder/Create", "POST", body)
    const validation = await expectProblem(
      result,
      400,
      "One or more validation errors occurred.",
      "15.5.1",
    )
    expect(Object.keys(validation.errors).sort()).toEqual(keys)
  }
  for (const ids of [[], [0]]) {
    const accepted = await client.createOrder({ ...valid, kitIds: ids, prepaidIds: ids })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ data: expect.any(Number), error: null, success: true })
  }
})

test("literal paths and query parameter names are case-insensitive", async () => {
  const { client, place, runtime } = scenario("/_control/mosaic")
  const { patientId, orderId } = await place()
  await place()
  for (const [path, canonical] of [
    ["/api/portaltesttype", "/api/PortalTestType"],
    ["/API/SALESORDERSLINESTATUS", "/api/salesorderslinestatus"],
  ] as const) {
    const response = await client.request(path)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(await (await client.request(canonical)).json())
  }
  const response = await client.request("/API/SalesOrderLines", "GET", undefined, {
    pageindex: 1,
    recordsperpage: 100,
    patientaccountid: patientId,
  })
  expect(response.status).toBe(200)
  const page = await response.json()
  expect(page).toEqual(await (await client.lines({ PatientAccountId: patientId })).json())
  expect(page.totalRecords).toBe(1)
  expect(page.data[0].orderId).toBe(orderId)
  const scoped = consumer(runtime.fetch, "http://mosaic.local/_control/mosaic/ns/CaseSensitive")
  const created = await scoped.request("/API/PATIENT/CREATE", "POST", patientBody)
  const id = await scoped.id(created)
  expect((await (await scoped.getPatient(id)).json()).data.patientAccountId).toBe(id)
})

test("order lines return the flat page with no paging parameters", async () => {
  const { client, place } = scenario()
  const { orderId } = await place()
  const response = await client.request("/api/salesorderlines")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    totalRecords: 1,
    pageIndex: 1,
    data: [expect.objectContaining({ orderId })],
    error: null,
    success: true,
  })
})

test("order create with an unknown test type rejects the entire order with data zero", async () => {
  const { client, runtime } = scenario()
  const patientId = await client.id(await client.createPatient())
  const response = await client.createOrder(orderBody(patientId, [263, 999]))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    data: 0,
    error: "Object reference not set to an instance of an object.",
    success: false,
  })
  expect(runtime.instance().state.orders.list()).toHaveLength(0)
  expect(runtime.instance().state.lines.list()).toHaveLength(0)
})

test("order create with an unknown patient returns the drop-ship or standard error and data zero", async () => {
  const { client, runtime } = scenario()
  for (const [dropShip, error] of [
    [true, "Patient required with dropship order."],
    [false, "Something went wrong saving the data. StatusCode:BadRequest"],
  ] as const) {
    const response = await client.createOrder({ ...orderBody(0), dropShip })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: 0, error, success: false })
  }
  expect(runtime.instance().state.orders.list()).toHaveLength(0)
  expect(runtime.instance().state.lines.list()).toHaveLength(0)
})

test("order create accepts an empty test-type array and creates no lines", async () => {
  const { client, place } = scenario()
  const { orderId } = await place([])
  expect((await (await client.getOrder(orderId)).json()).data).toMatchObject({
    id: orderId,
    portalTestTypeIds: [],
  })
  expect(await (await client.lines({ OrderIdFrom: orderId, OrderIdTo: orderId })).json()).toEqual({
    totalRecords: 0,
    pageIndex: 1,
    data: [],
    error: null,
    success: true,
  })
})

test("results for an order with no files or an unknown order are an empty successful list", async () => {
  const { client, place } = scenario()
  const { orderId } = await place()
  for (const id of [orderId, 0]) {
    const response = await client.listResults(id)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: [], error: null, success: true })
  }
})

test("unknown countries have an empty successful state list", async () => {
  const response = await scenario().client.request("/api/Country/States?CountryId=0")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ data: [], error: null, success: true })
})

test("issue comments: PUT patient returns the updated object directly and preserves both ids", async () => {
  const { client } = scenario()
  const id = await client.id(await client.createPatient())
  const { data } = await (await client.getPatient(id)).json()
  const response = await client.updatePatient({
    ...patientBody,
    patientAccountId: id,
    city: "Updated City",
  })
  expect(response.status).toBe(200)
  const updated = await response.json()
  expect(updated).toEqual({ ...data, city: "Updated City" })
  expect((await (await client.getPatient(id)).json()).data).toEqual(updated)
})

test("partial patient updates preserve omitted demographics and allow a new state code", async () => {
  const { client } = scenario()
  const id = await client.id(await client.createPatient())
  const { data } = await (await client.getPatient(id)).json()
  const response = await client.updatePatient({ patientAccountId: id, stateCode: "NE" })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    ...data,
    stateId: expect.any(Number),
    state: "NE",
  })
})

test("reference endpoints return the full status vocabulary, cancel reasons, and local references", async () => {
  const { client } = scenario()
  const statuses = (await (await client.request("/api/salesorderslinestatus")).json()).data
  expect(statuses.map(({ id, name }: { id: number; name: string }) => [id, name])).toEqual([
    [4, "Order Placed"],
    [7, "Shipped to Patient"],
    [14, "In Transit"],
    [2, "Test Processing"],
    [1, "Results Completed"],
    [10, "Downloaded Results"],
    [8, "Archived"],
    [6, "Cancelled"],
    [9, "Issue"],
    [11, "Awaiting Patient Action"],
    [13, "Awaiting Patient Payment"],
    [12, "Awaiting Practitioner Payment"],
    [15, "Awaiting Practitioner Confirmation"],
  ])
  for (const status of statuses) expect(typeof status.description).toBe("string")
  expect((await (await client.request("/api/salesorderslinecancelreason")).json()).data).toEqual([
    { id: 1, name: "Duplicate Test Ordered" },
    { id: 2, name: "Accidentally Ordered" },
    { id: 3, name: "Patient Requested Cancellation" },
    { id: 4, name: "No longer Clinically Relevant" },
    { id: 5, name: "Cost of Testing" },
    { id: 6, name: "Technical Problems During Ordering" },
    { id: 7, name: "Other" },
  ])
  const countries = await (await client.request("/api/Country")).json()
  expect(countries).toContainEqual(expect.objectContaining({ id: 105, code: "US" }))
  const states = (await (await client.request("/api/Country/States?CountryId=105")).json()).data
  expect(states).toContainEqual(expect.objectContaining({ id: 17, countryId: 105, code: "KS" }))
  expect(states.every(({ countryId }: { countryId: number }) => countryId === 105)).toBe(true)
  expect(await (await client.request("/api/Language")).json()).toContainEqual(
    expect.objectContaining({ id: 1, name: "English" }),
  )
})

test("published out-of-scope paths return Mockingbird's 501; unknown routes return 404", async () => {
  const { client } = scenario()
  for (const [method, path] of [
    ["POST", "/api/salesorders/PatientOrder/BulkCreate"],
    ["GET", "/api/Correspondences"],
  ] as const) {
    const response = await client.request(path, method)
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ code: "mockingbird_unsupported" })
  }
  expect((await client.request("/api/unknown")).status).toBe(404)
})
