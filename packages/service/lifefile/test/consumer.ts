/** Wire behavior ported from the consumer's LifeFileApiClient; no vendor SDK exists here. */
export const headers = {
  authorization: `Basic ${btoa("test:test")}`,
  "content-type": "application/json",
  "X-Vendor-ID": "1",
  "X-Location-ID": "1",
  "X-API-Network-ID": "1",
}
export const orderBody = (id = 1, referenceId = `reference-${id}`, state = "AZ") => ({
  message: { id, sentTime: "2026-01-01T00:00:00.000Z" },
  order: {
    general: { referenceId, memo: "Synthetic test only" },
    patient: { firstName: "Synthetic", lastName: "Fixture" },
    shipping: { state },
    rxs: [{ drugName: "Synthetic fixture", directions: "Synthetic fixture" }],
  },
})
export type Transport = (request: Request) => Promise<Response>
export const call = (
  transport: Transport,
  path: string,
  method: string,
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  transport(
    new Request(`https://mock.lifefile.local${path}`, {
      method,
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
export const submit = async (transport: Transport, body = orderBody()) => {
  const response = await call(transport, "/order", "POST", body)
  const raw: unknown = await response.json().catch(() => null)
  const envelope =
    raw && typeof raw === "object" && "type" in raw && "message" in raw
      ? (raw as { type: string; message: string; data?: { orderId?: string } })
      : null
  return { httpStatus: response.status, ok: response.ok, envelope }
}
