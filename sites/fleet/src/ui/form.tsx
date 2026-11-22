/**
 * The one layout every mutation screen uses: a heading that names the action and its object, a
 * sentence of consequence, labelled fields, one submit button and a Cancel link.
 *
 * Feedback stays in the form. A problem with a field is written under that field and tied to it
 * with `aria-describedby` and `aria-invalid`; anything else is a summary at the top of the form
 * (`role="alert"`). While the request is in flight the submit button is disabled and says so.
 */
import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import {
  Alert,
  Button,
  buttonVariants,
  Card,
  Description,
  FieldError,
  Form,
  Input,
  Label,
  ListBox,
  Radio,
  RadioGroup,
  Select,
  TextField,
} from "@heroui/react"
import { type InputHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react"
import { type Child, Head, Narrow, Notice } from "./kit.js"
import { ApiError, busy, MANAGED_BY_DECLARATION } from "./runtime.js"

export type Values = Record<string, string>

type Common = {
  name: string
  label: string
  hint?: Child
  /** What to say when it is left empty; absent means it may be. */
  required?: string
}
export type Field =
  | (Common & {
      kind: "text"
      type?: "text" | "email" | "password" | "number"
      value?: string
      attrs?: Pick<
        InputHTMLAttributes<HTMLInputElement>,
        | "maxLength"
        | "autoComplete"
        | "inputMode"
        | "autoCapitalize"
        | "spellCheck"
        | "min"
        | "step"
      >
    })
  | (Common & { kind: "select"; value: string; options: { value: string; label: string }[] })
  | (Common & {
      kind: "choice"
      value: string
      options: { value: string; label: string; description?: string; note?: string }[]
    })

export type MutationSpec = {
  title: string
  crumbs?: Child
  /** What submitting does, where that is not obvious from the title. */
  lead?: Child
  /** A better way to do this than the form, said once above it. */
  note?: Child
  /** The action destroys something: the consequence and the button are marked. */
  danger?: boolean
  /** Facts about the thing acted on, shown read-only above the fields. */
  facts?: Child
  fields?: Field[]
  submit: string
  /** The button's label while the request is in flight: "Creating…". */
  pending: string
  /** Where Cancel goes: the screen this one was opened from. */
  cancel: string
  /** The summary's first line when the API refuses: "The project was not created." */
  failed: string
  /** Problems the browser can see without asking: field name → message. */
  check?: (values: Values) => Record<string, string>
  /** The field a refusal without `details` is about, if it is about one. */
  place?: (error: ApiError) => string | undefined
  /** Make the one API call, then `land` on the screen its result lives on. */
  run: (values: Values) => Promise<unknown>
  /** Drawn for someone who is not signed in: one card in the middle of the page. */
  signedOut?: boolean
}

const fieldId = (name: string) => `field-${name}`

/** The value a select's "nothing chosen" option stands for: React Aria keys cannot be empty. */
const NONE = "__none"

/** "must be at most 80 characters" → "Name must be at most 80 characters." */
function phrase(label: string, problem: string) {
  if (problem === "required") return `Enter ${label.charAt(0).toLowerCase()}${label.slice(1)}.`
  const sentence = /^[a-z]/.test(problem) ? `${label} ${problem}` : problem
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

/** Sort a refusal into the fields it is about and whatever belongs to none of them. */
export function sortProblems(error: unknown, fields: Field[], place?: MutationSpec["place"]) {
  const byField: Record<string, string> = {}
  const rest: string[] = []
  if (!(error instanceof ApiError))
    return {
      byField,
      rest: ["The server could not be reached. Check your connection and try again."],
    }
  const details = Array.isArray(error.details)
    ? error.details.filter((detail): detail is string => typeof detail === "string")
    : []
  for (const detail of details) {
    const [, name, problem] = /^body\.([A-Za-z0-9_]+)[^:]*:\s*(.*)$/.exec(detail) ?? []
    const field = fields.find((entry) => entry.name === name)
    if (field && problem) byField[field.name] ??= phrase(field.label, problem)
    else rest.push(detail)
  }
  if (details.length === 0) {
    // The organization came under a mockingbird.yaml meanwhile: no field's value is at fault.
    const about = error.code === MANAGED_BY_DECLARATION ? undefined : place?.(error)
    const field = fields.find((entry) => entry.name === about)
    // The API names the field by its JSON key ("requestsPerMinute cannot exceed…"): use its label.
    if (field)
      byField[field.name] = phrase(
        field.label,
        error.message.startsWith(`${field.name} `)
          ? error.message.slice(field.name.length + 1)
          : error.message.replace(/^[a-z]/, (letter) => letter.toUpperCase()),
      )
    else rest.push(error.message)
  }
  return { byField, rest }
}

/** A problem written under its field; `audit.ts` finds it by this class. */
const Problem = ({ children }: { children: ReactNode }) => (
  <FieldError className="field-error">{children}</FieldError>
)

function Control({ field, problem }: { field: Field; problem: string | undefined }) {
  const id = fieldId(field.name)
  const invalid = problem !== undefined
  const hint = field.hint ? <Description>{field.hint}</Description> : null
  if (field.kind === "choice")
    return (
      <RadioGroup
        id={id}
        data-field={field.name}
        name={field.name}
        defaultValue={field.value}
        isInvalid={invalid}
        validationBehavior="aria"
      >
        <Label>{field.label}</Label>
        {hint}
        <div className="mt-1 flex flex-col gap-2">
          {field.options.map((option) => (
            <Radio
              key={option.value}
              value={option.value}
              className="rounded-lg border border-border px-3 py-2.5"
            >
              <Radio.Content>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {option.label}
                    {option.note ? (
                      <span className="rounded-full bg-default px-2 text-xs font-normal text-muted">
                        {option.note}
                      </span>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="text-sm text-muted">{option.description}</span>
                  ) : null}
                </span>
              </Radio.Content>
            </Radio>
          ))}
        </div>
        <Problem>{problem}</Problem>
      </RadioGroup>
    )
  if (field.kind === "select")
    return (
      <div data-field={field.name}>
        <Select
          id={id}
          name={field.name}
          defaultSelectedKey={field.value || NONE}
          isInvalid={invalid}
          validationBehavior="aria"
          fullWidth
        >
          <Label>{field.label}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          {hint}
          <Problem>{problem}</Problem>
          <Select.Popover>
            <ListBox>
              {field.options.map((option) => (
                <ListBox.Item
                  key={option.value || NONE}
                  id={option.value || NONE}
                  textValue={option.label}
                >
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
    )
  return (
    <div data-field={field.name}>
      <TextField
        name={field.name}
        type={field.type ?? "text"}
        defaultValue={field.value ?? ""}
        isInvalid={invalid}
        validationBehavior="aria"
        fullWidth
      >
        <Label>{field.label}</Label>
        <Input id={id} autoComplete="off" {...field.attrs} />
        {hint}
        <Problem>{problem}</Problem>
      </TextField>
    </div>
  )
}

function MutationForm({ spec }: { spec: MutationSpec }) {
  const fields = spec.fields ?? []
  const form = useRef<HTMLFormElement>(null)
  const summary = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(false)
  const [problems, setProblems] = useState<{ byField: Record<string, string>; rest: string[] }>({
    byField: {},
    rest: [],
  })
  /** Bumped each time problems are shown, so the focus moves to them even when they repeat. */
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (shown === 0) return
    if (problems.rest.length > 0) return summary.current?.focus()
    const first = fields.find((field) => problems.byField[field.name])
    if (!first) return
    const holder = form.current?.querySelector(`[data-field="${first.name}"]`)
    const control = holder?.querySelector<HTMLElement>(
      "input[type=radio]:checked, input:not([type=radio]), button[aria-haspopup]",
    )
    ;(control ?? holder?.querySelector<HTMLElement>("input"))?.focus()
  }, [shown, problems, fields])

  const read = (): Values => {
    const data = form.current ? new FormData(form.current) : new FormData()
    return Object.fromEntries(
      fields.map((field) => {
        const value = data.get(field.name)
        const text = typeof value === "string" ? value.trim() : ""
        return [field.name, text === NONE ? "" : text]
      }),
    )
  }

  const show = (byField: Record<string, string>, rest: string[]) => {
    setProblems({ byField, rest })
    setShown((count) => count + 1)
  }

  const submit = async () => {
    if (pending) return
    setProblems({ byField: {}, rest: [] })
    const values = read()
    const missing = Object.fromEntries(
      fields
        .filter((field) => field.required && !values[field.name])
        .map((field) => [field.name, field.required as string]),
    )
    const wrong = { ...spec.check?.(values), ...missing }
    if (Object.keys(wrong).length > 0) return show(wrong, [])
    setPending(true)
    try {
      await busy(() => spec.run(values))
    } catch (error) {
      setPending(false)
      const { byField, rest } = sortProblems(error, fields, spec.place)
      show(byField, rest)
    }
  }

  return (
    <Form
      ref={form}
      validationBehavior="aria"
      aria-label={spec.title}
      className="flex flex-col gap-5"
      {...(pending ? { "aria-busy": true } : {})}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {problems.rest.length > 0 ? (
        <Alert
          ref={summary}
          status="danger"
          role="alert"
          tabIndex={-1}
          id="form-error"
          className="form-error outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{spec.failed}</Alert.Title>
            {problems.rest.length === 1 ? (
              <Alert.Description className="break-words">{problems.rest[0]}</Alert.Description>
            ) : (
              <ul className="m-0 list-disc pl-5 text-sm">
                {problems.rest.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Alert.Content>
        </Alert>
      ) : null}
      {fields.map((field) => (
        <Control key={field.name} field={field} problem={problems.byField[field.name]} />
      ))}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="submit"
          variant={spec.danger ? "danger" : "primary"}
          isDisabled={pending}
          {...(pending ? { "data-pending": "" } : {})}
        >
          {pending ? spec.pending : spec.submit}
        </Button>
        <a href={spec.cancel} data-cancel="" className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </a>
      </div>
    </Form>
  )
}

/** A mutation screen: everything `MutationSpec` says, around its one form. */
export function mutation(spec: MutationSpec): Child {
  const lead = spec.lead ? (
    spec.danger ? (
      <Notice tone="danger">{spec.lead}</Notice>
    ) : (
      <p className="mb-6 max-w-prose text-sm text-muted">{spec.lead}</p>
    )
  ) : null
  if (spec.signedOut)
    return (
      <CenteredCard title={spec.title} description={spec.lead} product="Fleet Cloud">
        {spec.note}
        <MutationForm spec={spec} />
      </CenteredCard>
    )
  return (
    <Narrow>
      {spec.crumbs}
      <div className="-mb-4">
        <Head title={spec.title} />
      </div>
      {lead}
      {spec.note}
      {spec.facts ? <div className="mb-6">{spec.facts}</div> : null}
      <Card>
        <Card.Content>
          <MutationForm spec={spec} />
        </Card.Content>
      </Card>
    </Narrow>
  )
}
