import { h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import {
  ApiError,
  action,
  api,
  crumbs,
  day,
  head,
  land,
  link,
  properties,
  removed,
  section,
} from "../runtime.js"
import type { Key } from "../types.js"
import { keyList } from "./keys.js"
import { secretScreen } from "./members.js"

const listTokens = async () => (await api<{ data: Key[] }>("GET", "/tokens")).data
const accountCrumbs = (last: string) => crumbs(link(to("account"), {}, "Account"), last)

export async function account({ me }: Context) {
  const tokens = await listTokens()
  return [
    head("Account", "Who you are signed in as, and the tokens that act as you."),
    properties("Signed in as", [
      { name: "Name", value: me.user?.name ?? h("span.aside", {}, "Not shared by your sign-in") },
      { name: "Email", value: me.user?.email ?? h("span.aside", {}, "Not shared by your sign-in") },
      {
        name: "Session",
        value: "This browser",
        change: link(to("sign-out"), {}, "Sign out"),
      },
    ]),
    section(
      "Personal tokens",
      action(to("token.new"), "New personal token", "primary"),
      h(
        "p.sub",
        {},
        "A personal token acts as you in every organization you belong to. Give one to an agent so it can set up organizations and fleets through the API.",
      ),
      removed("tokens"),
      keyList(
        "Personal tokens",
        tokens,
        (token) => to("token.revoke", { token: token.id }),
        () => null,
        [h("strong", {}, "No personal tokens yet"), "Create one to use the API as yourself."],
      ),
    ),
  ]
}

export function tokenNew({ route }: Context) {
  return mutation({
    title: route.title,
    crumbs: accountCrumbs("New token"),
    lead: "The token can do everything you can, in every organization you belong to. It is shown once, on the next screen.",
    fields: [
      {
        kind: "text",
        name: "name",
        label: "Name",
        hint: "Where it will be used, for example laptop or coding-agent. Up to 80 characters.",
        required: "Enter a name for the token.",
        attrs: { maxlength: "80" },
      },
    ],
    submit: "Create token",
    pending: "Creating…",
    cancel: to("account"),
    failed: "The token was not created.",
    run: async ({ name }) => {
      const token = await api<Key>("POST", "/tokens", { name })
      await land(to("token.created", { token: token.id }), {
        secret: { id: token.id, value: token.key ?? "", for: token.name },
      })
    },
  })
}

export function tokenCreated({ route, params }: Context) {
  return secretScreen({
    id: params.token ?? "",
    title: route.title,
    what: "This personal token",
    body: "Send it as Authorization: Bearer <token>. Anyone who has it can act as you.",
    done: to("account"),
  })
}

export async function tokenRevoke({ route, params }: Context) {
  const token = (await listTokens()).find((entry) => entry.id === params.token)
  if (!token) throw new ApiError(404, "This personal token does not exist, or was already revoked.")
  return mutation({
    title: titleOf(route, { token: token.name }),
    crumbs: accountCrumbs("Revoke token"),
    danger: true,
    lead: [
      "Anything still using ",
      h("code", {}, `${token.prefix}…`),
      ` is refused from its next request (last used ${day(token.lastUsedAt)}). A revoked token cannot be restored.`,
    ],
    submit: "Revoke token",
    pending: "Revoking…",
    cancel: to("account"),
    failed: "The token was not revoked.",
    run: async () => {
      await api("DELETE", `/tokens/${token.id}`)
      await land(to("account"), {
        note: { about: "tokens", text: `${token.name} was revoked just now.` },
      })
    },
  })
}
