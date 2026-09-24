/**
 * Agent commands live once in `.agents/commands/<name>.md` and are symlinked into every
 * agent harness, so /pr-ready (and friends) is the same file in Claude Code, Cursor, Codex,
 * OpenCode, Windsurf, and GitHub Copilot. Edit the canonical file; never the links.
 *
 *   bun run agents:sync     create / repair the links
 *   bun run check:agents    fail if any link is missing, stale, or not a symlink (CI)
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"

const root = join(import.meta.dir, "..")
const SOURCE_DIR = ".agents/commands"

/** Where each harness discovers project commands, as a path for command `name`. */
const HARNESSES: Array<{ harness: string; path: (name: string) => string }> = [
  { harness: "Claude Code", path: (n) => `.claude/commands/${n}.md` },
  { harness: "Cursor", path: (n) => `.cursor/commands/${n}.md` },
  { harness: "OpenCode", path: (n) => `.opencode/command/${n}.md` },
  { harness: "Windsurf", path: (n) => `.windsurf/workflows/${n}.md` },
  { harness: "GitHub Copilot", path: (n) => `.github/prompts/${n}.prompt.md` },
  // Agent Skills standard (Codex, and any harness reading .agents/skills). Needs `name:` frontmatter.
  { harness: "Codex / Agent Skills", path: (n) => `.agents/skills/${n}/SKILL.md` },
]

const check = process.argv.includes("--check")
const names = readdirSync(join(root, SOURCE_DIR))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -".md".length))
  .sort()

const problems: string[] = []
let changed = 0

for (const name of names) {
  const source = join(root, SOURCE_DIR, `${name}.md`)
  const text = await Bun.file(source).text()
  if (!new RegExp(`^---\\n[\\s\\S]*?^name: ${name}$[\\s\\S]*?^description: .+$`, "m").test(text)) {
    problems.push(`${SOURCE_DIR}/${name}.md: frontmatter needs "name: ${name}" and a description`)
  }
  for (const { harness, path } of HARNESSES) {
    const link = join(root, path(name))
    const target = relative(dirname(link), source)
    const stat = existsSync(link) || isLink(link) ? lstatSync(link) : null
    if (stat?.isSymbolicLink() && readlinkSync(link) === target) continue
    if (check) {
      problems.push(`${path(name)} (${harness}) must be a symlink to ${target}`)
      continue
    }
    if (stat) rmSync(link, { force: true })
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
    changed++
  }
}

// Dangling links left behind by a removed or renamed canonical command.
const harnessRoots = new Set(HARNESSES.map(({ path }) => path("*").split("/*")[0] as string))
for (const dir of harnessRoots) {
  if (!existsSync(join(root, dir))) continue
  for (const rel of readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })) {
    const link = join(root, dir, rel)
    // A dangling link into .agents/commands (skills link to it as ../../commands/…).
    if (!isLink(link) || existsSync(link) || !readlinkSync(link).endsWith(".md")) continue
    if (!readlinkSync(link).includes("commands/")) continue
    if (check) problems.push(`${relative(root, link)} points at a removed command`)
    else {
      rmSync(link.endsWith("/SKILL.md") ? dirname(link) : link, { recursive: true, force: true })
      changed++
    }
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  console.error("\nRun: bun run agents:sync")
  process.exit(1)
}
console.log(
  `agent-commands: ${names.length} command(s) × ${HARNESSES.length} harnesses in sync${changed ? ` (${changed} link(s) updated)` : ""}`,
)
