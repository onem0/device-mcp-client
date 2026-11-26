// Messages between daemon and server over /daemon/ws (JSON, one message per frame).
// Counterpart: server/src/services/protocol.ts. Always apply changes to both files.

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
  // -1 as long as the line index of an old job is not loaded.
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
  // read_file with encoding=base64: a byte range of the file.
  | { kind: 'base64'; path: string; size: number; offset: number; length: number; data: string; hasMore: boolean }

export interface EditFileResult {
  path: string
  replacements: number
  // true if the write could not be done atomically (directory not writable).
  inPlace: boolean
  crlf: boolean
  // Snippets around the first changes, line numbers 1-based.
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
  // true if the tmux server runs outside the daemon process (systemd-run) and survives a restart.
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

// Reply to "update". installed: the new binary is on disk.
// restart now: the daemon restarts right away. when_idle: as soon as no job is running. manual: it does not run as a service.
export type UpdateResult =
  | { status: 'current'; version: string }
  | { status: 'installed'; version: string; restart: 'now' | 'when_idle' | 'manual'; runningJobs: number }

export interface WriteFileResult {
  path: string
  bytesWritten: number
  size: number
  created: boolean
}

// Error reported by the daemon; goes to the server as { ok: false, error }.
export class DaemonError extends Error {
  constructor(
    message: string,
    public code = 'ERROR',
  ) {
    super(message)
  }
}
