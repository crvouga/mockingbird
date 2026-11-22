import { CenteredCard, EmptyState } from "@crvouga/mockingbird-ui/react"
import { mutation } from "../form.js"
import { LinkList, LinkRow, Removed } from "../kit.js"
import type { Context } from "../router.js"
import { to } from "../routes.js"
import { api, deny, land, returnTo, ui } from "../runtime.js"
import { SIGN_IN_METHODS } from "../types.js"

/** Each way to sign in → where it leads and how the chooser describes it. */
const METHODS: Record<(typeof SIGN_IN_METHODS)[number], { label: string; about: string }> = {
  oidc: {
    label: "Continue with single sign-on",
    about: "Sign in through your organization's identity provider.",
  },
  devLogin: {
    label: "Sign in locally",
    about: "Type any email address. Offered only because this server runs on a loopback address.",
  },
  tokenLogin: {
    label: "Sign in with a token",
    about: "Paste a personal token (mbf_u_…) issued by the operator of this server.",
  },
}

/** A sign-in screen's own address, keeping where to return to afterwards. */
const within = (path: string) => path + ui.address.search()

/** The chooser: one link per way to sign in. Signing in itself happens on the screen it leads to. */
export function signIn({ config }: Context) {
  const back = returnTo(ui.address.search())
  // Single sign-on leaves the dashboard: the browser follows that link itself.
  const href = {
    oidc: `/auth/login?return_to=${encodeURIComponent(back)}`,
    devLogin: within(to("sign-in.local")),
    tokenLogin: within(to("sign-in.token")),
  }
  const offered = SIGN_IN_METHODS.filter((method) => config?.auth[method])
  return (
    <CenteredCard
      product="Fleet Cloud"
      title="Sign in to Mockingbird Fleet"
      description="Hosted fleets of vendor-API emulators at stable URLs, with their state kept in object storage."
    >
      <Removed about="signed-out" />
      {back.startsWith("/invite/") ? (
        <p className="text-sm text-muted">Sign in to continue to the invite you opened.</p>
      ) : null}
      {offered.length > 0 ? (
        <LinkList label="Ways to sign in" framed={false}>
          {offered.map((method) => (
            <LinkRow
              key={method}
              href={href[method]}
              title={METHODS[method].label}
              meta={METHODS[method].about}
            />
          ))}
        </LinkList>
      ) : (
        <EmptyState
          title="This server offers no way to sign in"
          description="Its operator must set OIDC_ISSUER, OPERATOR_TOKEN or AUTH_DEV_LOGIN."
        />
      )}
    </CenteredCard>
  )
}

export function signInLocal({ config, route }: Context) {
  if (!config?.auth.devLogin) deny("Local sign-in is not available on this server.")
  return mutation({
    signedOut: true,
    title: route.title,
    lead: "For development only: you are signed in as whichever email address you type. This is offered because the server runs on a loopback address.",
    fields: [
      {
        kind: "text",
        type: "email",
        name: "email",
        label: "Email",
        hint: "Any address works, for example you@example.test.",
        required: "Enter an email address.",
        attrs: { autoComplete: "email", inputMode: "email" },
      },
    ],
    check: ({ email }) =>
      email && !/^[^@\s]+@[^@\s]+$/.test(email)
        ? { email: "Enter an email address with an @, like you@example.test." }
        : {},
    place: (error) => (error.status === 400 ? "email" : undefined),
    submit: "Sign in",
    pending: "Signing in…",
    cancel: within(to("sign-in")),
    failed: "You were not signed in.",
    run: async ({ email }) => {
      await api("POST", "/auth/dev-login", { email })
      await land(returnTo(ui.address.search()))
    },
  })
}

export function signInToken({ config, route }: Context) {
  if (!config?.auth.tokenLogin) deny("Signing in with a token is not available on this server.")
  return mutation({
    signedOut: true,
    title: route.title,
    lead: "The operator of this server issues personal tokens with POST /api/v1/admin/users.",
    fields: [
      {
        kind: "text",
        type: "password",
        name: "token",
        label: "Personal token",
        hint: "Starts with mbf_u_. An organization or project key cannot sign in.",
        required: "Paste your personal token.",
      },
    ],
    place: (error) => (error.status === 401 || error.status === 400 ? "token" : undefined),
    submit: "Sign in",
    pending: "Signing in…",
    cancel: within(to("sign-in")),
    failed: "You were not signed in.",
    run: async ({ token }) => {
      await api("POST", "/auth/token-login", { token })
      await land(returnTo(ui.address.search()))
    },
  })
}

export function signOut({ me, route }: Context) {
  return mutation({
    title: route.title,
    lead: (
      <>
        You are signed in
        {me.user?.email ? (
          <>
            {" as "}
            <strong>{me.user.email}</strong>
          </>
        ) : null}
        . Signing out ends the session in this browser. Your personal tokens and API keys keep
        working.
      </>
    ),
    submit: "Sign out",
    pending: "Signing out…",
    cancel: to("orgs"),
    failed: "You are still signed in.",
    run: async () => {
      await api("POST", "/auth/logout")
      await land(to("sign-in"), { note: { about: "signed-out", text: "You signed out just now." } })
    },
  })
}
