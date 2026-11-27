import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonError, type SessionScreen } from './protocol.ts'

// Own tmux socket so the tests never touch real sessions; no systemd-run. Own state dir for pipe-pane files.
process.env.DEVICE_MCP_TMUX_SOCKET = `device-mcp-test-${process.pid}`
process.env.DEVICE_MCP_TMUX_NO_SCOPE = '1'
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'dmcp-sessions-'))
process.env.DEVICE_MCP_STATE_DIR = stateDir
const { sessionKill, sessionList, sessionName, sessionRead, sessionSend, sessionStart, sessionWait } = await import('./sessions.ts')

const hasTmux = spawnSync('tmux', ['-V']).status === 0
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// A shell without profile so the output is predictable.
const SHELL = "env PS1='$ ' bash --norc --noprofile -i"

afterAll(() => {
  if (hasTmux) spawnSync('tmux', ['-L', process.env.DEVICE_MCP_TMUX_SOCKET!, 'kill-server'])
  rmSync(stateDir, { recursive: true, force: true })
})

const tmuxRaw = (...args: string[]) => spawnSync('tmux', ['-L', process.env.DEVICE_MCP_TMUX_SOCKET!, ...args])
const screenOf = (res: SessionScreen | { name: string; screen: null }) => {
  if (!('text' in res)) throw new Error('expected a screen')
  return res
}

async function expectError(promise: Promise<unknown>, code: string) {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(DaemonError)
    expect((err as DaemonError).code).toBe(code)
    return (err as DaemonError).message
  }
  throw new Error('Expected an error, got none')
}

describe('session names', () => {
  test('prefix mcp- is added, never twice', () => {
    expect(sessionName('build')).toBe('mcp-build')
    expect(sessionName('mcp-build')).toBe('mcp-build')
  })
  test('invalid names are rejected', () => {
    expect(() => sessionName('a:b')).toThrow(DaemonError)
    expect(() => sessionName('with spaces')).toThrow(DaemonError)
  })
})

describe.skipIf(!hasTmux)('tmux sessions', () => {
  test('start without a name assigns mcp-…', async () => {
    const res = await sessionStart({ command: SHELL })
    expect(res.name).toMatch(/^mcp-[0-9a-f]{6}$/)
    // Without systemd-run (disabled in the test) only on macOS: there tmux survives the daemon restart on its own.
    expect(res.detachedFromDaemon).toBe(process.platform === 'darwin')
    await sessionKill({ session: res.name })
  })

  test('send with text and Enter returns the screen right away', async () => {
    await sessionStart({ name: 'shell', command: SHELL, cols: 100, rows: 20 })
    const screen = await sessionSend({ session: 'shell', text: 'echo result-$((40+2))', keys: ['Enter'], wait_ms: 600 })
    if (!('text' in screen)) throw new Error('expected a screen')
    expect(screen.text).toContain('result-42')
    // No colour codes and no empty lines at the end.
    expect(screen.text).not.toContain('\x1b[')
    expect(screen.text.endsWith('\n')).toBe(false)
  })

  test('wait_ms 0 returns no screen', async () => {
    const res = await sessionSend({ session: 'mcp-shell', text: 'true', keys: ['Enter'], wait_ms: 0 })
    expect('screen' in res && res.screen === null).toBe(true)
  })

  test('C-c interrupts a running command', async () => {
    await sessionSend({ session: 'shell', text: 'sleep 30', keys: ['Enter'], wait_ms: 200 })
    await sessionSend({ session: 'shell', keys: ['C-c'], wait_ms: 200 })
    const screen = await sessionSend({ session: 'shell', text: 'echo back-again', keys: ['Enter'], wait_ms: 500 })
    if (!('text' in screen)) throw new Error('expected a screen')
    expect(screen.text).toContain('back-again')
  })

  test('read with scrollback returns older lines', async () => {
    await sessionSend({ session: 'shell', text: 'seq 1 300', keys: ['Enter'], wait_ms: 600 })
    const visible = await sessionRead({ session: 'shell' })
    expect(visible.text).not.toMatch(/^1$/m)
    const withHistory = await sessionRead({ session: 'shell', scrollback_lines: 1000 })
    expect(withHistory.text).toMatch(/^1$/m)
    expect(withHistory.text).toMatch(/^300$/m)
  })

  test('unknown key is rejected', async () => {
    await expectError(sessionSend({ session: 'shell', keys: ['Hyperspace'] }), 'BAD_REQUEST')
    await expectError(sessionSend({ session: 'shell' }), 'BAD_REQUEST')
  })

  test('list shows only mcp sessions', async () => {
    spawnSync('tmux', ['-L', process.env.DEVICE_MCP_TMUX_SOCKET!, 'new-session', '-d', '-s', 'my-own'])
    const names = (await sessionList()).map((s) => s.name)
    expect(names).toContain('mcp-shell')
    expect(names).not.toContain('my-own')
  })

  test('finished command stays readable, with exit code', async () => {
    await sessionStart({ name: 'kurz', command: "sh -c 'echo done; exit 3'" })
    await sleep(400)
    const screen = await sessionRead({ session: 'kurz' })
    expect(screen.text).toContain('done')
    expect(screen.dead).toBe(true)
    expect(screen.exitStatus).toBe(3)
  })

  test('duplicate name gives CONFLICT', async () => {
    await expectError(sessionStart({ name: 'shell', command: SHELL }), 'CONFLICT')
  })

  test('kill removes the session, then NOT_FOUND', async () => {
    await sessionKill({ session: 'shell' })
    await sessionKill({ session: 'kurz' })
    const names = (await sessionList()).map((s) => s.name)
    expect(names).not.toContain('mcp-shell')
    await expectError(sessionRead({ session: 'shell' }), 'NOT_FOUND')
  })
})

describe.skipIf(!hasTmux)('waiting, own sessions and more input', () => {
  test('until_shell returns once the typed command is done', async () => {
    await sessionStart({ name: 'w', command: SHELL, cols: 120, rows: 30 })
    await sleep(300)
    await sessionSend({ session: 'w', text: 'sleep 1.2; echo waited-$((1+1))', keys: ['Enter'], wait_ms: 0 })
    const res = await sessionWait({ session: 'w', until_shell: true, timeout_ms: 10_000 })
    expect(res.wait?.reason).toBe('shell')
    expect(res.text).toContain('waited-2')
    expect(res.wait!.waitedMs).toBeGreaterThanOrEqual(900)
  })

  test('pattern on screen, quiet, timeout', async () => {
    await sessionSend({ session: 'w', text: 'sleep 0.6; echo ready-$((3*3))', keys: ['Enter'], wait_ms: 0 })
    const matched = await sessionWait({ session: 'w', pattern: 'ready-9', timeout_ms: 5000 })
    expect(matched.wait?.reason).toBe('pattern')
    expect(matched.wait?.match).toBe('ready-9')
    const quiet = await sessionWait({ session: 'w', quiet_ms: 300, timeout_ms: 5000 })
    expect(quiet.wait?.reason).toBe('quiet')
    const timeout = await sessionWait({ session: 'w', pattern: 'never-there', timeout_ms: 500 })
    expect(timeout.wait?.reason).toBe('timeout')
    await expectError(sessionWait({ session: 'w', pattern: '(' }), 'BAD_REQUEST')
  })

  test('wait_for only sees output that comes after the input', async () => {
    await sessionSend({ session: 'w', text: "printf '%s\\n' \"$((6*7))-done\"", keys: ['Enter'], wait_ms: 400 })
    expect((await sessionRead({ session: 'w' })).text).toContain('42-done')
    // "42-done" is already on screen; wait_for must wait for the new one.
    const res = screenOf(await sessionSend({ session: 'w', text: "sleep 1; printf '%s\\n' \"$((6*7))-done\"", keys: ['Enter'], wait_for: '42-done', timeout_ms: 8000 }))
    expect(res.wait?.reason).toBe('pattern')
    expect(res.wait?.outputMatched).toBe(true)
    expect(res.wait!.waitedMs).toBeGreaterThanOrEqual(900)
    // The tap is closed again afterwards.
    expect(tmuxRaw('display-message', '-p', '-t', '=mcp-w:', '#{pane_pipe}').stdout.toString().trim()).toBe('0')
  })

  test('cursor, highlight and the alternate screen', async () => {
    await sessionSend({ session: 'w', text: 'clear', keys: ['Enter'], wait_ms: 300 })
    const res = screenOf(await sessionSend({ session: 'w', text: "printf 'a \\033[7mSEL\\033[27m b\\n'", keys: ['Enter'], wait_ms: 400, highlight: true }))
    expect(res.text).toMatch(/^a ⟦SEL⟧ b$/m)
    expect(res.cursor!.row).toBeGreaterThanOrEqual(2)
    expect(res.alternateScreen).toBe(false)

    await sessionStart({ name: 'alt', command: 'less /etc/hosts' })
    await sleep(500)
    expect((await sessionRead({ session: 'alt' })).alternateScreen).toBe(true)
    await sessionKill({ session: 'alt' })
  })

  test('paste and long text arrive complete', async () => {
    await sessionStart({ name: 'cat', command: 'cat', cols: 200, rows: 40 })
    await sleep(300)
    const pasted = screenOf(await sessionSend({ session: 'cat', text: 'first-line\nsecond-line\n', paste: true, wait_ms: 300 }))
    expect(pasted.text).toContain('second-line')
    await sessionKill({ session: 'cat' })
    // More than tmux takes in one command (16 KB). A shell, because a tty line for cat holds at most 1024 bytes on macOS.
    const long = 'x'.repeat(20_000)
    await sessionSend({ session: 'w', text: 'clear', keys: ['Enter'], wait_ms: 300 })
    // Count what the shell received; the screen cannot show a line longer than itself completely.
    await sessionSend({ session: 'w', text: `printf %s ${long} | wc -c | sed 's/^ *//;s/$/-bytes/'`, keys: ['Enter'], wait_ms: 0 })
    const counted = await sessionWait({ session: 'w', pattern: '^\\d+-bytes$', timeout_ms: 10_000 })
    expect(counted.wait?.match).toBe('20000-bytes')
  })

  test("the user's own sessions can be read and typed into, but not killed", async () => {
    tmuxRaw('new-session', '-d', '-s', 'work', '-x', '100', '-y', '20', "env PS1='$ ' bash --norc --noprofile -i")
    await sleep(300)
    const all = await sessionList({ all: true })
    expect(all.find((s) => s.name === 'work')?.own).toBe(true)
    expect(all.find((s) => s.name === 'mcp-w')?.own).toBe(false)
    expect((await sessionList()).map((s) => s.name)).not.toContain('work')

    const res = screenOf(await sessionSend({ session: 'work', text: 'echo own-$((2+3))', keys: ['Enter'], wait_ms: 500 }))
    expect(res.own).toBe(true)
    expect(res.text).toContain('own-5')
    expect((await sessionRead({ session: 'work:0' })).text).toContain('own-5')
    const message = await expectError(sessionKill({ session: 'work' }), 'NOT_FOUND')
    expect(message).toContain("user's own")
    await expectError(sessionRead({ session: 'work:9' }), 'TMUX_ERROR')
    await sessionKill({ session: 'w' })
  })
})
