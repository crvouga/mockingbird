# twilio evidence

Added vendor routes are checked against the pinned Emulate 0.12.1 npm package and licensed provider regression tests. Native fixture, namespace, checkpoint, branch and clock checks run separately. This is offline package evidence, not live vendor proof. See [coverage audit](../../../docs/EMULATE_COVERAGE.md) for the pinned source, coverage gate, reviewed differences and exact commands.

## Message list paging and the un-prefixed routes (#762)

**Best guess, not oracle-verified.** No Twilio credentials are available to this repository's
parity runs, and Messages is never called live (it sends real SMS). The behavior follows:

- Twilio's response-format docs (https://www.twilio.com/docs/usage/twilios-response#response-formats-list-paging-information)
  and the Message resource reference (https://www.twilio.com/docs/messaging/api/message-resource):
  `uri`, `first_page_uri`, `next_page_uri` and `previous_page_uri` are paths relative to
  `https://api.twilio.com` (`/2010-04-01/Accounts/AC…/Messages.json?PageSize=1&Page=1&PageToken=PA…`).
- twilio-node 5.10.0 source: `lib/base/Page.js` `getNextPageUrl` returns
  `this._version._domain.absoluteUrl(next_page_uri)`, and `lib/base/Domain.js` `absoluteUrl` joins
  it to the domain's base URL (`https://api.twilio.com`). An `httpClient` that rewrites that host
  (`twilioMockUrl`) therefore adds the `/api` prefix back, so the URIs carry no mount prefix.

The emulator keeps the vendor form of these URIs under every mount. The un-prefixed
`/2010-04-01/…` routes accept the same Basic credentials as the `/api` ones and list Messages in
the same newest-first order, so a raw client following the URIs from the emulator origin pages
correctly. Tested in `twilio.collections.test.ts` (`#762` tests), including twilio-node paging
`PageSize=1` across two pages with and without the `/api` prefix.
