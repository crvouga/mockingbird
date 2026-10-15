import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REPO } from "../release/lib.ts"
import { command, githubPages } from "./io.ts"

/** Inspect only status metadata; never echo response bodies or patient/test records. */
export function verificationBlocker(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const report = value as {
    blocked?: { status?: unknown }
    divergences?: Array<{ kind?: string; real?: unknown }>
  }
  const differences = report.divergences
  const status =
    report.blocked?.status ??
    (differences?.length &&
    differences.every((entry) => entry.kind === "status" && entry.real === differences[0]?.real)
      ? differences[0]?.real
      : undefined)
  if (status === 402)
    return "Junction sandbox is blocking verification with HTTP 402 Payment Required. Restore the team's account access/entitlement; emulator parity cannot be evaluated while access is blocked."
  if (status === 401)
    return "Junction rejected JUNCTION_API_KEY (HTTP 401). Restore the GitHub Actions sandbox credential."
  if (status === 403)
    return "Junction denied sandbox access (HTTP 403). Restore the team's API permissions."
  return undefined
}

export async function readVerificationBlocker(runId: number): Promise<string | undefined> {
  const artifacts = await githubPages<{ id: number; name: string; expired: boolean }>(
    `repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
    "artifacts",
  )
  const artifact = artifacts
    .filter((entry) => entry.name === "junction-verify-report" && !entry.expired)
    .sort((a, b) => b.id - a.id)[0]
  if (!artifact) return undefined
  const dir = mkdtempSync(join(tmpdir(), "mockingbird-verify-health-"))
  try {
    const proc = Bun.spawn(["gh", "api", `repos/${REPO}/actions/artifacts/${artifact.id}/zip`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => proc.kill(), 20_000)
    let bytes: ArrayBuffer
    try {
      const [code, data] = await Promise.all([proc.exited, new Response(proc.stdout).arrayBuffer()])
      if (code !== 0) return undefined
      bytes = data
    } finally {
      clearTimeout(timer)
    }
    const archive = join(dir, "report.zip")
    writeFileSync(archive, new Uint8Array(bytes))
    return verificationBlocker(
      JSON.parse(await command(["unzip", "-p", archive, "junction-verify.json"], 15_000)),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
