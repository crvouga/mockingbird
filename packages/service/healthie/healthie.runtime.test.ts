import { describe, expect, test } from "bun:test"
import { createRuntime, HEALTHIE_PRESETS, SEED } from "./src/index.js"
import { HealthieConsumer, HttpException } from "./test/consumer.js"

const HOST = "http://healthie.mock"
const ORG_KEY = "gh_sbox_org_api_key"

const gql = (
  runtime: ReturnType<typeof createRuntime>,
  query: string,
  options: {
    variables?: Record<string, unknown>
    auth?: string
    headers?: Record<string, string>
    path?: string
  } = {},
) =>
  runtime.fetch(
    new Request(`${HOST}${options.path ?? "/graphql"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.auth ? { authorization: options.auth } : {}),
        ...options.headers,
      },
      body: JSON.stringify({ query, variables: options.variables ?? {} }),
    }),
  )

// biome-ignore lint/suspicious/noExplicitAny: GraphQL payloads are asserted field by field.
const json = async (response: Response) => (await response.json()) as Record<string, any>

describe("the service contract", () => {
  test("/health, the x-mockingbird header, and every documented preset listed", async () => {
    const runtime = createRuntime()
    const health = await runtime.fetch(new Request(`${HOST}/health`))
    expect(await health.json()).toMatchObject({ status: "ok", service: "healthie" })
    expect(health.headers.get("x-mockingbird")).toMatch(/^healthie@.+; ns=default$/)
    const presets = await json(await runtime.fetch(new Request(`${HOST}/__admin/faults/presets`)))
    const names = JSON.stringify(presets)
    for (const name of Object.keys(HEALTHIE_PRESETS)) expect(names).toContain(name)
  })

  test("namespaces by header, by /ns/ prefix (file URLs keep the prefix), and by API key", async () => {
    const runtime = createRuntime()
    const update = (headers: Record<string, string>, path?: string) =>
      gql(
        runtime,
        'mutation { updateClient(input: { id: "100003", metadata: "ns-marker" }) { user { id } } }',
        {
          auth: `Bearer ${ORG_KEY}`,
          headers,
          ...(path ? { path } : {}),
        },
      )
    const read = async (headers: Record<string, string>, path?: string) =>
      (
        await json(
          await gql(runtime, '{ user(id: "100003") { metadata } }', {
            auth: `Bearer ${ORG_KEY}`,
            headers,
            ...(path ? { path } : {}),
          }),
        )
      ).data.user.metadata
    await update({ "x-mockingbird-namespace": "one" })
    expect(await read({ "x-mockingbird-namespace": "one" })).toBe("ns-marker")
    expect(await read({})).not.toBe("ns-marker")
    await update({}, "/ns/two/graphql")
    expect(await read({}, "/ns/two/graphql")).toBe("ns-marker")
    expect(await read({ "x-mockingbird-namespace": "one" })).toBe("ns-marker")

    // A document uploaded under /ns/three comes back with a /ns/three download URL.
    const form = new FormData()
    form.append(
      "operations",
      JSON.stringify({
        query: "mutation($f: Upload) { createDocument(input: { file: $f }) { document { id } } }",
        variables: { f: null },
      }),
    )
    form.append("map", JSON.stringify({ "0": ["variables.f"] }))
    form.append("0", new File(["hello"], "hello.txt", { type: "text/plain" }))
    const created = await json(
      await runtime.fetch(
        new Request(`${HOST}/ns/three/graphql`, {
          method: "POST",
          headers: { authorization: `Bearer ${ORG_KEY}` },
          body: form,
        }),
      ),
    )
    const id = created.data.createDocument.document.id as string
    const doc = await json(
      await gql(runtime, `{ document(id: "${id}") { expiring_url display_name } }`, {
        auth: `Bearer ${ORG_KEY}`,
        path: "/ns/three/graphql",
      }),
    )
    expect(doc.data.document.display_name).toBe("hello.txt")
    expect(doc.data.document.expiring_url).toStartWith(`${HOST}/ns/three/files/`)
    expect(await (await runtime.fetch(new Request(doc.data.document.expiring_url))).text()).toBe(
      "hello",
    )

    // By API key: PUT /__admin/credentials maps a key to a namespace.
    await runtime.fetch(
      new Request(`${HOST}/__admin/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credentials: { [ORG_KEY]: "one" } }),
      }),
    )
    expect(await read({})).toBe("ns-marker")
  })

  test("the GraphQL multipart request spec: nested map paths, several files, a missing part", async () => {
    const runtime = createRuntime()
    const form = new FormData()
    form.append(
      "operations",
      JSON.stringify({
        query:
          'mutation($input: createDocumentInput, $other: Upload) { a: createDocument(input: $input) { document { id display_name file_content_type } messages { field } } b: updateUser(input: { id: "100003", avatar: $other }) { user { avatar_url } } }',
        variables: { input: { display_name: "scan.pdf", file: null }, other: null },
      }),
    )
    form.append("map", JSON.stringify({ "0": ["variables.input.file"], "1": ["variables.other"] }))
    form.append("0", new File(["%PDF-1.4"], "scan.pdf", { type: "application/pdf" }))
    form.append("1", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }))
    const body = await json(
      await runtime.fetch(
        new Request(`${HOST}/graphql`, {
          method: "POST",
          headers: { authorization: `Bearer ${ORG_KEY}` },
          body: form,
        }),
      ),
    )
    expect(body.errors).toBeUndefined()
    expect(body.data.a.document).toMatchObject({
      display_name: "scan.pdf",
      file_content_type: "application/pdf",
    })
    expect(body.data.b.user.avatar_url).toStartWith(`${HOST}/files/`)

    const missing = new FormData()
    missing.append(
      "operations",
      JSON.stringify({
        query: "mutation($f: Upload) { createDocument(input: { file: $f }) { document { id } } }",
        variables: { f: null },
      }),
    )
    missing.append("map", JSON.stringify({ "0": ["variables.f"] }))
    const refused = await runtime.fetch(
      new Request(`${HOST}/graphql`, {
        method: "POST",
        headers: { authorization: `Bearer ${ORG_KEY}` },
        body: missing,
      }),
    )
    expect(refused.status).toBe(400)
    // An Upload cannot be smuggled in as a JSON string.
    const smuggled = await json(
      await gql(
        runtime,
        "mutation($f: Upload) { createDocument(input: { file: $f }) { document { id } } }",
        {
          auth: `Bearer ${ORG_KEY}`,
          variables: { f: "data" },
        },
      ),
    )
    expect(smuggled.errors[0].message).toContain("Upload")
  })

  test("GraphQL semantics: fragments, aliases, __typename, operationName, syntax and non-GraphQL bodies", async () => {
    const runtime = createRuntime()
    const response = await runtime.fetch(
      new Request(`${HOST}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ORG_KEY}` },
        body: JSON.stringify({
          query:
            "query A { me: currentUser { ...U } } query B { __typename } fragment U on User { id __typename email }",
          operationName: "A",
        }),
      }),
    )
    expect(await response.json()).toEqual({
      data: { me: { id: SEED.orgAdminId, __typename: "User", email: SEED.adminEmail } },
    })
    expect((await json(await gql(runtime, "{ currentUser { id "))).errors[0].message).toContain(
      "Syntax Error",
    )
    const notGraphql = await runtime.fetch(
      new Request(`${HOST}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(notGraphql.status).toBe(400)
    expect(await notGraphql.json()).toEqual({
      errors: [{ message: "No query string was present" }],
    })
  })

  test("auth: Bearer, Basic and bare keys; anonymous sees nothing; an unknown key is 'API Key is Invalid'", async () => {
    const runtime = createRuntime()
    for (const auth of [`Bearer ${ORG_KEY}`, `Basic ${ORG_KEY}`, ORG_KEY]) {
      expect(
        (await json(await gql(runtime, "{ currentUser { id } }", { auth }))).data.currentUser.id,
      ).toBe(SEED.orgAdminId)
    }
    expect(await json(await gql(runtime, "{ currentUser { id } users { id } }"))).toEqual({
      data: { currentUser: null, users: [] },
    })
    const anonymousWrite = await json(
      await gql(runtime, 'mutation { createFolder(input: { name: "x" }) { folder { id } } }'),
    )
    expect(anonymousWrite.errors[0].message).toContain("logged in")
    expect(
      await json(await gql(runtime, "{ currentUser { id } }", { auth: "Bearer nope" })),
    ).toEqual({
      errors: [{ message: "API Key is Invalid" }],
    })
  })

  test("rate_limited (429) and server_error presets reach our consumer's status branches", async () => {
    const runtime = createRuntime()
    const consumer = new HealthieConsumer(
      `${HOST}/graphql`,
      { HEALTHIE_API_AUTH_TOKEN: ORG_KEY },
      (r) => runtime.fetch(r),
    )
    runtime.applyPreset("rate_limited", "default", { count: 1 })
    const limited = await consumer.getUserByEmail(SEED.patientEmail).catch((e: unknown) => e)
    expect(limited).toBeInstanceOf(HttpException)
    expect((limited as HttpException).status).toBe(400)
    runtime.applyPreset("server_error", "default", { count: 1 })
    const failed = await consumer.getUserByEmail(SEED.patientEmail).catch((e: unknown) => e)
    expect((failed as HttpException).status).toBe(500)
    expect((await consumer.getUserByEmail(SEED.patientEmail))[0].id).toBe(SEED.patientId)
  })

  test("webhooks: patient + form routes, x-forwarded-for, no signature; delivery faults and replay", async () => {
    const seen: { url: string; ip: string | null; headers: string[]; body: unknown }[] = []
    let status = 500
    const runtime = createRuntime({
      webhooks: {
        baseUrl: "http://backend.local/",
        ip: "52.4.158.130",
        retryDelaysMs: [0, 10],
        fetch: async (request) => {
          seen.push({
            url: request.url,
            ip: request.headers.get("x-forwarded-for"),
            headers: [...request.headers.keys()],
            body: await request.json(),
          })
          return new Response(null, { status })
        },
      },
    })
    const admin = (path: string, body: unknown) =>
      runtime.fetch(
        new Request(`${HOST}/__admin${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    await admin("/events", { event_type: "patient.updated", resource_id: 100003 })
    await runtime.webhooks.idle()
    await Bun.sleep(30)
    await runtime.webhooks.flush()
    expect(seen.map((s) => [s.url, s.ip])).toEqual([
      ["http://backend.local/users/webhook/status", "52.4.158.130"],
      ["http://backend.local/users/webhook/status", "52.4.158.130"],
    ])
    expect(seen[0]?.body).toEqual({
      resource_id: "100003",
      resource_id_type: "User",
      event_type: "patient.updated",
    })
    expect(seen[0]?.headers.some((h) => /signature/i.test(h))).toBe(false)
    status = 200
    const deliveries = (await json(await runtime.fetch(new Request(`${HOST}/__admin/webhooks`))))
      .deliveries
    expect(deliveries[0].state).toBe("failed")
    const replayed = await json(
      await runtime.fetch(
        new Request(`${HOST}/__admin/webhooks/${deliveries[0].id}/replay`, { method: "POST" }),
      ),
    )
    expect(replayed.state).toBe("delivered")

    seen.length = 0
    runtime.applyPreset("webhook_duplicate")
    await admin("/requested-forms", { recipient_id: SEED.patientId })
    await runtime.webhooks.idle()
    expect(seen.map((s) => s.url)).toEqual([
      "http://backend.local/forms/webhooks/status",
      "http://backend.local/forms/webhooks/status",
    ])
    seen.length = 0
    runtime.applyPreset("webhook_drop")
    await admin("/events", { event_type: "patient.updated", resource_id: "100003" })
    await runtime.webhooks.idle()
    expect(seen).toEqual([])
    // Billing events have no default receiver (our backend's billing route is commented out).
    await admin("/events", {
      event_type: "billing_item.updated",
      resource_id: "400001",
      resource_id_type: "BillingItem",
    })
    await runtime.webhooks.idle()
    expect(seen).toEqual([])
  })

  test("reset re-seeds, and the admin plane never exposes passwords", async () => {
    const runtime = createRuntime()
    await gql(
      runtime,
      'mutation { updateClient(input: { id: "100003", metadata: "x" }) { user { id } } }',
      {
        auth: `Bearer ${ORG_KEY}`,
      },
    )
    const users = JSON.stringify(
      await json(await runtime.fetch(new Request(`${HOST}/__admin/users`))),
    )
    expect(users).not.toContain(SEED.patientPassword)
    expect(users).not.toContain('"password"')
    await runtime.fetch(new Request(`${HOST}/__admin/reset`, { method: "POST" }))
    const after = await json(
      await gql(runtime, '{ user(id: "100003") { metadata email } }', {
        auth: `Bearer ${ORG_KEY}`,
      }),
    )
    expect(after.data.user.email).toBe(SEED.patientEmail)
    expect(after.data.user.metadata).not.toBe("x")
  })
})
