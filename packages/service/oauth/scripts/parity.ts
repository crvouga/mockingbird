/**
 * Safe public live parity. This checks the provider metadata and signing-key contracts that can
 * be observed without creating users, granting consent, or storing provider credentials.
 * Interactive and token behavior is covered by the protocol, SDK, behavior, and property suites.
 */
import { OAuthAPI, type Provider } from "../src/index.js"

type Metadata = Record<string, unknown>
type ProviderCase = {
  provider: Exclude<Provider, "github" | "oidc">
  discovery: string
  scopes: string[]
  subject: "public" | "pairwise"
}

const providers: ProviderCase[] = [
  {
    provider: "google",
    discovery: "https://accounts.google.com/.well-known/openid-configuration",
    scopes: ["openid", "email", "profile"],
    subject: "public",
  },
  {
    provider: "apple",
    discovery: "https://appleid.apple.com/.well-known/openid-configuration",
    scopes: ["openid", "email", "name"],
    subject: "pairwise",
  },
  {
    provider: "microsoft",
    discovery: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
    scopes: ["openid", "email", "profile", "offline_access"],
    subject: "pairwise",
  },
]

const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []
const requireSubset = (name: string, subset: string[], available: string[]) => {
  const missing = subset.filter((item) => !available.includes(item))
  if (missing.length) throw new Error(`${name}: live provider is missing ${missing.join(", ")}`)
}
const getJson = async (url: string, headers?: HeadersInit): Promise<Metadata> => {
  const response = await fetch(url, { headers, redirect: "manual" })
  if (!response.ok) throw new Error(`${url}: expected success, received ${response.status}`)
  return (await response.json()) as Metadata
}

for (const entry of providers) {
  const live = await getJson(entry.discovery)
  const mock = (await (
    await new OAuthAPI({ provider: entry.provider }).fetch(
      new Request("https://identity.test/.well-known/openid-configuration"),
    )
  ).json()) as Metadata

  if (typeof live.issuer !== "string" || typeof live.jwks_uri !== "string")
    throw new Error(`${entry.provider}: live discovery omitted issuer or jwks_uri`)
  requireSubset(`${entry.provider} scopes`, entry.scopes, strings(live.scopes_supported))
  requireSubset(
    `${entry.provider} response modes`,
    strings(mock.response_modes_supported),
    strings(live.response_modes_supported),
  )
  requireSubset(
    `${entry.provider} signing algorithms`,
    strings(mock.id_token_signing_alg_values_supported),
    strings(live.id_token_signing_alg_values_supported),
  )
  requireSubset(
    `${entry.provider} subject type`,
    [entry.subject],
    strings(live.subject_types_supported),
  )
  requireSubset(
    `${entry.provider} client authentication`,
    strings(mock.token_endpoint_auth_methods_supported),
    strings(live.token_endpoint_auth_methods_supported),
  )

  const liveKeys = await getJson(live.jwks_uri)
  const mockKeys = (await (
    await new OAuthAPI({ provider: entry.provider }).fetch(new Request(String(mock.jwks_uri)))
  ).json()) as Metadata
  for (const [source, keys] of [
    ["live", liveKeys.keys],
    ["mock", mockKeys.keys],
  ] as const) {
    if (!Array.isArray(keys) || !keys.some((key) => key?.kty === "RSA" && key?.use === "sig"))
      throw new Error(`${entry.provider}: ${source} JWKS has no RSA signing key`)
  }
  console.log(`${entry.provider}: discovery and JWKS parity passed`)
}

const githubLive = await fetch("https://api.github.com/user", {
  headers: { accept: "application/vnd.github+json", "user-agent": "mockingbird-parity" },
})
const githubMock = await new OAuthAPI({ provider: "github" }).fetch(
  new Request("https://identity.test/user"),
)
if (githubLive.status !== 401 || githubMock.status !== 401)
  throw new Error(
    `github: unauthenticated profile status diverged (live ${githubLive.status}, mock ${githubMock.status})`,
  )
for (const [source, response] of [
  ["live", githubLive],
  ["mock", githubMock],
] as const) {
  const body = (await response.json()) as Metadata
  if (typeof body.message !== "string") throw new Error(`github: ${source} error omitted message`)
}
console.log("github: unauthenticated REST error parity passed")
console.log("oauth public live parity passed")
