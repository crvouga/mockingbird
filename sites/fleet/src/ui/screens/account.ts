import { h } from "../dom.js"
import { act, api, field, flashSlot, form, secretNotice, ui } from "../runtime.js"
import type { Key, Me } from "../types.js"
import { keyList } from "./keys.js"

export async function account(me: Me) {
  const tokens = (await api<{ data: Key[] }>("GET", "/tokens")).data
  return [
    h(".head", {}, h("div", {}, h("h1", {}, "Account"), h("p.sub", {}, me.user?.email ?? ""))),
    flashSlot(),
    h(
      "section",
      {},
      h("h2", {}, "Personal tokens"),
      h(
        "p.sub",
        {},
        "A personal token acts as you everywhere you are a member. Use one to let an agent set up organizations and fleets through the API.",
      ),
      secretNotice(),
      h(
        "form.inline.newtoken",
        {
          onsubmit: act(async () => {
            const token = await api<Key>("POST", "/tokens", {
              name: field(form("form.newtoken"), "name"),
            })
            ui.revealed = { label: "Token created.", value: token.key ?? "" }
          }),
        },
        h("input", {
          name: "name",
          required: true,
          maxlength: "80",
          placeholder: "Token name, e.g. laptop",
          "aria-label": "Token name",
        }),
        h("button.primary", {}, "Create token"),
      ),
      keyList(
        "Personal tokens",
        tokens,
        (key) => api("DELETE", `/tokens/${key.id}`),
        "No personal tokens yet.",
      ),
    ),
  ]
}
