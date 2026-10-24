import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkReport, compareReports } from "./gate.ts"
import { measure } from "./harness.ts"
import type { Report } from "./types.ts"

function report(): Report {
  return {
    schema: 1,
    environment: { platform: "linux", arch: "x64", bun: "1.4.0" },
    warmup: 3,
    failures: [],
    results: [
      {
        name: "point-update",
        operations: 100,
        samples: 9,
        medianMs: 10,
        p95Ms: 12,
        perOperationUs: 100,
        details: { candidateRowVisits: 100, candidateRowVisitBudget: 400 },
      },
    ],
  }
}

test("performance gates catch scans, bad timings, incomplete reports and missing budgets", () => {
  const current = report()
  expect(
    checkReport(
      current,
      ["point-update"],
      { "point-update": 30 },
      { "point-update": { candidateRowVisits: 400 } },
    ),
  ).toEqual([])
  const result = current.results[0]
  if (!result) throw new Error("missing fixture")
  result.details.candidateRowVisits = 1_000_000
  expect(
    checkReport(
      current,
      ["point-update"],
      { "point-update": 30 },
      { "point-update": { candidateRowVisits: 400 } },
    ).join(),
  ).toContain("candidateRowVisits")
  result.medianMs = Number.NaN
  expect(checkReport(current, ["point-update"], {}).join()).toContain(
    "Invalid performance measurement",
  )
  expect(checkReport(current, ["point-update"], {}).join()).toContain("Missing/invalid budget")
  current.results = []
  expect(
    checkReport(
      current,
      ["point-update"],
      { "point-update": 30 },
      { "point-update": { candidateRowVisits: 400 } },
    ).join(),
  ).toContain("Missing workload")
})

test("baseline comparison rejects incompatible data and real regressions", () => {
  const baseline = report()
  const current = report()
  expect(compareReports(current, baseline)).toEqual([])
  const result = current.results[0]
  if (!result) throw new Error("missing fixture")
  result.medianMs = 30
  expect(compareReports(current, baseline).join()).toContain("regressed")
  current.environment.arch = "arm64"
  expect(compareReports(current, baseline).join()).toContain("mismatch")
  current.environment.arch = "x64"
  current.results = []
  expect(compareReports(current, baseline).join()).toContain("Missing baseline workload")
})

test("same-run WASM comparison catches regressions without failing tiny timer differences", () => {
  const current = report()
  current.results.push({
    name: "wasm",
    operations: 100,
    samples: 9,
    medianMs: 1,
    p95Ms: 2,
    perOperationUs: 10,
    details: {},
  })
  const options = { "point-update": { reference: "wasm", factor: 5, floorMs: 10 } }
  expect(
    checkReport(current, ["point-update", "wasm"], { "point-update": 100, wasm: 100 }, {}, options),
  ).toEqual([])
  const result = current.results[0]
  if (!result) throw new Error("missing fixture")
  result.medianMs = 30
  result.p95Ms = 32
  expect(
    checkReport(
      current,
      ["point-update", "wasm"],
      { "point-update": 100, wasm: 100 },
      {},
      options,
    ).join(),
  ).toContain("exceeds 5x")
})

test("benchmark fixtures clean up after run or correctness verification fails", async () => {
  for (const stage of ["run", "verify"]) {
    let closed = 0
    await expect(
      measure(
        {
          name: "failure",
          operations: 1,
          setup: () => ({
            run: () => {
              if (stage === "run") throw new Error(stage)
            },
            verify: () => {
              if (stage === "verify") throw new Error(stage)
            },
            close: () => {
              closed++
            },
          }),
        },
        0,
        1,
      ),
    ).rejects.toThrow(stage)
    expect(closed).toBe(1)
  }
})

test("the real performance command rejects a deliberately de-indexed query", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mockingbird-performance-canary-"))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "run.ts"),
        "--check",
        "--only",
        "postgres/update-batch/1000",
        "--samples",
        "5",
        "--no-wasm",
        "--canary-scan",
        "--out",
        join(directory, "report.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(code).toBe(1)
    expect(stderr).toContain("candidateRowVisits 100000 exceeds 400")
    const report = (await Bun.file(join(directory, "report.json")).json()) as Report
    expect(report.results[0]?.details.candidateRowVisits).toBe(100000)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test("the buffered performance gate catches a return to full snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mockingbird-buffered-canary-"))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "run.ts"),
        "--check",
        "--buffered",
        "--samples",
        "5",
        "--only",
        "sqlite/buffered/sparse-flush/100000",
        "--canary-buffered-snapshot",
        "--out",
        join(directory, "report.json"),
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ])
    expect(code).toBe(1)
    expect(stderr).toContain("fullSnapshotEncodes")
    const report = (await Bun.file(join(directory, "report.json")).json()) as Report
    expect(report.results[0]?.details.fullSnapshotEncodes).toBeGreaterThan(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
