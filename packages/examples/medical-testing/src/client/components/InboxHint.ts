import { html } from "htm/preact"
import type { ComponentChildren } from "preact"
import type { InboxTarget } from "../inbox.js"
import { openInbox } from "../inbox.js"

/**
 * "We sent you something" with the one thing a visitor to a demo needs next:
 * a button that opens that exact message. Nothing here leaves the page, so
 * the message is in the Notifications view, not in a real inbox.
 */
export const InboxHint = ({
  target,
  children,
  label = "Open Notifications",
}: {
  target: InboxTarget
  children: ComponentChildren
  label?: string
}) =>
  html`<div class="cove-inbox-hint" role="status" data-testid="inbox-hint"><p>${children}</p><button type="button" class="cove-btn cove-btn-ghost cove-btn-sm" data-testid="open-inbox" onClick=${() => openInbox(target)}>${label}</button></div>`
