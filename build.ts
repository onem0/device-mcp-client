// Baut den Daemon als Single-Binary für Linux und macOS, ohne Runtime auf dem Gerät.
// Aufruf: bun run build.ts [linux-x64|linux-arm64|darwin-x64|darwin-arm64|linux|darwin|x64|arm64]   (ohne Argument alle)
// Neben den Binaries entsteht dist/manifest.json: Version und Prüfsummen. Der Server liefert es aus,
// die Daemons erkennen daran ein Update.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { VERSION } from './src/version.ts'

const TARGETS = {
  // baseline läuft auch auf älteren x64-CPUs ohne AVX2 (und unter Rosetta).
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  // Bun signiert macOS-Binaries beim Bauen ad hoc, auch beim Cross-Compile unter Linux.
  'darwin-arm64': 'bun-darwin-arm64',
} as const

type Key = keyof typeof TARGETS
interface Manifest {
  version: string
  // sha256 und size gelten für das entpackte Binary.
  binaries: Partial<Record<Key, { sha256: string; size: number }>>
}

const filter = process.argv[2]
const wanted = (Object.keys(TARGETS) as Key[]).filter((key) => !filter || key === filter || key.split('-').includes(filter))
if (!wanted.length) throw new Error(`Unbekanntes Ziel ${filter}. Möglich: ${Object.keys(TARGETS).join(', ')}`)
mkdirSync('dist', { recursive: true })

// Ein Teil-Build ergänzt das Manifest derselben Version, eine neue Version beginnt leer.
const MANIFEST = 'dist/manifest.json'
let manifest: Manifest = { version: VERSION, binaries: {} }
if (existsSync(MANIFEST)) {
  try {
    const old = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest
    if (old.version === VERSION && old.binaries) manifest = old
  } catch {
    // Kaputtes Manifest: neu schreiben.
  }
}

for (const key of wanted) {
  const outfile = `dist/device-mcp-${key}`
  const result = await Bun.build({
    entrypoints: ['src/index.ts'],
    // Keine .env oder bunfig.toml aus dem Arbeitsverzeichnis (beim Daemon das Home) laden.
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
