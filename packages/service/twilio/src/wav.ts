/**
 * Just enough RIFF/WAVE for the Recordings surface: synthesise a PCM recording, read a WAV's
 * format, and mix a dual-channel recording down to mono (what Twilio serves unless the
 * request asks for `RequestedChannels=2`).
 */

export type WavFormat = {
  audioFormat: number
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** Offset and length of the `data` chunk, when present. */
  dataOffset: number
  dataLength: number
}

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

/** The `fmt ` and `data` chunks of a RIFF/WAVE file, or `undefined` when it is not one. */
export const readWav = (bytes: Uint8Array): WavFormat | undefined => {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return undefined
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let format: Omit<WavFormat, "dataOffset" | "dataLength"> | undefined
  while (offset + 8 <= bytes.length) {
    const name = ascii(bytes, offset, 4)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (name === "fmt " && size >= 16 && start + 16 <= bytes.length) {
      format = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bitsPerSample: view.getUint16(start + 14, true),
      }
    }
    if (name === "data" && format) {
      return { ...format, dataOffset: start, dataLength: Math.min(size, bytes.length - start) }
    }
    offset = start + size + (size % 2)
  }
  return undefined
}

const header = (channels: number, sampleRate: number, bits: number, dataLength: number) => {
  const out = new Uint8Array(44)
  const view = new DataView(out.buffer)
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  const blockAlign = (channels * bits) / 8
  write(0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  write(36, "data")
  view.setUint32(40, dataLength, true)
  return out
}

/**
 * A 16-bit PCM WAV like a Twilio call recording (8 kHz). Each channel carries a quiet tone at a
 * different pitch, so a mix-down is observably not either channel.
 */
export const synthesizeWav = (options: { channels?: number; seconds?: number } = {}) => {
  const channels = options.channels ?? 2
  const sampleRate = 8000
  const frames = Math.max(1, Math.round(sampleRate * (options.seconds ?? 0.25)))
  const data = new Uint8Array(frames * channels * 2)
  const view = new DataView(data.buffer)
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const pitch = 440 * (channel + 1)
      const sample = Math.round(2000 * Math.sin((2 * Math.PI * pitch * frame) / sampleRate))
      view.setInt16((frame * channels + channel) * 2, sample, true)
    }
  }
  const out = new Uint8Array(44 + data.length)
  out.set(header(channels, sampleRate, 16, data.length), 0)
  out.set(data, 44)
  return out
}

/** Average a 16-bit PCM WAV's channels into one; anything else is returned unchanged. */
export const mixDownToMono = (bytes: Uint8Array): Uint8Array => {
  const format = readWav(bytes)
  if (!format || format.channels < 2 || format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    return bytes
  }
  const source = new DataView(bytes.buffer, bytes.byteOffset + format.dataOffset, format.dataLength)
  const frames = Math.floor(format.dataLength / (2 * format.channels))
  const data = new Uint8Array(frames * 2)
  const target = new DataView(data.buffer)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < format.channels; channel++) {
      sum += source.getInt16((frame * format.channels + channel) * 2, true)
    }
    target.setInt16(frame * 2, Math.round(sum / format.channels), true)
  }
  const out = new Uint8Array(44 + data.length)
  out.set(header(1, format.sampleRate, 16, data.length), 0)
  out.set(data, 44)
  return out
}

/** Whole seconds of audio, as Twilio reports a recording's `duration`. */
export const durationSeconds = (bytes: Uint8Array): number => {
  const format = readWav(bytes)
  if (!format || format.sampleRate === 0 || format.bitsPerSample === 0) return 0
  const bytesPerSecond = (format.sampleRate * format.channels * format.bitsPerSample) / 8
  return Math.round(format.dataLength / bytesPerSecond)
}
