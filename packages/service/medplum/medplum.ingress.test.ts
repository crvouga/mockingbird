import { expect, test } from "bun:test"
import type { MockingbirdConfig } from "../../adapters/node/src/cli.js"
import { startFleet } from "../../adapters/node/src/fleet.js"
import { createFleetIngress } from "../../adapters/node/src/fleet-proxy.js"
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "./src/api.js"
import { serveTarget } from "./src/server.js"

const publicBase = "https://synthetic.example.test/health"
const config: MockingbirdConfig = {
  adminKey: "synthetic-admin",
  services: {
    health: {
      target: "medplum",
      port: 0,
      publicOrigin: "https://synthetic.example.test",
      publicPath: "/health",
    },
  },
}

test("Medplum public FHIR/OAuth links retain namespace and survive changed listeners (#460)", async () => {
  let fleet = await startFleet(config, { load: async () => serveTarget })
  const ingressFor = () =>
    createFleetIngress(config, {
      version: 1,
      services: { health: { url: fleet.children.get("health")?.url ?? "" } },
    })
  let ingress = ingressFor()
  const nsBase = `${publicBase}/__admin/ns/alpha`
  const call = (path: string, init?: RequestInit) => ingress(new Request(`${nsBase}${path}`, init))
  try {
    const discovery = await (
      await call("/.well-known/openid-configuration", {
        headers: { forwarded: "host=evil.test;proto=http", "x-forwarded-host": "evil.test" },
      })
    ).json()
    expect(discovery.issuer).toBe(`${nsBase}/`)
    expect(discovery.token_endpoint).toBe(`${nsBase}/oauth2/token`)
    expect(discovery.jwks_uri).toBe(`${nsBase}/.well-known/jwks.json`)
    expect((await ingress(new Request(discovery.jwks_uri))).status).toBe(200)
    const login = await call("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
      }),
    })
    expect(login.status).toBe(200)
    const token = (await login.json()).access_token
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/fhir+json" }
    let id = ""
    for (const family of ["SyntheticOne", "SyntheticTwo"]) {
      const created = await call("/fhir/R4/Patient", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ resourceType: "Patient", name: [{ family }] }),
      })
      expect(created.status).toBe(201)
      id = (await created.json()).id
      expect(created.headers.get("location")).toStartWith(`${nsBase}/fhir/R4/Patient/${id}`)
    }
    const search = await (await call("/fhir/R4/Patient?_count=1", { headers: auth })).json()
    expect(search.entry).toHaveLength(1)
    expect(search.entry[0].fullUrl).toStartWith(`${nsBase}/fhir/R4/Patient/`)
    const next = search.link.find((link: { relation: string }) => link.relation === "next")
    expect(next.url).toStartWith(`${nsBase}/fhir/R4/Patient`)
    expect((await ingress(new Request(next.url, { headers: auth }))).status).toBe(200)
    expect(
      (
        await ingress(
          new Request(`${publicBase}/__admin/ns/beta/fhir/R4/Patient/${id}`, { headers: auth }),
        )
      ).status,
    ).toBe(401)
    for (const path of ["/__admin/state", "/__admin/ns/alpha/__admin/state"]) {
      expect(
        (
          await ingress(
            new Request(`${publicBase}${path}`, {
              headers: { "x-mockingbird-admin-key": "synthetic-admin" },
            }),
          )
        ).status,
      ).toBe(403)
    }
    const child = fleet.children.get("health")
    if (!child?.exportCheckpoint) throw new Error("missing export participant")
    const snapshot = await child.exportCheckpoint("alpha", await child.checkpoint("alpha"))
    expect(snapshot).toBeDefined()
    const oldUrl = fleet.children.get("health")?.url
    // Start the replacement before stopping the old listener, forcing a different private port.
    const replacement = await startFleet(config, { load: async () => serveTarget })
    await fleet.close()
    fleet = replacement
    expect(fleet.children.get("health")?.url).not.toBe(oldUrl)
    const restored = fleet.children.get("health")
    if (!restored?.importCheckpoint) throw new Error("missing import participant")
    await restored.restore("alpha", await restored.importCheckpoint("alpha", snapshot))
    ingress = ingressFor()
    const renewed = await call("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
      }),
    })
    const nextToken = (await renewed.json()).access_token
    expect(
      (await call(`/fhir/R4/Patient/${id}`, { headers: { authorization: `Bearer ${nextToken}` } }))
        .status,
    ).toBe(200)
    expect((await (await call("/.well-known/openid-configuration")).json()).issuer).toBe(
      `${nsBase}/`,
    )
  } finally {
    await fleet.close()
  }
}, 30_000)
