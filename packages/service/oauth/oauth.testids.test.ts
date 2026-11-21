import { describe, expect, test } from "bun:test"
import { OAuthAPI } from "./src/index.js"

const issuer = "https://identity.test"
const callback = "https://app.test/callback"
const ada = { id: "ada", name: "Ada Lovelace", email: "ada@example.test" }
const grace = { id: "grace-1", name: "Grace Hopper", email: "grace@example.test" }
const client = {
  id: "app",
  name: "Example application",
  redirectUris: [callback],
  secret: "fixture-client-secret",
}
const post = (path: string, body: Record<string, string>) =>
  new Request(issuer + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  })
const authorize = (api: OAuthAPI, extra: Record<string, string> = {}) =>
  api.fetch(
    new Request(
      `${issuer}/authorize?${new URLSearchParams({ client_id: "app", redirect_uri: callback, response_type: "code", scope: "openid email profile", state: "s", nonce: "n", ...extra })}`,
    ),
  )
const transactionOf = (html: string) => /name="transaction" value="([^"]+)"/.exec(html)?.[1] ?? ""
const ids = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1])
// The tag that carries a test id, so attributes can be asserted on the same element.
const tag = (html: string, id: string) =>
  new RegExp(`<[a-z]+ [^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? ""

describe("data-testid hooks on the interaction pages", () => {
  test("chooser: root, one button per account, create account and cancel", async () => {
    const api = new OAuthAPI({ accounts: [ada, grace], clients: [client] })
    const html = await (await authorize(api)).text()
    const found = ids(html)
    expect(found.filter((id) => id === "oauth-mock-chooser")).toHaveLength(1)
    // the root wraps the page's one heading
    expect(html).toMatch(/data-testid="oauth-mock-chooser".*<h1[^>]*>Choose an account<\/h1>/)
    expect(found).toContain("oauth-mock-account-ada")
    expect(found).toContain("oauth-mock-account-grace-1")
    expect(found).toContain("oauth-mock-create-account")
    expect(found).toContain("oauth-mock-deny")
    // the shared id names the account through data attributes
    const wrappers = html.match(/<form [^>]*data-testid="oauth-mock-account"[^>]*>/g) ?? []
    expect(wrappers).toHaveLength(2)
    expect(wrappers[1]).toContain('data-account-id="grace-1"')
    expect(wrappers[1]).toContain('data-email="grace@example.test"')
    // each per-account id is unique, so a driver using only getByTestId picks one account
    const perAccount = found.filter((id) => id?.startsWith("oauth-mock-account-"))
    expect(new Set(perAccount).size).toBe(perAccount.length)
    expect(tag(html, "oauth-mock-account-ada")).toContain('value="ada"')
  })

  test("account ids are escaped in test ids", async () => {
    const api = new OAuthAPI({
      accounts: [{ id: 'a"b', name: "Odd", email: "odd@example.test" }],
      clients: [client],
    })
    const html = await (await authorize(api)).text()
    expect(html).toContain('data-testid="oauth-mock-account-a&quot;b"')
  })

  test("signup: root, inputs, submit and error", async () => {
    const api = new OAuthAPI({ accounts: [ada], clients: [client] })
    const tx = transactionOf(await (await authorize(api)).text())
    const signup = await api.fetch(
      new Request(`${issuer}/interaction?transaction=${tx}&screen=signup`),
    )
    const html = await signup.text()
    const found = ids(html)
    expect(found).toContain("oauth-mock-signup")
    expect(found).not.toContain("oauth-mock-chooser")
    expect(tag(html, "oauth-mock-signup-name")).toContain('name="name"')
    expect(tag(html, "oauth-mock-signup-email")).toContain('name="email"')
    expect(found).toContain("oauth-mock-signup-submit")
    expect(found).toContain("oauth-mock-deny")
    expect(found).not.toContain("oauth-mock-signup-error")

    const invalid = await api.fetch(
      post("/interaction", { transaction: tx, action: "signup", name: "", email: "nope" }),
    )
    const errorHtml = await invalid.text()
    expect(invalid.status).toBe(400)
    expect(ids(errorHtml)).toContain("oauth-mock-signup")
    expect(tag(errorHtml, "oauth-mock-signup-error")).toContain('role="alert"')

    const duplicate = await api.fetch(
      post("/interaction", {
        transaction: tx,
        action: "signup",
        name: "Ada",
        email: ada.email,
      }),
    )
    expect(ids(await duplicate.text())).toContain("oauth-mock-signup-error")
  })

  test("chooser: an unavailable account shows a chooser error", async () => {
    const api = new OAuthAPI({ accounts: [ada], clients: [client] })
    const tx = transactionOf(await (await authorize(api)).text())
    const response = await api.fetch(
      post("/interaction", { transaction: tx, action: "select", account: "missing" }),
    )
    const found = ids(await response.text())
    expect(found).toContain("oauth-mock-chooser")
    expect(found).toContain("oauth-mock-chooser-error")
  })

  test("consent: root, allow and cancel, with Share/Hide radios only for Apple's default choice", async () => {
    const api = new OAuthAPI({ accounts: [ada], clients: [client] })
    const tx = transactionOf(await (await authorize(api)).text())
    const consent = await (
      await api.fetch(post("/interaction", { transaction: tx, action: "select", account: "ada" }))
    ).text()
    const found = ids(consent)
    expect(found).toContain("oauth-mock-consent")
    expect(found).toContain("oauth-mock-allow")
    expect(found).toContain("oauth-mock-deny")
    expect(found).not.toContain("oauth-mock-share-email")

    const apple = new OAuthAPI({
      provider: "apple",
      accounts: [ada],
      clients: [client],
    })
    const appleTx = transactionOf(
      await (await authorize(apple, { response_mode: "form_post", scope: "openid email" })).text(),
    )
    const appleConsent = await (
      await apple.fetch(
        post("/interaction", { transaction: appleTx, action: "select", account: "ada" }),
      )
    ).text()
    const appleIds = ids(appleConsent)
    expect(appleIds).toContain("oauth-mock-share-email")
    expect(appleIds).toContain("oauth-mock-hide-email")
    expect(tag(appleConsent, "oauth-mock-share-email")).toContain('value="share"')
    expect(tag(appleConsent, "oauth-mock-hide-email")).toContain('value="hide"')
  })

  test("form_post: root and the no-JavaScript Continue button", async () => {
    const api = new OAuthAPI({
      provider: "apple",
      accounts: [ada],
      clients: [client],
      nonce: () => "fixed-nonce",
    })
    const tx = transactionOf(
      await (await authorize(api, { response_mode: "form_post", scope: "openid email" })).text(),
    )
    await api.fetch(post("/interaction", { transaction: tx, action: "select", account: "ada" }))
    const response = await api.fetch(post("/interaction", { transaction: tx, action: "allow" }))
    const html = await response.text()
    expect(ids(html)).toContain("oauth-mock-form-post")
    expect(tag(html, "oauth-mock-form-post-continue")).toContain('type="submit"')
    // the Continue button sits inside the hand-off form that posts to the client
    expect(html).toMatch(
      /<form id="callback" action="https:\/\/app\.test\/callback" method="post">.*data-testid="oauth-mock-form-post-continue".*<\/form>/,
    )
  })

  test("error: an expired transaction carries the error root", async () => {
    const api = new OAuthAPI({ accounts: [ada], clients: [client] })
    const response = await api.fetch(new Request(`${issuer}/interaction?transaction=unknown`))
    expect(response.status).toBe(400)
    expect(ids(await response.text())).toEqual(["oauth-mock-error"])
  })
})
