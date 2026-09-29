import type { FaultPreset } from "@crvouga/mockingbird-service"

/** Explicit scenarios, not automatic capacity management or real gateway state. */
export const presets: Record<string, FaultPreset> = {
  hermes_submit_accepted_drop: {
    description: "Admit one new run, then lose the response; retry with the same key to recover",
    rules: [{ operationId: "RunCreate", count: 1, effect: "hermes.accepted_drop" }],
  },
  hermes_poll_timeout: {
    description: "Delay one poll by 1000ms to exercise a shorter client deadline",
    rules: [{ operationId: "RunGet", count: 1, delayMs: 1000 }],
  },
  hermes_throttled: {
    description: "Reject one submission with the pinned default-capacity throttle envelope",
    rules: [
      {
        operationId: "RunCreate",
        count: 1,
        status: 429,
        headers: { "Retry-After": "1" },
        body: {
          error: {
            message: "Too many concurrent runs (max 10)",
            type: "rate_limit_error",
            param: null,
            code: "rate_limit_exceeded",
          },
        },
      },
    ],
  },
  hermes_draining: {
    description: "Reject one submission with the pinned gateway-draining envelope",
    rules: [
      {
        operationId: "RunCreate",
        count: 1,
        status: 503,
        headers: { "Retry-After": "1" },
        body: {
          error: {
            message: "Gateway is draining existing work; retry shortly.",
            type: "invalid_request_error",
            param: null,
            code: "gateway_draining",
          },
        },
      },
    ],
  },
}
