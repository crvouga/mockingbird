import { api, type OAuthProvider, type OAuthStepResponse, type User } from "../api.js"
import { attachOAuthPage } from "../hostedPages.js"
import { HostedPageModal, type HostedStep } from "./HostedPageModal.js"

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", apple: "Apple" }

const toStep = (result: OAuthStepResponse): HostedStep<User> =>
  result.user ? { done: result.user } : { flowId: result.flowId, html: result.html }

/**
 * The identity provider's real hosted sign-in screen (account chooser → consent), with every
 * submit dispatched through the app's own server, which finishes the code flow with PKCE.
 */
export const OAuthModal = ({
  provider,
  onDone,
  onClose,
}: {
  provider: OAuthProvider
  onDone: (user: User) => void
  onClose: () => void
}) => (
  <HostedPageModal<User>
    title={`Signing in with ${PROVIDER_LABEL[provider]}`}
    regionLabel={`${PROVIDER_LABEL[provider]} sign-in`}
    flowKey={provider}
    start={async () => toStep(await api.oauthStart(provider))}
    step={async (flowId, action, method, body) =>
      toStep(await api.oauthStep(provider, flowId, action, method, body))
    }
    attach={attachOAuthPage}
    onDone={onDone}
    onClose={onClose}
  />
)
