import { HOSTING_CONTRACT, INVENTORY_URL, json, request } from "./io.ts"

export type HostedService = {
  id: string
  kind: string
  hostname: string
  github_repo: string
  dockerfile: string
  build_context: string
  port: number
  health_check: boolean
  health_path?: string
}
export async function loadHosting(): Promise<HostedService> {
  const contract = await request(HOSTING_CONTRACT)
  if (!contract.ok) throw new Error(`Hosting contract HTTP ${contract.status}`)
  if (!(await contract.text()).includes("mockingbird-docs"))
    throw new Error("Fresh hosting contract does not list mockingbird-docs")
  const inventory = await json<{ locals?: { inventory?: { services?: HostedService[] } } }>(
    INVENTORY_URL,
  )
  const service = inventory.locals?.inventory?.services?.find(
    (entry) => entry.id === "mockingbird-docs",
  )
  if (!service?.hostname)
    throw new Error("mockingbird-docs is absent from the authoritative OpenTofu inventory")
  return service
}
