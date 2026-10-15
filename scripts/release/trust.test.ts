import { describe, expect, test } from "bun:test"
import type { TrustConfig } from "../health/trusted-publisher.ts"
import { hasReleasePublisher, normalizedTrustConfig, trustedPublisherReconciler } from "./trust.ts"

const config: TrustConfig = {
  id: "healthy-id",
  type: "github",
  permissions: ["createPackage"],
  claims: { repository: "crvouga/mockingbird", workflow_ref: { file: "ci.yml" } },
}

describe("local seed trust reconciliation", () => {
  test("the repository name alone does not prove CI can publish", () => {
    expect(hasReleasePublisher(JSON.stringify([config]))).toBe(true)
    for (const other of [
      { ...config, permissions: ["createStagedPackage"] },
      { ...config, environment: "production" },
      { ...config, claims: { ...config.claims, workflow_ref: { file: "other.yml" } } },
      { ...config, claims: { ...config.claims, repository: "crvouga/mockingbird-extra" } },
    ]) {
      expect(hasReleasePublisher(JSON.stringify([other]))).toBe(false)
    }
    for (const output of ["[]", "null", "[null]", "not json"]) {
      expect(hasReleasePublisher(output)).toBe(false)
    }
    expect(hasReleasePublisher(JSON.stringify(config))).toBe(true)
  })

  test("accepts npm trust list's normalized single-object output", () => {
    expect(
      hasReleasePublisher(
        JSON.stringify({
          id: "cli-id",
          type: "github",
          file: "ci.yml",
          repository: "crvouga/mockingbird",
          permissions: ["createPackage", "createStagedPackage"],
        }),
      ),
    ).toBe(true)
  })

  test("normalizes CLI fields for an older seed checkout's health helper", () => {
    expect(
      normalizedTrustConfig({
        type: "github",
        file: "ci.yml",
        repository: "crvouga/mockingbird",
      }).claims,
    ).toEqual({
      repository: "crvouga/mockingbird",
      workflow_ref: { file: "ci.yml" },
    })
  })

  test("healthy configurations are skipped without a mutation", async () => {
    const created: string[] = []
    const trust = trustedPublisherReconciler({
      list: async () => JSON.stringify([config]),
      revoke: async () => true,
      create: async (name) => {
        created.push(name)
        return true
      },
      onError: () => {},
    })
    await trust.ensure("healthy")
    expect(created).toEqual([])
    expect(trust.failed.size).toBe(0)
  })

  test("spaces mutations, preserves failures and continues independent packages", async () => {
    let clock = 0
    const started: number[] = []
    const slept: number[] = []
    const saved = new Set<string>()
    const trust = trustedPublisherReconciler({
      list: async (name) => JSON.stringify(saved.has(name) ? [config] : []),
      revoke: async () => true,
      create: async (name) => {
        started.push(clock)
        clock += 500
        if (name !== "failed") saved.add(name)
        return name !== "failed"
      },
      onError: () => {},
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })
    for (const name of ["first", "failed", "last"]) await trust.ensure(name)
    expect(started).toEqual([0, 2_500, 5_000])
    expect(slept).toEqual([2_000, 2_000])
    expect([...trust.failed]).toEqual(["failed"])
  })

  test("a successful retry clears an earlier failure", async () => {
    let healthy = false
    const trust = trustedPublisherReconciler({
      list: async () => JSON.stringify(healthy ? [config] : []),
      revoke: async () => true,
      create: async () => false,
      onError: () => {},
    })
    await trust.ensure("retry")
    expect([...trust.failed]).toEqual(["retry"])
    healthy = true
    await trust.ensure("retry")
    expect(trust.failed.size).toBe(0)
  })

  test("thrown trust commands remain failures without aborting reconciliation", async () => {
    const errors: string[] = []
    const saved = new Set<string>()
    const trust = trustedPublisherReconciler({
      list: async (name) => {
        if (name === "lookup-failed") throw new Error("lookup failed")
        return JSON.stringify(saved.has(name) ? [config] : [])
      },
      revoke: async () => true,
      create: async (name) => {
        if (name === "create-failed") throw new Error("create failed")
        saved.add(name)
        return true
      },
      onError: (name) => errors.push(name),
      sleep: async () => {},
    })
    for (const name of ["lookup-failed", "create-failed", "healthy"]) await trust.ensure(name)
    expect([...trust.failed]).toEqual(["lookup-failed", "create-failed"])
    expect(errors).toEqual(["lookup-failed", "create-failed"])
  })

  test("revokes a conflicting publisher before creating its replacement", async () => {
    let clock = 0
    const events: string[] = []
    const slept: number[] = []
    const stageOnly = { ...config, id: "stage-id", permissions: ["createStagedPackage"] }
    let saved = false
    const trust = trustedPublisherReconciler({
      list: async () => JSON.stringify([saved ? config : stageOnly]),
      revoke: async (name, id) => {
        events.push(`revoke ${name} ${id}`)
        clock += 200
        return true
      },
      create: async (name) => {
        events.push(`create ${name}`)
        saved = true
        return true
      },
      onError: () => {},
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })

    await trust.ensure("replace-me")

    expect(events).toEqual(["revoke replace-me stage-id", "create replace-me"])
    expect(slept).toEqual([2_000])
    expect(trust.failed.size).toBe(0)
  })

  test("a successful create must persist a publisher that permits Release to publish", async () => {
    for (const saved of [
      null,
      "[]",
      "invalid JSON",
      JSON.stringify([{ ...config, permissions: ["createStagedPackage"] }]),
      JSON.stringify([{ ...config, environment: "production" }]),
      JSON.stringify([{ ...config, file: "other.yml" }]),
      JSON.stringify([config]),
    ]) {
      let created = false
      const errors: unknown[] = []
      const trust = trustedPublisherReconciler({
        list: async () => (created ? saved : "[]"),
        revoke: async () => true,
        create: async () => {
          created = true
          return true
        },
        onError: (_, error) => errors.push(error),
      })
      await trust.ensure("verify-me")
      const healthy = saved === JSON.stringify([config])
      expect([...trust.failed]).toEqual(healthy ? [] : ["verify-me"])
      expect(errors.length).toBe(healthy ? 0 : 1)
    }
  })

  test("does not create when an existing publisher cannot be revoked safely", async () => {
    const events: string[] = []
    const trust = trustedPublisherReconciler({
      list: async () => JSON.stringify([{ ...config, id: undefined, permissions: [] }]),
      revoke: async () => {
        events.push("revoke")
        return true
      },
      create: async () => {
        events.push("create")
        return true
      },
      onError: (_, error) => events.push(String(error)),
    })

    await trust.ensure("invalid")

    expect(events).toEqual(["Error: npm trust list returned a publisher without an id"])
    expect([...trust.failed]).toEqual(["invalid"])
  })
})
