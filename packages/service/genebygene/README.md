# @crvouga/mockingbird-service-genebygene

Stateful mock of the [GeneByGene Nucleus API](https://api.genebygene.com/swagger/index.html) (OAuth token, products, orders).

- Developer guide (PDF): https://api.genebygene.com/assets/GxG%20API%20Services%20Developer%20Guide%202022.pdf
- Swagger UI: https://api.genebygene.com/swagger/index.html
- Staging API: `https://staging-api.genebygene.com`
- Staging auth: `https://staging-auth.genebygene.com/connect/token`
- Coverage: [SUPPORT.md](./SUPPORT.md)

```ts
import { GeneByGeneAPI } from "@crvouga/mockingbird-service-genebygene"

const gbg = new GeneByGeneAPI()
const token = await gbg.fetch(
  new Request("https://mock.genebygene.local/connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&client_id=demo&client_secret=demo",
  }),
)
```

Live parity (staging credentials from env or OpenBao):

```bash
bun run parity
# MOCKINGBIRD_GENEBYGENE_CLIENT_ID=... MOCKINGBIRD_GENEBYGENE_CLIENT_SECRET=... bun run parity
```
