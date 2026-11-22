import { PageHeader, StatusChip } from "@crvouga/mockingbird-ui/react"
import { ArrowRightFromSquare, Check } from "@gravity-ui/icons"
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Description,
  Form,
  Input,
  Label,
  Radio,
  RadioGroup,
  Switch,
  TextField,
} from "@heroui/react"
import { type FormEvent, type ReactNode, useState } from "react"
import { can, PERMISSIONS } from "../../app/model.js"
import {
  api,
  type NotificationPreferences,
  type SentTo,
  type TestNotification,
  type TextChannel,
  type User,
} from "../api.js"
import { InboxHint } from "../components/InboxHint.js"
import { formatPhone, message } from "../format.js"

export { formatPhone } from "../format.js"

const LABELS: Record<string, string> = {
  "orders.own": "View your orders and download your records",
  "orders.create": "Order tests and complete checkout",
  "profile.edit": "Edit your profile and notification preferences",
  "orders.read": "View all patient orders and reports",
  "results.review": "Review results and write care notes",
  "users.manage": "Manage workspace members and roles",
  "audit.read": "Read the workspace audit log",
}
const SIGN_IN_METHOD: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  email: "an emailed code",
}
const CHANNEL_LABEL: Record<TextChannel, string> = { sms: "SMS", whatsapp: "WhatsApp" }

type Props = { user: User; onUpdated: (user: User) => void }

/** A failed request, in the danger alert every form on this screen uses. */
const Failure = ({ error, testId }: { error: string; testId?: string }) => (
  <Alert status="danger" role="alert" data-testid={testId}>
    <Alert.Indicator />
    <Alert.Content>
      <Alert.Description>{error}</Alert.Description>
    </Alert.Content>
  </Alert>
)

/** A titled settings card. */
const Section = ({
  title,
  description,
  children,
  testId,
}: {
  title: string
  description?: string
  children: ReactNode
  testId?: string
}) => (
  <Card data-testid={testId}>
    <Card.Header>
      <Card.Title>{title}</Card.Title>
      {description ? <Card.Description>{description}</Card.Description> : null}
    </Card.Header>
    <Card.Content className="gap-4">{children}</Card.Content>
  </Card>
)

const Profile = ({ user, onUpdated }: Props) => {
  const [name, setName] = useState(user.name ?? "")
  const [notifications, setNotifications] = useState(user.notifications)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const dirty = name !== (user.name ?? "") || notifications !== user.notifications
  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setSuccess(false)
    try {
      onUpdated((await api.profile(name, notifications)).user)
      setSuccess(true)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Profile" testId="profile-card">
      {error ? <Failure error={error} /> : null}
      {success ? (
        <Alert status="success" role="status" data-testid="profile-saved">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>Your changes have been saved.</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Form className="flex flex-col gap-4" onSubmit={save}>
        <TextField
          isRequired
          maxLength={80}
          value={name}
          onChange={(value) => {
            setName(value)
            setSuccess(false)
          }}
        >
          <Label>Full name</Label>
          <Input data-testid="profile-name" />
        </TextField>
        <TextField isReadOnly value={user.email ?? "Not shared"}>
          <Label>Email</Label>
          <Input />
          <Description>
            {user.provider === "email"
              ? "You sign in with a one-time code sent to this address."
              : `Your email is managed by your ${SIGN_IN_METHOD[user.provider] ?? user.provider} sign-in account.`}
          </Description>
        </TextField>
        <Checkbox
          isSelected={notifications}
          onChange={(value) => {
            setNotifications(value)
            setSuccess(false)
          }}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Label>Show result updates on my overview</Label>
          </Checkbox.Content>
          <Description>Highlight new reports and next steps in this workspace.</Description>
        </Checkbox>
        <div>
          <Button
            type="submit"
            data-testid="profile-save"
            isDisabled={busy || !dirty || !name.trim()}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </Form>
    </Section>
  )
}

const CHANNELS: { key: keyof NotificationPreferences; label: string; detail: string }[] = [
  { key: "email", label: "Email", detail: "Receipts, shipping and result notices." },
  { key: "text", label: "Text message", detail: "Short updates to your verified phone." },
  { key: "push", label: "Push", detail: "Alerts on your phones with the Cove app." },
]

/** Each switch saves on its own: there is no "save" to forget. */
const Preferences = ({ user, onUpdated }: Props) => {
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = async (key: keyof NotificationPreferences, on: boolean) => {
    setSaving(key)
    setError(null)
    try {
      const notify = { ...user.notify, [key]: on }
      onUpdated((await api.profile(user.name ?? "", user.notifications, notify)).user)
    } catch (error) {
      setError(message(error))
    } finally {
      setSaving(null)
    }
  }
  return (
    <Section
      title="Order updates"
      description="Choose how you hear about payments, kits and results."
      testId="notification-preferences"
    >
      {error ? <Failure error={error} /> : null}
      {CHANNELS.map((channel) => (
        <Switch
          key={channel.key}
          isSelected={user.notify[channel.key]}
          isDisabled={saving !== null || !user.name}
          onChange={(on) => void toggle(channel.key, on)}
        >
          <Switch.Content data-testid={`notify-${channel.key}`}>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{channel.label}</Label>
          </Switch.Content>
          <Description>
            {channel.key === "text" && !user.phone
              ? "Verify a phone number below to turn this on."
              : channel.detail}
          </Description>
        </Switch>
      ))}
      <p className="text-sm text-muted">
        Security messages, such as sign-in codes and new sign-in alerts, are always sent.
      </p>
    </Section>
  )
}

const Phone = ({ user, onUpdated }: Props) => {
  const [editing, setEditing] = useState(false)
  const [phone, setPhone] = useState("")
  const [channel, setChannel] = useState<TextChannel>(user.phoneChannel)
  const [pending, setPending] = useState<{ phone: string; channel: TextChannel } | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState<SentTo | null>(null)
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const start = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      setPending(await api.phoneStart(phone, channel))
      setCode("")
      setVerified(null)
    })
  }
  const check = (event: FormEvent) => {
    event.preventDefault()
    if (!pending) return
    void run(async () => {
      const { user } = await api.phoneCheck(pending.phone, pending.channel, code)
      onUpdated(user)
      setVerified({ channel: "sms", to: pending.phone })
      setPending(null)
      setEditing(false)
      setPhone("")
    })
  }
  const remove = () =>
    run(async () => {
      onUpdated((await api.phoneRemove()).user)
      setVerified(null)
    })
  const showForm = !user.phone || editing
  return (
    <Section title="Phone number" testId="phone-card">
      {error ? <Failure error={error} testId="phone-error" /> : null}
      {user.phone && !editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <strong className="text-foreground" data-testid="phone-current">
                {formatPhone(user.phone)}
              </strong>
              <StatusChip status="ok">Verified</StatusChip>
            </div>
            <span className="text-sm text-muted">
              Updates arrive by {CHANNEL_LABEL[user.phoneChannel]}.
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => {
                setEditing(true)
                setVerified(null)
              }}
            >
              Change
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="phone-remove"
              isDisabled={busy}
              onPress={() => void remove()}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : null}
      {verified ? (
        <InboxHint target={verified}>
          Your number is verified. We sent a confirmation text to it.
        </InboxHint>
      ) : null}
      {showForm && !pending ? (
        <Form className="flex flex-col gap-4" onSubmit={start}>
          <p className="text-sm text-muted">
            Add a mobile number to get order updates by text. We will send a code to confirm it is
            yours.
          </p>
          <TextField type="tel" isRequired autoComplete="tel" value={phone} onChange={setPhone}>
            <Label>Mobile number</Label>
            <Input placeholder="(415) 555-0142" data-testid="phone-input" />
          </TextField>
          <RadioGroup
            name="cove-phone-channel"
            orientation="horizontal"
            value={channel}
            onChange={(value) => setChannel(value as TextChannel)}
          >
            <Label>Send codes and updates by</Label>
            <div className="flex gap-4">
              {(["sms", "whatsapp"] as const).map((option) => (
                <Radio key={option} value={option}>
                  <Radio.Content data-testid={`phone-channel-${option}`}>
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                    <Label>{CHANNEL_LABEL[option]}</Label>
                  </Radio.Content>
                </Radio>
              ))}
            </div>
          </RadioGroup>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" data-testid="phone-send" isDisabled={busy || !phone.trim()}>
              {busy ? "Sending…" : "Send code"}
            </Button>
            {editing ? (
              <Button variant="secondary" onPress={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </Form>
      ) : null}
      {pending ? (
        <>
          <InboxHint target={{ channel: "sms", to: pending.phone }}>
            We sent a code to <strong>{formatPhone(pending.phone)}</strong> by{" "}
            {CHANNEL_LABEL[pending.channel]}. Open Notifications to read it on the demo phone.
          </InboxHint>
          <Form className="flex flex-col gap-4" onSubmit={check}>
            <TextField
              isRequired
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={setCode}
            >
              <Label>Verification code</Label>
              <Input
                placeholder="000000"
                className="font-mono tracking-widest"
                data-testid="phone-code"
              />
            </TextField>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" data-testid="phone-verify" isDisabled={busy || !code.trim()}>
                {busy ? "Checking…" : "Verify number"}
              </Button>
              <Button
                variant="secondary"
                isDisabled={busy}
                onPress={() => {
                  setPending(null)
                  setError(null)
                }}
              >
                Use a different number
              </Button>
            </div>
          </Form>
        </>
      ) : null}
    </Section>
  )
}

const TESTS: { kind: TestNotification; label: string; staff?: true }[] = [
  { kind: "email", label: "Email" },
  { kind: "text", label: "Text" },
  { kind: "push", label: "Push" },
  { kind: "chat", label: "Staff alert", staff: true },
]
const SENT: Record<SentTo["channel"], (to: string) => string> = {
  email: (to) => `Test email sent to ${to}.`,
  sms: (to) => `Test text sent to ${formatPhone(to)}.`,
  push: () => "Test push sent to your iPhone and Android phone.",
  chat: (to) => `Test alert posted to ${to} in the staff workspace.`,
}

/** A small playground: fire one message on any channel and go look at it. */
const TestNotifications = ({ user }: { user: User }) => {
  const [busy, setBusy] = useState<TestNotification | null>(null)
  const [sent, setSent] = useState<SentTo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const send = async (kind: TestNotification) => {
    setBusy(kind)
    setError(null)
    setSent(null)
    try {
      setSent((await api.testNotification(kind)).sent)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Section
      title="Send a test notification"
      description="Check that each channel reaches you. Tests ignore the switches above."
      testId="test-notifications"
    >
      <div className="flex flex-wrap gap-2">
        {TESTS.filter((item) => !item.staff || can(user.role, "orders.read")).map((item) => (
          <Button
            key={item.kind}
            variant="secondary"
            data-testid={`test-${item.kind}`}
            isDisabled={busy !== null}
            onPress={() => void send(item.kind)}
          >
            {busy === item.kind ? "Sending…" : item.label}
          </Button>
        ))}
      </div>
      {error ? <Failure error={error} testId="test-error" /> : null}
      {sent ? (
        <InboxHint target={sent.channel === "push" ? { channel: "push" } : sent}>
          {SENT[sent.channel](sent.to)}
        </InboxHint>
      ) : null}
    </Section>
  )
}

export const Account = ({
  user,
  onUpdated,
  onSignOut,
  signingOut,
}: Props & { onSignOut: () => Promise<void>; signingOut: boolean }) => (
  <div>
    <PageHeader
      eyebrow="Settings"
      title="Your account"
      description="Manage your profile, how we reach you, and your access."
    />
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <Profile user={user} onUpdated={onUpdated} />
          <Phone user={user} onUpdated={onUpdated} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Preferences user={user} onUpdated={onUpdated} />
          <TestNotifications user={user} />
          <Section
            title="Your access"
            description="Workspace administrators manage roles. Permissions are checked for every request."
          >
            <div>
              <StatusChip status="info">{user.role}</StatusChip>
            </div>
            <ul className="flex flex-col gap-2 text-sm text-foreground">
              {PERMISSIONS[user.role].map((permission) => (
                <li key={permission} className="flex items-start gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" />
                  {LABELS[permission]}
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
      <Section title="Session">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Signed in with {SIGN_IN_METHOD[user.provider] ?? user.provider}. Sign out to switch
            accounts.
          </p>
          <Button
            variant="secondary"
            data-testid="sign-out"
            isDisabled={signingOut}
            onPress={() => void onSignOut()}
          >
            <ArrowRightFromSquare className="size-4" />
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </Section>
    </div>
  </div>
)
