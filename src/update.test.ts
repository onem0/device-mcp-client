import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compareVersions, parseManifest, Updater } from './update.ts'
import { VERSION } from './version.ts'

// A "binary" here is a shell script that answers --version like the daemon does.
const fakeBinary = (version: string) => Buffer.from(`#!/bin/sh\necho ${version}\n`)
const NEXT = '99.0.0'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
      // Same layout as GitHub releases: /latest/download/<asset> and /download/v<version>/<asset>.
      if (pathname === '/latest/download/manifest.json') return manifest ? Response.json(manifest) : new Response('no', { status: 404 })
      const asset = /^\/download\/v([^/]+)\/(.+)$/.exec(pathname)
      if (asset && asset[1] === (manifest as { version?: string } | null)?.version && asset[2] === `device-mcp-${process.platform}-${process.arch}.gz`) {
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

function setup(opts: { running?: number; supervised?: boolean; compiled?: boolean } = {}) {
  const execPath = path.join(dir, 'device-mcp')
  writeFileSync(execPath, fakeBinary(VERSION))
  chmodSync(execPath, 0o755)
  const state = { restarts: 0, running: opts.running ?? 0 }
  const updater = new Updater(
    { runningCount: () => state.running },
    path.join(dir, 'state'),
    () => state.restarts++,
    { execPath, compiled: opts.compiled ?? true, supervised: opts.supervised ?? true, restartDelayMs: 10, releaseUrl: `http://127.0.0.1:${server.port}` },
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

test('newer version: replaces the binary, answers first, then restarts', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor(NEXT, binary)
  const result = await updater.run()
  expect(result).toEqual({ status: 'installed', version: NEXT, restart: 'now', runningJobs: 0 })
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  // The restart only comes after the reply.
  expect(state.restarts).toBe(0)
  await sleep(60)
  expect(state.restarts).toBe(1)
  expect(readdirSync(dir).filter((f) => f.startsWith('.device-mcp.update-'))).toEqual([])
})

test('same or older version: reports current and downloads nothing', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor(VERSION, binary)
  expect(await updater.run()).toEqual({ status: 'current', version: VERSION })
  manifest = manifestFor('0.0.1', binary)
  expect(await updater.run({ force: true })).toEqual({ status: 'current', version: VERSION })
  expect(downloads).toBe(0)
  await sleep(40)
  expect(state.restarts).toBe(0)
  expect(readFileSync(execPath).equals(fakeBinary(VERSION))).toBe(true)
})

test('no manifest on the server: clear error', async () => {
  const { updater } = setup()
  await expect(updater.run()).rejects.toThrow(/No daemon release found/)
})

test('waits for running jobs before restarting', async () => {
  const { execPath, state, updater } = setup({ running: 1 })
  manifest = manifestFor(NEXT, binary)
  expect(await updater.run()).toEqual({ status: 'installed', version: NEXT, restart: 'when_idle', runningJobs: 1 })
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  await sleep(60)
  expect(state.restarts).toBe(0)
  // A second call does not download again and reports the same state.
  expect((await updater.run({ force: true })).status).toBe('installed')
  expect(downloads).toBe(1)
  updater.stop()
})

test('not running as a service: installs, but does not restart', async () => {
  const { execPath, state, updater } = setup({ supervised: false })
  manifest = manifestFor(NEXT, binary)
  expect((await updater.run()) as { restart?: string }).toMatchObject({ status: 'installed', restart: 'manual' })
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  await sleep(40)
  expect(state.restarts).toBe(0)
})

test('wrong checksum: keeps the old binary; auto-update waits, a click retries', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor(NEXT, fakeBinary('99.0.1'))
  await expect(updater.run()).rejects.toThrow(/checksum/)
  await sleep(100)
  expect(readFileSync(execPath).equals(fakeBinary(VERSION))).toBe(true)
  expect(existsSync(path.join(dir, 'state', 'update.json'))).toBe(true)
  expect(readdirSync(dir).filter((f) => f.startsWith('.device-mcp.update-'))).toEqual([])

  manifest = manifestFor(NEXT, binary)
  // Auto-update (without force): not the same version again right away.
  await expect(updater.run()).rejects.toThrow(/failed less than an hour ago/)
  await sleep(20)
  expect(downloads).toBe(1)
  // Click in the panel: right away.
  expect((await updater.run({ force: true })).status).toBe('installed')
  expect(downloads).toBe(2)
  expect(existsSync(path.join(dir, 'state', 'update.json'))).toBe(false)
  await sleep(60)
  expect(state.restarts).toBe(1)
})

test('binary reports another version than the manifest: refused', async () => {
  const { execPath, state, updater } = setup()
  manifest = manifestFor('98.0.0', binary)
  await expect(updater.run()).rejects.toThrow(/reports 99\.0\.0 instead of 98\.0\.0/)
  await sleep(100)
  expect(readFileSync(execPath).equals(fakeBinary(VERSION))).toBe(true)
  expect(state.restarts).toBe(0)
})

test('started with bun instead of the binary: refuses', async () => {
  const { updater } = setup({ compiled: false })
  manifest = manifestFor(NEXT, binary)
  await expect(updater.run()).rejects.toThrow(/cannot update itself/)
  expect(downloads).toBe(0)
})

test('the server can name another release location', async () => {
  const { execPath, updater } = setup()
  manifest = manifestFor(NEXT, binary)
  await expect(updater.run({ releaseUrl: 'ftp://example.invalid/releases' })).rejects.toThrow(/not an http\(s\) URL/)
  await expect(updater.run({ releaseUrl: `http://127.0.0.1:${server.port}/nowhere` })).rejects.toThrow(/No daemon release found/)
  expect((await updater.run({ releaseUrl: `http://127.0.0.1:${server.port}/` })).status).toBe('installed')
  expect(readFileSync(execPath).equals(binary)).toBe(true)
  updater.stop()
})
