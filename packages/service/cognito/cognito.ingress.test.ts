import { expect, test } from "bun:test"
import { createPublicKey, type JsonWebKey, verify } from "node:crypto"
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose"
import { startFleet } from "../../adapters/node/src/fleet.js"
import { FleetClient } from "../../adapters/node/src/fleet-client.js"
import { createFleetIngress } from "../../adapters/node/src/fleet-proxy.js"
import { serveTarget } from "./src/server.js"

const base = "https://identity.example.test/auth"
const poolId = "us-east-1_fixture"
const user = { username: "fixture@example.test", password: "Synthetic1", confirmed: true }
const config = {
  adminKey: "synthetic-admin",
  services: {
    identity: {
      target: "cognito",
      port: 0,
      publicOrigin: "https://identity.example.test",
      publicPath: "/auth",
      fixtures: { users: [user] },
      options: { "pool-id": poolId, "client-id": "fixture-client" },
    },
  },
}
const tokenParts = (token: string) => {
  const [head, body, signature] = token.split(".") as [string, string, string]
  return {
    head,
    body,
    signature,
    header: JSON.parse(Buffer.from(head, "base64url").toString()),
    claims: JSON.parse(Buffer.from(body, "base64url").toString()),
  }
}

test("Cognito public ingress verifies namespaced identity and restored key rings through an immutable origin (#459)", async () => {
  const start = () => startFleet(config, { load: async () => serveTarget })
  let fleet = await start()
  const ingressFor = () =>
    createFleetIngress(config, {
      version: 1,
      services: { identity: { url: fleet.children.get("identity")?.url ?? "" } },
    })
  let ingress = ingressFor()
  const authenticate = async (namespace: string) => {
    const response = await ingress(
      new Request(`${base}/__admin/ns/${namespace}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
          host: "attacker.example.test",
          forwarded: "host=attacker.example.test;proto=http",
          "x-forwarded-host": "attacker.example.test",
        },
        body: JSON.stringify({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: "fixture-client",
          AuthParameters: { USERNAME: user.username, PASSWORD: user.password },
        }),
      }),
    )
    expect(response.status).toBe(200)
    return (await response.json()).AuthenticationResult.IdToken as string
  }
  const verifyDiscovered = async (token: string, namespace: string) => {
    const { head, body, signature, header, claims } = tokenParts(token)
    const expectedIssuer = `${base}/__admin/ns/${namespace}/${poolId}`
    expect(claims).toMatchObject({ iss: expectedIssuer, aud: "fixture-client", token_use: "id" })
    expect(header.alg).toBe("RS256")
    const discovery = await (
      await ingress(new Request(`${expectedIssuer}/.well-known/openid-configuration`))
    ).json()
    expect(discovery.issuer).toBe(expectedIssuer)
    expect(discovery.jwks_uri).toBe(`${expectedIssuer}/.well-known/jwks.json`)
    const remote = createRemoteJWKSet(new URL(discovery.jwks_uri), {
      [customFetch]: async (url, init) => ingress(new Request(url, init)),
    })
    const checked = await jwtVerify(token, remote, {
      issuer: expectedIssuer,
      audience: "fixture-client",
      algorithms: ["RS256"],
    })
    expect(checked.payload.token_use).toBe("id")
    const keys = (await (await ingress(new Request(discovery.jwks_uri))).json())
      .keys as (JsonWebKey & { kid: string })[]
    const matches = keys.filter((key) => key.kid === header.kid)
    expect(matches).toHaveLength(1)
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${head}.${body}`),
        createPublicKey({ key: matches[0] as JsonWebKey, format: "jwk" }),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true)
    return keys
  }
  try {
    const alpha = await authenticate("alpha")
    const beta = await authenticate("beta")
    const alphaKeys = await verifyDiscovered(alpha, "alpha")
    const betaKeys = await verifyDiscovered(beta, "beta")
    expect(alphaKeys.map((key) => key.kid)).not.toEqual(betaKeys.map((key) => key.kid))
    for (const path of [
      "/__admin/users",
      "/__admin/state",
      "/__admin/keys/rotate",
      "/__admin/ns/alpha/__admin/keys/rotate",
    ])
      expect(
        (
          await ingress(
            new Request(`${base}${path}`, {
              headers: { "x-mockingbird-admin-key": "synthetic-admin" },
            }),
          )
        ).status,
      ).toBe(403)
    expect(
      (
        await ingress(
          new Request(`${base}/`, {
            method: "POST",
            headers: {
              authorization:
                "AWS4-HMAC-SHA256 Credential=fixture/20300101/us-east-1/cognito-idp/aws4_request, SignedHeaders=host, Signature=fixture",
              "content-type": "application/json",
              "x-amz-target": "AWSCognitoIdentityProviderService.AdminGetUser",
            },
            body: JSON.stringify({ Username: user.username }),
          }),
        )
      ).status,
    ).toBe(403)
    const privateUrl = fleet.children.get("identity")?.url ?? ""
    const rotate = await fetch(`${privateUrl}/__admin/ns/alpha/__admin/keys/rotate`, {
      method: "POST",
      headers: { "x-mockingbird-admin-key": "synthetic-admin", "content-type": "application/json" },
      body: JSON.stringify({ retainPrevious: true }),
    })
    expect(rotate.status).toBe(200)
    const rotated = await authenticate("alpha")
    const retainedKeys = await verifyDiscovered(alpha, "alpha")
    await verifyDiscovered(rotated, "alpha")
    const client = new FleetClient(fleet.manifest.adminBase, { adminKey: "synthetic-admin" })
    const archive = await client.exportArchive(undefined, true)
    await fleet.close()
    fleet = await start()
    expect(fleet.children.get("identity")?.url).not.toBe(privateUrl)
    await new FleetClient(fleet.manifest.adminBase, { adminKey: "synthetic-admin" }).importArchive(
      archive,
    )
    ingress = ingressFor()
    expect(await verifyDiscovered(alpha, "alpha")).toEqual(retainedKeys)
    await verifyDiscovered(rotated, "alpha")
    expect(await verifyDiscovered(beta, "beta")).toEqual(betaKeys)
    await verifyDiscovered(await authenticate("alpha"), "alpha")
  } finally {
    await fleet.close()
  }
})
