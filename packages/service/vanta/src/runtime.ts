import {
  bearerToken,
  type Clock,
  createRuntime as createServiceRuntime,
  type FaultPreset,
  type MockControls,
  type RequestLog,
  type ServiceRuntime,
} from "@crvouga/mockingbird-service"
import { document } from "./generated/openapi.js"
import { VANTA_NAMESPACE, VantaAPI, type VantaAPIOptions } from "./index.js"
export const VANTA_PRESETS: Record<string, FaultPreset> = {
  unauthorized_once: {
    description: "Force reauthentication on a read",
    rules: [
      {
        operationId: "ListPeople",
        status: 401,
        body: "Unauthorized",
        headers: { "content-type": "application/json" },
        count: 1,
      },
    ],
  },
  rate_limited: {
    description: "Scripted throttle",
    rules: [
      { status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "1" } },
    ],
  },
  server_error: {
    description: "Transient error",
    rules: [{ status: 503, body: { message: "Service unavailable" } }],
  },
  upload_failed: {
    description: "Multipart failure before mutation",
    rules: [
      { operationId: "UploadFileForDocument", status: 500, body: { message: "Upload failed" } },
    ],
  },
  submit_failed: {
    description: "Submission failure before mutation",
    rules: [
      { operationId: "SubmitDocumentCollection", status: 500, body: { message: "Submit failed" } },
    ],
  },
  connection_drop: { description: "Dropped connection", rules: [{ drop: true }] },
}
export type VantaRuntimeOptions = Omit<VantaAPIOptions, "now" | "namespace"> & {
  clock?: Clock
  seed?: string | number
  adminPrefix?: string
  adminKey?: string
  /** Admin controls to boot with: clock, latency, faults, seed, a starting snapshot. */
  adminControls?: MockControls
  onLog?: (entry: RequestLog) => void
}
export type VantaRuntime = ServiceRuntime<VantaAPI>
export const createRuntime = (options: VantaRuntimeOptions = {}): VantaRuntime =>
  createServiceRuntime({
    name: VANTA_NAMESPACE,
    document,
    presets: VANTA_PRESETS,
    credential: bearerToken,
    ...(options.sqlite ? { sqlite: options.sqlite } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.adminPrefix ? { adminPrefix: options.adminPrefix } : {}),
    ...(options.adminKey ? { adminKey: options.adminKey } : {}),
    ...(options.adminControls !== undefined ? { adminControls: options.adminControls } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    create: ({ sqlite, namespace, clock }) =>
      new VantaAPI({ ...options, sqlite, namespace, now: clock.now }),
  })
