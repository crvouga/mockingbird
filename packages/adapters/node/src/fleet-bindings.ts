import { digest, type FleetArchive, sealArchive, validateArchive } from "./fleet-archive.js"

export type RestoreBinding = {
  namespace: string
  service: string
  endpointId: string
  endpointRef: string
  secretRef?: string
  signing?: "preserve" | "replace"
  signingRef?: string
}
export type RestoreBindings = { bindings: RestoreBinding[]; endpoints: Record<string, string> }
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
/** Explicitly relocates declared webhook configuration; opaque payloads/tokens are never rewritten. */
export async function planRestoreBindings(
  input: unknown,
  plan: RestoreBindings,
  resolveSecret?: (reference: string) => Promise<string>,
) {
  const source = validateArchive(input),
    copy = structuredClone(source)
  if (!plan || !Array.isArray(plan.bindings) || !object(plan.endpoints))
    throw new Error("expected explicit restore bindings and endpoint references")
  const changes: {
    namespace: string
    service: string
    endpointId: string
    endpointRef: string
    secretRef?: string
    previousFingerprint: string
    destinationFingerprint: string
    signing: string
  }[] = []
  const seen = new Set<string>()
  const endpoint = (reference: string) => {
    const value = plan.endpoints[reference]
    if (typeof value !== "string") throw new Error(`unresolved endpoint reference ${reference}`)
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error(`invalid endpoint reference ${reference}`)
    return url.href
  }
  for (const binding of plan.bindings) {
    const identity = `${binding.namespace}/${binding.service}/${binding.endpointId}`
    if (seen.has(identity)) throw new Error(`ambiguous binding ${identity}`)
    seen.add(identity)
    const section = copy.namespaces[binding.namespace]?.services[binding.service]
    if (
      section?.protocol !== "http" ||
      !object(section.state) ||
      !object(section.state.webhooks) ||
      !Array.isArray(section.state.webhooks.endpoints)
    )
      throw new Error(`unsupported callback binding ${identity}`)
    const hub = section.state.webhooks
    const matches = (hub.endpoints as unknown[]).filter(
      (e) => object(e) && e.id === binding.endpointId,
    ) as Record<string, unknown>[]
    if (matches.length !== 1) throw new Error(`unresolved or ambiguous endpoint ${identity}`)
    const current = matches[0] as Record<string, unknown>,
      old = String(current.url),
      destination = endpoint(binding.endpointRef)
    if (current.signUrl !== undefined && binding.signing === undefined)
      throw new Error(`signing policy required for ${identity}`)
    if (binding.signing !== undefined && !["preserve", "replace"].includes(binding.signing))
      throw new Error(`unsupported signing policy ${identity}`)
    const signUrl =
      binding.signing === "replace"
        ? endpoint(binding.signingRef ?? binding.endpointRef)
        : current.signUrl
    let secret: string | undefined
    if (binding.secretRef !== undefined) {
      if (!resolveSecret) throw new Error(`unresolved secret reference ${binding.secretRef}`)
      try {
        secret = await resolveSecret(binding.secretRef)
        if (typeof secret !== "string" || !secret) throw new Error()
      } catch {
        throw new Error(`unresolved secret reference ${binding.secretRef}`)
      }
    }
    const apply = (value: Record<string, unknown>) => {
      value.url = destination
      if (signUrl !== undefined) value.signUrl = signUrl
      if (secret !== undefined) value.secret = secret
    }
    apply(current)
    if (Array.isArray(hub.payloads))
      for (const pair of hub.payloads)
        if (
          Array.isArray(pair) &&
          object(pair[1]) &&
          object(pair[1].endpoint) &&
          pair[1].endpoint.id === binding.endpointId
        )
          apply(pair[1].endpoint)
    if (Array.isArray(hub.deliveries))
      for (const pair of hub.deliveries)
        if (Array.isArray(pair) && object(pair[1]) && pair[1].endpointId === binding.endpointId)
          pair[1].url = destination
    if (Array.isArray(section.state.records))
      for (const row of section.state.records)
        if (
          object(row) &&
          row.collection === "runtime_webhook_endpoints" &&
          object(row.value) &&
          row.value.id === binding.endpointId
        )
          apply(row.value)
    changes.push({
      namespace: binding.namespace,
      service: binding.service,
      endpointId: binding.endpointId,
      endpointRef: binding.endpointRef,
      ...(binding.secretRef ? { secretRef: binding.secretRef } : {}),
      previousFingerprint: digest(old),
      destinationFingerprint: digest(destination),
      signing: binding.signing ?? "not-configured",
    })
  }
  const { sha256: _sha, ...content } = copy
  return {
    report: {
      version: 1,
      source: source.sha256,
      changes,
      limitations: [
        "opaque payloads, tokens, issuer material and application URLs are unchanged",
        "protocol key rebinding requires a registered participant transformation",
      ],
    },
    archive: sealArchive(content),
  }
}
export const rebaseArchiveNamespace = (
  input: FleetArchive,
  source: string,
  destination: string,
): FleetArchive => {
  const archive = validateArchive(input)
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(destination) || !archive.namespaces[source])
    throw new Error("invalid namespace fork")
  const { sha256: _sha, ...content } = archive
  return sealArchive({
    ...content,
    namespaces: { [destination]: structuredClone(archive.namespaces[source]) },
  })
}
