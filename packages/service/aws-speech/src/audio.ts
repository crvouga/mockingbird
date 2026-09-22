/**
 * Deterministic synthetic audio. Polly's answer stands in for speech: its length grows with
 * the text (60 ms per character) and the bytes are identical on every run.
 *
 * - PCM is a 440 Hz tone, signed 16-bit little-endian mono: always an even byte count.
 * - MP3 is a run of valid MPEG-2 (or 2.5) Layer III frames, mono, 32 kbit/s, at the requested
 *   sample rate: 576 samples each, decoding (mpg123, ffmpeg) to silence. A tone would need a
 *   real encoder; the frames are what a decoder checks.
 */

/** Milliseconds of audio per character of text. */
export const MS_PER_CHARACTER = 60

/** Duration of the speech standing in for `text`. */
export const durationFor = (text: string) => Math.max(1, text.length) * MS_PER_CHARACTER

/** PCM s16le mono tone of `durationMs` at `sampleRate`. */
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

/** MPEG version bits and sample-rate index per rate (MPEG-2 and MPEG-2.5 only). */
const MP3_RATES: Record<number, { version: number; index: number }> = {
  22050: { version: 0b10, index: 0 },
  24000: { version: 0b10, index: 1 },
  16000: { version: 0b10, index: 2 },
  11025: { version: 0b00, index: 0 },
  12000: { version: 0b00, index: 1 },
  8000: { version: 0b00, index: 2 },
}

/** Sample rates {@link mp3Frames} can encode. */
export const MP3_SAMPLE_RATES = Object.keys(MP3_RATES).map(Number)

/** Samples per MPEG-2/2.5 Layer III frame. */
export const MP3_SAMPLES_PER_FRAME = 576

/** One silent Layer III frame: header, zeroed side info (9 bytes, mono), zeroed main data. */
export const mp3Frame = (sampleRate: number): Uint8Array => {
  const rate = MP3_RATES[sampleRate]
  if (!rate) throw new RangeError(`no MPEG-2 Layer III sample rate ${sampleRate}`)
  const bitrateIndex = 4 // 32 kbit/s in the MPEG-2 Layer III table
  const length = Math.floor((72 * 32_000) / sampleRate)
  const frame = new Uint8Array(length)
  frame[0] = 0xff
  frame[1] = 0xe0 | (rate.version << 3) | (0b01 << 1) | 1 // sync, version, layer III, no CRC
  frame[2] = (bitrateIndex << 4) | (rate.index << 2) // no padding
  frame[3] = 0b11 << 6 // mono
  return frame
}

/** MP3 frames covering `durationMs`. */
export const mp3Audio = (durationMs: number, sampleRate: number): Uint8Array => {
  const frames = Math.max(1, Math.ceil((sampleRate * durationMs) / 1000 / MP3_SAMPLES_PER_FRAME))
  const one = mp3Frame(sampleRate)
  const out = new Uint8Array(one.length * frames)
  for (let i = 0; i < frames; i++) out.set(one, i * one.length)
  return out
}
