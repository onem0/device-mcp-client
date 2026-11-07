import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { DaemonError } from './protocol.ts'

// Own tmux socket so the tests never touch real sessions; no systemd-run.
process.env.DEVICE_MCP_TMUX_SOCKET = `device-mcp-test-${process.pid}`
process.env.DEVICE_MCP_TMUX_NO_SCOPE = '1'
const { sessionKill, sessionList, sessionName, sessionRead, sessionSend, sessionStart } = await import('./sessions.ts')

const hasTmux = spawnSync('tmux', ['-V']).status === 0
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// A shell without profile so the output is predictable.
const SHELL = "env PS1='$ ' bash --norc --noprofile -i"

afterAll(() => {
  if (hasTmux) spawnSync('tmux', ['-L', process.env.DEVICE_MCP_TMUX_SOCKET!, 'kill-server'])
})

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
    expect(res.detachedFromDaemon).toBe(false)
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
