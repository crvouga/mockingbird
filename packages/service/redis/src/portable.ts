/** JSON representation preserves binary values, maps and stream bigint IDs across processes. */
export const encodePortable = (value: unknown): unknown => {
  if (typeof value === "bigint") return { $redis: "bigint", value: String(value) }
  if (value instanceof Uint8Array) return { $redis: "bytes", value: Array.from(value) }
  if (value instanceof Map)
    return {
      $redis: "map",
      value: [...value].map(([k, v]) => [encodePortable(k), encodePortable(v)]),
    }
  if (Array.isArray(value)) return value.map(encodePortable)
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodePortable(v)]))
  return value
}
export const decodePortable = (value: unknown, depth = 0): unknown => {
  if (depth > 100) throw new Error("Redis archive is too deeply nested")
  const decode = (v: unknown): unknown => decodePortable(v, depth + 1)
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (
      record.$redis === "bigint" &&
      typeof record.value === "string" &&
      /^-?\d+$/.test(record.value)
    )
      return BigInt(record.value)
    if (
      record.$redis === "bytes" &&
      Array.isArray(record.value) &&
      record.value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    )
      return new Uint8Array(record.value)
    if (
      record.$redis === "map" &&
      Array.isArray(record.value) &&
      record.value.every((p) => Array.isArray(p) && p.length === 2)
    )
      return new Map(record.value.map((p) => [decode(p[0]), decode(p[1])]))
    if (record.$redis !== undefined) throw new Error("invalid Redis archive tag")
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v)]))
  }
  return value
}

/** Reject malformed tagged state before it can replace a live engine. */
export function assertPortableDatabase(value: unknown): void {
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
  const stringMap = (v: unknown): v is Map<string, unknown> =>
    v instanceof Map && [...v.keys()].every((k) => typeof k === "string")
  const bytes = (v: unknown) => v instanceof Uint8Array
  const byteList = (v: unknown) => Array.isArray(v) && v.every(bytes)
  const numericMap = (v: unknown) =>
    stringMap(v) && [...v.values()].every((n) => typeof n === "number" && Number.isFinite(n))
  if (
    !object(value) ||
    !stringMap(value.values) ||
    !numericMap(value.expires) ||
    !numericMap(value.gens) ||
    !numericMap(value.lru) ||
    !Array.isArray(value.order) ||
    !value.order.every((k) => typeof k === "string") ||
    !Number.isSafeInteger(value.tick)
  )
    throw new Error("invalid Redis database archive")
  for (const row of value.values.values()) {
    if (!object(row)) throw new Error("invalid Redis archived value")
    if ((row.kind === "string" && bytes(row.bytes)) || (row.kind === "list" && byteList(row.items)))
      continue
    if (row.kind === "set" && stringMap(row.members) && [...row.members.values()].every(bytes))
      continue
    if (row.kind === "hash" && stringMap(row.fields) && [...row.fields.values()].every(bytes))
      continue
    if (
      row.kind === "zset" &&
      stringMap(row.members) &&
      [...row.members.values()].every(
        (m) =>
          object(m) && bytes(m.member) && typeof m.score === "number" && !Number.isNaN(m.score),
      )
    )
      continue
    if (row.kind === "stream" && object(row.stream)) {
      const stream = row.stream
      if (
        !Array.isArray(stream.entries) ||
        !stream.entries.every(
          (e) =>
            object(e) &&
            typeof e.id === "string" &&
            typeof e.ms === "bigint" &&
            typeof e.seq === "bigint" &&
            byteList(e.fields),
        ) ||
        typeof stream.lastMs !== "bigint" ||
        typeof stream.lastSeq !== "bigint" ||
        !stringMap(stream.groups)
      )
        throw new Error("invalid Redis archived stream")
      for (const group of stream.groups.values()) {
        if (
          !object(group) ||
          typeof group.name !== "string" ||
          typeof group.lastId !== "string" ||
          !stringMap(group.consumers) ||
          !stringMap(group.pel) ||
          ![...group.consumers.values()].every((c) => object(c) && typeof c.seenAt === "number") ||
          ![...group.pel.values()].every(
            (p) =>
              object(p) &&
              typeof p.id === "string" &&
              typeof p.consumer === "string" &&
              Number.isSafeInteger(p.deliveries) &&
              typeof p.deliveredAt === "number",
          )
        )
          throw new Error("invalid Redis archived consumer group")
      }
      continue
    }
    throw new Error("invalid Redis archived value type")
  }
}
