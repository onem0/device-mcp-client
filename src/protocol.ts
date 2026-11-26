// Nachrichten zwischen Daemon und Server über /daemon/ws (JSON, eine Nachricht pro Frame).
// Gegenstück: server/src/services/protocol.ts. Änderungen immer in beiden Dateien nachziehen.

export const PROTOCOL_VERSION = 1

export const CloseCode = {
  BadMessage: 4400,
  InvalidToken: 4401,
  Disabled: 4403,
  Replaced: 4409,
  HelloTimeout: 4408,
  HeartbeatTimeout: 4000,
} as const

export type JobStatus = 'running' | 'exited' | 'killed' | 'timeout' | 'failed' | 'lost'

export interface DaemonInfo {
  hostname: string
  os: string
  kernel: string
  arch: string
  username: string
  homeDir: string
  version: string
}

export interface JobSummary {
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
  // -1, solange der Zeilenindex eines alten Jobs nicht geladen ist.
  outputLines: number
  outputBytes: number
  outputTruncated: boolean
}

export type DaemonMessage =
  | { type: 'hello'; protocol: number; token: string; info: DaemonInfo; jobs: JobSummary[] }
  | { type: 'heartbeat' }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: { message: string; code?: string } }
  | { type: 'job_exit'; job: JobSummary }

export type ServerMessage =
  | { type: 'welcome'; deviceId: string; name: string; heartbeatIntervalMs: number; heartbeatTimeoutMs: number }
  | { type: 'heartbeat_ack' }
  | { type: 'request'; id: number; method: string; params: unknown }

export interface OutputChunk {
  text: string
  fromLine: number
  toLine: number
  totalLines: number
  omittedLines?: number
  omittedFrom?: number
  tailText?: string
  tailFromLine?: number
  truncatedChars: boolean
  job: JobSummary
}

export type ReadFileResult =
  | {
      kind: 'text'
      path: string
      size: number
      text: string
      fromLine: number
      toLine: number
      totalLines: number | null
      hasMore: boolean
      truncatedChars: boolean
    }
  | { kind: 'image'; path: string; size: number; mimeType: string; data: string }
  | { kind: 'binary'; path: string; size: number; mimeType: string | null }
  // read_file mit encoding=base64: ein Byte-Bereich der Datei.
  | { kind: 'base64'; path: string; size: number; offset: number; length: number; data: string; hasMore: boolean }

export interface EditFileResult {
  path: string
  replacements: number
  // true, wenn nicht atomar geschrieben werden konnte (Ordner nicht beschreibbar).
  inPlace: boolean
  crlf: boolean
  // Ausschnitte rund um die ersten Änderungen, Zeilennummern 1-basiert.
  snippets: { fromLine: number; lines: string[] }[]
}

export interface SessionInfo {
  name: string
  created: string
  command: string
  dead: boolean
  exitStatus: number | null
  width: number
  height: number
  attached: boolean
}

export interface SessionStartResult {
  name: string
  cwd: string
  cols: number
  rows: number
  // true, wenn der tmux-Server außerhalb des Daemon-Prozesses läuft (systemd-run) und einen Neustart übersteht.
  detachedFromDaemon: boolean
}

export interface SessionScreen {
  name: string
  text: string
  lines: number
  dead: boolean
  exitStatus: number | null
  command: string
}

// Antwort auf "update". installed: Das neue Binary liegt auf der Platte.
// restart now: Der Daemon startet gleich neu. when_idle: sobald kein Job mehr läuft. manual: Er läuft nicht als Service.
export type UpdateResult =
  | { status: 'current'; version: string }
  | { status: 'installed'; version: string; restart: 'now' | 'when_idle' | 'manual'; runningJobs: number }

export interface WriteFileResult {
  path: string
  bytesWritten: number
  size: number
  created: boolean
}

// Vom Daemon gemeldeter Fehler, geht als { ok: false, error } an den Server.
export class DaemonError extends Error {
  constructor(
    message: string,
    public code = 'ERROR',
  ) {
    super(message)
  }
}
