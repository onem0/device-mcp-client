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
