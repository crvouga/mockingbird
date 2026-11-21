import { beforeAll, describe, expect, test } from "bun:test"
import {
  createPreviewStatusObject,
  type DurableObjectStateLike,
  githubOidcVerifier,
  type PreviewStatusSnapshot,
  type PreviewWebSocketLike,
  parsePreviewEvent,
  previewStatusRoutes,
} from "./src/preview-status.js"

const ISSUER = "https://token.actions.githubusercontent.com"
const ORIGIN = "https://lab-pr-12.example.workers.dev"
const REPO = "crvouga/mockingbird"
const SHA = "a".repeat(40)
const SHA2 = "b".repeat(40)
const NOW = Date.parse("2026-11-20T12:00:00Z")

// --- JWT helpers ---

const b64url = (bytes: Uint8Array | string): string => {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  let binary = ""
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey; jwk: JsonWebKey & { kid: string } }

const generate = async (kid: string): Promise<KeyPair> => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { ...pair, jwk: { ...jwk, kid, use: "sig", alg: "RS256" } }
}

const sign = async (
  key: KeyPair,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: key.jwk.kid },
): Promise<string> => {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(input),
  )
  return `${input}.${b64url(new Uint8Array(signature))}`
}

const goodClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: ORIGIN,
  repository: REPO,
  iat: NOW / 1000 - 10,
  nbf: NOW / 1000 - 10,
  exp: NOW / 1000 + 300,
  ...overrides,
})

let keyA: KeyPair
let keyB: KeyPair
beforeAll(async () => {
  keyA = await generate("key-a")
  keyB = await generate("key-b")
})

/** A verifier whose JWKS fetch serves `served()` and counts calls. */
const verifierWith = (served: () => JsonWebKey[], clock: { now: number } = { now: NOW }) => {
  const calls: string[] = []
  const verify = githubOidcVerifier({
    repository: REPO,
    now: () => clock.now,
    fetch: async (request) => {
      calls.push(request.url)
      return Response.json({ keys: served() })
    },
  })
  return { verify, calls, clock }
}

const eventRequest = (token?: string, body: unknown = {}) =>
  new Request(`${ORIGIN}/__preview/events`, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

describe("githubOidcVerifier", () => {
  test("accepts a good token and fetches the JWKS from the issuer", async () => {
    const { verify, calls } = verifierWith(() => [keyA.jwk])
    const result = await verify(eventRequest(await sign(keyA, goodClaims())))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.claims.repository).toBe(REPO)
    expect(calls).toEqual([`${ISSUER}/.well-known/jwks`])
  })

  test("accepts an audience array and caches the JWKS", async () => {
    const { verify, calls } = verifierWith(() => [keyA.jwk])
    const token = await sign(keyA, goodClaims({ aud: ["other", ORIGIN] }))
    expect((await verify(eventRequest(token))).ok).toBe(true)
    expect((await verify(eventRequest(token))).ok).toBe(true)
    expect(calls.length).toBe(1)
  })

  test("refetches the JWKS after ten minutes", async () => {
    const { verify, calls, clock } = verifierWith(() => [keyA.jwk])
    expect((await verify(eventRequest(await sign(keyA, goodClaims())))).ok).toBe(true)
    clock.now += 11 * 60 * 1000
    const token = await sign(keyA, goodClaims({ exp: clock.now / 1000 + 60 }))
    expect((await verify(eventRequest(token))).ok).toBe(true)
    expect(calls.length).toBe(2)
  })

  const rejects: [string, () => Promise<string>, string][] = [
    [
      "wrong audience",
      () => sign(keyA, goodClaims({ aud: "https://evil.example" })),
      "wrong audience",
    ],
    ["wrong issuer", () => sign(keyA, goodClaims({ iss: "https://evil.example" })), "wrong issuer"],
    [
      "wrong repository",
      () => sign(keyA, goodClaims({ repository: "evil/fork" })),
      "wrong repository",
    ],
    ["expired", () => sign(keyA, goodClaims({ exp: NOW / 1000 - 61 })), "token expired"],
    [
      "not yet valid",
      () => sign(keyA, goodClaims({ nbf: NOW / 1000 + 120 })),
      "token not yet valid",
    ],
    ["no expiry", () => sign(keyA, goodClaims({ exp: undefined })), "token has no expiry"],
    [
      "alg none",
      async () =>
        `${b64url(JSON.stringify({ alg: "none", kid: "key-a" }))}.${b64url(JSON.stringify(goodClaims()))}.`,
      "unsupported token algorithm",
    ],
    [
      "HS256",
      () => sign(keyA, goodClaims(), { alg: "HS256", kid: "key-a" }),
      "unsupported token algorithm",
    ],
    ["no kid", () => sign(keyA, goodClaims(), { alg: "RS256" }), "token has no key id"],
    [
      "bad signature",
      async () => {
        const token = await sign(keyB, goodClaims(), { alg: "RS256", kid: "key-a" })
        return token
      },
      "bad signature",
    ],
    [
      "tampered payload",
      async () => {
        const [h, , s] = (await sign(keyA, goodClaims())).split(".")
        return `${h}.${b64url(JSON.stringify(goodClaims({ repository: "evil/fork" })))}.${s}`
      },
      "bad signature",
    ],
    ["malformed", async () => "not-a-jwt", "malformed token"],
    ["malformed base64", async () => "a.b!.c", "malformed token"],
  ]
  for (const [name, token, reason] of rejects) {
    test(`rejects ${name}`, async () => {
      const { verify } = verifierWith(() => [keyA.jwk])
      expect(await verify(eventRequest(await token()))).toEqual({ ok: false, reason })
    })
  }

  test("tolerates 60 s of clock skew", async () => {
    const { verify } = verifierWith(() => [keyA.jwk])
    const token = await sign(keyA, goodClaims({ exp: NOW / 1000 - 30, nbf: NOW / 1000 + 30 }))
    expect((await verify(eventRequest(token))).ok).toBe(true)
  })

  test("rejects a missing header without fetching keys", async () => {
    const { verify, calls } = verifierWith(() => [keyA.jwk])
    expect(await verify(eventRequest())).toEqual({ ok: false, reason: "missing bearer token" })
    expect(calls.length).toBe(0)
  })

  test("refetches once on an unknown kid (key rotation), then rate-limits", async () => {
    let served = [keyA.jwk]
    const { verify, calls, clock } = verifierWith(() => served)
    expect((await verify(eventRequest(await sign(keyA, goodClaims())))).ok).toBe(true)
    served = [keyA.jwk, keyB.jwk]
    clock.now += 31_000
    expect(await verify(eventRequest(await sign(keyB, goodClaims())))).toMatchObject({ ok: true })
    expect(calls.length).toBe(2)
    // A kid nobody serves: one refetch per cooldown at most.
    const ghost = await sign(keyA, goodClaims(), { alg: "RS256", kid: "ghost" })
    clock.now += 31_000
    expect(await verify(eventRequest(ghost))).toEqual({ ok: false, reason: "unknown signing key" })
    expect(await verify(eventRequest(ghost))).toEqual({ ok: false, reason: "unknown signing key" })
    expect(calls.length).toBe(3)
  })

  test("a JWKS failure is a rejection, not a throw", async () => {
    const verify = githubOidcVerifier({
      repository: REPO,
      now: () => NOW,
      fetch: async () => new Response("down", { status: 503 }),
    })
    expect(await verify(eventRequest(await sign(keyA, goodClaims())))).toEqual({
      ok: false,
      reason: "could not load signing keys",
    })
  })

  test("custom audience and issuer", async () => {
    const issuer = "https://issuer.example"
    const verify = githubOidcVerifier({
      repository: REPO,
      issuer,
      audience: () => "mockingbird-preview",
      now: () => NOW,
      fetch: async (request) => {
        expect(request.url).toBe(`${issuer}/.well-known/jwks`)
        return Response.json({ keys: [keyA.jwk] })
      },
    })
    const token = await sign(keyA, goodClaims({ iss: issuer, aud: "mockingbird-preview" }))
    expect((await verify(eventRequest(token))).ok).toBe(true)
  })
})

describe("parsePreviewEvent", () => {
  test("parses a build event and normalizes it", () => {
    expect(
      parsePreviewEvent({
        kind: "build",
        state: "failed",
        version: SHA.toUpperCase(),
        at: "2026-11-20T12:00:00+00:00",
        runUrl: "https://github.com/crvouga/mockingbird/actions/runs/1",
        message: "build-preview failed",
        extra: "dropped",
      }),
    ).toEqual({
      kind: "build",
      state: "failed",
      version: SHA,
      at: "2026-11-20T12:00:00.000Z",
      runUrl: "https://github.com/crvouga/mockingbird/actions/runs/1",
      message: "build-preview failed",
    })
  })

  test("parses a checks event", () => {
    expect(
      parsePreviewEvent({
        kind: "checks",
        state: "passed",
        version: SHA,
        at: "2026-11-20T12:00:00Z",
        summary: "14 of 14 passed",
      }),
    ).toEqual({
      kind: "checks",
      state: "passed",
      version: SHA,
      at: "2026-11-20T12:00:00.000Z",
      summary: "14 of 14 passed",
    })
  })

  const bad: [string, unknown, RegExp][] = [
    ["not an object", [], /JSON object/],
    ["null", null, /JSON object/],
    [
      "unknown kind",
      { kind: "deploy", state: "deployed", version: SHA, at: "2026-11-20T12:00:00Z" },
      /kind/,
    ],
    [
      "build state",
      { kind: "build", state: "passed", version: SHA, at: "2026-11-20T12:00:00Z" },
      /state/,
    ],
    [
      "checks state",
      { kind: "checks", state: "deployed", version: SHA, at: "2026-11-20T12:00:00Z" },
      /state/,
    ],
    [
      "version",
      { kind: "build", state: "building", version: "main", at: "2026-11-20T12:00:00Z" },
      /version/,
    ],
    ["at", { kind: "build", state: "building", version: SHA, at: "yesterday" }, /at must/],
    [
      "runUrl http",
      {
        kind: "build",
        state: "building",
        version: SHA,
        at: "2026-11-20T12:00:00Z",
        runUrl: "http://x.example",
      },
      /https/,
    ],
    [
      "runUrl javascript",
      {
        kind: "build",
        state: "building",
        version: SHA,
        at: "2026-11-20T12:00:00Z",
        runUrl: "javascript:alert(1)",
      },
      /https/,
    ],
    [
      "message type",
      { kind: "build", state: "failed", version: SHA, at: "2026-11-20T12:00:00Z", message: 3 },
      /message/,
    ],
    [
      "message length",
      {
        kind: "build",
        state: "failed",
        version: SHA,
        at: "2026-11-20T12:00:00Z",
        message: "x".repeat(501),
      },
      /message/,
    ],
  ]
  for (const [name, value, message] of bad) {
    test(`rejects ${name}`, () => {
      expect(() => parsePreviewEvent(value)).toThrow(message)
    })
  }
})

// --- Durable Object fakes ---

class FakeSocket implements PreviewWebSocketLike {
  sent: string[] = []
  closed: [number | undefined, string | undefined] | undefined
  send(data: string) {
    if (this.closed) throw new Error("closed")
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closed = [code, reason]
  }
  snapshots(): PreviewStatusSnapshot[] {
    return this.sent
      .map((s) => JSON.parse(s) as { snapshot: PreviewStatusSnapshot })
      .map((m) => m.snapshot)
  }
}

const fakeState = () => {
  const store = new Map<string, unknown>()
  const accepted: FakeSocket[] = []
  const puts: unknown[] = []
  const autoResponses: unknown[] = []
  const state: DurableObjectStateLike = {
    acceptWebSocket: (ws) => {
      accepted.push(ws as FakeSocket)
    },
    getWebSockets: () => accepted.filter((ws) => !ws.closed),
    storage: {
      get: async <T>(key: string) => structuredClone(store.get(key)) as T | undefined,
      put: async <T>(key: string, value: T) => {
        puts.push(value)
        store.set(key, structuredClone(value))
      },
    },
    setWebSocketAutoResponse: (pair) => {
      autoResponses.push(pair)
    },
  }
  return { state, store, accepted, puts, autoResponses }
}

const objectWith = (verdict: { ok: true } | { ok: false; reason: string } = { ok: true }) => {
  const fake = fakeState()
  const verified: Request[] = []
  const PreviewStatus = createPreviewStatusObject({
    verify: async (request) => {
      verified.push(request)
      return verdict
    },
    pr: (env) =>
      typeof env.PR_NUMBER === "string"
        ? { number: Number(env.PR_NUMBER), url: `https://github.com/${REPO}/pull/${env.PR_NUMBER}` }
        : undefined,
    upgrade: () => {
      const server = new FakeSocket()
      return {
        server,
        response: new Response(null, { status: 200, headers: { "x-upgrade": "websocket" } }),
      }
    },
  })
  const object = new PreviewStatus(fake.state, { PR_NUMBER: "12" })
  return { object, fake, verified, PreviewStatus }
}

const build = (
  state: string,
  version: string,
  at: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "build",
  state,
  version,
  at,
  ...extra,
})

const post = (body: unknown) => eventRequest("token-value", body)
const live = () => new Request(`${ORIGIN}/__preview/live`, { headers: { upgrade: "websocket" } })
const status = () => new Request(`${ORIGIN}/__preview/status`)

describe("createPreviewStatusObject", () => {
  test("GET /status serves the empty snapshot with the PR, no-store", async () => {
    const { object } = objectWith()
    const response = await object.fetch(status())
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      updatedAt: new Date(0).toISOString(),
      pr: { number: 12, url: `https://github.com/${REPO}/pull/12` },
    })
  })

  test("POST /events merges, persists and serves build, deployed and checks", async () => {
    const { object, fake } = objectWith()
    const runUrl = "https://github.com/crvouga/mockingbird/actions/runs/7"
    expect((await object.fetch(post(build("building", SHA, "2026-11-20T12:00:00Z")))).status).toBe(
      204,
    )
    expect(
      (await object.fetch(post(build("deployed", SHA, "2026-11-20T12:01:00Z", { runUrl })))).status,
    ).toBe(204)
    expect(
      (
        await object.fetch(
          post({ kind: "checks", state: "running", version: SHA, at: "2026-11-20T12:02:00Z" }),
        )
      ).status,
    ).toBe(204)
    const snapshot = (await (await object.fetch(status())).json()) as PreviewStatusSnapshot
    expect(snapshot.build).toMatchObject({ state: "deployed", version: SHA })
    expect(snapshot.deployed).toEqual({ version: SHA, at: "2026-11-20T12:01:00.000Z", runUrl })
    expect(snapshot.checks).toMatchObject({ state: "running", version: SHA })
    expect(fake.puts.length).toBe(3)
    expect(fake.store.get("snapshot")).not.toHaveProperty("pr")
  })

  test("a new object (after hibernation/eviction) reloads the snapshot from storage", async () => {
    const { object, fake, PreviewStatus } = objectWith()
    await object.fetch(post(build("deployed", SHA, "2026-11-20T12:01:00Z")))
    const revived = new PreviewStatus(fake.state, {})
    const snapshot = (await (await revived.fetch(status())).json()) as PreviewStatusSnapshot
    expect(snapshot.deployed?.version).toBe(SHA)
    expect(snapshot.pr).toBeUndefined()
  })

  test("ignores an event older than the stored one of the same kind and version", async () => {
    const { object, fake } = objectWith()
    await object.fetch(post(build("failed", SHA, "2026-11-20T12:05:00Z")))
    expect((await object.fetch(post(build("building", SHA, "2026-11-20T12:00:00Z")))).status).toBe(
      204,
    )
    let snapshot = (await (await object.fetch(status())).json()) as PreviewStatusSnapshot
    expect(snapshot.build?.state).toBe("failed")
    expect(fake.puts.length).toBe(1)
    // A different version is not stale, even if older.
    await object.fetch(post(build("building", SHA2, "2026-11-20T11:00:00Z")))
    snapshot = (await (await object.fetch(status())).json()) as PreviewStatusSnapshot
    expect(snapshot.build?.version).toBe(SHA2)
    // Checks ordering is independent of builds.
    await object.fetch(
      post({ kind: "checks", state: "failed", version: SHA, at: "2026-11-20T12:10:00Z" }),
    )
    await object.fetch(
      post({ kind: "checks", state: "running", version: SHA, at: "2026-11-20T12:09:00Z" }),
    )
    snapshot = (await (await object.fetch(status())).json()) as PreviewStatusSnapshot
    expect(snapshot.checks?.state).toBe("failed")
  })

  test("401 on failed verification, without echoing the token", async () => {
    const { object, fake } = objectWith({ ok: false, reason: "wrong audience" })
    const response = await object.fetch(post(build("deployed", SHA, "2026-11-20T12:00:00Z")))
    expect(response.status).toBe(401)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: "wrong audience" })
    expect(text).not.toContain("token-value")
    expect(fake.puts.length).toBe(0)
  })

  test("400 on a bad body", async () => {
    const { object } = objectWith()
    expect((await object.fetch(post("{not json"))).status).toBe(400)
    const response = await object.fetch(post({ kind: "build" }))
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toMatch(/version/)
    expect((await object.fetch(post("x".repeat(17 * 1024)))).status).toBe(400)
  })

  test("405 on wrong methods, 404 elsewhere, 426 on /live without upgrade", async () => {
    const { object } = objectWith()
    expect((await object.fetch(new Request(`${ORIGIN}/__preview/events`))).status).toBe(405)
    expect(
      (await object.fetch(new Request(`${ORIGIN}/__preview/status`, { method: "POST" }))).status,
    ).toBe(405)
    expect((await object.fetch(new Request(`${ORIGIN}/__preview/other`))).status).toBe(404)
    expect((await object.fetch(new Request(`${ORIGIN}/__preview/live`))).status).toBe(426)
  })

  test("/live accepts via the hibernation API, sends the snapshot, broadcasts changes", async () => {
    const { object, fake } = objectWith()
    const response = await object.fetch(live())
    expect(response.headers.get("x-upgrade")).toBe("websocket")
    await object.fetch(live())
    expect(fake.accepted.length).toBe(2)
    const [first, second] = fake.accepted as [FakeSocket, FakeSocket]
    expect(JSON.parse(first.sent[0] ?? "")).toMatchObject({
      type: "snapshot",
      snapshot: { pr: { number: 12 } },
    })
    second.close(1000, "bye")
    await object.fetch(post(build("building", SHA, "2026-11-20T12:00:00Z")))
    expect(first.snapshots().map((s) => s.build?.state)).toEqual([undefined, "building"])
    expect(second.sent.length).toBe(1)
    // A stale event broadcasts nothing.
    await object.fetch(post(build("building", SHA, "2026-11-20T11:00:00Z")))
    expect(first.sent.length).toBe(2)
  })

  test("a socket that throws on send does not break the broadcast", async () => {
    const { object, fake } = objectWith()
    await object.fetch(live())
    await object.fetch(live())
    const [first, second] = fake.accepted as [FakeSocket, FakeSocket]
    first.send = () => {
      throw new Error("gone")
    }
    expect((await object.fetch(post(build("building", SHA, "2026-11-20T12:00:00Z")))).status).toBe(
      204,
    )
    expect(second.sent.length).toBe(2)
  })

  test("hibernation handlers: ping/pong, close, error", () => {
    const { object } = objectWith()
    const ws = new FakeSocket()
    object.webSocketMessage(ws, "ping")
    object.webSocketMessage(ws, "hello")
    expect(ws.sent).toEqual(["pong"])
    object.webSocketClose(ws, 1006, "", false)
    expect(ws.closed).toEqual([1000, ""])
    const other = new FakeSocket()
    object.webSocketClose(other, 4001, "going", true)
    expect(other.closed).toEqual([4001, "going"])
    const broken = new FakeSocket()
    object.webSocketError(broken, new Error("x"))
    expect(broken.closed).toEqual([1011, "error"])
  })

  test("registers a ping/pong auto-response when the runtime offers one", () => {
    const globals = globalThis as { WebSocketRequestResponsePair?: unknown }
    globals.WebSocketRequestResponsePair = class {
      constructor(
        readonly request: string,
        readonly response: string,
      ) {}
    }
    try {
      const { fake } = objectWith()
      expect(fake.autoResponses).toEqual([
        expect.objectContaining({ request: "ping", response: "pong" }),
      ])
    } finally {
      delete globals.WebSocketRequestResponsePair
    }
  })

  test("default upgrade uses the WebSocketPair global", async () => {
    const globals = globalThis as { WebSocketPair?: unknown }
    const server = new FakeSocket()
    const client = new FakeSocket()
    let pairs = 0
    globals.WebSocketPair = class {
      0 = client
      1 = server
      constructor() {
        pairs++
      }
    }
    try {
      const fake = fakeState()
      const PreviewStatus = createPreviewStatusObject({ verify: async () => ({ ok: true }) })
      const object = new PreviewStatus(fake.state, {})
      // The Workers runtime accepts status 101 with `webSocket`; Bun's Response refuses it.
      const outcome = await object.fetch(live()).then(
        (response) => response.status,
        (error: unknown) => (error instanceof RangeError ? "refused" : error),
      )
      expect([101, "refused"] as unknown[]).toContain(outcome)
      expect(pairs).toBe(1)
      if (outcome === 101) expect(fake.accepted).toEqual([server])
    } finally {
      delete globals.WebSocketPair
    }
  })
})

describe("previewStatusRoutes", () => {
  const harness = (
    options?: Parameters<typeof previewStatusRoutes>[0],
    binding = "PREVIEW_STATUS",
  ) => {
    const forwarded: Request[] = []
    const names: string[] = []
    const env: Record<string, unknown> = {
      [binding]: {
        idFromName: (name: string) => {
          names.push(name)
          return { name }
        },
        get: (id: { name: string }) => ({
          fetch: async (request: Request) => {
            forwarded.push(request)
            return new Response(`object ${id.name}`)
          },
        }),
      },
    }
    return { routes: previewStatusRoutes(options), env, forwarded, names }
  }

  test("forwards status, live and events to the singleton object", async () => {
    const { routes, env, forwarded, names } = harness()
    for (const path of ["status", "live", "events"]) {
      const response = await routes(new Request(`${ORIGIN}/__preview/${path}`), env)
      expect(await response?.text()).toBe("object status")
    }
    expect(forwarded.map((r) => new URL(r.url).pathname)).toEqual([
      "/__preview/status",
      "/__preview/live",
      "/__preview/events",
    ])
    expect(names).toEqual(["status", "status", "status"])
  })

  test("returns undefined for other paths", () => {
    const { routes, env } = harness()
    expect(routes(new Request(`${ORIGIN}/`), env)).toBeUndefined()
    expect(routes(new Request(`${ORIGIN}/__preview/other`), env)).toBeUndefined()
    expect(routes(new Request(`${ORIGIN}/__previewstatus`), env)).toBeUndefined()
    expect(routes(new Request(`${ORIGIN}/__preview/status/x`), env)).toBeUndefined()
  })

  test("custom basePath and binding", async () => {
    const { routes, env, forwarded } = harness({ basePath: "/_status/", binding: "LIVE" }, "LIVE")
    expect(routes(new Request(`${ORIGIN}/__preview/status`), env)).toBeUndefined()
    expect((await routes(new Request(`${ORIGIN}/_status/status`), env))?.status).toBe(200)
    expect(forwarded.length).toBe(1)
  })

  test("refuses cross-origin status and live, but not CI events", async () => {
    const { routes, env, forwarded } = harness()
    const cross = { origin: "https://evil.example", "sec-fetch-site": "cross-site" }
    expect(
      (await routes(new Request(`${ORIGIN}/__preview/status`, { headers: cross }), env))?.status,
    ).toBe(403)
    expect(
      (
        await routes(
          new Request(`${ORIGIN}/__preview/live`, {
            headers: { origin: "https://evil.example", upgrade: "websocket" },
          }),
          env,
        )
      )?.status,
    ).toBe(403)
    expect(
      (
        await routes(
          new Request(`${ORIGIN}/__preview/status`, { headers: { "sec-fetch-site": "same-site" } }),
          env,
        )
      )?.status,
    ).toBe(403)
    expect(
      (
        await routes(
          new Request(`${ORIGIN}/__preview/live`, {
            headers: { origin: ORIGIN, upgrade: "websocket" },
          }),
          env,
        )
      )?.status,
    ).toBe(200)
    expect(
      (
        await routes(
          new Request(`${ORIGIN}/__preview/status`, {
            headers: { "sec-fetch-site": "same-origin" },
          }),
          env,
        )
      )?.status,
    ).toBe(200)
    expect(
      (
        await routes(
          new Request(`${ORIGIN}/__preview/events`, { method: "POST", headers: cross }),
          env,
        )
      )?.status,
    ).toBe(200)
    expect(forwarded.length).toBe(3)
  })

  test("503 when the binding is missing", async () => {
    const routes = previewStatusRoutes()
    const response = await routes(new Request(`${ORIGIN}/__preview/status`), {})
    expect(response?.status).toBe(503)
  })
})
