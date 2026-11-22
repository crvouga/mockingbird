/**
 * Proof that what was deployed is what is served, and the consumer's own checks before and after
 * upload. A deploy returns once Cloudflare accepts it; the edge then moves to it machine by machine,
 * so both are polled until they agree or a deadline passes.
 */
export type PreviewHttpFetch = (input: string, init?: RequestInit) => Promise<Response>

/** One consumer check result. */
export type PreviewCheck = { name: string; ok: boolean; detail?: string }

/**
 * A consumer's checks. Before upload they run against the built directory (`origin` is a local
 * stand-in and `fetch` reads the files); after upload against the deployed origin.
 */
export type PreviewChecks = (origin: string, fetch: PreviewHttpFetch) => Promise<PreviewCheck[]>

export type PreviewPollOptions = {
  timeoutMs?: number
  intervalMs?: number
  fetch?: PreviewHttpFetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaults = (options: PreviewPollOptions) => ({
  timeoutMs: options.timeoutMs ?? 120_000,
  intervalMs: options.intervalMs ?? 2_000,
  fetch: options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
  now: options.now ?? (() => Date.now()),
  sleep: options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
})

/**
 * Polls `<origin>/version.json` (no-store, cache-busted) until its `version` is `commit`.
 * Resolves with the number of reads; rejects with the last thing seen once `timeoutMs` passes.
 */
export async function waitUntilServing(
  origin: string,
  commit: string,
  options: PreviewPollOptions = {},
): Promise<{ attempts: number }> {
  if (!commit) throw new Error("waitUntilServing needs a commit")
  const { timeoutMs, intervalMs, fetch, now, sleep } = defaults(options)
  const deadline = now() + timeoutMs
  let last = "no response"
  for (let attempts = 1; ; attempts++) {
    try {
      const url = new URL("/version.json", origin)
      url.searchParams.set("t", `${now()}-${attempts}`)
      const response = await fetch(url.toString(), { cache: "no-store", redirect: "error" })
      if (response.ok) {
        const body = (await response.json()) as { version?: unknown }
        if (body.version === commit) return { attempts }
        last = `version.json names ${String(body.version)}`
      } else last = `HTTP ${response.status}`
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (now() + intervalMs > deadline)
      throw new Error(`${origin} is not serving ${commit} after ${timeoutMs} ms (${last})`)
    await sleep(intervalMs)
  }
}

/** Runs `checks` once, turning a throw into one failed check. */
export async function runPreviewChecks(
  checks: PreviewChecks,
  origin: string,
  fetch: PreviewHttpFetch,
): Promise<{ passed: boolean; results: PreviewCheck[] }> {
  let results: PreviewCheck[]
  try {
    results = await checks(origin, fetch)
    if (!Array.isArray(results)) throw new Error("checks must resolve with an array")
  } catch (error) {
    results = [
      { name: "checks", ok: false, detail: error instanceof Error ? error.message : String(error) },
    ]
  }
  return { passed: results.every((result) => result.ok === true), results }
}

/** Re-runs `checks` against a deployed origin until they all pass or `timeoutMs` passes. */
export async function checkUntilPassing(
  checks: PreviewChecks,
  origin: string,
  options: PreviewPollOptions = {},
): Promise<{ passed: boolean; results: PreviewCheck[]; attempts: number }> {
  const { timeoutMs, intervalMs, fetch, now, sleep } = defaults(options)
  const deadline = now() + timeoutMs
  for (let attempts = 1; ; attempts++) {
    const outcome = await runPreviewChecks(checks, origin, fetch)
    if (outcome.passed || now() + intervalMs > deadline) return { ...outcome, attempts }
    await sleep(intervalMs)
  }
}

/** What a deploy is for: a pull request's Preview, or a branch's (e.g. main). */
export type PreviewTarget = "pull-request" | "branch"

/**
 * Whether a build whose gate (checks on the built directory) failed is still uploaded. A pull
 * request's gate is best effort: it uploads and the PR says it fails its checks. A branch's gate is
 * strict: nothing is uploaded and the last passing deploy keeps serving.
 */
export function previewGateUploads(target: PreviewTarget, gatePassed: boolean): boolean {
  return gatePassed || target === "pull-request"
}
