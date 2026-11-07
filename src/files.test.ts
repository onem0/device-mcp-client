import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { editFileForClaude, readFileForClaude } from './files.ts'
import { DaemonError } from './protocol.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'device-mcp-files-'))
let n = 0
let file = ''

beforeEach(() => {
  file = path.join(dir, `datei-${++n}.txt`)
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

describe('edit_file', () => {
  test('0 Treffer: Fehler mit Anzahl, Datei unverändert', async () => {
    writeFileSync(file, 'eins\nzwei\n')
    const message = await expectError(editFileForClaude({ path: file, old_string: 'drei', new_string: 'vier' }), 'NO_MATCH')
    expect(message).toContain('0 Treffer')
    expect(readFileSync(file, 'utf8')).toBe('eins\nzwei\n')
  })

  test('1 Treffer: ersetzt und liefert Kontext mit Zeilennummer', async () => {
    writeFileSync(file, ['a', 'b', 'c', 'port = 3000', 'd', 'e', 'f', 'g'].join('\n') + '\n')
    const res = await editFileForClaude({ path: file, old_string: 'port = 3000', new_string: 'port = 4000' })
    expect(res.replacements).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(['a', 'b', 'c', 'port = 4000', 'd', 'e', 'f', 'g'].join('\n') + '\n')
    expect(res.snippets).toHaveLength(1)
    expect(res.snippets[0]!.fromLine).toBe(1)
    expect(res.snippets[0]!.lines).toContain('port = 4000')
    // Nur ein Ausschnitt, nicht die ganze Datei.
    expect(res.snippets[0]!.lines).not.toContain('g')
  })

  test('mehrere Treffer ohne replace_all: Fehler mit Anzahl, Datei unverändert', async () => {
    writeFileSync(file, 'x = 1\nx = 1\nx = 1\n')
    const message = await expectError(editFileForClaude({ path: file, old_string: 'x = 1', new_string: 'x = 2' }), 'AMBIGUOUS')
    expect(message).toContain('3-mal')
    expect(readFileSync(file, 'utf8')).toBe('x = 1\nx = 1\nx = 1\n')
  })

  test('replace_all ersetzt alle Treffer', async () => {
    writeFileSync(file, 'x = 1\ny\nx = 1\ny\nx = 1\n')
    const res = await editFileForClaude({ path: file, old_string: 'x = 1', new_string: 'x = 2', replace_all: true })
    expect(res.replacements).toBe(3)
    expect(readFileSync(file, 'utf8')).toBe('x = 2\ny\nx = 2\ny\nx = 2\n')
  })

  test('mehrzeiliges old_string', async () => {
    writeFileSync(file, 'function a() {\n  return 1\n}\n')
    await editFileForClaude({ path: file, old_string: '  return 1\n}', new_string: '  return 2\n}' })
    expect(readFileSync(file, 'utf8')).toBe('function a() {\n  return 2\n}\n')
  })

  test('CRLF bleibt erhalten, auch wenn old_string und new_string nur \\n haben', async () => {
    writeFileSync(file, 'eins\r\nzwei\r\ndrei\r\n')
    const res = await editFileForClaude({ path: file, old_string: 'zwei\ndrei', new_string: 'ZWEI\nDREI\nvier' })
    expect(res.crlf).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('eins\r\nZWEI\r\nDREI\r\nvier\r\n')
  })

  test('Dateirechte bleiben erhalten, kein Temp-Rest', async () => {
    writeFileSync(file, 'geheim=1\n')
    chmodSync(file, 0o640)
    const res = await editFileForClaude({ path: file, old_string: 'geheim=1', new_string: 'geheim=2' })
    expect(res.inPlace).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o640)
    const leftovers = require('node:fs').readdirSync(dir).filter((f: string) => f.includes('.device-mcp-'))
    expect(leftovers).toHaveLength(0)
  })

  test('Symlink: Ziel wird geändert, der Link bleibt ein Link', async () => {
    writeFileSync(file, 'ziel=a\n')
    const link = `${file}.link`
    symlinkSync(file, link)
    await editFileForClaude({ path: link, old_string: 'ziel=a', new_string: 'ziel=b' })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('ziel=b\n')
  })

  test('gleiche Strings und leeres old_string werden abgelehnt', async () => {
    writeFileSync(file, 'a\n')
    await expectError(editFileForClaude({ path: file, old_string: 'a', new_string: 'a' }), 'BAD_REQUEST')
    await expectError(editFileForClaude({ path: file, old_string: '', new_string: 'b' }), 'BAD_REQUEST')
  })

  test('Binärdatei wird abgelehnt', async () => {
    writeFileSync(file, Buffer.from([0x61, 0x00, 0x62]))
    await expectError(editFileForClaude({ path: file, old_string: 'a', new_string: 'b' }), 'BAD_REQUEST')
  })
})

describe('read_file mit encoding=base64', () => {
  test('liefert Bytes in Stücken', async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
    writeFileSync(file, bytes)
    const first = await readFileForClaude({ path: file, encoding: 'base64', byteOffset: 0, byteLength: 600 })
    expect(first.kind).toBe('base64')
    if (first.kind !== 'base64') return
    expect(first.length).toBe(600)
    expect(first.hasMore).toBe(true)
    const rest = await readFileForClaude({ path: file, encoding: 'base64', byteOffset: 600, byteLength: 600 })
    if (rest.kind !== 'base64') throw new Error('base64 erwartet')
    expect(rest.length).toBe(400)
    expect(rest.hasMore).toBe(false)
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(rest.data, 'base64')])).toEqual(bytes)
  })

  test('ohne encoding bleibt das Verhalten wie bisher (Binärdatei wird nur beschrieben)', async () => {
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]))
    const res = await readFileForClaude({ path: file })
    expect(res.kind).toBe('binary')
  })
})
