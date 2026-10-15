import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checks } from "./checks.ts"
import { parseArgs, readReports } from "./cli.ts"
import { catalogHealth, deploymentRevisionHealth } from "./docs.ts"
import { runHealth, scheduleWindow } from "./github.ts"
import { command, inspect, request, safeError, type WorkflowRun } from "./io.ts"
import { latestReleaseTags, type Packument, packageHealth } from "./npm.ts"
import { needsAttention, renderHealth, report } from "./report.ts"
import { releaseConfiguration } from "./repository.ts"
import { paritySecretMappings, referencedSecrets } from "./secrets.ts"

const name = "@crvouga/mockingbird-service-example"
const document: Packument = {
  name,
  "dist-tags": { latest: "1.2.0" },
  versions: {
    "1.2.0": {
      repository: "https://github.com/crvouga/mockingbird",
      dist: { tarball: "https://registry.npmjs.org/example.tgz", integrity: "sha512-test-fixture" },
    },
  },
}

describe("npm health", () => {
  test("compares numeric stable release versions and ignores peeled refs and prereleases", () => {
    const refs = ["1.9.0", "1.12.0", "1.12.0^{}", "1.13.0-beta", "1.2.0"]
      .map((version) => `abc\trefs/tags/${name}@${version}`)
      .join("\n")
    expect(latestReleaseTags(refs).get(name)).toBe("1.12.0")
  })
  test("missing packages, dist tags, bad metadata, deprecations, broken pins, and unpublished tags fail", () => {
    expect(packageHealth(name, document, "1.2.0")[0]?.status).toBe("ok")
    for (const doc of [
      null,
      {},
      { ...document, "dist-tags": {} },
      { ...document, versions: { "1.2.0": { deprecated: "retired" } } },
      {
        ...document,
        versions: {
          "1.2.0": { ...document.versions?.["1.2.0"], dependencies: { helper: "workspace:*" } },
        },
      },
    ])
      expect(packageHealth(name, doc, "1.2.0")[0]?.status).toBe("fail")
    expect(packageHealth(name, document, "1.3.0")[0]?.message).toContain("missing from npm")
    expect(packageHealth(name, document, null)[0]?.message).toContain("no stable release tag")
    expect(packageHealth(name, document)[0]?.message).not.toContain("release tag agrees")
  })
})

describe("health reports", () => {
  test("unknown, pending, failed, and empty observations never produce green health", () => {
    for (const status of ["unknown", "pending", "fail"] as const) {
      const value = report("check", "Check", [{ id: "resource", status, message: "reason" }])
      expect(needsAttention(value)).toBe(true)
      expect(renderHealth([value])).toContain("ATTENTION")
      expect(renderHealth([value])).toContain("resource: reason")
    }
    expect(needsAttention(report("empty", "Empty", []))).toBe(true)
    const ready = report("check", "Check", [
      { id: "ready", status: "ok", message: "healthy" },
      { id: "optional", status: "optional", message: "not configured" },
    ])
    expect(needsAttention(ready)).toBe(false)
    expect(renderHealth([ready])).not.toContain("ready: healthy")
    expect(renderHealth([ready], true)).toContain("ready: healthy")
  })
  test("missing, malformed, mismatched, and empty task reports cannot reuse a stale pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "mockingbird-health-test-"))
    try {
      for (const content of [
        "invalid JSON",
        JSON.stringify(report("other", "Other", [])),
        JSON.stringify(report("npm", "npm", [])),
        JSON.stringify({ id: "npm", items: [null] }),
      ]) {
        writeFileSync(join(dir, "npm.json"), content)
        expect(readReports(dir, ["npm"])[0]?.items?.[0]?.status).toBe("unknown")
      }
      expect(readReports(dir, ["docs"])[0]?.items?.[0]?.status).toBe("unknown")
      writeFileSync(
        join(dir, "npm.json"),
        JSON.stringify(report("npm", "npm", [{ id: "fixture", status: "ok", message: "checked" }])),
      )
      expect(readReports(dir, ["npm"])[0]?.items?.[0]?.status).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test("all seven live tasks are uncached and compose through Turbo independently", () => {
  const turbo = JSON.parse(readFileSync(new URL("../../turbo.json", import.meta.url), "utf8")) as {
    tasks: Record<string, { cache?: boolean; dependsOn?: string[]; passThroughEnv?: string[] }>
  }
  expect(turbo.tasks["//#health:all"]?.dependsOn).toEqual(
    checks.map((check) => `//#health:${check.id}`),
  )
  for (const check of checks) {
    const task = turbo.tasks[`//#health:${check.id}`]
    expect(task?.cache).toBe(false)
    expect(task?.dependsOn ?? []).toEqual([])
    expect(task?.passThroughEnv).toContain("MOCKINGBIRD_HEALTH_REPORT_DIR")
  }
  expect(parseArgs(["--", "docs", "npm", "--json"]).selected.map((check) => check.id)).toEqual([
    "npm",
    "docs",
  ])
  expect(() => parseArgs(["--invalid"])).toThrow("Unknown")
  expect(parseArgs([]).interactive).toBe(false)
})

test("a check that throws becomes unknown without aborting independent observations", async () => {
  const values = await Promise.all([
    inspect("blocked", async () => {
      throw new Error("access denied")
    }),
    inspect("independent", async () => ({ id: "independent", status: "ok", message: "up" })),
  ])
  expect(values.map((value) => value.status)).toEqual(["unknown", "ok"])
})

test("GitHub failures, skipped work, and pending runs are distinct from success", () => {
  const run: WorkflowRun = {
    id: 1,
    head_sha: "abc",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example",
    created_at: "2026-10-15T00:00:00Z",
    updated_at: "2026-10-15T00:00:00Z",
    event: "push",
  }
  expect(runHealth("run", run).status).toBe("ok")
  expect(runHealth("run", { ...run, conclusion: "failure" }).status).toBe("fail")
  expect(runHealth("run", { ...run, conclusion: "skipped" }).status).toBe("fail")
  expect(runHealth("run", { ...run, status: "queued", conclusion: null }).status).toBe("pending")
  expect(runHealth("run", undefined).status).toBe("unknown")
  expect(scheduleWindow("17 */6 * * *")).toBe(13 * 60 * 60 * 1000)
  expect(scheduleWindow("17 6 * * 1")).toBe(337 * 60 * 60 * 1000)
})

test("catalog omissions, duplicates, and invalid responses identify broken docs deployments", () => {
  expect(catalogHealth([name], { services: [{ package: name }] }).status).toBe("ok")
  expect(catalogHealth([name], { services: [] }).message).toContain(name)
  expect(catalogHealth([name], { services: [{ package: name }, { package: name }] }).status).toBe(
    "fail",
  )
  expect(catalogHealth([name], "not a catalog").status).toBe("fail")
})

test("deployment availability is never substituted for immutable revision evidence", () => {
  const sha = "a".repeat(40)
  expect(deploymentRevisionHealth(null, sha).status).toBe("unknown")
  expect(deploymentRevisionHealth("latest", sha).status).toBe("unknown")
  expect(deploymentRevisionHealth(sha).status).toBe("unknown")
  expect(deploymentRevisionHealth(sha, sha).status).toBe("ok")
  expect(deploymentRevisionHealth(sha, "b".repeat(40)).status).toBe("fail")
})

test("job permission overrides cannot inherit OIDC accidentally", () => {
  expect(
    releaseConfiguration({
      permissions: { "id-token": "write", contents: "write" },
      jobs: { release: {} },
    }),
  ).toEqual([])
  expect(
    releaseConfiguration({
      permissions: { "id-token": "write" },
      jobs: { release: { permissions: { contents: "write" } } },
    }),
  ).toContain("Release lacks id-token: write")
  expect(
    releaseConfiguration({
      jobs: {
        release: {
          permissions: { "id-token": "write", contents: "write" },
          environment: "prod",
          steps: [{ with: { "registry-url": "https://registry.npmjs.org" } }],
        },
      },
    }),
  ).toHaveLength(2)
})

test("secret discovery extracts names without reading values or requiring GITHUB_TOKEN", () => {
  expect(
    referencedSecrets("secrets.API_KEY secrets['OTHER_KEY'] secrets.API_KEY secrets.GITHUB_TOKEN"),
  ).toEqual(["API_KEY", "OTHER_KEY"])
  expect(safeError("npm_abcdefghijklmnopqrstuvwxyz Bearer fixture-session")).not.toContain(
    "fixture-session",
  )
  const source =
    "jobs:\n  parity:\n    steps:\n      - env:\n          API_KEY: secrets.API_KEY\n          WRONG_ENV: secrets.OTHER_KEY\n"
  expect([...paritySecretMappings(source)]).toEqual(["API_KEY"])
})

test("HTTP probes retry transient failures and reject stuck subprocesses", async () => {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("", { status: ++calls === 1 ? 503 : 200 }),
  })
  try {
    expect((await request(`http://127.0.0.1:${server.port}`)).status).toBe(200)
    expect(calls).toBe(2)
    await expect(command([process.execPath, "-e", "await Bun.sleep(10000)"], 20)).rejects.toThrow(
      "exited",
    )
  } finally {
    server.stop(true)
  }
})
