export const patientBody = {
  practitionerAccountId: 701,
  customerPatientId: "synthetic-patient",
  firstName: "Synthetic",
  lastName: "Patient",
  birthDate: "1985-05-22T00:00:00",
  sex: "F",
  phone: "202-555-0100",
  email: "patient@example.test",
  address: "100 Example Lane",
  address2: "",
  city: "Example City",
  postalCode: "66002",
  countryId: 105,
  stateId: 0,
  stateCode: "KS",
  instructionLanguageId: 1,
}

export const orderBody = (patientAccountId: number, portalTestTypeIds = [263]) => ({
  practitionerAccountId: patientBody.practitionerAccountId,
  patientAccountId,
  kitIds: [] as number[],
  portalTestTypeIds,
  prepaidIds: [] as number[],
  paySourceId: 1,
  paymentMethodId: 31,
  shippingMethod: 0,
  shippingNotificationToPatient: false,
  dropShip: true,
  shippingCountryId: patientBody.countryId,
  shippingAddress: patientBody.address,
  shippingAddress2: patientBody.address2,
  shippingCity: patientBody.city,
  shippingStateId: 0,
  shippingState: patientBody.stateCode,
  shippingPostalCode: patientBody.postalCode,
  includePediatricBag: false,
  pediatricBagQuantity: 0,
})

type Transport = (request: Request) => Promise<Response>
type Query = Record<string, string | number>
type Envelope<T> = { data: T; error: string | null; success: boolean }

export const consumer = (
  send: Transport = (request) => fetch(request),
  baseUrl = "http://mosaic.local",
  headers: HeadersInit = { ApiKey: "mockingbird" },
) => {
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    query?: Query,
    accept = "application/json",
  ) => {
    const url = new URL(`${baseUrl}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    const outgoing = new Headers(headers)
    outgoing.set("accept", accept)
    if (body !== undefined) outgoing.set("content-type", "application/json")
    return send(
      new Request(url, {
        method,
        headers: outgoing,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  const createPatient = (body: unknown = patientBody) =>
    request("/api/patient/create", "POST", body)
  const createOrder = (body: ReturnType<typeof orderBody>) =>
    request("/api/salesorders/PatientOrder/Create", "POST", body)
  const lines = (filters: Query = {}) =>
    request("/api/salesorderlines", "GET", undefined, {
      PageIndex: 1,
      RecordsPerPage: 100,
      ...filters,
    })
  return {
    request,
    createPatient,
    createOrder,
    getPatient: (id: number) => request(`/api/patient/${id}`),
    listPatients: (filters: Query) => request("/api/patient", "GET", undefined, filters),
    updatePatient: (body: unknown) => request("/api/patient", "PUT", body),
    getOrder: (id: number) => request(`/api/salesorders/${id}`),
    lines,
    async cancel(salesOrderId: number, portalTestTypeIds: number[], cancelReasonId: number) {
      const response = await request("/api/salesorderlines/Cancel", "POST", {
        salesOrderId,
        portalTestTypeIds,
        cancelReasonId,
      })
      return {
        response,
        lines: response.ok
          ? await lines({ OrderIdFrom: salesOrderId, OrderIdTo: salesOrderId })
          : undefined,
      }
    },
    listResults: (id: number) => request(`/api/PatientResults/${id}`),
    pdf: (fileName: string) =>
      request(
        "/api/PatientResults/GetPDF",
        "GET",
        undefined,
        { FileName: fileName },
        "application/pdf",
      ),
    report: (testTypeId: number, reqNum: string | number) =>
      request(`/api/PatientResults/ReportJson/${testTypeId}`, "GET", undefined, { ReqNum: reqNum }),
    testTypes: () => request("/api/PortalTestType"),
    async id(response: Response) {
      const body: Envelope<number> = await response.json()
      if (!response.ok || !body.success || typeof body.data !== "number") {
        throw new Error(body.error ?? `Mosaic request failed (${response.status})`)
      }
      return body.data
    },
  }
}
