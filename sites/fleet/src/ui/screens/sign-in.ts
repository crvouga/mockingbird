import { h } from "../dom.js"
import { act, api, field, flashSlot, form, ui } from "../runtime.js"
import type { Config } from "../types.js"

export async function signIn(config: Config) {
  const back = encodeURIComponent(ui.address.path() + ui.address.search())
  return h(
    ".signin",
    {},
    h("h1", {}, "Mockingbird Fleet"),
    h(
      "p",
      {},
      "Hosted fleets of vendor-API emulators at stable URLs, with their state kept in object storage.",
    ),
    flashSlot(),
    config.auth.oidc && h("a.button.primary", { href: `/auth/login?return_to=${back}` }, "Sign in"),
    config.auth.devLogin &&
      h(
        "form.inline",
        {
          onsubmit: act(async () => {
            await api("POST", "/auth/dev-login", { email: field(form(), "email") })
          }),
        },
        h("input", {
          name: "email",
          type: "email",
          required: true,
          placeholder: "you@example.test",
          "aria-label": "Email",
        }),
        h("button.primary", {}, "Sign in locally"),
      ),
    config.auth.devLogin &&
      h("p.sub", {}, "Local sign-in is available because this server runs on a loopback address."),
    config.auth.tokenLogin &&
      h(
        "form.inline.tokenlogin",
        {
          onsubmit: act(async () => {
            await api("POST", "/auth/token-login", {
              token: field(form("form.tokenlogin"), "token"),
            })
          }),
        },
        h("input", {
          name: "token",
          type: "password",
          required: true,
          autocomplete: "off",
          placeholder: "Personal token (mbf_u_…)",
          "aria-label": "Personal token",
        }),
        h("button", {}, "Sign in with a token"),
      ),
    config.auth.tokenLogin &&
      h("p.sub", {}, "The operator of this server issues tokens with POST /api/v1/admin/users."),
  )
}
