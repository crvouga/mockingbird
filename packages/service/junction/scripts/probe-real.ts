import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadCredentials } from "@crvouga/mockingbird-openbao"

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

const credentials = await loadCredentials(
  {
    provider: "junction",
    fields: { MOCKINGBIRD_JUNCTION_API_KEY: "MOCKINGBIRD_JUNCTION_API_KEY" },
  },
  { env: Bun.env, readTokenFile },
)
const apiKey = credentials.values.MOCKINGBIRD_JUNCTION_API_KEY
const baseUrl = Bun.env.MOCKINGBIRD_JUNCTION_BASE_URL ?? "https://api.sandbox.us.junction.com"
const headers = { "x-vital-api-key": apiKey, "content-type": "application/json" }

const log = (label: string, value: unknown) => {
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(value, null, 2))
}

const createOrder = async (body: unknown) => {
  const response = await fetch(`${baseUrl}/v3/order`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

const createUser = async (clientUserId: string): Promise<string> => {
  const response = await fetch(`${baseUrl}/v2/user`, {
    method: "POST",
    headers,
    body: JSON.stringify({ client_user_id: clientUserId }),
  })
  const payload = (await response.json()) as { user_id?: string }
  if (!response.ok) throw new Error(`create failed ${response.status}: ${JSON.stringify(payload)}`)
  return payload.user_id ?? ""
}

const listResponse = await fetch(`${baseUrl}/v3/lab_test`, { headers })
const catalog = (await listResponse.json()) as { data: Array<Record<string, unknown>> }
const testId = "c533549c-1e62-4afe-9a0e-0567a9b2bcc2"

const userId = await createUser(`probeAoe2.${Date.now()}`)

const validBody = {
  user_id: userId,
  patient_details: {
    first_name: "Maria",
    last_name: "Lee",
    dob: "1990-01-01",
    gender: "female",
    phone_number: "+14155550123",
    email: "maria@example.com",
  },
  patient_address: {
    first_line: "1 Main St",
    city: "SF",
    state: "CA",
    zip: "94105",
    country: "US",
  },
  order_set: { lab_test_ids: [testId] },
  aoe_answers: [{ marker_id: 2075, question_id: 1, answer: "No" }],
}

const ok = await createOrder(validBody)
log("valid order + valid AOE", { status: ok.status, body: ok.body.slice(0, 400) })

const badAnswer = await createOrder({
  ...validBody,
  aoe_answers: [{ marker_id: 2075, question_id: 1, answer: "totally-invalid" }],
})
log("valid order + bad answer", { status: badAnswer.status, body: badAnswer.body })

const unknownMarker = await createOrder({
  ...validBody,
  aoe_answers: [{ marker_id: 999999, question_id: 1, answer: "x" }],
})
log("valid order + unknown marker", { status: unknownMarker.status, body: unknownMarker.body })

const knownMarkerUnknownQ = await createOrder({
  ...validBody,
  aoe_answers: [{ marker_id: 2075, question_id: 999999, answer: "x" }],
})
log("valid order + known marker unknown question", {
  status: knownMarkerUnknownQ.status,
  body: knownMarkerUnknownQ.body,
})

const emptyAoe = await createOrder({ ...validBody, aoe_answers: [] })
log("valid order + empty aoe", { status: emptyAoe.status, body: emptyAoe.body.slice(0, 400) })

const deletion = await fetch(`${baseUrl}/v2/user/${userId}`, { method: "DELETE", headers })
log(`DELETE ${userId} -> ${deletion.status}`, await deletion.json().catch(() => null))
