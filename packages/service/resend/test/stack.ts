/**
 * One served Resend mock (forwarding into one served Mailosaur mock) per test process.
 *
 * `resend@4.8.0` reads `RESEND_BASE_URL` once, when the module is first imported, and every
 * test file in a `bun test` run shares the module cache. So the base URL is set once, before
 * the first `import("resend")`, and every file uses the same servers; tests stay apart by
 * mapping their own API key to their own namespace (`PUT /__admin/credentials`).
 */
import tls from "node:tls"
import {
  createServer as createInbox,
  type MailosaurServer,
} from "@crvouga/mockingbird-service-mailosaur/server"
import { createServer, type ResendServer } from "../src/server.js"

export type Stack = {
  resend: ResendServer
  inbox: MailosaurServer
  Resend: typeof import("resend").Resend
}

let stack: Promise<Stack> | undefined

const trust = tls as unknown as {
  getCACertificates(kind: "default"): string[]
  setDefaultCACertificates(certs: string[]): void
}

export const sharedStack = (): Promise<Stack> => {
  stack ??= (async () => {
    const inbox = await createInbox({ tls: true })
    // The Mailosaur SDK reaches the inbox over TLS; trust its generated certificate.
    trust.setDefaultCACertificates([...trust.getCACertificates("default"), inbox.cert as string])
    const resend = await createServer({ forwardToInbox: { url: inbox.url } })
    process.env.RESEND_BASE_URL = resend.url
    const { Resend } = await import("resend")
    return { resend, inbox, Resend }
  })()
  return stack
}

let counter = 0

/**
 * A fresh API key mapped to a fresh namespace, on the shared Resend mock and on the inbox (the
 * Resend mock forwards under its namespace name, so the same key reads the forwarded mail).
 */
export const isolatedKey = async (label: string) => {
  const { resend, inbox } = await sharedStack()
  counter += 1
  const namespace = `${label}-${counter}`.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 60)
  const key = `re_${namespace.replace(/[^A-Za-z0-9]/g, "")}_${counter}`
  for (const base of [resend.url, inbox.url]) {
    const response = await fetch(`${base}/__admin/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credentials: { [key]: namespace } }),
    })
    if (!response.ok) throw new Error(`credential mapping failed: ${response.status}`)
  }
  return { key, namespace }
}

/** `fetch` against the shared Resend mock's admin plane, in `namespace`. */
export const admin = async (path: string, namespace: string, body?: unknown) => {
  const { resend } = await sharedStack()
  return fetch(`${resend.url}/__admin${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-mockingbird-namespace": namespace },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A Mailosaur SDK client for the shared inbox, through its CONNECT door. */
export const mailosaurClient = async (apiKey: string) => {
  const { inbox } = await sharedStack()
  const { default: MailosaurNode } = await import("mailosaur")
  process.env.HTTPS_PROXY = inbox.proxyUrl
  try {
    return new MailosaurNode(apiKey)
  } finally {
    // Bun caches a proxy it has seen until the variable is set to "" (a bare delete keeps it).
    process.env.HTTPS_PROXY = ""
    delete process.env.HTTPS_PROXY
  }
}
