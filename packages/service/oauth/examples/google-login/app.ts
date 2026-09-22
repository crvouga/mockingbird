import { type Context, Hono } from "hono"
import * as oauth from "oauth4webapi"
import { type BehaviorInput, OAuthAPI, type Provider } from "../../src/index.js"
import { escapeHtml } from "../../src/ui.js"
import { COOKIE_HEADERS, ORIGIN_HEADER } from "./transport.js"

export const APP = "https://app.example.test"
export const IDENTITY = "https://accounts.example.test"
export type Trace = { sequence: number; actor: string; method: string; url: string; status: number }
type Identity = { sub: string; name?: string; email?: string }
const callback = `${APP}/auth/callback`
const client = { client_id: "example-app" }
const secret = "example-only-client-secret"
export type ExampleProvider = Extract<Provider, "google" | "apple" | "microsoft" | "github">

/** A complete application server. Every outbound OAuth request uses the local dispatcher. */
export function createExample(
  behavior: BehaviorInput = {},
  onTrace: (entry: Trace) => void = () => {},
  providerProfile: ExampleProvider = "google",
) {
  const provider = new OAuthAPI({
    provider: providerProfile,
    cookieHeaders: COOKIE_HEADERS,
    issuer: IDENTITY,
    behavior,
    accounts: [
      {
        id: "ada",
        name: "Ada Lovelace",
        email: "ada@example.test",
        github: {
          id: 101,
          login: "ada",
          publicEmail: null,
          emails: [
            {
              email: "ada@example.test",
              primary: true,
              verified: true,
              visibility: "private",
            },
          ],
        },
      },
      {
        id: "grace",
        name: "Grace Hopper",
        email: "grace@example.test",
        github: {
          id: 102,
          login: "grace",
          publicEmail: "grace@example.test",
          emails: [
            {
              email: "grace@example.test",
              primary: true,
              verified: true,
              visibility: "public",
            },
          ],
        },
      },
    ],
    clients: [
      {
        id: client.client_id,
        name: "Side A",
        secret,
        redirectUris: [callback],
        requirePkce: true,
      },
    ],
  })
  const preferences = { reuseLastAccount: false }
  const app = new Hono()
  const pending = new Map<
    string,
    { state: string; nonce: string; verifier: string; expires: number }
  >()
  const sessions = new Map<string, { user: Identity; expires: number }>()
  let sequence = 0
  async function dispatch(request: Request, actor = "Browser"): Promise<Response> {
    const url = new URL(request.url)
    if (![APP, IDENTITY].includes(url.origin))
      throw new Error("This example only routes its two in-process origins.")
    const id = ++sequence
    const response = await (url.origin === APP ? app.fetch(request) : provider.fetch(request))
    onTrace({
      sequence: id,
      actor,
      method: request.method,
      url: `${url.host}${url.pathname}`,
      status: response.status,
    })
    return response
  }
  const options = {
    [oauth.customFetch]: (
      input: string,
      init: oauth.CustomFetchOptions<string, URLSearchParams | undefined>,
    ) =>
      dispatch(
        new Request(input, {
          method: init.method,
          headers: init.headers,
          ...(init.body ? { body: init.body } : {}),
        }),
        "Hono server",
      ),
  }
  let discovery: Promise<oauth.AuthorizationServer> | undefined
  const metadata = () =>
    (discovery ??=
      providerProfile === "github"
        ? Promise.resolve({
            issuer: IDENTITY,
            authorization_endpoint: `${IDENTITY}/login/oauth/authorize`,
            token_endpoint: `${IDENTITY}/login/oauth/access_token`,
            userinfo_endpoint: `${IDENTITY}/user`,
          })
        : oauth
            .discoveryRequest(new URL(IDENTITY), options)
            .then((response) => oauth.processDiscoveryResponse(new URL(IDENTITY), response)))
  const current = (cookie: string | undefined) => {
    const session = cookie ? sessions.get(cookie) : undefined
    return session && session.expires > Date.now() ? session.user : undefined
  }
  app.get("/", (c) => c.html(document(current(cookie(c, "session")))))
  app.get("/api/session", (c) => c.json({ user: current(cookie(c, "session")) ?? null }))
  app.get("/auth/start", async (c) => {
    const as = await metadata()
    const state = oauth.generateRandomState()
    const nonce = oauth.generateRandomNonce()
    const verifier = oauth.generateRandomCodeVerifier()
    const key = crypto.randomUUID()
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id)
    pending.set(key, { state, nonce, verifier, expires: Date.now() + 600_000 })
    setCookie(c, "login", key, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    })
    const url = new URL(as.authorization_endpoint ?? "")
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: "code",
      ...(!preferences.reuseLastAccount ? { prompt: "select_account" } : {}),
      scope:
        providerProfile === "apple"
          ? "openid email name"
          : providerProfile === "github"
            ? "read:user user:email"
            : "openid email profile",
      ...(providerProfile === "apple" ? { response_mode: "form_post" } : {}),
      state,
      nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    }).toString()
    return c.redirect(url.href)
  })
  const callbackHandler = async (c: Context) => {
    const key = cookie(c, "login") ?? ""
    const transaction = pending.get(key)
    pending.delete(key)
    deleteCookie(c, "login", { path: "/" })
    try {
      if (!transaction || transaction.expires < Date.now()) throw new Error("Login expired")
      const as = await metadata()
      const callbackUrl = new URL(c.req.url)
      let appleUser: { name?: { firstName?: string; lastName?: string }; email?: string } = {}
      if (c.req.method === "POST") {
        const form = new URLSearchParams(await c.req.text())
        for (const name of ["code", "state", "error", "error_description"])
          if (form.has(name)) callbackUrl.searchParams.set(name, form.get(name) ?? "")
        try {
          appleUser = JSON.parse(form.get("user") ?? "{}")
        } catch {
          appleUser = {}
        }
      }
      const params = oauth.validateAuthResponse(as, client, callbackUrl, transaction.state)
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.ClientSecretPost(secret),
        params,
        callback,
        transaction.verifier,
        options,
      )
      const tokens = await oauth.processAuthorizationCodeResponse(
        as,
        client,
        response,
        providerProfile === "github"
          ? { requireIdToken: false }
          : { expectedNonce: transaction.nonce, requireIdToken: true },
      )
      if (providerProfile !== "github")
        await oauth.validateApplicationLevelSignature(as, response, options)
      const claims =
        providerProfile === "github" ? undefined : oauth.getValidatedIdTokenClaims(tokens)
      const user: Identity =
        providerProfile === "github"
          ? await githubIdentity(as, tokens.access_token)
          : providerProfile === "apple" && claims
            ? {
                sub: claims.sub,
                ...(typeof claims.email === "string" ? { email: claims.email } : {}),
                ...(appleUser.name
                  ? {
                      name: [appleUser.name.firstName, appleUser.name.lastName]
                        .filter(Boolean)
                        .join(" "),
                    }
                  : {}),
              }
            : claims
              ? await oauth.processUserInfoResponse(
                  as,
                  client,
                  claims.sub,
                  await oauth.userInfoRequest(as, client, tokens.access_token, options),
                )
              : (() => {
                  throw new Error("Missing identity")
                })()
      const session = crypto.randomUUID()
      sessions.set(session, {
        user: {
          sub: user.sub,
          ...(typeof user.name === "string" ? { name: user.name } : {}),
          ...(typeof user.email === "string" ? { email: user.email } : {}),
        },
        expires: Date.now() + 3600_000,
      })
      setCookie(c, "session", session, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 3600,
      })
      return c.redirect("/")
    } catch {
      return c.html(
        document(
          undefined,
          "Sign-in could not be completed. Permission may have been declined, the provider may be unavailable, or the login may have expired. You can safely try again.",
        ),
        400,
      )
    }
  }

  async function githubIdentity(as: oauth.AuthorizationServer, accessToken: string) {
    const profileResponse = await oauth.userInfoRequest(as, client, accessToken, options)
    if (!profileResponse.ok) throw new Error("GitHub profile request failed")
    const profile = (await profileResponse.json()) as {
      id?: number
      name?: string | null
      login?: string
      email?: string | null
    }
    if (!Number.isSafeInteger(profile.id)) throw new Error("GitHub profile has no stable ID")
    let email = profile.email ?? undefined
    if (!email) {
      const emailResponse = await dispatch(
        new Request(`${IDENTITY}/user/emails`, {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        "Hono server",
      )
      const emails = emailResponse.ok
        ? ((await emailResponse.json()) as { email: string; primary: boolean; verified: boolean }[])
        : []
      email = emails.find((item) => item.primary && item.verified)?.email
    }
    return {
      sub: String(profile.id),
      ...(profile.name || profile.login ? { name: profile.name ?? profile.login } : {}),
      ...(email ? { email } : {}),
    }
  }
  app.get("/auth/callback", callbackHandler)
  app.post("/auth/callback", callbackHandler)
  app.post("/auth/logout", (c) => {
    if (c.req.header(ORIGIN_HEADER) !== APP) return c.text("Invalid origin", 403)
    sessions.delete(cookie(c, "session") ?? "")
    deleteCookie(c, "session", { path: "/" })
    return c.redirect("/", 303)
  })
  return { dispatch, app, provider, preferences, providerProfile }
}

function document(user?: Identity, error?: string) {
  const e = escapeHtml
  const record = `<div class="record-art" aria-hidden="true"><div class="sleeve"><span class="sleeve-label">SIDE A<br>SELECTS / 001</span><span class="sleeve-title">THE<br>GOOD<br>STUFF.</span><span class="sleeve-bottom">A collection of things you felt.</span></div><div class="vinyl"><div class="vinyl-label">SIDE A<span>33⅓ RPM</span></div></div><span class="sticker">ON<br>REPEAT ↗</span></div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Side A — Your listening journal</title><style>
  :root{color-scheme:light dark;--paper:light-dark(#f1eee6,#171b24);--surface:light-dark(#fffdf7,#222735);--ink:light-dark(#191f32,#f1eee6);--muted:light-dark(#666a70,#b0b4be);--line:light-dark(#c9c8bf,#414755);--acid:#e2ff54;--blue:#3448e9;--orange:#ff7656}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 system-ui,sans-serif}header{padding:20px 30px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{font-size:27px;font-weight:900;letter-spacing:-1.8px;display:flex;align-items:center;gap:10px;white-space:nowrap}.brand-mark{width:25px;height:25px;border:7px solid currentColor;border-radius:50%;position:relative}.brand-mark:after{content:"";position:absolute;width:3px;height:3px;top:4px;left:4px;background:currentColor;border-radius:50%}.edition,.eyebrow,.caption,.tag{font:10px/1.5 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}.edition{color:var(--muted);text-align:right}main{max-width:1100px;margin:auto;padding:38px 30px 28px}h1{font:clamp(42px,7vw,68px)/.98 Georgia,serif;letter-spacing:-2.6px;margin:18px 0 22px;font-weight:400}h1 em{font-weight:400}h1[tabindex="-1"]:focus{outline:none}.eyebrow{display:flex;align-items:center;gap:8px}.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--blue)}.hero{display:grid;grid-template-columns:1.1fr 1fr;align-items:center;gap:28px}.intro{font-size:15px;line-height:1.7;color:var(--muted);max-width:330px;margin:0 0 24px}.signin{max-width:340px}.primary{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;background:var(--acid);color:#191f32;border:1px solid #191f32;border-radius:0;padding:15px 18px;box-shadow:4px 4px 0 var(--ink);font:700 13px system-ui;cursor:pointer;text-decoration:none}.primary:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 var(--ink)}.primary span{font-size:20px;line-height:1}.fine{font-size:11px;color:var(--muted);margin:14px 0 0}.record-art{position:relative;aspect-ratio:1.03;min-width:0;isolation:isolate}.sleeve{position:absolute;inset:10% 17% 7% 0;background:var(--blue);color:#fff8db;padding:18px;box-shadow:0 14px 25px #0002;transform:rotate(-7deg);display:flex;flex-direction:column;justify-content:space-between;z-index:2}.sleeve-label,.sleeve-bottom{font:9px/1.4 ui-monospace,monospace;letter-spacing:.06em}.sleeve-title{font-size:clamp(25px,4.5vw,48px);font-weight:900;line-height:.92;letter-spacing:-2px}.vinyl{position:absolute;width:82%;aspect-ratio:1;border-radius:50%;right:-3%;top:13%;background:repeating-radial-gradient(circle at center,#202127 0 2px,#33343b 3px,#18191e 4px 5px);box-shadow:0 12px 26px #0003;display:grid;place-items:center}.vinyl-label{width:36%;aspect-ratio:1;background:var(--orange);color:#191f32;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column;font-size:15px;font-weight:900;transform:rotate(18deg)}.vinyl-label span{font:7px ui-monospace,monospace;margin-top:5px}.sticker{position:absolute;right:0;top:4%;z-index:3;width:70px;height:70px;display:grid;place-content:center;background:var(--acid);color:#191f32;border-radius:50%;text-align:center;font:800 12px/1.15 system-ui;transform:rotate(13deg)}.manifesto{border-top:1px solid var(--line);margin-top:34px;padding-top:18px;display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:11px}.manifesto strong{color:var(--ink);font-weight:600}.notice{border-left:3px solid var(--orange);padding:12px 15px;background:var(--surface);font-size:13px;margin:0 0 22px}.welcome{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.welcome h1{font-size:46px;margin-bottom:16px}.logout{background:transparent;border:1px solid var(--line);color:var(--ink);padding:8px 12px;font:11px ui-monospace,monospace;cursor:pointer;white-space:nowrap}.logout:hover{border-color:var(--ink)}.shelf-title{display:flex;justify-content:space-between;align-items:center;margin:24px 0 12px}.shelf-title h2{font-size:14px;margin:0;font-weight:650}.tag{color:var(--muted);font-size:9px}.shelf{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}.album{margin:0}.cover{aspect-ratio:1.35;position:relative;overflow:hidden;display:flex;align-items:end;padding:12px;color:#fff;font:800 17px/1 system-ui;letter-spacing:-.7px}.cover:before{content:"";position:absolute;border-radius:50%;width:80%;aspect-ratio:1;right:-10%;top:-20%;border:22px solid #ffffff38}.cover span{position:relative;z-index:1}.cover-blue{background:#3448e9}.cover-orange{background:#df5034}.cover-green{background:#286752}.album h3{font-size:12px;margin:10px 0 3px;font-weight:600}.album p{font-size:11px;color:var(--muted);margin:0}.account{border-top:1px solid var(--line);margin-top:26px;padding-top:15px;display:flex;justify-content:space-between;align-items:start;gap:15px;font-size:11px}.account small{display:block;color:var(--muted);font-size:10px}.account span{overflow-wrap:anywhere}.account details{color:var(--muted);max-width:50%;text-align:right;overflow-wrap:anywhere}.account summary{cursor:pointer}.account p{margin:8px 0 0}:is(a,button,summary):focus-visible{outline:3px solid var(--blue);outline-offset:5px}@media(max-width:600px){header{padding:18px 20px}main{padding:28px 22px}.hero{grid-template-columns:1fr;gap:12px}h1{font-size:54px;max-width:350px}.intro{max-width:340px}.record-art{width:min(260px,80%);margin:10px auto 0}.sleeve-title{font-size:34px}.manifesto{margin-top:24px;flex-wrap:wrap}.welcome{gap:10px}.welcome h1{font-size:37px}.shelf{gap:9px}.cover{aspect-ratio:1;padding:9px;font-size:14px}.cover:before{border-width:15px}.edition{font-size:9px}.account{flex-wrap:wrap}}@media(prefers-reduced-motion:no-preference){.primary{transition:transform .15s,box-shadow .15s}}
  </style></head><body><header><div class="brand"><span class="brand-mark" aria-hidden="true"></span>SIDE A</div><span class="edition">A home for your good taste.<br>Independent listening journal</span></header><main>${error ? `<p class="notice" role="alert">${e(error)}</p>` : ""}${user ? `<section class="welcome"><div><div class="eyebrow"><span class="dot" aria-hidden="true"></span>Your personal rotation</div><h1 tabindex="-1">Welcome, ${e(user.name?.split(" ")[0] ?? "friend")}.</h1><p class="intro">Every great collection starts with a feeling.<br>Make room for your next favorite.</p></div><form method="post" action="/auth/logout"><button class="logout">Sign out ↗</button></form></section><div class="shelf-title"><h2>A little shelf inspiration</h2><span class="tag">Sample collection / 001—003</span></div><section class="shelf" aria-label="Sample listening journal"><article class="album"><div class="cover cover-blue" aria-hidden="true"><span>BLUE<br>HOUR.</span></div><h3>For the long way home</h3><p>Late-night listening</p></article><article class="album"><div class="cover cover-orange" aria-hidden="true"><span>SOFT<br>FOCUS.</span></div><h3>Sunday, on repeat</h3><p>Slow mornings</p></article><article class="album"><div class="cover cover-green" aria-hidden="true"><span>OFF<br>THE GRID.</span></div><h3>Somewhere new</h3><p>Outside the usual</p></article></section><div class="account"><span><small>Signed in as</small>${e(user.name ?? "Name not shared")}<small>${e(user.email ?? "Email not shared")}</small></span><details><summary>Account details</summary><p>Account ID: ${e(user.sub)}</p></details></div>` : `<section class="hero"><div><div class="eyebrow"><span class="dot" aria-hidden="true"></span>For the love of listening</div><h1 tabindex="-1">Good records.<br><em>Better memories.</em></h1><p class="intro">Your favorite albums. The places they take you. A little space to keep it all.</p><div class="signin"><a class="primary" href="/auth/start">Continue with OAuth Mock <span aria-hidden="true">↗</span></a><p class="fine">Your next favorite thing starts here.</p></div></div>${record}</section><footer class="manifesto"><strong>Less algorithm. More you.</strong><span>Collect the music. Keep the feeling.</span></footer>`}</main></body></html>`
}

// Explicit local cookie envelope: browser Fetch strips native Cookie/Set-Cookie headers.
// The envelope is only used by this example's allowlisted in-process dispatcher.
function cookie(c: Context, name: string) {
  return c.req
    .header(COOKIE_HEADERS.request)
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
function setCookie(
  c: Context,
  name: string,
  value: string,
  options: { maxAge: number; httpOnly: boolean; secure: boolean; sameSite: string; path: string },
) {
  c.header(
    COOKIE_HEADERS.response,
    `${name}=${value}; Path=${options.path}; HttpOnly; Secure; SameSite=${options.sameSite}; Max-Age=${options.maxAge}`,
    { append: true },
  )
}
function deleteCookie(c: Context, name: string, options: { path: string }) {
  c.header(COOKIE_HEADERS.response, `${name}=; Path=${options.path}; Max-Age=0`, { append: true })
}
