import { describe, expect, test } from "bun:test"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import {
  CredentialError,
  createRedactor,
  DEFAULT_OPENBAO_ADDRESS,
  leaks,
  loadCredentials,
  OpenBaoClient,
  OpenBaoError,
} from "./src/index.js"

const params = fcParameters(process.env)

const secret = fc.stringMatching(/^[A-Za-z0-9_-]{4,40}$/)
const slug = fc.stringMatching(/^[a-z][a-z0-9]{0,11}$/)

type FakeBao = {
  fetch: (request: Request) => Promise<Response>
  requests: Array<{ method: string; path: string; token: string | undefined; body: unknown }>
}

const fakeBao = (config: {
  jwtRole: string
  jwt: string
  issuedToken: string
  secrets: Record<string, Record<string, string>>
}): FakeBao => {
  const requests: FakeBao["requests"] = []
  const validTokens = new Set([config.issuedToken])
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  return {
    requests,
    fetch: async (request) => {
      const url = new URL(request.url)
      const token = request.headers.get("x-vault-token") ?? undefined
      const text = await request.text()
      const body: unknown = text === "" ? undefined : JSON.parse(text)
      const path = url.pathname.replace(/^\/v1\//, "")
      requests.push({ method: request.method, path, token, body })
      if (request.method === "POST" && path === "auth/jwt/login") {
        const b = body as { jwt?: string; role?: string }
        if (b.jwt !== config.jwt || b.role !== config.jwtRole)
          return json(400, { errors: ["invalid jwt"] })
        return json(200, { auth: { client_token: config.issuedToken, lease_duration: 60 } })
      }
      if (request.method === "POST" && path === "auth/token/revoke-self") {
        if (token === undefined || !validTokens.has(token))
          return json(403, { errors: ["permission denied"] })
        validTokens.delete(token)
        return new Response(null, { status: 204 })
      }
      if (request.method === "GET") {
        if (token === undefined || !validTokens.has(token))
          return json(403, { errors: ["permission denied"] })
        const data = config.secrets[path]
        if (!data) return json(404, { errors: [] })
        return json(200, { data: { data, metadata: { version: 1 } } })
      }
      return json(404, { errors: ["unsupported"] })
    },
  }
}

describe("openbao credentials", () => {
  test("env vars win, OpenBao is used otherwise, and nothing secret survives redaction", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          provider: slug,
          fieldA: slug,
          fieldB: slug,
          valueA: secret,
          valueB: secret,
          jwt: secret,
          issuedToken: secret,
          useEnv: fc.boolean(),
          viaJwt: fc.boolean(),
          overridePath: fc.option(slug, { nil: undefined }),
          noise: fc.string({ maxLength: 40 }),
        }),
        async (input) => {
          fc.pre(input.fieldA !== input.fieldB)
          fc.pre(
            new Set([input.valueA, input.valueB, input.jwt, input.issuedToken]).size === 4 &&
              ![input.valueA, input.valueB, input.jwt].some(
                (s) => input.issuedToken.includes(s) || s.includes(input.issuedToken),
              ),
          )
          const spec = {
            provider: input.provider,
            fields: {
              [input.fieldA]: `MOCKINGBIRD_${input.provider.toUpperCase()}_A`,
              [input.fieldB]: `MOCKINGBIRD_${input.provider.toUpperCase()}_B`,
            },
          }
          const path =
            input.overridePath === undefined
              ? `secret/data/secret`
              : `secret/data/${input.overridePath}`
          const bao = fakeBao({
            jwt: input.jwt,
            jwtRole: "mockingbird-parity",
            issuedToken: input.issuedToken,
            secrets: { [path]: { [input.fieldA]: input.valueA, [input.fieldB]: input.valueB } },
          })
          const env: Record<string, string | undefined> = {
            MOCKINGBIRD_OPENBAO_ADDR: DEFAULT_OPENBAO_ADDRESS,
          }
          if (input.useEnv) {
            env[spec.fields[input.fieldA] ?? ""] = input.valueA
            env[spec.fields[input.fieldB] ?? ""] = input.valueB
          } else if (input.viaJwt) {
            env.MOCKINGBIRD_OPENBAO_JWT = input.jwt
          } else {
            env.MOCKINGBIRD_OPENBAO_TOKEN = input.issuedToken
          }
          if (input.overridePath !== undefined)
            env[`MOCKINGBIRD_OPENBAO_PATH_${input.provider.toUpperCase()}`] = path

          const loaded = await loadCredentials(spec, { env, fetch: bao.fetch })
          expect(loaded.values).toEqual({
            [input.fieldA]: input.valueA,
            [input.fieldB]: input.valueB,
          })
          expect(loaded.source).toBe(input.useEnv ? "env" : "openbao")
          if (input.useEnv) {
            expect(bao.requests).toHaveLength(0)
          } else {
            const read = bao.requests.find((r) => r.method === "GET")
            expect(read?.path).toBe(path)
            expect(read?.token).toBe(input.issuedToken)
            expect(loaded.secrets).toContain(input.issuedToken)
            if (input.viaJwt) {
              expect(bao.requests[0]).toMatchObject({
                method: "POST",
                path: "auth/jwt/login",
                body: { jwt: input.jwt, role: "mockingbird-parity" },
              })
              expect(bao.requests.at(-1)).toMatchObject({ path: "auth/token/revoke-self" })
            }
          }
          const redact = createRedactor(loaded.secrets)
          const leaky = `${input.noise}${input.valueA} ${input.issuedToken}/${input.valueB}${input.noise}`
          const clean = redact(leaky)
          expect(leaks(clean, loaded.secrets)).toBe(false)
          expect(leaks(leaky, loaded.secrets)).toBe(true)
          expect(redact(input.noise.split(input.valueA).join(""))).toBe(
            redact(input.noise.split(input.valueA).join("")),
          )
        },
      ),
      params,
    )
  })

  test("missing sources and denied reads surface as typed errors, never as raw fetch failures", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          provider: slug,
          field: slug,
          wrongToken: secret,
          realToken: secret,
          mode: fc.constantFrom("env", "openbao", "auto", "bogus"),
          withToken: fc.boolean(),
        }),
        async (input) => {
          fc.pre(input.wrongToken !== input.realToken)
          const spec = {
            provider: input.provider,
            fields: { [input.field]: "MOCKINGBIRD_X_FIELD" },
          }
          const bao = fakeBao({ jwt: "j", jwtRole: "r", issuedToken: input.realToken, secrets: {} })
          const env: Record<string, string | undefined> = {
            MOCKINGBIRD_CREDENTIALS: input.mode,
            MOCKINGBIRD_OPENBAO_ADDR: DEFAULT_OPENBAO_ADDRESS,
          }
          if (input.withToken) env.MOCKINGBIRD_OPENBAO_TOKEN = input.wrongToken
          const outcome = await loadCredentials(spec, { env, fetch: bao.fetch }).then(
            () => "ok",
            (error: unknown) => error,
          )
          const url = `${DEFAULT_OPENBAO_ADDRESS}/v1/secret/data/secret`
          if (input.mode === "bogus") {
            expect(outcome).toBeInstanceOf(CredentialError)
          } else if (input.mode === "env") {
            expect(outcome).toBeInstanceOf(CredentialError)
            expect((outcome as CredentialError).message).toContain("MOCKINGBIRD_X_FIELD")
          } else if (input.withToken) {
            expect(outcome).toBeInstanceOf(OpenBaoError)
            expect((outcome as OpenBaoError).status).toBe(403)
            expect((outcome as OpenBaoError).message).toContain(url)
            expect((outcome as OpenBaoError).message).toContain("MOCKINGBIRD_X_FIELD")
            expect((outcome as OpenBaoError).message).not.toContain(input.wrongToken)
          } else {
            expect(outcome).toBeInstanceOf(CredentialError)
            const message = (outcome as CredentialError).message
            expect(message).toContain(input.provider)
            expect(message).toContain("MOCKINGBIRD_X_FIELD")
            expect(message).toContain(url)
            expect(message).toContain(`MOCKINGBIRD_OPENBAO_PATH_${input.provider.toUpperCase()}`)
          }
        },
      ),
      params,
    )
  })

  test("a secret that exists but lacks a field names the field, the url, and the env alternative", async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ provider: slug, field: slug, token: secret }), async (input) => {
        const envVar = `MOCKINGBIRD_${input.provider.toUpperCase()}_KEY`
        const spec = { provider: input.provider, fields: { [input.field]: envVar } }
        const path = `secret/data/secret`
        const bao = fakeBao({
          jwt: "j",
          jwtRole: "r",
          issuedToken: input.token,
          secrets: { [path]: { other: "unrelated" } },
        })
        const error = await loadCredentials(spec, {
          env: {
            MOCKINGBIRD_OPENBAO_ADDR: DEFAULT_OPENBAO_ADDRESS,
            MOCKINGBIRD_OPENBAO_TOKEN: input.token,
          },
          fetch: bao.fetch,
        }).then(
          () => undefined,
          (e: unknown) => e,
        )
        expect(error).toBeInstanceOf(CredentialError)
        const message = (error as CredentialError).message
        expect(message).toContain(`"${input.field}"`)
        expect(message).toContain(`${DEFAULT_OPENBAO_ADDRESS}/v1/${path}`)
        expect(message).toContain(envVar)
      }),
      params,
    )
  })

  test("client refuses plaintext addresses and normalises paths", () => {
    fc.assert(
      fc.property(fc.webUrl({ validSchemes: ["http"] }), (address) => {
        const host = new URL(address).hostname
        fc.pre(host !== "localhost" && host !== "127.0.0.1")
        expect(() => new OpenBaoClient({ address })).toThrow(RangeError)
      }),
      params,
    )
  })
})
