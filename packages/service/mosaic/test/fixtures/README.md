# Mosaic response recordings

These 17 samples retain the HTTP status and response structure captured at the vendor's test
API. All variable values were replaced with type-preserving placeholders before check-in.
Timestamp fields use the string "redacted" where the response contains a timestamp.
The plain-text missing-key message is part of the public wire contract.

The three `salesorderlines.*.json` captures saved only the `data` array. Their replay tests use
the flat envelope from `error.missing-lines.json` and compare the response shape. See
[Observed at the vendor's test API](../../README.md#observed-at-the-vendors-test-api-on-2026-11-19)
for the observations and [the replay suite](../../mosaic.recordings.test.ts) for their requests.
