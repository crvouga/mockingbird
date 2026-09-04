import { test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { keyValueStoreProperties } from "@crvouga/mockingbird-kv-properties"
import { fcParameters } from "@crvouga/mockingbird-testing"
import fc from "fast-check"
import { FileKV } from "./src/index.js"

const params = fcParameters(process.env)
const directories = new Map<FileKV, string>()

test("FileKV satisfies the KeyValueStore contract (including very long keys)", async () => {
  await keyValueStoreProperties({
    create: async () => {
      const directory = await mkdtemp(join(tmpdir(), "mockingbird-filekv-"))
      const kv = new FileKV({ directory })
      directories.set(kv, directory)
      return kv
    },
    destroy: async (kv) => {
      const directory = directories.get(kv as FileKV)
      if (directory) await rm(directory, { recursive: true, force: true })
    },
    keys: fc.oneof(
      { arbitrary: fc.string({ minLength: 1, maxLength: 12 }), weight: 3 },
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
          "../escape",
          ".",
        ),
        weight: 2,
      },
      { arbitrary: fc.string({ minLength: 150, maxLength: 400 }), weight: 1 },
    ),
    numRuns: params.numRuns ?? 25,
    ...(params.seed === undefined ? {} : { seed: params.seed }),
  })
})
