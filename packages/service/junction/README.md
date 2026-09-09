# @crvouga/mockingbird-service-junction

Stateful mock of the [Junction (Vital) API](https://docs.junction.com/) user, lab-testing,
and scheduling surfaces.

- Coverage: [SUPPORT.md](./SUPPORT.md), [docs/geviti-coverage.md](./docs/geviti-coverage.md),
  [docs/qa-drop-in.md](./docs/qa-drop-in.md) (Geviti QA proof matrix)
- Follow-on Geviti wiring: [docs/geviti-followon.md](./docs/geviti-followon.md)

Auth header: `x-vital-api-key`. Sandbox keys look like `sk_us_*` / `sk_eu_*`.

```ts
import { JunctionAPI } from "@crvouga/mockingbird-service-junction"

const junction = new JunctionAPI()
const created = await junction.fetch(
  new Request("https://mock.junction.local/v2/user", {
    method: "POST",
    headers: {
      "x-vital-api-key": "sk_us_mockingbird",
      "content-type": "application/json",
    },
    body: JSON.stringify({ client_user_id: "app-user-1" }),
  }),
)

await junction.seedFrom({
  fetch: globalThis.fetch,
  baseUrl: "https://api.sandbox.tryvital.io",
  headers: { "x-vital-api-key": "sk_us_..." },
})
```

## Parity (monkey proof)

Primary proof is **seedParity**: warmup N on the oracle → `seedFrom` → lockstep M.

```bash
# Default mode=seed against api.sandbox.tryvital.io
bun run parity
bun run parity -- --warmup 15 --compare 30 --runs 25

# Legacy empty-start differential
bun run parity -- --mode=empty
```

Offline monkey (no network): `bun test junction.seed.property.test.ts`.

Scheduling state-space (booking keys, cascades, delayed simulate): `bun test`.

Example SDK scenarios (`client-parity*.ts`) are **deprecated as proof** — keep only as
manual probes. Drop-in for Geviti QA is claimed only when [docs/qa-drop-in.md](./docs/qa-drop-in.md)
is fully `monkey-green`.
