import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, chmod, chown, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { resolveUserPath } from './paths.ts'
import { DaemonError, type EditFileResult, type ReadFileResult, type WriteFileResult } from './protocol.ts'
import { capLine, cleanFileLine, takeLines } from './text.ts'

// Claude akzeptiert Bilder bis 5 MB als base64, das sind 3,75 MB Rohdaten.
export const IMAGE_MAX_BYTES = 3.75 * 1024 * 1024
const WRITE_MAX_BYTES = 16 * 1024 * 1024
// Bis zu dieser Größe wird eine Textdatei ganz gelesen (dann ist die Zeilenzahl bekannt), darüber gestreamt.
const FULL_READ_MAX_BYTES = 16 * 1024 * 1024
const MAX_TEXT_CHARS = 100_000
const SNIFF_BYTES = 8192
// read_file mit encoding=base64: so viele Bytes pro Aufruf (Standard und Obergrenze).
export const BASE64_DEFAULT_BYTES = 256 * 1024
export const BASE64_MAX_BYTES = 1024 * 1024
// edit_file liest die Datei ganz in den Speicher.
const EDIT_MAX_BYTES = 16 * 1024 * 1024
const SNIPPET_CONTEXT = 3
const SNIPPET_MAX = 3

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

export async function readFileForClaude(params: {
  path: string
  offset?: number
  limit?: number
  encoding?: 'utf8' | 'base64'
  byteOffset?: number
  byteLength?: number
}): Promise<ReadFileResult> {
  if (typeof params.path !== 'string' || !params.path) throw new DaemonError('Kein Pfad angegeben.', 'BAD_REQUEST')
  const file = resolveUserPath(params.path)
  const offset = Math.max(0, params.offset ?? 0)
  const limit = Math.max(1, params.limit ?? 2000)

  const info = await stat(file).catch((err) => fsError(err, file))
  if (info.isDirectory()) throw new DaemonError(`${file} ist ein Ordner. Inhalt z. B. mit run_command "ls -la ${file}".`, 'BAD_REQUEST')
  if (!info.isFile()) throw new DaemonError(`${file} ist keine normale Datei.`, 'BAD_REQUEST')

  // Rohdaten als base64, in Stücken: für Binärdateien jeder Art.
  if (params.encoding === 'base64') {
    const start = Math.max(0, Math.floor(params.byteOffset ?? 0))
    const want = Math.min(BASE64_MAX_BYTES, Math.max(1, Math.floor(params.byteLength ?? BASE64_DEFAULT_BYTES)))
    const length = Math.max(0, Math.min(want, info.size - start))
    const buf = Buffer.alloc(length)
    if (length > 0) {
      const handle = await open(file, 'r').catch((err) => fsError(err, file))
      try {
        await handle.read(buf, 0, length, start)
      } finally {
        await handle.close()
      }
    }
    return { kind: 'base64', path: file, size: info.size, offset: start, length, data: buf.toString('base64'), hasMore: start + length < info.size }
  }

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

const countOccurrences = (text: string, needle: string) => {
  let n = 0
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++
  return n
}

// Schreibt über eine Temp-Datei im selben Ordner und rename: Wer die Datei liest, sieht nie einen halben Stand.
// Rechte (und, wenn erlaubt, Besitzer) der alten Datei bleiben. Ist der Ordner nicht beschreibbar, wird in place geschrieben.
async function writeAtomic(file: string, data: string, mode: number, uid: number, gid: number) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.device-mcp-${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tmp, data, { mode: mode & 0o7777, flag: 'wx' })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EROFS') fsError(err, path.dirname(file))
    await writeFile(file, data).catch((e) => fsError(e, file))
    return { inPlace: true }
  }
  try {
    await chmod(tmp, mode & 0o7777)
    await chown(tmp, uid, gid).catch(() => {})
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    fsError(err, file)
  }
  return { inPlace: false }
}

export async function editFileForClaude(params: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<EditFileResult> {
  if (typeof params.path !== 'string' || !params.path) throw new DaemonError('Kein Pfad angegeben.', 'BAD_REQUEST')
  if (typeof params.old_string !== 'string' || !params.old_string) throw new DaemonError('old_string darf nicht leer sein.', 'BAD_REQUEST')
  if (typeof params.new_string !== 'string') throw new DaemonError('new_string fehlt.', 'BAD_REQUEST')
  if (params.old_string === params.new_string) throw new DaemonError('old_string und new_string sind gleich, es gibt nichts zu ändern.', 'BAD_REQUEST')

  // Symlinks auflösen: geändert wird die Zieldatei, der Link bleibt ein Link.
  const file = await realpath(resolveUserPath(params.path)).catch((err) => fsError(err, resolveUserPath(params.path)))
  const info = await stat(file).catch((err) => fsError(err, file))
  if (!info.isFile()) throw new DaemonError(`${file} ist keine normale Datei.`, 'BAD_REQUEST')
  if (info.size > EDIT_MAX_BYTES) throw new DaemonError(`${file} ist zu groß für edit_file (höchstens 16 MB).`, 'TOO_LARGE')

  const buf = await readFile(file).catch((err) => fsError(err, file))
  if (buf.includes(0)) throw new DaemonError(`${file} ist eine Binärdatei, edit_file ändert nur Text.`, 'BAD_REQUEST')
  const text = buf.toString('utf8')

  // Zeilenenden erhalten: Hat die Datei durchgehend CRLF, werden \n in old_string und new_string angeglichen.
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text)
  let oldS = params.old_string
  let newS = params.new_string
  if (crlf && !oldS.includes('\r\n')) {
    oldS = oldS.replace(/\n/g, '\r\n')
    newS = newS.replace(/\r?\n/g, '\r\n')
  }

  const count = countOccurrences(text, oldS)
  if (count === 0) {
    throw new DaemonError(
      `old_string kommt in ${file} nicht vor (0 Treffer). Leerzeichen, Einrückung und Zeilenumbrüche müssen exakt stimmen; zum Nachsehen read_file nutzen.`,
      'NO_MATCH',
    )
  }
  if (count > 1 && !params.replace_all) {
    throw new DaemonError(`old_string kommt in ${file} ${count}-mal vor. Mehr umgebenden Text angeben, damit es eindeutig ist, oder replace_all=true setzen.`, 'AMBIGUOUS')
  }

  // Neuen Text bauen und merken, wo die Ersetzungen landen.
  const positions: number[] = []
  let out = ''
  let last = 0
  for (let i = text.indexOf(oldS); i !== -1; i = params.replace_all ? text.indexOf(oldS, last) : -1) {
    out += text.slice(last, i)
    positions.push(out.length)
    out += newS
    last = i + oldS.length
  }
  out += text.slice(last)

  const { inPlace } = await writeAtomic(file, out, info.mode, info.uid, info.gid)

  // Kontext: ein paar Zeilen um die ersten Änderungen, mit Zeilennummern.
  const lines = out.split('\n').map((l) => cleanFileLine(l))
  const newLineCount = newS.split('\n').length
  const snippets: EditFileResult['snippets'] = []
  for (const pos of positions.slice(0, SNIPPET_MAX)) {
    const line = out.slice(0, pos).split('\n').length - 1
    const from = Math.max(0, line - SNIPPET_CONTEXT)
    const to = Math.min(lines.length, line + newLineCount + SNIPPET_CONTEXT)
    const prev = snippets[snippets.length - 1]
    if (prev && from <= prev.fromLine - 1 + prev.lines.length) continue
    snippets.push({ fromLine: from + 1, lines: lines.slice(from, to).map((l) => (l.length > 300 ? `${l.slice(0, 300)} …` : l)) })
  }
  return { path: file, replacements: positions.length, inPlace, crlf, snippets }
}
