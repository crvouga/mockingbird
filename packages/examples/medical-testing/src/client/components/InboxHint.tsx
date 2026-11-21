import { Alert, Button } from "@heroui/react"
import type { ReactNode } from "react"
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
  children: ReactNode
  label?: string
}) => (
  <Alert status="accent" role="status" data-testid="inbox-hint">
    <Alert.Indicator />
    <Alert.Content>
      <Alert.Description>{children}</Alert.Description>
      <div className="mt-2">
        <Button
          size="sm"
          variant="secondary"
          data-testid="open-inbox"
          onPress={() => openInbox(target)}
        >
          {label}
        </Button>
      </div>
    </Alert.Content>
  </Alert>
)
