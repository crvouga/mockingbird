import { createHmac, timingSafeEqual } from "node:crypto"

const SIGNATURE_TIMESTAMP_PREFIX = "t="
const SIGNATURE_VALUE_PREFIX = "v1="
const SIGNATURE_HEX_LENGTH = 64
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

type VerifyFullscriptWebhookSignatureOptions = {
  rawBody: Buffer
  signatureHeader: string | undefined
  secret: string
  now?: Date
}

export function verifyFullscriptWebhookSignature(options: VerifyFullscriptWebhookSignatureOptions) {
  const signature = parseSignatureHeader(options.signatureHeader)
  if (!signature || !options.secret) {
    return false
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000)
  if (Math.abs(nowSeconds - signature.timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return false
  }

  const expectedSignature = createHmac("sha256", options.secret)
    .update(Buffer.from(`${signature.timestamp}.`))
    .update(options.rawBody)
    .digest()
  const providedSignature = Buffer.from(signature.value, "hex")
  return (
    providedSignature.length === expectedSignature.length &&
    timingSafeEqual(providedSignature, expectedSignature)
  )
}

function parseSignatureHeader(header: string | undefined) {
  if (!header) {
    return null
  }

  let timestamp: number | undefined
  let value: string | undefined
  for (const part of header.split(",")) {
    const trimmedPart = part.trim()
    if (trimmedPart.startsWith(SIGNATURE_TIMESTAMP_PREFIX)) {
      const timestampText = trimmedPart.slice(SIGNATURE_TIMESTAMP_PREFIX.length)
      if (!/^\d+$/.test(timestampText)) {
        return null
      }
      timestamp = Number(timestampText)
    } else if (trimmedPart.startsWith(SIGNATURE_VALUE_PREFIX)) {
      value = trimmedPart.slice(SIGNATURE_VALUE_PREFIX.length).toLowerCase()
    }
  }

  if (
    timestamp === undefined ||
    !Number.isSafeInteger(timestamp) ||
    value?.length !== SIGNATURE_HEX_LENGTH ||
    !/^[a-f0-9]+$/.test(value)
  ) {
    return null
  }

  return { timestamp, value }
}
