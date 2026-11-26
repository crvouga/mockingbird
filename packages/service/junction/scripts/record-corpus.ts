/** Record a private Junction sandbox corpus with JUNCTION_API_KEY. */
import { access, writeFile } from "node:fs/promises"
import { loadCredentials } from "@crvouga/mockingbird-credentials"
import { DEFAULT_JUNCTION_BASE_URL, isSandboxKey, pullCorpus } from "../src/corpus-tools.js"

const argv = Bun.argv.slice(2)
const outIndex = argv.indexOf("--out")
const target = outIndex >= 0 ? argv[outIndex + 1] : undefined
if (!target || target.startsWith("--")) {
  throw new Error("Provide --out <private-corpus-file>")
}
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
    fields: { JUNCTION_API_KEY: "JUNCTION_API_KEY" },
  },
  {
    env: Bun.env,
  },
)
const apiKey = credentials.values.JUNCTION_API_KEY
if (!isSandboxKey(apiKey)) {
  console.error("refusing to run with a key that is not a sandbox team key")
  process.exit(2)
}

const corpus = await pullCorpus({
  apiKey,
  baseUrl: process.env.JUNCTION_BASE_URL ?? DEFAULT_JUNCTION_BASE_URL,
  onProgress: (message) => console.log(message),
})
const json = JSON.stringify(corpus, null, 2)
await writeFile(target, json, { mode: 0o600, flag: argv.includes("--force") ? "w" : "wx" })
console.log(
  `sealed ${Object.keys(corpus.observations).length} observations (${Buffer.byteLength(json)} bytes), ${corpus.catalog.labTests.length} lab tests, ${corpus.catalog.labs.length} labs, ${corpus.labAccounts.length} lab accounts, fingerprint ${corpus.fingerprint}`,
)
