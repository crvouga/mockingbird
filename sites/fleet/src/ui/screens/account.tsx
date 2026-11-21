import { mutation } from "../form.js"
import { A, Aside, action, Code, Crumbs, Head, Properties, Removed, Section } from "../kit.js"
import type { Context } from "../router.js"
import { titleOf, to } from "../routes.js"
import { ApiError, api, day, land } from "../runtime.js"
import type { Key } from "../types.js"
import { keyList } from "./keys.js"
import { secretScreen } from "./members.js"

const listTokens = async () => (await api<{ data: Key[] }>("GET", "/tokens")).data
const accountCrumbs = (last: string) => (
  <Crumbs items={[{ href: to("account"), label: "Account" }, last]} />
)

export async function account({ me }: Context) {
  const tokens = await listTokens()
  const notShared = <Aside>Not shared by your sign-in</Aside>
  return (
    <>
      <Head title="Account" sub="Who you are signed in as, and the tokens that act as you." />
      <Properties
        label="Signed in as"
        rows={[
          { name: "Name", value: me.user?.name ?? notShared },
          { name: "Email", value: me.user?.email ?? notShared },
          {
            name: "Session",
            value: "This browser",
            change: <A href={to("sign-out")}>Sign out</A>,
          },
        ]}
      />
      <Section
        title="Personal tokens"
        actions={action(to("token.new"), "New personal token", "primary")}
        sub="A personal token acts as you in every organization you belong to. Give one to an agent so it can set up organizations and fleets through the API."
      >
        <Removed about="tokens" />
        {keyList(
          "Personal tokens",
          tokens,
          (token) => to("token.revoke", { token: token.id }),
          undefined,
          { title: "No personal tokens yet", body: "Create one to use the API as yourself." },
        )}
      </Section>
    </>
  )
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
        attrs: { maxLength: 80 },
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
    lead: (
      <>
        Anything still using <Code>{`${token.prefix}…`}</Code> is refused from its next request
        (last used {day(token.lastUsedAt)}). A revoked token cannot be restored.
      </>
    ),
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
