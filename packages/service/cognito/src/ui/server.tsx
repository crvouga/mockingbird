/**
 * The Cognito hosted UI's pages: the account picker that stands in for the pool's (or a federated
 * provider's) sign-in page, and the hosted UI's `/error` page. Server-rendered with React into
 * complete HTML (every form posts without JavaScript) and prebuilt into `dist-ui/server.js` (see
 * packages/ui/README.md, "Pages served as strings"), which `src/hosted-ui.ts` imports lazily
 * through `#ui/server`, so React never loads on the user-pool API or token path.
 *
 * Each function returns the document only; `src/hosted-ui.ts` wraps it in the Response with its
 * status, Content-Security-Policy (the `nonce` here) and cache headers.
 */
import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { ArrowRight } from "@gravity-ui/icons"
import { Alert, Avatar, Button } from "@heroui/react"
import type { ReactNode } from "react"

const PRODUCT = "Amazon Cognito"
const NOTICE = "A Mockingbird emulator: no real account is used."

const document = (title: string, nonce: string, element: ReactNode): string =>
  renderPage(element, {
    title: `${title} · ${PRODUCT}`,
    css: MOCKINGBIRD_CSS,
    nonce,
    rememberTheme: true,
  })

/** A user-pool account the picker offers. */
export type PickerAccount = { username: string; email?: string | undefined }

export type PickerPageProps = {
  /** Where every form posts: `{base}/oauth2/idpresponse`. */
  action: string
  transaction: string
  /** `COGNITO`, or the federated provider the app asked for. */
  provider: string
  accounts: readonly PickerAccount[]
  nonce: string
}

const Transaction = ({ value }: { value: string }) => (
  <input type="hidden" name="transaction" value={value} />
)

/** The account picker: one form per account, and Cancel. */
export function pickerPage(props: PickerPageProps): string {
  const { action, transaction, provider, accounts, nonce } = props
  return document(
    "Choose an account",
    nonce,
    <CenteredCard
      product={PRODUCT}
      notice={NOTICE}
      title={provider === "COGNITO" ? "Sign in" : `Continue with ${provider} (emulated)`}
      description="Choose a user-pool account to sign in as."
      footer={
        <form method="post" action={action} className="w-full">
          <Transaction value={transaction} />
          <Button
            type="submit"
            name="action"
            value="cancel"
            variant="ghost"
            fullWidth
            data-testid="cognito-hosted-cancel"
          >
            Cancel
          </Button>
        </form>
      }
    >
      {accounts.length ? (
        <ul className="flex flex-col gap-2" aria-label="Accounts">
          {accounts.map((account) => (
            <li key={account.username}>
              <form method="post" action={action}>
                <Transaction value={transaction} />
                <Button
                  type="submit"
                  name="username"
                  value={account.username}
                  variant="secondary"
                  fullWidth
                  className="h-auto justify-start gap-3 py-2 text-left"
                  data-testid="cognito-hosted-account"
                  data-username={account.username}
                >
                  <Avatar size="sm">
                    <Avatar.Fallback>{account.username.slice(0, 1).toUpperCase()}</Avatar.Fallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium break-words text-foreground">
                      {account.username}
                    </span>
                    {account.email ? (
                      <span className="truncate text-xs text-muted">{account.email}</span>
                    ) : null}
                  </span>
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          No users in this pool. Seed one with POST /__admin/users.
        </p>
      )}
    </CenteredCard>,
  )
}

/** Cognito's hosted-UI error page, in Cognito's words, with the error code under it. */
export function errorPage(error: string, description: string, nonce: string): string {
  return document(
    "Error",
    nonce,
    <CenteredCard
      product={PRODUCT}
      notice={NOTICE}
      title="An error was encountered with the requested page."
    >
      <Alert status="danger" role="alert">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title className="break-words">
            <span data-testid="cognito-hosted-error">
              {description ? `${error}: ${description}` : error}
            </span>
          </Alert.Title>
        </Alert.Content>
      </Alert>
    </CenteredCard>,
  )
}
