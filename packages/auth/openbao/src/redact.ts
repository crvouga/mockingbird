export const REDACTED = "<redacted>"

const MIN_SECRET_LENGTH = 4

/**
 * Build a redactor that blanks every given secret (longest first so prefixes never leak a
 * suffix). Secrets shorter than four characters are ignored: masking them would shred output.
 */
export const createRedactor = (secrets: readonly string[]) => {
  const distinct = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  )
  return (text: string) => {
    let out = text
    for (const secret of distinct) out = out.split(secret).join(REDACTED)
    return out
  }
}

/** True when `text` still contains any of the secrets. */
export const leaks = (text: string, secrets: readonly string[]) =>
  secrets.some((secret) => secret.length >= MIN_SECRET_LENGTH && text.includes(secret))
