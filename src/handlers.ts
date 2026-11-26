import { editFileForClaude, readFileForClaude, writeFileForClaude } from './files.ts'
import type { JobManager, OutputParams } from './jobs.ts'
import { DaemonError } from './protocol.ts'
import { sessionKill, sessionList, sessionRead, sessionSend, sessionStart } from './sessions.ts'
import type { Updater } from './update.ts'

// Requests from the server. The server is trusted; the parameters are still roughly checked.
export function createHandlers(jobs: JobManager, updater: Updater) {
  return async (method: string, params: any): Promise<unknown> => {
    params ??= {}
    switch (method) {
      case 'exec':
        return jobs.start(params)
      case 'job_status':
        return jobs.status(params.jobId)
      case 'job_list':
        return jobs.list(Number(params.limit) || 20)
      case 'job_output':
        if (!['range', 'tail', 'headtail'].includes(params.mode)) throw new DaemonError('Unknown output mode.', 'BAD_REQUEST')
        return jobs.output(params as OutputParams)
      case 'job_kill':
        return jobs.kill(params.jobId, params.signal)
      case 'read_file':
        return readFileForClaude(params)
      case 'write_file':
        return writeFileForClaude(params)
      case 'edit_file':
        return editFileForClaude(params)
      case 'session_start':
        return sessionStart(params)
      case 'session_send':
        return sessionSend(params)
      case 'session_read':
        return sessionRead(params)
      case 'session_list':
        return sessionList()
      case 'session_kill':
        return sessionKill(params)
      case 'update':
        return updater.run({ force: params.force === true, releaseUrl: typeof params.releaseUrl === 'string' ? params.releaseUrl : undefined })
      default:
        throw new DaemonError(`Unknown method ${method}. Is the daemon up to date?`, 'UNKNOWN_METHOD')
    }
  }
}

export type Handler = ReturnType<typeof createHandlers>
