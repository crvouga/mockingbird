/**
 * Re-record the shipped corpus (corpus/sandbox-sealed.json) from the Junction sandbox,
 * with the key from Vault. Consumers record their own team with
 * `mockingbird-junction corpus pull` instead.
 *
 *   bun run corpus:record            (refuses to overwrite)
 *   bun run corpus:record -- --force
 */
import { access, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadCredentials } from "@crvouga/mockingbird-openbao"
import { DEFAULT_JUNCTION_BASE_URL, isSandboxKey, pullCorpus } from "../src/corpus-tools.js"

const argv = Bun.argv.slice(2)
const outIndex = argv.indexOf("--out")
const target =
  (outIndex >= 0 ? argv[outIndex + 1] : undefined) ??
  join(import.meta.dir, "../corpus/sandbox-sealed.json")
if (!argv.includes("--force")) {
  const exists = await access(target).then(
    () => true,
    () => false,
  )
  if (exists) {
    console.log(`${target} exists; pass --force to overwrite`)
    process.exit(1)
  }
}

const credentials = await loadCredentials(
  {
    provider: "junction",
    fields: { MOCKINGBIRD_JUNCTION_API_KEY: "MOCKINGBIRD_JUNCTION_API_KEY" },
  },
  {
    env: Bun.env,
    readTokenFile: () => readFile(join(homedir(), ".vault-token"), "utf8").catch(() => undefined),
  },
)
const apiKey = credentials.values.MOCKINGBIRD_JUNCTION_API_KEY
if (!isSandboxKey(apiKey)) {
  console.error("refusing to run with a key that is not a sandbox team key")
  process.exit(2)
}

const corpus = await pullCorpus({
  apiKey,
  baseUrl: process.env.MOCKINGBIRD_JUNCTION_BASE_URL ?? DEFAULT_JUNCTION_BASE_URL,
  onProgress: (message) => console.log(message),
})
const json = JSON.stringify(corpus, null, 2)
await writeFile(target, json)
console.log(
  `sealed ${Object.keys(corpus.observations).length} observations (${Buffer.byteLength(json)} bytes), ${corpus.catalog.labTests.length} lab tests, ${corpus.catalog.labs.length} labs, ${corpus.labAccounts.length} lab accounts, fingerprint ${corpus.fingerprint}`,
)
