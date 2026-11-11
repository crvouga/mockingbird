import { h } from "../dom.js"
import { mutation } from "../form.js"
import type { Context } from "../router.js"
import { to } from "../routes.js"
import { api, land } from "../runtime.js"
import type { Org } from "../types.js"

/** `k3v9x2…r6t0`: enough of an invite's code to recognise the link by, not enough to reuse it. */
const abbreviate = (token: string) =>
  token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-4)}` : token

/**
 * Opening an invite link joins nothing by itself: this screen says what joining means, and the
 * one button does it. The API names the organization only once the invite is accepted.
 */
export function inviteAccept({ me, route, params }: Context) {
  const token = params.token ?? ""
  return mutation({
    title: route.title,
    lead: [
      "You opened the invite link ",
      h("code", {}, abbreviate(token)),
      ". Joining adds ",
      me.user?.email ? h("strong", {}, me.user.email) : "your account",
      " to the organization that sent it, with the role its admin chose. The link works once.",
    ],
    submit: "Join",
    pending: "Joining…",
    cancel: to("orgs"),
    failed: "You did not join.",
    run: async () => {
      const org = await api<Org>("POST", "/invites/accept", { token })
      await land(to("org", { org: org.id }), {
        note: { about: `org:${org.id}`, text: "Joined just now" },
      })
    },
  })
}
