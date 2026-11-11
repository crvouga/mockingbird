import { When } from "./common.steps.js"

When("anyone requests {string}", async ({ world }, path: string) => {
  const response = await fetch(`${world.url}${path}`)
  world.last = {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
    body: undefined,
  }
})
