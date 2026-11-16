/**
 * `checkpointMutations: false` reaches the Medplum runtime: a write records no time-travel
 * checkpoint, and everything it wrote reads back as usual.
 */
import { expect, test } from "bun:test"
import { CHECKPOINT_HEADER } from "@crvouga/mockingbird-service"
import { createRuntime, DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "./src/index.js"

const BASE = "http://localhost:8103"

const tokenFor = async (runtime: ReturnType<typeof createRuntime>) => {
  const response = await runtime.fetch(
    new Request(`${BASE}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
      }).toString(),
    }),
  )
  return ((await response.json()) as { access_token: string }).access_token
}

for (const checkpointMutations of [true, false]) {
  test(`a write ${checkpointMutations ? "records" : "records no"} checkpoint with checkpointMutations: ${checkpointMutations}`, async () => {
    const runtime = createRuntime({ checkpointMutations })
    const headers = {
      authorization: `Bearer ${await tokenFor(runtime)}`,
      "content-type": "application/fhir+json",
    }
    const created = await runtime.fetch(
      new Request(`${BASE}/fhir/R4/Practitioner`, {
        method: "POST",
        headers,
        body: JSON.stringify({ resourceType: "Practitioner", name: [{ family: "Ada" }] }),
      }),
    )
    expect(created.status).toBe(201)
    expect(created.headers.get(CHECKPOINT_HEADER) !== null).toBe(checkpointMutations)
    const { id } = (await created.json()) as { id: string }
    const read = await runtime.fetch(new Request(`${BASE}/fhir/R4/Practitioner/${id}`, { headers }))
    expect(((await read.json()) as { name: { family: string }[] }).name[0]?.family).toBe("Ada")
  })
}
