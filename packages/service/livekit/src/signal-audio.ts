export type AudioInput = { tone?: { hz: number; ms: number }; pcm?: string; sampleRate?: number }
export type AudioSource = { track: MediaStreamTrack; durationMs: number; close(): void }
export type AudioFactory = (input: AudioInput) => AudioSource | Promise<AudioSource>

export function parseAudioInput(value: unknown): AudioInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected audio input")
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !["tone", "pcm", "sampleRate"].includes(key)))
    throw new TypeError("Unknown audio option")
  if ((input.tone !== undefined) === (input.pcm !== undefined))
    throw new TypeError("Supply tone or PCM, exclusively")
  if (input.tone !== undefined) {
    if (!input.tone || typeof input.tone !== "object") throw new TypeError("Invalid tone")
    const tone = input.tone as Record<string, unknown>
    if (
      input.sampleRate !== undefined ||
      Object.keys(tone).some((key) => key !== "hz" && key !== "ms")
    )
      throw new TypeError("Unknown tone option")
    const { hz, ms } = tone
    if (
      typeof hz !== "number" ||
      !Number.isFinite(hz) ||
      hz < 20 ||
      hz > 20000 ||
      typeof ms !== "number" ||
      !Number.isFinite(ms) ||
      ms < 1 ||
      ms > 60000
    )
      throw new TypeError("Tone requires hz 20–20000 and ms 1–60000")
    return { tone: { hz, ms } }
  }
  if (typeof input.pcm !== "string" || input.pcm.length > 16_000_000)
    throw new TypeError("PCM must be base64 mono signed 16-bit little-endian samples")
  const samples = atob(input.pcm)
  const sampleRate = input.sampleRate ?? 48000
  if (
    samples.length === 0 ||
    samples.length % 2 ||
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    samples.length / 2 / sampleRate > 60
  )
    throw new TypeError("PCM requires complete samples, 8–96kHz, at most 60 seconds")
  return { pcm: input.pcm, sampleRate }
}

/** Explicit fixture audio generation; no speech recognition, TTS or application agent. */
export const createBrowserAudio: AudioFactory = async (input) => {
  const config = parseAudioInput(input)
  const context = new AudioContext()
  try {
    await context.resume()
    const destination = context.createMediaStreamDestination()
    const track = destination.stream.getAudioTracks()[0]
    if (!track) throw new Error("Audio destination did not expose a track")
    let durationMs: number
    let source: OscillatorNode | AudioBufferSourceNode
    if (config.tone) {
      durationMs = config.tone.ms
      const oscillator = context.createOscillator()
      oscillator.frequency.value = config.tone.hz
      source = oscillator
    } else {
      const bytes = Uint8Array.from(atob(config.pcm ?? ""), (char) => char.charCodeAt(0))
      const sampleRate = config.sampleRate ?? 48000
      durationMs = (bytes.length / 2 / sampleRate) * 1000
      const buffer = context.createBuffer(1, bytes.length / 2, sampleRate)
      const view = new DataView(bytes.buffer)
      const samples = buffer.getChannelData(0)
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
      const player = context.createBufferSource()
      player.buffer = buffer
      source = player
    }
    source.connect(destination)
    source.start()
    let closed = false
    return {
      track,
      durationMs,
      close() {
        if (closed) return
        closed = true
        source.stop()
        track.stop()
        void context.close()
      },
    }
  } catch (error) {
    await context.close()
    throw error
  }
}
