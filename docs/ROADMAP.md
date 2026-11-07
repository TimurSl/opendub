# Gameplay and library roadmap

Status: **in progress**. See [Implementation status](#implementation-status) for what has shipped. This document covers six features:

1. [Avatars and colors](#1-avatars-and-colors)
2. [Dub library (automatic save of every game)](#2-dub-library)
3. [Export for players](#3-export-for-players)
4. [Blind lines](#4-blind-lines)
5. [Match modes](#5-match-modes)
6. [Handicaps and cards](#6-handicaps-and-cards)

Each section builds on the current architecture in [DESIGN.md](DESIGN.md): one in-memory party in `server/session/store.js`, full-state WebSocket snapshots, one ownership function (`ownerForLine`), and a single FFmpeg export in `server/index.js`.

## Implementation status

| Phase | Work | Status |
| --- | --- | --- |
| 1 | §1 Avatars and colors | **Done** |
| 2 | §0.1 rules (take limit, retakes), §2 Library, §3 Export jobs | **Done**, with the gaps listed in each section |
| 3 | §0.2 redaction, §0.3 reveal, §4 Blind lines | **Done**, with the gaps listed in §4 |
| 4 | §5 modes: duet, relay, speed, mystery | Not started |
| 5 | §0.4 server effects, §6 Cards (data-driven decks, batch add in the admin panel) | Not started |
| 6 | §5 swap (rounds) | Not started |

Deviations from the plan are noted in each section as they are implemented.

---

## 0. Shared foundations

The six features need four common pieces. Build them first, as they come up, so later features don't each invent their own.

### 0.1 Match rules object

Today, per-match behaviour is spread across `data.options`: `gameMode`, `voiceEffectsEnabled`, `referencePlaybackEnabled`, and so on. Add one validated object, `data.rules`. The host edits it in setup, and it is **locked when assignment opens**, the same way `gameMode` is locked now:

```js
rules = {
  mode: 'character',            // see §5; 'character' | 'line' | 'duet' | 'relay' | 'swap' | 'speed'
  blind: { caption: false, reference: false, scene: false, share: 1.0 }, // §4
  takeLimit: 0,                 // 0 = unlimited; speed round uses 1 (§5)
  lineTimeLimitSec: 0,          // 0 = none; time to start recording once a line is opened
  allowPlayerRetakes: true,
  cards: { enabled: false, deal: 'per-player', deckId: 'default', guessing: true }, // §6
};
```

- Validation sits in one function, `validateRules(rules, pack)`, next to `configure()`. It accepts only known keys and bounded values.
- `rules` goes into every snapshot, so players can see which game they're in. Secret **per-line results** of the rules (which lines are blind, which card someone holds) are not part of `rules`. They live in private state, described in §0.2.
- `gameMode` becomes a derived alias of `rules.mode` for one release, so existing clients and tests keep working.

### 0.2 Per-viewer redaction

`snapshot(viewer)` currently sends `publicPack(this.pack)` unchanged to every viewer, including every caption and every reference-audio URL. Blind lines and cards both need secrets, so add one helper:

```js
redactFor(viewer, session) // runs last in snapshot(); pure, unit-tested
```

- The host sees everything.
- A player sees their own secrets, and other players' secrets only after the **reveal** (§0.3).
- `GET /media/:packId/:assetId` must apply the same check to reference audio. Hiding a URL is not enough, because asset IDs are stable and guessable from the pack.
- Add a regression test that renders a player snapshot and asserts that no redacted caption text appears anywhere in the JSON.

### 0.3 Reveal step

Add a short `reveal` sub-state between `review` and `playback`, plus a host button **Reveal**. It does three things:

- It unredacts blind captions, cards, and the mystery cast.
- It opens card guessing (§6).
- It is skipped automatically when no secret rules are on.

The lifecycle becomes:

```text
recording -> review -> [reveal] -> playback
```

### 0.4 Server-side audio processing

Today, voice effects other than Custom run in the browser (an AudioWorklet), and the server can't verify them. Forced effects from cards (§6) must be applied on the server after upload. The existing `custom-audio.js` already provides an allowlisted filter-chain builder with a two-job limit and a timeout, so reuse it. Generalise it to `processTake(take, chain)`, so a card can attach a fixed chain that the player can't bypass.

---

## 1. Avatars and colors

**Goal:** make players easy to tell apart in the lobby, the host's progress list, the line picker, review, playback, and the library.

### Rules

- **Color:** choose from a fixed palette of 12 colors that pass contrast checks on both themes. Colors are unique within a party. On join, the server auto-assigns the first free color, and the player can change it later. When there are more than 12 players, colors repeat with a pattern marker (dot or stripe), so they stay distinguishable.
- **Avatar:** choose from a built-in set of about 40 SVG icons shipped in `web/shared/avatars/`, or show initials as a fallback. Don't allow **image uploads** in the first version. Uploads add moderation, size, and decoding risk on a self-hosted box. They could be added later behind a setting, re-encoded through FFmpeg to a 128×128 PNG.

### Server

- `Player` gains `{ color, avatar }`. Both are validated against the palette and icon allowlist, so no free text goes into CSS.
- `POST /api/join` accepts optional `color` and `avatar`.
- New `POST /api/player/profile` takes `{ nickname?, color?, avatar? }` and is allowed in any state except `playback`. If a requested color is taken, it returns 409 and the client offers the next free one.
- The snapshot's `players[]` includes `color` and `avatar`.
- Accepted takes snapshot the recorder's color and avatar at accept time (`take.recorder`), so the library and export credits stay correct after a player changes their profile.

### Client

- **Join screen:** add a color swatch row and an avatar grid. Remember the last choice in `localStorage`, wrapped in try/catch, and prefill it on the next join.
- **Host:** show colored chips on the player list, the character and line assignment dropdowns, and progress bars.
- **Player:** in the line picker, color each line by its owner. In review, show the owner's color on each take's waveform.
- **Playback:** show a speaker badge (avatar + name in the player's color) while their line plays.
- **Shared:** add one `web/shared/identity.js` with `renderPlayerChip(player)`, so every screen draws chips the same way.

### Tests

- Palette uniqueness, auto-assignment when the palette is exhausted, and rejection of unknown colors and avatars.
- A profile change during recording keeps the old color on existing accepted takes.

**Size:** small. **Do this first**, because every later feature shows players.

**Implemented.** Notes on how the plan was realised:

- Allowlists live in `web/shared/identity-data.js`, imported by both the server (validation) and the browser (rendering). Colors are sent as ids and mapped to hex on the client, so no free text reaches CSS. A test checks every color keeps 3:1 contrast on `#121212` and `#ffffff`.
- Past 12 players, the least-used color is reused and the snapshot's `players[].marker` (`dot`, then `stripe`) tells clients which pattern to draw. Taking a color someone else holds is a 409 only while a free color exists.
- Joining with a taken color does not fail; the server picks the first free one.
- Taken-color 409 responses carry `suggestion`, and the client retries with it automatically.
- The line picker is not colored per owner: a player only ever sees their own lines, so the recording panel gets a top border in the player's color instead. The host's line-assignment rows show each owner's chip.
- Review-waveform coloring is not done yet, because review waveforms are host-side only today.

---

## 2. Dub library

**Goal:** save every finished game automatically, so nothing is lost on restart or **Next match**. Saved games can be replayed, exported, and downloaded later.

### What "save" means

Today, `init()` deletes `data/takes/` on startup, and `nextMatch()` drops all takes. The library is a separate store that survives both:

```text
data/library/
  <entryId>/
    manifest.json        # metadata, see below
    takes/<lineId>.media # accepted takes, copied (hardlinked when possible)
    export.mp4           # optional cached render (§3)
    thumb.jpg            # one frame from the middle of the video, made with FFmpeg
```

```js
LibraryEntry = {
  id, version: 1, createdAt, updatedAt, title,      // title defaults to "<pack title> · <date>"
  pack: { id, title, language, fingerprint },       // fingerprint = hash of the pack's line INI + media sizes
  rules,                                            // §0.1 snapshot
  players: [{ id, nickname, color, avatar }],       // no credentials
  lines: [{ id, character, caption, startTime, endTime,
            take: { file, recorderId, leadIn, tail, effect?, card? } | null }],
  cards: { ... },                                   // §6 results, if any
  awards: null,                                     // reserved for voting later
  starred: false,
};
```

### When it saves

- **Auto-save** happens when a match first enters `review`, which is the first point where all lines are accepted, or when the host starts playback with `allowMissing`.
- **Update** happens when a take is replaced or a host retake is accepted after the first save.
- **Finalise** happens on **Next match**, when replacing the party, or on graceful shutdown (SIGTERM). Finalising writes the manifest atomically: write to a temporary file, then rename.
- Partial matches the host abandons mid-recording aren't saved by default. The setting `librarySavePartial: true` saves them, marked "incomplete".

### Replay

- A library entry replays only when its pack is still installed and the fingerprint matches. If not, the library shows "pack missing", but the takes and export remain downloadable.
- Replay reuses `web/playback/playback.js`. Feed it a timeline from the manifest instead of the live session. This requires a small refactor: playback takes `{ videoUrl, backingUrl, takes[] }` instead of reading `session` directly.
- Replay can be **local** (only the host watches) or **party** (broadcast to connected players with the existing playback epoch). Party replay is allowed only while the party is in `lobby`.

### Server

| Method/path | Access | Purpose |
| --- | --- | --- |
| `GET /api/library` | admin; players if `libraryVisibleToPlayers` | List entries (no takes inlined) |
| `GET /api/library/:id` | same | Manifest with authenticated take URLs |
| `PATCH /api/library/:id` | admin | Rename or star |
| `DELETE /api/library/:id` | admin | Delete entry and files |
| `POST /api/library/:id/replay` | admin | `{ scope: 'local' \| 'party' }` |
| `POST /api/library/:id/export` | admin | Render or reuse `export.mp4` (§3) |
| `GET /library-media/:id/:file` | same as list | Takes, thumbnail, export; range requests supported |

- Entry IDs are opaque random IDs. The server never accepts a path from a client. Files resolve only from the manifest, then go through the same `realpath`-under-root check that `/media` uses.
- When the manifest is loaded at startup, it is **validated**: schema, file names matching `^[A-Za-z0-9_-]+\.media$`, and no paths. An invalid entry is listed as "damaged" and isn't served.
- **Retention:** `LIBRARY_MAX_ENTRIES` (default 200) and `LIBRARY_MAX_BYTES` (default 10 GB). The oldest **unstarred** entries are pruned first. Setting `LIBRARY=off` disables saving completely.
- Update DESIGN.md: "a server restart clears the party and recordings" stays true for the **live** match. The library is the one deliberate exception.

### Client

- **Host:** add a **Library** tab in `/admin` with a grid of thumbnails, title, pack, date, cast avatars, and duration. Add filters (pack, player, starred) and actions: replay locally, replay for the party, export, download takes, rename, star, delete. Deleting asks for confirmation.
- **Host, after a match:** show a toast, "Saved to library". The confirm text for **Next match** changes from "all takes are deleted" to "this match is saved in the library".
- **Players:** when visibility is on, add a "Past dubs" list on the waiting screen.

### Tests

- A restart keeps library entries and still wipes live takes.
- Replacing a take after the auto-save updates the entry.
- A pack fingerprint mismatch blocks replay.
- Path-traversal and damaged-manifest cases are rejected.
- Retention never deletes starred entries.

**Size:** medium-large. **Risk:** disk usage. Defaults and retention handle it.

**Implemented.** Gaps and deviations:

- Saving, updating, listing, rename/star/delete, retention, validation, local replay, download of takes, and cached renders are done. `server/library.js` has the storage rules.
- **Not done:** party replay (`scope: 'party'`), the `librarySavePartial` setting, the players' "Past dubs" screen (players can use `GET /api/library` when the host shares it, but there is no list UI yet), and library filtering by anything but pack, player and starred.
- Finalise-on-shutdown is covered by saving at every commit while the match is in review or playback; `close()` waits for the save queue.
- There is no `POST /api/library/:id/replay`: local replay is purely client-side on top of `GET /api/library/:id`.
- `rules` currently holds `mode`, `takeLimit` and `allowPlayerRetakes`. `blind`, `cards` and `lineTimeLimitSec` arrive with the phases that enforce them.

---

## 3. Export for players

**Goal:** players, not only the host, can get the finished dub, plus lighter formats.

### Current state

`POST /api/admin/export` renders an MP4 synchronously inside the HTTP request. It is admin only. The server keeps the last 5 exports in a memory map, which is lost on restart and on match change.

### Changes

1. **Export jobs instead of a blocking request.** `POST /api/exports` returns `{ jobId }`. Job status (`queued | rendering | ready | failed`, plus progress from FFmpeg `-progress pipe:1`) goes into the snapshot as `session.exports[]`. Every viewer sees the progress bar, and the host can leave the page without killing the render. Run at most one render at a time and queue the rest.
2. **Formats:**
   - `mp4`: the existing full video.
   - `m4a`: an audio-only mix (backing + voices). It is fast and small, good for phones.
   - `takes.zip`: every accepted take named `NN_character_player.webm`, plus `credits.txt`. Stream it with a zip writer; there is no temporary zip on disk.
   - `mine.zip`: for players, only their own takes.
3. **Who can download:** the setting `exportAccess` is `host` (default, current behaviour), `players`, or `players-after-playback`. A ready export appears in the player UI as a **Download** button on the playback and review screens. Downloads go through the authenticated `/exports/:id` route for both host and players.
4. **Library link:** a finished MP4 or M4A is stored as `export.mp4` / `export.m4a` in the match's library entry (§2). It survives **Next match** and restarts, and it is re-exported only when takes change.
5. **Credits overlay (optional):** an end card added with FFmpeg `drawtext`, listing character → player with each player's color (§1). It is off by default. Font paths are configured on the server, not taken from the client.
6. **Share link (later, optional):** a time-limited, unguessable read-only URL for one export, for people who weren't in the party. It is off by default. It needs its own expiry and revocation, so it's out of scope for the first release.

### Tests

- A player without access gets 403.
- A match change during a render doesn't attach the result to the wrong match. The existing check stays.
- A queued job survives the host page closing.
- The zip contains exactly the accepted takes.
- `mine.zip` contains only the requester's takes.

**Size:** medium. It shares storage with §2, so build them together.

**Implemented.** Jobs, formats `mp4` and `m4a`, streamed `takes.zip` and `mine.zip`, `exportAccess`, and library-stored renders are done. Notes:

- `takes.zip` and `mine.zip` are streamed directly (not jobs), because there is no temporary file to track.
- `POST /api/admin/export` stays as a blocking compatibility wrapper that always renders fresh.
- **Not done:** the credits overlay (drawtext) and share links, both optional in the plan.

---

## 4. Blind lines

**Goal:** players record without full information, and the group compares with the original at the reveal.

### Rules (host setup, part of `rules.blind`)

| Option | Player sees while recording |
| --- | --- |
| `caption` | No caption text; shows "???" and the character name |
| `reference` | The **Original** button and original waveform are hidden; the scene preview is muted |
| `scene` | No video preview, only a timing bar and countdown |
| `share` | 0–1: fraction of lines that are blind, chosen randomly per match (1 = every line) |

The options combine. For example, `caption + reference` gives an improv round, and `scene` alone gives a "voice it from the script" round.

### Server

- At `startRecording()`, pick blind lines with a seeded shuffle and store them in `data.blindLines: { lineId: { caption, reference, scene } }`. This state is private. The host sees it; players don't.
- `redactFor` (§0.2) removes `caption` and `referenceAudio` for blind lines in player snapshots until the reveal. Player queues still show line numbers, characters, and timing.
- `/media` refuses to serve a reference asset for a blind line to players before the reveal.
- **Scene blindness can't be fully enforced.** The pack ships one video file, which players must load for final playback. The server can delay player access to the video asset until `review`. The preview then shows a placeholder, and the video URL only becomes valid at playback. Document this as best effort for anyone using browser devtools.
- `take.blind` records which blind flags applied, for the library and reveal.

### Client

- **Recorder:** placeholder states for each blind flag. Hidden controls are **removed**, not just disabled, so the layout doesn't hint at them. Add a "BLIND" badge on the line.
- **Reveal and playback:** the reveal screen lists blind lines with the original caption next to the take. In final playback, a toggle switches subtitles between "what they said" (nothing, since there's no speech-to-text) and "what was written".
- **Host:** shows a small eye-slash icon on blind lines and can still see everything.

### Tests

- No player snapshot or `/media` response leaks a blind caption or reference before the reveal.
- After the reveal, everything is visible.
- `share` picks the expected number of lines, and the selection is stable across snapshots.

**Size:** small-medium. It exercises §0.2 and §0.3, which makes it a good first secret rule.

**Implemented.** `server/session/redact.js` holds `redactFor` (pure, unit-tested) and the `/media` check; `reveal` is a real session state between `review` and `playback`. Deviations:

- **Scene blindness is client-side only.** The recorder's cue timing is driven by playing the scene video, so the server cannot withhold the video from players without breaking recording. The video is hidden visually and replaced by a placeholder, timing bar and countdown, but a player using devtools can still fetch it. Caption and reference-audio blindness *are* enforced by the server (text and URL removed from player snapshots, `/media` returns 403 until the reveal).
- Blind lines never fall back to the scene's own audio for the Original button or waveform.
- A host retake after the reveal makes all lines blind again until the host reveals again.
- The live match's library entry is hidden from players until the reveal.
- Players do get a per-line `blind` flag (and `captionHidden` / `referenceHidden`), because the recorder has to show "???" and a BLIND badge. The host additionally gets the `blindLines` map.
- **No "listen to the original" anywhere in blind mode.** The reveal screen lists the written caption and the player's take only. Instead, final playback has an **ORIGINAL SUBTITLES** button (shown only when the match had blind lines, off by default, per device) that shows the written line live while the dub plays, timed by each line's start and end. It shows what the line was meant to say, not a transcript of the take.
- **Not done:** the eye-slash icon (blind lines show a text BLIND tag in the host's lists instead).

---

## 5. Match modes

**Goal:** more variety without rewriting ownership. Every mode **compiles to `lineAssignments`** at `startRecording()`. `ownerForLine` stays the single source of truth, and only Character mode keeps its live role mapping.

| Mode | How lines are owned | Extra rules |
| --- | --- | --- |
| `character` (existing) | One player per character | — |
| `line` (existing) | Deal or assign lines directly | — |
| `duet` | Each character gets **two** players; that character's lines alternate between them | Host or players pick pairs; auto-pair fills gaps |
| `relay` | Character ownership rotates every *N* lines (host picks N, default 3) through all players | Everyone voices every character a bit |
| `swap` | Two rounds: round 1 is normal Character mode; round 2 re-deals every line to a **different** player | Final playback can switch between round 1, round 2, or "best of" per line |
| `speed` | Any ownership above, plus `takeLimit: 1`, `lineTimeLimitSec: 10`, no retakes | The take is accepted automatically after upload |
| `mystery` (flag, not a mode) | Any mode; character and owner hidden from other players until the reveal | Uses §0.2 |

### Server

- Add a `compileAssignments(mode, pack, players, settings)` function in a new `server/session/modes.js`. It is pure and returns `lineAssignments`, which makes it easy to test.
- `duet` and `relay` are previewed during assignment. The host sees the compiled table and can edit single lines before starting, using the existing `assign-line`.
- `swap` needs a **round** concept. Add `data.round` (1 or 2) and `lineTakes[lineId]` → `lineTakes[round][lineId]`. A new host action, **Start round 2**, is available from review. The library stores both rounds. Of all the modes, this one makes the deepest change, so ship it last.
- `takeLimit` and `lineTimeLimitSec` are checked on the server. `beginRetake` and `storeTake` reject a take when the limit is used up. The time limit counts from an explicit `POST /api/player/open-line`, so the server owns the clock and a refresh doesn't reset it.

### Client

- **Host setup:** a mode picker with a short description and a "players needed" hint for each mode. For example, duet needs at least 2 × characters to give every character a pair.
- **Player:** a mode badge, and "Round 2 of 2" for swap. Speed mode shows the countdown and has no retake button.
- **Playback:** in swap mode, a round switcher.

### Tests

- One table test per mode for `compileAssignments`: line counts differ by at most one, queues stay chronological, and duet partners alternate.
- Limits are enforced on the server even when a client calls the API directly.
- Swap round 2 never gives a line to its round 1 owner when more than one player is present.

**Size:** `duet`, `relay`, `speed`, and `mystery` are small to medium. `swap` is medium-large because of rounds.

---

## 6. Handicaps and cards

**Goal:** each player gets a secret challenge, and the group guesses or laughs at the reveal.

### Card model

```js
Card = {
  id, title, text,                    // "Whisper everything", "You are a pirate"
  kind: 'performance' | 'effect' | 'constraint',
  effect: null | { chain: '-af ...' },// kind=effect: server-applied, allowlisted (§0.4)
  constraint: null | { blind?: {...}, takeLimit?, noReference? }, // kind=constraint
  weight: 1,                          // deal probability
};
```

- **Performance cards** (accent, emotion, "sing it", "as a villain") work on the honor system. They are the fun core, and nothing is enforced.
- **Effect cards** (robot, helium, radio, cave) apply a fixed server-side FFmpeg chain to every take the player uploads under that card. The player can't turn the effect off or bypass it.
- **Constraint cards** (one take, no original, blind captions) reuse the §4 and §5 enforcement for that player only.

### Decks

**Cards are data, never code.** No card text, title or effect chain is hardcoded in server or client source.

- **Storage:** cards live in a JSON deck store in the data directory (`<data dir>/cards/decks.json`), loaded and validated at startup and written atomically. The runtime is shipped with a default deck as a plain data file (`server/data/default-cards.json`, about 40 cards). On first start it is copied into the store as an ordinary, editable deck; after that the store is the only source of truth, so a host can edit or delete default cards like any other. A "restore default deck" action re-imports the shipped file as a new deck without overwriting the host's own.
- **Admin panel:** a Cards section with:
  - **Batch add:** paste many cards at once, either as JSON (an array of cards, the same format as export) or as plain text with one performance card per line (`Title | Text`). A preview shows which rows are valid and why the rest are rejected, and nothing is saved until the host confirms. Imports are all-or-nothing per confirmation, capped in count and size.
  - List, search, filter by kind, edit, enable or disable, weight, and delete cards.
  - Create, rename, duplicate, export and import whole decks as JSON, and choose the deck for the match (`rules.cards.deckId`).
- **Validation:** every card, from batch add or JSON import, goes through one `validateCard` function: known keys only, bounded text lengths, `kind` in the allowed set, bounded `weight`. Effect cards use the same allowlisted FFmpeg filter validator as Custom (§0.4), so a card cannot carry arbitrary FFmpeg arguments. Constraint cards are built from the fixed set of §4/§5 rule keys, not free text.
- **API:** `GET /api/admin/cards`, `POST /api/admin/cards/batch` (with `{ dryRun: true }` for the preview), `PATCH` and `DELETE /api/admin/cards/:id`, and deck endpoints beside them. Players never read the deck; they only see the cards dealt to them (§0.2).
- **Snapshotting:** at deal time the match copies the cards it uses into `data.cards`, so editing or deleting a card mid-match changes nothing for a game in progress, and the library entry (§2) keeps the cards that were played.
- A deck can be filtered by kind, for example "performance only" for groups without FFmpeg.

### Dealing (`rules.cards.deal`)

- `per-player`: one card per player for the whole match.
- `per-line`: a new card per line, drawn from the remaining deck.
- `per-character`: Character mode only.
- The host can **re-deal** one card before recording, and **veto** a card during recording, which removes its effect from future takes but not from accepted ones.

### Secrecy and guessing

- `data.cards` is private: the host sees all cards, and each player sees their own. It is redacted by §0.2 until the reveal.
- During the reveal (§0.3), each player guesses one card per other player from a shortlist: the real card plus 3 decoys from the same deck. The server scores +1 for a correct guess and +1 to the card holder for each player who guessed right. This rewards performing the card clearly.
- Scores show on the reveal screen and are saved to the library entry (`cards`, plus guesses and scores). The scoring is simple on purpose. A later voting or awards feature can build on the same reveal step.

### Server

- New endpoints:
  - `POST /api/admin/cards/deal`
  - `POST /api/admin/cards/redeal` with `{ playerId | lineId }`
  - `POST /api/admin/cards/veto`
  - `POST /api/player/guess` with `{ targetPlayerId, cardId }`, accepted only in `reveal`, one guess per target, changeable until the host closes guessing.
- `storeTake` looks up the active effect card for (player, line). If there is one, it runs `processTake` before committing, using the same failure path as Custom: the raw audio isn't saved, and the previous take is restored.
- `take.card` records the card ID that applied.

### Client

- **Player:** a card shown face-up on their own screen while recording (title + text + icon), and collapsible on mobile. Effect cards show "applied automatically after recording".
- **Reveal:** cards flip over one player at a time, with a guessing grid and a results table.
- **Host:** a card overview with re-deal and veto buttons, and the Cards section described under Decks (batch add, deck editor, import and export).

### Tests

- Card secrecy in snapshots before the reveal.
- An effect card can't be bypassed by uploading straight to the API, because the server applies the chain.
- A veto stops future processing.
- Guess scoring.
- A custom card with a disallowed filter is rejected.

**Size:** medium-large. It depends on §0.2, §0.3, §0.4, and works best after §4 and §5.

---

## Delivery order

| Phase | Work | Why this order |
| --- | --- | --- |
| 1 | §1 Avatars and colors | Small. Every later screen shows players |
| 2 | §0.1 rules object, §2 Library, §3 Export jobs | Library and exports share storage and the job queue; saving games removes the biggest current pain |
| 3 | §0.2 redaction, §0.3 reveal, §4 Blind lines | The first secret rule; proves redaction and reveal on the simplest case |
| 4 | §5 modes: duet, relay, speed, mystery | Mostly pure assignment compilers and limits |
| 5 | §0.4 server effects, §6 Cards | Reuses redaction, reveal, limits, and the FFmpeg pipeline |
| 6 | §5 swap (rounds) | Deepest data-model change; done last, when the library format is stable |

Each phase should end with:

- Tests for the new server rules, including direct-API bypass attempts.
- Updates to DESIGN.md (models and endpoint table) and README.md (host workflow).
- `library.manifest.version` bumped if the manifest changes, with a loader that still reads older versions.

## Open questions for the maintainer

1. Should the library be visible to players by default, or to the host only? The plan defaults to host only.
2. Should exports default to host only, as now, or be shared with players after playback?
3. Should avatar image uploads ever be allowed, or only the built-in icons?
4. In swap mode, should final playback pick "best of" per line by a vote, or leave the choice to the host?
5. Should FFmpeg become a hard requirement? Effect cards, library thumbnails, and audio exports all need it. The plan keeps it optional and hides those options when it's missing.
