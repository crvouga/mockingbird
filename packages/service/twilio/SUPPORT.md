# Twilio Verify, Lookup, Messaging and Recordings (Mockingbird subset) — operation support

Generated from `openapi.yaml`; do not edit by hand.

- operations in spec: **10**
- supported by the mock: **10**
- parity enabled: **10**

| operationId | route | mock | parity | notes |
| --- | --- | --- | --- | --- |
| `FetchPhoneNumber` | `GET /lookups/v2/PhoneNumbers/{PhoneNumber}` | ✅ supported | ✅ |  |
| `CreateVerification` | `POST /verify/v2/Services/{ServiceSid}/Verifications` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `FetchVerification` | `GET /verify/v2/Services/{ServiceSid}/Verifications/{Sid}` | ✅ supported | ✅ |  |
| `UpdateVerification` | `POST /verify/v2/Services/{ServiceSid}/Verifications/{Sid}` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateVerificationCheck` | `POST /verify/v2/Services/{ServiceSid}/VerificationCheck` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `CreateMessage` | `POST /api/2010-04-01/Accounts/{AccountSid}/Messages.json` | ✅ supported | ⚠️ unsafe (opt-in) |  |
| `FetchMessage` | `GET /api/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json` | ✅ supported | ✅ |  |
| `FetchRecordingMedia` | `GET /api/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.wav` | ✅ supported | ✅ |  |
| `FetchRecording` | `GET /api/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.json` | ✅ supported | ✅ |  |
| `DeleteRecording` | `DELETE /api/2010-04-01/Accounts/{AccountSid}/Recordings/{Sid}.json` | ✅ supported | ⚠️ unsafe (opt-in) |  |
