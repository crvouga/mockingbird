/**
 * A ready-made preview Worker module: use `node_modules/@crvouga/mockingbird-preview/dist/worker-entry.js`
 * as a wrangler config's `main` (or `mockingbird-preview wrangler-config` writes it for you).
 */
import { createPreviewWorker } from "./worker.js"

export default createPreviewWorker()
