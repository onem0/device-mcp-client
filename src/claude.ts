// Claude Code on the device: find the CLI, start headless runs (claude -p) as jobs, and turn their stream-json log
// into short events for the Claude on the other side of the MCP connection.

import { spawn } from 'node:child_process'
import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { JobManager } from './jobs.ts'
import { home } from './paths.ts'
import { DaemonError, type ClaudeEvent, type ClaudeEventsResult, type ClaudeInfo, type ClaudeResult, type ClaudeStartResult } from './protocol.ts'
import { cleanOutputLine } from './text.ts'

export const PERMISSION_MODES = ['bypassPermissions', 'acceptEdits', 'plan'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL_RE = /^[A-Za-z0-9._:[\]-]{1,100}$/
const MAX_PROMPT_CHARS = 200_000
const VERSION_TIMEOUT_MS = 15_000
const DETECT_TTL_MS = 60_000
// stream-json lines above this size (huge tool results) are skipped instead of parsed.
const MAX_EVENT_LINE_BYTES = 8 * 1024 * 1024
const PAGE_LINES = 2000
const PAGE_CHARS = 40_000
const TEXT_CHARS = 4000
const TOOL_CHARS = 300
const ERROR_CHARS = 600
const RESULT_CHARS = 30_000

// Variables that mark a process as running inside Claude Code. A daemon started from a Claude Code shell
// would otherwise hand them on, and the child would behave like a nested session.
const NESTED_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID', 'CLAUDE_CODE_SSE_PORT']

const unique = <T>(items: T[]) => [...new Set(items)]

function isExecutable(file: string) {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// PATH first, then the places the installers use. The service's PATH can be shorter than a login shell's.
export function claudeCandidates(): string[] {
  const h = home()
  const fromPath = (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((dir) => path.join(dir, 'claude'))
  const fixed = [
    path.join(h, '.local/bin/claude'),
    path.join(h, '.claude/local/claude'),
    path.join(h, '.npm-global/bin/claude'),
    path.join(h, '.bun/bin/claude'),
    path.join(h, '.volta/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ]
  let nvm: string[] = []
  try {
    const dir = path.join(h, '.nvm/versions/node')
    nvm = readdirSync(dir)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map((v) => path.join(dir, v, 'bin/claude'))
  } catch {
    // No nvm.
  }
  return unique([...fromPath, ...fixed, ...nvm])
}

// The directory of the binary goes to the front of PATH: an npm install is a node script and needs its node.
function binDirs(bin: string) {
  const dirs = [path.dirname(bin)]
  try {
    dirs.push(path.dirname(realpathSync(bin)))
  } catch {
    // Broken link: the start fails with a clear error anyway.
  }
  return unique(dirs)
}

function claudePath(bin: string) {
  return [...binDirs(bin), ...(process.env.PATH ?? '').split(':').filter(Boolean)].join(':')
}

function readVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !NESTED_SESSION_VARS.includes(key)) env[key] = value
    env.PATH = claudePath(bin)
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, VERSION_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? (/\d+\.\d+\.\d+[^\s]*/.exec(out)?.[0] ?? out.trim().slice(0, 40)) || null : null))
  })
}

let cache: { info: ClaudeInfo; at: number } | null = null

// Cached for a minute; claude_start and claude_info check again after that.
export async function detectClaude(force = false): Promise<ClaudeInfo> {
  if (!force && cache && Date.now() - cache.at < DETECT_TTL_MS) return cache.info
  let info: ClaudeInfo = { path: null, version: null }
  for (const candidate of claudeCandidates()) {
    if (!isExecutable(candidate)) continue
    info = { path: candidate, version: await readVersion(candidate) }
    break
  }
  cache = { info, at: Date.now() }
  return info
}

// Last known result without spawning anything, for hello.
export const cachedClaudeVersion = () => cache?.info.version ?? null

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

// Appended to Claude Code's system prompt: nobody can answer questions while it runs headless.
const HEADLESS_NOTE =
  'You were started headless (claude -p) through device-mcp by another Claude instance acting for the user. ' +
  'Nobody can answer questions while you run: make reasonable decisions on your own and note them. ' +
  'Finish with a short summary of what you did, which files you changed, how you verified it, and anything left open.'

export interface ClaudeStartParams {
  jobId: string
  prompt: string
  cwd?: string | null
  sessionId: string
  resume?: boolean
  model?: string | null
  effort?: string | null
  permissionMode?: string | null
  appendSystemPrompt?: string | null
  timeoutMs?: number | null
  oauthToken?: string | null
}

export function buildClaudeArgs(p: ClaudeStartParams) {
  const mode = p.permissionMode ?? 'bypassPermissions'
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode]
  if (p.model) args.push('--model', p.model)
  if (p.effort) args.push('--effort', p.effort)
  args.push('--append-system-prompt', p.appendSystemPrompt ? `${HEADLESS_NOTE}\n\n${p.appendSystemPrompt}` : HEADLESS_NOTE)
  args.push(p.resume ? '--resume' : '--session-id', p.sessionId)
  return args
}

export function validateClaudeStart(p: ClaudeStartParams) {
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw new DaemonError('No prompt given.', 'BAD_REQUEST')
  if (p.prompt.length > MAX_PROMPT_CHARS) throw new DaemonError(`The prompt is longer than ${MAX_PROMPT_CHARS} characters.`, 'BAD_REQUEST')
  if (typeof p.sessionId !== 'string' || !UUID_RE.test(p.sessionId)) throw new DaemonError('session_id must be a UUID.', 'BAD_REQUEST')
  if (p.permissionMode && !(PERMISSION_MODES as readonly string[]).includes(p.permissionMode)) {
    throw new DaemonError(`Unknown permission mode ${p.permissionMode}. Allowed: ${PERMISSION_MODES.join(', ')}.`, 'BAD_REQUEST')
  }
  if (p.effort && !(EFFORTS as readonly string[]).includes(p.effort)) throw new DaemonError(`Unknown effort ${p.effort}. Allowed: ${EFFORTS.join(', ')}.`, 'BAD_REQUEST')
  if (p.model && !MODEL_RE.test(p.model)) throw new DaemonError(`Invalid model name "${p.model}".`, 'BAD_REQUEST')
  if ((p.permissionMode ?? 'bypassPermissions') === 'bypassPermissions' && process.getuid?.() === 0) {
    throw new DaemonError(
      'The daemon runs as root, and Claude Code refuses permission mode bypassPermissions as root. Use permission_mode acceptEdits or plan, or run the daemon as a normal user.',
      'BAD_REQUEST',
    )
  }
}

export async function claudeStart(jobs: JobManager, p: ClaudeStartParams): Promise<ClaudeStartResult> {
  validateClaudeStart(p)
  const claude = await detectClaude(true)
  if (!claude.path) {
    throw new DaemonError(
      'Claude Code is not installed on this device (no "claude" in the PATH of the daemon or in the usual places). ' +
        'Install it with run_command: curl -fsSL https://claude.ai/install.sh | bash, then log in once on the device with "claude" ' +
        '(or set CLAUDE_CODE_OAUTH_TOKEN on the server, see the device-mcp README).',
      'CLAUDE_MISSING',
    )
  }
  const env: Record<string, string | undefined> = { PATH: claudePath(claude.path) }
  for (const key of NESTED_SESSION_VARS) env[key] = undefined
  if (p.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = p.oauthToken

  const firstLine = p.prompt.trim().split('\n')[0]!
  const label = `claude -p ${JSON.stringify(firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine)}${p.resume ? ` (resume ${p.sessionId})` : ''}`
  const command = `exec ${[claude.path, ...buildClaudeArgs(p)].map(quote).join(' ')}`
  // The prompt goes through stdin: no length limit of the command line, and it does not show up in ps.
  const job = jobs.start({ jobId: p.jobId, command, cwd: p.cwd, timeoutMs: p.timeoutMs }, { stdin: p.prompt, env, label })
  return { job, claude, sessionId: p.sessionId }
}

// --- stream-json → events --------------------------------------------------------------------------------------

const oneLine = (value: unknown, max: number) => {
  const s = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}\n[… ${value.length - max} more characters]` : value)

function relative(file: unknown, cwd: string) {
  if (typeof file !== 'string') return ''
  return cwd && file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file
}

export function summarizeToolUse(name: string, input: any, cwd: string): string {
  const i = input && typeof input === 'object' ? input : {}
  switch (name) {
    case 'Bash':
      return oneLine(i.command, TOOL_CHARS)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return relative(i.file_path, cwd)
    case 'NotebookEdit':
      return relative(i.notebook_path, cwd)
    case 'Glob':
    case 'Grep':
      return `${oneLine(i.pattern, 120)}${i.path ? ` in ${relative(i.path, cwd)}` : ''}`
    case 'WebFetch':
      return oneLine(i.url, 200)
    case 'WebSearch':
      return oneLine(i.query, 200)
    case 'Task':
    case 'Agent':
      return oneLine(i.description ?? i.subagent_type ?? i.prompt, 200)
    case 'TodoWrite': {
      const todos: any[] = Array.isArray(i.todos) ? i.todos : []
      const done = todos.filter((t) => t?.status === 'completed').length
      const now = todos.find((t) => t?.status === 'in_progress')
      return `${done}/${todos.length} done${now ? `, now: ${oneLine(now.activeForm ?? now.content, 120)}` : ''}`
    }
    default:
      return oneLine(i, 200)
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : '')).join('\n')
  return ''
}

export interface ParseState {
  cwd: string
  tools: Map<string, string>
}

export function parseResult(o: any): ClaudeResult {
  const denials: any[] = Array.isArray(o.permission_denials) ? o.permission_denials : []
  return {
    subtype: typeof o.subtype === 'string' ? o.subtype : 'unknown',
    isError: o.is_error === true,
    text: typeof o.result === 'string' ? cut(o.result, RESULT_CHARS) : '',
    numTurns: typeof o.num_turns === 'number' ? o.num_turns : null,
    durationMs: typeof o.duration_ms === 'number' ? o.duration_ms : null,
    costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null,
    permissionDenials: denials.map((d) => (typeof d?.tool_name === 'string' ? d.tool_name : 'tool')),
    sessionId: typeof o.session_id === 'string' ? o.session_id : null,
  }
}

// One log line → events, plus the final result if the line is it. Lines that are not JSON are Claude Code's own
// messages on stderr (e.g. a missing login).
export function parseLine(line: string | null, state: ParseState): { events: ClaudeEvent[]; result: ClaudeResult | null } {
  const none = { events: [] as ClaudeEvent[], result: null }
  if (line === null) return { events: [{ kind: 'note', text: '(very large event skipped)' }], result: null }
  const trimmed = line.trim()
  if (!trimmed) return none
  let o: any
  try {
    o = JSON.parse(trimmed)
  } catch {
    const text = cleanOutputLine(trimmed)
    return { events: text ? [{ kind: 'output', text: cut(text, ERROR_CHARS) }] : [], result: null }
  }
  if (!o || typeof o !== 'object') return none
  const sub = typeof o.parent_tool_use_id === 'string' && o.parent_tool_use_id !== ''
  const events: ClaudeEvent[] = []
  switch (o.type) {
    case 'result':
      return { events, result: parseResult(o) }
    case 'system':
      if (o.subtype === 'init') {
        if (typeof o.cwd === 'string') state.cwd = o.cwd
        const parts = [`Claude Code ${o.claude_code_version ?? ''}`.trim(), o.model, o.permissionMode, typeof o.cwd === 'string' ? `in ${o.cwd}` : null]
        events.push({ kind: 'init', text: parts.filter(Boolean).join(' · ') })
      } else if (o.subtype === 'compact_boundary') {
        events.push({ kind: 'note', text: 'Context was compacted.' })
      } else if (o.subtype === 'api_retry') {
        events.push({ kind: 'note', text: `API retry${o.attempt ? ` ${o.attempt}` : ''}${o.error ? `: ${oneLine(o.error, 200)}` : ''}` })
      }
      break
    case 'assistant': {
      const content: any[] = Array.isArray(o.message?.content) ? o.message.content : []
      for (const c of content) {
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
          events.push({ kind: 'text', text: cut(c.text.trim(), TEXT_CHARS), sub })
        } else if (c?.type === 'tool_use' && typeof c.name === 'string') {
          if (typeof c.id === 'string') state.tools.set(c.id, c.name)
          const summary = summarizeToolUse(c.name, c.input, state.cwd)
          events.push({ kind: 'tool', text: summary ? `${c.name}: ${summary}` : c.name, sub })
        }
      }
      break
    }
    case 'user': {
      const content: any[] = Array.isArray(o.message?.content) ? o.message.content : []
      for (const c of content) {
        if (c?.type !== 'tool_result' || c.is_error !== true) continue
        const name = (typeof c.tool_use_id === 'string' && state.tools.get(c.tool_use_id)) || 'Tool'
        events.push({ kind: 'error', text: `${name} failed: ${oneLine(toolResultText(c.content), ERROR_CHARS)}`, sub })
      }
      break
    }
  }
  return { events, result: null }
}

// Events from line offset on (or from the last tail lines), as many as fit into one reply. The result comes along on
// every page once it exists.
export function claudeEvents(jobs: JobManager, params: { jobId: string; offset?: number; tail?: number }): ClaudeEventsResult {
  let offset = Math.max(0, Number(params.offset) | 0)
  if (params.offset === undefined && typeof params.tail === 'number' && params.tail > 0) {
    offset = Math.max(0, jobs.rawLines(params.jobId, 0, 0, 0).total - Math.floor(params.tail))
  }
  const page = jobs.rawLines(params.jobId, offset, PAGE_LINES, MAX_EVENT_LINE_BYTES)
  // The line Claude Code is still writing is read on the next call.
  const pending = page.job.status === 'running' && page.partialLast ? 1 : 0
  const usable = page.to === page.total ? page.lines.length - pending : page.lines.length

  const state: ParseState = { cwd: page.job.cwd, tools: new Map() }
  const events: ClaudeEvent[] = []
  let used = 0
  let consumed = 0
  let result: ClaudeResult | null = null
  for (let i = 0; i < usable; i++) {
    const parsed = parseLine(page.lines[i]!, state)
    const size = parsed.events.reduce((n, e) => n + e.text.length + 4, 0)
    if (events.length > 0 && used + size > PAGE_CHARS) break
    events.push(...parsed.events)
    if (parsed.result) result = parsed.result
    used += size
    consumed = i + 1
  }

  // The result is the last JSON line: look for it at the end as well.
  if (!result && page.total > 0) {
    const tail = jobs.rawLines(params.jobId, Math.max(0, page.total - 5), 5, MAX_EVENT_LINE_BYTES)
    for (const line of tail.lines.toReversed()) {
      if (!line?.includes('"result"')) continue
      const parsed = parseLine(line, state)
      if (parsed.result) {
        result = parsed.result
        break
      }
    }
  }

  const toLine = page.from + consumed
  return { job: page.job, events, fromLine: page.from, toLine, totalLines: page.total - pending, hasMore: toLine < page.total - pending, result }
}

export async function claudeInfo(): Promise<ClaudeInfo> {
  return detectClaude(true)
}
