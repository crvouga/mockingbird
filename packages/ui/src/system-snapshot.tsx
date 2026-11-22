/**
 * The System screen's Data card (save, load and reset of the whole in-tab state) and the host
 * for a consumer's own sections.
 */
import { ArrowDownToSquare, ArrowRotateLeft, ArrowUpFromSquare } from "@gravity-ui/icons"
import { Alert, Button, Card } from "@heroui/react"
import { useEffect, useId, useRef, useState } from "react"
import { ErrorState, LoadingState } from "./react/states.js"
import type { SystemSection, SystemSnapshot } from "./system-types.js"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const defaultName = (now: Date) =>
  `mockingbird-state-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`

type Busy = "save" | "load" | "reset"
type Confirm = { kind: "load"; file: File } | { kind: "reset" }

/** Save (downloads the file), Load (asks first) and Reset (asks first); a failure shows inline. */
export function DataCard({ snapshot }: { snapshot: SystemSnapshot }) {
  const headingId = useId()
  const input = useRef<HTMLInputElement>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const [busy, setBusy] = useState<Busy>()
  const [confirm, setConfirm] = useState<Confirm>()
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  useEffect(() => {
    if (confirm) confirmButton.current?.focus()
  }, [confirm])

  const run = async (kind: Busy, action: () => Promise<string>) => {
    setBusy(kind)
    setError(undefined)
    setDone(undefined)
    setConfirm(undefined)
    try {
      const text = await action()
      if (alive.current) setDone(text)
    } catch (cause) {
      if (alive.current) setError(message(cause))
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }

  const save = () =>
    run("save", async () => {
      const blob = await snapshot.save()
      const name = snapshot.fileName?.() ?? defaultName(new Date())
      const doc = input.current?.ownerDocument ?? document
      const url = URL.createObjectURL(blob)
      try {
        const link = doc.createElement("a")
        link.href = url
        link.download = name
        link.hidden = true
        doc.body.append(link)
        link.click()
        link.remove()
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1_000)
      }
      return `Saved ${name}.`
    })
  const accept = () => {
    const pending = confirm
    if (!pending) return
    if (pending.kind === "reset")
      void run("reset", async () => {
        await snapshot.reset()
        return "Reset to the seeded state."
      })
    else
      void run("load", async () => {
        await snapshot.load(pending.file)
        return `Loaded ${pending.file.name}.`
      })
  }

  return (
    <section aria-labelledby={headingId} data-testid="system-data">
      <div className="mb-4">
        <h2 id={headingId} className="text-xl font-semibold tracking-tight text-foreground">
          Data
        </h2>
        <p className="mt-1 text-sm text-muted">
          Everything the apps and emulators keep in this tab. Save it to a file to hand someone a
          bug, load one to reproduce it, or reset to the seeded state.
        </p>
      </div>
      <Card className="gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" isDisabled={busy !== undefined} onPress={save}>
            <ArrowDownToSquare aria-hidden="true" className="size-4" />
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy !== undefined}
            onPress={() => input.current?.click()}
          >
            <ArrowUpFromSquare aria-hidden="true" className="size-4" />
            {busy === "load" ? "Loading…" : "Load…"}
          </Button>
          <Button
            size="sm"
            variant="danger-soft"
            isDisabled={busy !== undefined}
            onPress={() => {
              setError(undefined)
              setDone(undefined)
              setConfirm({ kind: "reset" })
            }}
          >
            <ArrowRotateLeft aria-hidden="true" className="size-4" />
            {busy === "reset" ? "Resetting…" : "Reset"}
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            aria-label="State file to load"
            data-testid="system-data-file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ""
              if (!file) return
              setError(undefined)
              setDone(undefined)
              setConfirm({ kind: "load", file })
            }}
          />
        </div>
        {confirm ? (
          // biome-ignore lint/a11y/useSemanticElements: an inline confirmation, not a form fieldset.
          <div
            role="group"
            aria-label={confirm.kind === "reset" ? "Confirm reset" : "Confirm load"}
            data-testid="system-data-confirm"
            data-kind={confirm.kind}
            onKeyDown={(event) => {
              if (event.key === "Escape") setConfirm(undefined)
            }}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-secondary px-3 py-2 text-sm"
          >
            <p className="m-0 min-w-0 flex-[1_1_240px] text-foreground">
              {confirm.kind === "reset"
                ? "Reset every app and emulator in this tab to its seeded state? What is not saved is lost."
                : `Replace this tab's state with ${confirm.file.name}? What is not saved is lost.`}
            </p>
            <div className="ml-auto flex gap-1.5">
              <Button size="sm" variant="ghost" onPress={() => setConfirm(undefined)}>
                Cancel
              </Button>
              <Button
                ref={confirmButton}
                size="sm"
                variant={confirm.kind === "reset" ? "danger" : "primary"}
                onPress={accept}
              >
                {confirm.kind === "reset" ? "Reset" : "Load"}
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <Alert status="danger" role="alert" data-testid="system-data-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        <p role="status" data-testid="system-data-status" className="m-0 text-sm text-muted">
          {done ?? ""}
        </p>
      </Card>
    </section>
  )
}

/** A consumer's section: mounted once into its own element, disposed when the screen goes. */
export function SectionMount({ section }: { section: SystemSection }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ status: "loading" | "ready" } | { error: string }>({
    status: "loading",
  })
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: mounted again only on Retry.
  useEffect(() => {
    const node = host.current
    if (!node) return
    const abort = new AbortController()
    let dispose: (() => void) | undefined
    setState({ status: "loading" })
    Promise.resolve()
      .then(() => section.mount(node, abort.signal))
      .then(
        (done) => {
          if (abort.signal.aborted) done?.()
          else {
            dispose = done
            setState({ status: "ready" })
          }
        },
        (error: unknown) => {
          if (!abort.signal.aborted) setState({ error: message(error) })
        },
      )
    return () => {
      abort.abort()
      try {
        dispose?.()
      } catch {
        /* The screen goes regardless. */
      }
      node.replaceChildren()
    }
  }, [section, attempt])
  return (
    <div data-testid={`system-section-${section.id}`}>
      {"error" in state ? (
        <ErrorState
          title={`Couldn't open ${section.label}`}
          error={state.error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : state.status === "loading" ? (
        <LoadingState />
      ) : null}
      <div ref={host} hidden={"error" in state} />
    </div>
  )
}
