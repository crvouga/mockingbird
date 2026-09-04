import { json, type KeyValueStore, namespace, type TypedKV } from "@crvouga/mockingbird-kv"

/** Every stored record carries a monotonically increasing sequence for stable ordering. */
export type Stored<T> = { seq: number; value: T }

export type ListRecordsOptions<T> = {
  /** Keep only records passing the predicate. */
  where?: (value: T, seq: number) => boolean
  /** Sort order; default newest first. */
  order?: "newest" | "oldest"
}

/**
 * A kv-backed table of JSON records addressed by id. Ordering is by insertion sequence, never
 * by kv key order, so list semantics stay identical across adapters.
 */
export class Collection<T> {
  private readonly records: TypedKV<Stored<T>>
  private readonly meta: TypedKV<number>

  constructor(kv: KeyValueStore, name: string) {
    const scoped = namespace(kv, name)
    this.records = json<Stored<T>>(namespace(scoped, "records"))
    this.meta = json<number>(namespace(scoped, "meta"))
  }

  async nextSequence(): Promise<number> {
    const current = (await this.meta.get("seq")) ?? 0
    const next = current + 1
    await this.meta.set("seq", next)
    return next
  }

  async get(id: string): Promise<T | undefined> {
    return (await this.records.get(id))?.value
  }

  async has(id: string): Promise<boolean> {
    return (await this.records.get(id)) !== undefined
  }

  /** Insert a new record, assigning it the next sequence number. */
  async insert(id: string, value: T): Promise<Stored<T>> {
    const seq = await this.nextSequence()
    const stored = { seq, value }
    await this.records.set(id, stored)
    return stored
  }

  /** Replace an existing record's value, keeping its position. */
  async update(id: string, value: T): Promise<Stored<T> | undefined> {
    const existing = await this.records.get(id)
    if (!existing) return undefined
    const stored = { seq: existing.seq, value }
    await this.records.set(id, stored)
    return stored
  }

  async delete(id: string): Promise<boolean> {
    const existed = await this.has(id)
    if (existed) await this.records.delete(id)
    return existed
  }

  async list(options: ListRecordsOptions<T> = {}): Promise<Array<Stored<T> & { id: string }>> {
    const out: Array<Stored<T> & { id: string }> = []
    for await (const entry of this.records.list()) {
      if (options.where && !options.where(entry.value.value, entry.value.seq)) continue
      out.push({ id: entry.key, ...entry.value })
    }
    out.sort((a, b) => (options.order === "oldest" ? a.seq - b.seq : b.seq - a.seq))
    return out
  }
}
