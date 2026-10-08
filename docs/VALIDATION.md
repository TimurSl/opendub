# MVP validation

Validation performed on 2026-10-04.

## Automated server and timeline checks

The parent reran `npm test` on 2026-10-04; all **82 tests** passed. Synthetic packs, a stubbed AudioWorklet, and browser-state mocks exercise:

- UTF-8 metadata, chronological/overlapping lines, multi-entry timing envelopes, malformed arrays, and unsafe asset paths.
- Three players uploading different assigned lines concurrently and in shuffled order, with independent progress.
- Twelve-player joining, Character-mode distribution, ownership enforcement, candidate acceptance, retakes, and reassignment.
- Character-mode defaults, mode selection and setup locking, remembered settings across matches, and rejection of assignment actions from the other mode.
- Line-mode round-robin deals for divisible, uneven, and fewer-tasks-than-players cases; no-connected-player rejection; disconnected and late joiners; readiness clearing and unlock on redeal; and chronological personal queues.
- Per-line upload ownership and progress, manual moves during recording, pause, and review, accepted-take provenance retention, unaccepted candidate cleanup, active-retake invalidation, and stale replacement uploads after reassignment.
- Player retake identity and ownership checks, same-attempt start retry recovering its retake ID, competing-attempt rejection, replacement privacy and media access, failed replacement preservation, explicit cancellation, last-socket disconnect, host pause/reopen/retake cleanup, and review/playback waiting for active retakes.
- Preservation of accepted takes during a server run and deletion of obsolete files.
- Separate admin/player authorization, protected media, encoded admin paths, upload limits/signatures, origin checks, and WebSocket validation.
- An incomplete multipart upload rejected after a host retake invalidates its line generation.
- A party created before pack selection, one persistent player/WebSocket across two packs and same-pack replay, settings retention and character-limit clamping, clean readiness/role/take/playback reset, explicit party replacement, and stale upload rejection after a match change.
- Ordered per-character task counts, title and character-count filters combined locally, and empty filter results.
- Competing character claims, role limits, release, readiness reset after role changes, host-only assignment mode, and locked roles.
- Delayed state from an older match or replaced party arriving during a pending action, rejected by the client while snapshots from a restarted server are accepted.
- Pending action buttons keep their busy state across broadcasts and restore the latest label, eligibility, and pressed state after success or failure.
- Microphone gain persistence and capture/meter graph placement without speaker routing; both 0.2-second waits and cancellation before capture; overlaid time-domain waveforms, longer takes, video-audio fallback, stale decode rejection, and decode-failure recovery.
- Export route success and failure using a fake ffmpeg executable, with failed temporary work removed.
- Shared audio-clock positions, overlapping voices, late joining, duration clipping, and exhausted playback windows.
- Player playback preloading, the single accessible PLAY/PAUSE control, latest-state preparation races, pause/completion suppression, and friendly retry errors.
- Recorder automatic saving with acceptance gated by NEXT, replacement cancellation recovery, accepted-take playback until replacement commit, stale upload completion, host-retake invalidation, and AUTO-TUNE availability messaging.
- Pure pitch helper checks for detuned voiced tones, chromatic snapping against A4 = 440 Hz, silence, noise, invalid values, and fresh recording windows; a stubbed worklet check covers 450-to-330 Hz transitions, state reset, finite output, and unchanged frame count.
- Configured padding for ORIGINAL reference previews and exact line windows for MY TAKE playback.

These tests use synthetic content and do not require or redistribute Workshop media. HTTP tests check recording-container signatures; they do not claim that arbitrary media payloads decode successfully.

## Earlier browser vertical slice (historical)

The following Firefox checks cover the earlier player workflow and used simulated microphone input. They predate the lasting-party, microphone-gain, and overlaid-waveform changes below; they do not validate those newer browser behaviors.

A headless Firefox smoke test used a synthetic pack with six lines, three distinct player sessions, browser `MediaRecorder`, simulated microphones, and an isolated PulseAudio dummy output.

The browser test recorded three different assigned lines simultaneously. One player retook a line while the others advanced. All six takes were accepted, and each player's dashboard reached `2 / 2`. The recorded Ogg takes decoded through Web Audio. Shared final playback used muted video, backing audio, and scheduled accepted takes; sampled visual/audio timeline drift was below 0.4 seconds. Stopping playback locally remained effective after another snapshot of the same playback state. Host and player screenshots were inspected.

## Player interface redesign

A second localhost Firefox smoke test exercised the simplified interface with simulated microphones and the dummy audio output. Invitations required only a nickname; READY requested microphone access. The recorder exposed exactly four controls. Desktop and mobile viewport screenshots showed no horizontal overflow.

Three browser players recorded simultaneously. An injected one-time save failure retried automatically, refreshing restored the saved candidate, and cancelling a replacement preserved the previous take. ORIGINAL and MY TAKE replayed the corresponding visuals; ORIGINAL included the configured padding. A repeat check verified the visible idle waveform, native recording progress, and an explicit STOP producing a valid shortened take. All six takes were accepted and players reached DONE.

The final viewer started automatically with one PLAY/PAUSE button, muted visuals, and sampled timeline drift below 0.5 seconds. PAUSE remained effective after another snapshot of the same playback descriptor. Opening the public player page with a host admin cookie still required joining as a player and exposed no admin controls. These checks used simulated input and localhost; they do not add evidence of real microphones or a deployed public proxy.

## Limits of this evidence

The browser checks validate the earlier recording and playback workflow with simulated input. Human microphones, speech quality, device latency, and synchronization across physical machines have not been tested. Firefox and Chromium executables were unavailable on the sandbox PATH for this update, so the current party flow, Character and Line player navigation, replacement-retake picker/discard interactions, AUTO-TUNE audio quality, real microphone gain, waveform rendering, and current media behavior were not smoke-tested in either browser. The worklet test stubs browser audio APIs and does not establish speech quality or device compatibility. Real packs and mixed browser codecs still need compatibility checks on the participating devices.

The browser smoke test ran through localhost. The [Desktop + VPS as Proxy](DESKTOP_VPS_PROXY.md) guide has not been deployed or tested against a real VPS, WireGuard tunnel, public certificate, or external player network. Validate the Caddy configuration and upstream certificate on your own deployment before sharing invitations.
