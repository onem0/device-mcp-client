# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The daemon of device-mcp. It runs on every device Claude should reach (Linux with systemd, or macOS with launchd), opens a WebSocket to its server on its own and executes the server's requests: shell commands as jobs, file reads/writes/edits, and tmux sessions. It is compiled with `bun build --compile` into a single binary per platform; devices need no runtime.

The server is a separate repo, [onem0/device-mcp-server](https://github.com/onem0/device-mcp-server). It installs this daemon from the GitHub releases of this repo and triggers updates; it never builds or hosts the binaries.

## Commands

```bash
bun install
bun run typecheck                    # tsc --noEmit
bun test                             # all tests; session tests are skipped without tmux
bun test src/update.test.ts -t "<name>"   # single file / single test
bun run build                        # all four targets into dist/ (+ .gz) and dist/manifest.json
bun run build.ts linux-arm64         # one target; also accepts linux, darwin, x64, arm64

# against a local server without installing
printf '{"serverUrl":"http://127.0.0.1:3100","token":"dmcp_…"}' > /tmp/dmcp.json && chmod 600 /tmp/dmcp.json
DEVICE_MCP_CONFIG=/tmp/dmcp.json DEVICE_MCP_STATE_DIR=/tmp/dmcp-state bun run dev
```

## Releases

Bump `VERSION` in `src/version.ts` and push to `main`. `.github/workflows/release.yml` runs typecheck and tests, builds all targets and publishes `v<version>` with `device-mcp-<platform>-<arch>.gz` and `manifest.json` (version, size and SHA-256 of each unpacked binary). A push without a new version publishes nothing. Servers pick up a new release within about ten minutes and offer it in their panel. Only a higher version counts as an update; there is no downgrade.

## Architecture

- `src/index.ts`: entry point (`--version`, `--help`), wires config, `JobManager`, `Updater` and `Connection`; SIGTERM/SIGINT and the post-update exit share one shutdown path that kills running jobs.
- `src/connection.ts`: WebSocket to `<serverUrl>/daemon/ws`. The token goes in the first message (`hello`, with daemon info and all job summaries), never in the URL. Heartbeats at the interval the server sends in `welcome`; reconnects with jittered exponential backoff, and fixed delays for the server's close codes (rejected token, disabled device, replaced connection).
- `src/handlers.ts`: dispatches server requests by method name. An unknown method answers `UNKNOWN_METHOD`, which the server turns into a "daemon too old" message.
- `src/jobs.ts`: each command runs as `bash -c` in its own process group with output written to disk under the state dir, so jobs and their output survive a lost connection; after reconnecting, `hello` reports their state. A daemon restart ends running jobs (reported as `lost`). Output is cleaned by `src/text.ts` (ANSI codes stripped, carriage-return progress bars collapsed, long lines cut).
- `src/files.ts`: `read_file` (text by lines, images inline, base64 ranges), `write_file`, and `edit_file`, which writes atomically via temp file plus `rename` while keeping mode and owner.
- `src/sessions.ts`: tmux sessions with the `mcp-` prefix on the user's normal tmux socket. On Linux they are started through `systemd-run --user --scope` so they survive a restart of the daemon's service; on macOS they survive anyway. `resolveSession()` also accepts the user's own sessions by exact name (read and type, never kill). `session_wait` polls the screen; `session_send` with `wait_for` taps new output with `pipe-pane` (files under `<state>/sessions/`). `src/screen.ts` marks highlighted text from `capture-pane -e`.
- `src/claude.ts`: finds the Claude Code CLI, starts `claude -p … --output-format stream-json` as a job (prompt on stdin via `JobManager.start(…, { stdin, env, label })`), and parses the raw job log (`JobManager.rawLines`) into events for `claude_events`.
- `src/update.ts` + `src/release.ts`: updates only on the server's `update` request, never on its own. Downloads the latest release's `manifest.json`, then the binary of exactly that version from GitHub, checks size and SHA-256, runs it with `--version`, replaces itself via `rename`, answers the server, and exits once no job is running so systemd/launchd restarts it. Only the compiled binary does this (`Bun.main` under `/$bunfs/`), and it exits only when the service files set `DEVICE_MCP_SUPERVISED=1`. A failed version is not retried by auto-update for an hour; a click (`force`) retries at once. The server may pass another release URL (forks).
- `src/protocol.ts`: message and result types. It mirrors `server/src/services/protocol.ts` in the server repo; change both together. A new method also needs an entry in `DAEMON_FEATURES` (`server/src/services/guards.ts`) with the first daemon version that has it.

The install and uninstall scripts and the systemd unit / launchd plist live in the server repo (`server/install/`).

## Conventions

- Must build and run on Linux and macOS, x64 and arm64; platform differences are branched on `process.platform` (see `info.ts`, `sessions.ts`).
- Environment variables for tests and manual runs: `DEVICE_MCP_CONFIG`, `DEVICE_MCP_STATE_DIR`, `DEVICE_MCP_TMUX_SOCKET` (separate tmux socket) and `DEVICE_MCP_TMUX_NO_SCOPE=1` (no `systemd-run`). Variables starting with `DEVICE_MCP_` are not passed on to jobs.
- All text is English: log and error messages, code comments and documentation.
