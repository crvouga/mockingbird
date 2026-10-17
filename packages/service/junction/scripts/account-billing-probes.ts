import type { SimulationProbeCall } from "./simulation-probes.js"

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const list = (v: unknown) =>
  Array.isArray(record(v).data) ? (record(v).data as unknown[]).map(record) : []

/** Probe only owned synthetic users/orders. Persist classifications, never vendor account identifiers. */
export async function probeAccountBilling(call: SimulationProbeCall, runId: string) {
  const observations: object[] = []
  const cleanup: { resource: string; status: number | null }[] = []
  const orders: string[] = []
  let userId: string | undefined
  try {
    const accounts = list((await call("GET", "/v3/lab_test/lab_account")).body)
    const tests = list((await call("GET", "/v3/lab_test")).body)
    const candidates = accounts.filter(
      (a) => a.lab === "bioreference" && a.org_id !== null && a.status === "active",
    )
    const test = tests.find(
      (t) =>
        record(t.lab).slug === "bioreference" &&
        t.is_active !== false &&
        t.method === "at_home_phlebotomy",
    )
    if (!test || !candidates.length)
      return {
        complete: false,
        reason: "matching account inventory unavailable",
        observations,
        cleanup,
      }
    const created = await call("POST", "/v2/user", {
      client_user_id: `mockingbird-account-billing-${runId}`,
    })
    userId =
      typeof record(created.body).user_id === "string"
        ? (record(created.body).user_id as string)
        : undefined
    if (!userId)
      return { complete: false, reason: "synthetic user unavailable", observations, cleanup }
    for (const account of candidates) {
      const billing = record(account.allowed_billing)
      const delegated = account.delegated_flow === "order_delegated"
      const patientState = delegated ? "AZ" : "NY"
      if (
        !Object.values(billing).some(
          (states) => Array.isArray(states) && states.includes(patientState),
        )
      )
        continue
      for (const carrier of ["root", "nested"] as const) {
        for (const billingType of ["client_bill", "patient_bill_passthrough"] as const) {
          const reply = await call("POST", "/v3/order", {
            user_id: userId,
            patient_details: {
              first_name: "Synthetic",
              last_name: "Probe",
              dob: "1990-01-01",
              gender: "female",
              phone_number: "+15005550006",
              email: "probe@example.com",
            },
            patient_address: {
              first_line: "1 Example St",
              city: delegated ? "Phoenix" : "New York",
              state: patientState,
              zip: delegated ? "85004" : "10001",
              country: "US",
            },
            order_set: {
              lab_test_ids: [test.id],
              ...(carrier === "nested" ? { lab_account_id: account.id } : {}),
            },
            ...(carrier === "root" ? { lab_account_id: account.id } : {}),
            collection_method: "at_home_phlebotomy",
            billing_type: billingType,
          })
          const order = record(record(reply.body).order)
          let independent: Record<string, unknown> = {}
          if (typeof order.id === "string") {
            orders.push(order.id)
            independent = record((await call("GET", `/v3/order/${order.id}`)).body)
          }
          observations.push({
            delegated,
            carrier,
            patientState,
            billingType,
            status: reply.status,
            unsupportedPassthrough:
              record(reply.body).detail ===
              "Lab 13 does not support billing type patient_bill_passthrough",
            postSelected: order.lab_account_id === account.id,
            getSelected: independent.lab_account_id === account.id,
            postNull: order.lab_account_id === null,
            getNull: independent.lab_account_id === null,
            returnedBilling: typeof order.billing_type === "string" ? order.billing_type : null,
          })
        }
      }
    }
    return { complete: observations.length > 0, observations, cleanup }
  } finally {
    for (const id of orders)
      cleanup.push({
        resource: "order",
        status: await call("POST", `/v3/order/${id}/cancel`).then(
          (r) => r.status,
          () => null,
        ),
      })
    if (userId)
      cleanup.push({
        resource: "user",
        status: await call("DELETE", `/v2/user/${userId}`).then(
          (r) => r.status,
          () => null,
        ),
      })
  }
}
