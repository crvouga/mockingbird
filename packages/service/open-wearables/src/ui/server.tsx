/**
 * The pages the Open Wearables emulator serves in the browser: pick a provider, consent, done.
 * Server-rendered with React into complete HTML (the consent form posts without JavaScript) and
 * prebuilt into `dist-ui/server.js` (see packages/ui/README.md, "Pages served as strings"), which
 * the runtime imports lazily through `#ui/server`, so React never loads on the API's hot path.
 */
import { CenteredCard, EmptyState } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { ArrowRight, CircleCheck, CircleXmark } from "@gravity-ui/icons"
import { Button, buttonVariants } from "@heroui/react"
import type { ReactNode } from "react"

/** The provider fields the pages show. */
export type PairingProvider = { provider: string; name: string }

const PRODUCT = "Open Wearables"
const NOTICE = "A Mockingbird emulator: no real wearable account is accessed."

const page = (title: string, element: ReactNode): string =>
  renderPage(element, { title: `${title} · ${PRODUCT}`, css: MOCKINGBIRD_CSS })

const pairHref = (prefix: string, userId: string, provider: string, redirectUrl: string) =>
  `${prefix}/users/${encodeURIComponent(userId)}/pair/${encodeURIComponent(provider)}${
    redirectUrl ? `?redirect_url=${encodeURIComponent(redirectUrl)}` : ""
  }`

/** `GET /users/:user_id/pair`: every enabled cloud provider, each a link into its consent. */
export function pairingPage(
  providers: readonly PairingProvider[],
  userId: string,
  redirectUrl = "",
  prefix = "",
): string {
  return page(
    "Connect a wearable",
    <CenteredCard
      product={PRODUCT}
      title="Connect a wearable"
      description="Choose a provider to simulate a connection."
      notice={NOTICE}
    >
      {providers.length ? (
        <ul className="flex flex-col gap-2" aria-label="Providers">
          {providers.map((provider) => (
            <li key={provider.provider}>
              <a
                href={pairHref(prefix, userId, provider.provider, redirectUrl)}
                className={`${buttonVariants({ variant: "secondary", fullWidth: true })} justify-between`}
              >
                {provider.name}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No cloud providers are enabled"
          description="Enable a provider with a cloud API through the emulator's provider settings."
        />
      )}
    </CenteredCard>,
  )
}

/** `GET /mockingbird/oauth/:state`: allow or cancel, posted as `decision`. */
export function consentPage(provider: string, action: string): string {
  return page(
    `Connect ${provider}`,
    <CenteredCard
      product={PRODUCT}
      title={`Connect ${provider}`}
      description="Allow this preview to create a simulated wearable connection?"
      notice={NOTICE}
    >
      <form method="post" action={action} className="flex flex-col gap-2">
        <Button type="submit" name="decision" value="allow" fullWidth>
          Allow connection
        </Button>
        <Button type="submit" name="decision" value="deny" variant="secondary" fullWidth>
          Cancel
        </Button>
      </form>
    </CenteredCard>,
  )
}

/** After the decision, when there is no `redirect_url` to return to. */
export function completionPage(allowed: boolean): string {
  const title = allowed ? "Connected" : "Connection cancelled"
  return page(
    title,
    <CenteredCard
      product={PRODUCT}
      title={title}
      description={
        allowed
          ? "The simulated connection is ready. You can return to the app."
          : "No connection was created."
      }
      notice={NOTICE}
    >
      <div className="flex justify-center py-2">
        {allowed ? (
          <CircleCheck aria-hidden="true" className="size-10 text-success" />
        ) : (
          <CircleXmark aria-hidden="true" className="size-10 text-muted" />
        )}
      </div>
    </CenteredCard>,
  )
}
