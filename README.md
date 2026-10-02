# Open Dub Runtime

A small self-hosted browser runtime for locally installed Dub Together Workshop packs. This is an independent open-source application: it does not contain or copy Dub Together code, interface, or bundled media.

Players record their own assigned lines **independently and in parallel**. There is no global recording turn or current line. One player can retake a line while everybody else continues. Characters can outnumber players, and each player can own several characters. There is no hardcoded eight-player limit.

## Run locally

Install Node.js 22 or newer and npm. Then:

```sh
npm install
WORKSHOP_DIR="/path/to/steamapps/workshop/content/GAME_ID" npm start
```

Point `WORKSHOP_DIR` at the directory containing your installed pack directories, or at a single pack directory. Obtain Workshop content through your own authorized installation; this runtime does not download or publish packs.

Startup prints a local admin address and a separate admin token. Open `http://localhost:7373/admin`, enter that token, and select a pack. Share the join link from the host interface with players. Keep the admin token private. Packs and recordings stay on the host computer.

Typical host workflow:

1. Select a discovered pack and check its metadata and characters.
2. Let players join with their nicknames.
3. Assign characters manually or distribute them automatically.
4. Start recording. Every player works through their own chronological queue.
5. Check each player's progress and listen to uploaded takes. Request retakes or reassign characters as needed.
6. Start final playback when every required line has an accepted take. Starting with missing lines requires an explicit host choice.

Accepted recordings survive disconnection and character reassignment while the server is running. Unfinished lines stay pending. Restarting the server creates a new empty room and deletes the previous room's recordings.

## Player workflow

Open the host's invitation and enter your nickname. Once your characters appear, press **READY** and allow microphone access. Your browser shows one assigned line at a time while everyone else follows their own queue.

Use **ORIGINAL** to watch the scene with its reference audio, **RECORD** to record or retake it, and **MY TAKE** to watch your version. Recording shows a countdown and microphone waveform; the recording button becomes **STOP** while capturing. Takes save in the background. Press **NEXT** to accept your take and advance your queue. A failed save can retry without losing the local take.

After your last line, **DONE** appears while the remaining players finish. Final playback loads quietly and starts when the host starts the dub. Its only control is **PLAY / PAUSE**. Press PLAY if your browser needs another gesture to enable sound; resuming catches up to the shared movie timeline.

## LAN access and microphones

The server listens on port 7373 by default. Allow that port in the host's firewall. Players can browse `http://HOST_LAN_IP:7373` and open the room join link.

**Microphone capture requires a secure browser context.** `http://localhost` is allowed for local testing, but ordinary HTTP on another machine's LAN address usually cannot access a microphone. For remote players, use the runtime's built-in HTTPS listener with a certificate their browsers trust:

```sh
WORKSHOP_DIR="/path/to/workshop/packs" \
TLS_CERT="/path/to/certificate.pem" \
TLS_KEY="/path/to/private-key.pem" \
npm start
```

The certificate must cover the hostname or IP address in the join URL. A locally issued certificate requires trusting its certificate authority on each client; clicking through a certificate warning may not grant microphone access. Tools such as `mkcert` can issue local certificates, but clients still need to trust the issuer. Use `https://localhost:7373/admin` on the host and share `https://HOST_LAN_IP:7373` links with players. The player interface explains secure-context and permission failures.

Keep admin access local: log in through localhost. Player credentials do not authorize admin requests. The runtime checks browser origins against its actual transport and Host header. A VPS can expose the player app through your existing WireGuard tunnel using Caddy, a verified **HTTPS upstream**, and the preserved public Host header. Follow [Desktop + VPS as Proxy](docs/DESKTOP_VPS_PROXY.md) for certificates, scoped firewall rules, public admin-route blocking, and invitation URLs. An HTTPS proxy terminating into an HTTP upstream is not supported by the current origin policy. There is no relay service in this MVP.

## Pack compatibility

```text
Pack/
  _pack_info.ini
  _backing_track.ogg
  dub_video.ogv
  Icon.png
  01_some_line.ini
  01_some_line.mp3
```

The parser reads `[data]` values for `title`, `icon`, `authors`, `language`, `caption`, `dub_timestamps`, `dub_ends`, and `dub_characters`. It preserves multi-entry timing arrays. One INI file is one recording task in this MVP. Multiple segments for the same character use a single timing envelope; a file containing different characters is rejected with a discovery error until segment-level recording is available.

Line order follows source timestamps, including valid overlapping lines. The matching MP3 is optional reference playback only. It never replaces a player's accepted take. Final playback uses muted video visuals, the dialogue-free backing track, and accepted takes positioned by Workshop timestamps through one Web Audio timeline.

Browser support for Ogg/Theora video, Ogg audio, microphone recording, and Web Audio decoding varies. Current desktop Firefox and Chromium are the main targets; test your chosen pack and recording codec in every participating browser. Unsupported media fails visibly rather than silently using reference dialogue.

For browsers that cannot play the original OGV, install ffmpeg and enable an optional whole-video conversion:

```sh
WORKSHOP_DIR="/path/to/workshop/packs" TRANSCODE_VIDEO=1 npm start
```

Alternatively pass `npm start -- --transcode-video`. The runtime creates and serves a cached H.264 MP4 under the data directory, with audio removed. It reads the original `dub_video.ogv` without changing Workshop files and creates no per-line clips. This does not render a final dub. Set `FFMPEG_PATH` if ffmpeg is not on `PATH`.

## Configuration

The runtime accepts environment variables; see startup output for the effective bind address. `WORKSHOP_DIR` selects the pack root. `DATA_DIR` selects runtime file storage for recordings and the optional video cache (default `./data`). Room state stays in memory and recordings are cleared when the server restarts. `HOST` and `PORT` control the listener (defaults `0.0.0.0` and `7373`). `ADMIN_TOKEN` optionally supplies a stable admin secret instead of generating one. Store secrets outside version control.

`PREVIEW_BEFORE` and `PREVIEW_AFTER` set preview padding in seconds; defaults are 1.5 and 0.5. Padding affects preview only: microphone takes start at the line timestamp so padding cannot shift the final mix. `MAX_UPLOAD_MB` sets the per-take size limit (default 25 MiB). `TLS_CERT` and `TLS_KEY` must be provided together. `TRANSCODE_VIDEO=1` enables whole-video MP4 caching; `FFMPEG_PATH` selects the executable.

Uploaded recordings have a size limit and their media type is validated. The server serves only allowlisted files in the selected pack and authenticated recordings. It does not provide arbitrary filesystem access.

## Development

```sh
npm test
```

Tests create synthetic packs and exercise parsing, three-player parallel uploads, ownership, independent progress, retakes, reassignment, room security, upload validation, clean restart behavior, and playback windows. They do not redistribute or require third-party Workshop media. See [docs/DESIGN.md](docs/DESIGN.md) for models, HTTP/WebSocket messages, state transitions, and timing decisions.

Public relay, ffmpeg export, Workshop publishing, accounts, and cloud storage are outside this MVP.

## License

Runtime source is licensed under the MIT License; see [LICENSE](LICENSE). User-provided Workshop content, including any pre-existing `example_pack/` directory, is excluded from that license. Pack authors retain their own rights. Do not redistribute Workshop media unless you have permission. This project is not affiliated with or endorsed by Dub Together.
