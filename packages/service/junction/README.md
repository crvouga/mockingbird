# @crvouga/mockingbird-service-junction

Stateful mock of the [Junction (Vital) API](https://docs.junction.com/) user and lab-testing surfaces.

- API overview / environments / auth: https://docs.junction.com/api-details/junction-api
- Create user: https://docs.junction.com/api-reference/user/create-user
- Get user: https://docs.junction.com/api-reference/user/get-user
- Delete user: https://docs.junction.com/api-reference/user/delete-user
- Update user: https://docs.junction.com/api-reference/user/update-user
- Lab tests: https://docs.junction.com/api-reference/lab-tests
- Orders: https://docs.junction.com/api-reference/order-v3
- Coverage: [SUPPORT.md](./SUPPORT.md)

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
```

Live parity against the sandbox (credentials from env or OpenBao):

```bash
bun run parity
# MOCKINGBIRD_JUNCTION_API_KEY=sk_us_... bun run parity
```
