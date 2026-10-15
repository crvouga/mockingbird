import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { serveTarget as postgres } from "@crvouga/mockingbird-service-postgres/server"
import { serveTarget as redis } from "@crvouga/mockingbird-service-redis/server"
import {
  FleetClient,
  filesystemRepository,
  type MockingbirdConfig,
  startFleet,
  validateArchive,
} from "@crvouga/mockingbird-service-stripe/fleet"
import { serveTarget as stripe } from "@crvouga/mockingbird-service-stripe/server"

if (!["linux", "darwin"].includes(process.platform) || !["arm64", "x64"].includes(process.arch))
  throw new Error(
    `unsupported fleet reference platform: ${process.platform}/${process.arch}; image supports linux/amd64 and linux/arm64`,
  )
const environment = process.env
const state = environment.FLEET_STATE_DIR ?? "/state"
await mkdir(state, { recursive: true, mode: 0o700 })
const adminKey = environment.MOCKINGBIRD_ADMIN_KEY
if (!adminKey)
  throw new Error(
    "MOCKINGBIRD_ADMIN_KEY is required; pass it at runtime, never bake it into the image",
  )
const config: MockingbirdConfig = environment.FLEET_CONFIG
  ? JSON.parse(await readFile(environment.FLEET_CONFIG, "utf8"))
  : {
      services: {
        stripe: { port: 9001, host: "0.0.0.0" },
        postgres: { port: 5432, host: "0.0.0.0", protocol: "postgres" },
        redis: { port: 6379, host: "0.0.0.0", protocol: "redis" },
      },
      control: { port: 9000, host: "0.0.0.0" },
    }
config.adminKey = adminKey
const repository = filesystemRepository(join(state, "backups"))
const inventory = { stripe, postgres, redis }
const fleet = await startFleet(config, {
  load: async (name) => {
    const target = inventory[name as keyof typeof inventory]
    if (!target)
      throw new Error(
        `missing service package ${name}; reference inventory contains stripe, postgres, redis`,
      )
    return target
  },
  repository,
  readyFile: join(state, "ready.json"),
  connectionsFile: join(state, "connections.json"),
  initialize: async ({ manifest }) => {
    const latest = await repository.latest()
    if (latest) {
      await new FleetClient(manifest.adminBase, { adminKey }).importArchive(
        await repository.get(latest),
      )
      console.log(JSON.stringify({ event: "restored", archive: latest }))
    }
  },
  beforeClose: async ({ manifest, capture }) => {
    const namespaces = await new FleetClient(manifest.adminBase, { adminKey }).request<{
      namespaces: { namespace: string }[]
    }>("namespaces")
    const archive = validateArchive(
      await capture(namespaces.namespaces.map((entry) => entry.namespace)),
    )
    const id = await repository.put(archive)
    await repository.publishLatest(id)
    console.log(JSON.stringify({ event: "shutdown-backup", status: "verified", archive: id }))
  },
  onReady: () =>
    console.log(JSON.stringify({ event: "ready", manifest: join(state, "ready.json") })),
})
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  try {
    await fleet.close()
    console.log(JSON.stringify({ event: "stopped", status: "success" }))
    process.exitCode = 0
  } catch {
    stopping = false
    console.error(
      JSON.stringify({
        event: "shutdown-backup",
        status: "failed",
        action: "fleet retained; resolve active work/storage failure, then signal again",
      }),
    )
  }
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
