// Interactive sessions via tmux. Sessions Claude starts are named mcp-… so that they do not collide with the user's own
// tmux sessions. tmux runs on the normal socket: on the device you can watch with `tmux attach -t mcp-…`.
// The user's own sessions can be read and typed into as well (by their exact name), but not started or killed.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync, readSync, closeSync, rmSync, statSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { home, resolveUserPath, stateDir } from './paths.ts'
import { DaemonError, type SessionInfo, type SessionScreen, type SessionStartResult, type SessionWaitInfo } from './protocol.ts'
import { cleanPaneOutput, markHighlights } from './screen.ts'

export const SESSION_PREFIX = 'mcp-'
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/
// Window and pane after the session name: "main:2" or "main:editor.1".
const WINDOW_RE = /^[A-Za-z0-9_-]{1,48}(?:\.\d{1,3})?$/
// Special keys in tmux notation, optionally with modifiers (C-c, M-x, S-Tab …).
const KEY_RE =
  /^(?:[CMS]-)*(?:[A-Za-z0-9]|Enter|Escape|Tab|BTab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|Insert|Delete|IC|DC|F(?:[1-9]|1[0-2]))$/
const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'ash', 'nu', 'elvish', 'xonsh', 'login'])
const MAX_SCREEN_CHARS = 100_000
const MAX_SCROLLBACK = 10_000
const MAX_WAIT_MS = 10_000
const DEFAULT_WAIT_MS = 500
const MAX_LONG_WAIT_MS = 600_000
const DEFAULT_LONG_WAIT_MS = 60_000
const DEFAULT_QUIET_MS = 1500
const POLL_MS = 250
// tmux passes a command to its server in one message of at most 16 KB; longer text goes in parts.
const SEND_CHUNK_CHARS = 2000
// New output kept for matching wait_for, from the end.
const MAX_PIPE_CHARS = 1024 * 1024
// After this long without the program in front, a shell in front counts as "command done".
const SHELL_GRACE_MS = 1000
// This much scrollback is read along automatically by session_read for finished commands.
const DEAD_SCROLLBACK = 1000

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(v)))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// For tests: a separate tmux socket and no systemd-run.
const socketArgs = () => (process.env.DEVICE_MCP_TMUX_SOCKET ? ['-L', process.env.DEVICE_MCP_TMUX_SOCKET] : [])

function tmuxEnv() {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('DEVICE_MCP_') && key !== 'TMUX' && key !== 'TMUX_PANE') env[key] = value
  }
  return env
}

function run(cmd: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: tmuxEnv() })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

async function tmux(args: string[], input?: string): Promise<RunResult> {
  try {
    return await run('tmux', [...socketArgs(), ...args], input)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DaemonError(
        process.platform === 'darwin'
          ? 'tmux is not installed on this device. Install it, e.g. with run_command: brew install tmux (needs Homebrew).'
          : 'tmux is not installed on this device. Install it, e.g. with run_command: sudo apt install -y tmux (Debian/Ubuntu/Raspberry Pi OS) or sudo dnf install -y tmux (Fedora).',
        'TMUX_MISSING',
      )
    }
    throw err
  }
}

async function tmuxOk(args: string[], input?: string) {
  const res = await tmux(args, input)
  if (res.code !== 0) throw new DaemonError(`tmux ${args[0]} failed: ${res.stderr.trim() || `exit ${res.code}`}`, 'TMUX_ERROR')
  return res
}

const noServer = (stderr: string) => /no server running|error connecting|No such file or directory/i.test(stderr)

// Accepts "build" and "mcp-build", always returns "mcp-build". For sessions Claude starts.
export function sessionName(input: string) {
  if (typeof input !== 'string') throw new DaemonError('No session name given.', 'BAD_REQUEST')
  const raw = input.trim()
  const rest = raw.startsWith(SESSION_PREFIX) ? raw.slice(SESSION_PREFIX.length) : raw
  if (!NAME_RE.test(rest)) throw new DaemonError(`Invalid session name "${input}". Allowed are letters, digits, - and _ (at most 48 characters).`, 'BAD_REQUEST')
  return SESSION_PREFIX + rest
}

async function exists(name: string) {
  const res = await tmux(['has-session', '-t', `=${name}`])
  return res.code === 0
}

export interface ResolvedSession {
  name: string
  // tmux target: "=name:" is the active pane of the current window, "=name:2.1" a specific one.
  target: string
  own: boolean
}

// "build" → mcp-build if it exists, otherwise the user's own session "build". "main:2" or "main:2.1" picks window and
// pane (with "." only for a pane). allowOwn=false: only mcp- sessions (session_kill).
export async function resolveSession(input: string, allowOwn = true): Promise<ResolvedSession> {
  if (typeof input !== 'string' || !input.trim()) throw new DaemonError('No session name given.', 'BAD_REQUEST')
  const raw = input.trim()
  const colon = raw.indexOf(':')
  const base = colon === -1 ? raw : raw.slice(0, colon)
  const window = colon === -1 ? '' : raw.slice(colon + 1)
  if (window && !WINDOW_RE.test(window)) throw new DaemonError(`Invalid window "${window}". Use e.g. "main:2" or "main:2.1".`, 'BAD_REQUEST')
  if (!base || base.length > 100 || /[\x00-\x1f\x7f.]/.test(base)) throw new DaemonError(`Invalid session name "${input}".`, 'BAD_REQUEST')
  const target = (name: string) => `=${name}:${window}`

  const rest = base.startsWith(SESSION_PREFIX) ? base.slice(SESSION_PREFIX.length) : base
  if (NAME_RE.test(rest) && (await exists(SESSION_PREFIX + rest))) return { name: SESSION_PREFIX + rest, target: target(SESSION_PREFIX + rest), own: false }
  if (allowOwn && !base.startsWith(SESSION_PREFIX) && (await exists(base))) return { name: base, target: target(base), own: true }

  const all = await sessionList({ all: allowOwn })
  const names = all.map((s) => s.name)
  const hint = names.length ? `Existing: ${names.join(', ')}.` : allowOwn ? 'No tmux session is running.' : 'No mcp session is running.'
  const ownNote = !allowOwn && !base.startsWith(SESSION_PREFIX) && (await exists(base)) ? ` "${base}" is one of the user's own sessions, which this does not touch.` : ''
  throw new DaemonError(`No session ${base.startsWith(SESSION_PREFIX) || allowOwn ? base : SESSION_PREFIX + rest}.${ownNote} ${hint}`, 'NOT_FOUND')
}

// systemd-run --user --scope puts the tmux server into its own scope unit. Otherwise it would belong to the cgroup of the
// daemon service, and systemd (KillMode=control-group) would end it too on every restart of the daemon.
let scopeAvailable: boolean | null = null
async function canUseScope() {
  if (process.env.DEVICE_MCP_TMUX_NO_SCOPE === '1' || process.platform !== 'linux') return false
  if (scopeAvailable === null) {
    try {
      scopeAvailable = (await run('systemd-run', ['--version'])).code === 0
    } catch {
      scopeAvailable = false
    }
  }
  return scopeAvailable
}

export async function sessionStart(params: { name?: string; cwd?: string; command?: string; cols?: number; rows?: number }): Promise<SessionStartResult> {
  const name = params.name ? sessionName(params.name) : `${SESSION_PREFIX}${randomBytes(3).toString('hex')}`
  if (await exists(name)) throw new DaemonError(`Session ${name} already exists. Pick another name or run session_kill first.`, 'CONFLICT')

  const cwd = params.cwd ? resolveUserPath(params.cwd) : home()
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {
    throw new DaemonError(`Working directory ${cwd} does not exist.`, 'NOT_FOUND')
  }
  if (!isDir) throw new DaemonError(`${cwd} is not a directory.`, 'BAD_REQUEST')

  const cols = clamp(params.cols ?? 200, 20, 500)
  const rows = clamp(params.rows ?? 50, 5, 200)
  const target = `=${name}:`
  // Without command, tmux starts the user's default shell as a login shell.
  const args = ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', cwd]
  if (params.command) {
    if (typeof params.command !== 'string') throw new DaemonError('command must be a string.', 'BAD_REQUEST')
    // After the command ends the screen should stay, so that the last output remains readable.
    // remain-on-exit must be set before the command runs: first a waiting placeholder (cat),
    // then the option, then respawn-pane replaces the placeholder with the actual command.
    args.push('cat', ';', 'set-option', '-t', target, 'remain-on-exit', 'on', ';', 'respawn-pane', '-k', '-t', target, '-c', cwd, params.command)
  }

  let detachedFromDaemon = false
  let res: RunResult | null = null
  if (await canUseScope()) {
    const unit = `device-mcp-tmux-${name.slice(SESSION_PREFIX.length)}-${randomBytes(2).toString('hex')}`
    res = await run('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, 'tmux', ...socketArgs(), ...args]).catch(() => null)
    if (res?.code === 0) detachedFromDaemon = true
    // Without a user bus (e.g. daemon started by hand), start the normal way.
    else if (res && !(await exists(name))) res = null
  }
  if (!res) res = await tmux(args)
  // macOS: the tmux server detaches into its own session, and when the daemon restarts launchd
  // only ends the daemon's process group. So the session survives it even without systemd-run.
  if (process.platform === 'darwin') detachedFromDaemon = true
  if (res.code !== 0 && !(await exists(name))) {
    throw new DaemonError(`tmux could not start the session: ${res.stderr.trim() || `exit ${res.code}`}`, 'TMUX_ERROR')
  }
  return { name, cwd, cols, rows, detachedFromDaemon }
}

// --- reading -----------------------------------------------------------------------------------------------------

interface PaneState {
  dead: boolean
  exitStatus: number | null
  cursorX: number
  cursorY: number
  alternate: boolean
  piped: boolean
  command: string
}

async function paneState(target: string): Promise<PaneState> {
  // Separator |, because some tmux versions replace tabs in formats with _. The command comes last.
  const res = await tmuxOk(['display-message', '-p', '-t', target, '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{alternate_on}|#{pane_pipe}|#{pane_current_command}'])
  const [dead, status, x, y, alt, pipe, ...rest] = res.stdout.replace(/\n$/, '').split('|')
  return {
    dead: dead === '1',
    exitStatus: dead === '1' && status !== '' && status !== undefined ? Number(status) : null,
    cursorX: Number(x) || 0,
    cursorY: Number(y) || 0,
    alternate: alt === '1',
    piped: pipe === '1',
    command: rest.join('|'),
  }
}

async function capture(target: string, opts: { scrollback?: number; styles?: boolean } = {}) {
  // -p: to stdout, -J: join wrapped lines. Without -e no colour codes come along.
  const args = ['capture-pane', '-p', '-J', '-t', target]
  if (opts.styles) args.push('-e')
  if (opts.scrollback && opts.scrollback > 0) args.push('-S', `-${opts.scrollback}`)
  const res = await tmuxOk(args)
  return opts.styles ? markHighlights(res.stdout) : res.stdout
}

async function readScreen(s: ResolvedSession, params: { scrollback_lines?: number; highlight?: boolean }): Promise<SessionScreen> {
  const state = await paneState(s.target)
  // Once the command has ended, tmux moves the last output into the scrollback. Then read the scrollback as well.
  const scrollback = clamp(Math.max(params.scrollback_lines ?? 0, state.dead ? DEAD_SCROLLBACK : 0), 0, MAX_SCROLLBACK)
  let text = (await capture(s.target, { scrollback, styles: params.highlight === true })).replace(/\s+$/, '')
  if (state.dead) text = text.replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n')
  if (text.length > MAX_SCREEN_CHARS) text = `[… truncated, showing the end]\n${text.slice(-MAX_SCREEN_CHARS)}`
  return {
    name: s.target.slice(1).replace(/:$/, ''),
    text,
    lines: text ? text.split('\n').length : 0,
    dead: state.dead,
    exitStatus: state.exitStatus,
    command: state.command,
    cursor: { row: state.cursorY + 1, col: state.cursorX + 1 },
    alternateScreen: state.alternate,
    own: s.own,
    highlighted: params.highlight === true,
  }
}

export async function sessionRead(params: { session: string; scrollback_lines?: number; highlight?: boolean }): Promise<SessionScreen> {
  return readScreen(await resolveSession(params.session), params)
}

// --- input -------------------------------------------------------------------------------------------------------

function chunks(value: string, size: number) {
  const out: string[] = []
  let i = 0
  while (i < value.length) {
    let end = Math.min(value.length, i + size)
    // Do not split a surrogate pair.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
    out.push(value.slice(i, end))
    i = end
  }
  return out
}

async function typeText(target: string, text: string, paste: boolean) {
  if (paste) {
    // Through a buffer: arrives as one block, with bracketed paste if the program asked for it (editors, REPLs).
    const buffer = `mcp-paste-${randomBytes(3).toString('hex')}`
    await tmuxOk(['load-buffer', '-b', buffer, '-'], text)
    await tmuxOk(['paste-buffer', '-p', '-d', '-b', buffer, '-t', target])
    return
  }
  for (const part of chunks(text, SEND_CHUNK_CHARS)) await tmuxOk(['send-keys', '-t', target, '-l', '--', part])
}

// pipe-pane copies everything the program writes from now on into a file. That is how wait_for sees only new output.
class OutputTap {
  private offset = 0
  private buffer = ''

  private constructor(
    private target: string,
    private file: string,
  ) {}

  static async open(target: string): Promise<OutputTap | null> {
    const dir = path.join(stateDir(), 'sessions')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${randomBytes(6).toString('hex')}.out`)
    closeSync(openSync(file, 'w', 0o600))
    // -o: only if no pipe is open yet. The user's own pipe-pane stays untouched.
    const res = await tmux(['pipe-pane', '-o', '-t', target, `cat >> '${file.replace(/'/g, `'\\''`)}'`])
    if (res.code !== 0 || !(await paneState(target)).piped) {
      rmSync(file, { force: true })
      return null
    }
    return new OutputTap(target, file)
  }

  read() {
    const fd = openSync(this.file, 'r')
    try {
      const buf = Buffer.allocUnsafe(256 * 1024)
      for (let n = readSync(fd, buf, 0, buf.length, this.offset); n > 0; n = readSync(fd, buf, 0, buf.length, this.offset)) {
        this.offset += n
        this.buffer += buf.toString('utf8', 0, n)
      }
    } finally {
      closeSync(fd)
    }
    if (this.buffer.length > MAX_PIPE_CHARS * 2) this.buffer = this.buffer.slice(-MAX_PIPE_CHARS)
    return cleanPaneOutput(this.buffer)
  }

  async close() {
    await tmux(['pipe-pane', '-t', this.target]).catch(() => null)
    rmSync(this.file, { force: true })
  }
}

// Leftovers of a daemon that stopped during a wait.
export function cleanupSessionFiles() {
  const dir = path.join(stateDir(), 'sessions')
  try {
    for (const file of readdirSync(dir)) if (file.endsWith('.out')) rmSync(path.join(dir, file), { force: true })
  } catch {
    // No directory yet.
  }
}

function compilePattern(pattern: string | undefined, ignoreCase: boolean | undefined) {
  if (pattern === undefined || pattern === '') return null
  if (typeof pattern !== 'string' || pattern.length > 1000) throw new DaemonError('The pattern must be a string of at most 1000 characters.', 'BAD_REQUEST')
  try {
    return new RegExp(pattern, ignoreCase ? 'im' : 'm')
  } catch (err) {
    throw new DaemonError(`Invalid regular expression: ${(err as Error).message}`, 'BAD_REQUEST')
  }
}

export interface SendParams {
  session: string
  text?: string
  keys?: string[]
  paste?: boolean
  wait_ms?: number
  wait_for?: string
  ignore_case?: boolean
  timeout_ms?: number
  highlight?: boolean
}

export async function sessionSend(params: SendParams): Promise<SessionScreen | { name: string; screen: null }> {
  const keys = params.keys ?? []
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) throw new DaemonError('keys must be a list of key names.', 'BAD_REQUEST')
  const bad = keys.filter((k) => !KEY_RE.test(k))
  if (bad.length) {
    throw new DaemonError(`Unknown key(s): ${bad.join(', ')}. Allowed are e.g. Enter, Tab, Escape, BSpace, Up, Down, Left, Right, C-c, C-d, M-x, F1–F12.`, 'BAD_REQUEST')
  }
  if (!params.text && keys.length === 0) throw new DaemonError('Nothing to send: give text or keys.', 'BAD_REQUEST')
  const pattern = compilePattern(params.wait_for, params.ignore_case)
  const s = await resolveSession(params.session)

  // For wait_for the tap must be open before the input, otherwise a fast answer is missed.
  const tap = pattern ? await OutputTap.open(s.target) : null
  const before = pattern && !tap ? await capture(s.target) : null
  const started = Date.now()
  try {
    // First the text (literally), then the special keys. That way "command + Enter" works in a single call.
    if (params.text) await typeText(s.target, params.text, params.paste === true)
    if (keys.length) await tmuxOk(['send-keys', '-t', s.target, ...keys])

    if (pattern) {
      const timeout = clamp(params.timeout_ms ?? DEFAULT_LONG_WAIT_MS, 0, MAX_LONG_WAIT_MS)
      let wait: SessionWaitInfo = { reason: 'timeout', waitedMs: 0, match: null, outputMatched: tap !== null }
      for (;;) {
        const haystack = tap ? tap.read() : await capture(s.target)
        // Without a tap (pipe already in use): the screen, once it differs from before the input.
        const match = tap || haystack !== before ? pattern.exec(haystack) : null
        if (match) {
          wait = { reason: 'pattern', waitedMs: Date.now() - started, match: match[0].slice(0, 500), outputMatched: tap !== null }
          break
        }
        const state = await paneState(s.target)
        if (state.dead) {
          wait = { reason: 'exited', waitedMs: Date.now() - started, match: null, outputMatched: tap !== null }
          break
        }
        if (Date.now() - started >= timeout) {
          wait = { reason: 'timeout', waitedMs: Date.now() - started, match: null, outputMatched: tap !== null }
          break
        }
        await sleep(POLL_MS)
      }
      return { ...(await readScreen(s, { highlight: params.highlight })), wait }
    }
  } finally {
    await tap?.close()
  }

  const wait = clamp(params.wait_ms ?? DEFAULT_WAIT_MS, 0, MAX_WAIT_MS)
  if (wait === 0) return { name: s.target.slice(1).replace(/:$/, ''), screen: null }
  await sleep(wait)
  return readScreen(s, { highlight: params.highlight })
}

export interface WaitParams {
  session: string
  pattern?: string
  ignore_case?: boolean
  quiet_ms?: number
  until_shell?: boolean
  timeout_ms?: number
  highlight?: boolean
}

// Waits for a state of the screen: a pattern on it, a pause in output, the shell back in front, or the program's end.
export async function sessionWait(params: WaitParams): Promise<SessionScreen> {
  const pattern = compilePattern(params.pattern, params.ignore_case)
  const s = await resolveSession(params.session)
  const timeout = clamp(params.timeout_ms ?? DEFAULT_LONG_WAIT_MS, 0, MAX_LONG_WAIT_MS)
  const quietMs = params.quiet_ms !== undefined ? clamp(params.quiet_ms, 100, MAX_LONG_WAIT_MS) : pattern || params.until_shell ? null : DEFAULT_QUIET_MS
  const started = Date.now()
  let last: string | null = null
  let lastChange = started
  let sawProgram = false
  let wait: SessionWaitInfo | null = null

  while (!wait) {
    const state = await paneState(s.target)
    const screen = await capture(s.target)
    const now = Date.now()
    if (screen !== last) {
      last = screen
      lastChange = now
    }
    const match = pattern?.exec(screen)
    if (match) wait = { reason: 'pattern', waitedMs: now - started, match: match[0].slice(0, 500), outputMatched: false }
    else if (state.dead) wait = { reason: 'exited', waitedMs: now - started, match: null, outputMatched: false }
    else if (params.until_shell && SHELLS.has(state.command.replace(/^-/, '')) && (sawProgram || now - started >= SHELL_GRACE_MS)) {
      wait = { reason: 'shell', waitedMs: now - started, match: null, outputMatched: false }
    } else if (quietMs !== null && now - lastChange >= quietMs) wait = { reason: 'quiet', waitedMs: now - started, match: null, outputMatched: false }
    else if (now - started >= timeout) wait = { reason: 'timeout', waitedMs: now - started, match: null, outputMatched: false }
    if (!SHELLS.has(state.command.replace(/^-/, ''))) sawProgram = true
    if (!wait) await sleep(POLL_MS)
  }
  return { ...(await readScreen(s, { highlight: params.highlight })), wait }
}

// --- list and kill -----------------------------------------------------------------------------------------------

export async function sessionList(params: { all?: boolean } = {}): Promise<SessionInfo[]> {
  const res = await tmux([
    'list-sessions',
    '-F',
    '#{session_name}|#{session_created}|#{pane_dead}|#{pane_dead_status}|#{window_width}|#{window_height}|#{session_attached}|#{session_windows}|#{pane_current_command}',
  ])
  if (res.code !== 0) {
    if (noServer(res.stderr)) return []
    throw new DaemonError(`tmux list-sessions failed: ${res.stderr.trim()}`, 'TMUX_ERROR')
  }
  return res.stdout
    .split('\n')
    .filter((line) => line && (params.all || line.startsWith(SESSION_PREFIX)))
    .map((line) => {
      // The command comes last, in case it contains a | itself.
      const [name = '', created = '0', dead = '0', status = '', width = '0', height = '0', attached = '0', windows = '1', ...rest] = line.split('|')
      return {
        name,
        created: new Date(Number(created) * 1000).toISOString(),
        command: rest.join('|'),
        dead: dead === '1',
        exitStatus: dead === '1' && status !== '' ? Number(status) : null,
        width: Number(width),
        height: Number(height),
        attached: Number(attached) > 0,
        windows: Number(windows) || 1,
        own: !name.startsWith(SESSION_PREFIX),
      }
    })
}

export async function sessionKill(params: { session: string }) {
  const s = await resolveSession(params.session, false)
  await tmuxOk(['kill-session', '-t', `=${s.name}`])
  return { name: s.name }
}
