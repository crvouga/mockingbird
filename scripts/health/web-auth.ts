/**
 * npm's trust API answers a logged-in session with a security-key challenge:
 * HTTP 401, `www-authenticate: OTP`, and `{ authUrl, doneUrl }`.
 * Open authUrl, poll doneUrl until it returns the one-time code, and send that
 * code back as `npm-otp`. Same exchange as `npm trust`.
 */

export type WebChallenge = {
  authUrl: string
  doneUrl: string
}

const FIRST_PROMPT = `npm needs a security key to read trusted publishers.
Approve the prompt in your browser. If the page offers to skip two-factor for a few minutes, turn that on so this run can check every package.`

const AGAIN_PROMPT = `npm asked for the security key again.
On the page, skip two-factor for the next few minutes so this run can read the rest of the packages.`

function httpsHost(value: string, host: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.host === host
  } catch {
    return false
  }
}

/** The web-auth challenge in a trust response, or null when this 401 is not one. */
export function webChallenge(status: number, body: unknown): WebChallenge | null {
  if (status !== 401 || !body || typeof body !== "object") return null
  const record = body as { authUrl?: unknown; doneUrl?: unknown }
  if (typeof record.authUrl !== "string" || typeof record.doneUrl !== "string") return null
  if (!httpsHost(record.authUrl, "www.npmjs.com")) return null
  if (!httpsHost(record.doneUrl, "registry.npmjs.org")) return null
  return { authUrl: record.authUrl, doneUrl: record.doneUrl }
}

export async function pollWebAuth(
  fetchDone: () => Promise<{ status: number; retryAfter: string | null; body: unknown }>,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
  deadlineMs = 10 * 60 * 1000,
): Promise<string> {
  const deadline = now() + deadlineMs
  for (;;) {
    if (now() > deadline) throw new Error("timed out waiting for the npm security key")
    const res = await fetchDone()
    if (res.status === 200) {
      const token =
        res.body &&
        typeof res.body === "object" &&
        "token" in res.body &&
        typeof res.body.token === "string"
          ? res.body.token
          : ""
      if (!token) throw new Error("npm web auth returned no one-time code")
      return token
    }
    if (res.status === 202) {
      const retry = Number(res.retryAfter)
      const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000
      await sleep(Math.min(wait, 5000))
      continue
    }
    throw new Error(`npm web auth returned HTTP ${res.status}`)
  }
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" })
  } catch {
    // The URL is already printed. The approval still works from a pasted link.
  }
}

export async function promptWebAuth(
  challenge: WebChallenge,
  token: string,
  again: boolean,
): Promise<string> {
  console.error(again ? AGAIN_PROMPT : FIRST_PROMPT)
  console.error(challenge.authUrl)
  openBrowser(challenge.authUrl)
  return pollWebAuth(
    async () => {
      const res = await fetch(challenge.doneUrl, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      })
      return {
        status: res.status,
        retryAfter: res.headers.get("retry-after"),
        body: await res.json().catch(() => undefined),
      }
    },
    (ms) => Bun.sleep(ms),
  )
}
