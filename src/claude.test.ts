import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildClaudeArgs, claudeEvents, claudeStart, detectClaude, parseLine, summarizeToolUse, validateClaudeStart, type ParseState } from './claude.ts'
import { JobManager } from './jobs.ts'
import { DaemonError, type JobSummary } from './protocol.ts'

const SESSION = '4f0b1d2e-1111-4222-8333-944445555666'
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dmcp-claude-'))
const project = path.join(tmp, 'project')
const fakeBin = path.join(tmp, 'bin')

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const state = (): ParseState => ({ cwd: '/home/neo/app', tools: new Map() })

describe('stream-json parsing', () => {
  test('init, text, tool use and a failed tool result become events', () => {
    const s = state()
    const init = parseLine(
      JSON.stringify({ type: 'system', subtype: 'init', cwd: '/home/neo/app', model: 'claude-haiku-5-5', permissionMode: 'bypassPermissions', claude_code_version: '2.1.331' }),
      s,
    )
    expect(init.events).toEqual([{ kind: 'init', text: 'Claude Code 2.1.331 · claude-haiku-5-5 · bypassPermissions · in /home/neo/app' }])

    const tool = parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/neo/app/src/a.ts' } }] },
      }),
      s,
    )
    expect(tool.events).toEqual([
      { kind: 'text', text: 'Let me look.', sub: false },
      { kind: 'tool', text: 'Edit: src/a.ts', sub: false },
    ])

    const failed = parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'old_string not found' }] }] } }), s)
    expect(failed.events).toEqual([{ kind: 'error', text: 'Edit failed: old_string not found', sub: false }])

    const ok = parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'fine' }] } }), s)
    expect(ok.events).toEqual([])
  })

  test('hooks and rate limit events are skipped, stderr lines are kept', () => {
    const s = state()
    expect(parseLine('{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}', s).events).toEqual([])
    expect(parseLine('{"type":"rate_limit_event","rate_limit_info":{}}', s).events).toEqual([])
    expect(parseLine('Error: Invalid API key · Please run /login', s).events).toEqual([{ kind: 'output', text: 'Error: Invalid API key · Please run /login' }])
    expect(parseLine(null, s).events[0]!.kind).toBe('note')
  })

  test('the result line carries text, turns, cost and denials', () => {
    const { result } = parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'All done.',
        num_turns: 3,
        duration_ms: 5048,
        total_cost_usd: 0.0065,
        permission_denials: [{ tool_name: 'Bash' }],
        session_id: SESSION,
      }),
      state(),
    )
    expect(result).toEqual({ subtype: 'success', isError: false, text: 'All done.', numTurns: 3, durationMs: 5048, costUsd: 0.0065, permissionDenials: ['Bash'], sessionId: SESSION })
  })

  test('tool summaries are short and relative to the project', () => {
    expect(summarizeToolUse('Bash', { command: 'npm   test\n  -- --watch=false' }, '/p')).toBe('npm test -- --watch=false')
    expect(summarizeToolUse('Grep', { pattern: 'TODO', path: '/p/src' }, '/p')).toBe('TODO in src')
    expect(summarizeToolUse('TodoWrite', { todos: [{ status: 'completed' }, { status: 'in_progress', activeForm: 'Writing tests' }, { status: 'pending' }] }, '/p')).toBe(
      '1/3 done, now: Writing tests',
    )
    expect(summarizeToolUse('Unknown', { a: 1 }, '/p')).toBe('{"a":1}')
  })
})

describe('arguments', () => {
  test('new session vs. resume', () => {
    const base = { jobId: 'job1', prompt: 'x', sessionId: SESSION }
    const fresh = buildClaudeArgs(base)
    expect(fresh.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'])
    expect(fresh.slice(-2)).toEqual(['--session-id', SESSION])
    const resumed = buildClaudeArgs({ ...base, resume: true, model: 'opus', effort: 'high', permissionMode: 'acceptEdits' })
    expect(resumed).toContain('--model')
    expect(resumed).toContain('acceptEdits')
    expect(resumed.slice(-2)).toEqual(['--resume', SESSION])
  })

  test('validation', () => {
    const base = { jobId: 'job1', prompt: 'x', sessionId: SESSION, permissionMode: 'acceptEdits' }
    expect(() => validateClaudeStart({ ...base, prompt: '  ' })).toThrow(DaemonError)
    expect(() => validateClaudeStart({ ...base, sessionId: 'nope' })).toThrow(DaemonError)
    expect(() => validateClaudeStart({ ...base, permissionMode: 'yolo' })).toThrow(DaemonError)
    expect(() => validateClaudeStart({ ...base, model: 'a b' })).toThrow(DaemonError)
    expect(() => validateClaudeStart(base)).not.toThrow()
  })
})

// A fake claude: records its arguments and the prompt from stdin, then writes stream-json like the real one.
const FAKE = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
cat > "$PWD/prompt.txt"
printf '%s\\n' "$@" > "$PWD/args.txt"
echo "\${CLAUDECODE:-unset} \${CLAUDE_CODE_OAUTH_TOKEN:-none}" > "$PWD/env.txt"
# stderr first and a pause: stdout and stderr are separate pipes, this keeps the order in the log fixed.
echo "a warning on stderr" >&2
sleep 0.3
echo '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}'
echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'","model":"fake-model","permissionMode":"bypassPermissions","claude_code_version":"9.9.9"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]}}'
echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"boom"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Finished."}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Finished.","num_turns":2,"duration_ms":12,"total_cost_usd":0.01,"session_id":"${SESSION}"}'
`

function waitForExit(jobs: JobManager, id: string) {
  return new Promise<JobSummary>((resolve) => {
    const onExit = (job: JobSummary) => {
      if (job.id !== id) return
      jobs.off('exit', onExit)
      resolve(job)
    }
    jobs.on('exit', onExit)
  })
}

describe('claude_start and claude_events with a fake CLI', () => {
  test('runs headless with the prompt on stdin and reports events and the result', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(project, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(path.join(fakeBin, 'claude'), FAKE)
    chmodSync(path.join(fakeBin, 'claude'), 0o755)
    const oldPath = process.env.PATH
    process.env.PATH = `${fakeBin}:${oldPath}`
    process.env.CLAUDECODE = '1'
    try {
      const info = await detectClaude(true)
      expect(info).toEqual({ path: path.join(fakeBin, 'claude'), version: '9.9.9' })

      const jobs = new JobManager(path.join(tmp, 'state'))
      jobs.init()
      const prompt = `Fix the "tests" in it's module\nsecond line`
      const exited = waitForExit(jobs, 'cjob1')
      const started = await claudeStart(jobs, { jobId: 'cjob1', prompt, cwd: project, sessionId: SESSION, oauthToken: 'tok-123' })
      expect(started.sessionId).toBe(SESSION)
      expect(started.job.command).toBe('claude -p "Fix the \\"tests\\" in it\'s module"')
      const job = await exited
      expect(job.status).toBe('exited')
      expect(job.exitCode).toBe(0)

      expect(readFileSync(path.join(project, 'prompt.txt'), 'utf8')).toBe(prompt)
      const args = readFileSync(path.join(project, 'args.txt'), 'utf8').trim().split('\n')
      expect(args).toContain('--session-id')
      expect(args).toContain(SESSION)
      // The nested-session marker is removed, the server's token is passed on.
      expect(readFileSync(path.join(project, 'env.txt'), 'utf8').trim()).toBe('unset tok-123')

      const ev = claudeEvents(jobs, { jobId: 'cjob1' })
      expect(ev.events.map((e) => e.kind)).toEqual(['output', 'init', 'tool', 'error', 'text'])
      expect(ev.events[0]!.text).toBe('a warning on stderr')
      expect(ev.events[2]!.text).toBe('Bash: ls -la')
      expect(ev.events[3]!.text).toBe('Bash failed: boom')
      expect(ev.result?.text).toBe('Finished.')
      expect(ev.hasMore).toBe(false)

      // tail: only the last lines.
      const tail = claudeEvents(jobs, { jobId: 'cjob1', tail: 1 })
      expect(tail.fromLine).toBe(ev.toLine - 1)
      expect(tail.events).toEqual([])
      expect(tail.result?.text).toBe('Finished.')

      // From the end: no events, but the result still comes along.
      const later = claudeEvents(jobs, { jobId: 'cjob1', offset: ev.toLine })
      expect(later.events).toEqual([])
      expect(later.result?.numTurns).toBe(2)
    } finally {
      process.env.PATH = oldPath
      delete process.env.CLAUDECODE
    }
  })
})
