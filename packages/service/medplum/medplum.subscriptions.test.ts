import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { Subscription } from "@medplum/fhirtypes"
import { mockTarget, type Project, provisionProject, type Target } from "./test/harness/target.js"

const oracleUrl = process.env.MOCKINGBIRD_MEDPLUM_ORACLE_URL
let target: Target
let project: Project
let listener: ReturnType<typeof Bun.serve>
let onDelivery: ((body: string) => Promise<void>) | undefined
let received: { headers: Headers; body: string }[]
const deliveryAt = (index: number) => {
  const delivery = received[index]
  if (!delivery) throw new Error(`Missing delivery ${index}`)
  return delivery
}
const send = async (method: string, path: string, body?: unknown, token = project.token) => {
  const response = await target.fetch(
    new Request(new URL(path, target.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/fhir+json",
        "x-medplum": "extended",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: response.status, body: await response.json() }
}
const subscribe = async (overrides: Partial<Subscription> = {}) => {
  const result = await send("POST", "fhir/R4/Subscription", {
    resourceType: "Subscription",
    status: "active",
    reason: "Synthetic webhook regression",
    criteria: "Patient",
    channel: {
      type: "rest-hook",
      endpoint: `${listener.url}hook`,
      payload: "application/fhir+json",
    },
    ...overrides,
  })
  expect(result.status).toBe(201)
  return result.body
}
const waitFor = async (count: number) => {
  const deadline = Date.now() + (oracleUrl ? 15000 : 1000)
  while (received.length < count && Date.now() < deadline) await Bun.sleep(10)
  expect(received).toHaveLength(count)
}

beforeEach(async () => {
  received = []
  onDelivery = undefined
  listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.text()
      received.push({ headers: request.headers, body })
      await onDelivery?.(body)
      return new Response("ok")
    },
  })
  target = oracleUrl
    ? { name: "oracle", baseUrl: oracleUrl, fetch: (req) => fetch(req) }
    : mockTarget()
  project = await provisionProject(target, "Subscription regression")
})
afterEach(() => listener.stop(true))

describe("rest-hook delivery (#355)", () => {
  test("create and update send FHIR resources, custom headers and HMAC signatures", async () => {
    const subscription = await subscribe({
      extension: [
        {
          url: "https://www.medplum.com/fhir/StructureDefinition/subscription-secret",
          valueString: "synthetic-hook-signing-secret",
        },
      ],
      channel: {
        type: "rest-hook",
        endpoint: `${listener.url}hook`,
        payload: "application/fhir+json",
        header: ["X-Example: synthetic"],
      },
    })
    const created = await send("POST", "fhir/R4/Patient", { resourceType: "Patient", active: true })
    expect(created.status).toBe(201)
    await waitFor(1)
    expect(JSON.parse(deliveryAt(0).body)).toEqual(created.body)
    const updated = await send("PUT", `fhir/R4/Patient/${created.body.id}`, {
      ...created.body,
      active: false,
    })
    expect(updated.status).toBe(200)
    await waitFor(2)
    expect(JSON.parse(deliveryAt(1).body)).toEqual(updated.body)
    for (const [index, interaction] of ["create", "update"].entries()) {
      const delivery = deliveryAt(index)
      expect(delivery.headers.get("content-type")).toBe("application/fhir+json")
      expect(delivery.headers.get("x-medplum-subscription")).toBe(subscription.id)
      expect(delivery.headers.get("x-medplum-interaction")).toBe(interaction)
      expect(delivery.headers.get("x-example")).toBe("synthetic")
      expect(delivery.headers.get("x-signature")).toBe(
        createHmac("sha256", "synthetic-hook-signing-secret").update(delivery.body).digest("hex"),
      )
    }
  }, 30000)

  test("criteria, status and project restrict delivery", async () => {
    await subscribe({ criteria: "Patient?active=true" })
    await subscribe({ status: "off" })
    const other = await provisionProject(target, "Other subscription project")
    await send(
      "POST",
      "fhir/R4/Subscription",
      {
        resourceType: "Subscription",
        status: "active",
        reason: "Isolation",
        criteria: "Patient",
        channel: { type: "rest-hook", endpoint: `${listener.url}hook` },
      },
      other.token,
    )
    await send("POST", "fhir/R4/Patient", { resourceType: "Patient", active: false })
    const created = await send("POST", "fhir/R4/Patient", { resourceType: "Patient", active: true })
    await waitFor(1)
    expect(JSON.parse(deliveryAt(0).body).id).toBe(created.body.id)
    await Bun.sleep(oracleUrl ? 1500 : 30)
    expect(received).toHaveLength(1)
  }, 30000)

  test("failed transactions send no notifications; successful ones deliver after commit", async () => {
    await subscribe()
    const p = await send(
      "GET",
      `fhir/R4/Project/${project.projectId}`,
      undefined,
      project.superToken,
    )
    expect(
      (
        await send(
          "PUT",
          `fhir/R4/Project/${project.projectId}`,
          { ...p.body, features: ["transaction-bundles"] },
          project.superToken,
        )
      ).status,
    ).toBe(200)
    const result = await send("POST", "fhir/R4", {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        { request: { method: "POST", url: "Patient" }, resource: { resourceType: "Patient" } },
        {
          request: { method: "POST", url: "Observation" },
          resource: { resourceType: "Observation" },
        },
      ],
    })
    expect(result.status).toBe(400)
    const created = await send("POST", "fhir/R4", {
      resourceType: "Bundle",
      type: "transaction",
      entry: [
        {
          request: { method: "POST", url: "Patient" },
          resource: { resourceType: "Patient", active: true },
        },
      ],
    })
    expect(created.status).toBe(200)
    await waitFor(1)
    expect(JSON.parse(deliveryAt(0).body).id).toBe(created.body.entry[0].resource.id)
    await Bun.sleep(oracleUrl ? 1500 : 30)
    expect(received).toHaveLength(1)
  }, 30000)

  test("delete sends an empty object and identifies the deleted resource, even without channel.payload", async () => {
    await subscribe({ channel: { type: "rest-hook", endpoint: `${listener.url}hook` } })
    const created = await send("POST", "fhir/R4/Patient", { resourceType: "Patient" })
    await waitFor(1)
    expect(JSON.parse(deliveryAt(0).body)).toEqual(created.body)
    expect((await send("DELETE", `fhir/R4/Patient/${created.body.id}`)).status).toBe(200)
    await waitFor(2)
    expect(deliveryAt(1).body).toBe("{}")
    expect(deliveryAt(1).headers.get("x-medplum-interaction")).toBe("delete")
    expect(deliveryAt(1).headers.get("x-medplum-deleted-resource")).toBe(
      `Patient/${created.body.id}`,
    )
  }, 30000)

  test("a receiver can read the committed resource back during delivery", async () => {
    let observed: unknown
    onDelivery = async (body) => {
      const resource = JSON.parse(body)
      observed = (await send("GET", `fhir/R4/Patient/${resource.id}`)).body
    }
    await subscribe()
    const created = await send("POST", "fhir/R4/Patient", { resourceType: "Patient", active: true })
    await waitFor(1)
    const deadline = Date.now() + 1000
    while (!observed && Date.now() < deadline) await Bun.sleep(10)
    expect(observed).toEqual(created.body)
  }, 30000)

  test("a failed hook does not fail the FHIR write and other subscribers still receive it", async () => {
    await subscribe({ channel: { type: "rest-hook", endpoint: "http://127.0.0.1:1/unreachable" } })
    await subscribe()
    const created = await send("POST", "fhir/R4/Patient", { resourceType: "Patient" })
    expect(created.status).toBe(201)
    await waitFor(1)
  }, 30000)
})
