/**
 * #866 asset preflight and split files, #863 the Vercel host, and the named-mode gate split of
 * #862 (gate-preview / deploy-preview --gate / check-preview).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkPreviewAssets } from "./src/assets-check.js"
import { runPreviewCli } from "./src/cli-main.js"
import type { PreviewCliDeps } from "./src/cli-previews.js"
import { type PreviewStatusSnapshot, parsePreviewBuild } from "./src/preview-status.js"
import { deployPreviewSite } from "./src/site.js"
import { loadSplitPreviewFile } from "./src/split-load.js"
import { createVercelPreviewHosting, VERCEL_PREVIEW_STATE } from "./src/vercel.js"

const MIB = 1024 * 1024
const root = mkdtempSync(join(tmpdir(), "mockingbird-preview-hosting-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dirs = 0
const site = (files: Record<string, string | Uint8Array>) => {
  const dir = join(root, `site-${dirs++}`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  }
}
/** Deterministic, incompressible-ish bytes. */
const bytes = (size: number, seed = 1) => {
  const data = new Uint8Array(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    data[i] = x & 0xff
  }
  return data
}
/** A fetch serving `dir` as static files at https://preview.test. */
const serve = (dir: string) => async (input: RequestInfo | URL) => {
  const path = decodeURIComponent(new URL(String(input)).pathname)
  const file = join(dir, path)
  if (!existsSync(file)) return new Response("missing", { status: 404 })
  return new Response(readFileSync(file))
}

describe("#866 preflight against the host's asset limits", () => {
  test("#866 acceptance: a 30 MiB file fails the preflight naming it, before anything is uploaded", async () => {
    const dir = site({ "index.html": "<h1>hi</h1>", "workers/backend.js": bytes(30 * MIB) })
    const run = io()
    expect(await runPreviewCli(["check", "--outdir", dir], run.io)).toBe(1)
    expect(run.out.join("\n")).toContain(
      "::error::workers/backend.js is 30.0 MiB, over the 25.0 MiB per-file limit",
    )
    const report = await checkPreviewAssets(dir)
    expect(report.problems).toEqual([
      { kind: "too-large", path: "workers/backend.js", bytes: 30 * MIB },
    ])
  })

  test("#866 the file count and the per-file limit are configurable and per host", async () => {
    const dir = site({ "a.txt": "a", "b.txt": "b", "c.txt": bytes(2 * MIB) })
    const run = io()
    expect(
      await runPreviewCli(
        ["check", "--outdir", dir, "--max-files", "2", "--max-file-mib", "1"],
        run.io,
      ),
    ).toBe(1)
    expect(run.out.join("\n")).toContain("3 files, over the 2 files per deployment limit")
    expect(run.out.join("\n")).toContain("c.txt is 2.0 MiB, over the 1.0 MiB")
    expect(await runPreviewCli(["check", "--outdir", dir, "--hosting", "vercel"], io().io)).toBe(0)
  })

  test("#866 acceptance: with splitting, the 30 MiB file deploys as parts and loads back verified", async () => {
    const big = bytes(30 * MIB, 7)
    const dir = site({ "index.html": "<h1>hi</h1>", "workers/backend.js": big })
    const run = io()
    expect(await runPreviewCli(["check", "--outdir", dir, "--split"], run.io)).toBe(0)
    expect(run.out.join("\n")).toContain("split workers/backend.js into parts")
    expect(existsSync(join(dir, "workers/backend.js"))).toBe(false)
    expect(existsSync(join(dir, "workers/backend.js.part-000"))).toBe(true)
    expect(existsSync(join(dir, "workers/backend.js.part-001"))).toBe(true)
    expect((await checkPreviewAssets(dir)).problems).toEqual([])
    const loaded = await loadSplitPreviewFile("https://preview.test/workers/backend.js", {
      fetch: serve(dir),
    })
    expect(loaded.byteLength).toBe(big.byteLength)
    expect(Buffer.from(loaded).equals(Buffer.from(big))).toBe(true)
    // A file that was never split loads directly.
    expect(
      new TextDecoder().decode(
        await loadSplitPreviewFile("https://preview.test/index.html", { fetch: serve(dir) }),
      ),
    ).toBe("<h1>hi</h1>")
    // A tampered part is refused.
    writeFileSync(join(dir, "workers/backend.js.part-001"), bytes(5 * MIB, 9))
    await expect(
      loadSplitPreviewFile("https://preview.test/workers/backend.js", { fetch: serve(dir) }),
    ).rejects.toThrow("does not match its SHA-256")
  })

  test("#866 a named Preview over the limits fails before upload", async () => {
    let uploads = 0
    const result = await deployPreviewSite({
      site: "app",
      worker: "app",
      name: "pr-1",
      outdir: site({ "index.html": "x", "big.wasm": bytes(26 * MIB) }),
      commit: "c1",
      target: "pull-request",
      previews: {
        deploy: async () => {
          uploads++
          return { action: "skip" }
        },
        list: async () => [],
        remove: async () => {},
      },
      currentPullRequest: async () => ({
        state: "open",
        repository: "a/b",
        headRepository: "a/b",
        head: "c1",
      }),
    })
    expect(result.state).toBe("failed")
    expect(result.message).toContain("big.wasm is 26.0 MiB")
    expect(uploads).toBe(0)
  })
})

describe("#862 named mode: the checks run where there are no credentials", () => {
  const checksModule = (passing: boolean) => {
    const dir = site({})
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "checks.mjs")
    writeFileSync(
      path,
      `export default async (origin, fetch) => { const r = await fetch(origin + "/"); return [{ name: "home", ok: ${passing} && r.ok }] }`,
    )
    return path
  }

  test("gate-preview writes the gate's results; deploy-preview --gate honours them without running code", async () => {
    const dir = site({ "index.html": "<h1>hi</h1>" })
    const out = join(root, `gate-${dirs++}.json`)
    expect(
      await runPreviewCli(
        ["gate-preview", "--outdir", dir, "--checks", checksModule(false), "--out", out],
        io().io,
      ),
    ).toBe(0)
    const gate = JSON.parse(readFileSync(out, "utf8"))
    expect(gate).toEqual([{ name: "home", ok: false }])
    let uploads = 0
    const result = await deployPreviewSite({
      site: "app",
      worker: "app",
      name: "main",
      outdir: dir,
      commit: "c1",
      target: "branch",
      gate,
      previews: {
        deploy: async () => {
          uploads++
          return { action: "skip" }
        },
        list: async () => [],
        remove: async () => {},
      },
      currentPullRequest: async () => ({
        state: "open",
        repository: "a/b",
        headRepository: "a/b",
        head: "c1",
      }),
    })
    expect(result.state).toBe("failed")
    expect(result.message).toContain("nothing was uploaded")
    expect(uploads).toBe(0)
  })

  test("check-preview records the checks after upload in the result", async () => {
    const result = join(root, `result-${dirs++}.json`)
    writeFileSync(
      result,
      JSON.stringify({
        site: "app",
        worker: "app",
        name: "pr-1",
        state: "live",
        attempted: "c1",
        deployed: "c1",
        url: "https://pr-1.example.com",
      }),
    )
    const deps: PreviewCliDeps = {
      env: {},
      fetch: async () => new Response("ok"),
      sleep: async () => {},
    }
    const run = io()
    expect(
      await runPreviewCli(
        [
          "check-preview",
          "--result",
          result,
          "--checks",
          checksModule(false),
          "--timeout-seconds",
          "0",
        ],
        run.io,
        deps,
      ),
    ).toBe(0)
    const next = JSON.parse(readFileSync(result, "utf8"))
    expect(next.state).toBe("failing-checks")
    expect(next.after).toEqual([{ name: "home", ok: false }])
    expect(run.out.join("\n")).toContain("::warning::app preview deployed, but failing its checks")
    await runPreviewCli(
      ["check-preview", "--result", result, "--checks", checksModule(true)],
      io().io,
      deps,
    )
    expect(JSON.parse(readFileSync(result, "utf8")).state).toBe("live")
  })
})

/** An in-memory Vercel: files, deployments, aliases, and the aliased hosts serving them. */
const vercel = () => {
  const files = new Map<string, Uint8Array>()
  const deployments = new Map<string, Map<string, string>>()
  const aliases = new Map<string, { uid: string; deploymentId: string }>()
  const calls: string[] = []
  let next = 1
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(String(input), init)
    const url = new URL(request.url)
    const method = request.method
    if (url.host !== "api.vercel.com") {
      const alias = aliases.get(url.host)
      const deployment = alias ? deployments.get(alias.deploymentId) : undefined
      const sha = deployment?.get(url.pathname.slice(1))
      if (!sha) return new Response("not found", { status: 404 })
      return new Response(new Blob([files.get(sha) as Uint8Array<ArrayBuffer>]))
    }
    calls.push(`${method} ${url.pathname}`)
    if (request.headers.get("authorization") !== "Bearer vt")
      return new Response(null, { status: 403 })
    if (method === "POST" && url.pathname === "/v2/files") {
      const body = new Uint8Array(await request.arrayBuffer())
      const digest = request.headers.get("x-vercel-digest") ?? ""
      const actual = new Bun.CryptoHasher("sha1").update(body).digest("hex")
      if (digest !== actual)
        return Response.json({ error: { code: "bad_digest" } }, { status: 400 })
      files.set(digest, body)
      return Response.json({})
    }
    if (method === "POST" && url.pathname === "/v13/deployments") {
      const body = (await request.json()) as {
        files: { file: string; sha: string }[]
        project: string
      }
      const missing = body.files.filter((file) => !files.has(file.sha)).map((file) => file.sha)
      if (missing.length > 0)
        return Response.json({ error: { code: "missing_files", missing } }, { status: 400 })
      const id = `dpl_${next++}`
      deployments.set(id, new Map(body.files.map((file) => [file.file, file.sha])))
      return Response.json({ id, url: `${body.project}-${id}.vercel.app` })
    }
    const deployment = url.pathname.match(/^\/v13\/deployments\/(.+)$/)
    if (deployment && method === "GET")
      return deployments.has(deployment[1] as string)
        ? Response.json({ id: deployment[1], readyState: "READY" })
        : new Response(null, { status: 404 })
    if (deployment && method === "DELETE") {
      deployments.delete(deployment[1] as string)
      return Response.json({})
    }
    const setAlias = url.pathname.match(/^\/v2\/deployments\/(.+)\/aliases$/)
    if (setAlias && method === "POST") {
      const { alias } = (await request.json()) as { alias: string }
      aliases.set(alias, { uid: `als_${alias}`, deploymentId: setAlias[1] as string })
      return Response.json({ alias })
    }
    const getAlias = url.pathname.match(/^\/v4\/aliases\/(.+)$/)
    if (getAlias && method === "GET") {
      const found = aliases.get(decodeURIComponent(getAlias[1] as string))
      return found
        ? Response.json({ ...found, alias: getAlias[1] })
        : Response.json({ error: { code: "not_found" } }, { status: 404 })
    }
    const deleteAlias = url.pathname.match(/^\/v2\/aliases\/(.+)$/)
    if (deleteAlias && method === "DELETE") {
      for (const [name, value] of aliases) if (value.uid === deleteAlias[1]) aliases.delete(name)
      return Response.json({})
    }
    return new Response(null, { status: 418 })
  }
  return { fetch, files, deployments, aliases, calls }
}

describe("#863 previews hosted on Vercel", () => {
  const preview = (world: ReturnType<typeof vercel>) =>
    createVercelPreviewHosting({
      token: "vt",
      project: "prj_1",
      domain: "preview.example.com",
      fetch: world.fetch,
      sleep: async () => {},
    })
  const encode = (text: string) => new TextEncoder().encode(text)

  test("#863 acceptance: a per-PR preview, its live build/checks status and the PR link, with only Vercel credentials", async () => {
    const world = vercel()
    const host = preview(world)
    expect(await host.exists("app-pr-12")).toBe(false)
    const { url } = await host.deploy({
      name: "app-pr-12",
      files: [
        { path: "/index.html", bytes: encode("<h1>hi</h1>"), contentType: "text/html" },
        {
          path: "/version.json",
          bytes: encode(JSON.stringify({ version: "c1", builtAt: "2026-11-21T00:00:00.000Z" })),
          contentType: "application/json",
        },
      ],
      vars: {
        PREVIEW_PR: JSON.stringify({ number: 12, url: "https://github.com/acme/app/pull/12" }),
      },
    })
    expect(url).toBe("https://app-pr-12.preview.example.com")
    expect(await host.exists("app-pr-12")).toBe(true)
    const status = async () =>
      (await (await world.fetch(`${url}/__preview/status`)).json()) as PreviewStatusSnapshot
    expect((await status()).pr?.number).toBe(12)
    expect((await status()).deployed?.version).toBe("c1")
    expect(await (await world.fetch(`${url}/index.html`)).text()).toBe("<h1>hi</h1>")
    const config = JSON.parse(await (await world.fetch(`${url}/vercel.json`)).text())
    expect(config.rewrites[0].destination).toBe("/index.html")

    // A status write re-deploys from the files Vercel holds: only the generated files upload.
    world.calls.length = 0
    const uploadsBefore = world.files.size
    await host.setStatus("app-pr-12", {
      PREVIEW_BUILD: JSON.stringify({
        state: "building",
        version: "c2",
        at: "2026-11-21T01:00:00Z",
      }),
    })
    expect(parsePreviewBuild(JSON.stringify((await status()).build))?.state).toBe("building")
    await host.setStatus("app-pr-12", {
      PREVIEW_CHECKS: JSON.stringify({
        state: "passed",
        version: "c1",
        at: "2026-11-21T01:00:00Z",
      }),
    })
    const latest = await status()
    expect(latest.build?.state).toBe("building")
    expect(latest.checks?.state).toBe("passed")
    expect(latest.pr?.number).toBe(12)
    expect(world.files.size - uploadsBefore).toBeLessThanOrEqual(4)
    // The deployment the alias pointed at is deleted: one live deployment per preview.
    expect(world.deployments.size).toBe(1)
    const state = JSON.parse(await (await world.fetch(`${url}${VERCEL_PREVIEW_STATE}`)).text())
    expect(state.files.map((file: { file: string }) => file.file)).toContain("index.html")

    await host.remove("app-pr-12")
    expect(await host.exists("app-pr-12")).toBe(false)
    expect(world.deployments.size).toBe(0)
    await host.remove("app-pr-12")
  })

  test("#863 the CLI deploys a directory to Vercel (preflight, stamp) and prints its URL", async () => {
    const world = vercel()
    const deps: PreviewCliDeps = {
      env: { VERCEL_TOKEN: "vt", VERCEL_PROJECT_ID: "prj_1" },
      fetch: (input, init) => world.fetch(input, init),
      sleep: async () => {},
    }
    const dir = site({ "index.html": "<h1>hi</h1>" })
    const run = io()
    expect(
      await runPreviewCli(
        [
          "host-deploy",
          "--hosting",
          "vercel",
          "--name",
          "app-pr-3",
          "--outdir",
          dir,
          "--version",
          "c3",
          "--pr",
          "3",
          "--pr-url",
          "https://github.com/acme/app/pull/3",
        ],
        run.io,
        deps,
      ),
    ).toBe(0)
    expect(run.out).toContain("url=https://app-pr-3.vercel.app")
    const snapshot = (await (
      await world.fetch("https://app-pr-3.vercel.app/__preview/status")
    ).json()) as PreviewStatusSnapshot
    expect(snapshot.deployed?.version).toBe("c3")
    const exists = io()
    await runPreviewCli(
      ["host-exists", "--hosting", "vercel", "--name", "app-pr-3"],
      exists.io,
      deps,
    )
    expect(exists.out).toEqual(["exists=true"])
    const status = io()
    expect(
      await runPreviewCli(
        [
          "host-status",
          "--hosting",
          "vercel",
          "--name",
          "app-pr-3",
          "--values",
          JSON.stringify({
            PREVIEW_BUILD: JSON.stringify({
              state: "deployed",
              version: "c3",
              at: "2026-11-21T00:00:00Z",
            }),
          }),
        ],
        status.io,
        deps,
      ),
    ).toBe(0)
    expect(status.out.join("\n")).not.toContain("::warning::")
    expect(
      await runPreviewCli(
        ["host-remove", "--hosting", "vercel", "--name", "app-pr-3"],
        io().io,
        deps,
      ),
    ).toBe(0)
    expect(world.aliases.size).toBe(0)
  })

  test("#863 unsupported: host-* on Cloudflare, secrets on Vercel and missing credentials are explicit errors", async () => {
    const run = io()
    expect(
      await runPreviewCli(["host-exists", "--hosting", "cloudflare", "--name", "x"], run.io, {
        env: {},
        fetch,
      }),
    ).toBe(1)
    expect(run.err.join("\n")).toContain(
      "--hosting cloudflare is not supported by the host-* commands",
    )
    const missing = io()
    expect(
      await runPreviewCli(["host-exists", "--hosting", "vercel", "--name", "x"], missing.io, {
        env: {},
        fetch,
      }),
    ).toBe(1)
    expect(missing.err.join("\n")).toContain("VERCEL_TOKEN is required")
    const world = vercel()
    await expect(preview(world).setStatus("x", { STRIPE_SECRET_KEY: "sk" })).rejects.toThrow(
      "Vercel previews hold only PREVIEW_* status values",
    )
    // A status write never throws in the CLI: it warns.
    const warn = io()
    expect(
      await runPreviewCli(
        ["host-status", "--hosting", "vercel", "--name", "gone", "--values", "{}"],
        warn.io,
        {
          env: { VERCEL_TOKEN: "vt", VERCEL_PROJECT_ID: "p" },
          fetch: (i, init) => world.fetch(i, init),
        },
      ),
    ).toBe(0)
    expect(warn.out.join("\n")).toContain("::warning::preview status not written")
  })
})
