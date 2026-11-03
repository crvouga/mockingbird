import { expect, test } from "bun:test"
import { createPrivateKey } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createClock } from "@crvouga/mockingbird-service"
import { importJWK, importPKCS8, type JWK, jwtVerify, SignJWT } from "jose"
import { startFleet } from "../../../adapters/node/src/index.js"
import { createRuntime as github, prepareFixtures } from "../../../service/github/src/index.js"
import { createRuntime as google } from "../../../service/google/src/index.js"
import { serveTarget as googleTarget } from "../../../service/google/src/server.js"
import { createRuntime as stripe } from "../../../service/stripe/src/index.js"
import { serveTarget as vercelTarget } from "../../../service/vercel/src/server.js"
import type { NativeProvider } from "./targets.js"

test("mounted Google OAuth preserves discovery, namespace forms, callbacks, JWKS and native controls", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const callback = "https://preview.example.test/callback"
  const runtime = google({
    clock,
    adminKey: "fixture-admin",
    fixtures: {
      users: [{ email: "fixture@example.test", name: "Fixture" }],
      oauth_clients: [
        { client_id: "fixture-client", client_secret: "fixture-secret", redirect_uris: [callback] },
      ],
    },
  })
  const mounted = runtime.mount("/api/mock/google")
  const request = (url: string, init?: RequestInit) => mounted.fetch(new Request(url, init))
  const base = "https://preview.example.test/api/mock/google/__admin/ns/fixture"
  const config = (await request(`${base}/.well-known/openid-configuration`).then((r) =>
    r.json(),
  )) as {
    issuer: string
    authorization_endpoint: string
    token_endpoint: string
    jwks_uri: string
  }
  for (const url of [
    config.issuer,
    config.authorization_endpoint,
    config.token_endpoint,
    config.jwks_uri,
  ])
    expect(url).toStartWith(base)
  const query = new URLSearchParams({
    client_id: "fixture-client",
    redirect_uri: callback,
    response_type: "code",
    scope: "openid email profile",
  })
  const page = await request(`${config.authorization_endpoint}?${query}`).then((r) => r.text())
  expect(page).toContain(`action="${new URL(base).pathname}/o/oauth2/v2/auth/callback"`)
  const response = await request(`${base}/o/oauth2/v2/auth/callback`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(query), email: "fixture@example.test" }),
  })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get("location") ?? "")
  expect(`${location.origin}${location.pathname}`).toBe(callback)
  const code = location.searchParams.get("code")
  const tokenResponse = await request(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code ?? "",
      grant_type: "authorization_code",
      redirect_uri: callback,
      client_id: "fixture-client",
      client_secret: "fixture-secret",
    }),
  })
  expect(tokenResponse.status).toBe(200)
  const tokens = (await tokenResponse.json()) as { id_token: string }
  const jwks = (await request(config.jwks_uri).then((r) => r.json())) as { keys: JWK[] }
  if (!jwks.keys[0]) throw new Error("No signing key")
  const verified = await jwtVerify(tokens.id_token, await importJWK(jwks.keys[0], "RS256"), {
    issuer: config.issuer,
    audience: "fixture-client",
    currentDate: new Date(clock.now()),
  })
  expect(verified.payload.email).toBe("fixture@example.test")
  const ui = "https://preview.example.test/api/mock/google/__admin/ui"
  expect((await request(ui.replace("/ui", "/state"))).status).toBe(401)
  const admin = await request(ui, { headers: { "x-mockingbird-admin-key": "fixture-admin" } })
  expect(admin.status).toBe(200)
  expect(await admin.text()).toContain('"adminPrefix":"/api/mock/google/__admin"')
})

test("mounted Stripe checkout advertises and completes its hosted page inside the namespace", async () => {
  const runtime = stripe()
  const handler = runtime.mount("/api/mock/stripe")
  const base = "https://preview.example.test/api/mock/stripe/__admin/ns/checkout-fixture"
  const success = "https://preview.example.test/payment-complete"
  const created = await handler.POST(
    new Request(`${base}/v1/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer sk_test_fixture",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        mode: "payment",
        success_url: success,
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": "1000",
        "line_items[0][price_data][product_data][name]": "Fixture",
        "line_items[0][quantity]": "1",
      }),
    }),
  )
  expect(created.status).toBe(200)
  const session = (await created.json()) as { url: string; id: string }
  expect(session.url).toBe(`${base}/c/pay/${session.id}`)
  expect((await handler.GET(new Request(session.url))).status).toBe(200)
  const paid = await handler.POST(
    new Request(session.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        card: "4242424242424242",
        exp: "12/34",
        cvc: "123",
        zip: "94107",
        action: "pay",
      }),
    }),
  )
  expect(paid.status).toBe(302)
  expect(paid.headers.get("location")).toBe(success)
})

test("provider CLI fixtures seed the native runtime and survive reset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mockingbird-provider-"))
  try {
    const file = join(directory, "google.json")
    await writeFile(file, JSON.stringify({ users: [{ email: "cli-fixture@example.test" }] }))
    const runtime = await googleTarget.create(
      { fixtures: file, "base-url": "https://preview.example.test/google" },
      { seed: "fixture", adminKey: undefined, onLog: undefined },
    )
    const request = (path: string) => runtime.fetch(new Request(`http://mock.local${path}`))
    expect((await request("/.well-known/openid-configuration").then((r) => r.json())).issuer).toBe(
      "https://preview.example.test/google",
    )
    const picker = () =>
      request(
        "/o/oauth2/v2/auth?client_id=fixture&redirect_uri=https://preview.example.test/callback&scope=email",
      ).then((r) => r.text())
    expect(await picker()).toContain("cli-fixture@example.test")
    await runtime.reset()
    expect(await picker()).toContain("cli-fixture@example.test")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("one fleet config carries inline fixtures and public URLs through native reset", async () => {
  const fleet = await startFleet(
    {
      services: {
        google: {
          port: 0,
          baseUrl: "https://preview.example.test/google",
          fixtures: { users: [{ email: "fleet-fixture@example.test" }] },
        },
        vercel: { port: 0, fixtures: { projects: [{ name: "fleet-fixture-project" }] } },
      },
    },
    { load: async (name) => (name === "google" ? googleTarget : vercelTarget) },
  )
  try {
    const googleUrl = fleet.manifest.services.google?.url
    const vercelUrl = fleet.manifest.services.vercel?.url
    if (!googleUrl || !vercelUrl) throw new Error("Fleet endpoints are missing")
    const check = async () => {
      const discovery = await fetch(`${googleUrl}/.well-known/openid-configuration`).then((r) =>
        r.json(),
      )
      expect(discovery.issuer).toBe("https://preview.example.test/google")
      const picker = await fetch(
        `${googleUrl}/o/oauth2/v2/auth?client_id=fixture&redirect_uri=https://preview.example.test/callback&scope=email`,
      ).then((r) => r.text())
      expect(picker).toContain("fleet-fixture@example.test")
      const projects = await fetch(`${vercelUrl}/v10/projects`, {
        headers: { authorization: "Bearer oracle-probe" },
      }).then((r) => r.json())
      expect(JSON.stringify(projects)).toContain("fleet-fixture-project")
    }
    await check()
    const reset = await fleet.fetch(
      new Request(`${fleet.manifest.adminBase}/namespaces/default/reset`, { method: "POST" }),
    )
    expect(reset.status).toBe(200)
    await check()
  } finally {
    await fleet.close()
  }
})

test("native GitHub fixture preparation returns only generated App keys and retains JWT identity on reset", async () => {
  const clock = createClock(() => 1700000000000)
  clock.freeze()
  const input = {
    users: [{ login: "fixture-user" }],
    apps: [
      {
        app_id: 12345,
        slug: "fixture-app",
        name: "Fixture App",
        installations: [{ installation_id: 100, account: "fixture-user" }],
      },
    ],
  }
  const prepared = await prepareFixtures(input)
  expect(input.apps[0]).not.toHaveProperty("private_key")
  expect(prepared.generatedPrivateKeys).toHaveLength(1)
  const key = prepared.generatedPrivateKeys[0]
  if (!key) throw new Error("Fixture key was not generated")
  expect((await prepareFixtures(prepared.fixtures)).generatedPrivateKeys).toHaveLength(0)
  const pem = createPrivateKey(key.private_key).export({ type: "pkcs8", format: "pem" }).toString()
  const jwt = await new SignJWT({})
    .setIssuer(String(key.app_id))
    .setIssuedAt(clock.now() / 1000)
    .setExpirationTime(clock.now() / 1000 + 300)
    .setProtectedHeader({ alg: "RS256" })
    .sign(await importPKCS8(pem, "RS256"))
  const runtime = github({ clock, fixtures: prepared.fixtures })
  const app = () =>
    runtime.fetch(
      new Request("http://mock.local/app", { headers: { authorization: `Bearer ${jwt}` } }),
    )
  const first = await app()
  expect(first.status).toBe(200)
  expect((await first.json()).slug).toBe("fixture-app")
  await runtime.reset()
  expect((await app()).status).toBe(200)
})

for (const name of ["google", "apple", "microsoft", "okta", "clerk"] satisfies NativeProvider[]) {
  test(`${name}: OIDC keys are isolated and snapshots restore the identity in a separate process`, async () => {
    const modulePath = fileURLToPath(
      new URL(`../../../service/${name}/src/index.ts`, import.meta.url),
    )
    const module = (await import(modulePath)) as { createRuntime: typeof google }
    const runtime = module.createRuntime()
    const discovery = (await runtime
      .fetch(new Request("http://mock.local/.well-known/openid-configuration"))
      .then((r) => r.json())) as { jwks_uri: string }
    const jwks = () => runtime.fetch(new Request(discovery.jwks_uri)).then((r) => r.json())
    const initial = await jwks()
    const snapshot = runtime.snapshot()
    const other = await runtime
      .fetch(new Request(discovery.jwks_uri, { headers: { "x-mockingbird-namespace": "other" } }))
      .then((r) => r.json())
    expect(other).not.toEqual(initial)
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const module = await import(${JSON.stringify(modulePath)}); const runtime = module.createRuntime(); const snapshot = JSON.parse(await Bun.stdin.text()); runtime.restore(snapshot); const response = await runtime.fetch(new Request(${JSON.stringify(discovery.jwks_uri)})); console.log(await response.text());`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    )
    child.stdin.write(JSON.stringify(snapshot))
    child.stdin.end()
    const [output, errors, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(errors).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual(initial)
    await runtime.reset()
    expect(await jwks()).toEqual(initial)
    runtime.restore(snapshot)
    expect(await jwks()).toEqual(initial)
  }, 60000)
}
