/**
 * The pages the OAuth emulator serves in the browser: the account chooser, creating a test
 * account, the consent card, the emulator's front page, an expired sign-in, and the two hand-offs
 * back to the app (a redirect, and Apple's `form_post`). Server-rendered with React into complete
 * HTML (every form posts without JavaScript) and prebuilt into `dist-ui/server.js` (see
 * packages/ui/README.md, "Pages served as strings"), which `src/ui.ts` imports lazily through
 * `#ui/server`, so React never loads on the token, discovery or JWKS path.
 *
 * Each function returns the document only; `src/ui.ts` wraps it in the Response with its status,
 * Content-Security-Policy (the `nonce` here) and cache headers.
 */
import { CenteredCard, StatusChip } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { ArrowRight, CircleCheck, Plus } from "@gravity-ui/icons"
import {
  Alert,
  Avatar,
  Button,
  buttonVariants,
  Description,
  Input,
  Label,
  TextField,
} from "@heroui/react"
import type { ReactNode } from "react"
import type { Account } from "../types.js"

const PRODUCT = "OAuth"
const NOTICE = "A Mockingbird emulator: no real account is used."

const document = (title: string, nonce: string, element: ReactNode): string =>
  renderPage(element, {
    title: `${title} · ${PRODUCT}`,
    css: MOCKINGBIRD_CSS,
    nonce,
    rememberTheme: true,
  })

/** A centered card page whose root carries the page's `data-testid`. */
const card = (
  testId: string | undefined,
  props: { title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode },
) => (
  <div className="contents" {...(testId ? { "data-testid": testId } : {})}>
    <CenteredCard product={PRODUCT} notice={NOTICE} {...props} />
  </div>
)

const initial = (name: string) => name.slice(0, 1).toUpperCase()

/** Avatar initial, name and email: an account row's content. */
function Identity({ account }: { account: Pick<Account, "name" | "email"> }) {
  return (
    <>
      <Avatar size="sm">
        <Avatar.Fallback>{initial(account.name)}</Avatar.Fallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium break-words text-foreground">{account.name}</span>
        <span className="truncate text-xs text-muted">{account.email}</span>
      </span>
    </>
  )
}

const Hidden = ({ name, value }: { name: string; value: string }) => (
  <input type="hidden" name={name} value={value} />
)

/** "Cancel sign-in": answers the app with `access_denied`. */
const CancelSignIn = ({ endpoint, transaction }: { endpoint: string; transaction: string }) => (
  <form method="post" action={endpoint} className="w-full">
    <Hidden name="transaction" value={transaction} />
    <Button
      type="submit"
      name="action"
      value="deny"
      variant="ghost"
      fullWidth
      data-testid="oauth-mock-deny"
    >
      Cancel sign-in
    </Button>
  </form>
)

const AppName = ({ children }: { children: ReactNode }) => (
  <span className="font-medium text-foreground">{children}</span>
)

/** An error above a form, announced as it arrives. */
const FormError = ({ testId, message }: { testId: string; message: string }) => (
  <Alert status="danger" role="alert" data-testid={testId}>
    <Alert.Indicator />
    <Alert.Content>
      <Alert.Title className="break-words">{message}</Alert.Title>
    </Alert.Content>
  </Alert>
)

export type LoginPageProps = {
  transaction: string
  /** The client's display name. */
  client: string
  accounts: readonly Account[]
  /** The interaction endpoint every form posts to. */
  endpoint: string
  signup: boolean
  error: string
  nonce: string
}

/** The account chooser, or (with `signup`) the form that creates a test account. */
export function loginPage(props: LoginPageProps): string {
  const { transaction, client, accounts, endpoint, signup, error, nonce } = props
  const cancel = <CancelSignIn endpoint={endpoint} transaction={transaction} />
  if (signup)
    return document(
      "Create account",
      nonce,
      card("oauth-mock-signup", {
        title: "Create your account",
        description: (
          <>
            Create an account to continue to <AppName>{client}</AppName>
          </>
        ),
        footer: cancel,
        children: (
          <>
            {error ? <FormError testId="oauth-mock-signup-error" message={error} /> : null}
            <form method="post" action={endpoint} className="flex flex-col gap-4">
              <Hidden name="transaction" value={transaction} />
              <Hidden name="action" value="signup" />
              <TextField name="name" isRequired fullWidth>
                <Label>Full name</Label>
                <Input autoComplete="name" maxLength={120} data-testid="oauth-mock-signup-name" />
              </TextField>
              <TextField name="email" type="email" isRequired fullWidth>
                <Label>Email address</Label>
                <Input autoComplete="email" maxLength={254} data-testid="oauth-mock-signup-email" />
                <Description>Use a fictional address. No email will be sent.</Description>
              </TextField>
              <Button type="submit" fullWidth data-testid="oauth-mock-signup-submit">
                Create account &amp; continue
              </Button>
            </form>
            <a
              href={`${endpoint}?transaction=${encodeURIComponent(transaction)}`}
              className={buttonVariants({ variant: "tertiary", fullWidth: true })}
            >
              Back to accounts
            </a>
          </>
        ),
      }),
    )
  return document(
    "Choose an account",
    nonce,
    card("oauth-mock-chooser", {
      title: "Choose an account",
      description: (
        <>
          to continue to <AppName>{client}</AppName>
        </>
      ),
      footer: cancel,
      children: (
        <>
          {error ? <FormError testId="oauth-mock-chooser-error" message={error} /> : null}
          {accounts.length ? (
            <ul className="flex flex-col gap-2" aria-label="Accounts">
              {accounts.map((account) => (
                <li key={account.id}>
                  <form
                    method="post"
                    action={endpoint}
                    data-testid="oauth-mock-account"
                    data-account-id={account.id}
                    data-email={account.email}
                  >
                    <Hidden name="transaction" value={transaction} />
                    <Hidden name="action" value="select" />
                    <Button
                      type="submit"
                      name="account"
                      value={account.id}
                      variant="secondary"
                      fullWidth
                      className="h-auto justify-start gap-3 py-2 text-left"
                      data-testid={`oauth-mock-account-${account.id}`}
                    >
                      <Identity account={account} />
                      <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">
              No accounts yet. Create your first test identity below.
            </p>
          )}
          <form method="get" action={endpoint}>
            <Hidden name="transaction" value={transaction} />
            <Hidden name="screen" value="signup" />
            <Button
              type="submit"
              variant="tertiary"
              fullWidth
              data-testid="oauth-mock-create-account"
            >
              <Plus aria-hidden="true" className="size-4" />
              Create a new account
            </Button>
          </form>
        </>
      ),
    }),
  )
}

const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm your identity",
  email: "View your email address",
  profile: "View your name and profile",
  name: "View your name",
  offline_access: "Stay connected when you’re away",
}

export type ConsentPageProps = {
  transaction: string
  client: string
  account: Pick<Account, "name" | "email">
  /** Space-separated scopes the app will receive. */
  scopes: string
  endpoint: string
  /** Apple's email privacy: a choice between sharing and a relay address, or a notice. */
  privacy?: { hideEmail: boolean; choice: boolean }
  nonce: string
}

/**
 * Apple's share-or-hide choice. Native radios (styled with the theme's accent) so the page
 * submits `email_choice` and shows the selection without JavaScript; HeroUI's Radio draws its
 * selected state from React state, which a page that is never hydrated does not have.
 */
function EmailChoice({ email, hide }: { email: string; hide: boolean }) {
  const option = (value: "share" | "hide", label: string, detail: ReactNode) => (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-surface-secondary">
      <input
        type="radio"
        name="email_choice"
        value={value}
        defaultChecked={(value === "hide") === hide}
        data-testid={`oauth-mock-${value}-email`}
        className="mt-0.5 size-4 shrink-0 accent-accent"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs break-words text-muted">{detail}</span>
      </span>
    </label>
  )
  return (
    <fieldset className="flex flex-col gap-1 rounded-xl border border-border p-2">
      <legend className="px-1 text-sm font-medium text-foreground">Choose what to share</legend>
      {option("share", "Share my email", <>Your app will receive {email}.</>)}
      {option("hide", "Hide my email", "Use a private relay address to keep your email private.")}
    </fieldset>
  )
}

/** Review access: the account, what the app will see, Allow or Cancel. */
export function consentPage(props: ConsentPageProps): string {
  const { transaction, client, account, scopes, endpoint, privacy, nonce } = props
  const granted = scopes.split(" ").filter(Boolean)
  return document(
    "Review access",
    nonce,
    card("oauth-mock-consent", {
      title: "Review access",
      description: (
        <>
          <AppName>{client}</AppName> would like access to your account.
        </>
      ),
      children: (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-border p-3">
            <Identity account={account} />
          </div>
          {granted.length ? (
            <ul className="flex flex-col" aria-label="Permissions">
              {granted.map((scope) => (
                <li
                  key={scope}
                  className="flex items-center gap-3 border-b border-border py-2.5 text-sm text-foreground last:border-b-0"
                >
                  <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-accent" />
                  <span className="min-w-0 break-words">{SCOPE_LABELS[scope] ?? scope}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <form method="post" action={endpoint} className="flex flex-col gap-3">
            <Hidden name="transaction" value={transaction} />
            {privacy?.choice ? (
              <EmailChoice email={account.email} hide={privacy.hideEmail} />
            ) : privacy ? (
              <p className="text-sm text-muted">
                {privacy.hideEmail
                  ? "A private relay address will be shared with this app."
                  : "Your email address will be shared with this app."}
              </p>
            ) : null}
            <p className="text-sm text-muted">You can cancel now without sharing anything.</p>
            <Button
              type="submit"
              name="action"
              value="allow"
              fullWidth
              data-testid="oauth-mock-allow"
            >
              Allow &amp; continue
            </Button>
            <Button
              type="submit"
              name="action"
              value="deny"
              variant="ghost"
              fullWidth
              data-testid="oauth-mock-deny"
            >
              Cancel
            </Button>
          </form>
        </>
      ),
    }),
  )
}

/** `GET /`: the emulator's front page. */
export function homePage(nonce: string): string {
  return document(
    "Identity sandbox",
    nonce,
    card(undefined, {
      title: "Make sign-in feel real",
      description:
        "Your identity sandbox is ready. Start sign-in from your application to choose an account, create a new identity, and review access.",
      children: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted">OAuth 2.0 · OpenID Connect</span>
          <StatusChip status="ok">Ready</StatusChip>
        </div>
      ),
    }),
  )
}

/** An interaction whose transaction is gone (expired, or already used). */
export function expiredPage(nonce: string): string {
  return document(
    "Session expired",
    nonce,
    card("oauth-mock-error", {
      title: "This sign-in expired",
      children: (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Let’s try again</Alert.Title>
            <Alert.Description>
              Return to your application and start sign-in again.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ),
    }),
  )
}

/** The script that moves on by itself; the page's Continue works without it. */
const Script = ({ nonce, source }: { nonce: string; source: string }) => (
  // biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed, trusted one-liner carrying the CSP nonce
  <script nonce={nonce} dangerouslySetInnerHTML={{ __html: source }} />
)

/**
 * The hand-off a top-level browser navigation gets in place of a bare redirect: it moves on to
 * `location` by script, and its Continue link does the same without one.
 */
export function redirectPage(location: string, nonce: string): string {
  return document(
    "Continue to your app",
    nonce,
    card("oauth-mock-redirect", {
      title: "Back to your app",
      description: "Your sign-in response is ready.",
      children: (
        <>
          <a
            id="callback"
            href={location}
            className={buttonVariants({ fullWidth: true })}
            data-testid="oauth-mock-redirect-continue"
          >
            Continue
          </a>
          <Script
            nonce={nonce}
            source="location.replace(document.getElementById('callback').href)"
          />
        </>
      ),
    }),
  )
}

/** `response_mode=form_post`: a form holding the response, posted to the app on load. */
export function formPostPage(
  redirectUri: string,
  values: Record<string, string>,
  nonce: string,
): string {
  return document(
    "Continue to your app",
    nonce,
    card("oauth-mock-form-post", {
      title: "Back to your app",
      description: "Your sign-in response is ready.",
      children: (
        <>
          <form id="callback" method="post" action={redirectUri}>
            {Object.entries(values).map(([name, value]) => (
              <Hidden key={name} name={name} value={value} />
            ))}
            <Button type="submit" fullWidth data-testid="oauth-mock-form-post-continue">
              Continue
            </Button>
          </form>
          <Script nonce={nonce} source="document.getElementById('callback').submit()" />
        </>
      ),
    }),
  )
}
