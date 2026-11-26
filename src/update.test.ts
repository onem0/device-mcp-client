import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions, parseManifest, Updater } from './update.ts'
import { VERSION } from './version.ts'

// Ein "Binary" ist hier ein Shell-Script, das wie der Daemon auf --version antwortet.
const fakeBinary = (version: string) => Buffer.from(`#!/bin/sh\necho ${version}\n`)
const NEXT = '99.0.0'

let dir: string
let server: ReturnType<typeof Bun.serve>
let manifest: unknown
let binary: Buffer
let downloads = 0

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dmcp-update-'))
  binary = fakeBinary(NEXT)
  manifest = null
  downloads = 0
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/download/manifest.json') return manifest ? Response.json(manifest) : new Response('no', { status: 404 })
      if (pathname === `/download/device-mcp-${process.platform}-${process.arch}.gz`) {
        downloads++
        return new Response(Bun.gzipSync(new Uint8Array(binary)))
      }
      return new Response('no', { status: 404 })
    },
  })
})

afterEach(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

const entry = (bytes: Buffer) => ({ sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
const manifestFor = (version: string, bytes: Buffer) => ({ version, binaries: { [`${process.platform}-${process.arch}`]: entry(bytes) } })

function setup(opts: { running?: number; supervised?: boolean; autoUpdate?: boolean } = {}) {
  const execPath = path.join(dir, 'device-mcp')
  writeFileSync(execPath, fakeBinary(VERSION))
  chmodSync(execPath, 0o755)
  const state = { restarts: 0, running: opts.running ?? 0 }
  const updater = new Updater(
    { serverUrl: `http://127.0.0.1:${server.port}`, autoUpdate: opts.autoUpdate ?? true },
    { runningCount: () => state.running },
    path.join(dir, 'state'),
    () => state.restarts++,
    { execPath, compiled: true, supervised: opts.supervised ?? true },
  )
  return { execPath, state, updater }
}

test('compareVersions', () => {
  expect(compareVersions('0.3.0', '0.2.9')).toBe(1)
  expect(compareVersions('0.3.0', '0.3.0')).toBe(0)
  expect(compareVersions('0.3', '0.3.1')).toBe(-1)
  expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
})

test('parseManifest rejects junk', () => {
  expect(() => parseManifest(null)).toThrow()
  expect(() => parseManifest({ version: '1.0.0; rm -rf', binaries: {} })).toThrow()
  expect(() => parseManifest({ version: '1.0.0' })).toThrow()
  expect(parseManifest({ version: '1.0.0', binaries: {} }).version).toBe('1.0.0')
})

test('newer version: replaces the binary and restarts', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor(NEXT, binary)
  await updater.check()
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  expect(updater.stagedVersion).toBe(NEXT)
  expect(state.restarts).toBe(1)
  expect(readdirSync(dir).filter((f) => f.startsWith('.device-mcp.update-'))).toEqual([])
})

test('same or older version, or no manifest: nothing happens', async () => {
  const { execPath, state, updater } = setup()
  await updater.check()
  manifest = manifestFor(VERSION, binary)
  await updater.check()
  manifest = manifestFor('0.0.1', binary)
  await updater.check()
  expect(downloads).toBe(0)
  expect(state.restarts).toBe(0)
  expect(readFileSync(execPath).equals(fakeBinary(VERSION))).toBe(true)
})

test('waits for running jobs before restarting', async () => {
  const { execPath, state, updater } = setup({ running: 1 })
  manifest = manifestFor(NEXT, binary)
  await updater.check()
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  expect(state.restarts).toBe(0)
  // Ein zweiter Lauf lädt nicht noch einmal.
  await updater.check()
  expect(downloads).toBe(1)
  updater.stop()
})

test('not running as a service: installs, but does not restart', async () => {
  const { execPath, state, updater } = setup({ supervised: false })
  manifest = manifestFor(NEXT, binary)
  await updater.check()
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  expect(state.restarts).toBe(0)
})

test('wrong checksum: keeps the old binary and waits before the next try', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor(NEXT, fakeBinary('99.0.1'))
  await updater.check()
  expect(readFileSync(execPath).equals(fakeBinary(VERSION))).toBe(true)
  expect(state.restarts).toBe(0)
  expect(existsSync(path.join(dir, 'state', 'update.json'))).toBe(true)
  expect(readdirSync(dir).filter((f) => f.startsWith('.device-mcp.update-'))).toEqual([])
  // Gleiche Version gleich noch einmal: kein neuer Download.
  manifest = manifestFor(NEXT, binary)
  await updater.check()
  expect(downloads).toBe(1)
})

test('binary reports another version than the manifest: refused', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor('98.0.0', binary)
  await updater.check()
  expect(readFileSync(execPath).equals(fakeBinary(VERSION))).toBe(true)
  expect(state.restarts).toBe(0)
})

test('autoUpdate: false turns it off', async () => {
  const { state, updater } = setup({ autoUpdate: false })
  manifest = manifestFor(NEXT, binary)
  await updater.check()
  expect(downloads).toBe(0)
  expect(state.restarts).toBe(0)
})
