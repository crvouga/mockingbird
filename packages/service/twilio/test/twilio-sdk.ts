/**
 * The unmodified twilio-node SDK, loaded through its CommonJS entry. twilio's `exports` map has
 * no `types` condition, so under NodeNext TypeScript cannot type `"twilio"`, and a tsconfig
 * `paths` entry pointing at its `.d.ts` is not an option: Bun 1.4.0 (the pinned runtime)
 * applies `paths` at runtime too and would execute that declaration file. So the value comes
 * from `require("twilio")` and the types from the package's own `lib/index.d.ts`.
 */
import { createRequire } from "node:module"

type TwilioSdk = typeof import("../node_modules/twilio/lib/index.js")

const sdk = createRequire(import.meta.url)("twilio") as TwilioSdk

export const RequestClient: TwilioSdk["RequestClient"] = sdk.RequestClient
export const Twilio: TwilioSdk["Twilio"] = sdk.Twilio
export const validateRequest: TwilioSdk["validateRequest"] = sdk.validateRequest
export type RequestClient = InstanceType<TwilioSdk["RequestClient"]>
export type Twilio = InstanceType<TwilioSdk["Twilio"]>
