import { api, type HostedCheckoutStepResponse } from "../api.js"
import { attachCheckoutPage } from "../hostedPages.js"
import { HostedPageModal, type HostedStep } from "./HostedPageModal.js"

const toStep = (result: HostedCheckoutStepResponse): HostedStep<true> =>
  result.done ? { done: true } : { flowId: result.flowId, html: result.html }

/**
 * The payments provider's real hosted checkout page, driven like `OAuthModal`. When it redirects
 * back to the app, payment is done; fulfillment lands separately, via a webhook.
 */
export const CheckoutModal = ({
  checkoutSessionId,
  onDone,
  onClose,
}: {
  checkoutSessionId: string
  onDone: () => void
  onClose: () => void
}) => (
  <HostedPageModal<true>
    title="Checkout"
    regionLabel="Payment"
    flowKey={checkoutSessionId}
    start={async () => toStep(await api.hostedCheckoutStart(checkoutSessionId))}
    step={async (flowId, action, method, body) =>
      toStep(await api.hostedCheckoutStep(flowId, action, method, body))
    }
    attach={attachCheckoutPage}
    onDone={() => onDone()}
    onClose={onClose}
  />
)
