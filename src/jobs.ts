import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { log } from './log.ts'
import { home, resolveUserPath } from './paths.ts'
import { DaemonError, type JobStatus, type JobSummary, type OutputChunk } from './protocol.ts'
import { capLine, cleanOutputLine, MAX_LINE_CHARS, takeLines, takeLinesFromEnd } from './text.ts'

// Ab hier wird die Ausgabe eines Jobs verworfen (die Pipes werden weiter geleert).
const MAX_LOG_BYTES = 64 * 1024 * 1024
const KILL_GRACE_MS = 5_000
// Nach dem Ende von bash so lange auf geschlossene Pipes warten. Hintergrundprozesse (cmd &) halten sie sonst offen.
const CLOSE_GRACE_MS = 2_000
const KEEP_JOBS = 300
const KEEP_DAYS = 14
const INDEX_IDLE_MS = 10 * 60_000
// Zeichenbudget pro Antwort, grob 25k Tokens.
const MAX_OUTPUT_CHARS = 100_000
const HEADTAIL_PART_CHARS = 40_000
// Pro Zeile höchstens so viele Bytes lesen, der Rest wird nur gezählt.
const MAX_LINE_BYTES = MAX_LINE_CHARS * 4

interface JobMeta {
  id: string
  command: string
  cwd: string
  status: JobStatus
  exitCode: number | null
  signal: string | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  timeoutMs: number | null
  outputBytes: number
  outputTruncated: boolean
}

// Byte-Offsets der Zeilenanfänge im Log. Damit lassen sich Zeilenbereiche lesen, ohne die Datei zu zerlegen.
class LineIndex {
  starts: number[] = [0]
  size = 0

  push(chunk: Uint8Array) {
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) this.starts.push(this.size + i + 1)
    this.size += chunk.length
  }

  get lines() {
    if (this.size === 0) return 0
    return this.starts[this.starts.length - 1] === this.size ? this.starts.length - 1 : this.starts.length
  }

  // Bytebereich von Zeile i, ohne das abschließende \n.
  line(i: number): [number, number] {
    const start = this.starts[i]!
    const next = i + 1 < this.starts.length ? this.starts[i + 1]! : this.size
    const end = next > start && i + 1 < this.starts.length ? next - 1 : next
    return [start, end]
  }
}

class Job {
  index: LineIndex | null = null
  indexUsedAt = Date.now()
  proc: ChildProcess | null = null
  pid: number | null = null
  writeFd: number | null = null
  timeoutTimer: Timer | null = null
  killTimer: Timer | null = null
  closeTimer: Timer | null = null
  timedOut = false
  killRequested: string | null = null

  constructor(
    public meta: JobMeta,
    public logPath: string,
  ) {}

  get running() {
    return this.meta.status === 'running'
  }
}

export interface ExecParams {
  jobId: string
  command: string
  cwd?: string | null
  timeoutMs?: number | null
}

export type OutputParams =
  | { jobId: string; mode: 'range'; offset: number; limit: number }
  | { jobId: string; mode: 'tail'; lines: number }
  | { jobId: string; mode: 'headtail'; head: number; tail: number }

// Umgebung für Befehle: wie der Daemon, aber ohne Pager und ohne interaktive Abfragen.
function commandEnv() {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('DEVICE_MCP_')) env[key] = value
  }
  return { ...env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }
}

export class JobManager extends EventEmitter<{ exit: [JobSummary] }> {
  private jobs = new Map<string, Job>()
  private dir: string
  private pruneTimer: Timer | null = null

  constructor(stateDir: string) {
    super()
    this.dir = path.join(stateDir, 'jobs')
  }

  init() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const meta = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as JobMeta
        const job = new Job(meta, path.join(this.dir, `${meta.id}.log`))
        // Ein Job, der beim letzten Lauf noch lief, ist mit dem Daemon beendet worden.
        if (meta.status === 'running') {
          meta.status = 'lost'
          meta.error = 'The daemon restarted while the job was running.'
          meta.finishedAt = new Date().toISOString()
          this.save(job)
        }
        this.jobs.set(meta.id, job)
      } catch (err) {
        log.warn(`Cannot read job file ${file}: ${(err as Error).message}`)
      }
    }
    this.prune()
    this.pruneTimer = setInterval(() => this.prune(), 60 * 60_000)
    this.pruneTimer.unref?.()
  }

  summaries(limit = KEEP_JOBS) {
    return this.sorted()
      .slice(0, limit)
      .map((job) => this.summary(job))
  }

  start(params: ExecParams): JobSummary {
    const { jobId, command } = params
    if (typeof jobId !== 'string' || !/^[a-z0-9]{4,64}$/.test(jobId)) throw new DaemonError('Invalid job ID.', 'BAD_REQUEST')
    if (typeof command !== 'string' || !command) throw new DaemonError('No command given.', 'BAD_REQUEST')
    if (this.jobs.has(jobId)) throw new DaemonError(`Job ${jobId} already exists.`, 'CONFLICT')

    const cwd = params.cwd ? resolveUserPath(params.cwd) : home()
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      throw new DaemonError(`Working directory ${cwd} does not exist.`, 'NOT_FOUND')
    }
    if (!isDir) throw new DaemonError(`${cwd} is not a directory.`, 'BAD_REQUEST')

    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : null
    const job = new Job(
      {
        id: jobId,
        command,
        cwd,
        status: 'running',
        exitCode: null,
        signal: null,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        timeoutMs,
        outputBytes: 0,
        outputTruncated: false,
      },
      path.join(this.dir, `${jobId}.log`),
    )
    job.index = new LineIndex()
    job.writeFd = openSync(job.logPath, 'w', 0o600)
    this.jobs.set(jobId, job)
    this.save(job)

    // detached: eigene Prozessgruppe, damit kill_job und Timeout auch Kindprozesse erreichen.
    const child = spawn('bash', ['-c', command], { cwd, env: commandEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    job.proc = child
    job.pid = child.pid ?? null

    const onData = (chunk: Buffer) => this.append(job, chunk)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('error', (err) => {
      job.meta.error = `Failed to start: ${err.message}`
      this.finish(job, null, null, 'failed')
      this.closeLog(job)
    })
    child.on('exit', (code, signal) => {
      // Auf die Pipes warten, aber nicht ewig: "server &" hält sie sonst offen.
      job.closeTimer = setTimeout(() => this.finish(job, code, signal), CLOSE_GRACE_MS)
    })
    child.on('close', (code, signal) => {
      this.finish(job, code, signal)
      this.closeLog(job)
    })

    if (timeoutMs) {
      job.timeoutTimer = setTimeout(() => {
        job.timedOut = true
        this.signal(job, 'SIGTERM')
        // Auch nach dem Ende von bash, solange Kindprozesse die Pipes noch offen halten.
        job.killTimer = setTimeout(() => {
          if (job.running || job.writeFd !== null) this.signal(job, 'SIGKILL')
        }, KILL_GRACE_MS)
      }, timeoutMs)
    }

    log.info(`Job ${jobId} started (pid ${job.pid ?? '?'}): ${command.slice(0, 200)}`)
    return this.summary(job)
  }

  status(jobId: string) {
    const job = this.get(jobId)
    this.ensureIndex(job)
    return this.summary(job)
  }

  list(limit: number) {
    return this.sorted()
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((job) => this.summary(job))
  }

  // Wartet kurz auf das Ende, damit der Aufrufer gleich den Endstand sieht.
  async kill(jobId: string, signal: NodeJS.Signals = 'SIGTERM') {
    const job = this.get(jobId)
    if (!job.running) throw new DaemonError(`Job ${jobId} is no longer running (${job.meta.status}).`, 'NOT_RUNNING')
    if (!['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'].includes(signal)) throw new DaemonError(`Signal ${signal} is not allowed.`, 'BAD_REQUEST')
    job.killRequested = signal
    this.signal(job, signal)
    if (signal !== 'SIGKILL' && !job.killTimer) {
      job.killTimer = setTimeout(() => {
        if (job.running) this.signal(job, 'SIGKILL')
      }, KILL_GRACE_MS)
    }
    if (job.running) await this.waitForExit(jobId, 1_500)
    this.ensureIndex(job)
    return this.summary(job)
  }

  private waitForExit(jobId: string, timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const onExit = (summary: JobSummary) => {
        if (summary.id === jobId) finish()
      }
      const finish = () => {
        clearTimeout(timer)
        this.off('exit', onExit)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.on('exit', onExit)
    })
  }

  runningCount() {
    let n = 0
    for (const job of this.jobs.values()) if (job.running) n++
    return n
  }

  // Beim Beenden des Daemons: laufende Jobs nicht als Waisen zurücklassen.
  killAll() {
    for (const job of this.jobs.values()) {
      if (!job.running) continue
      job.killRequested = 'SIGTERM'
      this.signal(job, 'SIGTERM')
    }
  }

  output(params: OutputParams): OutputChunk {
    const job = this.get(params.jobId)
    const index = this.ensureIndex(job)
    const total = index.lines
    const fd = total > 0 ? openSync(job.logPath, 'r') : null
    try {
      const read = (from: number, to: number) => this.readLines(fd!, index, from, to)
      const base = { totalLines: total, job: this.summary(job) }
      if (total === 0) return { ...base, text: '', fromLine: 0, toLine: 0, truncatedChars: false }

      if (params.mode === 'range') {
        const from = Math.min(Math.max(0, params.offset | 0), total)
        const to = Math.min(total, from + Math.max(1, params.limit | 0))
        const lines = read(from, to)
        const taken = takeLines(lines.lines, MAX_OUTPUT_CHARS)
        return { ...base, text: taken.join('\n'), fromLine: from, toLine: from + taken.length, truncatedChars: lines.cut || taken.length < lines.lines.length }
      }

      if (params.mode === 'tail') {
        const from = Math.max(0, total - Math.max(1, params.lines | 0))
        const lines = read(from, total)
        const taken = takeLinesFromEnd(lines.lines, MAX_OUTPUT_CHARS)
        return { ...base, text: taken.join('\n'), fromLine: total - taken.length, toLine: total, truncatedChars: lines.cut || taken.length < lines.lines.length }
      }

      // headtail: Anfang und Ende, die Mitte nur als Zahl. Für run_command im Vordergrund.
      const headEnd = Math.min(total, Math.max(0, params.head | 0))
      const tailStart = Math.max(headEnd, total - Math.max(0, params.tail | 0))
      const headRead = read(0, headEnd)
      const head = takeLines(headRead.lines, HEADTAIL_PART_CHARS)
      const tailRead = read(tailStart, total)
      const tail = takeLinesFromEnd(tailRead.lines, HEADTAIL_PART_CHARS)
      const shownHead = head.length
      const tailFrom = total - tail.length
      const omitted = tailFrom - shownHead
      const cut = headRead.cut || tailRead.cut || head.length < headRead.lines.length || tail.length < tailRead.lines.length
      if (omitted <= 0) {
        return { ...base, text: [...head, ...tail].join('\n'), fromLine: 0, toLine: total, truncatedChars: cut }
      }
      return {
        ...base,
        text: head.join('\n'),
        fromLine: 0,
        toLine: shownHead,
        omittedLines: omitted,
        omittedFrom: shownHead,
        tailText: tail.join('\n'),
        tailFromLine: tailFrom,
        truncatedChars: cut,
      }
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  private readLines(fd: number, index: LineIndex, from: number, to: number) {
    const lines: string[] = []
    let cut = false
    const buf = Buffer.allocUnsafe(MAX_LINE_BYTES)
    for (let i = from; i < to; i++) {
      const [start, end] = index.line(i)
      const len = end - start
      const n = len > 0 ? readSync(fd, buf, 0, Math.min(len, MAX_LINE_BYTES), start) : 0
      const capped = capLine(cleanOutputLine(buf.toString('utf8', 0, n)), Math.max(0, len - n))
      if (capped.cut) cut = true
      lines.push(capped.text)
    }
    return { lines, cut }
  }

  private get(jobId: string) {
    const job = typeof jobId === 'string' ? this.jobs.get(jobId) : undefined
    if (!job) throw new DaemonError(`Job ${jobId} is not known on this device.`, 'NOT_FOUND')
    return job
  }

  private sorted() {
    return [...this.jobs.values()].sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt))
  }

  private append(job: Job, chunk: Buffer) {
    if (job.writeFd === null) return
    let data: Buffer = chunk
    if (job.meta.outputBytes + data.length > MAX_LOG_BYTES) {
      if (!job.meta.outputTruncated) {
        data = data.subarray(0, Math.max(0, MAX_LOG_BYTES - job.meta.outputBytes))
        job.meta.outputTruncated = true
        log.warn(`Job ${job.meta.id}: log full (${MAX_LOG_BYTES} bytes), discarding further output`)
      } else return
    }
    if (data.length === 0) return
    writeSync(job.writeFd, data)
    job.meta.outputBytes += data.length
    job.index?.push(data)
  }

  private closeLog(job: Job) {
    if (job.writeFd === null) return
    try {
      closeSync(job.writeFd)
    } catch {
      // schon zu
    }
    job.writeFd = null
  }

  private signal(job: Job, signal: NodeJS.Signals) {
    if (!job.pid) return
    try {
      process.kill(-job.pid, signal)
    } catch {
      try {
        process.kill(job.pid, signal)
      } catch {
        // Prozess ist schon weg.
      }
    }
  }

  private finish(job: Job, code: number | null, signal: NodeJS.Signals | null, forced?: JobStatus) {
    if (!job.running) return
    for (const timer of [job.timeoutTimer, job.closeTimer]) if (timer) clearTimeout(timer)
    // killTimer bleibt bewusst stehen: Bei einem Timeout sollen auch hängende Kindprozesse noch SIGKILL bekommen.
    const meta = job.meta
    meta.status = forced ?? (job.timedOut ? 'timeout' : job.killRequested || signal ? 'killed' : 'exited')
    meta.exitCode = code
    meta.signal = signal ?? (meta.status === 'killed' ? job.killRequested : null)
    meta.finishedAt = new Date().toISOString()
    meta.durationMs = Date.parse(meta.finishedAt) - Date.parse(meta.startedAt)
    this.save(job)
    log.info(`Job ${meta.id} ${meta.status}${code !== null ? ` (exit ${code})` : ''}${signal ? ` (${signal})` : ''} after ${meta.durationMs} ms`)
    this.emit('exit', this.summary(job))
  }

  private ensureIndex(job: Job) {
    job.indexUsedAt = Date.now()
    if (job.index) return job.index
    const index = new LineIndex()
    if (existsSync(job.logPath)) {
      const fd = openSync(job.logPath, 'r')
      try {
        const buf = Buffer.allocUnsafe(1024 * 1024)
        let pos = 0
        for (let n = readSync(fd, buf, 0, buf.length, pos); n > 0; n = readSync(fd, buf, 0, buf.length, pos)) {
          index.push(buf.subarray(0, n))
          pos += n
        }
      } finally {
        closeSync(fd)
      }
    }
    job.index = index
    return index
  }

  private summary(job: Job): JobSummary {
    return { ...job.meta, outputLines: job.index ? job.index.lines : -1 }
  }

  private save(job: Job) {
    const file = path.join(this.dir, `${job.meta.id}.json`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(job.meta), { mode: 0o600 })
    renameSync(tmp, file)
  }

  // Alte Jobs löschen, Zeilenindizes lange nicht gelesener Jobs aus dem Speicher werfen.
  private prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    const finished = this.sorted().filter((job) => !job.running)
    finished.forEach((job, i) => {
      const old = Date.parse(job.meta.finishedAt ?? job.meta.startedAt) < cutoff
      if (i < KEEP_JOBS && !old) {
        if (job.index && Date.now() - job.indexUsedAt > INDEX_IDLE_MS) job.index = null
        return
      }
      this.jobs.delete(job.meta.id)
      rmSync(job.logPath, { force: true })
      rmSync(path.join(this.dir, `${job.meta.id}.json`), { force: true })
    })
  }
}
