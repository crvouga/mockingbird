import { DeleteOutlined, DownloadOutlined, PlusOutlined } from "@ant-design/icons"
import {
  App,
  Button,
  Card,
  Descriptions,
  Flex,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
} from "antd"
import { useState } from "react"
import {
  DataTable,
  ErrorNotice,
  Json,
  Refresh,
  useAction,
  useResource,
  ViewTitle,
} from "./components.js"
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

export function Overview({ api, revision }: { api: Api; revision: number }) {
  const health = useResource<Record<string, unknown>>(api, "/health", revision)
  const state = useResource<StateView>(api, "/state", revision)
  const clock = useResource<Clock>(api, "/clock", revision)
  const controls = useResource<Controls>(api, "/controls", revision)
  const journal = useResource<Journal>(api, "/requests?limit=8", revision)
  const { modal, message } = App.useApp()
  const reset = useAction(api, () => {
    state.reload()
    clock.reload()
    controls.reload()
    journal.reload()
    void message.success("Namespace reset")
  })
  const overrides = Object.keys(controls.data?.latency.operations ?? {}).length
  return (
    <Flex vertical gap="large">
      <ViewTitle>Overview</ViewTitle>
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
      <Flex gap="middle" wrap>
        <Card loading={health.loading} style={{ flex: "1 1 200px" }}>
          <Statistic title="Service" value={text(health.data?.service)} />
        </Card>
        <Card loading={state.loading} style={{ flex: "1 1 200px" }}>
          <Statistic title="Collections" value={state.data?.collections.length ?? 0} />
        </Card>
        <Card loading={state.loading} style={{ flex: "1 1 200px" }}>
          <Statistic
            title="Records"
            value={state.data?.collections.reduce((sum, item) => sum + item.count, 0) ?? 0}
          />
        </Card>
      </Flex>
      <Card title="Environment" loading={clock.loading || health.loading || controls.loading}>
        <Descriptions
          column={1}
          bordered
          items={[
            {
              key: "status",
              label: "Status",
              children: <Tag color="success">{text(health.data?.status)}</Tag>,
            },
            { key: "namespace", label: "Namespace", children: api.namespace() },
            {
              key: "time",
              label: "Clock",
              children: clock.data
                ? `${new Date(clock.data.now).toLocaleString()} · ${clock.data.frozen ? "Frozen" : "Live"}`
                : "—",
            },
            { key: "seed", label: "Seed", children: text(controls.data?.seed) },
            {
              key: "virtualTime",
              label: "Virtual time",
              children: controls.data ? (controls.data.virtualTime ? "On" : "Off") : "—",
            },
            {
              key: "latency",
              label: "Latency",
              children: controls.data
                ? `${wait(controls.data.latency)}${overrides ? ` · ${overrides} per-operation` : ""}`
                : "—",
            },
          ]}
        />
      </Card>
      <Card title="Recent requests">
        <DataTable
          rows={journal.data?.requests ?? []}
          columns={["method", "path", "status", "operationId", "durationMs", "delayMs", "faultId"]}
          widths={JOURNAL_WIDTHS}
          loading={journal.loading}
        />
      </Card>
      <Card title="Reset namespace">
        <Flex gap="middle" wrap align="center">
          <Typography.Text type="secondary">
            Return {api.namespace()} to its boot state. Other namespaces are unaffected.
          </Typography.Text>
          <Button
            danger
            loading={reset.busy}
            onClick={() =>
              modal.confirm({
                title: `Reset ${api.namespace()}?`,
                content:
                  "The namespace returns to its boot state: records, clock, faults, latency, snapshots and journal.",
                okText: "Reset namespace",
                okButtonProps: { danger: true },
                onOk: async () => {
                  if (!(await reset.run("POST", "/reset", {}))) throw new Error("Reset failed")
                },
              })
            }
          >
            Reset namespace
          </Button>
        </Flex>
      </Card>
    </Flex>
  )
}

export function ClockView({ api, revision }: { api: Api; revision: number }) {
  const clock = useResource<Clock>(api, "/clock", revision)
  const controls = useResource<Controls>(api, "/controls", revision)
  const { message } = App.useApp()
  const action = useAction(api, () => {
    clock.reload()
    void message.success("Clock updated")
  })
  const virtual = useAction(api, () => {
    controls.reload()
    void message.success("Virtual time updated")
  })
  const autoAdvance = clock.data?.autoAdvanceMs ? `${clock.data.autoAdvanceMs} ms` : "off"
  return (
    <Flex vertical gap="large">
      <Flex justify="space-between" gap="middle" wrap>
        <ViewTitle page="clock">Clock</ViewTitle>
        <Refresh loading={clock.loading} onClick={clock.reload} />
      </Flex>
      <ErrorNotice
        error={clock.error ?? controls.error ?? action.error ?? virtual.error}
        retry={() => {
          clock.reload()
          controls.reload()
        }}
      />
      <Card title="Current time" loading={clock.loading}>
        <Flex vertical gap="middle">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {clock.data?.iso ?? "—"}
          </Typography.Title>
          <Flex gap="middle" align="center">
            <Switch
              aria-label="Freeze clock"
              checked={clock.data?.frozen ?? false}
              loading={action.busy}
              onChange={(freeze) => void action.run("POST", "/clock", { freeze })}
            />
            <Typography.Text>Freeze clock</Typography.Text>
          </Flex>
          <Space wrap>
            {[
              ["−1h", -3600000],
              ["+1m", 60000],
              ["+15m", 900000],
              ["+1h", 3600000],
              ["+1d", 86400000],
            ].map(([label, advance]) => (
              <Button
                key={String(label)}
                disabled={action.busy}
                onClick={() => void action.run("POST", "/clock", { advance })}
              >
                {label}
              </Button>
            ))}
          </Space>
          <Button
            loading={action.busy}
            onClick={() => void action.run("POST", "/clock", { reset: true })}
          >
            Reset clock
          </Button>
        </Flex>
      </Card>
      <Flex gap="middle" wrap align="stretch">
        <Card title="Set an instant" style={{ flex: "1 1 300px" }}>
          <Form
            layout="vertical"
            onFinish={(values: { set: string }) =>
              void action.run("POST", "/clock", { set: values.set })
            }
          >
            <Form.Item
              label="ISO 8601 timestamp"
              name="set"
              rules={[
                { required: true },
                {
                  validator: async (_, value: string) => {
                    if (!Number.isFinite(Date.parse(value)))
                      throw new Error("Enter an ISO timestamp")
                  },
                },
              ]}
            >
              <Input placeholder="2026-01-01T00:00:00Z" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={action.busy}>
              Set time
            </Button>
          </Form>
        </Card>
        <Card title="Auto-advance" style={{ flex: "1 1 300px" }}>
          <Form
            layout="vertical"
            onFinish={(values: { autoAdvance: string }) =>
              void action.run("POST", "/clock", { autoAdvance: values.autoAdvance.trim() })
            }
          >
            <Form.Item
              label="Step before every vendor request"
              name="autoAdvance"
              rules={[{ required: true, message: "Enter a duration" }]}
              extra={`Currently ${autoAdvance}. A duration such as 1s or 250ms; 0 turns it off.`}
            >
              <Input placeholder="1s" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={action.busy}>
              Set auto-advance
            </Button>
          </Form>
        </Card>
        <Card title="Virtual time" loading={controls.loading} style={{ flex: "1 1 300px" }}>
          <Flex vertical gap="middle">
            <Flex gap="middle" align="center">
              <Switch
                aria-label="Virtual time"
                checked={controls.data?.virtualTime ?? false}
                loading={virtual.busy}
                onChange={(virtualTime) => void virtual.run("PUT", "/controls", { virtualTime })}
              />
              <Typography.Text>Virtual time</Typography.Text>
            </Flex>
            <Typography.Text type="secondary">
              When on, latency, fault delays and timeouts are spent on this clock instead of the
              wall clock: the request returns at once and the clock moves forward by the wait.
            </Typography.Text>
          </Flex>
        </Card>
      </Flex>
    </Flex>
  )
}

export function LatencyView({ api, revision }: { api: Api; revision: number }) {
  const latency = useResource<Latency>(api, "/latency", revision)
  const [form] = Form.useForm<{ operationId: string; delay: string; jitter?: string }>()
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    latency.reload()
    void message.success("Latency updated")
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
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between" align="center">
        <ViewTitle page="latency-and-timeouts">Latency</ViewTitle>
        <Space>
          <Refresh loading={latency.loading} onClick={latency.reload} />
          <Button
            danger
            loading={action.busy}
            icon={<DeleteOutlined />}
            onClick={() =>
              modal.confirm({
                title: "Clear this namespace's latency?",
                content: "The baseline and every per-operation override are removed.",
                onOk: async () => {
                  if (!(await action.run("DELETE", "/latency"))) throw new Error("Clear failed")
                },
              })
            }
          >
            Clear latency
          </Button>
        </Space>
      </Flex>
      <Typography.Paragraph type="secondary">
        How long every vendor request in this namespace takes, before any fault is considered.
        Durations are milliseconds or a string such as 250ms, 2s or 15m.
      </Typography.Paragraph>
      <ErrorNotice error={latency.error ?? action.error} retry={latency.reload} />
      <Card title="Baseline" loading={latency.loading}>
        {latency.data && (
          <Form
            // Remount with the stored values whenever they change.
            key={`${latency.data.delayMs}:${latency.data.jitterMs}`}
            name="latency-baseline"
            layout="vertical"
            initialValues={{
              delay: `${latency.data.delayMs}ms`,
              jitter: `${latency.data.jitterMs}ms`,
            }}
            onFinish={(values: { delay: string; jitter?: string }) =>
              void put({ delay: values.delay.trim(), jitter: values.jitter?.trim() || 0 })
            }
          >
            <Flex gap="middle" wrap>
              <Form.Item
                label="Delay"
                name="delay"
                rules={[{ required: true, message: "Enter a duration" }]}
                extra="Added to every request."
                style={{ flex: "1 1 220px" }}
              >
                <Input placeholder="40ms" />
              </Form.Item>
              <Form.Item
                label="Jitter"
                name="jitter"
                extra="A seeded extra wait from 0 up to this."
                style={{ flex: "1 1 220px" }}
              >
                <Input placeholder="10ms" />
              </Form.Item>
            </Flex>
            <Button type="primary" htmlType="submit" loading={action.busy}>
              Set baseline
            </Button>
          </Form>
        )}
      </Card>
      <Card title="Per-operation overrides">
        <Flex vertical gap="middle">
          <Typography.Text type="secondary">
            An override replaces the baseline for one operation. The journal lists each request's
            operationId.
          </Typography.Text>
          <Form
            form={form}
            name="latency-override"
            layout="vertical"
            onFinish={async (values) => {
              const added = await put({
                operations: {
                  ...operations,
                  [values.operationId.trim()]: {
                    delay: values.delay.trim(),
                    jitter: values.jitter?.trim() || 0,
                  },
                },
              })
              if (added) form.resetFields()
            }}
          >
            <Flex gap="middle" wrap>
              <Form.Item
                label="operationId"
                name="operationId"
                rules={[{ required: true, whitespace: true, message: "Enter an operationId" }]}
                style={{ flex: "2 1 240px" }}
              >
                <Input placeholder="CreateCharge" />
              </Form.Item>
              <Form.Item
                label="Delay"
                name="delay"
                rules={[{ required: true, message: "Enter a duration" }]}
                style={{ flex: "1 1 140px" }}
              >
                <Input placeholder="250ms" />
              </Form.Item>
              <Form.Item label="Jitter" name="jitter" style={{ flex: "1 1 140px" }}>
                <Input placeholder="0ms" />
              </Form.Item>
            </Flex>
            <Button htmlType="submit" icon={<PlusOutlined />} loading={action.busy}>
              Set override
            </Button>
          </Form>
          <DataTable
            rows={Object.entries(operations).map(([operationId, rule]) => ({
              operationId,
              ...rule,
            }))}
            columns={["operationId", "delayMs", "jitterMs"]}
            rowKeys={Object.keys(operations)}
            loading={latency.loading}
            action={(row) => (
              <Button
                danger
                disabled={action.busy}
                onClick={() =>
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
        </Flex>
      </Card>
    </Flex>
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

const FAULT_FIELD = { flex: "1 1 170px" }

export function FaultsView({ api, revision }: { api: Api; revision: number }) {
  const faults = useResource<{ faults: Record<string, unknown>[] }>(api, "/faults", revision)
  const presets = useResource<{ presets: FaultPreset[] }>(api, "/faults/presets", revision)
  const [mode, setMode] = useState<"fields" | "json">("fields")
  const [custom, setCustom] = useState('{\n  "status": 503,\n  "count": 1\n}')
  const [parseError, setParseError] = useState<string | null>(null)
  const [presetCount, setPresetCount] = useState<number | null>(null)
  const { message, modal } = App.useApp()
  const done = () => {
    faults.reload()
    void message.success("Fault rules updated")
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
    <Flex vertical gap="large">
      <Flex justify="space-between" wrap gap="middle">
        <ViewTitle page="faults">Faults</ViewTitle>
        <Refresh loading={faults.loading} onClick={faults.reload} />
      </Flex>
      <ErrorNotice
        error={faults.error ?? presets.error ?? remove.error}
        retry={() => {
          faults.reload()
          presets.reload()
        }}
      />
      <Card
        title="Add a fault"
        extra={
          <Segmented
            aria-label="Fault input"
            value={mode}
            onChange={setMode}
            options={[
              { label: "Fields", value: "fields" },
              { label: "JSON", value: "json" },
            ]}
          />
        }
      >
        <Flex vertical gap="middle">
          <ErrorNotice error={parseError ?? add.error} />
          {mode === "fields" ? (
            <Form layout="vertical" onFinish={submit}>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                Match
              </Typography.Title>
              <Flex gap="middle" wrap>
                <Form.Item label="operationId" name="operationId" style={FAULT_FIELD}>
                  <Input placeholder="Any operation" />
                </Form.Item>
                <Form.Item label="method" name="method" style={FAULT_FIELD}>
                  <Select
                    allowClear
                    placeholder="Any method"
                    options={["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(
                      (method) => ({ label: method, value: method }),
                    )}
                  />
                </Form.Item>
                <Form.Item label="path" name="path" extra="Exact path." style={FAULT_FIELD}>
                  <Input placeholder="/v1/charges" />
                </Form.Item>
                <Form.Item
                  label="pathPrefix"
                  name="pathPrefix"
                  extra="Paths starting with this."
                  style={FAULT_FIELD}
                >
                  <Input placeholder="/v1" />
                </Form.Item>
              </Flex>
              <Typography.Title level={5}>Schedule</Typography.Title>
              <Flex gap="middle" wrap>
                <Form.Item
                  label="after"
                  name="after"
                  extra="Let this many matches through first."
                  style={FAULT_FIELD}
                >
                  <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label="every"
                  name="every"
                  extra="Then fault only every nth match."
                  style={FAULT_FIELD}
                >
                  <InputNumber min={1} precision={0} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label="count"
                  name="count"
                  extra="Retire the rule after this many faults."
                  style={FAULT_FIELD}
                >
                  <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label="rate"
                  name="rate"
                  extra="Fraction to fault, 0 to 1, drawn from the seed."
                  style={FAULT_FIELD}
                >
                  <InputNumber min={0} max={1} step={0.1} style={{ width: "100%" }} />
                </Form.Item>
              </Flex>
              <Typography.Title level={5}>Action</Typography.Title>
              <Flex gap="middle" wrap>
                <Form.Item
                  label="status"
                  name="status"
                  extra="Answer with this status instead of reaching the emulator."
                  style={FAULT_FIELD}
                >
                  <InputNumber min={200} max={599} precision={0} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label="delay"
                  name="delay"
                  extra="Hold the response back."
                  style={FAULT_FIELD}
                >
                  <Input placeholder="2s" />
                </Form.Item>
                <Form.Item
                  label="jitter"
                  name="jitter"
                  extra="A seeded extra wait from 0 up to this."
                  style={FAULT_FIELD}
                >
                  <Input placeholder="100ms" />
                </Form.Item>
                <Form.Item
                  label="timeout"
                  name="timeout"
                  extra="Hold the request this long, then drop the connection."
                  style={FAULT_FIELD}
                >
                  <Input placeholder="30s" />
                </Form.Item>
                <Form.Item
                  label="truncate"
                  name="truncate"
                  extra="Cut the body off after this many bytes."
                  style={FAULT_FIELD}
                >
                  <InputNumber min={0} precision={0} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item
                  label="drop"
                  name="drop"
                  valuePropName="checked"
                  extra="Drop the connection at once."
                  style={FAULT_FIELD}
                >
                  <Switch aria-label="Drop the connection" />
                </Form.Item>
              </Flex>
              <Form.Item
                label="body"
                name="body"
                extra="The response body, as JSON. Quote a plain string."
              >
                <Input.TextArea
                  placeholder={'{"error": "unavailable"}'}
                  rows={3}
                  spellCheck={false}
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />} loading={add.busy}>
                Add fault
              </Button>
            </Form>
          ) : (
            <>
              <Form layout="vertical">
                <Form.Item
                  label="Rule JSON"
                  extra="Any rule field, including pathPattern, requestHeaders, query, requestBody, namespace, from, until, headers, effect and params."
                >
                  <Input.TextArea
                    aria-label="Fault rule JSON"
                    value={custom}
                    onChange={(event) => setCustom(event.target.value)}
                    rows={8}
                    spellCheck={false}
                  />
                </Form.Item>
              </Form>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                loading={add.busy}
                onClick={() => submit()}
                style={{ alignSelf: "flex-start" }}
              >
                Add fault
              </Button>
            </>
          )}
        </Flex>
      </Card>
      <Card
        title="Active rules"
        extra={
          <Button
            danger
            icon={<DeleteOutlined />}
            disabled={!rules.length}
            onClick={() =>
              modal.confirm({
                title: "Clear this namespace's fault rules?",
                content: "Rules that apply to every namespace stay.",
                onOk: async () => {
                  if (!(await remove.run("DELETE", "/faults"))) throw new Error("Clear failed")
                },
              })
            }
          >
            Clear all
          </Button>
        }
      >
        <DataTable
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
              danger
              disabled={remove.busy}
              onClick={() =>
                void remove.run("DELETE", `/faults/${encodeURIComponent(text(row.id))}`)
              }
            >
              Remove
            </Button>
          )}
        />
      </Card>
      <Card
        title="Presets"
        loading={presets.loading}
        extra={
          <InputNumber
            aria-label="Preset count"
            placeholder="count"
            min={0}
            precision={0}
            value={presetCount}
            onChange={setPresetCount}
          />
        }
      >
        <Flex vertical gap="middle">
          <Typography.Text type="secondary">
            A preset is a fault by name. Set a count to retire it after that many faults; without
            one it stays until removed.
          </Typography.Text>
          <ErrorNotice error={apply.error} />
          <Flex gap="middle" wrap>
            {presets.data?.presets.map((preset) => (
              <Card
                key={preset.name}
                size="small"
                title={preset.name}
                style={{ flex: "1 1 260px" }}
                extra={
                  <Button
                    size="small"
                    disabled={apply.busy}
                    onClick={() =>
                      void apply.run("POST", "/faults", {
                        preset: preset.name,
                        ...(presetCount === null ? {} : { count: presetCount }),
                      })
                    }
                  >
                    Apply
                  </Button>
                }
              >
                <Typography.Text type="secondary">{preset.description}</Typography.Text>
              </Card>
            ))}
          </Flex>
        </Flex>
      </Card>
    </Flex>
  )
}

const download = (name: string, value: unknown): void => {
  const url = URL.createObjectURL(new Blob([pretty(value)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export function SnapshotsView({ api, revision }: { api: Api; revision: number }) {
  const snapshots = useResource<{ snapshots: Snapshot[] }>(api, "/snapshots", revision)
  const [name, setName] = useState("")
  const [importId, setImportId] = useState("")
  const [pasted, setPasted] = useState("")
  const [shown, setShown] = useState<{ id: string; value: unknown } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    snapshots.reload()
    void message.success("Snapshots updated")
  })
  const restore = useAction(api, () => void message.success("Snapshot restored"))
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
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between">
        <ViewTitle page="snapshot-and-restore">Snapshot and restore</ViewTitle>
        <Refresh loading={snapshots.loading} onClick={snapshots.reload} />
      </Flex>
      <Typography.Paragraph type="secondary">
        A snapshot is the whole namespace: records, id counters, the clock, random streams, fault
        rules and latency. Resetting the namespace discards its snapshots.
      </Typography.Paragraph>
      <ErrorNotice
        error={snapshots.error ?? localError ?? action.error ?? restore.error}
        retry={snapshots.reload}
      />
      <Flex gap="middle" wrap align="stretch">
        <Card title="Take a snapshot" style={{ flex: "1 1 320px" }}>
          <Form
            layout="vertical"
            onFinish={() =>
              void action.run("POST", "/snapshots", name.trim() ? { name: name.trim() } : {})
            }
          >
            <Form.Item
              label="Name"
              extra="Optional. A name that is already used replaces that snapshot; without one the id is snap_1, snap_2, …"
            >
              <Input
                aria-label="Snapshot name"
                placeholder="baseline"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={action.busy}>
              Take snapshot
            </Button>
          </Form>
        </Card>
        <Card title="Import a snapshot" style={{ flex: "2 1 420px" }}>
          <Form layout="vertical" onFinish={store}>
            <Form.Item label="Id" extra="The document is stored under this id, not restored.">
              <Input
                aria-label="Imported snapshot id"
                placeholder="baseline"
                value={importId}
                onChange={(event) => setImportId(event.target.value)}
              />
            </Form.Item>
            <Form.Item label="Snapshot document">
              <Input.TextArea
                aria-label="Snapshot document JSON"
                placeholder={'{\n  "format": "mockingbird.snapshot/v1",\n  "records": []\n}'}
                value={pasted}
                onChange={(event) => setPasted(event.target.value)}
                rows={5}
                spellCheck={false}
              />
            </Form.Item>
            <Button
              htmlType="submit"
              disabled={!importId.trim() || !pasted.trim()}
              loading={action.busy}
            >
              Import snapshot
            </Button>
          </Form>
        </Card>
      </Flex>
      <Card title="Saved snapshots">
        <DataTable
          rows={list.map((snapshot) => ({
            id: snapshot.id,
            records: snapshot.records,
            at: new Date(snapshot.at).toISOString(),
            portable: snapshot.portable,
          }))}
          columns={["id", "records", "at", "portable"]}
          rowKeys={list.map((snapshot) => snapshot.id)}
          loading={snapshots.loading}
          actionWidth={270}
          action={(row) => {
            const id = text(row.id)
            return (
              <Space>
                <Button disabled={row.portable !== true} onClick={() => void show(id)}>
                  View
                </Button>
                <Button
                  onClick={() =>
                    modal.confirm({
                      title: `Restore ${id}?`,
                      content: `This replaces ${api.namespace()} with the snapshot: records, clock, fault rules and latency.`,
                      okText: "Restore",
                      onOk: async () => {
                        if (!(await restore.run("POST", `${path(id)}/restore`, {})))
                          throw new Error("Restore failed")
                      },
                    })
                  }
                >
                  Restore
                </Button>
                <Button
                  danger
                  onClick={() =>
                    modal.confirm({
                      title: `Delete snapshot ${id}?`,
                      okText: "Delete",
                      okButtonProps: { danger: true },
                      onOk: async () => {
                        if (!(await action.run("DELETE", path(id))))
                          throw new Error("Delete failed")
                      },
                    })
                  }
                >
                  Delete
                </Button>
              </Space>
            )
          }}
        />
      </Card>
      {shown && (
        <Card
          title={`Snapshot ${shown.id}`}
          extra={
            <Space>
              <Button
                icon={<DownloadOutlined />}
                onClick={() => download(`${shown.id}.json`, shown.value)}
              >
                Download JSON
              </Button>
              <Button onClick={() => setShown(null)}>Close</Button>
            </Space>
          }
        >
          <Json value={shown.value} />
        </Card>
      )}
    </Flex>
  )
}

export function JournalView({ api, revision }: { api: Api; revision: number }) {
  const journal = useResource<Journal>(api, "/requests?limit=1000", revision)
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    journal.reload()
    void message.success("Journal cleared")
  })
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between" align="center">
        <ViewTitle page="journal-and-state">Request journal</ViewTitle>
        <Space>
          <Refresh loading={journal.loading} onClick={journal.reload} />
          <Button
            danger
            loading={action.busy}
            icon={<DeleteOutlined />}
            onClick={() =>
              modal.confirm({
                title: "Clear this namespace's journal?",
                onOk: async () => {
                  if (!(await action.run("DELETE", "/requests"))) throw new Error("Clear failed")
                },
              })
            }
          >
            Clear journal
          </Button>
        </Space>
      </Flex>
      <Typography.Paragraph type="secondary">
        The latest 1,000 requests in this namespace. Expand a row for metadata; request bodies are
        never stored.
      </Typography.Paragraph>
      <ErrorNotice error={journal.error ?? action.error} retry={journal.reload} />
      <DataTable
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
    </Flex>
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
  const [result, setResult] = useState<unknown>()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<Record<string, string>>()
  const params = [...(selected ?? "").matchAll(/:([\w]+)/g)].map((match) => match[1] ?? "")
  const send = async (values: Record<string, string>) => {
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
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between">
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Refresh loading={routes.loading} onClick={routes.reload} />
      </Flex>
      {description && <Typography.Paragraph>{description}</Typography.Paragraph>}
      <ErrorNotice error={routes.error ?? error} retry={routes.reload} />
      <Card title="Admin request runner">
        <Flex vertical gap="middle">
          <Select
            aria-label="Admin route"
            showSearch
            optionFilterProp="label"
            placeholder="Select a route"
            value={selected}
            disabled={Boolean(initialRoute)}
            onChange={(route) => {
              setSelected(route)
              setResult(undefined)
              setError(null)
              form.resetFields()
            }}
            options={
              routes.data?.routes.map((route) => ({
                label: `${route}${standardRoutes.includes(route) ? "" : " · service"}`,
                value: route,
              })) ?? []
            }
          />
          <Form form={form} layout="vertical" onFinish={send}>
            {params.map((name) => (
              <Form.Item key={name} name={name} label={name} rules={[{ required: true }]}>
                <Input />
              </Form.Item>
            ))}
            {selected && !selected.startsWith("GET ") && !selected.startsWith("DELETE ") && (
              <Form.Item label="JSON body">
                <Input.TextArea
                  aria-label="Request body"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  rows={8}
                  spellCheck={false}
                />
              </Form.Item>
            )}
            <Button type="primary" htmlType="submit" disabled={!selected} loading={busy}>
              Send request
            </Button>
          </Form>
          {result !== undefined && <Json value={result} />}
        </Flex>
      </Card>
    </Flex>
  )
}

export function TimelineView({ api, revision }: { api: Api; revision: number }) {
  const timeline = useResource<{
    branches: Record<string, string>
    checkpoints: Record<string, unknown>[]
  }>(api, "/timeline", revision)
  const [branch, setBranch] = useState("main")
  const [fork, setFork] = useState("")
  const { message, modal } = App.useApp()
  const action = useAction(api, () => {
    timeline.reload()
    void message.success("Timeline updated")
  })
  return (
    <Flex vertical gap="large">
      <Flex wrap gap="middle" justify="space-between">
        <ViewTitle page="checkpoints-and-branches">Checkpoints</ViewTitle>
        <Refresh loading={timeline.loading} onClick={timeline.reload} />
      </Flex>
      <ErrorNotice error={timeline.error ?? action.error} retry={timeline.reload} />
      <Card title="Branches">
        <Flex vertical gap="middle">
          <Select
            aria-label="Branch"
            style={{ width: "100%", maxWidth: 400 }}
            value={branch}
            onChange={setBranch}
            options={Object.keys(timeline.data?.branches ?? { main: "" }).map((name) => ({
              label: name,
              value: name,
            }))}
          />
          <Space wrap>
            <Button
              type="primary"
              loading={action.busy}
              onClick={() => void action.run("POST", "/checkpoints", { branch })}
            >
              Create checkpoint
            </Button>
          </Space>
          <Flex gap="small" wrap>
            <Input
              aria-label="New branch name"
              placeholder="New branch name"
              value={fork}
              onChange={(event) => setFork(event.target.value)}
              style={{ maxWidth: 320 }}
            />
            <Button
              disabled={!fork.trim()}
              loading={action.busy}
              onClick={() =>
                void action.run("POST", `/branches/${encodeURIComponent(fork.trim())}`, {})
              }
            >
              Create branch
            </Button>
          </Flex>
        </Flex>
      </Card>
      <Card title="Saved checkpoints">
        <DataTable
          rows={timeline.data?.checkpoints ?? []}
          loading={timeline.loading}
          action={(row) => (
            <Button
              onClick={() =>
                modal.confirm({
                  title: "Restore checkpoint?",
                  content: `Replace ${branch} with ${text(row.id)}.`,
                  okText: "Restore",
                  onOk: async () => {
                    if (
                      !(await action.run(
                        "POST",
                        `/branches/${encodeURIComponent(branch)}/checkout`,
                        { checkpoint: row.id },
                      ))
                    )
                      throw new Error("Restore failed")
                  },
                })
              }
            >
              Restore
            </Button>
          )}
        />
      </Card>
    </Flex>
  )
}
