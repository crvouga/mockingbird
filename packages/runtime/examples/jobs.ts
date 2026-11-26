import { Collection, defineHttpService, IdSequence } from "@crvouga/mockingbird-runtime/authoring"

export const { createRuntime, serveTarget } = defineHttpService({
  name: "jobs",
  version: "1.0.0",
  document: {
    openapi: "3.1.0",
    info: { title: "Example job queue", version: "1" },
    paths: {
      "/jobs": {
        post: { operationId: "enqueue", responses: { "201": { description: "Queued" } } },
        get: { operationId: "count", responses: { "200": { description: "Queue size" } } },
      },
    },
  },
  state: [{ name: "jobs" }],
  handlers({ sqlite, namespace, clock }) {
    const jobs = new Collection<{ queuedAt: number }>(sqlite, namespace, "jobs")
    const ids = new IdSequence(sqlite, namespace)
    return {
      enqueue() {
        const id = ids.next("job")
        jobs.insert(id, { queuedAt: clock.now() })
        return Response.json({ id }, { status: 201 })
      },
      count: () => Response.json({ count: jobs.count() }),
    }
  },
})
