/** Ship shared declarations beside bundled engines without a private-package dependency. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

export async function inlineCoreTypes(packageDir: string): Promise<void> {
  const dist = join(packageDir, "dist")
  const destination = join(dist, "shared", "core")
  const core = join(import.meta.dir, "..", "packages", "core", "dist")
  await mkdir(destination, { recursive: true })
  for (const file of await readdir(core)) {
    if (file.endsWith(".d.ts")) {
      await writeFile(join(destination, file), await readFile(join(core, file)))
    }
  }
  // Database consumers must not acquire Fetch/DOM type requirements from unused core APIs.
  await writeFile(
    join(destination, "index.d.ts"),
    'export * from "./durability.js"\nexport * from "./durability-browser.js"\n',
  )
  const files = new Bun.Glob("**/*.d.ts")
  for await (const file of files.scan({ cwd: dist, absolute: true })) {
    const source = await readFile(file, "utf8")
    if (!source.includes('"@crvouga/mockingbird-core"')) continue
    let target = relative(dirname(file), join(destination, "index.js")).replaceAll("\\", "/")
    if (!target.startsWith(".")) target = `./${target}`
    await writeFile(file, source.replaceAll('"@crvouga/mockingbird-core"', JSON.stringify(target)))
  }
}
