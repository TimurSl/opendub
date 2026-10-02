# MVP validation

Validation performed on 2026-10-03. The restart test was updated afterward to expect an empty room and removed take files; the suite has not been rerun after that change.

## Automated server and timeline checks

`npm test` passed all **42 tests**. Synthetic packs and browser-state mocks exercise:

- UTF-8 metadata, chronological/overlapping lines, multi-entry timing envelopes, malformed arrays, and unsafe asset paths.
- Three players uploading different assigned lines concurrently and in shuffled order, with independent progress.
- Twelve-player joining, character distribution, ownership enforcement, candidate acceptance, retakes, and reassignment.
- Preservation of accepted takes during a server run and deletion of obsolete files.
- Separate admin/player authorization, protected media, encoded admin paths, upload limits/signatures, origin checks, and WebSocket validation.
- An incomplete multipart upload rejected after a host retake invalidates its line generation.
- Shared audio-clock positions, overlapping voices, late joining, duration clipping, and exhausted playback windows.
- Player playback preloading, the single accessible PLAY/PAUSE control, latest-state preparation races, pause/completion suppression, and friendly retry errors.
- Recorder automatic saving with acceptance gated by NEXT, replacement cancellation recovery, stale upload completion, and host-retake invalidation.
- Configured padding for ORIGINAL reference previews and exact line windows for MY TAKE playback.

These tests use synthetic content and do not require or redistribute Workshop media. HTTP tests check recording-container signatures; they do not claim that arbitrary media payloads decode successfully.

## Browser vertical slice

A headless Firefox smoke test used a synthetic pack with six lines, three distinct player sessions, browser `MediaRecorder`, simulated microphones, and an isolated PulseAudio dummy output.

The browser test recorded three different assigned lines simultaneously. One player retook a line while the others advanced. All six takes were accepted, and each player's dashboard reached `2 / 2`. The recorded Ogg takes decoded through Web Audio. Shared final playback used muted video, backing audio, and scheduled accepted takes; sampled visual/audio timeline drift was below 0.4 seconds. Stopping playback locally remained effective after another snapshot of the same playback state. Host and player screenshots were inspected.

## Player interface redesign

A second localhost Firefox smoke test exercised the simplified interface with simulated microphones and the dummy audio output. Invitations required only a nickname; READY requested microphone access. The recorder exposed exactly four controls. Desktop and mobile viewport screenshots showed no horizontal overflow.

Three browser players recorded simultaneously. An injected one-time save failure retried automatically, refreshing restored the saved candidate, and cancelling a replacement preserved the previous take. ORIGINAL and MY TAKE replayed the corresponding visuals; ORIGINAL included the configured padding. A repeat check verified the visible idle waveform, native recording progress, and an explicit STOP producing a valid shortened take. All six takes were accepted and players reached DONE.

The final viewer started automatically with one PLAY/PAUSE button, muted visuals, and sampled timeline drift below 0.5 seconds. PAUSE remained effective after another snapshot of the same playback descriptor. Opening the public player page with a host admin cookie still required joining as a player and exposed no admin controls. These checks used simulated input and localhost; they do not add evidence of real microphones or a deployed public proxy.

## Limits of this evidence

The browser check validates the recording and playback workflow with simulated input. Human microphones, speech quality, device latency, and synchronization across physical machines have not been tested. Real packs and mixed browser codecs still need compatibility checks on the participating devices.

The browser smoke test ran through localhost. The [Desktop + VPS as Proxy](DESKTOP_VPS_PROXY.md) guide has not been deployed or tested against a real VPS, WireGuard tunnel, public certificate, or external player network. Validate the Caddy configuration and upstream certificate on your own deployment before sharing invitations.
