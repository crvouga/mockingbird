import { VitalClient } from "@tryvital/vital-node"
import { JunctionAPI } from "../src/index.js"
import { normalize, withMockFetch } from "./client-parity.js"

const apiKey = process.env.JUNCTION_API_KEY
const sandboxUrl = process.env.JUNCTION_SANDBOX_URL

if (process.env.JUNCTION_LIVE_PARITY !== "1") {
  process.stdout.write("Skipped: set JUNCTION_LIVE_PARITY=1 to run sandbox client parity\n")
} else if (!apiKey || !sandboxUrl) {
  throw new Error("JUNCTION_API_KEY and JUNCTION_SANDBOX_URL are required for live parity")
} else {
  const mock = new JunctionAPI({ now: () => 1_700_000_000_000 })
  const mockClientResult = await withMockFetch(mock, async (client) =>
    client.labTests.getById("c533549c-1e62-4afe-9a0e-0567a9b2bcc2"),
  )
  const sandboxClient = new VitalClient({ apiKey, environment: sandboxUrl })
  const sandboxResult = await sandboxClient.labTests.getById("c533549c-1e62-4afe-9a0e-0567a9b2bcc2")
  process.stdout.write(
    `${JSON.stringify({ mock: normalize(mockClientResult), sandbox: normalize(sandboxResult) })}\n`,
  )
}
