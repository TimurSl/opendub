# Runtime design

This is an independent implementation of the Workshop content format. It uses no Dub Together application code, interface, or bundled assets. Workshop files remain external user-provided content.

## Format analysis

A pack is one directory containing `_pack_info.ini`, `dub_video.ogv`, `_backing_track.ogg`, an optional icon, and line INI files with optional matching reference MP3s. INI values use a small Godot-style subset: `[data]`, quoted UTF-8 strings, finite numbers, and arrays. Parse that subset explicitly; never execute pack text or evaluate expressions.

Metadata fields are `title`, `icon`, `authors`, and `language`. Line fields are `caption`, `dub_timestamps`, `dub_ends`, and `dub_characters`. Preserve every corresponding array entry as a segment so expansion to segment-level tasks does not require changing the parser. Initially one file is one task. A task with several segments for the same character can use the envelope from the earliest start to the latest end. A file naming several distinct characters is rejected with a clear discovery error until segment-level recording is implemented; silently assigning it to the first character would lose ownership information.

Pack summaries expose `characterLineCounts` in the same order as `characters`. Each value counts recording tasks after the existing parser rules are applied, so the values add up to `lineCount`. The host pack chooser shows named counts, filters immediately by title and minimum/maximum character count, and keeps those filter values in local browser storage across refreshes.

The supplied example has 58 line files, five distinct characters, UTF-8 Cyrillic text, single-entry arrays, and overlapping timestamps. Overlap is valid and final playback must mix overlapping takes. Filenames are not chronological authority: sort tasks by start time, then stable ID. `duration = endTime - startTime`; starts must be nonnegative and each end must exceed its corresponding start. Missing video/backing media, mismatched arrays, invalid numbers, malformed INI, unsafe asset paths, and symbolic links escaping the pack are rejected. An absent reference MP3 is allowed.

## Smallest useful structure

```text
server/
  workshop/       safe INI parser, discovery, asset manifest
  session/        in-memory authoritative state and queues
  index.js        HTTP, uploads, WebSocket, startup
web/
  admin/         local host controls and progress
  player/        lobby and personal recording queue
  recorder/      microphone, preview, accept/retake
  playback/      Web Audio timeline
docs/DESIGN.md
tests/           synthetic packs and integration tests
README.md
```

Node.js 22, Express, Multer, and `ws` provide a single server process. The browser is plain HTML/CSS/JavaScript. No database, accounts, relay, or rendering pipeline is required. One active room lives in server memory, with take files stored on disk only for the lifetime of that server run.

## Concrete models

```js
Pack = {
  id,
  metadata: { title, authors: [], language },
  videoUrl, backingTrackUrl, iconUrl,
  characters: [], // stable order; characterLineCounts uses this order
  characterLineCounts: [], // one task count per character using parser semantics
  lines: [{
    id, caption, startTime, endTime, duration, character,
    referenceAudio: null, // authenticated URL, never a filesystem path
    segments: [{ startTime, endTime, character }]
  }]
};

Session = {
  id, joinToken, // stable party identity and invite; joinToken appears only for the host
  partyCreated,
  matchId, // fresh ID for every selected match, including replay of the same pack
  state: 'lobby', // assignment | recording | review | playback
  pack: null, // players may join before the host selects a pack
  players: [], // identities, credentials, nicknames, and connections persist between matches
  roleAssignments: {}, // character -> playerId; ownership source in Character mode
  lineAssignments: {}, // lineId -> playerId; ownership source in Line mode
  lineTakes: {}, // lineId -> current recorded or accepted take
  replacementTakes: {}, // lineId -> unaccepted replacement, visible only to its owner
  activeRetakes: [], // host summaries; private retake IDs are never snapshotted
  completedLineCount: 0,
  totalLineCount: 0,
  playback: null, // { id, startsAt: serverEpochMilliseconds }
  settings: { previewBefore: 1.5, previewAfter: 0.5, gameMode: 'character' | 'line', /* other party options */ }
};

Player = {
  id, nickname, connected, assignedCharacters: [],
  color, // palette id from web/shared/identity-data.js; unique while the 12-color palette lasts
  marker, // 'none' | 'dot' | 'stripe': distinguishes players who must share a color
  avatar, // built-in icon id (web/shared/avatars/<id>.svg) or null for initials
  progress: {
    currentQueueIndex: 0,
    totalAssignedLines: 0,
    completedLines: 0,
    pendingLines: 0
  }
};

PlayerQueue = {
  playerId, assignedCharacters: [], // empty in Line mode
  lines: [], completedLines: [], pendingLines: [], // owned stable line IDs, chronological in both modes
  currentQueueIndex: 0
};

Take = {
  id, matchId, playerId, character, startTime, endTime,
  status: 'recorded', // accepted after explicit acceptance
  recorder, // { id, nickname, color, avatar } captured at accept time, so restyling never rewrites history
  retakeId, acceptedTakeId, lineVersion, // replacement identity fields when applicable
  url // authenticated URL; private storage metadata is server-only
};

ActiveRetake = {
  id, matchId, lineId, playerId, lineVersion, acceptedTakeId, startedAt
};
```

Player and admin authentication are separate HttpOnly SameSite cookies. Private disk paths, player credentials, and admin credentials never enter snapshots. Accepted takes retain their recording player's provenance even if the character is reassigned.

## HTTP and WebSocket protocol

All mutation requests are JSON except multipart take uploads. Errors return `{ "error": "message" }` with an appropriate HTTP status. Role checks, schema validation, and ownership checks happen on the server, including requests sent outside the browser UI.

| Method/path | Request | Result/access |
| --- | --- | --- |
| `POST /api/admin/login` | `{token}` | Sets admin cookie; loopback only |
| `GET /api/admin/packs` | — | `{packs, errors}`; admin only |
| `POST /api/admin/create-party` | `{}` | Creates/replaces the party and invalidates old invites and credentials |
| `POST /api/admin/select` | `{packId, partyId}` | Starts a new match in the existing party |
| `POST /api/admin/next-match` | `{}` | Clears match data and returns to pack selection |
| `POST /api/admin/settings` | `{gameMode, rules?, exportAccess?, libraryVisibleToPlayers?, ...settings}` | Saves host settings before assignment opens; settings persist between matches. `rules` is validated by `validateRules` and `gameMode` is an alias of `rules.mode`. After setup closes only `exportAccess` and `libraryVisibleToPlayers` may change (everything else must be identical, else 409) |
| `POST /api/admin/assign` | `{character, playerId, matchId}` | Assigns/reassigns one character |
| `POST /api/admin/deal-lines` | `{matchId}` | Shuffles all tasks and deals them round robin to currently connected players; Line mode only, assignment only |
| `POST /api/admin/assign-line` | `{lineId, playerId, matchId}` (`playerId: ""` unassigns) | Assigns, moves, or unassigns one line; Line mode only |
| `POST /api/admin/distribute` | `{matchId}` | Distributes characters among players |
| `POST /api/admin/start` | `{matchId}` | Requires every task to have an owner under the selected mode |
| `POST /api/admin/retake` | `{lineId, matchId}` | Removes take, makes task pending again |
| `POST /api/admin/accept` | `{lineId, matchId}` | Accepts an uploaded take after host review |
| `POST /api/admin/playback` | `{allowMissing, matchId}` | Starts playback; missing accepted takes require explicit override |
| `POST /api/admin/reveal` | `{matchId}` | Moves review to the `reveal` state and unredacts blind lines. 409 when the match has no blind lines. Final playback is refused (409) until it has run whenever blind lines exist |
| `POST /api/admin/stop-playback` | `{matchId}` | Returns to recording/review |
| `POST /api/join` | `{roomId, joinToken, nickname, color?, avatar?}` | Joins the party by stable ID, before or during its lobby; returns player state. A taken color falls back to the first free one; unknown colors or avatars are rejected |
| `POST /api/player/profile` | `{nickname?, color?, avatar?}` (no `matchId`) | Restyles the player in any state except playback. `avatar: ""` clears it. A color another player holds answers 409 with `suggestion` (the next free color) while a free color exists |
| `POST /api/player/claim` / `release` | `{character, matchId}` | Claims or releases a character during assignment |
| `POST /api/player/ready` | `{ready, matchId}` | Sets readiness for the current match |
| `POST /api/takes/:lineId/retake` | `{matchId, attemptId?}` | Starts one active player replacement retake; returns an opaque `retakeId` bound to the player, match, line version, and accepted take. Retrying the same `attemptId` recovers that ID; a competing attempt is rejected |
| `POST /api/takes/:lineId/retake/cancel` | `{matchId, retakeId}` | Cancels the caller's active replacement and removes its candidate |
| `POST /api/takes/:lineId/discard` | `{matchId, takeId}` | Discards the caller's unaccepted first take |
| `GET /api/state` | — | Role-specific snapshot |
| `POST /api/takes/:lineId` | multipart field `take`, `X-Match-ID` and optional `X-Retake-ID` headers | Stores a current-match candidate owned by the authenticated player; replacement uploads must carry their active retake ID |
| `POST /api/takes/:lineId/accept` | `{takeId, matchId, retakeId?}` | Accepts the candidate; replacement acceptance atomically swaps the accepted take |
| `POST /api/exports` | `{format: 'mp4' \| 'm4a', force?}` | Queues a render job for the live match. Admin always; players when `exportAccess` allows (`players`, or `players-after-playback` once playback started). An identical queued, running or ready job is reused; only admins may `force`. Progress appears in `session.exports[]` |
| `GET /exports/:id` | — | Downloads a ready job. Admin, or a player while exports are shared for this match |
| `GET /exports/takes.zip` / `mine.zip` | — | Streams a store-only ZIP of every accepted take (`NN_character_player.ext` plus `credits.txt`), or only the caller's takes (`mine.zip`, players only). Same access rule; no file is written to disk |
| `POST /api/admin/export` / `GET /api/admin/exports/:id` | `{matchId}` | Compatibility: renders a fresh MP4 and waits for it |
| `GET /api/library` | — | List saved dubs. Admin; players only while `libraryVisibleToPlayers` |
| `GET /api/library/:id` | — | Manifest with authenticated take URLs, `replay: {replayable, reason?, videoUrl, backingTrackUrl}`, and which cached renders exist |
| `PATCH /api/library/:id` | `{title?, starred?}` | Admin: rename or star |
| `DELETE /api/library/:id` | — | Admin: delete the entry and its files |
| `POST /api/library/:id/export` | `{format}` | Admin: returns `{ready, url}` when a cached render exists, else queues a job from the saved takes (pack must still be installed and identical) |
| `GET /library-media/:id/:file` | — | Manifest-listed takes, `thumb.jpg`, cached `export.mp4`/`export.m4a`, `takes.zip`, and `video`/`backing` from the installed pack while its fingerprint matches. Range requests supported |
| `GET /media/:packId/:assetId` | — | Authenticated, selected-pack allowlisted assets; range requests supported |
| `GET /takes/:takeId` | — | Authenticated accepted take or candidate; a replacement candidate is visible only to its owning player |
| `POST /api/admin/deal-lines` (modes) | `{matchId}` | In Line mode shuffles and deals; in Duet pairs two players per character and alternates its lines; in Relay hands each character over every `rules.relayEvery` lines. Result is `lineAssignments`, editable with `assign-line` |
| `POST /api/player/open-line` | `{lineId, matchId}` | Speed rounds: starts the server clock for the caller's line (idempotent); uploads before it or after its deadline answer 409. Clocks appear in `session.lineClocks` |
| `POST /api/player/pack-vote` | `{packId, vote}` (no `matchId`) | Players vote for the pack to dub while the host is choosing (lobby). One vote each; another pack moves it; `vote: false` withdraws. `session.packChoices` lists the installed packs in the lobby and `session.packVotes` is `{packId: {count, mine, voters}}`; votes are cleared when a pack is selected |
| `GET /api/packs/:id/icon` | — | Pack icon for any party member (the admin route stays for the host) |
| `GET /api/admin/cards` | — | `{decks, limits, ffmpeg}`. The deck store (`<data dir>/cards/decks.json`) starts with one empty deck |
| `POST /api/admin/cards` / `PATCH` / `DELETE /api/admin/cards/:id` | `{deckId, card}` / `{card}` | Add, edit, delete one card (validated by `validateCard`). Not match-scoped |
| `POST /api/admin/cards/batch` | `{format: 'json' \| 'text', content, deckId \| newDeckName, dryRun?, skipInvalid?}` | Batch add. `dryRun` previews every row; saving is all-or-nothing for the confirmed rows. Up to 200 cards, 400 KB |
| `POST /api/admin/decks`, `PATCH`/`DELETE /api/admin/decks/:id`, `GET /api/admin/decks/:id/export` | `{name}` | Deck management and JSON export (the same format batch add imports) |
| `POST /api/admin/cards/deal` / `redeal` / `veto` / `open` | `{matchId}`, `{key}`, `{key, vetoed?}` | Deal cards during assignment, re-deal one before recording, veto one during it, and turn the cards face up after guessing |
| `POST /api/player/guess` | `{targetPlayerId, cardId, matchId}` | During the reveal, guess another player's card from a shortlist (real card plus decoys); changeable until the cards are opened |
| `GET /ws` | authenticated upgrade | Full state snapshots, no client gameplay authority |

WebSocket snapshots have this envelope:

```js
{
  type: 'state', serverId, revision, serverTime,
  viewer: { kind: 'player', playerId }, // or {kind: 'admin'}
  session,
  queue // personal queue for player; null for admin
}
```

The only client WebSocket message is `{type: 'ping'}`; the reply is `{type: 'pong', serverTime}`. WebSocket connections stay attached to the party across matches and receive each new snapshot. Invalid, oversized, binary, or unknown messages are rejected. Match-scoped mutations and uploads include the current `matchId`; stale requests, including uploads completed after a match change, receive a conflict and cannot create a take. Reconnect fetches current authoritative state. Recording and review continue locally without a WebSocket connection; an upload can be retried once connectivity returns.

## Lifecycle and ownership

```text
party waiting --select pack--> lobby -> assignment -> recording -> review -> playback
      ^                                             ^          |          |
      +---------------- next match -----------------+          +----------+
                                                        retake / reassignment / stop
```

The host creates one party before choosing a pack. Its ID, invite token, player identities, credentials, nicknames, connections, and party settings stay stable across matches. `settings.gameMode` defaults to `character`; the host can choose `character` or `line` during match setup, and assignment opening locks that choice until **Next match**. `/join/:roomId` and its request shape continue to use the party ID. `/api/admin/select` starts a match inside the party and creates a fresh `matchId`, including when replaying the same pack. **Next match** from review or final playback clears match state and returns everyone to the waiting screen while the host picks another pack. The new match begins with empty role and line assignments, readiness, queues, takes, and playback; other settings, including game mode, persist, and the saved maximum-role limit is clamped to the new pack's character count. Replacing the party explicitly creates a new ID and invite and invalidates old credentials. A server restart clears the in-memory party and recordings.

Players may join before the pack is selected. Existing restrictions still prevent new joins after assignments lock. Joining has no arbitrary maximum player count. In Character mode, each character has one owner, players can have several characters, and the existing automatic distribution balances characters by recording-task count. The host can adjust character assignments manually. In Line mode, `lineAssignments` maps each task ID directly to a player; character membership is informational and several players can voice the same character. **Deal lines** shuffles the full task list and assigns tasks round robin to players connected at that moment, so counts differ by at most one. A player with no lines does not need microphone readiness. Later joins need another deal or a manual line assignment. A pre-recording redeal replaces the full mapping, clears readiness, and unlocks assignment. Starting recording in either mode rejects any task without a valid owner.

One `ownerForLine` resolution selects role ownership in Character mode and direct task ownership in Line mode; queues, progress, uploads, acceptance, retakes, and reassignment all use that result. Each player's queue filters the global chronological task list by its resolved owner. A line is complete only when `lineTakes[lineId]` is accepted; an unaccepted replacement never changes progress. The queue index is the earliest unfinished entry, or queue length if done. Full queues remain available for revisiting accepted lines and progress; the browser does not submit an index that changes another player's state. During recording and on DONE, the native player picker lists assigned lines chronologically with line number, character, shortened caption, and completion state. Browsing an accepted line loads its scene, original audio, and accepted take without changing completion. The player keeps the selection across ordinary snapshots, resets it on a new match, and falls back to the earliest unfinished line when ownership changes.

There is **no global current line, recording turn, or lock across players**. Three players can upload distinct owned line IDs at the same time and in any order. The server serializes small state mutations and take-file updates, never the recording process. Every upload rechecks the current party and match, lifecycle, mode-specific ownership, line version, and expected candidate identity before commit. A stale response or take must not overwrite a newer candidate or become valid after reassignment. Manual line moves are available during assignment, recording, pause, and review. They preserve an accepted take and its original recorder provenance, while clearing unaccepted candidates and active retakes for the moved line. Playback rejects manual moves.

Disconnecting changes presence, not ownership or accepted takes. Remaining tasks stay pending. Closing the player's last connection cancels that player's active replacement and removes its candidate. Reassigning a character moves its lines in Character mode; in Line mode the host moves one task directly. Accepted recordings keep their original recorder provenance. Unaccepted candidates belonging to the old owner are discarded. The host can invalidate an accepted take with a host retake, which makes that line pending under its current owner.

Players can begin a replacement while required lines remain unfinished. A player may hold one active retake, and a second tab cannot start a competing retake. The active ID binds the player, match, line version, and accepted take; upload and acceptance both recheck that identity. The accepted `lineTakes` entry remains the source for progress, playback, and export until the server atomically commits a successfully saved replacement. Failed, stale, canceled, or reassigned replacements preserve the accepted entry. A player may accept a replacement with **NEXT** or cancel it and keep the accepted take. Replacement candidates are private to their owner and the host.

Once every required line is accepted, the server blocks new player retakes. Active retakes keep the match in recording and hold completion open. Playback and explicit review are blocked until they finish or are canceled; the host snapshot identifies the players holding completion open. When the final active retake is accepted or canceled and all lines are complete, the match enters review. A host pause, host-requested retake, affected line reassignment, assignment reopening, or last-connection close cancels affected active retakes. Match replacement removes all candidates and active retakes. Review and playback do not allow player retakes. Playback otherwise requires all required lines to be accepted unless the host explicitly sets `allowMissing: true`.

## Recording and final timeline

Preview uses the original video with `max(0, startTime - previewBefore)` through `endTime + previewAfter`. A reference button plays the matching MP3 separately. The reference is never copied into a take or the final mix.

The recorder provides an optional countdown, microphone permission errors, local review, acceptance, and replacement retakes. On an accepted line, **RECORD** first requests its bound retake ID. **MY TAKE** uses a saved replacement candidate when available and otherwise the accepted take. **NEXT** accepts only a successfully saved candidate; failure leaves the accepted take intact. Switching lines with an unaccepted take asks for discard confirmation. Switching is disabled during capture and acceptance, and the player can cancel a replacement explicitly. After the countdown, the recorder waits 0.2 seconds before starting the muted scene and capture together at the line timestamp. Capture stops at line end, including the selected effect's drain/tail handling; the take review appears after another 0.2-second wait, while upload may already be running. Both waits are cancelable on STOP, host pause, reassignment, and match change. Preview padding never becomes an unaccounted lead-in in the uploaded audio, so final take alignment remains based on the line's Workshop timestamp.

Microphone amplification is a local 0–300% gain node before the voice-effect chain and capture gate. It feeds both the recorded stream and the separate live meter; the monitor branch never connects to the speakers. The chosen value is remembered in browser storage, while capture and other browser preferences remain local to each player.

The effect selector includes **AUTO-TUNE**. Its AudioWorklet analyzes a trailing window with confidence-gated voiced-pitch detection, maps voiced frequency to the nearest equal-tempered chromatic note using A4 = 440 Hz, and applies strong pitch correction with brief smoothing across frames and note boundaries. Silence and unvoiced consonants pass without correction. Worklet state resets between recordings. If AudioWorklet processing is unavailable, the UI disables AUTO-TUNE and explains why. The effect is processed into the uploaded audio; it preserves the task's scene alignment and recording duration.

The recording comparison decodes time-domain samples for the original/reference and the full take and draws them on one timeline and amplitude scale. Purple shows the original; cyan shows the take. The original uses its reference MP3 where available, otherwise the current line's original video audio. The take waveform is shown as soon as capture ends, and a playback cursor appears while either audio plays. Decoding is cached within a match and canceled or ignored when the line, take, or match changes. If source decoding fails, the UI reports that the original waveform is unavailable; recording and playback continue. The live microphone meter stays independent of this comparison.

Final playback preloads the backing track and accepted takes, decodes them into Web Audio buffers, and schedules them against a single `AudioContext` clock. The backing starts at timeline zero and each take starts at the Workshop line start. Clip accepted voice duration to the corresponding line window so an overlong take cannot run indefinitely. Overlapping takes mix naturally. The visual video is muted and follows that timeline; seeking/rejoining rebuilds the schedule with offsets. Do not use independent JavaScript timers for each line.

The host broadcasts one future playback epoch. Browsers estimate their offset to the server clock, preload audio, and schedule a common start. Late joiners enter at the elapsed timeline time. Network timing affects when a browser begins watching, never where a take belongs in the dub. This is best-effort shared playback, not sample-perfect synchronization between devices.

## Modes, cards and pack votes

`rules` also holds `relayEvery`, `speed: {enabled, lineTimeLimitSec}`, `mystery` and `cards: {enabled, deckId, deal, kinds}`. Speed forces `takeLimit: 1` and `allowPlayerRetakes: false`. `session.settings.assignmentStyle` is `line` for Line, Duet and Relay (ownership in `lineAssignments`) and `character` otherwise; clients use it instead of `gameMode`.

Cards are copied into `data.cards` when dealt (`{deal, cards, holders, vetoed, decoyCards}`), so deck edits never change a running match. A card's key is `player:<id>`, `line:<id>` or `char:<name>`. Effect cards are applied by the take upload route with the allowlisted filter chain; if FFmpeg fails nothing is stored. Constraint cards add per-line blind flags and tighten the take limit. Players receive only their own cards until `cardsOpen`; effect chains are never sent to players.

## Redaction and the reveal

`snapshot()` ends with `redactFor(viewer, session, {blindLines, revealed})`. The host sees everything plus `blindLines`. Players receive blind lines with `caption: ""` / `referenceAudio: null` (and `captionHidden` / `referenceHidden`) until `data.revealed` is true, so no secret text or URL exists in their JSON, including WebSocket pushes. `GET /media` also refuses a blind line's reference asset for players, and the live match's library entry is hidden from players until the reveal. Blind lines are picked once per match, in `startRecording()`, with a seeded shuffle (`share` of the lines, at least one when `share > 0`); recording restarts do not re-roll. Lifecycle: `recording -> review -> [reveal] -> playback`; a host retake clears `revealed` and returns to `recording`. After the reveal, `DubPlayback` offers an ORIGINAL SUBTITLES toggle for matches with blind lines; `captionAt(session, timeline)` picks the line speaking at the shared timeline time.

## Library and exports

Rules (`data.rules`): `{mode, takeLimit, allowPlayerRetakes}`, validated by `server/session/rules.js` and locked when role selection opens. `takeLimit` counts stored uploads per line (a host retake or reassignment starts a new count) and is checked in `storeTake`, `beginRetake` and `discardCandidate`, so direct API calls cannot bypass it. `session.takesUsed` shows the viewer's counts.

The **library** (`server/library.js`) is the one deliberate exception to "a restart clears recordings". `store.onCommit` runs after every committed mutation and before obsolete take files are deleted. Whenever the match is in `review` or `playback`, `Library.syncMatch` saves or updates `data/library/<entryId>/` (`manifest.json`, `takes/line-N.media` hard-linked or copied, optional `thumb.jpg`, `export.mp4`/`export.m4a`). Matches abandoned while recording are never saved. Manifests are written to a temporary file and renamed; they carry `version: 1`, the pack fingerprint (hash of line data and media sizes), a rules snapshot, players (no credentials), lines with take metadata including the recorder profile, and `starred`.

At startup every manifest is validated (schema, take file names matching `^[A-Za-z0-9_-]+\.media$`, take files present); invalid entries are listed as damaged and never served. Files are resolved only from names the manifest lists, then checked with `realpath` against the entry directory. Retention (`LIBRARY_MAX_ENTRIES`, default 200; `LIBRARY_MAX_BYTES`, default 10 GB) prunes the oldest unstarred entries; `LIBRARY=off` disables saving. A cached render is dropped when the entry's takes change.

**Export jobs** (`server/exports.js`) render one at a time. `-progress pipe:1` feeds `progress` into the snapshot (throttled to about one update per 750 ms). A job is tied to its match: if the match changes, the job fails with "The match changed" and its file is deleted. A finished live render is also stored in the matching library entry. Local replay builds a session-shaped object from the manifest and reuses `DubPlayback`.

## Security and runtime storage

Only discovered, validated files from the selected pack are served through an opaque asset manifest. Reject traversal, symlink escapes, unknown IDs, and unsafe icon paths. Never offer a filesystem browser. Admin login requires loopback and a separately generated secret; public player endpoints do not expose admin actions or join secrets. Validate nickname lengths, body sizes, origin, WebSocket schemas, recording MIME types/signatures, and maximum upload bytes. Random opaque IDs prevent predictable room/take paths from becoming authorization.

Keep room state in memory. Store accepted takes, replacement candidates, and temporary uploads under a configurable data directory with restrictive permissions, then clear old session snapshots, takes, and temporary uploads at startup so every server run begins with an empty lobby. Replacement media is authenticated and is removed when its retake is canceled, reassigned, or replaced by an accepted version. Optional converted-video cache files can remain across restarts. Failed or stale uploads must leave neither authoritative takes nor orphan temporary files.

LAN HTTP works for browsing and playback. Browser microphone capture normally requires a secure context: localhost or HTTPS. Therefore remote LAN players need the built-in HTTPS listener configured with `TLS_CERT` and `TLS_KEY`, using a certificate trusted by their browsers. Origin validation checks the connection scheme and Host header. An HTTPS proxy may forward over HTTP through WireGuard when its actual source IP appears in the explicit `TRUSTED_PROXY` list; only then does a single `http` or `https` value in `X-Forwarded-Proto` determine the public scheme for HTTP mutations, WebSocket upgrades, and Secure cookies. Native TLS always uses HTTPS. An exact trusted proxy may pass overwritten `X-Real-IP` to authorize a narrowly scoped WireGuard admin CIDR. Public access otherwise always requires the admin token; `PUBLIC_LINK` only changes invitation URLs. A verified HTTPS upstream with the preserved public Host also works; see [Desktop + VPS as Proxy](DESKTOP_VPS_PROXY.md). FFmpeg export and standalone VPS hosting are supported; no public relay process is required.

Optional `--transcode-video` / `TRANSCODE_VIDEO=1` converts the whole source video into a cached audio-free H.264 MP4 in the runtime data directory. It does not edit Workshop files, produce line clips, or render the finished dub. The selected pack manifest exposes that cache entry through the same authenticated media route.
