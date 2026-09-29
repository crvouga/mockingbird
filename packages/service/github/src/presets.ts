import type { FaultPreset, FaultRule } from "@crvouga/mockingbird-service"

const mutations = ["git/create-ref", "git/update-ref", "pulls/create", "pulls/update"]
const reject = (rule: Omit<FaultRule, "id" | "operationId">) =>
  mutations.map((operationId) => ({ operationId, count: 1, ...rule }))
const acceptedDrop = (operationId: string): FaultPreset => ({
  description: `Accept one successful ${operationId} mutation, then drop its response`,
  rules: [{ operationId, count: 1, effect: "github.accepted_drop" }],
})

/** Scripted observations only; no credentials, authorization, branch rules or quota engine. */
export const presets: Record<string, FaultPreset> = {
  github_pr_create_accepted_drop: acceptedDrop("pulls/create"),
  github_pr_update_accepted_drop: acceptedDrop("pulls/update"),
  github_ref_create_accepted_drop: acceptedDrop("git/create-ref"),
  github_ref_update_accepted_drop: acceptedDrop("git/update-ref"),
  github_unavailable: {
    description: "Reject one request per supported mutation operation before writing, with503",
    rules: reject({
      status: 503,
      body: {
        message: "Service Unavailable",
        documentation_url:
          "https://docs.github.com/rest/using-the-rest-api/troubleshooting-the-rest-api",
        status: "503",
      },
    }),
  },
  github_denied: {
    description:
      "Script one integration-denied403 per supported mutation operation; no policy evaluation",
    rules: reject({
      status: 403,
      body: {
        message: "Resource not accessible by integration",
        documentation_url:
          "https://docs.github.com/rest/using-the-rest-api/troubleshooting-the-rest-api#resource-not-accessible",
        status: "403",
      },
    }),
  },
  github_rate_limited: {
    description: "Script one secondary-limit429 per mutation operation, with a60second retry hint",
    rules: reject({
      status: 429,
      headers: {
        "Retry-After": "60",
        "X-RateLimit-Remaining": "1",
        "X-RateLimit-Resource": "core",
      },
      body: {
        message:
          "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        documentation_url:
          "https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit",
        status: "429",
      },
    }),
  },
}
