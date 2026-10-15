import { createHash } from "node:crypto"

export type FleetArchive = {
  format: "mockingbird.fleet/v1"
  createdAt: string
  sourceId: string
  namespaces: Record<
    string,
    {
      clock: { now: number; frozen: boolean }
      services: Record<
        string,
        {
          protocol: "http" | "postgres" | "redis" | "external"
          version: 1
          packageVersion?: string
          target?: string
          state: unknown
        }
      >
    }
  >
  sha256: string
}

export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex")
export const sealArchive = (content: Omit<FleetArchive, "sha256">): FleetArchive => ({
  ...content,
  sha256: digest(content),
})
export function validateArchive(value: unknown): FleetArchive {
  if (!value || typeof value !== "object") throw new Error("expected fleet archive")
  const doc = value as FleetArchive
  const { sha256, ...content } = doc
  if (
    doc.format !== "mockingbird.fleet/v1" ||
    typeof doc.sourceId !== "string" ||
    typeof doc.createdAt !== "string" ||
    !doc.namespaces ||
    typeof doc.namespaces !== "object" ||
    Array.isArray(doc.namespaces) ||
    sha256 !== digest(content)
  )
    throw new Error("unsupported or corrupt fleet archive")
  for (const [namespace, entry] of Object.entries(doc.namespaces)) {
    if (
      !/^[A-Za-z0-9_.-]{1,64}$/.test(namespace) ||
      !entry ||
      !Number.isFinite(entry.clock?.now) ||
      typeof entry.clock?.frozen !== "boolean" ||
      !entry.services ||
      !Object.keys(entry.services).length
    )
      throw new Error("invalid archive namespace")
    for (const [name, child] of Object.entries(entry.services))
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
        !child ||
        child.version !== 1 ||
        !["http", "postgres", "redis", "external"].includes(child.protocol)
      )
        throw new Error("unsupported archive service/version")
  }
  return doc
}

/** Read-only semantic summaries; values are omitted unless explicitly requested. */
export function inspectArchive(input: unknown) {
  const archive = validateArchive(input)
  return {
    format: archive.format,
    createdAt: archive.createdAt,
    sha256: archive.sha256,
    namespaces: Object.fromEntries(
      Object.entries(archive.namespaces).map(([name, ns]) => [
        name,
        {
          clock: ns.clock,
          services: Object.fromEntries(
            Object.entries(ns.services).map(([service, state]) => [
              service,
              {
                protocol: state.protocol,
                version: state.version,
                bytes: Buffer.byteLength(canonical(state.state)),
              },
            ]),
          ),
        },
      ]),
    ),
  }
}
export function diffArchives(
  left: unknown,
  right: unknown,
  options: { namespace?: string; service?: string; values?: boolean; limit?: number } = {},
) {
  const a = validateArchive(left),
    b = validateArchive(right)
  const limit = Math.min(1000, Math.max(1, options.limit ?? 100))
  const changes: {
    namespace: string
    service: string
    path: string
    kind: string
    before?: unknown
    after?: unknown
  }[] = []
  let total = 0
  const walk = (
    namespace: string,
    service: string,
    path: string,
    before: unknown,
    after: unknown,
  ) => {
    if (canonical(before) === canonical(after)) return
    if (
      before &&
      after &&
      typeof before === "object" &&
      typeof after === "object" &&
      !Array.isArray(before) &&
      !Array.isArray(after)
    ) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
        walk(
          namespace,
          service,
          `${path}/${key}`,
          (before as Record<string, unknown>)[key],
          (after as Record<string, unknown>)[key],
        )
      return
    }
    total++
    if (changes.length < limit)
      changes.push({
        namespace,
        service,
        path,
        kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
        ...(options.values ? { before, after } : {}),
      })
  }
  for (const ns of new Set([...Object.keys(a.namespaces), ...Object.keys(b.namespaces)])) {
    if (options.namespace !== undefined && options.namespace !== ns) continue
    const an = a.namespaces[ns],
      bn = b.namespaces[ns]
    walk(ns, "$clock", "/clock", an?.clock, bn?.clock)
    for (const service of new Set([
      ...Object.keys(an?.services ?? {}),
      ...Object.keys(bn?.services ?? {}),
    ])) {
      if (options.service !== undefined && options.service !== service) continue
      const x = an?.services[service],
        y = bn?.services[service]
      if (x && y && (x.protocol !== y.protocol || x.version !== y.version))
        throw new Error("incompatible snapshot comparison")
      const normalize = (state: unknown): unknown => {
        if (state && typeof state === "object") {
          const obj = state as Record<string, unknown>
          if (obj.format === "mockingbird.postgres/v1" && obj.inventory) {
            if (options.values)
              throw new Error(
                "raw PostgreSQL row diff is unsupported; use bounded namespace inspection",
              )
            const { databases: _databases, ...metadata } = obj
            return metadata
          }
          if (obj.$redis === "map" && Array.isArray(obj.value))
            return Object.fromEntries(
              obj.value.map((pair: [unknown, unknown]) => [
                typeof pair[0] === "string" ? pair[0] : canonical(pair[0]),
                normalize(pair[1]),
              ]),
            )
          if (Array.isArray(state))
            return Object.fromEntries(
              state.map((value, index) => [String(index), normalize(value)]),
            )
        }
        if (
          state &&
          typeof state === "object" &&
          Array.isArray((state as { records?: unknown }).records)
        ) {
          const { records, ...rest } = state as { records: { collection: string; id: string }[] }
          return {
            ...rest,
            records: Object.fromEntries(records.map((r) => [`${r.collection}/${r.id}`, r])),
          }
        }
        if (state && typeof state === "object" && !Array.isArray(state))
          return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, normalize(v)]))
        return state
      }
      walk(ns, service, "/state", normalize(x?.state), normalize(y?.state))
    }
  }
  return { format: "mockingbird.fleet-diff/v1", total, truncated: total > changes.length, changes }
}
