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
}

export type AppEnv = {
  Variables: AppDeps & {
    user: UserRow | undefined
  }
}
