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
  // Version of Claude Code found when the daemon started, null if there is none (since 0.6.0).
  claudeCode?: string | null
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
  // Since 0.6.0: number of windows, and whether it is one of the user's own sessions (no mcp- prefix).
  windows?: number
  own?: boolean
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
  // Since 0.6.0. cursor: 1-based on the visible screen. alternateScreen: a full-screen program (editor, TUI) is in front.
  cursor?: { row: number; col: number }
  alternateScreen?: boolean
  own?: boolean
  // Highlighted text (selection, reverse video) is wrapped in ⟦…⟧.
  highlighted?: boolean
  // Only for session_wait and session_send with wait_for.
  wait?: SessionWaitInfo
}

export interface SessionWaitInfo {
  reason: 'pattern' | 'quiet' | 'shell' | 'exited' | 'timeout'
  waitedMs: number
  match: string | null
  // true: wait_for was matched against new output only; false: against the screen.
  outputMatched: boolean
}

// Claude Code (since 0.6.0).
export interface ClaudeInfo {
  path: string | null
  version: string | null
}

export interface ClaudeStartResult {
  job: JobSummary
  claude: ClaudeInfo
  sessionId: string
}

export interface ClaudeEvent {
  kind: 'init' | 'text' | 'tool' | 'error' | 'output' | 'note'
  text: string
  // From a subagent.
  sub?: boolean
}

export interface ClaudeResult {
  subtype: string
  isError: boolean
  text: string
  numTurns: number | null
  durationMs: number | null
  costUsd: number | null
  permissionDenials: string[]
  sessionId: string | null
}

export interface ClaudeEventsResult {
  job: JobSummary
  events: ClaudeEvent[]
  // Lines of the stream-json log: continue with offset = toLine.
  fromLine: number
  toLine: number
  totalLines: number
  hasMore: boolean
  result: ClaudeResult | null
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
