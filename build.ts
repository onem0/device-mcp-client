// Baut den Daemon als Single-Binary für Linux, ohne Runtime auf dem Gerät.
// Aufruf: bun run build.ts [x64|arm64]   (ohne Argument beide)
import { mkdirSync } from 'node:fs'

const TARGETS = {
  // baseline läuft auch auf älteren x64-CPUs ohne AVX2.
  x64: 'bun-linux-x64-baseline',
  arm64: 'bun-linux-arm64',
} as const

const wanted = (process.argv[2] ? [process.argv[2]] : Object.keys(TARGETS)) as (keyof typeof TARGETS)[]
mkdirSync('dist', { recursive: true })

for (const arch of wanted) {
  const target = TARGETS[arch]
  if (!target) throw new Error(`Unbekannte Architektur ${arch}`)
  const outfile = `dist/device-mcp-linux-${arch}`
  const result = await Bun.build({
    entrypoints: ['src/index.ts'],
    // Keine .env oder bunfig.toml aus dem Arbeitsverzeichnis (beim Daemon das Home) laden.
    compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  const gz = Bun.gzipSync(await Bun.file(outfile).bytes(), { level: 9 })
  await Bun.write(`${outfile}.gz`, gz)
  console.log(`${outfile} (${(Bun.file(outfile).size / 1024 / 1024).toFixed(1)} MB, gz ${(gz.length / 1024 / 1024).toFixed(1)} MB)`)
}
