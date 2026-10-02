# Runtime design

This is an independent implementation of the Workshop content format. It uses no Dub Together application code, interface, or bundled assets. Workshop files remain external user-provided content.

## Format analysis

A pack is one directory containing `_pack_info.ini`, `dub_video.ogv`, `_backing_track.ogg`, an optional icon, and line INI files with optional matching reference MP3s. INI values use a small Godot-style subset: `[data]`, quoted UTF-8 strings, finite numbers, and arrays. Parse that subset explicitly; never execute pack text or evaluate expressions.

Metadata fields are `title`, `icon`, `authors`, and `language`. Line fields are `caption`, `dub_timestamps`, `dub_ends`, and `dub_characters`. Preserve every corresponding array entry as a segment so expansion to segment-level tasks does not require changing the parser. Initially one file is one task. A task with several segments for the same character can use the envelope from the earliest start to the latest end. A file naming several distinct characters is rejected with a clear discovery error until segment-level recording is implemented; silently assigning it to the first character would lose ownership information.

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
  characters: [],
  lines: [{
    id, caption, startTime, endTime, duration, character,
    referenceAudio: null, // authenticated URL, never a filesystem path
    segments: [{ startTime, endTime, character }]
  }]
};

Session = {
  id, joinToken, // joinToken appears only in admin snapshots
  state: 'lobby', // assignment | recording | review | playback
  pack: null,
  players: [],
  roleAssignments: {}, // character -> playerId
  lineTakes: {}, // lineId -> latest recorded/accepted take
  completedLineCount: 0,
  totalLineCount: 0,
  playback: null, // { id, startsAt: serverEpochMilliseconds }
  settings: { previewBefore: 1.5, previewAfter: 0.5 }
};

Player = {
  id, nickname, connected, assignedCharacters: [],
  progress: {
    currentQueueIndex: 0,
    totalAssignedLines: 0,
    completedLines: 0,
    pendingLines: 0
  }
};

PlayerQueue = {
  playerId, assignedCharacters: [],
  lines: [], completedLines: [], pendingLines: [], // stable line IDs
  currentQueueIndex: 0
};

Take = {
  id, playerId, character, startTime, endTime,
  status: 'recorded', // accepted after explicit acceptance
  url // authenticated URL; private storage metadata is server-only
};
```

Player and admin authentication are separate HttpOnly SameSite cookies. Private disk paths, player credentials, and admin credentials never enter snapshots. Accepted takes retain their recording player's provenance even if the character is reassigned.

## HTTP and WebSocket protocol

All mutation requests are JSON except multipart take uploads. Errors return `{ "error": "message" }` with an appropriate HTTP status. Role checks, schema validation, and ownership checks happen on the server, including requests sent outside the browser UI.

| Method/path | Request | Result/access |
| --- | --- | --- |
| `POST /api/admin/login` | `{token}` | Sets admin cookie; loopback only |
| `GET /api/admin/packs` | — | `{packs, errors}`; admin only |
| `POST /api/admin/select` | `{packId}` | Loads pack, creates random room ID/join token |
| `POST /api/admin/assign` | `{character, playerId}` | Assigns/reassigns one character |
| `POST /api/admin/distribute` | `{}` | Distributes characters among players |
| `POST /api/admin/start` | `{}` | Requires every character assigned; starts all queues |
| `POST /api/admin/retake` | `{lineId}` | Removes take, makes task pending again |
| `POST /api/admin/accept` | `{lineId}` | Accepts an uploaded take after host review |
| `POST /api/admin/playback` | `{allowMissing}` | Starts playback; missing accepted takes require explicit override |
| `POST /api/admin/stop-playback` | `{}` | Returns to recording/review |
| `POST /api/join` | `{roomId, joinToken, nickname}` | Sets player cookie; returns player state |
| `GET /api/state` | — | Role-specific snapshot |
| `POST /api/takes/:lineId` | multipart field `take` | Stores candidate owned by authenticated player |
| `POST /api/takes/:lineId/accept` | `{takeId}` | Accepts that candidate; advances that player's queue |
| `GET /media/:packId/:assetId` | — | Authenticated, selected-pack allowlisted assets; range requests supported |
| `GET /takes/:takeId` | — | Authenticated room recording |
| `GET /ws` | authenticated upgrade | Full state snapshots, no client gameplay authority |

WebSocket snapshots have this envelope:

```js
{
  type: 'state', revision, serverTime,
  viewer: { kind: 'player', playerId }, // or {kind: 'admin'}
  session,
  queue // personal queue for player; null for admin
}
```

The only client WebSocket message is `{type: 'ping'}`; the reply is `{type: 'pong', serverTime}`. Invalid, oversized, binary, or unknown messages are rejected. Reconnect fetches current authoritative state. Recording and review continue locally without a WebSocket connection; an upload can be retried once connectivity returns.

## Lifecycle and ownership

```text
lobby -> assignment -> recording -> review -> playback
                            ^          |          |
                            +----------+----------+
                              retake / reassignment / stop
```

Selecting a pack rotates room identity and join credentials. Joining has no arbitrary maximum player count. Assignments support several characters per player. Starting recording rejects any unassigned character. An automatic distribution balances characters among joined players and preserves one owner per character; the host can adjust it manually.

Each personal queue filters the global chronological task list by that player's assigned characters. A line is complete only when its stored take is accepted. The queue index is the earliest unfinished entry, or queue length if done. Full queues remain available for retakes and progress; the browser does not submit an index that changes another player's state.

There is **no global current line, recording turn, or lock across players**. Three players can upload distinct owned line IDs at the same time and in any order. The server serializes small state mutations and take-file updates, never the recording process. Every upload rechecks room, lifecycle, assignment, ownership, and expected candidate identity before acceptance. A stale response or take must not overwrite a newer candidate or become valid after reassignment.

Disconnecting changes presence, not ownership or accepted takes. Remaining tasks stay pending. Reassigning a character moves its unfinished lines into the new owner's sorted queue and keeps already accepted recordings. Unaccepted candidates belonging to the old owner are discarded. Invalidating an accepted take makes it pending under the current assignment. Completion automatically moves recording into review. Playback requires all required lines accepted unless the host explicitly sets `allowMissing: true`.

## Recording and final timeline

Preview uses the original video with `max(0, startTime - previewBefore)` through `endTime + previewAfter`. A reference button plays the matching MP3 separately. The reference is never copied into a take or the final mix.

The recorder provides countdown, microphone permission errors, local review, acceptance, and retake. Video is muted throughout recording and final playback. Microphone timing must be aligned to the actual line: the recording begins at the task's `startTime` and ends after its duration; preview padding must not become an unaccounted lead-in in the uploaded audio. If a future implementation records the padded fragment, it must persist the lead-in and crop/offset the accepted audio before scheduling.

Final playback preloads the backing track and accepted takes, decodes them into Web Audio buffers, and schedules them against a single `AudioContext` clock. The backing starts at timeline zero and each take starts at the Workshop line start. Clip accepted voice duration to the corresponding line window so an overlong take cannot run indefinitely. Overlapping takes mix naturally. The visual video is muted and follows that timeline; seeking/rejoining rebuilds the schedule with offsets. Do not use independent JavaScript timers for each line.

The host broadcasts one future playback epoch. Browsers estimate their offset to the server clock, preload audio, and schedule a common start. Late joiners enter at the elapsed timeline time. Network timing affects when a browser begins watching, never where a take belongs in the dub. This is best-effort shared playback, not sample-perfect synchronization between devices.

## Security and runtime storage

Only discovered, validated files from the selected pack are served through an opaque asset manifest. Reject traversal, symlink escapes, unknown IDs, and unsafe icon paths. Never offer a filesystem browser. Admin login requires loopback and a separately generated secret; public player endpoints do not expose admin actions or join secrets. Validate nickname lengths, body sizes, origin, WebSocket schemas, recording MIME types/signatures, and maximum upload bytes. Random opaque IDs prevent predictable room/take paths from becoming authorization.

Keep room state in memory. Store take blobs and temporary uploads under a configurable data directory with restrictive permissions, then clear old session snapshots, takes, and temporary uploads at startup so every server run begins with an empty lobby. Optional converted-video cache files can remain across restarts. Failed or stale uploads must leave neither authoritative takes nor orphan temporary files.

LAN HTTP works for browsing and playback. Browser microphone capture normally requires a secure context: localhost or HTTPS. Therefore remote LAN players need the built-in HTTPS listener configured with `TLS_CERT` and `TLS_KEY`, using a certificate trusted by their browsers. Origin validation deliberately checks the actual transport and Host header. A VPS proxy over WireGuard works today with a verified HTTPS upstream and the preserved public Host header; see [Desktop + VPS as Proxy](DESKTOP_VPS_PROXY.md). A TLS-terminating HTTP upstream proxy needs future explicit trusted-origin support. Public relay and ffmpeg export are deferred; the protocol remains a local process that can later sit behind an outbound tunnel without moving gameplay into the relay.

Optional `--transcode-video` / `TRANSCODE_VIDEO=1` converts the whole source video into a cached audio-free H.264 MP4 in the runtime data directory. It does not edit Workshop files, produce line clips, or render the finished dub. The selected pack manifest exposes that cache entry through the same authenticated media route.
