import { Card } from "@heroui/react"
import type { ReactNode } from "react"
import { Brand } from "./brand.js"

export type CenteredCardProps = {
  /** The page's question or purpose: "Sign in to Acme", "Allow access?", "Pair a device". */
  title: ReactNode
  description?: ReactNode
  /** The form or content. */
  children?: ReactNode
  /** Under the content, inside the card: secondary actions, a cancel link. */
  footer?: ReactNode
  /** The emulated product beside the brand ("Google", "Open Wearables"). */
  product?: ReactNode
  /** Under the card, outside it: a note that this is an emulator, links. */
  notice?: ReactNode
  /** Card width. Default "md" (28rem). */
  size?: "sm" | "md" | "lg"
}

const WIDTH = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-xl" } as const

/**
 * A single-purpose page (sign-in, consent, device pairing, an error): the brand above one card,
 * centered on the screen. Server-render it with a plain `<form method="post">` inside, and it
 * works without JavaScript.
 */
export function CenteredCard({
  title,
  description,
  children,
  footer,
  product,
  notice,
  size = "md",
}: CenteredCardProps) {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-10 text-foreground"
      data-mockingbird-centered
    >
      <Brand product={product} />
      <Card className={`w-full ${WIDTH[size]}`}>
        <Card.Header>
          {/* The page's one heading, so it is an h1 (Card.Title defaults to h3). */}
          <Card.Title className="text-lg font-semibold" render={(props) => <h1 {...props} />}>
            {title}
          </Card.Title>
          {description ? <Card.Description>{description}</Card.Description> : null}
        </Card.Header>
        {children ? <Card.Content className="gap-3">{children}</Card.Content> : null}
        {footer ? <Card.Footer className="flex-wrap gap-2">{footer}</Card.Footer> : null}
      </Card>
      {notice ? (
        <div className={`w-full ${WIDTH[size]} text-center text-xs text-muted`}>{notice}</div>
      ) : null}
    </div>
  )
}
