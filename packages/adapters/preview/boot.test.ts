import { describe, expect, test } from "bun:test"
import { type BootPreviewOptions, bootPreview } from "./src/boot.js"

const BASE = "https://lab-pr-3.example.workers.dev/"
const VERSION = {
  version: "e".repeat(40),
  builtAt: "2026-11-20T10:00:00.000Z",
  entry: "./app-abc.js",
  pr: { number: 3, url: "https://github.com/o/r/pull/3" },
}

/** A host element, as much of one as the boot loader touches. */
const fakeHost = () => ({ textContent: "" }) as unknown as HTMLElement

const listeners = { addEventListener() {}, removeEventListener() {} }

const options = (
  overrides: Partial<BootPreviewOptions> & { versionAnswer?: Response } = {},
): { opts: BootPreviewOptions; fetched: string[]; imported: string[]; host: HTMLElement } => {
  const fetched: string[] = []
  const imported: string[] = []
  const host = fakeHost()
  const fetcher = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    fetched.push(url)
    if (url.endsWith("/version.json")) return overrides.versionAnswer ?? Response.json(VERSION)
    return Response.json({ source: "none", updatedAt: new Date().toISOString() })
  }) as typeof fetch
  const { versionAnswer: _, ...rest } = overrides
  return {
    fetched,
    imported,
    host,
    opts: {
      host,
      baseUrl: BASE,
      fetch: fetcher,
      importEntry: async (url) => {
        imported.push(url)
        return {
          start: async (target: HTMLElement, opts: { build?: unknown }) => {
            target.textContent = `mounted with build=${typeof opts.build}`
            return () => {}
          },
        }
      },
      live: {
        fetch: fetcher,
        EventSource: null,
        origin: BASE.slice(0, -1),
        document: listeners,
        window: listeners,
        timers: { setTimeout: () => 0, clearTimeout: () => {} },
      },
      ...rest,
    },
  }
}

describe("bootPreview", () => {
  test("fetches version.json without cache, imports its entry and starts it with the live build", async () => {
    const { opts, fetched, imported, host } = options()
    const live = await bootPreview(opts)
    expect(fetched[0]).toBe(`${BASE}version.json`)
    expect(imported).toEqual([`${BASE}app-abc.js`])
    expect(host.textContent).toBe("mounted with build=object")
    expect(live.get().current.version).toBe(VERSION.version)
    expect(live.get().pr).toEqual(VERSION.pr)
    live.close()
  })

  test("a host selector is looked up in the document", async () => {
    const element = fakeHost()
    const queried: string[] = []
    const { opts } = options({
      host: "#system",
      document: {
        querySelector: ((selector: string) => {
          queried.push(selector)
          return element
        }) as Document["querySelector"],
      },
    })
    const live = await bootPreview(opts)
    expect(queried).toEqual(["#system"])
    expect(element.textContent).toBe("mounted with build=object")
    live.close()
  })

  test("a missing host rejects", async () => {
    const { opts } = options({
      host: "#nope",
      document: { querySelector: (() => null) as Document["querySelector"] },
    })
    await expect(bootPreview(opts)).rejects.toThrow("No element matches #nope")
  })

  test("a failing version.json writes a readable message into the host", async () => {
    const { opts, host } = options({ versionAnswer: new Response("", { status: 503 }) })
    await expect(bootPreview(opts)).rejects.toThrow("version.json answered 503")
    expect(host.textContent).toBe("Unable to start the preview: version.json answered 503")
  })

  test("an entry without start writes a readable message into the host", async () => {
    const { opts, host } = options({ importEntry: async () => ({}) })
    await expect(bootPreview(opts)).rejects.toThrow()
    expect(host.textContent).toContain("Unable to start the preview:")
    expect(host.textContent).toContain("exports no start")
  })

  // #867: the live poller read the absolute /version.json, whatever the boot loader had read.
  test("the live poller reads the same version.json the boot loader read", async () => {
    const { opts, fetched } = options({ versionUrl: "./v1/version.json" })
    const live = await bootPreview(opts)
    expect(fetched[0]).toBe(`${BASE}v1/version.json`)
    const polled = fetched.filter((url) => url.endsWith("version.json"))
    expect(polled.length).toBeGreaterThanOrEqual(2)
    expect(new Set(polled)).toEqual(new Set([`${BASE}v1/version.json`]))
    live.close()
  })

  test("under a sub-path deployment, boot and live polling read the sub-path's version.json", async () => {
    const root = "https://example.test/apps/lab/"
    const { opts, fetched, imported } = options({ baseUrl: root })
    const live = await bootPreview({
      ...opts,
      live: { ...opts.live, origin: "https://example.test" },
    })
    expect(imported).toEqual([`${root}app-abc.js`])
    const polled = fetched.filter((url) => url.endsWith("version.json"))
    expect(polled.length).toBeGreaterThanOrEqual(2)
    expect(new Set(polled)).toEqual(new Set([`${root}version.json`]))
    live.close()
  })

  test("an explicit live.versionUrl still wins", async () => {
    const { opts, fetched } = options()
    const live = await bootPreview({
      ...opts,
      live: { ...opts.live, versionUrl: "/elsewhere/version.json" },
    })
    expect(fetched).toContain(`${BASE}elsewhere/version.json`)
    live.close()
  })
})
