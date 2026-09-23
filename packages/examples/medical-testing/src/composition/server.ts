import { buildApp } from "./build.js"
import { buildClientAssets } from "./buildClientAssets.js"

const PORT = Number(process.env.PORT ?? 4300)

export const runStandaloneServer = async (): Promise<void> => {
  const assets = await buildClientAssets()
  const app = await buildApp(assets)
  Bun.serve({ port: PORT, fetch: app.fetch })
  console.log(`Cove is running at http://localhost:${PORT}`)
}
