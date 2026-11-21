import { createPreviewClient } from "./bridge.js"
import { type createPreviewHost, sharedPreviewWorkerName } from "./host.js"

export function connectSharedPreviewWorker(
  url: string | URL,
  options: { application: string; artifact: string; generation: number; timeoutMs?: number },
) {
  const worker = new SharedWorker(url, { type: "module", name: sharedPreviewWorkerName(options) })
  const client = createPreviewClient(
    worker.port,
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  )
  const failed = () => client.dispose()
  worker.addEventListener("error", failed)
  return {
    fetch: client.fetch,
    get pending() {
      return client.pending
    },
    worker,
    dispose: () => {
      worker.removeEventListener("error", failed)
      client.dispose()
    },
  }
}

export function connectDedicatedPreviewWorker(
  url: string | URL,
  options: { timeoutMs?: number } = {},
) {
  const worker = new Worker(url, { type: "module" })
  const channel = new MessageChannel()
  const client = createPreviewClient(channel.port1, options)
  const failed = () => client.dispose()
  worker.addEventListener("error", failed)
  worker.postMessage({ type: "mockingbird-preview-connect" }, [channel.port2])
  return {
    fetch: client.fetch,
    get pending() {
      return client.pending
    },
    worker,
    dispose: () => {
      worker.removeEventListener("error", failed)
      client.dispose()
      worker.terminate()
    },
  }
}

type WorkerScope = {
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void
  removeEventListener: (type: string, listener: (event: MessageEvent) => void) => void
}
/** Installs shared-worker connect events or dedicated-worker transferred-port handshakes. */
export function installPreviewWorkerHost(
  host: ReturnType<typeof createPreviewHost>,
  scope: WorkerScope,
) {
  const shared = (event: MessageEvent) => {
    for (const port of event.ports) host.connect(port)
  }
  const dedicated = (event: MessageEvent) => {
    if (event.data?.type === "mockingbird-preview-connect") shared(event)
  }
  scope.addEventListener("connect", shared)
  scope.addEventListener("message", dedicated)
  return async () => {
    scope.removeEventListener("connect", shared)
    scope.removeEventListener("message", dedicated)
    await host.dispose()
  }
}
