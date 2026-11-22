import { devPreview } from "@crvouga/mockingbird-preview/dev-server"
import { DEV_PROXY_BASE_PATH, devProxy } from "../src/devProxy.ts"
import { previewOptions } from "./preview-options.ts"

/**
 * The lab's preview while you work on it: built in memory, rebuilt on save, and swapped into
 * every open tab in place. The dev resources proxy answers at `/__dev` with the non-production
 * keys in `.env.local`, as the deployed preview Worker does with its secrets.
 *
 *   bun scripts/dev-preview.ts [--port=<n>] [--host=<name>] [--strict-port]
 */
const flag = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const port = flag("port")
const hostname = flag("host")

const preview = await devPreview({
  ...previewOptions,
  ...(port === undefined ? {} : { port: Number(port) }),
  ...(hostname === undefined ? {} : { hostname }),
  strictPort: process.argv.includes("--strict-port"),
  fetch: (request) => {
    const { pathname } = new URL(request.url)
    return pathname === DEV_PROXY_BASE_PATH || pathname.startsWith(`${DEV_PROXY_BASE_PATH}/`)
      ? devProxy.fetch(request, process.env)
      : undefined
  },
})

const stop = () => void preview.close().then(() => process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
