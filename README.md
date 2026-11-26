# device-mcp-client

The daemon of [device-mcp](https://github.com/onem0/device-mcp-server). It runs on every device (Linux or macOS) that Claude should reach, opens a WebSocket connection (wss) to the server on its own and carries out the server's requests: commands via `bash -c`, background jobs, reading, writing and making targeted edits to files, interactive sessions via tmux.

It is built with `bun build --compile` as a single binary for Linux and macOS, each for x64 and arm64. No runtime is needed on the device. The server builds the binaries from this repo (it is included there as the submodule `daemon/`) and serves them together with the installer and a `manifest.json` (version, checksums). When the server requests an update (a click in the panel or Auto-update for the device), the daemon fetches the new version from there.

## Installation

In the server's panel, click “Add device”. The panel offers the install command for copying exactly once; the device token is part of the copied command and is hidden on screen:

```bash
curl -fsSL https://device.onemo.dev/install.sh | DEVICE_MCP_TOKEN='dmcp_…' bash
```

Run it as a normal user, not as root: the daemon runs as exactly that user. The script creates the binary, the config and `~/.claude-tools/README.md`. On Linux it sets up a systemd user service with `Restart=always` and sets `loginctl enable-linger` so that the daemon starts after a reboot without a login. On macOS it sets up the LaunchAgent `dev.onemo.device-mcp`, which runs as long as the user is logged in.

Requirements: Linux with systemd or macOS, x86_64 or arm64, `curl`, `gzip`. The session tools additionally need `tmux` (`sudo apt install tmux` or `brew install tmux`).

## Operation

```bash
systemctl --user status device-mcp      # Status
journalctl --user -u device-mcp -f      # Log
systemctl --user restart device-mcp     # Restart
curl -fsSL https://device.onemo.dev/install.sh | bash   # Set up binary and service again, the token stays
systemd-run --user --collect bash -c 'curl -fsSL https://device.onemo.dev/install.sh | bash'   # the same from within the daemon (e.g. via run_command)
device-mcp-uninstall                    # Remove (~/.claude-tools stays)
device-mcp --version
```

macOS: `launchctl print gui/$(id -u)/dev.onemo.device-mcp` (status), `tail -f ~/Library/Logs/device-mcp.log` (log), `launchctl kickstart -k gui/$(id -u)/dev.onemo.device-mcp` (restart).

| Path | Contents |
|---|---|
| `~/.local/bin/device-mcp` | Daemon |
| `~/.config/device-mcp/config.json` | `serverUrl` and `token` (chmod 600) |
| `~/.config/device-mcp/env` | Linux: PATH from the shell at install time |
| `~/.config/systemd/user/device-mcp.service` | Linux: systemd unit |
| `~/Library/LaunchAgents/dev.onemo.device-mcp.plist` | macOS: LaunchAgent, also contains the PATH |
| `~/Library/Logs/device-mcp.log` | macOS: log |
| `~/.local/state/device-mcp/update.json` | Only after a failed update: version, time, error |
| `~/.local/state/device-mcp/jobs/` | Status and output of the jobs (last 300, at most 14 days) |
| `~/.claude-tools/` | Claude's helper scripts with a README |

Environment variables for testing: `DEVICE_MCP_CONFIG` (path to the config), `DEVICE_MCP_STATE_DIR` (job directory). The unit and the plist set `DEVICE_MCP_SUPERVISED=1`: only then does the daemon exit by itself after an update.

## Behaviour

- **Connection:** wss to `<serverUrl>/daemon/ws`. The token is sent in the first message (`hello`), not in the URL. Heartbeat every 15 s; if nothing arrives from the server for more than 45 s, the daemon re-establishes the connection.
- **Reconnect:** exponential backoff from 1 s to 60 s with jitter. Rejected token: retry every 5 min, disabled device: every minute.
- **Update:** The daemon does not look for updates itself. The server sends the `update` request (a click on “Update” in the panel, or Auto-update is switched on for the device and it connects with an older version). The daemon then fetches `<serverUrl>/download/manifest.json`; if the version there is newer, it downloads `device-mcp-<platform>-<arch>.gz`, decompresses it as a stream, checks size and SHA-256, runs the new binary with `--version`, replaces itself via `rename`, replies to the server and exits as soon as no job is running any more; systemd or launchd restarts it. Only the compiled binary does this (`bun run dev` never does), no downgrade. After a failure it rejects Auto-update requests for the same version for one hour; a click (`force`) goes through right away. Code in `src/update.ts`.
- **Jobs:** Every command is a job in its own process group (`bash -c`, no TTY, empty stdin). The output goes to disk, so jobs and their output survive a dropped connection. After the reconnect the daemon reports the state of all jobs. Timeout and `kill_job` send SIGTERM to the whole group, SIGKILL after 5 s. A restart of the daemon ends running jobs.
- **Output:** Colour codes are removed, progress bars using `\r` are reduced to their last state, lines over 2000 characters are truncated. At most 64 MB of log per job.
- **Files:** Text line by line with offset/limit, PNG/JPEG/GIF/WebP as an image (at most 3.75 MB), other binary files are only described; with `encoding: base64` the raw data comes in chunks (at most 1 MB per call). Writing creates missing directories, at most 16 MB per call.
- **edit_file:** replaces `old_string` with `new_string`, only if it occurs exactly once (or with `replace_all`). Symlinks are resolved. Writing goes through a temp file in the same directory plus `rename`, with the permissions (and, if possible, the owner) of the old file. If only the file is writable but the directory is not, it is written in place. Hard links lose their connection on `rename`. If the file uses CRLF throughout, `\n` in the strings is adjusted to match.
- **Sessions:** tmux sessions with the prefix `mcp-` on the normal tmux socket, so they can be watched with `tmux attach -t mcp-…`. Started via `systemd-run --user --scope` so that the tmux server does not end up in the cgroup of the daemon service and survives its restart (it also works without systemd-run, then without this guarantee). On macOS tmux survives the restart without any help; launchd only ends the daemon's process group. With `command` the screen stays readable after the command ends (`remain-on-exit`); `session_read` then returns the exit code and the scrollback. Reading uses `capture-pane -p -J`, i.e. without colour codes. Allowed keys: Enter, Tab, BTab, Escape, BSpace, Space, arrow keys, Home/End, PageUp/PageDown, Insert/Delete, F1–F12, single characters, each also with `C-`, `M-`, `S-`.

The message format is defined in `src/protocol.ts`, its counterpart in the server in `server/src/services/protocol.ts`. Always apply changes in both repos.

## Development

```bash
bun install
bun run typecheck
bun test                 # edit_file, update and tmux sessions (session tests are skipped without tmux)
bun run build            # dist/device-mcp-{linux,darwin}-{x64,arm64}, each also as .gz, plus dist/manifest.json
bun run build.ts arm64   # only one architecture (or linux, darwin, linux-arm64 …)
```

Run it against a local server, without installing:

```bash
printf '{"serverUrl":"http://127.0.0.1:3100","token":"dmcp_…"}' > /tmp/dmcp.json && chmod 600 /tmp/dmcp.json
DEVICE_MCP_CONFIG=/tmp/dmcp.json DEVICE_MCP_STATE_DIR=/tmp/dmcp-state bun run dev
```

## Rollout

On deploy, the server builds the daemon from the commit its submodule points to:

```bash
# commit and push here, then in the server repo:
git submodule update --remote daemon
git commit -am "Update daemon" && git push   # Coolify rebuilds
```

Before that, bump `VERSION` in `src/version.ts`: only a higher version counts as an update. After the deploy the panel shows the “Update” button for every device; devices with Auto-update switched on fetch the new binary themselves as soon as no job is running any more. Daemons older than 0.4.0 need the install script run by hand one last time. For new tools, older daemons get the message “Daemon version too old” from the server. `VERSION` in `src/version.ts` and the minimum versions in `server/src/services/guards.ts` belong together.

## License

MIT, see [LICENSE](LICENSE).
