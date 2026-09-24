/**
 * SDK drop-in: the official Python SDK the consumer app's Python chat service pins
 * (llama-cloud-services 0.6.88 over llama-cloud 0.1.45 and llama-index-core 0.14.10), driven
 * through that service's real `LlamaCloudClient` file, against the served mock.
 *
 * Python is not part of this repo's toolchain, so the test runs only when
 * `MOCKINGBIRD_LLAMACLOUD_PYTHON` points at an interpreter with those packages installed:
 *
 *   uv venv /tmp/llama && VIRTUAL_ENV=/tmp/llama uv pip install \
 *     llama-cloud-services==0.6.88 llama-cloud==0.1.45 llama-index-core==0.14.10
 *   MOCKINGBIRD_LLAMACLOUD_PYTHON=/tmp/llama/bin/python bun test llamacloud.sdk
 *
 * `MOCKINGBIRD_LLAMACLOUD_PY_CLIENT` must also point at that service's `llamacloud_client.py`
 * (the consumer app's own source; it is not in this repo).
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createServer } from "./src/server.js"

const PYTHON = process.env.MOCKINGBIRD_LLAMACLOUD_PYTHON
const CLIENT = process.env.MOCKINGBIRD_LLAMACLOUD_PY_CLIENT
const enabled =
  PYTHON !== undefined && existsSync(PYTHON) && CLIENT !== undefined && existsSync(CLIENT)

type Outcome = {
  error: string | null
  available: boolean
  total: number
  sources: {
    content: string
    score: number
    title: string | null
    source_id: string | null
    document_id: string | null
  }[]
}

const run = async (base: string, index: string, project: string, query: string) => {
  const child = Bun.spawn(
    [
      PYTHON as string,
      join(import.meta.dir, "test/sdk_check.py"),
      CLIENT as string,
      base,
      "llx-python",
      index,
      project,
      query,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`python exited ${code}: ${err}`)
  return JSON.parse(out.trim().split("\n").at(-1) as string) as Outcome
}

describe.skipIf(!enabled)("llama_cloud_services SDK (via the Python chat client)", () => {
  test(
    "LlamaCloudIndex(name, project_name).as_retriever().aretrieve() resolves the index and retrieves",
    async () => {
      const server = await createServer({
        pipelines: [{ name: "python-kb", projectName: "Default" }],
      })
      try {
        const put = await fetch(`${server.url}/__admin/retrieval`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            match: { contains: "vitamin d" },
            nodes: [{ text: "Vitamin D supports bone health.", metadata: { title: "Vitamin D" } }],
          }),
        })
        expect(put.status).toBe(200)
        const hit = await run(server.url, "python-kb", "Default", "What does vitamin D do?")
        expect(hit.error).toBeNull()
        expect(hit.available).toBe(true)
        expect(hit.sources).toEqual([
          {
            content: "Vitamin D supports bone health.",
            score: 1,
            title: "Vitamin D",
            source_id: "scripted_0",
            document_id: null,
          },
        ])
        // The exact call sequence the SDK made, from the journal.
        const journal = (await (await fetch(`${server.url}/__admin/requests`)).json()) as {
          requests: { operationId: string }[]
        }
        expect(journal.requests.map((r) => r.operationId)).toEqual([
          "ListProjects",
          "SearchPipelines",
          "GetPipeline",
          "GetProject",
          "RunSearch",
        ])

        // The Python client's default project name is "default" (lowercase), the backend's is "Default":
        // with no such project the SDK raises and the client degrades to empty results.
        const miss = await run(server.url, "python-kb", "default", "vitamin d")
        expect(miss.available).toBe(false)
        expect(miss.error).toContain("No project found with name default")
        expect(miss.total).toBe(0)

        // Unscripted: the term-overlap ranking over documents our backend upserted.
        await fetch(`${server.url}/__admin/retrieval`, { method: "DELETE" })
        const pipelines = (await (
          await fetch(`${server.url}/api/v1/pipelines?project_name=Default`, {
            headers: { authorization: "Bearer llx-python" },
          })
        ).json()) as { id: string }[]
        await fetch(`${server.url}/api/v1/pipelines/${pipelines[0]?.id}/documents`, {
          method: "PUT",
          headers: { authorization: "Bearer llx-python", "content-type": "application/json" },
          body: JSON.stringify([
            {
              id: "magnesium-sleep",
              text: "# Magnesium and sleep\n\nMagnesium glycinate may improve sleep quality.",
              metadata: { file_name: "magnesium-sleep.md", title: "Magnesium and sleep" },
            },
          ]),
        })
        const ranked = await run(server.url, "python-kb", "Default", "magnesium for sleep")
        expect(ranked.sources.map((s) => [s.title, s.document_id, s.score])).toEqual([
          ["Magnesium and sleep", "magnesium-sleep", 1],
        ])

        const unknown = await run(server.url, "no-such-index", "Default", "vitamin d")
        expect(unknown.error).toContain("Unknown index name no-such-index")
      } finally {
        await server.close()
      }
    },
    { timeout: 120_000 },
  )
})
