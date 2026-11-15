export class FleetAdmissionTimeout extends Error {
  override readonly name = "FleetAdmissionTimeout"
  constructor() {
    super("Fleet control timed out waiting for active requests to drain")
  }
}

/** While draining, admit nested application requests; only an acquired writer fences readers. */
export function createAdmission(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("controlTimeoutMs must be positive")
  let readers = 0
  let writing = false
  const readersWaiting: (() => void)[] = []
  const writers: {
    grant(): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  const next = () => {
    if (writing || readers > 0) return
    const writer = writers.shift()
    if (writer) {
      writing = true
      clearTimeout(writer.timer)
      writer.grant()
      return
    }
    for (const grant of readersWaiting.splice(0)) grant()
  }
  const read = () =>
    new Promise<() => void>((resolve) => {
      const grant = () => {
        readers++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          readers--
          next()
        })
      }
      if (writing) readersWaiting.push(grant)
      else grant()
    })
  const write = () =>
    new Promise<() => void>((resolve, reject) => {
      const pending = {
        grant() {
          let released = false
          resolve(() => {
            if (released) return
            released = true
            writing = false
            next()
          })
        },
        reject,
        timer: setTimeout(() => {
          const index = writers.indexOf(pending)
          if (index < 0) return
          writers.splice(index, 1)
          reject(new FleetAdmissionTimeout())
          next()
        }, timeoutMs),
      }
      writers.push(pending)
      next()
    })
  return { read, write }
}
