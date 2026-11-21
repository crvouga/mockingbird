/**
 * Third-party license notices for what a build inlines (a browser bundle, the compiled
 * stylesheet). Pages and published services carry these files as strings, with no node_modules
 * beside them, so the licenses must travel inside them (HeroUI and React Aria are Apache-2.0).
 */
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

/** The nearest package.json above `file` that names a package. */
async function owningPackage(file: string): Promise<string | undefined> {
  let directory = dirname(resolve(file))
  while (directory !== dirname(directory)) {
    const manifest = resolve(directory, "package.json")
    if (existsSync(manifest)) {
      const pkg = JSON.parse(await readFile(manifest, "utf8")) as { name?: string }
      if (pkg.name) return directory
    }
    directory = dirname(directory)
  }
  return undefined
}

/** `name@version` → license text, for every package under node_modules that `files` come from. */
export async function collectNotices(files: Iterable<string>): Promise<Map<string, string>> {
  const notices = new Map<string, string>()
  const seen = new Set<string>()
  for (const file of [...files].sort()) {
    if (!file.includes("node_modules/")) continue
    const directory = await owningPackage(file)
    if (!directory || seen.has(directory)) continue
    seen.add(directory)
    const pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
      name: string
      version?: string
    }
    const key = `${pkg.name}@${pkg.version}`
    if (notices.has(key)) continue
    const licenses = (await readdir(directory))
      .filter((name) => /^licen[sc]e(?:$|[.-])/i.test(name))
      .sort()
    const text = await Promise.all(
      licenses.map((name) => readFile(resolve(directory, name), "utf8")),
    )
    if (text.length) notices.set(key, text.join("\n\n"))
  }
  return notices
}

/** The notices as one `/*! … *\/` comment, which minifiers and bundlers keep. */
export function noticeComment(title: string, notices: Map<string, string>): string {
  const body = [...notices].map(([name, license]) => `${name}\n${license}`).join("\n\n")
  return `/*! ${title}\n${body.replace(/\*\//g, "* /")}\n*/\n`
}
