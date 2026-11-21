import { CenteredCard, StatusChip } from "@crvouga/mockingbird-ui/react"
import { renderPage } from "@crvouga/mockingbird-ui/react/server"
import { MOCKINGBIRD_CSS } from "@crvouga/mockingbird-ui/styles"
import { Button, Input, Label, TextField } from "@heroui/react"

export function trialPage(name: string, script?: { source: string }): string {
  return renderPage(
    <CenteredCard title={`Allow ${name}?`} product="Google">
      <form method="post">
        <TextField name="email">
          <Label>Email</Label>
          <Input />
        </TextField>
        <StatusChip status="info">Test</StatusChip>
        <Button type="submit">Allow</Button>
      </form>
    </CenteredCard>,
    {
      title: "Consent",
      css: MOCKINGBIRD_CSS,
      ...(script ? { script: { source: script.source, call: "MockingbirdTrial.start", props: { name } } } : {}),
    },
  )
}
