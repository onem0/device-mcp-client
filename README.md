# device-mcp-client

Der Daemon von [device-mcp](https://github.com/onem0/device-mcp-server). Er läuft auf jedem Linux-Gerät, das Claude erreichen soll, baut von sich aus eine WebSocket-Verbindung (wss) zum Server auf und führt dessen Aufträge aus: Befehle über `bash -c`, Hintergrundjobs, Dateien lesen und schreiben.

Gebaut wird er mit `bun build --compile` als Single-Binary für linux-x64 und linux-arm64. Auf dem Gerät ist keine Runtime nötig. Der Server baut die Binaries aus diesem Repo (es ist dort als Submodule `daemon/` eingebunden) und liefert sie zusammen mit dem Installer aus.

## Installieren

Im Panel des Servers ein Gerät anlegen. Das Panel zeigt den Install-Befehl mit dem Geräte-Token genau einmal:

```bash
curl -fsSL https://device.onemo.dev/install.sh | DEVICE_MCP_TOKEN='dmcp_…' bash
```

Als normaler Benutzer ausführen, nicht als root: Der Daemon läuft als genau dieser Benutzer. Das Script legt Binary, Config, `~/.claude-tools/README.md` und einen systemd-User-Service mit `Restart=always` an und setzt `loginctl enable-linger`, damit der Daemon nach einem Reboot ohne Anmeldung startet.

Voraussetzungen: Linux mit systemd, x86_64 oder aarch64, `curl`, `gzip`.

## Bedienen

```bash
systemctl --user status device-mcp      # Status
journalctl --user -u device-mcp -f      # Log
systemctl --user restart device-mcp     # Neustart
curl -fsSL https://device.onemo.dev/install.sh | bash   # Update, der Token bleibt
device-mcp-uninstall                    # Entfernen (~/.claude-tools bleibt)
device-mcp --version
```

| Pfad | Inhalt |
|---|---|
| `~/.local/bin/device-mcp` | Daemon |
| `~/.config/device-mcp/config.json` | `serverUrl` und `token` (chmod 600) |
| `~/.config/device-mcp/env` | PATH aus der Shell beim Installieren |
| `~/.config/systemd/user/device-mcp.service` | systemd-Unit |
| `~/.local/state/device-mcp/jobs/` | Status und Ausgabe der Jobs (letzte 300, höchstens 14 Tage) |
| `~/.claude-tools/` | Helfer-Scripts von Claude mit README |

Umgebungsvariablen zum Testen: `DEVICE_MCP_CONFIG` (Pfad zur Config), `DEVICE_MCP_STATE_DIR` (Job-Ordner).

## Verhalten

- **Verbindung:** wss auf `<serverUrl>/daemon/ws`. Der Token geht in der ersten Nachricht (`hello`) mit, nicht in der URL. Heartbeat alle 15 s; kommt vom Server länger als 45 s nichts, baut der Daemon die Verbindung neu auf.
- **Reconnect:** exponentieller Backoff von 1 s bis 60 s mit Streuung. Abgelehnter Token: neuer Versuch alle 5 min, deaktiviertes Gerät: jede Minute.
- **Jobs:** Jeder Befehl ist ein Job in einer eigenen Prozessgruppe (`bash -c`, ohne TTY, stdin leer). Die Ausgabe landet auf der Platte, deshalb überleben Jobs und Ausgabe einen Verbindungsabbruch. Nach dem Reconnect meldet der Daemon den Stand aller Jobs. Timeout und `kill_job` schicken SIGTERM an die ganze Gruppe, nach 5 s SIGKILL. Ein Neustart des Daemons beendet laufende Jobs.
- **Ausgabe:** Farbcodes werden entfernt, Fortschrittsbalken mit `\r` auf den letzten Stand gekürzt, Zeilen über 2000 Zeichen gekürzt. Pro Job höchstens 64 MB Log.
- **Dateien:** Text zeilenweise mit offset/limit, PNG/JPEG/GIF/WebP als Bild (höchstens 3,75 MB), andere Binärdateien werden nur beschrieben. Schreiben legt fehlende Ordner an, höchstens 16 MB pro Aufruf.

Das Nachrichtenformat steht in `src/protocol.ts`, das Gegenstück im Server in `server/src/services/protocol.ts`. Änderungen immer in beiden Repos nachziehen.

## Entwickeln

```bash
bun install
bun run typecheck
bun run build            # dist/device-mcp-linux-x64 und -arm64, jeweils auch .gz
bun run build.ts arm64   # nur eine Architektur
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

Danach auf den Geräten das Install-Script erneut ausführen (siehe oben), um das neue Binary zu holen.
