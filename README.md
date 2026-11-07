# Open Dub Runtime

A small self-hosted browser runtime for locally installed Dub Together Workshop packs. This is an independent open-source application: it does not contain or copy Dub Together code, interface, or bundled media.

Players record their own assigned lines **independently and in parallel**. There is no global recording turn or current line. Hosts choose Character mode, which assigns all lines for a character to one player, or Line mode, which gives each recording task its own owner and can give one character several voices. An unfinished line can be revisited, and an accepted take can be replaced with a player retake while other players continue. Characters can outnumber players, and there is no hardcoded eight-player limit.

## Custom voice effect (requires FFmpeg)

The **Custom** effect applies a supported FFmpeg audio filter chain to a recorded
line **on the host after recording**, before the processed WebM is previewed or
uploaded as the take. This is not a live microphone effect; the server must have
`ffmpeg` installed (or configured with `FFMPEG_PATH`). On failure, the raw audio
is not saved and a previous take is restored if one existed.

Custom accepts only `-af` (or `-filter:a`) followed by at most six allowlisted
audio filters, with numeric parameters. For example:

```text
-af highpass=f=250,acrusher=bits=6:mix=0.8
-af vibrato=f=6:d=0.8,volume=1.3
-af aecho=in_gain=0.8:out_gain=0.9:delays=200:decays=0.5
-af tremolo=f=8:d=0.8,lowpass=f=3500
```

Allowed: `volume` (0–3), `highpass` (40–8000 Hz), `lowpass` (100–18000 Hz),
`atempo` (0.75–1.5), `vibrato` (f=0.1–12, d=0–1), `tremolo` (f=0.1–15, d=0–1),
`acrusher` (bits=2–16, mix=0–1), and `aecho` (in_gain=0–1,
out_gain=0–1, delays=20–600 ms, decays=0–0.8).

**Security:** Arbitrary FFmpeg CLI switches, scripts, expressions, file/URL
filters, and complex filtergraph syntax are deliberately unsupported. Every
value is checked against a fixed numeric schema, then the server constructs
the graph and uses `spawn` without a shell. Processing is capped at two
concurrent jobs, a 15-second timeout, and limited input/output size and
duration. FFmpeg still parses untrusted audio; run the service under an
unprivileged account or container for additional isolation.

## Run locally

Install Node.js 22 or newer and npm. Then:

```sh
npm install
WORKSHOP_DIR="/path/to/steamapps/workshop/content/GAME_ID" npm start
```

Point `WORKSHOP_DIR` at the directory containing your installed pack directories, or at a single pack directory. Workshop downloading is optional and requires SteamCMD; you can also supply packs through an existing authorized Steam installation. This runtime does not publish packs.

Startup prints a local admin address; it never logs the token. Run `node bin/opendub-auth --data-dir "${DATA_DIR:-./data}"`, then open `http://localhost:7373/admin`, enter that token, create a party, and share its invitation. Players can join before you choose a pack. Keep the admin token private. Packs and recordings stay on the host computer.

Typical host workflow:

1. Create a party and share its invitation. Players may join while the host chooses a pack.
2. Filter discovered packs by title and character count, then choose a pack for the next match.
3. Choose the game mode during setup. In Character mode, assign characters manually or distribute them automatically. In Line mode, use **Deal lines** to shuffle every task across the players connected at that moment; you can also assign or move individual lines. Counts differ by at most one after a deal, and every player's queue stays chronological.
4. Start recording after every line has an owner. In Line mode, players with no assigned lines wait without microphone setup or READY.
5. Check each player's progress and listen to uploaded takes. Request host retakes or move characters or lines as needed. Moving an accepted line keeps the accepted take and its original recorder attribution; an unfinished candidate is cleared.
6. Start final playback when every required line has an accepted take. Starting with missing lines requires an explicit host choice.
7. Choose **Next match** from review or final playback to return the same players to the party waiting screen. Choose the same or another pack to start a fresh match.

The party invitation, player credentials, nicknames, connections, and host settings, including the selected game mode, last across matches. Each match gets a new match ID; its assignments, readiness, queues, takes, and playback are cleared. Assignment locks the mode for that match. Change it from setup for the next match. **Replace party** invalidates the old invitation and player credentials. Restarting the server clears the party and recordings.

## Player workflow

Open the host's invitation, enter your nickname, and optionally pick a color and one of 40 built-in avatars (your choice is remembered in this browser). You can change your look any time before final playback with **EDIT LOOK**; colors are unique among players until all 12 are taken, after which players share colors with a dot or stripe marker. The host's lists, the role and line assignment rows, and the speaker badge during final playback all show your chip. Hosts who participate open the same public invitation and use the same Player UI as everyone else. In Character mode, you can choose or release characters during role selection; each character shows its task count and owner. In Line mode, the host assigns individual lines and your screen shows your line count and character summary. You need at least one assigned line to set up the microphone and press **READY**. Players with no lines wait without microphone setup.

The **SOUNDPAD** button beneath the recording controls imports a local MP3, WAV, OGG, WebM, M4A, or FLAC audio clip instead of using the microphone. FFmpeg on the host converts the clip to mono WebM; clips longer than the line plus 2 seconds are trimmed. After conversion, **MY TAKE**, the cyan waveform, saving, **NEXT**, replacement retakes, and the final export all work exactly like a voice recording. An import failure preserves any previous take. Filenames and FFmpeg commands from uploads are never executed.

During recording and on **DONE**, the native **Go to your line** picker lists your assigned lines in chronological order, with line number, character, shortened caption, and completion status. Selecting a line opens its scene and reference audio. Browsing accepted lines does not change completion. **RECORD** records an unfinished line; on an accepted line it starts a replacement retake. **MY TAKE** plays the replacement when one is saved, otherwise the accepted take. Press **NEXT** to accept a successfully saved take. For a replacement, NEXT atomically replaces the accepted take; until then the accepted version stays in use. Use **Cancel retake** to keep the accepted version. Leaving with an unaccepted take asks before discarding it; line switching is disabled during capture and acceptance.

The effect selector includes **AUTO-TUNE**, a strong chromatic correction to the nearest equal-tempered note using A4 = 440 Hz. It corrects voiced pitch and lets silence and unvoiced sounds pass through. The effect is baked into the saved audio. If the browser cannot run the audio worklet needed for tuning, AUTO-TUNE is disabled with an explanation. The comparison shows the original in purple and your full take in cyan; the live microphone meter remains separate. The **Amplify microphone** slider ranges from 0% to 300% and remembers your setting in this browser. After the optional countdown, the microphone starts before the scene, and the scene begins after a 0.18-second lead-in. The capture cursor, progress bar, and the actual MediaRecorder stop all share the same monotonic deadline, including the MP3 overhang and voice-effect tail; the take review appears 0.2 seconds later while saving can continue in the background. A failed save can retry without losing the local take.

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

Keep admin tokens private: public admin APIs require the token (or a configured WireGuard IP bypass). Player credentials do not authorize admin requests. The runtime checks browser origins against its connection scheme and Host header. An HTTPS proxy can forward over HTTP through WireGuard when `TRUSTED_PROXY` contains the VPS's WireGuard source IP and the proxy preserves Host and sets `X-Forwarded-Proto: https`. A verified HTTPS upstream also works. Follow [Desktop + VPS as Proxy](docs/DESKTOP_VPS_PROXY.md) for Nginx/NixOS configuration, scoped firewall rules, and invitation URLs. There is no relay service in this MVP.

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

The runtime accepts environment variables; see startup output for the effective bind address. `WORKSHOP_DIR` selects the pack root. `DATA_DIR` selects runtime file storage for recordings and the optional video cache (default `./data`). Room state stays in memory and recordings are cleared when the server restarts. `HOST` and `PORT` control the listener (defaults `0.0.0.0` and `7373`). `PUBLIC_LINK` optionally sets the public HTTP(S) origin used in copied player join links, for example `https://dub.example.com`; a trailing slash is ignored. When unset, join links use the address opened in the host studio. `PUBLIC_LINK` does not grant proxy trust. `TRUSTED_PROXY` is an optional comma-separated list of exact proxy source IP addresses, for example `10.77.0.1`; it permits those peers to supply a single `http` or `https` value in `X-Forwarded-Proto` for origin checks and Secure cookies. Other peers' forwarded headers are ignored. Do not put the desktop's address or a subnet here. A trusted proxy may also send an overwritten `X-Real-IP`; only addresses explicitly listed in `WG_ADMIN_CIDRS` are granted no-token admin access. `ADMIN_TOKEN` remains a compatibility override, but normal deployments use the persistent randomly generated `DATA_DIR/admin-token` managed with `opendub-auth`. Never put the admin token in the Nix store.

`PREVIEW_BEFORE` and `PREVIEW_AFTER` set preview padding in seconds; defaults are 1.5 and 0.5. Padding affects preview only: microphone takes start at the line timestamp so padding cannot shift the final mix. `MAX_UPLOAD_MB` sets the per-take size limit (default 25 MiB). `TLS_CERT` and `TLS_KEY` must be provided together. `TRANSCODE_VIDEO=1` enables whole-video MP4 caching; `FFMPEG_PATH` selects the executable.

`WORKSHOP_MAX_FILES` and `WORKSHOP_MAX_BYTES` limit each Workshop pack during import (defaults: 10000 files and 10737418240 bytes / 10 GiB). Both must be positive safe integers. Each line usually adds an INI and an MP3, so large packs can contain thousands of files. For NixOS use `services.opendub.workshopMaxFiles` and `services.opendub.workshopMaxBytes`. Limit errors identify the exceeded limit and its setting; adjust it and retry the download. Allow disk space for both the SteamCMD cache and the imported copy, plus any video conversion cache.

Uploaded recordings have a size limit and their media type is validated. The server serves only allowlisted files in the selected pack and authenticated recordings. It does not provide arbitrary filesystem access.

## Development

```sh
npm test
```

Tests create synthetic packs and cover party and match lifecycle, both assignment modes, shuffled equal line deals, per-line authorization, reassignment and progress, stale uploads, replacement-retake identity, cancellation and completion waits, chromatic pitch analysis, pack counts and filters, role conflicts and limits, microphone gain routing, both recording waits, waveform overlays, pending button states, export outcomes, playback timing, and server security. They do not redistribute or require third-party Workshop media. See [docs/DESIGN.md](docs/DESIGN.md) for models, HTTP/WebSocket messages, state transitions, and timing decisions; see [docs/VALIDATION.md](docs/VALIDATION.md) for coverage and browser-test limits.

Workshop publishing, external accounts and cloud storage are outside this runtime; FFmpeg export is implemented.

## License

Runtime source is licensed under the MIT License; see [LICENSE](LICENSE). User-provided Workshop content, including any pre-existing `example_pack/` directory, is excluded from that license. Pack authors retain their own rights. Do not redistribute Workshop media unless you have permission. This project is not affiliated with or endorsed by Dub Together.

## Live recording waveform and uncropped voice edges

The purple original waveform is visible before recording, and a cyan trace grows
across it live from the processed microphone audio during the take. Recording
now primes the MediaRecorder **before** the video cue and keeps the microphone
open after the cue finishes. Browser noise suppression and auto gain control are disabled for this recorder,
as their voice activity gating can cut quiet first/last syllables (headphones are
recommended to prevent feedback). The measured lead-in and allowed tail are stored
with the take (legacy takes use zero padding) and used for host/player playback
and exported MP4 audio. Custom FFmpeg remains post-processing, so its live cyan
trace shows the incoming recording rather than the resulting FFmpeg effect.

## Standalone NixOS / VPS hosting (2026)

The runtime can now be deployed directly on a VPS: no desktop relay required. It ships a Nix flake, `services.opendub` NixOS module, HTTPS Nginx integration, Workshop download API/UI (SteamCMD), and the persistent `opendub-auth` admin token utility. The public admin page requires a token; a specifically allowed WireGuard network can bypass it. Read [docs/NIXOS_STANDALONE.md](docs/NIXOS_STANDALONE.md) for a full example on NixOS host `pussy`, including the [Patchouli Deployment](https://zenisoft.net.ua/projects/patchouli-deployment/) webhook/flake input workflow.

To run standalone outside NixOS, set `DATA_DIR` to a persistent writable directory, `WORKSHOP_DIR` to a writable packs directory, `PUBLIC_LINK` to the public HTTPS origin, `HOST=127.0.0.1`, and `TRUSTED_PROXY` to the exact Nginx source IP (usually `127.0.0.1`). Set `STEAMCMD_PATH` (and optionally `STEAMCMD_DIR`, `STEAMCMD_USERNAME`) to enable Workshop downloading. Set `WORKSHOP_APP_ID` to the game’s Steam App ID (default `5020310` for Dub Together), `STEAMCMD_DIR` to the persistent SteamCMD cache, and `WORKSHOP_DIR` to the destination for validated packs. To authorize a purchased Steam account on NixOS, set `services.opendub.steamcmdUsername`, rebuild, and run `sudo -u opendub -H opendub-steam login YOUR_STEAM_LOGIN`; never pass a password through the application or Nix config. Set `WG_ADMIN_CIDRS=10.77.0.0/24` only when you intend a WireGuard no-token admin bypass and ensure your proxy **overwrites** `X-Real-IP`. The server generates a persistent admin token in `DATA_DIR/admin-token`; run `node bin/opendub-auth --data-dir "$DATA_DIR"` to display it and `--rotate` to immediately revoke it. Never publish that token in environment files, URLs, build logs or CI.
