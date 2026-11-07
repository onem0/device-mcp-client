import { readFileForClaude, writeFileForClaude } from './files.ts'
import type { JobManager, OutputParams } from './jobs.ts'
import { DaemonError } from './protocol.ts'

// Anfragen des Servers. Der Server ist vertrauenswürdig, die Parameter werden trotzdem grob geprüft.
export function createHandlers(jobs: JobManager) {
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
        if (!['range', 'tail', 'headtail'].includes(params.mode)) throw new DaemonError('Unbekannter Ausgabemodus.', 'BAD_REQUEST')
        return jobs.output(params as OutputParams)
      case 'job_kill':
        return jobs.kill(params.jobId, params.signal)
      case 'read_file':
        return readFileForClaude(params)
      case 'write_file':
        return writeFileForClaude(params)
      default:
        throw new DaemonError(`Unbekannte Methode ${method}. Ist der Daemon aktuell?`, 'UNKNOWN_METHOD')
    }
  }
}

export type Handler = ReturnType<typeof createHandlers>
