/**
 * Deterministic synthetic speech: a fixed 440 Hz tone as raw PCM (signed 16-bit
 * little-endian, mono). Its length grows with the text it stands for, so a caller can
 * assert "longer reply → more audio" without any real voice; the bytes are identical on
 * every run.
 */

/** Milliseconds of audio per character of text. */
export const MS_PER_CHARACTER = 60

/** PCM s16le mono tone of `durationMs` at `sampleRate`: always an even byte count. */
export const pcmTone = (durationMs: number, sampleRate: number): Uint8Array => {
  const samples = Math.max(1, Math.round((sampleRate * durationMs) / 1000))
  const out = new Uint8Array(samples * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25 * 32767)
    view.setInt16(i * 2, value, true)
  }
  return out
}

/** The tone standing in for speaking `text` aloud. */
export const speechFor = (text: string, sampleRate: number): Uint8Array =>
  pcmTone(Math.max(1, text.length) * MS_PER_CHARACTER, sampleRate)

/** Base64 without a platform `Buffer`. */
export const base64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Bytes from base64 (standard alphabet). */
export const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
