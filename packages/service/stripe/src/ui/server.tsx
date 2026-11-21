/**
 * The emulator's own "not found" page, for a Checkout or Customer Portal link whose session it
 * does not know. (Checkout, the portal and Elements imitate Stripe's own UI and are drawn
 * elsewhere.) Server-rendered with React and prebuilt into `dist-ui/server.js` (see
 * packages/ui/README.md, "Pages served as strings"), which `src/browser.ts` imports lazily
 * through `#ui/server`, so React never loads on the API's path.
 */
import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"

const PRODUCT = "Stripe"
const NOTICE = "A Mockingbird emulator: no real account is used."

/** A hosted-page link whose session the emulator does not know, and why. */
export function notFoundPage(message: string): string {
  return renderPage(
    <CenteredCard product={PRODUCT} notice={NOTICE} title="Not found">
      <p className="text-sm text-muted" data-testid="stripe-mock-not-found">
        {message}
      </p>
    </CenteredCard>,
    { title: `Not found · ${PRODUCT}`, css: MOCKINGBIRD_CSS, rememberTheme: true },
  )
}
