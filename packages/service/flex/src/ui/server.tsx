/**
 * The hosted HSA/FSA checkout as the emulator serves it (`/pay/:session`): the card form, the
 * letter-of-medical-necessity step, a session that can no longer be paid, and an unknown one.
 * Server-rendered with React into complete HTML (every form posts without JavaScript) and
 * prebuilt into `dist-ui/server.js` (see packages/ui/README.md, "Pages served as strings"), which
 * `src/hosted.ts` imports lazily through `#ui/server`, so React never loads on the payments API's
 * path.
 */
import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { Alert, Button, buttonVariants, Input, Label, TextField } from "@heroui/react"
import type { ReactNode } from "react"

const PRODUCT = "Flex"
const NOTICE = "A Mockingbird emulator: no real account is used."

const document = (title: string, element: ReactNode): string =>
  renderPage(element, {
    title: `${title} · ${PRODUCT}`,
    css: MOCKINGBIRD_CSS,
    rememberTheme: true,
  })

/** What the checkout pages show of a session. */
export type CheckoutView = {
  sessionId: string
  mode: string
  /** Cents. */
  amountTotal: number
  /** "month", "3 months": how often a subscription bills. */
  interval?: string | undefined
  productNames: readonly string[]
  /** The "Cancel and return" link, when the session has a `cancel_url`. */
  cancelHref?: string | undefined
  error?: string | undefined
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

/** The total (or what setup mode does) and the line items. */
function Summary({ view }: { view: CheckoutView }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <p
        className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted"
        data-testid="flex-mock-session"
        data-session-id={view.sessionId}
        data-mode={view.mode}
      >
        {view.mode === "setup" ? (
          "Save a card for future payments"
        ) : (
          <>
            Total
            <strong
              className="text-lg font-semibold text-foreground"
              data-testid="flex-mock-amount"
            >
              {dollars(view.amountTotal)}
            </strong>
            {view.mode === "subscription" && view.interval ? (
              <span data-testid="flex-mock-interval">{`per ${view.interval}`}</span>
            ) : null}
          </>
        )}
      </p>
      {view.productNames.length ? (
        <ul className="flex flex-col gap-1 text-sm text-foreground" aria-label="Items">
          {view.productNames.map((name, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static page, names may repeat.
            <li key={index} data-testid="flex-mock-line-item" className="break-words">
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const FormError = ({ message }: { message: string | undefined }) =>
  message ? (
    <Alert status="danger" role="alert" data-testid="flex-mock-error">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title className="break-words">{message}</Alert.Title>
      </Alert.Content>
    </Alert>
  ) : null

const CancelLink = ({ href }: { href: string | undefined }) =>
  href ? (
    <a
      data-testid="flex-mock-cancel"
      href={href}
      className={buttonVariants({ variant: "ghost", fullWidth: true })}
    >
      Cancel and return
    </a>
  ) : null

function Field(props: {
  name: string
  label: string
  testId: string
  autoComplete: string
  placeholder: string
  type?: "email" | "tel"
  inputMode?: "numeric"
}) {
  return (
    <TextField name={props.name} type={props.type ?? "text"} fullWidth className="min-w-0">
      <Label>{props.label}</Label>
      <Input
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        data-testid={props.testId}
        {...(props.inputMode ? { inputMode: props.inputMode } : {})}
      />
    </TextField>
  )
}

const heading = (view: CheckoutView) =>
  view.mode === "subscription" ? "Subscribe with HSA/FSA" : "Pay with HSA/FSA"

/** The card form: contact fields, then the card, then Pay. */
export function cardPage(view: CheckoutView): string {
  return document(
    "Checkout",
    <CenteredCard
      product={PRODUCT}
      notice={NOTICE}
      title={heading(view)}
      footer={view.cancelHref ? <CancelLink href={view.cancelHref} /> : undefined}
    >
      <Summary view={view} />
      <FormError message={view.error} />
      <form method="post" data-testid="flex-mock-form" className="flex flex-col gap-3">
        <input type="hidden" name="step" value="card" />
        <Field
          name="email"
          label="Email"
          type="email"
          autoComplete="email"
          placeholder="Email"
          testId="flex-mock-email"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            name="firstName"
            label="First name"
            autoComplete="given-name"
            placeholder="First Name"
            testId="flex-mock-first-name"
          />
          <Field
            name="lastName"
            label="Last name"
            autoComplete="family-name"
            placeholder="Last Name"
            testId="flex-mock-last-name"
          />
        </div>
        <Field
          name="phone"
          label="Phone"
          type="tel"
          autoComplete="tel"
          placeholder="Phone"
          testId="flex-mock-phone"
        />
        <Field
          name="cardNumber"
          label="Card number"
          inputMode="numeric"
          autoComplete="cc-number"
          placeholder="Card number"
          testId="flex-mock-card"
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            name="expiry"
            label="Expiration (MM/YY)"
            autoComplete="cc-exp"
            placeholder="MM / YY"
            testId="flex-mock-exp"
          />
          <Field
            name="cvc"
            label="CVC"
            autoComplete="cc-csc"
            placeholder="CVC"
            testId="flex-mock-cvc"
          />
        </div>
        <Field
          name="postalCode"
          label="ZIP"
          autoComplete="postal-code"
          placeholder="ZIP"
          testId="flex-mock-zip"
        />
        <Button type="submit" fullWidth className="mt-1" data-testid="flex-mock-pay">
          {view.mode === "setup" ? "Save card" : "Pay"}
        </Button>
      </form>
    </CenteredCard>,
  )
}

/** The next-action step that asks for a letter of medical necessity. */
export function letterPage(view: CheckoutView): string {
  return document(
    "Letter of medical necessity",
    <CenteredCard
      product={PRODUCT}
      notice={NOTICE}
      title={heading(view)}
      footer={view.cancelHref ? <CancelLink href={view.cancelHref} /> : undefined}
    >
      <Summary view={view} />
      <FormError message={view.error} />
      <p className="text-sm text-foreground" data-testid="flex-mock-lmn">
        One of these items needs a letter of medical necessity. Answer the short questionnaire to
        finish paying.
      </p>
      <form method="post" data-testid="flex-mock-lmn-form">
        <input type="hidden" name="step" value="lmn" />
        <Button type="submit" fullWidth data-testid="flex-mock-lmn-submit">
          Submit questionnaire and pay
        </Button>
      </form>
    </CenteredCard>,
  )
}

/** A session that can no longer be paid (complete, expired, canceled). */
export function closedPage(status: string): string {
  return document(
    "Checkout",
    <CenteredCard product={PRODUCT} notice={NOTICE} title={`This checkout is ${status}`}>
      <p className="text-sm text-muted" data-testid="flex-mock-closed" data-status={status}>
        Nothing more to pay here.
      </p>
    </CenteredCard>,
  )
}

/** No session has this id. */
export function notFoundPage(): string {
  return document(
    "Checkout not found",
    <CenteredCard product={PRODUCT} notice={NOTICE} title="Checkout not found">
      <p className="text-sm text-muted" data-testid="flex-mock-not-found">
        This link is invalid.
      </p>
    </CenteredCard>,
  )
}
