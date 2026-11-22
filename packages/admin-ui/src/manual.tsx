import { Alert, Button } from "@heroui/react"
import { useState } from "react"
import {
  Choose,
  DataTable,
  ErrorNotice,
  NumberInput,
  Section,
  TextInput,
  Toggle,
  useAction,
  useChrome,
  useResource,
  ViewTitle,
} from "./components.js"
import { JournalView } from "./controls.js"
import { type ManualEffect, manualFault, type RequestTarget } from "./manual-model.js"
import type { Api, Controls } from "./model.js"
import { errorMessage, text } from "./model.js"

const METHODS = ["", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

export function ManualView({ api, revision }: { api: Api; revision: number }) {
  const controls = useResource<Controls>(api, "/controls", revision)
  const [target, setTarget] = useState<RequestTarget>({})
  const [durationMs, setDurationMs] = useState<number | null>(3000)
  const [count, setCount] = useState<number | null>(1)
  const [localError, setLocalError] = useState<string | null>(null)
  const [journalRevision, setJournalRevision] = useState(0)
  const { notify } = useChrome()
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
        notify(`Armed ${effect} for the next ${count} matching request(s)`)
        setJournalRevision((value) => value + 1)
      }
    } catch (error) {
      setLocalError(errorMessage(error))
    }
  }
  const ready = Boolean(controls.data) && !action.busy
  return (
    <div className="flex flex-col gap-6">
      <ViewTitle
        page="latency-and-timeouts"
        description={`Arm a response, then trigger the request in your app. Delay it to inspect loading, time it out to inspect the error, then click Retry in your app and watch the journal. Actions affect future matching vendor requests in ${api.namespace()}.`}
      >
        Manual controls
      </ViewTitle>
      <ErrorNotice error={localError ?? controls.error ?? action.error} retry={controls.reload} />
      <Section title="1. Choose the request">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_2fr_2fr]">
          <Choose
            label="HTTP method"
            ariaLabel="Manual request method"
            value={target.method ?? ""}
            onChange={(method) => setTarget({ ...target, method })}
            choices={METHODS.map((value) => ({ value, label: value || "Any method" }))}
          />
          <TextInput
            label="Exact path"
            ariaLabel="Manual request path"
            placeholder="/v1/charges"
            value={target.path ?? ""}
            onChange={(path) => setTarget({ ...target, path })}
            description="Leave blank for any path."
          />
          <TextInput
            label="Operation ID"
            ariaLabel="Manual operation ID"
            placeholder="Any operation"
            value={target.operationId ?? ""}
            onChange={(operationId) => setTarget({ ...target, operationId })}
          />
        </div>
        {!target.method && !target.path?.trim() && !target.operationId?.trim() && (
          <Alert status="accent">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Matches every vendor request in this namespace. Background requests can consume the
                rule; choose a path or operation to target your UI action.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </Section>
      <Section title="2. Arm the next response">
        <Toggle
          label="Use real waits to inspect loading states"
          ariaLabel="Use real waits"
          isSelected={controls.data ? !controls.data.virtualTime : false}
          isDisabled={!ready}
          onChange={(real) => void action.run("PUT", "/controls", { virtualTime: !real })}
        />
        {controls.data?.virtualTime && (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                Virtual time is on. Delays finish immediately. Enable real waits before testing your
                app's loading state or client timeout.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberInput
            label="Wait (milliseconds)"
            ariaLabel="Manual wait milliseconds"
            minValue={0}
            value={durationMs}
            onChange={setDurationMs}
          />
          <NumberInput
            label="Number of matching requests"
            ariaLabel="Manual request count"
            minValue={1}
            value={count}
            onChange={setCount}
            description="Defaults to one so the retry can recover."
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button isDisabled={!ready} onPress={() => void arm("delay")}>
            Delay next request
          </Button>
          <Button variant="danger-soft" isDisabled={!ready} onPress={() => void arm("timeout")}>
            Timeout next request
          </Button>
          <Button variant="danger-soft" isDisabled={!ready} onPress={() => void arm("error")}>
            Fail next request (503)
          </Button>
        </div>
        <p className="m-0 text-sm text-muted">
          Delay holds the response before normal handling. Timeout waits, then drops the connection
          (the Bun server responds with 500). A 503 fails immediately. Rules retire after their
          count is used. Existing latency and fault rules still apply; arming multiple actions adds
          rules.
        </p>
      </Section>
      <Section
        title="Armed rules"
        description="Remove a rule to stop it affecting future requests. Requests already waiting keep their injected wait."
      >
        <DataTable
          label="Armed rules"
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
              size="sm"
              variant="danger-soft"
              isDisabled={action.busy}
              onPress={() =>
                void action.run("DELETE", `/faults/${encodeURIComponent(text(row.id))}`)
              }
            >
              Remove
            </Button>
          )}
        />
      </Section>
      <JournalView api={api} revision={revision + journalRevision} target={target} />
    </div>
  )
}
