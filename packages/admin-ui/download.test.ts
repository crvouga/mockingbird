import { describe, expect, test } from "bun:test"
import { type DownloadEnvironment, downloadJson } from "./src/download.js"

/** A fake document, URL and timer that record what a browser would see, in order. */
const fakeBrowser = () => {
  const events: string[] = []
  const timers: (() => void)[] = []
  const body = {
    children: new Set<unknown>(),
    append(node: unknown) {
      this.children.add(node)
      events.push("append")
    },
  }
  const environment: DownloadEnvironment = {
    document: {
      body,
      createElement: () => {
        const link = {
          href: "",
          download: "",
          style: { display: "" },
          click: () => events.push(`click attached=${body.children.has(link)}`),
          remove: () => {
            body.children.delete(link)
            events.push("remove")
          },
        }
        return link
      },
    },
    URL: {
      createObjectURL: () => "blob:snapshot",
      revokeObjectURL: (url: string) => events.push(`revoke ${url}`),
    },
    setTimeout: (run: () => void) => {
      timers.push(run)
      events.push("schedule")
    },
  }
  return { environment, events, timers }
}

describe("snapshot download", () => {
  test("the link is in the document when clicked and its URL outlives the click", () => {
    const { environment, events, timers } = fakeBrowser()
    downloadJson("snap_1.json", { records: [] }, environment)
    expect(events).toEqual(["append", "click attached=true", "remove", "schedule"])
    for (const run of timers) run()
    expect(events.at(-1)).toBe("revoke blob:snapshot")
  })
})
