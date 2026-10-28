import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Transcript } from "./harness.js"

const root = join(import.meta.dir, "golden")
const file = (name: string) => join(root, `${name}.json`)

export const readGolden = (name: string): Transcript | undefined => {
  try {
    return JSON.parse(readFileSync(file(name), "utf8")) as Transcript
  } catch {
    return undefined
  }
}

export const writeGolden = (name: string, transcript: Transcript) => {
  mkdirSync(dirname(file(name)), { recursive: true })
  writeFileSync(file(name), `${JSON.stringify(transcript, null, 2)}\n`)
}
