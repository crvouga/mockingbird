import {
  Alert,
  App,
  Button,
  Card,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Typography,
} from "antd"
import { useState } from "react"
import { DataTable, ErrorNotice, useAction, useResource, ViewTitle } from "./components.js"
import { JournalView } from "./controls.js"
import { type ManualEffect, manualFault, type RequestTarget } from "./manual-model.js"
import type { Api, Controls } from "./model.js"
import { errorMessage, text } from "./model.js"

export function ManualView({ api, revision }: { api: Api; revision: number }) {
  const controls = useResource<Controls>(api, "/controls", revision)
  const [target, setTarget] = useState<RequestTarget>({})
  const [durationMs, setDurationMs] = useState<number | null>(3000)
  const [count, setCount] = useState<number | null>(1)
  const [localError, setLocalError] = useState<string | null>(null)
  const [journalRevision, setJournalRevision] = useState(0)
  const { message } = App.useApp()
  const action = useAction(api, controls.reload)
  const arm = async (effect: ManualEffect) => {
    setLocalError(null)
    try {
      const rule = manualFault(effect, {
        ...target,
        durationMs: durationMs ?? -1,
        count: count ?? 0,
      })
      if (await action.run("POST", "/faults", rule)) {
        void message.success(`Armed ${effect} for the next ${count} matching request(s)`)
        setJournalRevision((value) => value + 1)
      }
    } catch (error) {
      setLocalError(errorMessage(error))
    }
  }
  return (
    <Flex vertical gap="large">
      <ViewTitle page="latency-and-timeouts">Manual controls</ViewTitle>
      <Typography.Paragraph type="secondary">
        Arm a response, then trigger the request in your app. Delay it to inspect loading, time it
        out to inspect the error, then click Retry in your app and watch the journal. Actions affect
        future matching vendor requests in {api.namespace()}.
      </Typography.Paragraph>
      <ErrorNotice error={localError ?? controls.error ?? action.error} retry={controls.reload} />
      <Card title="1. Choose the request">
        <Form layout="vertical">
          <Flex gap="middle" wrap>
            <Form.Item label="HTTP method" style={{ flex: "1 1 150px" }}>
              <Select
                aria-label="Manual request method"
                placeholder="Any method"
                value={target.method ?? ""}
                onChange={(method) => setTarget({ ...target, method })}
                options={["", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(
                  (value) => ({ value, label: value || "Any method" }),
                )}
              />
            </Form.Item>
            <Form.Item
              label="Exact path"
              extra="Leave blank for any path."
              style={{ flex: "2 1 240px" }}
            >
              <Input
                aria-label="Manual request path"
                placeholder="/v1/charges"
                value={target.path ?? ""}
                onChange={(event) => setTarget({ ...target, path: event.target.value })}
              />
            </Form.Item>
            <Form.Item label="Operation ID" style={{ flex: "2 1 200px" }}>
              <Input
                aria-label="Manual operation ID"
                placeholder="Any operation"
                value={target.operationId ?? ""}
                onChange={(event) => setTarget({ ...target, operationId: event.target.value })}
              />
            </Form.Item>
          </Flex>
        </Form>
        {!target.method && !target.path?.trim() && !target.operationId?.trim() && (
          <Alert
            type="info"
            showIcon
            title="Matches every vendor request in this namespace. Background requests can consume the rule; choose a path or operation to target your UI action."
          />
        )}
      </Card>
      <Card title="2. Arm the next response" loading={controls.loading && !controls.data}>
        <Flex vertical gap="middle">
          <Space wrap>
            <Switch
              aria-label="Use real waits"
              checked={controls.data ? !controls.data.virtualTime : false}
              disabled={!controls.data}
              loading={action.busy}
              onChange={(real) => void action.run("PUT", "/controls", { virtualTime: !real })}
            />
            <Typography.Text>Use real waits to inspect loading states</Typography.Text>
          </Space>
          {controls.data?.virtualTime && (
            <Alert
              type="warning"
              showIcon
              title="Virtual time is on. Delays finish immediately. Enable real waits before testing your app's loading state or client timeout."
            />
          )}
          <Form layout="vertical">
            <Flex gap="middle" wrap>
              <Form.Item label="Wait (milliseconds)" style={{ flex: "1 1 220px" }}>
                <InputNumber
                  aria-label="Manual wait milliseconds"
                  min={0}
                  precision={0}
                  value={durationMs}
                  onChange={setDurationMs}
                  style={{ width: "100%" }}
                />
              </Form.Item>
              <Form.Item
                label="Number of matching requests"
                extra="Defaults to one so the retry can recover."
                style={{ flex: "1 1 220px" }}
              >
                <InputNumber
                  aria-label="Manual request count"
                  min={1}
                  precision={0}
                  value={count}
                  onChange={setCount}
                  style={{ width: "100%" }}
                />
              </Form.Item>
            </Flex>
          </Form>
          <Space wrap>
            <Button
              type="primary"
              disabled={!controls.data || action.busy}
              onClick={() => void arm("delay")}
            >
              Delay next request
            </Button>
            <Button
              danger
              disabled={!controls.data || action.busy}
              onClick={() => void arm("timeout")}
            >
              Timeout next request
            </Button>
            <Button
              danger
              disabled={!controls.data || action.busy}
              onClick={() => void arm("error")}
            >
              Fail next request (503)
            </Button>
          </Space>
          <Typography.Text type="secondary">
            Delay holds the response before normal handling. Timeout waits, then drops the
            connection (the Bun server responds with 500). A 503 fails immediately. Rules retire
            after their count is used. Existing latency and fault rules still apply; arming multiple
            actions adds rules.
          </Typography.Text>
        </Flex>
      </Card>
      <Card title="Armed rules">
        <Typography.Paragraph type="secondary">
          Remove a rule to stop it affecting future requests. Requests already waiting keep their
          injected wait.
        </Typography.Paragraph>
        <DataTable
          rows={controls.data?.faults ?? []}
          widths={{
            id: 130,
            method: 90,
            path: 220,
            operationId: 180,
            delayMs: 100,
            timeoutMs: 100,
            status: 90,
            remaining: 100,
          }}
          columns={[
            "id",
            "method",
            "path",
            "operationId",
            "delayMs",
            "timeoutMs",
            "status",
            "remaining",
          ]}
          action={(row) => (
            <Button
              danger
              disabled={action.busy}
              onClick={() =>
                void action.run("DELETE", `/faults/${encodeURIComponent(text(row.id))}`)
              }
            >
              Remove
            </Button>
          )}
        />
      </Card>
      <JournalView api={api} revision={revision + journalRevision} target={target} />
    </Flex>
  )
}
