import { Collection } from "@crvouga/mockingbird-service"
import type { SqliteClient } from "@crvouga/mockingbird-sqlite"

/**
 * A scripted transcript (`PUT /__admin/transcripts`): what Transcribe "hears". Audio bytes
 * sent in are ignored; the words come from here.
 */
export type TranscriptScript = {
  id: string
  /**
   * Which streaming session (0-based, per namespace) or batch job this answers; `any: true`
   * (or no match) answers any session that has no more specific script.
   */
  match?: { sessionIndex?: number; jobName?: string; any?: boolean }
  /** Partial results, sent one per audio chunk received, in order. */
  partials?: string[]
  /** The final (IsPartial: false) result, sent when the audio ends. */
  final: string
  /** Answer at most this many sessions / jobs. */
  times?: number
}

/** A Transcribe batch job, with only the fields the service echoes back. */
export type JobRecord = {
  TranscriptionJobName: string
  TranscriptionJobStatus: "QUEUED" | "IN_PROGRESS" | "FAILED" | "COMPLETED"
  LanguageCode: string
  MediaFormat?: string
  MediaSampleRateHertz?: number
  Media: { MediaFileUri?: string }
  Settings?: Record<string, unknown>
  OutputBucketName?: string
  OutputKey?: string
  region: string
  /** Mock-clock epoch ms. */
  createdAtMs: number
  completedAtMs?: number
  failureReason?: string
  /** The transcript text, fixed when the job completes. */
  transcript?: string
}

/** Per-namespace knobs, set through `PUT /__admin/settings`; cleared on reset. */
export type Settings = {
  /** What an unscripted streaming session or batch job hears. */
  defaultTranscript: string
  /** Mock-clock ms from `StartTranscriptionJob` to COMPLETED (0: complete on the first Get). */
  jobDurationMs: number
}

export const DEFAULT_SETTINGS: Settings = {
  defaultTranscript: "Hello.",
  jobDurationMs: 2_000,
}

/** Metadata about one synthesis or transcription (never the text). */
export type SpeechLogEntry = {
  operation: string
  voiceId?: string
  engine?: string
  outputFormat?: string
  sampleRate?: string
  characters?: number
  audioBytes: number
  /** Audio events received (transcription). */
  chunks?: number
  script?: string
}

export type SpeechStats = {
  sessions: number
  scripted: number
  unscripted: number
}

export class SpeechState {
  readonly transcripts: Collection<TranscriptScript>
  readonly uses: Collection<number>
  readonly jobs: Collection<JobRecord>
  readonly settings: Collection<Settings>
  readonly stats: Collection<SpeechStats>
  readonly log: Collection<SpeechLogEntry>

  constructor(
    sqlite: SqliteClient,
    namespace: string,
    private readonly seed: {
      settings: Partial<Settings>
      transcripts: readonly TranscriptScript[]
    },
  ) {
    this.transcripts = new Collection(sqlite, namespace, "transcripts")
    this.uses = new Collection(sqlite, namespace, "transcript_uses")
    this.jobs = new Collection(sqlite, namespace, "jobs")
    this.settings = new Collection(sqlite, namespace, "settings")
    this.stats = new Collection(sqlite, namespace, "stats")
    this.log = new Collection(sqlite, namespace, "speech_log")
    this.ensureSeeded()
  }

  ensureSeeded(): void {
    if (!this.settings.has("settings")) {
      this.settings.insert("settings", { ...DEFAULT_SETTINGS, ...this.seed.settings })
      for (const script of this.seed.transcripts) this.transcripts.insert(script.id, script)
    }
  }

  current(): Settings {
    return this.settings.get("settings") ?? DEFAULT_SETTINGS
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.current(), ...patch }
    this.settings.insert("settings", next)
    return next
  }

  scripts(): TranscriptScript[] {
    return this.transcripts.list({ order: "oldest" }).map((row) => row.value)
  }

  put(scripts: readonly TranscriptScript[], replace: boolean): TranscriptScript[] {
    if (replace) {
      for (const row of this.transcripts.list()) this.transcripts.delete(row.id)
      for (const row of this.uses.list()) this.uses.delete(row.id)
    }
    for (const script of scripts) this.transcripts.insert(script.id, script)
    return this.scripts()
  }

  remove(id?: string): number {
    const targets = id === undefined ? this.transcripts.list().map((row) => row.id) : [id]
    let removed = 0
    for (const each of targets) {
      if (this.transcripts.delete(each)) removed++
      this.uses.delete(each)
    }
    return removed
  }

  /**
   * The transcript for a session or job: the first script naming it exactly, else the first
   * `any` (or unmatched) script with uses left. Counts the use and the stats.
   */
  pick(target: { sessionIndex?: number; jobName?: string }): TranscriptScript | undefined {
    const usable = this.scripts().filter(
      (s) => s.times === undefined || (this.uses.get(s.id) ?? 0) < s.times,
    )
    const exact = usable.find(
      (s) =>
        (target.sessionIndex !== undefined && s.match?.sessionIndex === target.sessionIndex) ||
        (target.jobName !== undefined && s.match?.jobName === target.jobName),
    )
    const chosen =
      exact ??
      usable.find(
        (s) =>
          !s.match ||
          s.match.any === true ||
          (s.match.sessionIndex === undefined && s.match.jobName === undefined),
      )
    const stats = this.currentStats()
    if (chosen) this.uses.insert(chosen.id, (this.uses.get(chosen.id) ?? 0) + 1)
    this.stats.insert("stats", {
      ...stats,
      scripted: stats.scripted + (chosen ? 1 : 0),
      unscripted: stats.unscripted + (chosen ? 0 : 1),
    })
    return chosen
  }

  /** The 0-based index of the next streaming session in this namespace. */
  nextSessionIndex(): number {
    const stats = this.currentStats()
    this.stats.insert("stats", { ...stats, sessions: stats.sessions + 1 })
    return stats.sessions
  }

  currentStats(): SpeechStats {
    return this.stats.get("stats") ?? { sessions: 0, scripted: 0, unscripted: 0 }
  }

  record(entry: SpeechLogEntry): void {
    this.log.insert(String(this.log.nextSequence()), entry)
  }
}
