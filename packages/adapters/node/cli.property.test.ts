import { expect, test } from "bun:test"
import fc from "fast-check"
import { type CliSpec, listen, runCli } from "./src/index.js"

const quiet = async <T>(
  run: () => Promise<T>,
): Promise<{ result: T; out: string; err: string }> => {
  const log = console.log
  const error = console.error
  let out = ""
  let err = ""
  console.log = (...args: unknown[]) => {
    out += `${args.join(" ")}\n`
  }
  console.error = (...args: unknown[]) => {
    err += `${args.join(" ")}\n`
  }
  try {
    return { result: await run(), out, err }
  } finally {
    console.log = log
    console.error = error
  }
}

const spec = (calls: { name: string; values: unknown; positionals: string[] }[]): CliSpec => ({
  bin: "tool",
  description: "a test tool",
  commands: {
    corpus: {
      summary: "one word",
      run: async (values, positionals) => {
        calls.push({ name: "corpus", values, positionals })
        return 0
      },
    },
    "corpus pull": {
      summary: "two words",
      options: {
        out: { type: "string", description: "where" },
        force: { type: "boolean", description: "overwrite" },
      },
      run: async (values, positionals) => {
        calls.push({ name: "corpus pull", values, positionals })
        return 3
      },
    },
  },
})

test("two-word commands win over one-word ones, with their own options", async () => {
  const calls: { name: string; values: unknown; positionals: string[] }[] = []
  const { result } = await quiet(() =>
    runCli(spec(calls), ["corpus", "pull", "--out", "x.json", "--force", "extra"]),
  )
  expect(result).toBe(3)
  expect(calls).toEqual([
    { name: "corpus pull", values: { out: "x.json", force: true }, positionals: ["extra"] },
  ])
  await quiet(() => runCli(spec(calls), ["corpus", "diff"]))
  expect(calls.at(-1)).toEqual({ name: "corpus", values: {}, positionals: ["diff"] })
})

test("help, unknown commands and unknown flags", async () => {
  const calls: { name: string; values: unknown; positionals: string[] }[] = []
  const help = await quiet(() => runCli(spec(calls), ["--help"]))
  expect(help.result).toBe(0)
  expect(help.out).toContain("corpus pull")
  const sub = await quiet(() => runCli(spec(calls), ["corpus", "pull", "--help"]))
  expect(sub.out).toContain("--out")
  expect((await quiet(() => runCli(spec(calls), ["nope"]))).result).toBe(2)
  expect((await quiet(() => runCli(spec(calls), ["corpus", "pull", "--bogus"]))).result).toBe(2)
  expect(calls).toEqual([])
})

test("listen binds the address it reports and closes cleanly", async () => {
  await fc.assert(
    fc.asyncProperty(fc.stringMatching(/^\/[a-z]{0,8}$/), async (path) => {
      const server = await listen({
        fetch: async (request) => new Response(new URL(request.url).pathname),
      })
      try {
        expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
        expect(await (await fetch(`${server.url}${path}`)).text()).toBe(path === "" ? "/" : path)
      } finally {
        await server.close()
      }
    }),
    { numRuns: 10 },
  )
})
