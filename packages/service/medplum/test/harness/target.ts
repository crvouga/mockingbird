/**
 * One side of a differential comparison — the self-hosted oracle or the mock — and the
 * project each scenario runs in, provisioned the same way on both sides: the super admin
 * client creates a Project, then a ClientApplication in it (`POST /admin/projects/:id/client`),
 * and the scenario authenticates as that client, exactly as a consumer backend would.
 */
import {
  MedplumAPI,
  type MedplumAPIOptions,
  SUPER_ADMIN_CLIENT_ID,
  SUPER_ADMIN_CLIENT_SECRET,
} from "../../src/index.js"

export type Target = {
  name: "oracle" | "mock"
  baseUrl: string
  fetch: (request: Request) => Promise<Response>
}

export const mockTarget = (options: MedplumAPIOptions = {}): Target & { api: MedplumAPI } => {
  const api = new MedplumAPI(options)
  return { name: "mock", baseUrl: api.baseUrl, fetch: (request) => api.fetch(request), api }
}

export type Project = {
  projectId: string
  clientId: string
  clientSecret: string
  /** Bearer token for the project client. */
  token: string
  /** Bearer token for the super admin client. */
  superToken: string
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString()

export const clientToken = async (
  target: Target,
  clientId: string,
  clientSecret: string,
): Promise<string> => {
  const response = await target.fetch(
    new Request(new URL("oauth2/token", target.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    }),
  )
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token)
    throw new Error(`${target.name}: client_credentials failed (${response.status})`)
  return body.access_token
}

/** Create a fresh project and client on `target`, through its public API. */
export const provisionProject = async (
  target: Target,
  name = "Parity Project",
): Promise<Project> => {
  const superToken = await clientToken(target, SUPER_ADMIN_CLIENT_ID, SUPER_ADMIN_CLIENT_SECRET)
  const auth = { authorization: `Bearer ${superToken}` }
  const projectResponse = await target.fetch(
    new Request(new URL("fhir/R4/Project", target.baseUrl), {
      method: "POST",
      headers: { ...auth, "content-type": "application/fhir+json" },
      body: JSON.stringify({ resourceType: "Project", name, strictMode: true }),
    }),
  )
  const project = (await projectResponse.json()) as { id?: string }
  if (!project.id)
    throw new Error(`${target.name}: creating a project failed (${projectResponse.status})`)
  const clientResponse = await target.fetch(
    new Request(new URL(`admin/projects/${project.id}/client`, target.baseUrl), {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: `${name} client` }),
    }),
  )
  const client = (await clientResponse.json()) as { id?: string; secret?: string }
  if (!client.id || !client.secret)
    throw new Error(`${target.name}: creating a client failed (${clientResponse.status})`)
  return {
    projectId: project.id,
    clientId: client.id,
    clientSecret: client.secret,
    token: await clientToken(target, client.id, client.secret),
    superToken,
  }
}
