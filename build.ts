// Builds the daemon as a single binary for Linux and macOS, with no runtime on the device.
// Usage: bun run build.ts [linux-x64|linux-arm64|darwin-x64|darwin-arm64|linux|darwin|x64|arm64]   (all of them without an argument)
// Alongside the binaries it writes dist/manifest.json: version and checksums. The server serves it,
// and the daemons use it to detect an update.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { VERSION } from './src/version.ts'

const TARGETS = {
  // baseline also runs on older x64 CPUs without AVX2 (and under Rosetta).
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  // Bun ad-hoc signs macOS binaries at build time, even when cross-compiling on Linux.
  'darwin-arm64': 'bun-darwin-arm64',
} as const

type Key = keyof typeof TARGETS
interface Manifest {
  version: string
  // sha256 and size refer to the uncompressed binary.
  binaries: Partial<Record<Key, { sha256: string; size: number }>>
}

const filter = process.argv[2]
const wanted = (Object.keys(TARGETS) as Key[]).filter((key) => !filter || key === filter || key.split('-').includes(filter))
if (!wanted.length) throw new Error(`Unknown target ${filter}. Available: ${Object.keys(TARGETS).join(', ')}`)
mkdirSync('dist', { recursive: true })

// A partial build adds to the manifest of the same version; a new version starts empty.
const MANIFEST = 'dist/manifest.json'
let manifest: Manifest = { version: VERSION, binaries: {} }
if (existsSync(MANIFEST)) {
  try {
    const old = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest
    if (old.version === VERSION && old.binaries) manifest = old
  } catch {
    // Broken manifest: rewrite it.
  }
}

for (const key of wanted) {
  const outfile = `dist/device-mcp-${key}`
  const result = await Bun.build({
    entrypoints: ['src/index.ts'],
    // Do not load .env or bunfig.toml from the working directory (for the daemon, the home directory).
    compile: { target: TARGETS[key], outfile, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const bytes = await Bun.file(outfile).bytes()
  const gz = Bun.gzipSync(bytes, { level: 9 })
  await Bun.write(`${outfile}.gz`, gz)
  manifest.binaries[key] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
  console.log(`${outfile} (${(bytes.length / 1024 / 1024).toFixed(1)} MB, gz ${(gz.length / 1024 / 1024).toFixed(1)} MB)`)
}

await Bun.write(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${MANIFEST}: ${manifest.version}, ${Object.keys(manifest.binaries).join(', ')}`)
