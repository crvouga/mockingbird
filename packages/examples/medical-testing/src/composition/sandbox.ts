import { createSandbox, type SandboxOptions } from "@crvouga/mockingbird-preview"
import type { MockAdmin } from "../adapters/admin.js"
import { SYSTEM_SERVICES } from "./services.js"

/** Where the preview Worker serves the sandbox proxy (`src/worker.ts`). */
export const SANDBOX_PROXY_PATH = "/__sandbox"

/** The page that explains sandbox mode, linked from the System screen. */
export const SANDBOX_DOCS_URL =
  "https://github.com/crvouga-organization/mockingbird/blob/main/docs/SANDBOX_MODE.md"

/**
 * The browser half of sandbox mode: transports for the emulators to forward through, and the
 * System screen's service controls. The proxy holds the secrets; this side only ever holds the
 * per-viewer access key.
 */
export const createLabSandbox = (
  proxyUrl: string | undefined,
  /** Tests inject the proxy and a storage in place of the network and localStorage. */
  overrides: Pick<SandboxOptions, "fetch" | "storage"> = {},
) => {
  const sandbox = createSandbox({ ...overrides, ...(proxyUrl ? { proxyUrl } : {}) })
  return {
    upstream: proxyUrl ? (service: string) => sandbox.upstream(service) : undefined,
    controls: (admins: readonly MockAdmin[]) =>
      sandbox.controls(
        SYSTEM_SERVICES.flatMap((service) => {
          const admin = admins.find((candidate) => candidate.id === service.id)
          return admin
            ? [
                {
                  id: service.id,
                  label: service.label,
                  category: service.category,
                  admin: admin.fetch,
                  ...(service.unsupported ? { unsupported: service.unsupported } : {}),
                },
              ]
            : []
        }),
      ),
  }
}
