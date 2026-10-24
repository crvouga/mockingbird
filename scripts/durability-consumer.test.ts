import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("database durability declarations work without DOM types or private workspace dependencies", async () => {
  const root = resolve(import.meta.dir, "..")
  const directory = await mkdtemp(join(tmpdir(), "mockingbird-durability-types-"))
  try {
    const imports = ["sqlite", "postgres"].map((service, index) => {
      const entry = JSON.stringify(join(root, "packages", "service", service, "dist", "index.js"))
      return `import { Database as Database${index}, openDurableDatabase as open${index}, openBufferedDurableDatabase as buffered${index},
        MemoryDurabilityBackend as Memory${index}, withDurability as wrap${index} } from ${entry};
      const db${index} = new Database${index}();
      db${index}.exec("SELECT 1");
      const saved${index} = open${index}({ key: "test", backend: new Memory${index}() });
      const background${index} = buffered${index}({ key: "buffered", backend: new Memory${index}(), flushIntervalMs: 1000,
        scheduler: { schedule: () => 0, cancel: () => {} } });
      void background${index}.then(handle => { const pending: boolean = handle.pending; void pending; return handle.flush(); });
      const api${index} = wrap${index}({ fetch: async (request: number) => String(request) }, { flush: async () => {} });
      const reply${index}: Promise<string> = api${index}.fetch(1);
      void saved${index}; void reply${index};`
    })
    await writeFile(join(directory, "consumer.mts"), imports.join("\n"))
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2022"],
          types: [],
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["consumer.mts"],
      }),
    )
    const result = Bun.spawnSync([
      join(root, "node_modules", ".bin", "tsc"),
      "-p",
      join(directory, "tsconfig.json"),
    ])
    expect(result.stdout.toString() + result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
    // The copied declaration graph must not resolve a private workspace package by accident.
    for (const service of ["sqlite", "postgres"]) {
      const files = new Bun.Glob("**/*.d.ts")
      for await (const file of files.scan({
        cwd: join(root, "packages", "service", service, "dist"),
        absolute: true,
      })) {
        expect(await Bun.file(file).text()).not.toContain('from "@crvouga/mockingbird-core"')
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
