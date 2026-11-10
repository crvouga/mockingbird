/**
 * Sign-in over HTTP: OpenID Connect against the `oauth` emulator in server mode (a real
 * provider: discovery, /authorize, /token, signed ID tokens, a JWKS), operator-issued users
 * with personal tokens, and dev login. Browser flows are specified elsewhere; these steps drive
 * the same redirects a browser would follow, one request at a time.
 */
import { expect } from "@playwright/test"
import {
  beginOidcSignIn,
  finishOidcSignIn,
  type Hosting,
  hosting,
  type OidcSignIn,
  signInWithOidc,
  startOidcProvider,
} from "../support/hosting.js"
import { OPERATOR_TOKEN, startStack } from "../support/stack.js"
import type { Credential, World } from "../support/world.js"
import { Given, Then, When } from "./common.steps.js"

const CLIENT_ID = "fleet-dashboard"

const provider = (state: Hosting) => {
  if (!state.provider) throw new Error("This scenario has no identity provider")
  return state.provider
}
const signedIn = (state: Hosting): OidcSignIn => {
  if (!state.signIn) throw new Error("Nobody has tried to sign in yet")
  return state.signIn
}
const session = (cookie: string): Credential => ({ kind: "session", cookie })

/** The cookie of a person's nth sign-in (default: the latest). */
const cookieOf = (state: Hosting, person: string, index = -1): string => {
  const cookie = state.cookies.get(person)?.at(index)
  if (!cookie) throw new Error(`${person} has no session`)
  return cookie
}

const me = async (world: World, cookie: string) =>
  world.api(session(cookie), "GET", "/me") as Promise<{
    status: number
    body: { user?: { id: string; email: string }; orgs?: { name: string }[] }
  }>

/** Record the outcome of a callback as the scenario's current sign-in (and the last reply). */
function record(world: World, person: string | undefined, outcome: OidcSignIn) {
  const state = hosting(world)
  state.signIn = outcome
  state.signIns.push(outcome)
  if (person && outcome.cookie)
    state.cookies.set(person, [...(state.cookies.get(person) ?? []), outcome.cookie])
}

// ---- the provider -------------------------------------------------------------------------

Given(
  "a server that signs people in through an OpenID Connect provider",
  async ({ world, ownStacks }) => {
    const state = hosting(world)
    state.provider = await startOidcProvider()
    state.cleanups.push(state.provider.stop)
    state.clientId = CLIENT_ID
    const stack = await startStack({
      OIDC_ISSUER: state.provider.issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
    })
    ownStacks.push(stack)
    world.stack = stack
    await state.provider.registerClient(CLIENT_ID, [`${stack.url}/auth/callback`])
  },
)

Given(
  "the provider has an account {string} with the email {string}",
  async ({ world }, id: string, email: string) => {
    await provider(hosting(world)).seedAccount({ id, email, name: id })
  },
)

Given(
  "the provider reassigns the email {string} from {string} to a new account {string}",
  async ({ world }, email: string, from: string, to: string) => {
    const idp = provider(hosting(world))
    await idp.seedAccount({ id: from, email: `former-${email}`, name: from })
    await idp.seedAccount({ id: to, email, name: to })
  },
)

Given(
  "the provider changes the email of {string} to {string}",
  async ({ world }, id: string, email: string) => {
    await provider(hosting(world)).seedAccount({ id, email, name: id })
  },
)

Given(
  /^the provider (signs ID tokens with a key it does not publish|issues ID tokens that expired an hour ago)$/,
  async ({ world }, fault: string) => {
    await provider(hosting(world)).behave(
      fault.startsWith("signs") ? "id_token_unknown_key" : "id_token_stale",
    )
  },
)

Given("the provider is not running", async ({ world }) => {
  await provider(hosting(world)).stop()
})

Given("a second replica of the server behind the same public address", async ({ world }) => {
  const replica = await world.stack.replica({ PUBLIC_URL: world.stack.url })
  hosting(world).notes.set("replica", replica.url)
})

// ---- starting a sign-in -------------------------------------------------------------------

When("a visitor starts to sign in", async ({ world }) => {
  hosting(world).redirects.push(await beginOidcSignIn(world.url))
})

When("a visitor tries to start signing in", async ({ world }) => {
  const response = await fetch(`${world.url}/auth/login`, { redirect: "manual" })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {}
  world.last = { status: response.status, headers: response.headers, body, text }
})

Then(
  "the sign-in attempt is refused with status {int} as {string}",
  async ({ world }, status: number, code: string) => {
    expect(world.last?.status, world.last?.text).toBe(status)
    expect(world.errorCode).toBe(code)
  },
)

const lastRedirect = (state: Hosting) => {
  const redirect = state.redirects.at(-1)
  if (!redirect) throw new Error("No sign-in was started")
  return redirect
}

Then("the visitor is redirected to the provider's authorization endpoint", async ({ world }) => {
  const state = hosting(world)
  const discovery = (await (
    await fetch(`${provider(state).issuer}/.well-known/openid-configuration`)
  ).json()) as { authorization_endpoint: string }
  const redirect = lastRedirect(state)
  expect(`${redirect.origin}${redirect.pathname}`).toBe(discovery.authorization_endpoint)
})

Then("the authorization request carries:", async ({ world }, table: { raw(): string[][] }) => {
  const query = lastRedirect(hosting(world)).searchParams
  for (const [name, value] of table.raw()) expect(query.get(name ?? ""), name).toBe(value)
})

Then(
  "the authorization request names this server's client id and its {string} address",
  async ({ world }, path: string) => {
    const query = lastRedirect(hosting(world)).searchParams
    expect(query.get("client_id")).toBe(CLIENT_ID)
    expect(query.get("redirect_uri")).toBe(`${world.url}${path}`)
  },
)

Then("the authorization request has a code challenge, a state and a nonce", async ({ world }) => {
  const query = lastRedirect(hosting(world)).searchParams
  // An S256 challenge is the base64url SHA-256 of the verifier: always 43 characters.
  expect(query.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(query.get("state")).toMatch(/^[A-Za-z0-9_-]{22,}$/)
  expect(query.get("nonce")).toMatch(/^[A-Za-z0-9_-]{22,}$/)
})

Then("the authorization request carries no client secret", async ({ world }) => {
  const query = lastRedirect(hosting(world)).searchParams
  expect(query.has("client_secret")).toBe(false)
  // Nor the verifier itself: only its hash leaves the server before the code comes back.
  expect(query.has("code_verifier")).toBe(false)
})

Then(
  "the two authorization requests share no state, nonce or code challenge",
  async ({ world }) => {
    const [first, second] = hosting(world).redirects
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(first?.searchParams.get(name), name).toBeTruthy()
      expect(first?.searchParams.get(name), name).not.toBe(second?.searchParams.get(name))
    }
  },
)

// ---- finishing a sign-in ------------------------------------------------------------------

When(
  "{string} signs in at the provider, asking to return to {string}",
  async ({ world }, person: string, returnTo: string) => {
    record(
      world,
      person,
      await signInWithOidc(world.url, provider(hosting(world)), person, { returnTo }),
    )
  },
)

When("{string} signs in at the provider", async ({ world }, person: string) => {
  record(world, person, await signInWithOidc(world.url, provider(hosting(world)), person))
})

/** Start a sign-in and approve it at the provider, stopping before the callback is opened. */
async function approve(world: World, person: string) {
  const state = hosting(world)
  const authorize = await beginOidcSignIn(world.url)
  state.redirects.push(authorize)
  const callback = await provider(state).decide(authorize.toString(), person)
  state.notes.set(`callback ${state.redirects.length}`, callback)
  state.notes.set("callback", callback)
  state.notes.set("person", person)
}

Given("{string} approves a sign-in at the provider", async ({ world }, person: string) => {
  await approve(world, person)
})

Given("{string} approves a second sign-in at the provider", async ({ world }, person: string) => {
  await approve(world, person)
})

const open = async (world: World, callbackUrl: string, serverUrl?: string) => {
  const state = hosting(world)
  record(
    world,
    state.notes.get("person"),
    await finishOidcSignIn(
      callbackUrl,
      state.signIns.at(-1)?.authorize ?? lastRedirect(state),
      serverUrl,
    ),
  )
}

When("the same callback address is opened again", async ({ world }) => {
  await open(world, signedIn(hosting(world)).callbackUrl)
})

When(
  /^the callback is opened with (a made-up state|no state|no code|a made-up code)$/,
  async ({ world }, change: string) => {
    const url = new URL(hosting(world).notes.get("callback") ?? "")
    if (change === "a made-up state")
      url.searchParams.set("state", "bm90LWEtc3RhdGUtdGhpcy1zZXJ2ZXItbWFkZQ")
    if (change === "no state") url.searchParams.delete("state")
    if (change === "no code") url.searchParams.delete("code")
    if (change === "a made-up code") url.searchParams.set("code", "not-a-code-the-provider-issued")
    await open(world, url.toString())
  },
)

When(
  "the callback of the first attempt is opened with the code of the second",
  async ({ world }) => {
    const { notes } = hosting(world)
    const first = new URL(notes.get("callback 1") ?? "")
    const second = new URL(notes.get("callback 2") ?? "")
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"))
    first.searchParams.set("code", second.searchParams.get("code") ?? "")
    await open(world, first.toString())
  },
)

When("the callback is opened on the second replica", async ({ world }) => {
  const { notes } = hosting(world)
  await open(world, notes.get("callback") ?? "", notes.get("replica"))
})

When("{string} declines the sign-in at the provider", async ({ world }, person: string) => {
  const state = hosting(world)
  const authorize = await beginOidcSignIn(world.url)
  state.redirects.push(authorize)
  const callback = await provider(state).decide(authorize.toString(), person, "deny")
  expect(new URL(callback).searchParams.get("state")).toBe(authorize.searchParams.get("state"))
  await open(world, callback)
})

Then("the sign-in ends with a redirect to {string}", async ({ world }, path: string) => {
  const outcome = signedIn(hosting(world))
  expect(outcome.status, outcome.text).toBe(302)
  expect(outcome.location).toBe(path)
})

const expectBrowserOnlyCookie = (setCookie: string | null | undefined) => {
  expect(setCookie).toMatch(/^mbf_session=[A-Za-z0-9_-]{40,};/)
  expect(setCookie).toContain("HttpOnly")
  expect(setCookie).toContain("SameSite=Lax")
  expect(setCookie).toContain("Path=/")
  expect(setCookie).toMatch(/Max-Age=\d+/)
}

Then(
  "the sign-in sets a session cookie that scripts cannot read and other sites cannot send",
  async ({ world }) => {
    expectBrowserOnlyCookie(signedIn(hosting(world)).setCookie)
  },
)

Then("the new session belongs to {string}", async ({ world }, email: string) => {
  const outcome = signedIn(hosting(world))
  expect(outcome.cookie, outcome.text).toBeDefined()
  const reply = await me(world, outcome.cookie ?? "")
  expect(reply.status).toBe(200)
  expect(reply.body.user?.email).toBe(email)
})

Then("the callback is refused with status {int}", async ({ world }, status: number) => {
  const outcome = signedIn(hosting(world))
  expect(outcome.status, outcome.text).toBe(status)
})

Then(/^the callback says "(.*)"$/, async ({ world }, message: string) => {
  const outcome = signedIn(hosting(world))
  expect((JSON.parse(outcome.text) as { error: { message: string } }).error.message).toBe(message)
})

Then("the callback starts no session", async ({ world }) => {
  const outcome = signedIn(hosting(world))
  expect(outcome.setCookie).toBeNull()
  expect(outcome.location).toBeNull()
})

// ---- who a session belongs to -------------------------------------------------------------

Given(
  "{string} creates an organization {string} in that session",
  async ({ world }, person: string, name: string) => {
    const reply = await world.api(session(cookieOf(hosting(world), person)), "POST", "/orgs", {
      name,
    })
    expect(reply.status, reply.text).toBe(201)
  },
)

Then(
  "the sessions of {string} and {string} belong to different users",
  async ({ world }, first: string, second: string) => {
    const state = hosting(world)
    const one = await me(world, cookieOf(state, first))
    const other = await me(world, cookieOf(state, second))
    expect(one.body.user?.id).toBeTruthy()
    expect(other.body.user?.id).toBeTruthy()
    expect(one.body.user?.id).not.toBe(other.body.user?.id)
  },
)

Then("both sessions of {string} belong to the same user", async ({ world }, person: string) => {
  const state = hosting(world)
  expect(state.cookies.get(person)).toHaveLength(2)
  const earlier = await me(world, cookieOf(state, person, 0))
  const later = await me(world, cookieOf(state, person, 1))
  expect(earlier.body.user?.id).toBeTruthy()
  expect(earlier.body.user?.id).toBe(later.body.user?.id)
})

Then("the session of {string} sees no organizations", async ({ world }, person: string) => {
  const reply = await me(world, cookieOf(hosting(world), person))
  expect(reply.status).toBe(200)
  expect(reply.body.orgs).toEqual([])
})

Then(
  "the session of {string} sees the organization {string}",
  async ({ world }, person: string, name: string) => {
    const reply = await me(world, cookieOf(hosting(world), person))
    expect(reply.body.orgs?.map((org) => org.name)).toEqual([name])
  },
)

When("{string} signs out of the server", async ({ world }, person: string) => {
  const reply = await fetch(`${world.url}/auth/logout`, {
    method: "POST",
    headers: { cookie: cookieOf(hosting(world), person), "x-mockingbird-csrf": "1" },
  })
  expect(reply.status).toBe(200)
  // The browser is told to drop the cookie as well.
  expect(reply.headers.get("set-cookie")).toMatch(/^mbf_session=;.*Max-Age=0/)
})

Then("the session of {string} is no longer accepted", async ({ world }, person: string) => {
  expect((await me(world, cookieOf(hosting(world), person))).status).toBe(401)
})

// ---- operator-issued users and personal tokens --------------------------------------------

/** One address per scenario, so scenarios sharing a server never meet each other's users. */
const address = (world: World, email: string) => email.replace("@", `.${world.tag}@`)

const lastBody = <T>(world: World): T => {
  if (!world.last) throw new Error("No reply yet")
  return world.last.body as T
}

type Issued = { user: { id: string; email: string; name: string }; token: { key: string } }

const exchange = async (world: World, body: unknown, csrf = true) => {
  const response = await fetch(`${world.url}/auth/token-login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(csrf ? { "x-mockingbird-csrf": "1" } : {}) },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  world.last = { status: response.status, headers: response.headers, body: parsed, text }
}

When(
  "the operator creates the user {string} named {string}",
  async ({ world }, email: string, name: string) => {
    const state = hosting(world)
    await world.api("operator", "POST", "/admin/users", { email: address(world, email), name })
    const issued = world.last?.body as Issued | undefined
    if (issued?.token?.key) state.notes.set("second token", issued.token.key)
  },
)

Given("the operator has issued a personal token to {string}", async ({ world }, email: string) => {
  const issued = await world.must<Issued>("operator", "POST", "/admin/users", {
    email: address(world, email),
  })
  hosting(world).notes.set("token", issued.token.key)
})

Then(
  "the reply holds the user {string} named {string}",
  async ({ world }, email: string, name: string) => {
    const { user } = lastBody<Issued>(world)
    expect(user.id).toMatch(/^usr_/)
    expect(user.email).toBe(address(world, email))
    expect(user.name).toBe(name)
  },
)

Then(
  "the reply holds a personal token starting with {string}",
  async ({ world }, prefix: string) => {
    const { token } = lastBody<Issued>(world)
    expect(token.key.startsWith(prefix)).toBe(true)
    expect(token.key).toMatch(/^mbf_u_[a-z0-9]{20}_[A-Za-z0-9_-]{43}$/)
    hosting(world).notes.set("token", token.key)
  },
)

Then("the reply says where to sign in", async ({ world }) => {
  expect(lastBody<{ signInUrl: string }>(world).signInUrl).toBe(`${world.url}/`)
})

Then(
  "the personal token works as an API credential for {string}",
  async ({ world }, email: string) => {
    const key = hosting(world).notes.get("token") ?? ""
    const reply = await world.api({ kind: "key", key }, "GET", "/me")
    expect(reply.status, reply.text).toBe(200)
    expect((reply.body as { user: { email: string } }).user.email).toBe(address(world, email))
  },
)

Then("both issued tokens belong to the same user", async ({ world }) => {
  const { notes } = hosting(world)
  expect(notes.get("token")).not.toBe(notes.get("second token"))
  const ids = []
  for (const name of ["token", "second token"]) {
    const reply = await world.api({ kind: "key", key: notes.get(name) ?? "" }, "GET", "/me")
    expect(reply.status, reply.text).toBe(200)
    ids.push((reply.body as { user: { id: string } }).user.id)
  }
  expect(ids[0]).toBe(ids[1])
})

When("that personal token is exchanged at {string}", async ({ world }, path: string) => {
  expect(path).toBe("/auth/token-login")
  await exchange(world, { token: hosting(world).notes.get("token") })
})

When(
  "that personal token is exchanged at {string} without the CSRF header",
  async ({ world }, path: string) => {
    expect(path).toBe("/auth/token-login")
    await exchange(world, { token: hosting(world).notes.get("token") }, false)
  },
)

When(
  /^(an organization API key|a personal token nobody was issued|the operator token|nothing) is exchanged at "\/auth\/token-login"$/,
  async ({ world }, credential: string) => {
    if (credential === "nothing") return exchange(world, {})
    if (credential === "the operator token") return exchange(world, { token: OPERATOR_TOKEN })
    if (credential === "a personal token nobody was issued")
      return exchange(world, { token: `mbf_u_${"c".repeat(20)}_${"C".repeat(43)}` })
    // An organization key, minted by the person the personal token was issued to.
    const owner: Credential = { kind: "key", key: hosting(world).notes.get("token") ?? "" }
    const org = await world.must<{ id: string }>(owner, "POST", "/orgs", { name: "Keys" })
    const key = await world.must<{ key: string }>(owner, "POST", `/orgs/${org.id}/api-keys`, {
      name: "ci",
    })
    expect(key.key).toMatch(/^mbf_o_/)
    return exchange(world, { token: key.key })
  },
)

Then(
  "the exchange sets a session cookie that scripts cannot read and other sites cannot send",
  async ({ world }) => {
    expectBrowserOnlyCookie(world.last?.headers.get("set-cookie"))
  },
)

Then("the exchange sets no session cookie", async ({ world }) => {
  expect(world.last?.headers.get("set-cookie")).toBeNull()
})

Then("that session cookie signs in {string}", async ({ world }, email: string) => {
  const cookie = world.last?.headers.get("set-cookie")?.split(";")[0] ?? ""
  const reply = await me(world, cookie)
  expect(reply.status).toBe(200)
  expect(reply.body.user?.email).toBe(address(world, email))
})

When(
  /^(a caller with no credential|a caller with a wrong operator token|a signed-in user|a caller presenting the usual operator token) tries to create the user "(.*)"$/,
  async ({ world }, caller: string, email: string) => {
    const who: Parameters<World["api"]>[0] =
      caller === "a caller with no credential"
        ? "anonymous"
        : caller === "a signed-in user"
          ? "Mallory"
          : caller === "a caller presenting the usual operator token"
            ? "operator"
            : "anonymous"
    await world.api(
      who,
      "POST",
      "/admin/users",
      { email: address(world, email) },
      caller === "a caller with a wrong operator token"
        ? { headers: { authorization: `Bearer ${OPERATOR_TOKEN.replace(/.$/, "!")}` } }
        : {},
    )
  },
)

When("a visitor signs in with dev login as {string}", async ({ world }, email: string) => {
  const response = await fetch(`${world.url}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mockingbird-csrf": "1" },
    body: JSON.stringify({ email: address(world, email) }),
  })
  const text = await response.text()
  world.last = { status: response.status, headers: response.headers, body: JSON.parse(text), text }
})
