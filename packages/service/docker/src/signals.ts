import { DockerInputError } from "./state.js"

// Pinned moby/sys/signal Linux amd64 map; this never sends a host signal.
const names: Record<string, number> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  ILL: 4,
  TRAP: 5,
  ABRT: 6,
  IOT: 6,
  BUS: 7,
  FPE: 8,
  KILL: 9,
  USR1: 10,
  SEGV: 11,
  USR2: 12,
  PIPE: 13,
  ALRM: 14,
  TERM: 15,
  STKFLT: 16,
  CHLD: 17,
  CLD: 17,
  CONT: 18,
  STOP: 19,
  TSTP: 20,
  TTIN: 21,
  TTOU: 22,
  URG: 23,
  XCPU: 24,
  XFSZ: 25,
  VTALRM: 26,
  PROF: 27,
  WINCH: 28,
  IO: 29,
  POLL: 29,
  PWR: 30,
  SYS: 31,
  RTMIN: 34,
  RTMAX: 64,
}
for (let n = 1; n <= 15; n++) names[`RTMIN+${n}`] = 34 + n
for (let n = 1; n <= 14; n++) names[`RTMAX-${n}`] = 64 - n
export const parseSignal = (raw: string, checkPlatform: boolean): number => {
  const signal = /^[+-]?\d+$/.test(raw) ? Number(raw) : names[raw.toUpperCase().replace(/^SIG/, "")]
  if (signal === undefined || !Number.isSafeInteger(signal) || signal === 0)
    throw new DockerInputError(400, `invalid signal: ${raw}`)
  if (checkPlatform && !Object.values(names).includes(signal))
    throw new DockerInputError(400, `the linux daemon does not support signal ${signal}`)
  return signal
}

export const stopTimeout = (raw: string | null, fallback: number): number => {
  if (!raw) return fallback
  const syntax = /^[+-]?\d+$/.test(raw)
  if (!syntax || BigInt(raw) < -(2n ** 63n) || BigInt(raw) > 2n ** 63n - 1n)
    throw new DockerInputError(
      500,
      `strconv.Atoi: parsing ${JSON.stringify(raw)}: ${syntax ? "value out of range" : "invalid syntax"}`,
    )
  if (!Number.isSafeInteger(Number(raw)))
    throw new DockerInputError(501, "Mockingbird: timeout outside the supported safe integer range")
  return Number(raw)
}
