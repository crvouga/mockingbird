import { KeyValueList, StatusChip } from "@crvouga/mockingbird-ui/react"
import { ArrowDownToLine, Plus, TrashBin } from "@gravity-ui/icons"
import { Button, Card, Form, Tabs } from "@heroui/react"
import type { ReactNode } from "react"
import { useState } from "react"
import {
  Choose,
  DataTable,
  ErrorNotice,
  FieldGroup,
  Json,
  NumberInput,
  Refresh,
  SearchSelect,
  Section,
  TextInput,
  Toggle,
  useAction,
  useChrome,
  useResource,
  ViewTitle,
} from "./components.js"
import { downloadJson } from "./download.js"
import { journalPath, type RequestTarget, requestAttempts } from "./manual-model.js"
import type {
  Api,
  Clock,
  Controls,
  FaultPreset,
  Journal,
  Latency,
  LatencyRule,
  Snapshot,
  StateView,
} from "./model.js"
import { errorMessage, pretty, text } from "./model.js"

const JOURNAL_WIDTHS = { at: 210, method: 90, status: 90, durationMs: 120, delayMs: 100 }

const wait = (rule: LatencyRule): string =>
  rule.jitterMs ? `${rule.delayMs} ms + 0–${rule.jitterMs} ms jitter` : `${rule.delayMs} ms`

const required =
  (message: string) =>
  (value: string): string | null =>
    value.trim() ? null : message

const submitted = (handler: () => unknown) => (event: { preventDefault(): void }) => {
  event.preventDefault()
  handler()
}

function Stat({ title, value, loading }: { title: string; value: ReactNode; loading: boolean }) {
  return (
    <Card>
      <Card.Content className="flex flex-col gap-1">
        <span className="text-sm text-muted">{title}</span>
        <span className="truncate text-2xl font-semibold text-foreground">
          {loading ? "…" : value}
        </span>
      </Card.Content>
    </Card>
  )
}

export function Overview({ api, revision }: { api: Api; revision: number }) {
  const health = useResource<Record<string, unknown>>(api, "/health", revision)
  const state = useResource<StateView>(api, "/state", revision)
  const clock = useResource<Clock>(api, "/clock", revision)
  const controls = useResource<Controls>(api, "/controls", revision)
  const journal = useResource<Journal>(api, "/requests?limit=8", revision)
  const { confirm, notify } = useChrome()
  const reset = useAction(api, () => {
    state.reload()
    clock.reload()
    controls.reload()
    journal.reload()
    notify("Namespace reset")
  })
  const overrides = Object.keys(controls.data?.latency.operations ?? {}).length
  const status = health.data?.status
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle description="The emulator at a glance: what it holds, its clock and controls, and the latest requests.">
        Overview
      </ViewTitle>
      <ErrorNotice
        error={
          health.error ??
          state.error ??
          clock.error ??
          controls.error ??
          journal.error ??
          reset.error
        }
        retry={() => {
          health.reload()
          state.reload()
          clock.reload()
          controls.reload()
          journal.reload()
        }}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat title="Service" value={text(health.data?.service)} loading={health.loading} />
        <Stat
          title="Collections"
          value={state.data?.collections.length ?? 0}
          loading={state.loading}
        />
        <Stat
          title="Records"
          value={state.data?.collections.reduce((sum, item) => sum + item.count, 0) ?? 0}
          loading={state.loading}
        />
      </div>
      <Section title="Environment">
        <KeyValueList
          items={[
            {
              label: "Status",
              value:
                status === undefined ? (
                  "—"
                ) : (
                  <StatusChip status={status === "ok" ? "ok" : "warning"}>
                    {text(status)}
                  </StatusChip>
                ),
            },
            { label: "Namespace", value: api.namespace(), mono: true },
            {
              label: "Clock",
              value: clock.data
                ? `${new Date(clock.data.now).toLocaleString()} · ${clock.data.frozen ? "Frozen" : "Live"}`
                : "—",
            },
            { label: "Seed", value: text(controls.data?.seed), mono: true },
            {
              label: "Virtual time",
              value: controls.data ? (controls.data.virtualTime ? "On" : "Off") : "—",
            },
            {
              label: "Latency",
              value: controls.data
                ? `${wait(controls.data.latency)}${overrides ? ` · ${overrides} per-operation` : ""}`
                : "—",
            },
          ]}
        />
      </Section>
      <Section title="Recent requests">
        <DataTable
          label="Recent requests"
          rows={journal.data?.requests ?? []}
          columns={["method", "path", "status", "operationId", "durationMs", "delayMs", "faultId"]}
          widths={JOURNAL_WIDTHS}
          loading={journal.loading}
          searchable={false}
          pagination={false}
        />
      </Section>
      <Section
        title="Reset namespace"
        description={`Return ${api.namespace()} to its boot state. Other namespaces are unaffected.`}
        actions={
          <Button
            variant="danger"
            isPending={reset.busy}
            onPress={() =>
              confirm({
                title: `Reset ${api.namespace()}?`,
                content:
                  "The namespace returns to its boot state: records, clock, faults, latency, snapshots and journal.",
                okText: "Reset namespace",
                danger: true,
                onOk: () => reset.run("POST", "/reset", {}),
              })
            }
          >
            Reset namespace
          </Button>
        }
      />
    </div>
  )
}

const ADVANCES = [
  ["−1h", -3600000],
  ["+1m", 60000],
  ["+15m", 900000],
  ["+1h", 3600000],
  ["+1d", 86400000],
] as const

export function ClockView({ api, revision }: { api: Api; revision: number }) {
  const clock = useResource<Clock>(api, "/clock", revision)
  const controls = useResource<Controls>(api, "/controls", revision)
  const { notify } = useChrome()
  const [instant, setInstant] = useState("")
  const [step, setStep] = useState("")
  const action = useAction(api, () => {
    clock.reload()
    notify("Clock updated")
  })
  const virtual = useAction(api, () => {
    controls.reload()
    notify("Virtual time updated")
  })
  const autoAdvance = clock.data?.autoAdvanceMs ? `${clock.data.autoAdvanceMs} ms` : "off"
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="clock"
        description="The emulator's own clock: freeze it, move it, or let every request advance it."
        actions={<Refresh loading={clock.loading} onClick={clock.reload} />}
      >
        Clock
      </ViewTitle>
      <ErrorNotice
        error={clock.error ?? controls.error ?? action.error ?? virtual.error}
        retry={() => {
          clock.reload()
          controls.reload()
        }}
      />
      <Section title="Current time">
        <p className="m-0 break-all font-mono text-xl font-semibold text-foreground">
          {clock.data?.iso ?? "—"}
        </p>
        <Toggle
          label="Freeze clock"
          ariaLabel="Freeze clock"
          isSelected={clock.data?.frozen ?? false}
          isDisabled={action.busy || !clock.data}
          onChange={(freeze) => void action.run("POST", "/clock", { freeze })}
        />
        <div className="flex flex-wrap gap-2">
          {ADVANCES.map(([label, advance]) => (
            <Button
              key={label}
              variant="secondary"
              size="sm"
              isDisabled={action.busy}
              onPress={() => void action.run("POST", "/clock", { advance })}
            >
              {label}
            </Button>
          ))}
          <Button
            variant="tertiary"
            size="sm"
            isPending={action.busy}
            onPress={() => void action.run("POST", "/clock", { reset: true })}
          >
            Reset clock
          </Button>
        </div>
      </Section>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Section title="Set an instant">
          <Form
            className="flex flex-col gap-4"
            onSubmit={submitted(() => void action.run("POST", "/clock", { set: instant }))}
          >
            <TextInput
              label="ISO 8601 timestamp"
              name="set"
              placeholder="2026-01-01T00:00:00Z"
              value={instant}
              onChange={setInstant}
              isRequired
              validate={(value) =>
                Number.isFinite(Date.parse(value)) ? null : "Enter an ISO timestamp"
              }
            />
            <Button type="submit" className="self-start" isPending={action.busy}>
              Set time
            </Button>
          </Form>
        </Section>
        <Section title="Auto-advance">
          <Form
            className="flex flex-col gap-4"
            onSubmit={submitted(
              () => void action.run("POST", "/clock", { autoAdvance: step.trim() }),
            )}
          >
            <TextInput
              label="Step before every vendor request"
              name="autoAdvance"
              placeholder="1s"
              value={step}
              onChange={setStep}
              isRequired
              validate={required("Enter a duration")}
              description={`Currently ${autoAdvance}. A duration such as 1s or 250ms; 0 turns it off.`}
            />
            <Button type="submit" className="self-start" isPending={action.busy}>
              Set auto-advance
            </Button>
          </Form>
        </Section>
        <Section
          title="Virtual time"
          description="When on, latency, fault delays and timeouts are spent on this clock instead of the wall clock: the request returns at once and the clock moves forward by the wait."
        >
          <Toggle
            label="Virtual time"
            ariaLabel="Virtual time"
            isSelected={controls.data?.virtualTime ?? false}
            isDisabled={virtual.busy || !controls.data}
            onChange={(virtualTime) => void virtual.run("PUT", "/controls", { virtualTime })}
          />
        </Section>
      </div>
    </div>
  )
}

function BaselineForm({
  latency,
  busy,
  onSubmit,
}: {
  latency: Latency
  busy: boolean
  onSubmit: (delay: string, jitter: string) => void
}) {
  const [delay, setDelay] = useState(`${latency.delayMs}ms`)
  const [jitter, setJitter] = useState(`${latency.jitterMs}ms`)
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={submitted(() => onSubmit(delay.trim(), jitter.trim()))}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextInput
          label="Delay"
          name="delay"
          placeholder="40ms"
          value={delay}
          onChange={setDelay}
          isRequired
          validate={required("Enter a duration")}
          description="Added to every request."
        />
        <TextInput
          label="Jitter"
          name="jitter"
          placeholder="10ms"
          value={jitter}
          onChange={setJitter}
          description="A seeded extra wait from 0 up to this."
        />
      </div>
      <Button type="submit" className="self-start" isPending={busy}>
        Set baseline
      </Button>
    </Form>
  )
}

export function LatencyView({ api, revision }: { api: Api; revision: number }) {
  const latency = useResource<Latency>(api, "/latency", revision)
  const { notify, confirm } = useChrome()
  const [override, setOverride] = useState({ operationId: "", delay: "", jitter: "" })
  const action = useAction(api, () => {
    latency.reload()
    notify("Latency updated")
  })
  const operations = latency.data?.operations ?? {}
  // PUT replaces the whole control, so every change sends the parts it leaves alone.
  const put = (change: {
    delay?: string | number
    jitter?: string | number
    operations?: Record<string, unknown>
  }) =>
    action.run("PUT", "/latency", {
      delay: latency.data?.delayMs ?? 0,
      jitter: latency.data?.jitterMs ?? 0,
      operations,
      ...change,
    })
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="latency-and-timeouts"
        description="How long every vendor request in this namespace takes, before any fault is considered. Durations are milliseconds or a string such as 250ms, 2s or 15m."
        actions={
          <>
            <Refresh loading={latency.loading} onClick={latency.reload} />
            <Button
              variant="danger-soft"
              size="sm"
              isPending={action.busy}
              onPress={() =>
                confirm({
                  title: "Clear this namespace's latency?",
                  content: "The baseline and every per-operation override are removed.",
                  okText: "Clear latency",
                  danger: true,
                  onOk: () => action.run("DELETE", "/latency"),
                })
              }
            >
              <TrashBin className="size-4" />
              Clear latency
            </Button>
          </>
        }
      >
        Latency
      </ViewTitle>
      <ErrorNotice error={latency.error ?? action.error} retry={latency.reload} />
      <Section title="Baseline">
        {latency.data ? (
          <BaselineForm
            // Remount with the stored values whenever they change.
            key={`${latency.data.delayMs}:${latency.data.jitterMs}`}
            latency={latency.data}
            busy={action.busy}
            onSubmit={(delay, jitter) => void put({ delay, jitter: jitter || 0 })}
          />
        ) : (
          <p className="text-sm text-muted">{latency.loading ? "Loading…" : "—"}</p>
        )}
      </Section>
      <Section
        title="Per-operation overrides"
        description="An override replaces the baseline for one operation. The journal lists each request's operationId."
      >
        <Form
          className="flex flex-col gap-4"
          onSubmit={submitted(async () => {
            const added = await put({
              operations: {
                ...operations,
                [override.operationId.trim()]: {
                  delay: override.delay.trim(),
                  jitter: override.jitter.trim() || 0,
                },
              },
            })
            if (added) setOverride({ operationId: "", delay: "", jitter: "" })
          })}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr_1fr]">
            <TextInput
              label="operationId"
              name="operationId"
              placeholder="CreateCharge"
              value={override.operationId}
              onChange={(operationId) => setOverride({ ...override, operationId })}
              isRequired
              validate={required("Enter an operationId")}
            />
            <TextInput
              label="Delay"
              name="delay"
              placeholder="250ms"
              value={override.delay}
              onChange={(delay) => setOverride({ ...override, delay })}
              isRequired
              validate={required("Enter a duration")}
            />
            <TextInput
              label="Jitter"
              name="jitter"
              placeholder="0ms"
              value={override.jitter}
              onChange={(jitter) => setOverride({ ...override, jitter })}
            />
          </div>
          <Button type="submit" variant="secondary" className="self-start" isPending={action.busy}>
            <Plus className="size-4" />
            Set override
          </Button>
        </Form>
        <DataTable
          label="Per-operation overrides"
          rows={Object.entries(operations).map(([operationId, rule]) => ({
            operationId,
            ...rule,
          }))}
          columns={["operationId", "delayMs", "jitterMs"]}
          rowKeys={Object.keys(operations)}
          loading={latency.loading}
          action={(row) => (
            <Button
              variant="danger-soft"
              size="sm"
              isDisabled={action.busy}
              onPress={() =>
                void put({
                  operations: Object.fromEntries(
                    Object.entries(operations).filter(([id]) => id !== row.operationId),
                  ),
                })
              }
            >
              Remove
            </Button>
          )}
        />
      </Section>
    </div>
  )
}

type FaultForm = {
  operationId?: string
  method?: string
  path?: string
  pathPrefix?: string
  after?: number | null
  every?: number | null
  count?: number | null
  rate?: number | null
  status?: number | null
  body?: string
  delay?: string
  jitter?: string
  timeout?: string
  drop?: boolean
  truncate?: number | null
}

/** Only the fields that were filled in. The emulator checks the rule and names what is wrong. */
const faultRule = (values: FaultForm): Record<string, unknown> => {
  const rule: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const given = typeof value === "string" ? value.trim() : value
    if (given === undefined || given === null || given === "" || given === false) continue
    rule[name] = name === "body" ? (JSON.parse(String(given)) as unknown) : given
  }
  return rule
}

const FAULT_MATCH = [
  "operationId",
  "method",
  "path",
  "pathPrefix",
  "pathPattern",
  "requestHeaders",
  "query",
  "requestBody",
]
const FAULT_SCHEDULE = ["after", "every", "rate", "count", "from", "until"]
const FAULT_ACTION = [
  "status",
  "delayMs",
  "jitterMs",
  "timeoutMs",
  "drop",
  "truncate",
  "effect",
  "fromPreset",
]

const faultParts = (rule: Record<string, unknown>, names: readonly string[]): string[] =>
  names
    .filter((name) => rule[name] !== undefined && rule[name] !== false)
    .map((name) => {
      const value = rule[name]
      const instant = (name === "from" || name === "until") && typeof value === "number"
      return `${name} ${instant ? new Date(value).toISOString() : text(value)}`
    })

/** A stored rule as its three parts: what it matches, when it fires, what it injects. */
const faultRow = (rule: Record<string, unknown>, namespace: string): Record<string, unknown> => ({
  id: rule.id,
  match:
    [
      ...(rule.namespace === namespace ? [] : ["every namespace"]),
      ...faultParts(rule, FAULT_MATCH),
    ].join(" · ") || "every request",
  schedule: faultParts(rule, FAULT_SCHEDULE).join(" · ") || "every match",
  injects: faultParts(rule, FAULT_ACTION).join(" · "),
  hits: rule.hits,
  seen: rule.seen,
  remaining: rule.remaining ?? "no limit",
})

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

function FaultFields({ busy, onSubmit }: { busy: boolean; onSubmit: (values: FaultForm) => void }) {
  const [values, setValues] = useState<FaultForm>({})
  const textField = (name: keyof FaultForm, placeholder: string, description?: string) => (
    <TextInput
      label={name}
      name={name}
      placeholder={placeholder}
      value={String(values[name] ?? "")}
      onChange={(value) => setValues({ ...values, [name]: value })}
      {...(description ? { description } : {})}
    />
  )
  const numberField = (
    name: keyof FaultForm,
    description: string,
    limits: { minValue?: number; maxValue?: number; step?: number },
  ) => (
    <NumberInput
      label={name}
      value={(values[name] as number | null | undefined) ?? null}
      onChange={(value) => setValues({ ...values, [name]: value })}
      description={description}
      {...limits}
    />
  )
  return (
    <Form className="flex flex-col gap-6" onSubmit={submitted(() => onSubmit(values))}>
      <FieldGroup title="Match">
        {textField("operationId", "Any operation")}
        <Choose
          label="method"
          value={values.method ?? ""}
          onChange={(method) => setValues({ ...values, method })}
          choices={[
            { value: "", label: "Any method" },
            ...METHODS.map((method) => ({ value: method, label: method })),
          ]}
        />
        {textField("path", "/v1/charges", "Exact path.")}
        {textField("pathPrefix", "/v1", "Paths starting with this.")}
      </FieldGroup>
      <FieldGroup title="Schedule">
        {numberField("after", "Let this many matches through first.", { minValue: 0 })}
        {numberField("every", "Then fault only every nth match.", { minValue: 1 })}
        {numberField("count", "Retire the rule after this many faults.", { minValue: 0 })}
        {numberField("rate", "Fraction to fault, 0 to 1, drawn from the seed.", {
          minValue: 0,
          maxValue: 1,
          step: 0.1,
        })}
      </FieldGroup>
      <FieldGroup title="Action">
        {numberField("status", "Answer with this status instead of reaching the emulator.", {
          minValue: 200,
          maxValue: 599,
        })}
        {textField("delay", "2s", "Hold the response back.")}
        {textField("jitter", "100ms", "A seeded extra wait from 0 up to this.")}
        {textField("timeout", "30s", "Hold the request this long, then drop the connection.")}
        {numberField("truncate", "Cut the body off after this many bytes.", { minValue: 0 })}
        <div className="flex flex-col justify-center gap-1">
          <Toggle
            label="drop"
            ariaLabel="Drop the connection"
            isSelected={values.drop ?? false}
            onChange={(drop) => setValues({ ...values, drop })}
          />
          <span className="text-xs text-muted">Drop the connection at once.</span>
        </div>
      </FieldGroup>
      <TextInput
        label="body"
        name="body"
        rows={3}
        monospace
        placeholder={'{"error": "unavailable"}'}
        value={values.body ?? ""}
        onChange={(body) => setValues({ ...values, body })}
        description="The response body, as JSON. Quote a plain string."
      />
      <Button type="submit" className="self-start" isPending={busy}>
        <Plus className="size-4" />
        Add fault
      </Button>
    </Form>
  )
}

export function FaultsView({ api, revision }: { api: Api; revision: number }) {
  const faults = useResource<{ faults: Record<string, unknown>[] }>(api, "/faults", revision)
  const presets = useResource<{ presets: FaultPreset[] }>(api, "/faults/presets", revision)
  const [custom, setCustom] = useState('{\n  "status": 503,\n  "count": 1\n}')
  const [parseError, setParseError] = useState<string | null>(null)
  const [presetCount, setPresetCount] = useState<number | null>(null)
  const { notify, confirm } = useChrome()
  const done = () => {
    faults.reload()
    notify("Fault rules updated")
  }
  // One per card, so a rejected rule is reported beside the control that sent it.
  const add = useAction(api, done)
  const apply = useAction(api, done)
  const remove = useAction(api, done)
  const submit = (values?: FaultForm) => {
    setParseError(null)
    try {
      void add.run("POST", "/faults", values ? faultRule(values) : (JSON.parse(custom) as unknown))
    } catch (error) {
      setParseError(errorMessage(error))
    }
  }
  const rules = faults.data?.faults ?? []
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="faults"
        description="Rules that make matching vendor requests fail, wait or break, now or on a schedule."
        actions={<Refresh loading={faults.loading} onClick={faults.reload} />}
      >
        Faults
      </ViewTitle>
      <ErrorNotice
        error={faults.error ?? presets.error ?? remove.error}
        retry={() => {
          faults.reload()
          presets.reload()
        }}
      />
      <Section title="Add a fault">
        <ErrorNotice error={parseError ?? add.error} />
        <Tabs aria-label="Fault input">
          <Tabs.ListContainer>
            <Tabs.List aria-label="Fault input">
              <Tabs.Tab id="fields">Fields</Tabs.Tab>
              <Tabs.Tab id="json">JSON</Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="fields" className="pt-4">
            <FaultFields busy={add.busy} onSubmit={submit} />
          </Tabs.Panel>
          <Tabs.Panel id="json" className="flex flex-col gap-4 pt-4">
            <TextInput
              label="Rule JSON"
              ariaLabel="Fault rule JSON"
              rows={8}
              monospace
              value={custom}
              onChange={setCustom}
              description="Any rule field, including pathPattern, requestHeaders, query, requestBody, namespace, from, until, headers, effect and params."
            />
            <Button className="self-start" isPending={add.busy} onPress={() => submit()}>
              <Plus className="size-4" />
              Add fault
            </Button>
          </Tabs.Panel>
        </Tabs>
      </Section>
      <Section
        title="Active rules"
        actions={
          <Button
            variant="danger-soft"
            size="sm"
            isDisabled={!rules.length}
            onPress={() =>
              confirm({
                title: "Clear this namespace's fault rules?",
                content: "Rules that apply to every namespace stay.",
                okText: "Clear all",
                danger: true,
                onOk: () => remove.run("DELETE", "/faults"),
              })
            }
          >
            <TrashBin className="size-4" />
            Clear all
          </Button>
        }
      >
        <DataTable
          label="Active fault rules"
          rows={rules.map((rule) => faultRow(rule, api.namespace()))}
          columns={["id", "match", "schedule", "injects", "hits", "seen", "remaining"]}
          widths={{
            id: 130,
            match: 220,
            schedule: 200,
            injects: 240,
            hits: 70,
            seen: 70,
            remaining: 110,
          }}
          loading={faults.loading}
          detail={(_, index) => rules[index]}
          action={(row) => (
            <Button
              variant="danger-soft"
              size="sm"
              isDisabled={remove.busy}
              onPress={() =>
                void remove.run("DELETE", `/faults/${encodeURIComponent(text(row.id))}`)
              }
            >
              Remove
            </Button>
          )}
        />
      </Section>
      <Section
        title="Presets"
        description="A preset is a fault by name. Set a count to retire it after that many faults; without one it stays until removed."
        actions={
          <NumberInput
            ariaLabel="Preset count"
            placeholder="count"
            minValue={0}
            value={presetCount}
            onChange={setPresetCount}
            className="w-36"
          />
        }
      >
        <ErrorNotice error={apply.error} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {presets.data?.presets.map((preset) => (
            <Card key={preset.name} variant="secondary">
              <Card.Header className="flex flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <Card.Title className="font-mono text-sm">{preset.name}</Card.Title>
                  <Card.Description>{preset.description}</Card.Description>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={apply.busy}
                  onPress={() =>
                    void apply.run("POST", "/faults", {
                      preset: preset.name,
                      ...(presetCount === null ? {} : { count: presetCount }),
                    })
                  }
                >
                  Apply
                </Button>
              </Card.Header>
            </Card>
          ))}
        </div>
      </Section>
    </div>
  )
}

export function SnapshotsView({ api, revision }: { api: Api; revision: number }) {
  const snapshots = useResource<{ snapshots: Snapshot[] }>(api, "/snapshots", revision)
  const [name, setName] = useState("")
  const [importId, setImportId] = useState("")
  const [pasted, setPasted] = useState("")
  const [shown, setShown] = useState<{ id: string; value: unknown } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const { notify, confirm } = useChrome()
  const action = useAction(api, () => {
    snapshots.reload()
    notify("Snapshots updated")
  })
  const restore = useAction(api, () => notify("Snapshot restored"))
  const path = (id: string) => `/snapshots/${encodeURIComponent(id)}`
  const show = async (id: string) => {
    setLocalError(null)
    try {
      setShown({ id, value: await api.get(path(id)) })
    } catch (error) {
      setLocalError(errorMessage(error))
    }
  }
  const store = () => {
    setLocalError(null)
    try {
      void action.run("PUT", path(importId.trim()), JSON.parse(pasted) as unknown)
    } catch (error) {
      setLocalError(errorMessage(error))
    }
  }
  const list = snapshots.data?.snapshots ?? []
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="snapshot-and-restore"
        description="A snapshot is the whole namespace: records, id counters, the clock, random streams, fault rules and latency. Resetting the namespace discards its snapshots."
        actions={<Refresh loading={snapshots.loading} onClick={snapshots.reload} />}
      >
        Snapshot and restore
      </ViewTitle>
      <ErrorNotice
        error={snapshots.error ?? localError ?? action.error ?? restore.error}
        retry={snapshots.reload}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_2fr]">
        <Section title="Take a snapshot">
          <Form
            className="flex flex-col gap-4"
            onSubmit={submitted(
              () => void action.run("POST", "/snapshots", name.trim() ? { name: name.trim() } : {}),
            )}
          >
            <TextInput
              label="Name"
              ariaLabel="Snapshot name"
              placeholder="baseline"
              value={name}
              onChange={setName}
              description="Optional. A name that is already used replaces that snapshot; without one the id is snap_1, snap_2, …"
            />
            <Button type="submit" className="self-start" isPending={action.busy}>
              Take snapshot
            </Button>
          </Form>
        </Section>
        <Section title="Import a snapshot">
          <Form className="flex flex-col gap-4" onSubmit={submitted(store)}>
            <TextInput
              label="Id"
              ariaLabel="Imported snapshot id"
              placeholder="baseline"
              value={importId}
              onChange={setImportId}
              description="The document is stored under this id, not restored."
            />
            <TextInput
              label="Snapshot document"
              ariaLabel="Snapshot document JSON"
              rows={5}
              monospace
              placeholder={'{\n  "format": "mockingbird.snapshot/v1",\n  "records": []\n}'}
              value={pasted}
              onChange={setPasted}
            />
            <Button
              type="submit"
              variant="secondary"
              className="self-start"
              isDisabled={!importId.trim() || !pasted.trim()}
              isPending={action.busy}
            >
              Import snapshot
            </Button>
          </Form>
        </Section>
      </div>
      <Section title="Saved snapshots">
        <DataTable
          label="Saved snapshots"
          rows={list.map((snapshot) => ({
            id: snapshot.id,
            records: snapshot.records,
            at: new Date(snapshot.at).toISOString(),
            portable: snapshot.portable,
          }))}
          columns={["id", "records", "at", "portable"]}
          rowKeys={list.map((snapshot) => snapshot.id)}
          loading={snapshots.loading}
          action={(row) => {
            const id = text(row.id)
            return (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={row.portable !== true}
                  onPress={() => void show(id)}
                >
                  View
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() =>
                    confirm({
                      title: `Restore ${id}?`,
                      content: `This replaces ${api.namespace()} with the snapshot: records, clock, fault rules and latency.`,
                      okText: "Restore",
                      onOk: () => restore.run("POST", `${path(id)}/restore`, {}),
                    })
                  }
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="danger-soft"
                  onPress={() =>
                    confirm({
                      title: `Delete snapshot ${id}?`,
                      okText: "Delete",
                      danger: true,
                      onOk: () => action.run("DELETE", path(id)),
                    })
                  }
                >
                  Delete
                </Button>
              </>
            )
          }}
        />
      </Section>
      {shown && (
        <Section
          title={`Snapshot ${shown.id}`}
          actions={
            <>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => downloadJson(`${shown.id}.json`, shown.value)}
              >
                <ArrowDownToLine className="size-4" />
                Download JSON
              </Button>
              <Button size="sm" variant="tertiary" onPress={() => setShown(null)}>
                Close
              </Button>
            </>
          }
        >
          <Json value={shown.value} label={`${shown.id}.json`} />
        </Section>
      )}
    </div>
  )
}

export function JournalView({
  api,
  revision,
  target = {},
}: {
  api: Api
  revision: number
  target?: RequestTarget
}) {
  const [live, setLive] = useState(true)
  const journal = useResource<Journal>(api, journalPath(target), revision, live)
  const { notify, confirm } = useChrome()
  const action = useAction(api, () => {
    journal.reload()
    notify("Journal cleared")
  })
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="journal-and-state"
        description="The latest 1,000 completed matching requests in this namespace, oldest first. Live updates every 1.5 seconds. Requests appear after completion or failure, including timeouts. Status 0 means a dropped connection. Open a row's details for its metadata; request bodies are never stored."
        actions={
          <>
            <Toggle label="Live" ariaLabel="Live journal" isSelected={live} onChange={setLive} />
            <Refresh loading={journal.loading} onClick={journal.reload} />
            <Button
              variant="danger-soft"
              size="sm"
              isPending={action.busy}
              onPress={() =>
                confirm({
                  title: "Clear this namespace's journal?",
                  okText: "Clear journal",
                  danger: true,
                  onOk: () => action.run("DELETE", "/requests"),
                })
              }
            >
              <TrashBin className="size-4" />
              Clear journal
            </Button>
          </>
        }
      >
        Request journal
      </ViewTitle>
      <ErrorNotice error={journal.error ?? action.error} retry={journal.reload} />
      <Section
        title="Request attempts"
        description="After clicking Retry in your app, look for an increased attempt count and a new journal row with the same method, path and operation. Repeated requests can also come from polling or other callers; the journal records what reached the emulator."
      >
        <DataTable
          label="Request attempts"
          rows={requestAttempts(journal.data?.requests ?? [])}
          columns={[
            "method",
            "path",
            "operationId",
            "attempts",
            "failures",
            "firstStatus",
            "latestStatus",
            "latestAt",
          ]}
        />
      </Section>
      <Section title="Requests">
        <DataTable
          label="Requests"
          rows={journal.data?.requests ?? []}
          columns={[
            "at",
            "method",
            "path",
            "status",
            "operationId",
            "durationMs",
            "delayMs",
            "faultId",
          ]}
          widths={JOURNAL_WIDTHS}
          loading={journal.loading}
        />
      </Section>
    </div>
  )
}

export function RoutesView({
  api,
  revision,
  standardRoutes,
  initialRoute,
  initialBody,
  title = "Routes",
  description,
}: {
  api: Api
  revision: number
  standardRoutes: readonly string[]
  initialRoute?: string
  initialBody?: unknown
  title?: string
  description?: string
}) {
  const routes = useResource<{ routes: string[] }>(api, "/", revision)
  const [selected, setSelected] = useState<string | undefined>(initialRoute)
  const [body, setBody] = useState(pretty(initialBody ?? {}))
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const params = [...(selected ?? "").matchAll(/:([\w]+)/g)].map((match) => match[1] ?? "")
  const send = async () => {
    if (!selected) return
    const [method = "GET", template = "/"] = selected.split(" ")
    const path = template.replace(/:([\w]+)/g, (_, name: string) =>
      encodeURIComponent(values[name] ?? ""),
    )
    setBusy(true)
    setError(null)
    setResult(undefined)
    try {
      setResult(
        await api.send(
          method,
          path,
          method === "GET" || method === "DELETE" ? undefined : (JSON.parse(body) as unknown),
        ),
      )
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const choices = [...new Set([...(selected ? [selected] : []), ...(routes.data?.routes ?? [])])]
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        docs={false}
        description={description ?? "Call any admin route of this emulator and read its answer."}
        actions={<Refresh loading={routes.loading} onClick={routes.reload} />}
      >
        {title}
      </ViewTitle>
      <ErrorNotice error={routes.error ?? error} retry={routes.reload} />
      <Section title="Admin request runner">
        <SearchSelect
          label="Route"
          ariaLabel="Admin route"
          placeholder="Select a route"
          value={selected ?? null}
          isDisabled={Boolean(initialRoute)}
          onChange={(route) => {
            setSelected(route)
            setResult(undefined)
            setError(null)
            setValues({})
          }}
          choices={choices.map((route) => ({
            value: route,
            label: `${route}${standardRoutes.includes(route) ? "" : " · service"}`,
          }))}
          className="max-w-xl"
        />
        <Form className="flex flex-col gap-4" onSubmit={submitted(() => void send())}>
          {params.map((name) => (
            <TextInput
              key={name}
              label={name}
              name={name}
              isRequired
              value={values[name] ?? ""}
              onChange={(value) => setValues({ ...values, [name]: value })}
              className="max-w-xl"
            />
          ))}
          {selected && !selected.startsWith("GET ") && !selected.startsWith("DELETE ") && (
            <TextInput
              label="JSON body"
              ariaLabel="Request body"
              rows={8}
              monospace
              value={body}
              onChange={setBody}
            />
          )}
          <Button type="submit" className="self-start" isDisabled={!selected} isPending={busy}>
            Send request
          </Button>
        </Form>
        {result !== undefined && <Json value={result} label="Response" />}
      </Section>
    </div>
  )
}

export function TimelineView({ api, revision }: { api: Api; revision: number }) {
  const timeline = useResource<{
    branches: Record<string, string>
    checkpoints: Record<string, unknown>[]
  }>(api, "/timeline", revision)
  const [branch, setBranch] = useState("main")
  const [fork, setFork] = useState("")
  const { notify, confirm } = useChrome()
  const action = useAction(api, () => {
    timeline.reload()
    notify("Timeline updated")
  })
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="checkpoints-and-branches"
        description="Every successful write saves a checkpoint on the current branch. Restore one, or branch from it."
        actions={<Refresh loading={timeline.loading} onClick={timeline.reload} />}
      >
        Checkpoints
      </ViewTitle>
      <ErrorNotice error={timeline.error ?? action.error} retry={timeline.reload} />
      <Section title="Branches">
        <div className="flex flex-wrap items-end gap-3">
          <Choose
            label="Branch"
            ariaLabel="Branch"
            value={branch}
            onChange={setBranch}
            choices={Object.keys(timeline.data?.branches ?? { main: "" }).map((name) => ({
              value: name,
              label: name,
            }))}
            className="w-full max-w-xs"
          />
          <Button
            isPending={action.busy}
            onPress={() => void action.run("POST", "/checkpoints", { branch })}
          >
            Create checkpoint
          </Button>
        </div>
        <Form
          className="flex flex-wrap items-end gap-3"
          onSubmit={submitted(
            () => void action.run("POST", `/branches/${encodeURIComponent(fork.trim())}`, {}),
          )}
        >
          <TextInput
            label="New branch"
            ariaLabel="New branch name"
            placeholder="New branch name"
            value={fork}
            onChange={setFork}
            className="w-full max-w-xs"
          />
          <Button
            type="submit"
            variant="secondary"
            isDisabled={!fork.trim()}
            isPending={action.busy}
          >
            Create branch
          </Button>
        </Form>
      </Section>
      <Section title="Saved checkpoints">
        <DataTable
          label="Saved checkpoints"
          rows={timeline.data?.checkpoints ?? []}
          loading={timeline.loading}
          action={(row) => (
            <Button
              size="sm"
              variant="secondary"
              onPress={() =>
                confirm({
                  title: "Restore checkpoint?",
                  content: `Replace ${branch} with ${text(row.id)}.`,
                  okText: "Restore",
                  onOk: () =>
                    action.run("POST", `/branches/${encodeURIComponent(branch)}/checkout`, {
                      checkpoint: row.id,
                    }),
                })
              }
            >
              Restore
            </Button>
          )}
        />
      </Section>
    </div>
  )
}
