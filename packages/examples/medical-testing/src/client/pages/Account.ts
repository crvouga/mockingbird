import { html } from "htm/preact"
import { useState } from "preact/hooks"
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
import { message } from "../components/States.js"

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

/** +14155550142 → (415) 555-0142; anything else is shown as stored. */
export const formatPhone = (phone: string): string => {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone)
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone
}

type Props = { user: User; onUpdated: (user: User) => void }

const Profile = ({ user, onUpdated }: Props) => {
  const [name, setName] = useState(user.name ?? "")
  const [notifications, setNotifications] = useState(user.notifications)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const dirty = name !== (user.name ?? "") || notifications !== user.notifications
  const save = async (event: Event) => {
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
  return html`<section class="cove-card"><h2>Profile</h2>
    ${error && html`<p class="cove-alert cove-alert-error" role="alert">${error}</p>`}${success && html`<p class="cove-alert cove-alert-success" role="status">Your changes have been saved.</p>`}
    <form onSubmit=${save}><label class="cove-field">Full name<input class="cove-input" required maxlength="80" value=${name} onInput=${(
      event: Event,
    ) => {
      setName((event.target as HTMLInputElement).value)
      setSuccess(false)
    }}/></label><label class="cove-field">Email<input class="cove-input" readonly value=${user.email ?? "Not shared"}/></label><p class="cove-muted cove-text-sm">${user.provider === "email" ? "You sign in with a one-time code sent to this address." : `Your email is managed by your ${SIGN_IN_METHOD[user.provider] ?? user.provider} sign-in account.`}</p><label class="cove-checkbox"><input type="checkbox" checked=${notifications} onChange=${(
      event: Event,
    ) => {
      setNotifications((event.target as HTMLInputElement).checked)
      setSuccess(false)
    }}/><span>Show result updates on my overview<small>Highlight new reports and next steps in this workspace.</small></span></label><button class="cove-btn cove-btn-primary" disabled=${busy || !dirty || !name.trim()}>${busy ? "Saving…" : "Save changes"}</button></form></section>`
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
  return html`<section class="cove-card" data-testid="notification-preferences"><h2>Order updates</h2><p class="cove-muted cove-text-sm">Choose how you hear about payments, kits and results.</p>
    ${error && html`<p class="cove-alert cove-alert-error" role="alert">${error}</p>`}
    <div class="cove-pref-list">${CHANNELS.map(
      (channel) =>
        html`<label class="cove-pref" key=${channel.key}><span><strong>${channel.label}</strong><small>${channel.key === "text" && !user.phone ? "Verify a phone number below to turn this on." : channel.detail}</small></span><input type="checkbox" role="switch" class="cove-switch" data-testid=${`notify-${channel.key}`} checked=${user.notify[channel.key]} disabled=${saving !== null || !user.name} onChange=${(
          event: Event,
        ) => toggle(channel.key, (event.target as HTMLInputElement).checked)}/></label>`,
    )}</div>
    <p class="cove-muted cove-text-sm">Security messages, such as sign-in codes and new sign-in alerts, are always sent.</p></section>`
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
  const start = (event: Event) => {
    event.preventDefault()
    void run(async () => {
      setPending(await api.phoneStart(phone, channel))
      setCode("")
      setVerified(null)
    })
  }
  const check = (event: Event) => {
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
  return html`<section class="cove-card" data-testid="phone-card"><h2>Phone number</h2>
    ${error && html`<p class="cove-alert cove-alert-error" role="alert" data-testid="phone-error">${error}</p>`}
    ${
      user.phone &&
      !editing &&
      html`<div class="cove-phone-row"><div><strong data-testid="phone-current">${formatPhone(user.phone)}</strong><span class="cove-badge cove-badge-normal">Verified</span><small class="cove-muted">Updates arrive by ${CHANNEL_LABEL[user.phoneChannel]}.</small></div><span class="cove-phone-actions"><button type="button" class="cove-btn cove-btn-ghost cove-btn-sm" disabled=${busy} onClick=${() => {
        setEditing(true)
        setVerified(null)
      }}>Change</button><button type="button" class="cove-btn cove-btn-ghost cove-btn-sm" data-testid="phone-remove" disabled=${busy} onClick=${remove}>Remove</button></span></div>`
    }
    ${verified && html`<${InboxHint} target=${verified}>Your number is verified. We sent a confirmation text to it.<//>`}
    ${
      showForm &&
      !pending &&
      html`<p class="cove-muted cove-text-sm">Add a mobile number to get order updates by text. We will send a code to confirm it is yours.</p><form onSubmit=${start}><label class="cove-field">Mobile number<input class="cove-input" type="tel" required autocomplete="tel" placeholder="(415) 555-0142" data-testid="phone-input" value=${phone} onInput=${(
        event: Event,
      ) =>
        setPhone(
          (event.target as HTMLInputElement).value,
        )}/></label><fieldset class="cove-choice"><legend>Send codes and updates by</legend>${(
        ["sms", "whatsapp"] as const
      ).map(
        (option) =>
          html`<label key=${option}><input type="radio" name="cove-phone-channel" value=${option} data-testid=${`phone-channel-${option}`} checked=${channel === option} onChange=${() => setChannel(option)}/>${CHANNEL_LABEL[option]}</label>`,
      )}</fieldset><div class="cove-form-actions"><button class="cove-btn cove-btn-primary" data-testid="phone-send" disabled=${busy || !phone.trim()}>${busy ? "Sending…" : "Send code"}</button>${editing && html`<button type="button" class="cove-btn cove-btn-ghost" onClick=${() => setEditing(false)}>Cancel</button>`}</div></form>`
    }
    ${
      pending &&
      html`<${InboxHint} target=${{ channel: "sms", to: pending.phone }}>We sent a code to <strong>${formatPhone(pending.phone)}</strong> by ${CHANNEL_LABEL[pending.channel]}. Open Notifications to read it on the demo phone.<//>
      <form onSubmit=${check}><label class="cove-field">Verification code<input class="cove-input cove-code-input" required inputmode="numeric" autocomplete="one-time-code" placeholder="000000" data-testid="phone-code" value=${code} onInput=${(
        event: Event,
      ) =>
        setCode(
          (event.target as HTMLInputElement).value,
        )}/></label><div class="cove-form-actions"><button class="cove-btn cove-btn-primary" data-testid="phone-verify" disabled=${busy || !code.trim()}>${busy ? "Checking…" : "Verify number"}</button><button type="button" class="cove-btn cove-btn-ghost" disabled=${busy} onClick=${() => {
        setPending(null)
        setError(null)
      }}>Use a different number</button></div></form>`
    }</section>`
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
  return html`<section class="cove-card" data-testid="test-notifications"><h2>Send a test notification</h2><p class="cove-muted cove-text-sm">Check that each channel reaches you. Tests ignore the switches above.</p>
    <div class="cove-test-buttons">${TESTS.filter((item) => !item.staff || can(user.role, "orders.read")).map((item) => html`<button type="button" key=${item.kind} class="cove-btn cove-btn-ghost" data-testid=${`test-${item.kind}`} disabled=${busy !== null} onClick=${() => send(item.kind)}>${busy === item.kind ? "Sending…" : item.label}</button>`)}</div>
    ${error && html`<p class="cove-alert cove-alert-error" role="alert" data-testid="test-error">${error}</p>`}
    ${sent && html`<${InboxHint} target=${sent.channel === "push" ? { channel: "push" } : sent}>${SENT[sent.channel](sent.to)}<//>`}</section>`
}

export const Account = ({
  user,
  onUpdated,
  onSignOut,
  signingOut,
}: Props & { onSignOut: () => Promise<void>; signingOut: boolean }) =>
  html`<div class="cove-page"><div><p class="cove-eyebrow">Settings</p><h1>Your account</h1><p class="cove-lede">Manage your profile, how we reach you, and your access.</p></div>
    <div class="cove-dashboard-grid"><div class="cove-stack"><${Profile} user=${user} onUpdated=${onUpdated}/><${Phone} user=${user} onUpdated=${onUpdated}/></div>
    <div class="cove-stack"><${Preferences} user=${user} onUpdated=${onUpdated}/><${TestNotifications} user=${user}/><section class="cove-card"><h2>Your access</h2><p><span class="cove-role">${user.role}</span></p><ul class="cove-permission-list">${PERMISSIONS[user.role].map((permission) => html`<li key=${permission}><span aria-hidden="true">✓</span>${LABELS[permission]}</li>`)}</ul><p class="cove-muted cove-text-sm">Workspace administrators manage roles. Permissions are checked for every request.</p></section></div></div>
    <section class="cove-card"><h2>Session</h2><div class="cove-section-head"><p class="cove-muted">Signed in with ${SIGN_IN_METHOD[user.provider] ?? user.provider}. Sign out to switch accounts.</p><button class="cove-btn cove-btn-ghost" disabled=${signingOut} onClick=${onSignOut}>${signingOut ? "Signing out…" : "Sign out"}</button></div></section>
  </div>`
