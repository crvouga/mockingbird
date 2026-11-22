/**
 * The inputs under a service's row while Dev is chosen (#903): the values a developer types to
 * reach the dev resource from the browser, handed to the host's `setCredentials`. The screen
 * keeps them only while they are being typed; a saved secret is never shown back.
 */
import { Alert, Button, Input, Label, TextField } from "@heroui/react"
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react"
import { StatusChip } from "./react/status-chip.js"
import { blankCredentials, credentialValues, missingCredentials } from "./system-services-store.js"
import type { SystemService, SystemServiceField } from "./system-types.js"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type ServiceCredentialsProps = {
  service: SystemService
  fields: readonly SystemServiceField[]
  save(values: Record<string, string>): Promise<void>
  /** Forget this service's values; without it there is no Forget button. */
  clear?: (() => Promise<void>) | undefined
  /** The row's Test button, drawn beside Save. */
  test?: ReactNode
}

export function ServiceCredentials({
  service,
  fields,
  save,
  clear,
  test,
}: ServiceCredentialsProps) {
  const formId = useId()
  const [values, setValues] = useState(() => blankCredentials(fields))
  const [busy, setBusy] = useState<"save" | "clear">()
  const [error, setError] = useState<{ kind: "save" | "clear"; text: string }>()
  const [done, setDone] = useState<string>()
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  const missing = missingCredentials(fields, values)

  const run = async (kind: "save" | "clear", action: () => Promise<void>, text: string) => {
    setBusy(kind)
    setError(undefined)
    setDone(undefined)
    try {
      await action()
      if (!alive.current) return
      setDone(text)
      // Saved or forgotten: the typed values (secrets above all) leave the screen.
      setValues(blankCredentials(fields))
    } catch (cause) {
      if (alive.current) setError({ kind, text: message(cause) })
    } finally {
      if (alive.current) setBusy(undefined)
    }
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || missing.length) return
    void run("save", () => save(credentialValues(fields, values)), `${service.label} key saved.`)
  }

  return (
    <form
      aria-label={`${service.label} credentials`}
      data-testid="system-service-credentials"
      data-configured={service.configured ? "" : undefined}
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface-secondary p-3"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-foreground">Your dev credentials</span>
        {service.configured ? (
          <span data-testid="system-service-configured" className="inline-flex">
            <StatusChip status="ok">Key saved</StatusChip>
          </span>
        ) : (
          <span className="text-muted">Not saved yet</span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map((field) =>
          field.options ? (
            <div key={field.name} className="flex min-w-0 flex-col gap-1">
              <Label htmlFor={`${formId}-${field.name}`}>{field.label}</Label>
              <select
                id={`${formId}-${field.name}`}
                name={field.name}
                value={values[field.name] ?? ""}
                disabled={!!busy}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setValues((current) => ({ ...current, [field.name]: value }))
                }}
                className="input w-full"
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <TextField
              key={field.name}
              name={field.name}
              type={field.secret ? "password" : "text"}
              value={values[field.name] ?? ""}
              isDisabled={!!busy}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
              className="min-w-0"
            >
              <Label>{field.label}</Label>
              <Input
                autoComplete="off"
                spellCheck={false}
                className={field.secret ? "font-mono" : ""}
                {...(service.configured && field.secret
                  ? { placeholder: "Saved · type to replace" }
                  : field.placeholder
                    ? { placeholder: field.placeholder }
                    : {})}
              />
            </TextField>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          isDisabled={!!busy || missing.length > 0}
          data-testid="system-service-credentials-save"
        >
          {busy === "save" ? "Saving…" : service.configured ? "Replace key" : "Save key"}
        </Button>
        {clear && service.configured ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!!busy}
            data-testid="system-service-credentials-clear"
            onPress={() => {
              void run("clear", clear, `${service.label} key forgotten.`)
            }}
          >
            {busy === "clear" ? "Forgetting…" : "Forget"}
          </Button>
        ) : null}
        {test}
      </div>
      <p className="m-0 text-xs text-muted">
        Kept by this preview, not by the System screen. Use a non-production key only.
      </p>
      <p role="status" data-testid="system-service-credentials-status" className="sr-only">
        {done ?? ""}
      </p>
      {error ? (
        <Alert status="danger" role="alert">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Couldn't {error.kind === "clear" ? "forget" : "save"} the {service.label} key:{" "}
              {error.text}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </form>
  )
}
