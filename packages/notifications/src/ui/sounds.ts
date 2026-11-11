/// <reference lib="dom" />
/**
 * Alert sounds, synthesized with Web Audio so no audio files ship with the package. Each is a
 * generic tone in the style of its platform: a bright three-note chime for an iPhone text, a
 * glassy two-note chime for an iPhone notification, a soft marimba pluck for Android and a short
 * two-tone ding for new mail. Phones also vibrate where the browser supports it.
 *
 * Browsers only start audio after a user gesture, so `unlock()` runs on the first pointer or key
 * press inside the UI.
 */
export type SoundKind = "sms" | "push-ios" | "push-android" | "email"

export type SoundPlayer = {
  play(kind: SoundKind): void
  unlock(): void
  enabled: boolean
  close(): void
}

type Ctx = AudioContext

/** A struck bell: a sine with inharmonic partials and an exponential decay. */
const bell = (ctx: Ctx, out: AudioNode, at: number, freq: number, length: number, level = 1) => {
  for (const [ratio, gain] of [
    [1, 1],
    [2.76, 0.18],
    [5.4, 0.06],
  ] as const) {
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = freq * ratio
    env.gain.setValueAtTime(0, at)
    env.gain.linearRampToValueAtTime(0.32 * gain * level, at + 0.006)
    env.gain.exponentialRampToValueAtTime(0.0001, at + length / ratio ** 0.35)
    osc.connect(env).connect(out)
    osc.start(at)
    osc.stop(at + length + 0.05)
  }
}

/** A mallet: a triangle through a closing low-pass, short and warm. */
const mallet = (ctx: Ctx, out: AudioNode, at: number, freq: number, length: number) => {
  const osc = ctx.createOscillator()
  const filter = ctx.createBiquadFilter()
  const env = ctx.createGain()
  osc.type = "triangle"
  osc.frequency.value = freq
  filter.type = "lowpass"
  filter.frequency.setValueAtTime(freq * 6, at)
  filter.frequency.exponentialRampToValueAtTime(freq * 1.5, at + length)
  env.gain.setValueAtTime(0, at)
  env.gain.linearRampToValueAtTime(0.42, at + 0.004)
  env.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(filter).connect(env).connect(out)
  osc.start(at)
  osc.stop(at + length + 0.05)
}

const VOICES: Record<SoundKind, (ctx: Ctx, out: AudioNode, t: number) => void> = {
  sms: (ctx, out, t) => {
    bell(ctx, out, t, 1318.5, 0.5)
    bell(ctx, out, t + 0.12, 1661.2, 0.5)
    bell(ctx, out, t + 0.24, 1975.5, 0.8)
  },
  "push-ios": (ctx, out, t) => {
    bell(ctx, out, t, 1760, 0.35, 0.8)
    bell(ctx, out, t + 0.09, 2349.3, 0.9, 0.9)
  },
  "push-android": (ctx, out, t) => {
    mallet(ctx, out, t, 1046.5, 0.22)
    mallet(ctx, out, t + 0.1, 1568, 0.22)
    mallet(ctx, out, t + 0.2, 2093, 0.45)
  },
  email: (ctx, out, t) => {
    bell(ctx, out, t, 987.8, 0.45, 0.7)
    bell(ctx, out, t + 0.16, 1318.5, 0.9, 0.7)
  },
}

const VIBRATION: Partial<Record<SoundKind, number[]>> = {
  sms: [180, 90, 180],
  "push-ios": [120],
  "push-android": [60, 80, 60],
}

export const createSoundPlayer = (initial = false): SoundPlayer => {
  let ctx: Ctx | null = null
  let master: GainNode | null = null
  const lastPlayed = new Map<SoundKind, number>()
  const ensure = (): Ctx | null => {
    if (ctx) return ctx
    const Ctor =
      globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    try {
      ctx = new Ctor()
      master = ctx.createGain()
      master.gain.value = 0.6
      master.connect(ctx.destination)
    } catch {
      ctx = null
    }
    return ctx
  }
  const player: SoundPlayer = {
    enabled: initial,
    unlock() {
      if (!player.enabled) return
      const c = ensure()
      if (c?.state === "suspended") void c.resume().catch(() => {})
    },
    play(kind) {
      if (!player.enabled) return
      const now = Date.now()
      // One alert per kind per moment, as a phone does for a burst.
      if (now - (lastPlayed.get(kind) ?? 0) < 600) return
      lastPlayed.set(kind, now)
      const pattern = VIBRATION[kind]
      if (pattern) {
        try {
          navigator.vibrate?.(pattern)
        } catch {}
      }
      const c = ensure()
      if (!c || !master) return
      if (c.state === "suspended") void c.resume().catch(() => {})
      VOICES[kind](c, master, c.currentTime + 0.02)
    },
    close() {
      void ctx?.close().catch(() => {})
      ctx = null
    },
  }
  return player
}
