import { describe, expect, test } from "bun:test"
import { renderToHtml } from "./src/react/server.tsx"
import { ServiceCredentials } from "./src/system-credentials.tsx"
import { countFacts, filterFacts, isFactsSection } from "./src/system-facts.ts"
import { FactsView } from "./src/system-facts-section.tsx"
import { StartupTimeline, SystemScreen, type SystemScreenProps } from "./src/system-screen.tsx"
import {
  blankCredentials,
  credentialValues,
  missingCredentials,
  takesCredentials,
} from "./src/system-services-store.ts"
import { formatMs, timelineRows } from "./src/system-timeline.ts"
import type {
  SystemFactGroup,
  SystemFactsSection,
  SystemSection,
  SystemService,
  SystemServiceField,
  SystemServices,
} from "./src/system-types.ts"

/** #903: credentials typed on the System screen, start-up timings, and facts sections. */

const FIELDS: readonly SystemServiceField[] = [
  { name: "apiKey", label: "API key", secret: true, placeholder: "re_…" },
  {
    name: "region",
    label: "Region",
    options: [
      { value: "us", label: "United States" },
      { value: "eu", label: "Europe" },
    ],
  },
]
const RESEND: SystemService = { id: "resend", label: "Resend", mode: "dev", fields: FIELDS }

describe("services: credentials", () => {
  const services: SystemServices = {
    list: async () => ({ dev: { state: "none", message: "No proxy." }, services: [] }),
    setMode: async () => {},
  }

  test("a row takes credentials only with fields and a host that keeps them", () => {
    expect(takesCredentials(RESEND, services)).toBe(false)
    const keeps = { ...services, setCredentials: async () => {} }
    expect(takesCredentials(RESEND, keeps)).toBe(true)
    expect(takesCredentials({ ...RESEND, fields: [] }, keeps)).toBe(false)
    const { fields: _, ...plain } = RESEND
    expect(takesCredentials(plain, keeps)).toBe(false)
  })

  test("inputs start blank (a select at its first option); every field is required", () => {
    const blank = blankCredentials(FIELDS)
    expect(blank).toEqual({ apiKey: "", region: "us" })
    expect(missingCredentials(FIELDS, blank)).toEqual(["API key"])
    expect(missingCredentials(FIELDS, { ...blank, apiKey: "   " })).toEqual(["API key"])
    expect(missingCredentials(FIELDS, { ...blank, apiKey: "re_1" })).toEqual([])
    expect(credentialValues(FIELDS, { apiKey: " re_1 ", region: "eu", stray: "x" })).toEqual({
      apiKey: "re_1",
      region: "eu",
    })
  })

  test("drawn as a password input, a select, Save and the row's Test", () => {
    const html = renderToHtml(
      <ServiceCredentials
        service={RESEND}
        fields={FIELDS}
        save={async () => {}}
        test={<button type="button">Test</button>}
      />,
    )
    expect(html).toContain('type="password"')
    expect(html).toContain('placeholder="re_…"')
    expect(html).toMatch(/<select[^>]*name="region"/)
    expect(html).toContain("Europe")
    expect(html).toContain("Save key")
    expect(html).toContain(">Test</button>")
    expect(html).toContain("Not saved yet")
    expect(html).not.toContain("Key saved")
    // No Forget without a saved key.
    expect(html).not.toContain("system-service-credentials-clear")
  })

  test("configured: says Key saved, offers Forget and Replace, never shows the secret back", () => {
    const html = renderToHtml(
      <ServiceCredentials
        service={{ ...RESEND, configured: true }}
        fields={FIELDS}
        save={async () => {}}
        clear={async () => {}}
      />,
    )
    expect(html).toContain("Key saved")
    expect(html).toContain("Replace key")
    expect(html).toContain("system-service-credentials-clear")
    expect(html).toContain("Saved · type to replace")
    expect(html).toMatch(/type="password"[^>]*value=""|value=""[^>]*type="password"/)
  })
})

describe("backends: start-up timings", () => {
  test("durations read like people say them", () => {
    expect(formatMs(0)).toBe("0 ms")
    expect(formatMs(412.4)).toBe("412 ms")
    expect(formatMs(1234)).toBe("1.2 s")
    expect(formatMs(42_000)).toBe("42 s")
    expect(formatMs(125_000)).toBe("2 min 5 s")
    expect(formatMs(120_000)).toBe("2 min")
    expect(formatMs(-1)).toBe("—")
    expect(formatMs(Number.NaN)).toBe("—")
  })

  test("steps come in time order, with the time each took, and bad times are dropped", () => {
    const rows = timelineRows([
      { label: "evaluated", atMs: 300 },
      { label: "fetched", atMs: 100 },
      { label: "broken", atMs: Number.NaN },
      { label: "ready", atMs: 400 },
      { label: "unpacked", atMs: 300 },
    ])
    expect(rows.map((row) => [row.label, row.sinceMs])).toEqual([
      ["fetched", 100],
      ["evaluated", 200],
      ["unpacked", 0],
      ["ready", 100],
    ])
    expect(rows[1]?.bar).toEqual({ from: 0.25, width: 0.5 })
    expect(timelineRows([])).toEqual([])
    expect(timelineRows([{ label: "at once", atMs: 0 }])[0]?.bar).toEqual({ from: 0, width: 0 })
  })

  test("the timeline draws each step and the total", () => {
    const html = renderToHtml(
      <StartupTimeline
        steps={[
          { label: "fetched", atMs: 120 },
          { label: "database", atMs: 1500 },
        ]}
      />,
    )
    expect(html).toContain("Ready in <!-- -->1.5 s")
    expect(html).toContain('data-step="fetched"')
    expect(html).toContain("+<!-- -->1.4 s")
    expect(renderToHtml(<StartupTimeline steps={[]} />)).not.toContain("system-backends-timeline")
  })
})

const FLAGS: readonly SystemFactGroup[] = [
  {
    group: "Lab workspace",
    rows: [
      { label: "new-results-view", value: "on", tone: "on" },
      {
        label: "sms-reminders",
        value: "off",
        tone: "off",
        note: "Waiting on carrier approval",
      },
    ],
  },
  { group: "Notifications", rows: [{ label: "digest", value: "weekly" }] },
]

describe("facts sections", () => {
  const facts: SystemFactsSection = { id: "flags", label: "Flags", load: async () => FLAGS }
  const mounted: SystemSection = { id: "boot", label: "Start-up", mount: () => () => {} }

  test("told apart from mount-based sections", () => {
    expect(isFactsSection(facts)).toBe(true)
    expect(isFactsSection(mounted)).toBe(false)
  })

  test("the filter matches every word in a row's label, value, note or group", () => {
    expect(countFacts(FLAGS)).toBe(3)
    expect(filterFacts(FLAGS, "")).toBe(FLAGS)
    expect(filterFacts(FLAGS, "  ")).toBe(FLAGS)
    expect(filterFacts(FLAGS, "SMS")).toEqual([
      { group: "Lab workspace", rows: FLAGS[0]?.rows.slice(1) ?? [] },
    ])
    expect(filterFacts(FLAGS, "carrier off")).toHaveLength(1)
    expect(filterFacts(FLAGS, "notifications")).toEqual(FLAGS.slice(1))
    expect(filterFacts(FLAGS, "on")).toHaveLength(2)
    expect(filterFacts(FLAGS, "nothing-like-this")).toEqual([])
  })

  test("drawn as grouped rows with a filter, tones and notes", () => {
    const html = renderToHtml(<FactsView label="Flags" groups={FLAGS} />)
    expect(html).toContain('aria-label="Filter Flags"')
    expect(html).toContain("3 rows in 2 groups")
    expect(html).toContain('data-fact-group="Lab workspace"')
    expect(html).toContain('data-fact="sms-reminders"')
    expect(html).toContain('data-tone="off"')
    expect(html).toContain("Waiting on carrier approval")
    expect(html).toContain("weekly")
  })

  test("a query that matches nothing says so; an empty section says so", () => {
    const html = renderToHtml(<FactsView label="Flags" groups={FLAGS} initialQuery="zzz" />)
    expect(html).toContain("0 of 3 rows match")
    expect(html).toContain("system-facts-empty")
    expect(renderToHtml(<FactsView label="Flags" groups={[]} />)).toContain(
      "Flags has nothing to show",
    )
  })
})

describe("backward compatibility", () => {
  const base: SystemScreenProps = {
    apps: [{ id: "system", label: "System" }],
    excluded: new Set(),
    open: () => {},
    setInRotation: () => {},
    setOrder: () => {},
  }

  test("a host passing none of the additions draws what it drew before", () => {
    const html = renderToHtml(
      <SystemScreen
        {...base}
        sections={[{ id: "boot", label: "Start-up", mount: () => () => {} }]}
        backends={{ list: () => [{ id: "api", state: "ready" }] }}
      />,
    )
    expect(html).not.toContain("system-backends-timeline")
    expect(html).not.toContain("system-service-credentials")
    expect(html).not.toContain("Filter Start-up")
    expect(html).toContain('data-testid="system-section-boot"')
  })

  test("a facts section sits in the nav beside mount-based ones and loads", () => {
    const html = renderToHtml(
      <SystemScreen
        {...base}
        sections={[
          { id: "boot", label: "Start-up", mount: () => () => {} },
          { id: "flags", label: "Flags", load: async () => FLAGS },
        ]}
      />,
    )
    expect(html).toContain('data-section="flags"')
    expect(html).toContain('data-testid="system-section-flags"')
    expect(html).toContain("Loading Flags…")
  })

  test("the store passes the credential calls through only when the host has them", async () => {
    const { trackServices } = await import("./src/system-services-store.ts")
    const plain: SystemServices = {
      list: async () => ({ dev: { state: "none", message: "" }, services: [] }),
      setMode: async () => {},
    }
    expect(trackServices(plain).services.setCredentials).toBeUndefined()
    expect(trackServices(plain).services.clearCredentials).toBeUndefined()
  })
})
