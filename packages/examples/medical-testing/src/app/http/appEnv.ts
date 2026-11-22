import type { UserRow } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { IdentityProvider } from "../ports/identityProvider.js"
import type { LabTestingClient } from "../ports/labTestingClient.js"
import type { Notifier } from "../ports/notifier.js"
import type { PaymentsClient } from "../ports/paymentsClient.js"
import type { PhoneVerifier } from "../ports/phoneVerifier.js"

export type AppDeps = {
  db: Db
  payments: PaymentsClient
  labTesting: LabTestingClient
  identity: IdentityProvider
  notifier: Notifier
  phoneVerifier: PhoneVerifier
  /**
   * The page a sign-in link opens, when the app does not answer at an address of its own (it
   * runs inside a browser tab). The link is this URL with the token added.
   */
  signInPage?: string | undefined
}

export type AppEnv = {
  Variables: AppDeps & {
    user: UserRow | undefined
  }
}
