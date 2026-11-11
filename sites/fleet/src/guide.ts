import type { Config } from "./config.js"
import type { RouteDoc } from "./openapi.js"

/**
 * `/llms.txt`: what an agent integrating another application needs, generated from the live
 * route table and this server's configuration so it cannot drift from either.
 */
export function agentGuide(
  config: Pick<Config, "publicUrl" | "fleetUrl" | "limits" | "rateLimits" | "operatorTokenHash">,
  routes: readonly RouteDoc[],
): string {
  const api = `${config.publicUrl}/api/v1`
  const show = (value: number) => (value === 0 ? "unlimited" : String(value))
  const groups = new Map<string, string[]>()
  for (const route of routes)
    groups.set(route.tag, [
      ...(groups.get(route.tag) ?? []),
      `- ${route.method} ${route.path} — ${route.summary}`,
    ])
  return `# Mockingbird Fleet

> Hosted fleets of stateful vendor-API emulators (Stripe, S3, Twilio, …) at stable URLs. Create a fleet, add emulators, point each vendor SDK's base URL at its emulator. State is kept in object storage.

API base: ${api}
OpenAPI 3.1: ${config.publicUrl}/api/openapi.json
Emulator catalog: GET ${api}/catalog (no auth)

## Authenticate

Send \`Authorization: Bearer <credential>\`.

- Personal token \`mbf_u_…\`: acts as a user. A person creates one in the dashboard (Account → Personal tokens).${config.operatorTokenHash ? " The operator can also issue one with POST /admin/users." : ""}
- Organization key \`mbf_o_…\` / project key \`mbf_p_…\`: created with POST /orgs/{orgId}/api-keys. Use these in CI.

## Configure it with one file (the prescribed way)

Commit a \`mockingbird.yaml\` and apply it. The same file runs the fleet locally.

\`\`\`yaml
version: 1
organization: acme
projects:
  web:
    fleets:
      acme-staging:
        access: open
        services:
          stripe: { durability: strict }
          resend: {}
          db: { target: postgres, protocol: postgres, local: true }   # local fleets only
\`\`\`

\`\`\`sh
# Plan (changes nothing), then apply. Add &prune=true to delete what the file no longer declares.
curl -X PUT "${api}/manifest?dryRun=true" -H "Authorization: Bearer $MOCKINGBIRD_FLEET_TOKEN" -H 'content-type: application/yaml' --data-binary @mockingbird.yaml
curl -X PUT "${api}/manifest" -H "Authorization: Bearer $MOCKINGBIRD_FLEET_TOKEN" -H 'content-type: application/yaml' --data-binary @mockingbird.yaml
# Or: npx mockingbird-fleet plan | apply   (MOCKINGBIRD_FLEET_URL=${config.publicUrl})
# Locally, same file: npx mockingbird-fleet serve --config mockingbird.yaml
\`\`\`

- The first apply needs a personal token (it creates the organization); later ones can use an admin API key.
- The file is the whole truth for projects, fleets and emulators. Once applied, hand edits of them answer 409 managed_by_declaration.
- GET /orgs/{orgId}/manifest returns any organization as a mockingbird.yaml to start from.
- Errors name the path of the key: \`projects.web.fleets.acme-staging.services.stripe.durability: must be one of strict, buffered, ephemeral\`.

## Quickstart, one call at a time

\`\`\`sh
API=${api}
AUTH="Authorization: Bearer $MOCKINGBIRD_FLEET_TOKEN"
ORG=$(curl -fsS -H "$AUTH" -H 'content-type: application/json' -d '{"name":"Acme"}' $API/orgs | jq -r .id)
PROJECT=$(curl -fsS -H "$AUTH" -H 'content-type: application/json' -d '{"name":"Web"}' $API/orgs/$ORG/projects | jq -r .id)
curl -fsS -H "$AUTH" -H 'content-type: application/json' $API/projects/$PROJECT/fleets -d '{
  "name": "Staging", "slug": "acme-staging",
  "emulators": { "stripe": { "target": "stripe", "durability": "strict" } }
}'
# Then use ${config.fleetUrl}/f/acme-staging/stripe as the Stripe SDK's base URL.
\`\`\`

A fleet slug is permanent, so its URLs are stable. Creating with a slug that exists returns 409: treat that as "already created" and GET it.

## Durability (per emulator)

- strict: answered only after the state is committed to object storage. Slowest; nothing acknowledged is lost.
- buffered (default): answered from memory, saved about 2 s later and at shutdown. A crash loses the last seconds.
- ephemeral: memory only.

Change it with PATCH /fleets/{fleetId}/emulators/{name} {"durability": "strict"}.

## Calling emulators

- \`${config.fleetUrl}/f/<fleet>/<emulator>/<vendor path>\`. Send the vendor's own auth header; emulators accept any vendor key.
- A fleet with access "key" also needs \`x-mockingbird-api-key: <mbf_… key>\`.
- Each emulator's control routes (\`/__admin/*\`: reset, seed, clock, faults) always need \`x-mockingbird-api-key\` with a member key.

## Errors

Every error is \`{"error": {"code", "message", "details"?}}\`; \`message\` says what to do. Every response carries \`x-request-id\`.

- 400 invalid_request — \`details\` lists each invalid field.
- 401 unauthorized — missing, malformed, expired or revoked credential.
- 403 forbidden — the credential's role is too low. 403 quota_exceeded — \`details.limit\` names the quota. 403 org_suspended.
- 404 not_found — also returned for resources the credential cannot see.
- 409 conflict — slug taken, or a concurrent change; re-read and retry. 409 managed_by_declaration — change mockingbird.yaml and apply it. 409 prune_required — the apply would delete something; pass prune=true.
- 429 rate_limited / fleet_rate_limited / auth_rate_limited / too_many_concurrent_requests — wait \`Retry-After\` seconds. 429 quota_exceeded — the monthly request quota is used up.
- 504 emulator_timeout. 507 state_too_large — reset the emulator or remove data.

## Limits on this server

Defaults; GET /orgs/{orgId}/usage returns an organization's own limits and current usage.

- Projects per organization: ${show(config.limits.projectsPerOrg)}; fleets per organization: ${show(config.limits.fleetsPerOrg)}; emulators per fleet: ${show(config.limits.emulatorsPerFleet)}
- Members per organization: ${show(config.limits.membersPerOrg)}; API keys per organization: ${show(config.limits.apiKeysPerOrg)}
- Stored state per emulator: ${show(config.limits.stateBytes)} bytes compressed
- Emulator requests per organization per month: ${show(config.limits.requestsPerMonth)}
- Emulator requests per fleet per minute: ${show(config.limits.fleetRequestsPerMinute)}; per client address per minute: ${show(config.rateLimits.clientPerMinute)}
- API requests per credential per minute: ${show(config.rateLimits.apiPerMinute)}

Rate-limited responses and successful API responses carry \`RateLimit-Limit\` and \`RateLimit-Remaining\`.

## Endpoints

${[...groups].map(([tag, lines]) => `### ${tag}\n\n${lines.join("\n")}`).join("\n\n")}
`
}
