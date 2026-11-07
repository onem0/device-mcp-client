import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { resolveUserPath } from './paths.ts'
import { DaemonError, type ReadFileResult, type WriteFileResult } from './protocol.ts'
import { capLine, cleanFileLine, takeLines } from './text.ts'

// Claude akzeptiert Bilder bis 5 MB als base64, das sind 3,75 MB Rohdaten.
export const IMAGE_MAX_BYTES = 3.75 * 1024 * 1024
const WRITE_MAX_BYTES = 16 * 1024 * 1024
// Bis zu dieser Größe wird eine Textdatei ganz gelesen (dann ist die Zeilenzahl bekannt), darüber gestreamt.
const FULL_READ_MAX_BYTES = 16 * 1024 * 1024
const MAX_TEXT_CHARS = 100_000
const SNIFF_BYTES = 8192

const startsWith = (buf: Buffer, ...bytes: number[]) => bytes.every((b, i) => buf[i] === b)

function imageType(head: Buffer): string | null {
  if (startsWith(head, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(head, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif'
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return null
}

function binaryType(head: Buffer): string | null {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (startsWith(head, 0x50, 0x4b, 0x03, 0x04)) return 'application/zip'
  if (startsWith(head, 0x1f, 0x8b)) return 'application/gzip'
  if (startsWith(head, 0x7f, 0x45, 0x4c, 0x46)) return 'application/x-elf'
  if (startsWith(head, 0x53, 0x51, 0x4c, 0x69, 0x74, 0x65)) return 'application/vnd.sqlite3'
  return null
}

function fsError(err: unknown, file: string): never {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') throw new DaemonError(`${file} gibt es nicht.`, 'NOT_FOUND')
  if (code === 'EACCES' || code === 'EPERM') throw new DaemonError(`Keine Berechtigung für ${file}.`, 'FORBIDDEN')
  if (code === 'EISDIR') throw new DaemonError(`${file} ist ein Ordner.`, 'BAD_REQUEST')
  if (code === 'ENOTDIR') throw new DaemonError(`Ein Teil von ${file} ist kein Ordner.`, 'BAD_REQUEST')
  throw new DaemonError(`${file}: ${(err as Error).message}`)
}

export async function readFileForClaude(params: { path: string; offset?: number; limit?: number }): Promise<ReadFileResult> {
  if (typeof params.path !== 'string' || !params.path) throw new DaemonError('Kein Pfad angegeben.', 'BAD_REQUEST')
  const file = resolveUserPath(params.path)
  const offset = Math.max(0, params.offset ?? 0)
  const limit = Math.max(1, params.limit ?? 2000)

  const info = await stat(file).catch((err) => fsError(err, file))
  if (info.isDirectory()) throw new DaemonError(`${file} ist ein Ordner. Inhalt z. B. mit run_command "ls -la ${file}".`, 'BAD_REQUEST')
  if (!info.isFile()) throw new DaemonError(`${file} ist keine normale Datei.`, 'BAD_REQUEST')

  const handle = await open(file, 'r').catch((err) => fsError(err, file))
  let head: Buffer
  try {
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, info.size))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    head = buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }

  const image = imageType(head)
  if (image) {
    if (info.size > IMAGE_MAX_BYTES) {
      const mb = (info.size / 1024 / 1024).toFixed(1)
      throw new DaemonError(
        `Das Bild ist ${mb} MB groß, höchstens 3,75 MB gehen. Verkleinern z. B. mit run_command: ` +
          `convert "${file}" -resize 2000x2000\\> -quality 85 /tmp/klein.jpg (ImageMagick) oder ffmpeg -i "${file}" -vf scale=2000:-1 /tmp/klein.jpg`,
        'TOO_LARGE',
      )
    }
    const data = await readFile(file).catch((err) => fsError(err, file))
    return { kind: 'image', path: file, size: info.size, mimeType: image, data: data.toString('base64') }
  }

  if (head.includes(0) || binaryType(head)) return { kind: 'binary', path: file, size: info.size, mimeType: binaryType(head) }

  if (info.size <= FULL_READ_MAX_BYTES) {
    let text = (await readFile(file).catch((err) => fsError(err, file))).toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const all = text.split('\n')
    if (text.endsWith('\n')) all.pop()
    const total = text.length === 0 ? 0 : all.length
    const from = Math.min(offset, total)
    const slice = all.slice(from, from + limit).map((l) => capLine(cleanFileLine(l)))
    const taken = takeLines(
      slice.map((l) => l.text),
      MAX_TEXT_CHARS,
    )
    const toLine = from + taken.length
    return {
      kind: 'text',
      path: file,
      size: info.size,
      text: taken.join('\n'),
      fromLine: from,
      toLine,
      totalLines: total,
      hasMore: toLine < total,
      truncatedChars: slice.some((l) => l.cut) || taken.length < slice.length,
    }
  }

  // Große Datei: bis zum gewünschten Bereich streamen, Gesamtzahl der Zeilen bleibt offen.
  const stream = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let cut = false
  let n = 0
  let used = 0
  let hasMore = false
  for await (const raw of rl) {
    if (n++ < offset) continue
    const line = capLine(raw)
    if (lines.length >= limit || (lines.length > 0 && used + line.text.length + 1 > MAX_TEXT_CHARS)) {
      hasMore = true
      if (lines.length < limit) cut = true
      break
    }
    if (line.cut) cut = true
    lines.push(line.text)
    used += line.text.length + 1
  }
  rl.close()
  stream.destroy()
  const from = Math.min(offset, n)
  return {
    kind: 'text',
    path: file,
    size: info.size,
    text: lines.join('\n'),
    fromLine: from,
    toLine: from + lines.length,
    totalLines: hasMore ? null : n,
    hasMore,
    truncatedChars: cut,
  }
}

export async function writeFileForClaude(params: {
  path: string
  content: string
  mode?: 'overwrite' | 'append'
  encoding?: 'utf8' | 'base64'
}): Promise<WriteFileResult> {
  if (typeof params.path !== 'string' || !params.path) throw new DaemonError('Kein Pfad angegeben.', 'BAD_REQUEST')
  if (typeof params.content !== 'string') throw new DaemonError('Kein Inhalt angegeben.', 'BAD_REQUEST')
  const file = resolveUserPath(params.path)
  const data = params.encoding === 'base64' ? Buffer.from(params.content, 'base64') : Buffer.from(params.content, 'utf8')
  if (data.length > WRITE_MAX_BYTES) throw new DaemonError(`Zu groß: höchstens ${WRITE_MAX_BYTES / 1024 / 1024} MB pro Aufruf.`, 'TOO_LARGE')

  const before = await stat(file).catch(() => null)
  if (before?.isDirectory()) throw new DaemonError(`${file} ist ein Ordner.`, 'BAD_REQUEST')

  await mkdir(path.dirname(file), { recursive: true }).catch((err) => fsError(err, path.dirname(file)))
  if (params.mode === 'append') await appendFile(file, data).catch((err) => fsError(err, file))
  else await writeFile(file, data).catch((err) => fsError(err, file))

  const after = await stat(file)
  return { path: file, bytesWritten: data.length, size: after.size, created: before === null }
}
