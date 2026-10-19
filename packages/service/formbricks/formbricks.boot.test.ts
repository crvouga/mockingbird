import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startFleet } from "@crvouga/mockingbird-adapter-node"
import { CORPUS_SURVEYS, ENVIRONMENT_ID, WORKSPACE_ID } from "./src/index.js"
import type { FormbricksRuntime } from "./src/runtime.js"
import { loadSurveysFile, serveTarget } from "./src/server.js"
import { SurveyClient } from "./test/consumer.js"

const APP = "http://formbricks.mock"
const COMMON = { adminKey: undefined, seed: undefined, onLog: undefined }
const OTHER = "cworkspace000000000000002"
const OLD_ENV = "cenvironment0000000000002"
const NPS = "csurveynps000000000000001"
const ONBOARDING = "csurveyonboarding00000001"
const FEEDBACK = "csurveyfeedback0000000001"
const CORPUS_IDS = CORPUS_SURVEYS.map((s) => s.id)

const dir = mkdtempSync(join(tmpdir(), "formbricks-boot-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const file = (name: string, body: unknown): string => {
  const path = join(dir, name)
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
  return path
}

const served = async (values: Record<string, string>, settings?: Record<string, unknown>) => {
  const runtime = (await serveTarget.create(values, {
    ...COMMON,
    ...(settings ? { settings } : {}),
  })) as FormbricksRuntime
  const send = (request: Request) => runtime.fetch(request)
  const ids = async (workspace: string) =>
    (await new SurveyClient(APP, workspace, send).surveys()).map((s) => s.id)
  const admin = (method: string, path: string, body?: unknown) =>
    runtime.fetch(
      new Request(`${APP}/__admin${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return { runtime, send, ids, admin }
}

describe("serve --settings boots the service with its own settings", () => {
  const BOOT = {
    workspaces: [OTHER],
    legacyEnvironmentIds: { [OLD_ENV]: OTHER },
    validation: "finished-validates-all",
  }

  test("S1: the settings are every namespace's defaults, and the legacy environment id resolves", async () => {
    const { ids, admin, send } = await served({}, BOOT)
    expect(await (await admin("GET", "/settings")).json()).toMatchObject(BOOT)
    expect(await ids(OLD_ENV)).toContain(NPS)
    expect(await ids(OTHER)).toContain(NPS)
    // The default workspace is not configured any more, so it is not served.
    expect(
      (await send(new Request(`${APP}/api/v1/client/${WORKSPACE_ID}/environment`))).status,
    ).toBe(404)
    // A namespace made later starts from them too.
    const second = await send(
      new Request(`${APP}/__admin/settings?namespace=worker-2`, { method: "GET" }),
    )
    expect(await second.json()).toMatchObject(BOOT)
  })

  test("S2: a reset returns to the boot settings, not the built-in ones", async () => {
    const { admin, runtime } = await served({}, BOOT)
    await admin("PUT", "/settings", { workspaces: ["cworkspace000000000000009"] })
    await runtime.reset()
    expect(await (await admin("GET", "/settings")).json()).toMatchObject(BOOT)
  })

  test("S3: --workspace-id adds to the booted workspaces", async () => {
    const { admin } = await served({ "workspace-id": "cworkspace000000000000003" }, BOOT)
    expect(
      ((await (await admin("GET", "/settings")).json()) as { workspaces: string[] }).workspaces,
    ).toEqual(["cworkspace000000000000003", OTHER])
  })

  test("S4: the settings schema refuses what is not a setting, naming the field", () => {
    const parse = serveTarget.parseSettings as (s: Record<string, unknown>) => unknown
    expect(parse(BOOT)).toEqual(BOOT)
    expect(() => parse({ workspace: ["x"] })).toThrow('unknown setting "workspace"')
    expect(() => parse({ workspaces: "x" })).toThrow("workspaces must be an array of strings")
    expect(() => parse({ legacyEnvironmentIds: { a: 1 } })).toThrow("legacyEnvironmentIds")
    expect(() => parse({ apiKeys: [1] })).toThrow("apiKeys must be an array of strings")
    expect(() => parse({ webhookId: 1 })).toThrow("webhookId must be a string")
    expect(() => parse({ contactsEnabled: "yes" })).toThrow("contactsEnabled must be a boolean")
    expect(() => parse({ validation: "strict" })).toThrow('validation must be "present-only"')
  })

  test("S5: a fleet entry's settings and surveys option boot the service, and a bad one stops the fleet", async () => {
    const path = file("fleet-surveys.json", [{ id: "cfleetsurvey0000000000001", name: "Fleet" }])
    const fleet = await startFleet(
      {
        log: "off",
        services: {
          formbricks: { port: 0, settings: BOOT, options: { surveys: path } },
        },
      },
      { load: async () => serveTarget },
    )
    try {
      const url = fleet.manifest.services.formbricks?.url as string
      const environment = (await (
        await fetch(`${url}/api/v1/client/${OLD_ENV}/environment`)
      ).json()) as {
        data: { data: { surveys: { id: string }[] } }
      }
      expect(environment.data.data.surveys.map((s) => s.id)).toContain("cfleetsurvey0000000000001")
    } finally {
      await fleet.close()
    }
    await expect(
      startFleet(
        { log: "off", services: { formbricks: { port: 0, settings: { validation: "strict" } } } },
        { load: async () => serveTarget },
      ),
    ).rejects.toThrow(/service formbricks: .*validation must be/)
  })
})

describe("serve --surveys appends to the corpus surveys", () => {
  const MINE = {
    id: "cmysurvey00000000000001",
    name: "Cancellation",
    blocks: [],
  }

  test("V1: the file's surveys are served beside every corpus survey", async () => {
    const { ids, admin } = await served({ surveys: file("mine.json", [MINE]) })
    expect(await ids(WORKSPACE_ID)).toEqual([NPS, ONBOARDING, FEEDBACK, MINE.id])
    const listed = (await (await admin("GET", "/surveys")).json()) as {
      surveys: { id: string; type: string; status: string; workspaceId: string | null }[]
    }
    expect(listed.surveys.map((s) => s.id)).toEqual([...CORPUS_IDS, MINE.id])
    // Defaults as `PUT /__admin/surveys` gives them; no workspace means shared.
    expect(listed.surveys.at(-1)).toMatchObject({
      type: "app",
      status: "inProgress",
      workspaceId: null,
    })
  })

  test("V2: a survey whose id is taken is skipped, the corpus one is kept", async () => {
    const path = file("dupes.json", {
      surveys: [{ id: NPS, name: "Imposter" }, MINE, { ...MINE, name: "Second copy" }],
    })
    const { admin } = await served({ surveys: path })
    const listed = (await (await admin("GET", "/surveys")).json()) as {
      surveys: { id: string; name: string }[]
    }
    expect(listed.surveys.filter((s) => s.id === NPS).map((s) => s.name)).toEqual([
      "Net Promoter Score (NPS)",
    ])
    expect(listed.surveys.filter((s) => s.id === MINE.id).map((s) => s.name)).toEqual([
      "Cancellation",
    ])
    expect(listed.surveys).toHaveLength(CORPUS_IDS.length + 1)
  })

  test("V3: a survey with no workspaceId is served by every workspace; one with a workspaceId by that one", async () => {
    const bound = { id: "cbound00000000000000001", name: "Bound", workspaceId: OTHER }
    const legacy = { id: "clegacy0000000000000001", name: "Legacy", environmentId: ENVIRONMENT_ID }
    const { ids } = await served(
      { surveys: file("scoped.json", [MINE, bound, legacy]), "workspace-id": OTHER },
      undefined,
    )
    expect(await ids(WORKSPACE_ID)).toContain(MINE.id)
    expect(await ids(OTHER)).toContain(MINE.id)
    expect(await ids(OTHER)).toContain(bound.id)
    expect(await ids(WORKSPACE_ID)).not.toContain(bound.id)
    // The legacy environment id is resolved to its workspace.
    expect(await ids(WORKSPACE_ID)).toContain(legacy.id)
    expect(await ids(OTHER)).not.toContain(legacy.id)
  })

  test("V4: the surveys survive a reset", async () => {
    const { ids, admin, runtime } = await served({ surveys: file("keep.json", [MINE]) })
    await admin("PUT", "/surveys", [{ id: "cextra000000000000000001", name: "Extra" }])
    await runtime.reset()
    const after = await ids(WORKSPACE_ID)
    expect(after).toContain(MINE.id)
    expect(after).not.toContain("cextra000000000000000001")
  })

  test("V5: --surveys-mode replace makes the file the whole corpus", async () => {
    const { ids } = await served({ surveys: file("only.json", [MINE]), "surveys-mode": "replace" })
    expect(await ids(WORKSPACE_ID)).toEqual([MINE.id])
    const appended = await served({ surveys: file("only2.json", [MINE]), "surveys-mode": "append" })
    expect(await appended.ids(WORKSPACE_ID)).toContain(NPS)
  })

  test("V6: a surveys file that cannot be used stops the command and names the problem", () => {
    const create = (values: Record<string, string>) => () => serveTarget.create(values, COMMON)
    expect(create({ surveys: join(dir, "missing.json") })).toThrow("formbricks surveys not found")
    expect(create({ surveys: file("bad.json", "[") })).toThrow("formbricks surveys")
    expect(create({ surveys: file("nobody.json", { items: [] }) })).toThrow(
      "expected [survey] or {surveys: [survey]}",
    )
    expect(create({ surveys: file("noid.json", [{ name: "x" }]) })).toThrow(
      "surveys[0].id must be a non-empty string",
    )
    expect(create({ surveys: file("noname.json", [{ id: "a" }]) })).toThrow(
      "surveys[0].name must be a string",
    )
    expect(create({ surveys: file("ok.json", [MINE]), "surveys-mode": "merge" })).toThrow(
      '--surveys-mode must be "append" or "replace"',
    )
    expect(create({ "surveys-mode": "replace" })).toThrow("--surveys-mode needs --surveys")
    expect(loadSurveysFile(file("ok2.json", [MINE])).map((s) => s.id)).toEqual([
      ...CORPUS_IDS,
      MINE.id,
    ])
  })
})
