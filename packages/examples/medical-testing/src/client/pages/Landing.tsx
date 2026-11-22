import { CenteredCard } from "@crvouga/mockingbird-ui/react"
import {
  Alert,
  Button,
  Chip,
  Description,
  Form,
  Input,
  Label,
  Separator,
  TextField,
} from "@heroui/react"
import { type FormEvent, useEffect, useState } from "react"
import { ApiError, api, type OAuthProvider, type User } from "../api.js"
import { InboxHint } from "../components/InboxHint.js"
import { OAuthModal } from "../components/OAuthModal.js"
import { message, signInLinkToken } from "../format.js"
import { PRODUCT } from "../product.js"
import { onSignInLink } from "../signInLink.js"

export { signInLinkToken } from "../format.js"

const DEMO_ACCOUNTS = [
  ["Ada Lovelace", "Patient", "ada@example.test"],
  ["Morgan Chen", "Clinician", "clinician@example.test"],
  ["Alex Morgan", "Administrator", "admin@example.test"],
] as const

/** Counts a resend cooldown down to zero, one second at a time. */
const useCountdown = (): [number, (seconds: number) => void] => {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setLeft(left - 1), 1000)
    return () => clearTimeout(timer)
  }, [left])
  return [left, setLeft]
}

const RESEND_COOLDOWN_SECONDS = 30

/** Signed out: a passwordless sign-in by emailed code, Google or Apple, and the demo accounts. */
export const Landing = ({ onSignedIn }: { onSignedIn: (user: User) => void }) => {
  const [provider, setProvider] = useState<OAuthProvider | null>(null)
  const [email, setEmail] = useState("")
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useCountdown()

  const send = async (address: string) => {
    setBusy(true)
    setError(null)
    try {
      const sent = await api.emailStart(address)
      setSentTo(sent.email)
      setCode("")
      setCooldown(RESEND_COOLDOWN_SECONDS)
    } catch (error) {
      if (error instanceof ApiError && error.retryAfterSeconds) setCooldown(error.retryAfterSeconds)
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  const verify = async (event: FormEvent) => {
    event.preventDefault()
    if (!sentTo) return
    setBusy(true)
    setError(null)
    try {
      const token = signInLinkToken(code)
      const done = token ? await api.emailLink(token) : await api.emailVerify(sentTo, code)
      onSignedIn(done.user)
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }
  // A click on the emailed link, followed in this page (see `signInLink.ts`).
  useEffect(
    () =>
      onSignInLink(async (token) => {
        setBusy(true)
        setError(null)
        try {
          onSignedIn((await api.emailLink(token)).user)
        } catch (error) {
          setError(message(error))
        } finally {
          setBusy(false)
        }
      }),
    [],
  )
  const startOver = () => {
    setSentTo(null)
    setCode("")
    setError(null)
  }

  const emailStep = (
    <>
      <Form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void send(email)
        }}
      >
        <TextField
          type="email"
          name="email"
          isRequired
          autoComplete="email"
          value={email}
          onChange={setEmail}
        >
          <Label>Email address</Label>
          <Input placeholder="you@example.com" data-testid="sign-in-email" />
          <Description>
            No password. New here? Entering your email creates your account.
          </Description>
        </TextField>
        <Button
          type="submit"
          fullWidth
          data-testid="sign-in-email-submit"
          isDisabled={busy || !email.trim()}
        >
          {busy ? "Sending…" : "Email me a sign-in code"}
        </Button>
      </Form>
      <div className="flex items-center gap-3 text-xs text-muted">
        <Separator className="flex-1" />
        or
        <Separator className="flex-1" />
      </div>
      <div className="flex flex-col gap-2">
        <Button variant="secondary" fullWidth onPress={() => setProvider("google")}>
          Continue with Google
        </Button>
        <Button variant="secondary" fullWidth onPress={() => setProvider("apple")}>
          Continue with Apple
        </Button>
      </div>
      <Separator />
      <section className="flex flex-col gap-2" aria-labelledby="demo-accounts-heading">
        <h2 id="demo-accounts-heading" className="text-sm font-semibold text-foreground">
          Explore the workspace
        </h2>
        <p className="text-sm text-muted">
          Three fictional accounts are ready. Pick one to fill in its email, or find them in the
          Google account chooser.
        </p>
        {DEMO_ACCOUNTS.map(([name, role, address]) => (
          <Button
            key={address}
            variant="outline"
            fullWidth
            className="h-auto justify-between gap-3 py-2 text-left"
            data-testid="demo-account"
            data-email={address}
            onPress={() => {
              setEmail(address)
              setError(null)
            }}
          >
            <span className="flex min-w-0 flex-col items-start">
              <span className="font-medium text-foreground">{name}</span>
              <span className="truncate text-xs font-normal text-muted">{address}</span>
            </span>
            <Chip size="sm" variant="soft">
              <Chip.Label>{role}</Chip.Label>
            </Chip>
          </Button>
        ))}
      </section>
    </>
  )

  const codeStep = sentTo ? (
    <>
      <InboxHint target={{ channel: "email", to: sentTo }}>
        We sent a 6-digit code to <strong>{sentTo}</strong>. This is a demo, so nothing left this
        page: open Notifications to read it.
      </InboxHint>
      <Form className="flex flex-col gap-3" onSubmit={verify}>
        <TextField
          name="code"
          isRequired
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={setCode}
        >
          <Label>Sign-in code</Label>
          <Input
            placeholder="000000"
            className="font-mono tracking-widest"
            data-testid="sign-in-code"
          />
          <Description>
            The code expires in 10 minutes. You can also paste the sign-in link from the email here.
          </Description>
        </TextField>
        <Button
          type="submit"
          fullWidth
          data-testid="sign-in-code-submit"
          isDisabled={busy || !code.trim()}
        >
          {busy ? "Checking…" : "Sign in"}
        </Button>
      </Form>
      <div className="flex flex-wrap justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          data-testid="sign-in-resend"
          isDisabled={busy || cooldown > 0}
          onPress={() => void send(sentTo)}
        >
          {cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}
        </Button>
        <Button size="sm" variant="ghost" data-testid="sign-in-start-over" onPress={startOver}>
          Use a different email
        </Button>
      </div>
    </>
  ) : null

  return (
    <>
      <CenteredCard
        product={PRODUCT}
        title={sentTo ? "Enter your sign-in code" : "Sign in to your account"}
        description={
          sentTo
            ? "Check your email for a one-time code."
            : "Order lab tests, follow their progress, and explore your results. Get a one-time code by email, or continue with a provider."
        }
        notice="Fictional demonstration data. No real email, charges or clinical advice. Changes last for this running instance."
      >
        {error ? (
          <Alert status="danger" role="alert" data-testid="sign-in-error">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {sentTo ? codeStep : emailStep}
      </CenteredCard>
      {provider ? (
        <OAuthModal
          provider={provider}
          onClose={() => setProvider(null)}
          onDone={(user) => {
            setProvider(null)
            onSignedIn(user)
          }}
        />
      ) : null}
    </>
  )
}
