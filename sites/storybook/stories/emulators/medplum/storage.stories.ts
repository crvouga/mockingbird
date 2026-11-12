import {
  createRuntime,
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_SECRET,
} from "@crvouga/mockingbird-service-medplum"
import type { Meta, StoryObj } from "@storybook/html-vite"
import { page } from "../../../src/story.js"

/**
 * What a browser shows for Medplum's links: a presigned attachment URL (`/storage/{id}/{version}`,
 * the `url` of a Binary or an Attachment) opened from an app, in each state the link can be in,
 * and the server's own page for a path it does not serve.
 */
export default {
  title: "Emulators/Medplum/Storage",
  parameters: {
    layout: "fullscreen",
    sources: ["packages/service/medplum/src/api.ts", "packages/service/medplum/src/http.ts"],
  },
} satisfies Meta

const ORIGIN = "https://api.medplum.com"

const REPORT = `<!doctype html><meta charset="utf-8"><title>Lab report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}td,th{padding:.25rem 1rem .25rem 0;text-align:left}</style>
<h1>Comprehensive metabolic panel</h1><p>Patient: Ada Lovelace · Collected 2026-11-02</p>
<table><tr><th>Test</th><th>Result</th><th>Range</th></tr>
<tr><td>Glucose</td><td>92 mg/dL</td><td>70–99</td></tr><tr><td>Sodium</td><td>139 mmol/L</td><td>135–145</td></tr></table>`

/** A Medplum emulator holding one attachment uploaded by a signed-in client, and its link. */
async function attachment(body: string, contentType: string) {
  const emulator = createRuntime({ baseUrl: `${ORIGIN}/` })
  const token = await emulator.fetch(
    new Request(`${ORIGIN}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: DEFAULT_CLIENT_ID,
        client_secret: DEFAULT_CLIENT_SECRET,
      }),
    }),
  )
  const { access_token } = (await token.json()) as { access_token: string }
  const binary = await emulator.fetch(
    new Request(`${ORIGIN}/fhir/R4/Binary`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": contentType },
      body,
    }),
  )
  const { url } = (await binary.json()) as { url: string }
  return { emulator, url: new URL(url) }
}

/** An HTML lab report attachment, opened from its link. */
export const Attachment: StoryObj = page(() =>
  attachment(REPORT, "text/html").then(({ emulator, url }) => ({ emulator, url: url.href })),
)

/** A plain-text attachment. */
export const PlainTextAttachment: StoryObj = page(async () => {
  const { emulator, url } = await attachment(
    "Results reviewed with the patient on 2026-11-04. No follow-up needed.",
    "text/plain",
  )
  return { emulator, url: url.href }
})

/** A link opened after its hour is up. */
export const Expired: StoryObj = page(async () => {
  const { emulator, url } = await attachment(REPORT, "text/html")
  await emulator.fetch(
    new Request(`${ORIGIN}/__admin/clock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ advance: "2h" }),
    }),
  )
  return { emulator, url: url.href }
})

/** A link whose signature was changed. */
export const InvalidSignature: StoryObj = page(async () => {
  const { emulator, url } = await attachment(REPORT, "text/html")
  url.searchParams.set("Signature", "tampered")
  return { emulator, url: url.href }
})

/** A link with its signature cut off. */
export const Unsigned: StoryObj = page(async () => {
  const { emulator, url } = await attachment(REPORT, "text/html")
  url.searchParams.delete("Signature")
  return { emulator, url: url.href }
})

/** A path the server does not serve: Express's own 404 page. */
export const NotFound: StoryObj = page(() => ({
  emulator: createRuntime({ baseUrl: `${ORIGIN}/` }),
  url: `${ORIGIN}/patients/ada`,
}))
