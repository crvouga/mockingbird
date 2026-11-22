/**
 * The example app's one page, signed out or signed in, server-rendered with the Mockingbird
 * design system. Plain HTML: the Sign in link and the Sign out form work without JavaScript.
 */
import { CenteredCard, KeyValueList } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { Alert, Button, buttonVariants } from "@heroui/react"

export type AppUser = { sub: string; name?: string; email?: string }

const PRODUCT = "Example app"

export function appPage(user?: AppUser, error?: string): string {
  const notice = error ? (
    <Alert status="danger" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>Sign-in did not complete</Alert.Title>
        <Alert.Description className="break-words">{error}</Alert.Description>
      </Alert.Content>
    </Alert>
  ) : null
  return renderPage(
    user ? (
      <CenteredCard
        product={PRODUCT}
        title={`Welcome, ${user.name?.split(" ")[0] ?? "friend"}.`}
        description="You are signed in."
        footer={
          <form method="post" action="/auth/logout" className="w-full">
            <Button type="submit" variant="secondary" fullWidth>
              Sign out
            </Button>
          </form>
        }
      >
        {notice}
        <KeyValueList
          items={[
            { label: "Name", value: user.name ?? "Name not shared" },
            { label: "Email", value: user.email ?? "Email not shared" },
            { label: "Account ID", value: user.sub, mono: true },
          ]}
        />
      </CenteredCard>
    ) : (
      <CenteredCard product={PRODUCT} title="Example app" description="Sign in to continue.">
        {notice}
        <a href="/auth/start" className={buttonVariants({ fullWidth: true })}>
          Sign in
        </a>
      </CenteredCard>
    ),
    { title: PRODUCT, css: MOCKINGBIRD_CSS },
  )
}
