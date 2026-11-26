# device-mcp-client

Der Daemon von [device-mcp](https://github.com/onem0/device-mcp-server). Er läuft auf jedem Gerät (Linux oder macOS), das Claude erreichen soll, baut von sich aus eine WebSocket-Verbindung (wss) zum Server auf und führt dessen Aufträge aus: Befehle über `bash -c`, Hintergrundjobs, Dateien lesen, schreiben und gezielt ändern, interaktive Sessions über tmux.

Gebaut wird er mit `bun build --compile` als Single-Binary für Linux und macOS, jeweils x64 und arm64. Auf dem Gerät ist keine Runtime nötig. Der Server baut die Binaries aus diesem Repo (es ist dort als Submodule `daemon/` eingebunden) und liefert sie zusammen mit dem Installer und einem `manifest.json` (Version, Prüfsummen) aus. Daran erkennt der Daemon neue Versionen und aktualisiert sich selbst.

## Installieren

Im Panel des Servers ein Gerät anlegen. Das Panel bietet den Install-Befehl genau einmal zum Kopieren an; der Geräte-Token steckt im kopierten Befehl und ist auf dem Bildschirm verdeckt:

```bash
curl -fsSL https://device.onemo.dev/install.sh | DEVICE_MCP_TOKEN='dmcp_…' bash
```

Als normaler Benutzer ausführen, nicht als root: Der Daemon läuft als genau dieser Benutzer. Das Script legt Binary, Config und `~/.claude-tools/README.md` an. Unter Linux richtet es einen systemd-User-Service mit `Restart=always` ein und setzt `loginctl enable-linger`, damit der Daemon nach einem Reboot ohne Anmeldung startet. Unter macOS richtet es den LaunchAgent `dev.onemo.device-mcp` ein, der läuft, solange der Benutzer angemeldet ist.

Voraussetzungen: Linux mit systemd oder macOS, x86_64 oder arm64, `curl`, `gzip`. Für die Session-Tools zusätzlich `tmux` (`sudo apt install tmux` bzw. `brew install tmux`).

## Bedienen

```bash
systemctl --user status device-mcp      # Status
journalctl --user -u device-mcp -f      # Log
systemctl --user restart device-mcp     # Neustart
curl -fsSL https://device.onemo.dev/install.sh | bash   # Binary und Service neu einrichten, der Token bleibt
systemd-run --user --collect bash -c 'curl -fsSL https://device.onemo.dev/install.sh | bash'   # dasselbe aus dem Daemon heraus (z. B. per run_command)
device-mcp-uninstall                    # Entfernen (~/.claude-tools bleibt)
device-mcp --version
```

macOS: `launchctl print gui/$(id -u)/dev.onemo.device-mcp` (Status), `tail -f ~/Library/Logs/device-mcp.log` (Log), `launchctl kickstart -k gui/$(id -u)/dev.onemo.device-mcp` (Neustart).

| Pfad | Inhalt |
|---|---|
| `~/.local/bin/device-mcp` | Daemon |
| `~/.config/device-mcp/config.json` | `serverUrl`, `token` und `autoUpdate` (chmod 600) |
| `~/.config/device-mcp/env` | Linux: PATH aus der Shell beim Installieren |
| `~/.config/systemd/user/device-mcp.service` | Linux: systemd-Unit |
| `~/Library/LaunchAgents/dev.onemo.device-mcp.plist` | macOS: LaunchAgent, enthält auch den PATH |
| `~/Library/Logs/device-mcp.log` | macOS: Log |
| `~/.local/state/device-mcp/update.json` | Nur nach einem fehlgeschlagenen Update: Version, Zeitpunkt, Fehler |
| `~/.local/state/device-mcp/jobs/` | Status und Ausgabe der Jobs (letzte 300, höchstens 14 Tage) |
| `~/.claude-tools/` | Helfer-Scripts von Claude mit README |

Umgebungsvariablen zum Testen: `DEVICE_MCP_CONFIG` (Pfad zur Config), `DEVICE_MCP_STATE_DIR` (Job-Ordner), `DEVICE_MCP_NO_UPDATE=1` (kein Auto-Update). `DEVICE_MCP_SUPERVISED=1` setzen die Unit und die plist: Nur dann beendet sich der Daemon nach einem Update selbst.

## Verhalten

- **Verbindung:** wss auf `<serverUrl>/daemon/ws`. Der Token geht in der ersten Nachricht (`hello`) mit, nicht in der URL. Heartbeat alle 15 s; kommt vom Server länger als 45 s nichts, baut der Daemon die Verbindung neu auf.
- **Reconnect:** exponentieller Backoff von 1 s bis 60 s mit Streuung. Abgelehnter Token: neuer Versuch alle 5 min, deaktiviertes Gerät: jede Minute.
- **Auto-Update:** Nach jedem `welcome` (mit 5 bis 20 s Streuung) und alle sechs Stunden holt der Daemon `<serverUrl>/download/manifest.json`. Ist die Version dort neuer, lädt er `device-mcp-<platform>-<arch>.gz`, entpackt im Strom, prüft Größe und SHA-256, startet das neue Binary mit `--version`, ersetzt sich per `rename` und beendet sich, sobald kein Job mehr läuft; systemd bzw. launchd startet neu. Nur das kompilierte Binary tut das (`bun run dev` nie), kein Downgrade, nach einem Fehler dieselbe Version frühestens nach einer Stunde. Abschalten: `"autoUpdate": false` in der Config. Code in `src/update.ts`.
- **Jobs:** Jeder Befehl ist ein Job in einer eigenen Prozessgruppe (`bash -c`, ohne TTY, stdin leer). Die Ausgabe landet auf der Platte, deshalb überleben Jobs und Ausgabe einen Verbindungsabbruch. Nach dem Reconnect meldet der Daemon den Stand aller Jobs. Timeout und `kill_job` schicken SIGTERM an die ganze Gruppe, nach 5 s SIGKILL. Ein Neustart des Daemons beendet laufende Jobs.
- **Ausgabe:** Farbcodes werden entfernt, Fortschrittsbalken mit `\r` auf den letzten Stand gekürzt, Zeilen über 2000 Zeichen gekürzt. Pro Job höchstens 64 MB Log.
- **Dateien:** Text zeilenweise mit offset/limit, PNG/JPEG/GIF/WebP als Bild (höchstens 3,75 MB), andere Binärdateien werden nur beschrieben; mit `encoding: base64` kommen Rohdaten in Stücken (höchstens 1 MB pro Aufruf). Schreiben legt fehlende Ordner an, höchstens 16 MB pro Aufruf.
- **edit_file:** ersetzt `old_string` durch `new_string`, nur wenn es genau einmal vorkommt (oder mit `replace_all`). Symlinks werden aufgelöst. Geschrieben wird über eine Temp-Datei im selben Ordner plus `rename`, mit den Rechten (und wenn möglich dem Besitzer) der alten Datei. Ist nur die Datei beschreibbar, der Ordner aber nicht, wird in place geschrieben. Hardlinks verlieren beim `rename` die Verbindung. Hat die Datei durchgehend CRLF, werden `\n` in den Strings angeglichen.
- **Sessions:** tmux-Sessions mit Präfix `mcp-` auf dem normalen tmux-Socket, also mit `tmux attach -t mcp-…` beobachtbar. Gestartet über `systemd-run --user --scope`, damit der tmux-Server nicht in der Cgroup des Daemon-Service landet und dessen Neustart übersteht (ohne systemd-run geht es auch, dann ohne diese Garantie). Unter macOS übersteht tmux den Neustart ohne Zutun, launchd beendet nur die Prozessgruppe des Daemons. Mit `command` bleibt der Bildschirm nach dem Ende lesbar (`remain-on-exit`), `session_read` liefert dann Exit-Code und Verlauf. Gelesen wird mit `capture-pane -p -J`, also ohne Farbcodes. Erlaubte Tasten: Enter, Tab, BTab, Escape, BSpace, Space, Pfeile, Home/End, PageUp/PageDown, Insert/Delete, F1–F12, einzelne Zeichen, jeweils auch mit `C-`, `M-`, `S-`.

Das Nachrichtenformat steht in `src/protocol.ts`, das Gegenstück im Server in `server/src/services/protocol.ts`. Änderungen immer in beiden Repos nachziehen.

## Entwickeln

```bash
bun install
bun run typecheck
bun test                 # edit_file, Auto-Update und tmux-Sessions (Session-Tests werden ohne tmux übersprungen)
bun run build            # dist/device-mcp-{linux,darwin}-{x64,arm64}, jeweils auch .gz, dazu dist/manifest.json
bun run build.ts arm64   # nur eine Architektur (oder linux, darwin, linux-arm64 …)
```

Gegen einen lokalen Server laufen lassen, ohne Installation:

```bash
printf '{"serverUrl":"http://127.0.0.1:3100","token":"dmcp_…"}' > /tmp/dmcp.json && chmod 600 /tmp/dmcp.json
DEVICE_MCP_CONFIG=/tmp/dmcp.json DEVICE_MCP_STATE_DIR=/tmp/dmcp-state bun run dev
```

## Ausrollen

Der Server baut den Daemon beim Deploy aus dem Commit, auf den sein Submodule zeigt:

```bash
# hier committen und pushen, dann im Server-Repo:
git submodule update --remote daemon
git commit -am "Daemon aktualisiert" && git push   # Coolify baut neu
```

Vorher `VERSION` in `src/version.ts` erhöhen: Nur eine höhere Version löst das Auto-Update aus. Nach dem Deploy holen sich die Geräte das neue Binary selbst, sobald kein Job mehr läuft. Daemons vor 0.3.0 brauchen das Install-Script ein letztes Mal von Hand. Ältere Daemons bekommen für neue Tools vom Server die Meldung „Daemon-Version zu alt“. `VERSION` in `src/version.ts` und die Mindestversionen in `server/src/services/guards.ts` gehören zusammen.
