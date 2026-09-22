/// <reference types="node" />
import { type Listening, listen, type ServeTarget } from "@crvouga/mockingbird-adapter-node"
import { createRuntime, type MedplumRuntime, type MedplumRuntimeOptions } from "./runtime.js"

/** Port `mockingbird-medplum serve` listens on when none is given (Medplum's own default). */
export const DEFAULT_PORT = 8103

export type MedplumServerOptions = Omit<MedplumRuntimeOptions, "baseUrl"> & {
  /** Default `0`: the OS picks a free port (read it from `url` / `port`). */
  port?: number
  /** Default `127.0.0.1`. */
  host?: string
  /**
   * The public base URL the server answers as (`fullUrl`s, `Location`, token issuer).
   * Default: the listening address.
   */
  baseUrl?: string
}

export type MedplumServer = Listening & { runtime: MedplumRuntime }

/**
 * Serve the Medplum mock over `node:http`. Resolves once it is listening.
 *
 *   const server = await createServer()
 *   const medplum = new MedplumClient({ baseUrl: `${server.url}/` })
 */
export const createServer = async (options: MedplumServerOptions = {}): Promise<MedplumServer> => {
  const { port, host, baseUrl, ...rest } = options
  let runtime: MedplumRuntime | undefined
  let resolvedBase = baseUrl
  const listening = await listen(
    { fetch: (request) => (runtime as MedplumRuntime).fetch(request) },
    { port: port ?? 0, ...(host !== undefined ? { host } : {}) },
  )
  resolvedBase ??= `${listening.url}/`
  runtime = createRuntime({ ...rest, baseUrl: resolvedBase })
  return { ...listening, runtime }
}

const text = (value: string | boolean | undefined) =>
  typeof value === "string" && value !== "" ? value : undefined

/** How `serve` (and `serve --config`) builds the Medplum mock from flags. */
export const serveTarget: ServeTarget = {
  name: "medplum",
  defaultPort: DEFAULT_PORT,
  options: {
    "base-url": {
      type: "string",
      value: "<url>",
      description: "Public base URL the server answers as (default http://127.0.0.1:<port>/)",
    },
    "client-id": {
      type: "string",
      value: "<uuid>",
      description: "The default project's ClientApplication id",
    },
    "client-secret": {
      type: "string",
      value: "<secret>",
      description: "The default project's ClientApplication secret",
    },
    "project-id": { type: "string", value: "<uuid>", description: "The default project's id" },
    "super-admin-email": {
      type: "string",
      value: "<email>",
      description: "The seeded super admin's email",
    },
    "super-admin-password": {
      type: "string",
      value: "<password>",
      description: "The seeded super admin's password",
    },
  },
  create: (values, common) => {
    const port = text(values.port) ?? String(DEFAULT_PORT)
    const host = text(values.host) ?? "127.0.0.1"
    const clientId = text(values["client-id"])
    const clientSecret = text(values["client-secret"])
    const projectId = text(values["project-id"])
    const email = text(values["super-admin-email"])
    const password = text(values["super-admin-password"])
    return createRuntime({
      baseUrl: text(values["base-url"]) ?? `http://${host}:${port}/`,
      ...(clientId || clientSecret || projectId
        ? {
            project: {
              ...(clientId ? { clientId } : {}),
              ...(clientSecret ? { clientSecret } : {}),
              ...(projectId ? { id: projectId } : {}),
            },
          }
        : {}),
      ...(email || password
        ? { superAdmin: { ...(email ? { email } : {}), ...(password ? { password } : {}) } }
        : {}),
      ...(common.adminKey !== undefined ? { adminKey: common.adminKey } : {}),
      ...(common.seed !== undefined ? { seed: common.seed } : {}),
      ...(common.onLog ? { onLog: common.onLog } : {}),
    })
  },
  banner: (runtime) => {
    const info = (runtime as MedplumRuntime).instance().describe()
    return [
      "routes: /fhir/R4/…, /oauth2/token, /auth/login, /auth/me, /admin/projects/…, /healthcheck",
      `client credentials: ${info.project?.clientId} / ${info.project?.clientSecret} (project ${info.project?.id})`,
      `super admin: ${info.superAdmin.email} / ${info.superAdmin.password}`,
      "namespaces: x-mockingbird-namespace, /ns/<name>/…, or PUT /__admin/credentials {<clientId>: <ns>}",
    ]
  },
}
