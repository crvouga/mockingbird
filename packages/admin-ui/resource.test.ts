import { describe, expect, test } from "bun:test"
import type { ResourceEvent } from "./src/resource.js"
import { initialResource, resourceFor, resourceReducer } from "./src/resource.js"

type Manifest = { panels: string[] }

describe("admin resource state", () => {
  const stripe = { id: "stripe" }
  const github = { id: "github" }
  const loadedStripe: ResourceEvent<Manifest>[] = [
    { type: "start", source: stripe, foreground: true },
    { type: "loaded", source: stripe, value: { panels: ["sql", "stripe-only"] } },
    { type: "settled", source: stripe, foreground: true },
  ]

  test("switching sources drops the old payload when the new request fails", () => {
    let state = initialResource<Manifest>(stripe)
    for (const event of loadedStripe) state = resourceReducer(state, event)
    expect(state.data).toEqual({ panels: ["sql", "stripe-only"] })
    state = resourceReducer(state, { type: "start", source: github, foreground: true })
    expect(state).toEqual({ source: github, data: null, error: null, loading: true })
    state = resourceReducer(state, { type: "failed", source: github, error: "HTTP 502" })
    state = resourceReducer(state, { type: "settled", source: github, foreground: true })
    expect(state).toEqual({ source: github, data: null, error: "HTTP 502", loading: false })
  })

  test("the render before the new request starts shows no data for the new source", () => {
    let state = initialResource<Manifest>(stripe)
    for (const event of loadedStripe) state = resourceReducer(state, event)
    expect(resourceFor(state, github)).toEqual({
      source: github,
      data: null,
      error: null,
      loading: true,
    })
    expect(resourceFor(state, stripe)).toBe(state)
  })

  test("polling the same source keeps the last good payload; a late reply from the old source is ignored", () => {
    let state = initialResource<Manifest>(stripe)
    for (const event of loadedStripe) state = resourceReducer(state, event)
    state = resourceReducer(state, { type: "start", source: stripe, foreground: false })
    state = resourceReducer(state, { type: "failed", source: stripe, error: "offline" })
    expect(state.data).toEqual({ panels: ["sql", "stripe-only"] })
    expect(state.loading).toBe(false)
    state = resourceReducer(state, { type: "start", source: github, foreground: true })
    state = resourceReducer(state, { type: "loaded", source: stripe, value: { panels: ["late"] } })
    expect(state.data).toBeNull()
  })
})
