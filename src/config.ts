import { readFileSync, statSync } from 'node:fs'
import { log } from './log.ts'
import { configPath } from './paths.ts'

export interface Config {
  serverUrl: string
  token: string
}

export function loadConfig(): Config {
  const file = configPath()
  let data: Partial<Config>
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Config ${file} is missing or not valid JSON (${(err as Error).message}).`)
  }
  if (typeof data.serverUrl !== 'string' || !/^https?:\/\//.test(data.serverUrl)) {
    throw new Error(`serverUrl in ${file} is missing or does not start with http(s)://.`)
  }
  if (typeof data.token !== 'string' || data.token.length < 20) throw new Error(`token in ${file} is missing.`)

  const mode = statSync(file).mode & 0o777
  if (mode & 0o077) log.warn(`${file} is readable by others (mode ${mode.toString(8)}). Recommended: chmod 600 ${file}`)

  return { serverUrl: data.serverUrl.replace(/\/+$/, ''), token: data.token }
}
