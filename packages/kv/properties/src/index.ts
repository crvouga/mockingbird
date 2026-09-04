import {
  compareKeys,
  type KeyValueEntry,
  type KeyValueStore,
  type ListOptions,
} from "@crvouga/mockingbird-kv"
import fc from "fast-check"

export type KeyValueStorePropertiesOptions = {
  /** Build a fresh, empty store. Called once per generated command sequence. */
  create: () => KeyValueStore | Promise<KeyValueStore>
  /** Optional teardown for stores that hold external resources (files, connections). */
  destroy?: (kv: KeyValueStore) => void | Promise<void>
  /** fast-check seed. Reproduces a previous failure exactly. */
  seed?: number
  /** Number of generated command sequences. Default 50. */
  numRuns?: number
  /** Upper bound on commands per sequence. Default 40. */
  maxCommands?: number
  /** Provide your own key arbitrary, e.g. to respect backend key restrictions. */
  keys?: fc.Arbitrary<string>
  /** Provide your own value arbitrary. */
  values?: fc.Arbitrary<Uint8Array>
}

type Model = { entries: Map<string, Uint8Array> }
type System = { kv: KeyValueStore }

const equalBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

const show = (bytes: Uint8Array) => `<${bytes.byteLength} bytes>`

const collect = async (iterable: AsyncIterable<KeyValueEntry>) => {
  const out: KeyValueEntry[] = []
  for await (const entry of iterable) out.push(entry)
  return out
}

const expectedList = (model: Model, prefix: string) =>
  [...model.entries.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([a], [b]) => compareKeys(a, b))

const fail = (message: string): never => {
  throw new Error(message)
}

class GetCommand implements fc.AsyncCommand<Model, System> {
  constructor(readonly key: string) {}
  check() {
    return true
  }
  async run(model: Model, system: System) {
    const actual = await system.kv.get(this.key)
    const expected = model.entries.get(this.key)
    if (expected === undefined) {
      if (actual !== undefined)
        fail(`get(${JSON.stringify(this.key)}) returned ${show(actual)}, expected undefined`)
      return
    }
    if (actual === undefined || !equalBytes(actual, expected)) {
      fail(
        `get(${JSON.stringify(this.key)}) returned ${actual ? show(actual) : "undefined"}, expected ${show(expected)}`,
      )
    }
  }
  toString() {
    return `get(${JSON.stringify(this.key)})`
  }
}

class SetCommand implements fc.AsyncCommand<Model, System> {
  constructor(
    readonly key: string,
    readonly value: Uint8Array,
  ) {}
  check() {
    return true
  }
  async run(model: Model, system: System) {
    const input = this.value.slice()
    await system.kv.set(this.key, input)
    input.fill(0)
    model.entries.set(this.key, this.value.slice())
    const readBack = await system.kv.get(this.key)
    if (readBack === undefined || !equalBytes(readBack, this.value)) {
      fail(
        `set(${JSON.stringify(this.key)}) did not persist ${show(this.value)} (adapter must copy or own the buffer)`,
      )
    }
  }
  toString() {
    return `set(${JSON.stringify(this.key)}, ${show(this.value)})`
  }
}

class DeleteCommand implements fc.AsyncCommand<Model, System> {
  constructor(readonly key: string) {}
  check() {
    return true
  }
  async run(model: Model, system: System) {
    await system.kv.delete(this.key)
    model.entries.delete(this.key)
    const after = await system.kv.get(this.key)
    if (after !== undefined) fail(`delete(${JSON.stringify(this.key)}) left a value behind`)
  }
  toString() {
    return `delete(${JSON.stringify(this.key)})`
  }
}

class ListCommand implements fc.AsyncCommand<Model, System> {
  constructor(readonly prefix: string | undefined) {}
  check() {
    return true
  }
  async run(model: Model, system: System) {
    const options: ListOptions = this.prefix === undefined ? {} : { prefix: this.prefix }
    const actual = await collect(system.kv.list(options))
    const expected = expectedList(model, this.prefix ?? "")
    if (actual.length !== expected.length) {
      fail(`${this} yielded ${actual.length} entries, expected ${expected.length}`)
    }
    for (let i = 0; i < expected.length; i++) {
      const [key, value] = expected[i] as [string, Uint8Array]
      const entry = actual[i] as KeyValueEntry
      if (entry.key !== key) {
        fail(
          `${this} yielded key ${JSON.stringify(entry.key)} at ${i}, expected ${JSON.stringify(key)} (ascending lexicographic order required)`,
        )
      }
      if (!equalBytes(entry.value, value))
        fail(`${this} yielded a stale value for ${JSON.stringify(key)}`)
    }
  }
  toString() {
    return this.prefix === undefined ? "list()" : `list({ prefix: ${JSON.stringify(this.prefix)} })`
  }
}

/**
 * Keys are drawn mostly from a small pool so sequences revisit the same key (overwrite, delete
 * then get, prefix siblings). Random strings keep the encoding paths honest.
 */
const defaultKeys = fc.oneof(
  {
    arbitrary: fc.constantFrom(
      "a",
      "a:b",
      "a:c",
      "b",
      "",
      "prefix/1",
      "prefix/2",
      "prefix/10",
      "ｚ",
      "z",
    ),
    weight: 4,
  },
  { arbitrary: fc.string({ minLength: 1, maxLength: 3 }), weight: 2 },
  { arbitrary: fc.string({ minLength: 1, maxLength: 12 }), weight: 1 },
  { arbitrary: fc.string({ unit: "grapheme", minLength: 1, maxLength: 6 }), weight: 1 },
)

const defaultValues = fc.oneof(
  { arbitrary: fc.uint8Array({ maxLength: 64 }), weight: 3 },
  { arbitrary: fc.constant(new Uint8Array(0)), weight: 1 },
  { arbitrary: fc.uint8Array({ minLength: 1024, maxLength: 4096 }), weight: 1 },
)

/**
 * Run the KeyValueStore conformance suite against `options.create()`.
 *
 * Generates stateful sequences of get / set / overwrite / delete / list / prefix-list, checks the
 * store against a simple `Map` reference model after every command, and lets fast-check shrink
 * any failure to a minimal reproducer. Throws on failure.
 */
export const keyValueStoreProperties = async (options: KeyValueStorePropertiesOptions) => {
  const keys = options.keys ?? defaultKeys
  const values = options.values ?? defaultValues
  const commands = [
    keys.map((key) => new GetCommand(key)),
    fc.tuple(keys, values).map(([key, value]) => new SetCommand(key, value)),
    fc.tuple(keys, values).map(([key, value]) => new SetCommand(key, value)),
    keys.map((key) => new DeleteCommand(key)),
    fc.option(keys, { nil: undefined }).map((prefix) => new ListCommand(prefix)),
  ]
  const parameters: fc.Parameters<unknown> = {
    numRuns: options.numRuns ?? 50,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  }
  await fc.assert(
    fc.asyncProperty(
      fc.commands(commands, { maxCommands: options.maxCommands ?? 40 }),
      async (cmds) => {
        const kv = await options.create()
        try {
          await fc.asyncModelRun(() => ({ model: { entries: new Map() }, real: { kv } }), cmds)
        } finally {
          await options.destroy?.(kv)
        }
      },
    ),
    parameters,
  )
}
