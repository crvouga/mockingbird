/**
 * Live parity: the same random walk against CareTalk's beta API and a fresh mock,
 * canonicalized and diffed. Credentials come from the environment or Vault
 * `secret/personal/prd`:
 *
 *   MOCKINGBIRD_CARETALK_API_URL     e.g. https://api.caretalkbeta.com
 *   MOCKINGBIRD_CARETALK_USERNAME
 *   MOCKINGBIRD_CARETALK_PASSWORD
 *
 * By default only reads run (login, GetForm, States, patient search, free slots, appointment
 * lists). Saving forms, inserting patients and booking need `--include-unsafe` and must only
 * ever target the beta environment. The mock is seeded with the live definitions of the forms
 * the walk asks for, so form bodies compare like for like.
 */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { CredentialError, createRedactor, loadCredentials } from "@crvouga/mockingbird-openbao"
import { parity } from "@crvouga/mockingbird-parity"
import { CareTalkAPI, document, type FullFormDto } from "../src/index.js"

const readTokenFile = async () => {
  try {
    return await readFile(join(homedir(), ".vault-token"), "utf8")
  } catch {
    return undefined
  }
}

let credentials: Awaited<ReturnType<typeof loadCredentials>>
try {
  credentials = await loadCredentials(
    {
      provider: "caretalk",
      fields: {
        MOCKINGBIRD_CARETALK_API_URL: "MOCKINGBIRD_CARETALK_API_URL",
        MOCKINGBIRD_CARETALK_USERNAME: "MOCKINGBIRD_CARETALK_USERNAME",
        MOCKINGBIRD_CARETALK_PASSWORD: "MOCKINGBIRD_CARETALK_PASSWORD",
      },
    },
    { env: process.env, readTokenFile },
  )
} catch (error) {
  if (error instanceof CredentialError) {
    console.error(`caretalk parity: no sandbox credentials. ${error.message}`)
    process.exit(2)
  }
  throw error
}

const baseUrl = credentials.values.MOCKINGBIRD_CARETALK_API_URL.replace(/\/$/, "")
if (!/caretalkbeta/.test(baseUrl) && !process.argv.includes("--allow-non-beta")) {
  console.error("caretalk parity: refusing a non-beta CareTalk URL (pass --allow-non-beta)")
  process.exit(2)
}
const login = await fetch(`${baseUrl}/externalapi/Auth/client-login`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "*/*" },
  body: JSON.stringify({
    userName: credentials.values.MOCKINGBIRD_CARETALK_USERNAME,
    password: credentials.values.MOCKINGBIRD_CARETALK_PASSWORD,
  }),
})
if (!login.ok) {
  console.error(`caretalk parity: client-login failed (${login.status})`)
  process.exit(2)
}
const realToken = ((await login.json()) as { token: string }).token
const forms: FullFormDto[] = []
for (const name of ["Health History", "AOE Questions"]) {
  const response = await fetch(`${baseUrl}/externalapi/Forms/GetForm/${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${realToken}` },
  })
  if (!response.ok) continue
  const rows = (await response.json()) as { fullFormDto: FullFormDto }[]
  if (rows[0]) forms.push(rows[0].fullFormDto)
}

const mock = () => new CareTalkAPI(forms.length > 0 ? { forms } : {})
const mockToken = (
  (await (
    await mock().fetch(
      new Request("https://mock.caretalk.local/externalapi/Auth/client-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userName: "parity", password: "parity" }),
      }),
    )
  ).json()) as { token: string }
).token

try {
  await parity({
    provider: "caretalk",
    spec: document,
    env: process.env,
    includeUnsafe: process.argv.includes("--include-unsafe"),
    real: {
      baseUrl,
      allowedHosts: [new URL(baseUrl).host],
      headers: () => ({ authorization: `Bearer ${realToken}`, accept: "*/*" }),
      minIntervalMs: 250,
    },
    mock: {
      create: mock,
      headers: () => ({ authorization: `Bearer ${mockToken}`, accept: "*/*" }),
    },
    redact: createRedactor([...credentials.secrets, realToken]),
  })
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
