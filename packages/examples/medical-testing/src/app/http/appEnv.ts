import type { UserRow } from "../db/usersRepo.js"
import type { Db } from "../ports/db.js"
import type { IdentityProvider } from "../ports/identityProvider.js"
import type { LabTestingClient } from "../ports/labTestingClient.js"
import type { PaymentsClient } from "../ports/paymentsClient.js"

export type AppDeps = {
  db: Db
  payments: PaymentsClient
  labTesting: LabTestingClient
  identity: IdentityProvider
}

export type AppEnv = {
  Variables: AppDeps & {
    user: UserRow | undefined
  }
}
