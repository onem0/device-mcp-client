// Interaktive Sessions über tmux. Jede Session heißt mcp-…, damit sie nicht mit eigenen tmux-Sessions kollidiert.
// tmux läuft auf dem normalen Socket: Auf dem Gerät kann man mit `tmux attach -t mcp-…` zuschauen.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { home, resolveUserPath } from './paths.ts'
import { DaemonError, type SessionInfo, type SessionScreen, type SessionStartResult } from './protocol.ts'

export const SESSION_PREFIX = 'mcp-'
const NAME_RE = /^[A-Za-z0-9_-]{1,48}$/
// Sondertasten in tmux-Schreibweise, optional mit Modifikatoren (C-c, M-x, S-Tab …).
const KEY_RE =
  /^(?:[CMS]-)*(?:[A-Za-z0-9]|Enter|Escape|Tab|BTab|BSpace|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|PPage|NPage|Insert|Delete|IC|DC|F(?:[1-9]|1[0-2]))$/
const MAX_SCREEN_CHARS = 100_000
const MAX_SCROLLBACK = 10_000
const MAX_WAIT_MS = 10_000
const DEFAULT_WAIT_MS = 500
// So viel Verlauf liest session_read bei beendeten Befehlen automatisch mit.
const DEAD_SCROLLBACK = 1000

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(v)))
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Für Tests: eigener tmux-Socket und kein systemd-run.
const socketArgs = () => (process.env.DEVICE_MCP_TMUX_SOCKET ? ['-L', process.env.DEVICE_MCP_TMUX_SOCKET] : [])

function tmuxEnv() {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('DEVICE_MCP_') && key !== 'TMUX' && key !== 'TMUX_PANE') env[key] = value
  }
  return env
}

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: tmuxEnv() })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function tmux(args: string[]): Promise<RunResult> {
  try {
    return await run('tmux', [...socketArgs(), ...args])
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

async function tmuxOk(args: string[]) {
  const res = await tmux(args)
  if (res.code !== 0) throw new DaemonError(`tmux ${args[0]} failed: ${res.stderr.trim() || `exit ${res.code}`}`, 'TMUX_ERROR')
  return res
}

const noServer = (stderr: string) => /no server running|error connecting|No such file or directory/i.test(stderr)

// Akzeptiert "build" und "mcp-build", liefert immer "mcp-build".
export function sessionName(input: string) {
  if (typeof input !== 'string') throw new DaemonError('No session name given.', 'BAD_REQUEST')
  const raw = input.trim()
  const rest = raw.startsWith(SESSION_PREFIX) ? raw.slice(SESSION_PREFIX.length) : raw
  if (!NAME_RE.test(rest)) throw new DaemonError(`Invalid session name "${input}". Allowed are letters, digits, - and _ (at most 48 characters).`, 'BAD_REQUEST')
  return SESSION_PREFIX + rest
}

// "=name" sucht exakt, ohne Präfix-Treffer auf ähnliche Namen.
const target = (name: string) => `=${name}:`

async function exists(name: string) {
  const res = await tmux(['has-session', '-t', `=${name}`])
  return res.code === 0
}

async function mustExist(name: string) {
  if (await exists(name)) return
  const names = (await sessionList()).map((s) => s.name)
  throw new DaemonError(`No session ${name}. ${names.length ? `Existing: ${names.join(', ')}.` : 'No mcp session is running.'}`, 'NOT_FOUND')
}

// systemd-run --user --scope legt den tmux-Server in eine eigene Scope-Unit. Sonst gehörte er zur Cgroup des
// Daemon-Service, und systemd würde ihn (KillMode=control-group) bei jedem Neustart des Daemons mit beenden.
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
  // Ohne command startet tmux die Standard-Shell des Benutzers als Login-Shell.
  const args = ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows), '-c', cwd]
  if (params.command) {
    if (typeof params.command !== 'string') throw new DaemonError('command must be a string.', 'BAD_REQUEST')
    // Nach dem Ende des Befehls soll der Bildschirm stehen bleiben, damit die letzte Ausgabe lesbar ist.
    // remain-on-exit muss gesetzt sein, bevor der Befehl läuft: erst ein wartender Platzhalter (cat),
    // dann die Option, dann ersetzt respawn-pane den Platzhalter durch den eigentlichen Befehl.
    args.push('cat', ';', 'set-option', '-t', target(name), 'remain-on-exit', 'on', ';', 'respawn-pane', '-k', '-t', target(name), '-c', cwd, params.command)
  }

  let detachedFromDaemon = false
  let res: RunResult | null = null
  if (await canUseScope()) {
    const unit = `device-mcp-tmux-${name.slice(SESSION_PREFIX.length)}-${randomBytes(2).toString('hex')}`
    res = await run('systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, 'tmux', ...socketArgs(), ...args]).catch(() => null)
    if (res?.code === 0) detachedFromDaemon = true
    // Ohne User-Bus (z. B. Daemon von Hand gestartet) ganz normal starten.
    else if (res && !(await exists(name))) res = null
  }
  if (!res) res = await tmux(args)
  // macOS: Der tmux-Server löst sich in eine eigene Sitzung ab, und launchd beendet beim Neustart
  // des Daemons nur dessen Prozessgruppe. Die Session übersteht ihn also auch ohne systemd-run.
  if (process.platform === 'darwin') detachedFromDaemon = true
  if (res.code !== 0 && !(await exists(name))) {
    throw new DaemonError(`tmux could not start the session: ${res.stderr.trim() || `exit ${res.code}`}`, 'TMUX_ERROR')
  }
  return { name, cwd, cols, rows, detachedFromDaemon }
}

export async function sessionSend(params: { session: string; text?: string; keys?: string[]; wait_ms?: number }): Promise<SessionScreen | { name: string; screen: null }> {
  const name = sessionName(params.session)
  const keys = params.keys ?? []
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) throw new DaemonError('keys must be a list of key names.', 'BAD_REQUEST')
  const bad = keys.filter((k) => !KEY_RE.test(k))
  if (bad.length) {
    throw new DaemonError(`Unknown key(s): ${bad.join(', ')}. Allowed are e.g. Enter, Tab, Escape, BSpace, Up, Down, Left, Right, C-c, C-d, M-x, F1–F12.`, 'BAD_REQUEST')
  }
  if (!params.text && keys.length === 0) throw new DaemonError('Nothing to send: give text or keys.', 'BAD_REQUEST')
  await mustExist(name)

  // Erst der Text (wörtlich, -l), dann die Sondertasten. So geht "Befehl + Enter" in einem Aufruf.
  if (params.text) await tmuxOk(['send-keys', '-t', target(name), '-l', '--', params.text])
  if (keys.length) await tmuxOk(['send-keys', '-t', target(name), ...keys])

  const wait = clamp(params.wait_ms ?? DEFAULT_WAIT_MS, 0, MAX_WAIT_MS)
  if (wait === 0) return { name, screen: null }
  await sleep(wait)
  return sessionRead({ session: name })
}

export async function sessionRead(params: { session: string; scrollback_lines?: number }): Promise<SessionScreen> {
  const name = sessionName(params.session)
  await mustExist(name)
  const info = await tmuxOk(['display-message', '-p', '-t', target(name), '#{pane_dead}|#{pane_dead_status}|#{pane_current_command}'])
  // Trenner |, weil manche tmux-Versionen Tabs in Formaten durch _ ersetzen.
  const [dead, status, ...rest] = info.stdout.trim().split('|')
  const command = rest.join('|')

  // Ist der Befehl beendet, schiebt tmux die letzte Ausgabe in den Verlauf. Dann den Verlauf mitlesen.
  const scrollback = clamp(Math.max(params.scrollback_lines ?? 0, dead === '1' ? DEAD_SCROLLBACK : 0), 0, MAX_SCROLLBACK)
  // -p: auf stdout, -J: umgebrochene Zeilen zusammenfügen. Ohne -e kommen keine Farbcodes mit.
  const args = ['capture-pane', '-p', '-J', '-t', target(name)]
  if (scrollback > 0) args.push('-S', `-${scrollback}`)
  const captured = await tmuxOk(args)

  let text = captured.stdout.replace(/\s+$/, '')
  if (dead === '1') text = text.replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n')
  if (text.length > MAX_SCREEN_CHARS) text = `[… truncated, showing the end]\n${text.slice(-MAX_SCREEN_CHARS)}`
  return {
    name,
    text,
    lines: text ? text.split('\n').length : 0,
    dead: dead === '1',
    exitStatus: dead === '1' && status !== '' && status !== undefined ? Number(status) : null,
    command: command ?? '',
  }
}

export async function sessionList(): Promise<SessionInfo[]> {
  const res = await tmux([
    'list-sessions',
    '-F',
    '#{session_name}|#{session_created}|#{pane_dead}|#{pane_dead_status}|#{window_width}|#{window_height}|#{session_attached}|#{pane_current_command}',
  ])
  if (res.code !== 0) {
    if (noServer(res.stderr)) return []
    throw new DaemonError(`tmux list-sessions failed: ${res.stderr.trim()}`, 'TMUX_ERROR')
  }
  return res.stdout
    .split('\n')
    .filter((line) => line.startsWith(SESSION_PREFIX))
    .map((line) => {
      // Der Befehl steht zuletzt, falls er selbst ein | enthält.
      const [name = '', created = '0', dead = '0', status = '', width = '0', height = '0', attached = '0', ...rest] = line.split('|')
      const command = rest.join('|')
      return {
        name,
        created: new Date(Number(created) * 1000).toISOString(),
        command,
        dead: dead === '1',
        exitStatus: dead === '1' && status !== '' ? Number(status) : null,
        width: Number(width),
        height: Number(height),
        attached: Number(attached) > 0,
      }
    })
}

export async function sessionKill(params: { session: string }) {
  const name = sessionName(params.session)
  await mustExist(name)
  await tmuxOk(['kill-session', '-t', `=${name}`])
  return { name }
}
