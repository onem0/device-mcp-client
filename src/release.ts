// Where daemon binaries come from: the GitHub releases of this repository. Each release carries the
// gzipped binaries (device-mcp-<platform>-<arch>.gz) and manifest.json with the version and checksums.
// The server may name another release location in its update request (a fork, a mirror).
export const DEFAULT_RELEASE_URL = 'https://github.com/onem0/device-mcp-client/releases'

export function releaseBase(url: string | undefined) {
  const base = (url ?? DEFAULT_RELEASE_URL).replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s]+$/.test(base)) throw new Error(`Release URL ${base} is not an http(s) URL.`)
  return base
}

// The manifest of the newest release.
export const manifestUrl = (base: string) => `${base}/latest/download/manifest.json`

// A binary of exactly that version, so that manifest and binary always belong together.
export const binaryUrl = (base: string, version: string, target: string) => `${base}/download/v${version}/device-mcp-${target}.gz`
