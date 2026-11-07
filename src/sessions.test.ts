import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { DaemonError } from './protocol.ts'

// Eigener tmux-Socket, damit die Tests keine echten Sessions berühren; ohne systemd-run.
process.env.DEVICE_MCP_TMUX_SOCKET = `device-mcp-test-${process.pid}`
process.env.DEVICE_MCP_TMUX_NO_SCOPE = '1'
const { sessionKill, sessionList, sessionName, sessionRead, sessionSend, sessionStart } = await import('./sessions.ts')

const hasTmux = spawnSync('tmux', ['-V']).status === 0
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// Eine Shell ohne Profil, damit die Ausgabe vorhersehbar ist.
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
  throw new Error('Fehler erwartet, aber keiner kam')
}

describe('Session-Namen', () => {
  test('Präfix mcp- wird ergänzt, nicht doppelt', () => {
    expect(sessionName('build')).toBe('mcp-build')
    expect(sessionName('mcp-build')).toBe('mcp-build')
  })
  test('ungültige Namen werden abgelehnt', () => {
    expect(() => sessionName('a:b')).toThrow(DaemonError)
    expect(() => sessionName('mit leerzeichen')).toThrow(DaemonError)
  })
})

describe.skipIf(!hasTmux)('tmux-Sessions', () => {
  test('start ohne Namen vergibt mcp-…', async () => {
    const res = await sessionStart({ command: SHELL })
    expect(res.name).toMatch(/^mcp-[0-9a-f]{6}$/)
    expect(res.detachedFromDaemon).toBe(false)
    await sessionKill({ session: res.name })
  })

  test('send mit Text und Enter, Bildschirm kommt direkt zurück', async () => {
    await sessionStart({ name: 'shell', command: SHELL, cols: 100, rows: 20 })
    const screen = await sessionSend({ session: 'shell', text: 'echo ergebnis-$((40+2))', keys: ['Enter'], wait_ms: 600 })
    if (!('text' in screen)) throw new Error('Bildschirm erwartet')
    expect(screen.text).toContain('ergebnis-42')
    // Keine Farbcodes und keine leeren Zeilen am Ende.
    expect(screen.text).not.toContain('\x1b[')
    expect(screen.text.endsWith('\n')).toBe(false)
  })

  test('wait_ms 0 liefert keinen Bildschirm', async () => {
    const res = await sessionSend({ session: 'mcp-shell', text: 'true', keys: ['Enter'], wait_ms: 0 })
    expect('screen' in res && res.screen === null).toBe(true)
  })

  test('C-c bricht einen laufenden Befehl ab', async () => {
    await sessionSend({ session: 'shell', text: 'sleep 30', keys: ['Enter'], wait_ms: 200 })
    await sessionSend({ session: 'shell', keys: ['C-c'], wait_ms: 200 })
    const screen = await sessionSend({ session: 'shell', text: 'echo wieder-da', keys: ['Enter'], wait_ms: 500 })
    if (!('text' in screen)) throw new Error('Bildschirm erwartet')
    expect(screen.text).toContain('wieder-da')
  })

  test('read mit Scrollback liefert ältere Zeilen', async () => {
    await sessionSend({ session: 'shell', text: 'seq 1 300', keys: ['Enter'], wait_ms: 600 })
    const visible = await sessionRead({ session: 'shell' })
    expect(visible.text).not.toMatch(/^1$/m)
    const withHistory = await sessionRead({ session: 'shell', scrollback_lines: 1000 })
    expect(withHistory.text).toMatch(/^1$/m)
    expect(withHistory.text).toMatch(/^300$/m)
  })

  test('unbekannte Taste wird abgelehnt', async () => {
    await expectError(sessionSend({ session: 'shell', keys: ['Hyperspace'] }), 'BAD_REQUEST')
    await expectError(sessionSend({ session: 'shell' }), 'BAD_REQUEST')
  })

  test('list zeigt nur mcp-Sessions', async () => {
    spawnSync('tmux', ['-L', process.env.DEVICE_MCP_TMUX_SOCKET!, 'new-session', '-d', '-s', 'meine-eigene'])
    const names = (await sessionList()).map((s) => s.name)
    expect(names).toContain('mcp-shell')
    expect(names).not.toContain('meine-eigene')
  })

  test('beendeter Befehl bleibt lesbar, mit Exit-Code', async () => {
    await sessionStart({ name: 'kurz', command: "sh -c 'echo fertig; exit 3'" })
    await sleep(400)
    const screen = await sessionRead({ session: 'kurz' })
    expect(screen.text).toContain('fertig')
    expect(screen.dead).toBe(true)
    expect(screen.exitStatus).toBe(3)
  })

  test('doppelter Name gibt CONFLICT', async () => {
    await expectError(sessionStart({ name: 'shell', command: SHELL }), 'CONFLICT')
  })

  test('kill entfernt die Session, danach NOT_FOUND', async () => {
    await sessionKill({ session: 'shell' })
    await sessionKill({ session: 'kurz' })
    const names = (await sessionList()).map((s) => s.name)
    expect(names).not.toContain('mcp-shell')
    await expectError(sessionRead({ session: 'shell' }), 'NOT_FOUND')
  })
})
