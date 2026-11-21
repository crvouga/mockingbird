/**
 * The pages the Fitbit emulator's `/oauth2/authorize` answers with when a request cannot be sent
 * back to the app at all (an unknown client, a redirect_uri it did not register, one that is not a
 * URL). Server-rendered with React and prebuilt into `dist-ui/server.js` (see
 * packages/ui/README.md, "Pages served as strings"), which `src/index.ts` imports lazily through
 * `#ui/server`, so React never loads on the Web API's path.
 */
import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { Alert } from "@heroui/react"

const PRODUCT = "Fitbit"
const NOTICE = "A Mockingbird emulator: no real account is used."

/** An authorize request that cannot continue, and why. */
export function authorizeErrorPage(message: string): string {
  return renderPage(
    <CenteredCard
      product={PRODUCT}
      notice={NOTICE}
      title="Authorization error"
      description="This sign-in request can't be sent back to the app."
    >
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title className="break-words">{message}</Alert.Title>
        </Alert.Content>
      </Alert>
    </CenteredCard>,
    { title: `Authorization error · ${PRODUCT}`, css: MOCKINGBIRD_CSS, rememberTheme: true },
  )
}
