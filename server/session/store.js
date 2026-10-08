import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export function randomId(bytes = 18) { return randomBytes(bytes).toString("base64url"); }
export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const record = value => Object.assign(Object.create(null), value);
const publicPack = pack => pack ? ({
  id: pack.id, metadata: pack.metadata, videoUrl: pack.videoUrl, backingTrackUrl: pack.backingTrackUrl,
  iconUrl: pack.iconUrl, characters: pack.characters, characterLineCounts: pack.characterLineCounts, lines: pack.lines,
}) : null;

export class SessionStore extends EventEmitter {
  constructor({ packs, dataDir, previewBefore = 1.5, previewAfter = 0.5 }) {
    super();
    this.serverId = randomId(12);
    this.packs = new Map(packs.map(pack => [pack.id, pack]));
    this.dataDir = dataDir;
    this.pack = null;
    this.pending = Promise.resolve();
    this.connections = new Map();
    this.revision = 0;
    this.settings = { previewBefore, previewAfter };
    this.reset();
  }
  reset() {
    this.data = {
      partyCreated: false, id: randomId(), joinToken: randomId(24), matchId: null,
      state: "lobby", packId: null, players: [],
      roleAssignments: record({}), readyPlayers: record({}), rolesLocked: false,
      options: {
        gameMode: "character",
        freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0,
        autoBalanceSuggestions: true, lockRolesWhenReady: true,
        referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false,
      },
      lineTakes: record({}), replacementTakes: record({}), activeRetakes: record({}),
      lineAssignments: record({}), lineVersions: record({}), recordingStarted: false, playback: null, pausedFrom: null,
    };
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.dataDir, "takes"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.dataDir, "tmp"), { recursive: true, mode: 0o700 });
    // Rooms are process-local. Discard snapshots from older versions and start
    // every server run with the fresh lobby created by the constructor.
    await fs.rm(path.join(this.dataDir, "session.json"), { force: true });
    for (const filename of await fs.readdir(this.dataDir)) {
      if (/^session\.json\.[A-Za-z0-9_-]+\.tmp$/.test(filename)) await fs.rm(path.join(this.dataDir, filename), { force: true });
    }
    // A crashed multipart request must not leave temporary uploads forever.
    for (const filename of await fs.readdir(path.join(this.dataDir, "tmp"))) {
      await fs.rm(path.join(this.dataDir, "tmp", filename), { force: true });
    }
    for (const filename of await fs.readdir(path.join(this.dataDir, "takes"))) {
      await fs.rm(path.join(this.dataDir, "takes", filename), { recursive: true, force: true });
    }
    return this;
  }
  takePath(take) { return path.join(this.dataDir, "takes", take.id + ".media"); }
  mutate(operation) {
    const task = this.pending.then(async () => {
      const oldData = structuredClone(this.data);
      const oldPack = this.pack;
      const oldRevision = this.revision;
      try {
        const result = await operation();
        this.revision++;
        const currentIds = new Set([...Object.values(this.data.lineTakes), ...Object.values(this.data.replacementTakes ?? {})].map(take => take.id));
        for (const take of [...Object.values(oldData.lineTakes), ...Object.values(oldData.replacementTakes ?? {})]) {
          if (!currentIds.has(take.id)) await fs.rm(this.takePath(take), { force: true }).catch(error => console.warn("Could not remove obsolete take:", error.message));
        }
        this.emit("change");
        return result;
      } catch (error) {
        this.data = oldData;
        this.data.roleAssignments = record(this.data.roleAssignments);
        for (const key of ["roleAssignments", "lineAssignments", "readyPlayers", "lineTakes", "replacementTakes", "activeRetakes", "lineVersions"]) {
          this.data[key] = record(this.data[key] ?? {});
        }
        this.pack = oldPack;
        this.revision = oldRevision;
        throw error;
      }
    });
    this.pending = task.catch(() => {});
    return task;
  }
  findPlayer(id) { return this.data.players.find(player => player.id === id); }
  findToken(token) { return this.data.players.find(player => player.token === token); }
  line(lineId) {
    const line = this.pack?.lines.find(line => line.id === lineId);
    if (!line) fail("Unknown line", 404);
    return line;
  }
  allComplete() { return !!this.pack && this.pack.lines.every(line => this.data.lineTakes[line.id]?.status === "accepted"); }
  completionPhase() {
    if (["recording", "review"].includes(this.data.state)) {
      if (this.allComplete() && !Object.keys(this.data.activeRetakes).length) this.data.state = "review";
      else if (Object.keys(this.data.activeRetakes).length) this.data.state = "recording";
    }
  }
  ownerForLine(lineId) {
    const line = this.line(lineId);
    if (this.data.options.gameMode === "line") return this.data.lineAssignments[lineId] || null;
    return this.data.roleAssignments[line.character] || null;
  }
  assignedLines(playerId) {
    return this.pack?.lines.filter(line => this.ownerForLine(line.id) === playerId).map(line => line.id) ?? [];
  }
  hasActiveRetakes() { return Object.keys(this.data.activeRetakes).length > 0; }
  cancelRetake(lineId) {
    const active = this.data.activeRetakes[lineId];
    if (!active) return null;
    delete this.data.activeRetakes[lineId];
    const candidate = this.data.replacementTakes[lineId];
    if (candidate?.retakeId === active.id) delete this.data.replacementTakes[lineId];
    return active;
  }
  cancelAllRetakes() {
    for (const lineId of Object.keys(this.data.activeRetakes)) this.cancelRetake(lineId);
  }
  queue(playerId) {
    const assignedCharacters = this.data.options.gameMode === "character"
      ? this.pack?.characters.filter(character => this.data.roleAssignments[character] === playerId) ?? []
      : [];
    const lines = this.assignedLines(playerId);
    const completedLines = lines.filter(id => this.data.lineTakes[id]?.status === "accepted");
    const pendingLines = lines.filter(id => this.data.lineTakes[id]?.status !== "accepted");
    const currentQueueIndex = pendingLines.length ? lines.indexOf(pendingLines[0]) : lines.length;
    return { playerId, assignedCharacters, lines, completedLines, pendingLines, currentQueueIndex };
  }
  snapshot(viewer) {
    const lineTakes = record({});
    for (const [lineId, take] of Object.entries(this.data.lineTakes)) {
      lineTakes[lineId] = { id: take.id, playerId: take.playerId, character: take.character, startTime: take.startTime, endTime: take.endTime, status: take.status, url: "/takes/" + take.id };
    }
    const replacementTakes = record({});
    if (viewer.kind === "player") for (const [lineId, take] of Object.entries(this.data.replacementTakes)) {
      if (take.playerId === viewer.playerId) replacementTakes[lineId] = { id: take.id, playerId: take.playerId, retakeId: take.retakeId, status: "recorded", url: "/takes/" + take.id };
    }
    const activeRetakes = Object.values(this.data.activeRetakes)
      .filter(retake => viewer.kind === "admin" || retake.playerId === viewer.playerId)
      .map(retake => ({ lineId: retake.lineId, playerId: retake.playerId, nickname: this.findPlayer(retake.playerId)?.nickname || "Player", startedAt: retake.startedAt }));
    const players = this.data.players.map(player => {
      const queue = this.queue(player.id);
      return { id: player.id, nickname: player.nickname, connected: (this.connections.get(player.id) ?? 0) > 0, ready: !!this.data.readyPlayers[player.id], assignedCharacters: queue.assignedCharacters, progress: { currentQueueIndex: queue.currentQueueIndex, totalAssignedLines: queue.lines.length, completedLines: queue.completedLines.length, pendingLines: queue.pendingLines.length } };
    });
    const session = {
      id: this.data.id, partyCreated: this.data.partyCreated, matchId: this.data.matchId,
      state: this.data.state, pack: publicPack(this.pack), players,
      roleAssignments: this.data.roleAssignments, readyPlayers: this.data.readyPlayers,
      rolesLocked: this.data.rolesLocked, recordingStarted: this.data.recordingStarted,
      lineAssignments: this.data.lineAssignments, lineTakes, replacementTakes,
      activeRetakes,
      completedLineCount: Object.values(lineTakes).filter(take => take.status === "accepted").length,
      totalLineCount: this.pack?.lines.length ?? 0, playback: this.data.playback,
      settings: { ...this.settings, ...this.data.options },
    };
    if (viewer.kind === "admin") session.joinToken = this.data.partyCreated ? this.data.joinToken : null;
    return { type: "state", serverId: this.serverId, revision: this.revision, serverTime: Date.now(), viewer, session, queue: viewer.kind === "player" ? this.queue(viewer.playerId) : null };
  }
  createParty() {
    this.reset();
    this.data.partyCreated = true;
    this.pack = null;
    this.connections.clear();
  }
  select(packId, partyId) {
    const pack = this.packs.get(packId);
    if (!pack) fail("Unknown pack", 404);
    if (!this.data.partyCreated) fail("Create a party before choosing a pack", 409);
    if (partyId !== this.data.id) fail("Party changed before the pack was selected", 409);
    if (this.data.state !== "lobby") fail("Return to the party before starting another match", 409);
    this.data.matchId = randomId();
    this.pack = pack;
    this.data.packId = packId;
    this.data.state = "lobby";
    this.data.roleAssignments = record({});
    this.data.readyPlayers = record({});
    this.data.rolesLocked = false;
    this.data.lineTakes = record({});
    this.data.replacementTakes = record({});
    this.data.activeRetakes = record({});
    this.data.lineAssignments = record({});
    this.data.recordingStarted = false;
    this.data.lineVersions = record({});
    this.data.playback = null;
    this.data.pausedFrom = null;
    if (this.data.options.maxRolesPerPlayer > 0) {
      this.data.options.maxRolesPerPlayer = Math.min(this.data.options.maxRolesPerPlayer, pack.characters.length);
    }
  }
  nextMatch() {
    if (!this.data.partyCreated || !this.pack || !["review", "playback"].includes(this.data.state)) {
      fail("Next match is available from review or final playback", 409);
    }
    this.pack = null;
    this.data.matchId = null;
    this.data.packId = null;
    this.data.state = "lobby";
    this.data.roleAssignments = record({});
    this.data.readyPlayers = record({});
    this.data.rolesLocked = false;
    this.data.lineTakes = record({});
    this.data.replacementTakes = record({});
    this.data.activeRetakes = record({});
    this.data.lineAssignments = record({});
    this.data.recordingStarted = false;
    this.data.lineVersions = record({});
    this.data.playback = null;
    this.data.pausedFrom = null;
  }
  requireMatch(matchId) {
    if (!this.data.matchId || matchId !== this.data.matchId) fail("Match changed. Refresh and try again.", 409);
  }
  openLobby() {
    if (!this.pack) fail("Select a pack first", 409);
    if (this.data.state !== "lobby") fail("The lobby is already open", 409);
    this.data.state = "assignment";
  }
  configure(options) {
    if (this.data.state !== "lobby") fail("Session setup is closed", 409);
    if (options.gameMode !== "character" && options.gameMode !== "line") fail("Invalid game mode");
    const max = options.maxRolesPerPlayer;
    if (!Number.isInteger(max) || max < 0 || max > (this.pack?.characters.length ?? 1000)) fail("Invalid maximum roles per player");
    this.data.options = { ...this.data.options, ...options };
    if (!this.data.options.allowMultipleRoles && this.data.options.maxRolesPerPlayer > 1) this.data.options.maxRolesPerPlayer = 1;
  }
  join({ roomId, joinToken, nickname }) {
    if (roomId !== this.data.id || joinToken !== this.data.joinToken) fail("Invalid room or join token", 403);
    if (!this.data.partyCreated) fail("The host has not created a party", 409);
    if (!["lobby", "assignment"].includes(this.data.state) || this.data.rolesLocked) fail("This game has started. Ask the host for help", 409);
    if (typeof nickname !== "string" || nickname.trim().length < 1 || nickname.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(nickname)) fail("Nickname must be 1–40 printable characters");
    const player = { id: randomId(), token: randomId(32), nickname: nickname.trim(), connected: false };
    this.data.players.push(player);
    return player;
  }
  assign(character, playerId) {
    if (this.data.options.gameMode !== "character") fail("Character assignment is unavailable in Line mode", 409);
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (!this.findPlayer(playerId)) fail("Unknown player", 404);
    if (this.data.state === "playback") fail("Stop playback before reassigning", 409);
    if (this.data.state === "lobby") fail("Open role selection before assigning characters", 409);
    if (this.data.roleAssignments[character] !== playerId) {
      if (this.data.state === "assignment") this.data.rolesLocked = false;
      for (const line of this.pack.lines.filter(line => line.character === character)) {
        this.cancelRetake(line.id);
        delete this.data.replacementTakes[line.id];
        this.data.lineVersions[line.id] = (this.data.lineVersions[line.id] ?? 0) + 1;
      }
      delete this.data.readyPlayers[playerId];
      const previousOwner = this.data.roleAssignments[character];
      if (previousOwner) delete this.data.readyPlayers[previousOwner];
    }
    this.data.roleAssignments[character] = playerId;
    // Recorded candidates have not been accepted and cannot follow new ownership.
    for (const [lineId, take] of Object.entries(this.data.lineTakes)) {
      if (take.character === character && take.status !== "accepted" && take.playerId !== playerId) delete this.data.lineTakes[lineId];
    }
    this.completionPhase();
  }
  dealLines() {
    if (this.data.options.gameMode !== "line") fail("Line dealing is unavailable in Character mode", 409);
    if (this.data.state !== "assignment" || this.data.recordingStarted) fail("Lines can only be dealt before recording", 409);
    const players = this.data.players.filter(player => (this.connections.get(player.id) ?? 0) > 0);
    if (!players.length) fail("At least one connected player is required to deal lines", 409);
    const tasks = [...this.pack.lines];
    for (let index = tasks.length - 1; index > 0; index--) {
      const target = Math.floor(Math.random() * (index + 1));
      [tasks[index], tasks[target]] = [tasks[target], tasks[index]];
    }
    this.data.lineAssignments = record({});
    tasks.forEach((line, index) => { this.data.lineAssignments[line.id] = players[index % players.length].id; });
    this.data.readyPlayers = record({});
    this.data.rolesLocked = false;
  }
  assignLine(lineId, playerId) {
    if (this.data.options.gameMode !== "line") fail("Line assignment is unavailable in Character mode", 409);
    const line = this.line(lineId);
    if (this.data.state === "lobby" || this.data.state === "playback") fail("Lines cannot be reassigned now", 409);
    if (playerId && !this.findPlayer(playerId)) fail("Unknown player", 404);
    const previousOwner = this.data.lineAssignments[lineId] || null;
    const nextOwner = playerId || null;
    if (previousOwner === nextOwner) return;
    if (this.data.state === "assignment") this.data.rolesLocked = false;
    this.cancelRetake(lineId);
    this.data.lineVersions[lineId] = (this.data.lineVersions[lineId] ?? 0) + 1;
    if (nextOwner) this.data.lineAssignments[lineId] = nextOwner;
    else delete this.data.lineAssignments[lineId];
    const take = this.data.lineTakes[lineId];
    if (take?.status !== "accepted") delete this.data.lineTakes[lineId];
    if (previousOwner) delete this.data.readyPlayers[previousOwner];
    if (nextOwner) delete this.data.readyPlayers[nextOwner];
    this.completionPhase();
  }
  assignedCharacters(playerId) {
    return this.pack?.characters.filter(character => this.data.roleAssignments[character] === playerId) ?? [];
  }
  roleLimit() {
    if (!this.data.options.allowMultipleRoles) return 1;
    return this.data.options.maxRolesPerPlayer || Infinity;
  }
  canLockRoles() {
    if (!this.pack) return false;
    if (this.data.options.gameMode === "line") return this.pack.lines.every(line => this.findPlayer(this.data.lineAssignments[line.id]));
    return this.pack.characters.every(character => this.findPlayer(this.data.roleAssignments[character]));
  }
  maybeLockRoles() {
    const participating = this.data.players.filter(player => this.data.options.gameMode === "line"
      ? this.assignedLines(player.id).length > 0
      : this.assignedCharacters(player.id).length > 0);
    const ready = participating.length > 0 && participating.every(player => this.data.readyPlayers[player.id]);
    if (this.data.options.lockRolesWhenReady && ready && this.canLockRoles()) this.data.rolesLocked = true;
  }
  claimRole(character, playerId) {
    if (this.data.options.gameMode !== "character") fail("Character assignment is unavailable in Line mode", 409);
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (!this.findPlayer(playerId)) fail("Unknown player", 404);
    if (this.data.state !== "assignment" || this.data.rolesLocked) fail("Role selection is locked", 409);
    if (!this.data.options.freeRolePicking) fail("The host is assigning roles", 403);
    const owner = this.data.roleAssignments[character];
    if (owner === playerId) return;
    if (owner) fail("That character is already taken", 409);
    if (this.assignedCharacters(playerId).length >= this.roleLimit()) fail("You have reached your role limit", 409);
    this.assign(character, playerId);
    this.maybeLockRoles();
  }
  releaseRole(character, playerId) {
    if (this.data.options.gameMode !== "character") fail("Character assignment is unavailable in Line mode", 409);
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (this.data.state !== "assignment" || this.data.rolesLocked) fail("Role selection is locked", 409);
    if (!this.data.options.freeRolePicking) fail("The host is assigning roles", 403);
    if (this.data.roleAssignments[character] !== playerId) fail("That character is not yours", 403);
    this.unassignRole(character);
  }
  unassignRole(character) {
    if (this.data.options.gameMode !== "character") fail("Character assignment is unavailable in Line mode", 409);
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (this.data.state === "playback" || this.data.state === "lobby") fail("Roles cannot be changed now", 409);
    const previousOwner = this.data.roleAssignments[character];
    if (!previousOwner) return;
    if (this.data.state === "assignment") this.data.rolesLocked = false;
    delete this.data.roleAssignments[character];
    for (const line of this.pack.lines.filter(line => line.character === character)) {
      this.cancelRetake(line.id);
      delete this.data.replacementTakes[line.id];
      this.data.lineVersions[line.id] = (this.data.lineVersions[line.id] ?? 0) + 1;
      const take = this.data.lineTakes[line.id];
      if (take?.status !== "accepted") delete this.data.lineTakes[line.id];
    }
    delete this.data.readyPlayers[previousOwner];
    this.completionPhase();
  }
  setPlayerReady(playerId, ready) {
    if (!this.findPlayer(playerId)) fail("Unknown player", 404);
    if (this.data.state !== "assignment" || this.data.rolesLocked) fail("Role selection is locked", 409);
    if (ready && !(this.data.options.gameMode === "line" ? this.assignedLines(playerId).length : this.assignedCharacters(playerId).length)) fail(this.data.options.gameMode === "line" ? "You have no assigned lines" : "Choose at least one character first", 409);
    if (ready) this.data.readyPlayers[playerId] = true;
    else delete this.data.readyPlayers[playerId];
    this.maybeLockRoles();
  }
  lockRoles() {
    if (this.data.state !== "assignment") fail("Role selection is not open", 409);
    if (!this.canLockRoles()) fail(this.data.options.gameMode === "line" ? "Assign every line before locking assignments" : "Assign every character before locking roles", 409);
    this.data.rolesLocked = true;
  }
  reopenRoles() {
    if (!["assignment", "recording", "review", "paused"].includes(this.data.state)) fail("Role selection cannot be reopened now", 409);
    this.data.state = "assignment";
    this.cancelAllRetakes();
    this.data.rolesLocked = false;
    this.data.readyPlayers = record({});
    this.data.pausedFrom = null;
  }
  distribute() {
    if (this.data.options.gameMode !== "character") fail("Character distribution is unavailable in Line mode", 409);
    if (!this.pack) fail("Select a pack first", 409);
    if (!this.data.players.length) fail("At least one player must join", 409);
    const weights = new Map(this.data.players.map(player => [player.id, 0]));
    const characters = this.pack.characters.map(character => ({ character, count: this.pack.lines.filter(line => line.character === character).length })).sort((a, b) => b.count - a.count);
    for (const { character, count } of characters) {
      const playerId = [...weights].sort((a, b) => a[1] - b[1])[0][0];
      this.assign(character, playerId);
      weights.set(playerId, weights.get(playerId) + count);
    }
  }
  fillUnassigned() {
    if (this.data.options.gameMode !== "character") fail("Character balancing is unavailable in Line mode", 409);
    if (!this.pack) fail("Select a pack first", 409);
    if (!this.data.players.length) fail("At least one player must join", 409);
    if (!this.data.options.autoBalanceSuggestions) fail("Auto-balance suggestions are turned off", 409);
    if (!["assignment", "recording", "review", "paused"].includes(this.data.state)) fail("Roles cannot be balanced now", 409);
    const weights = new Map(this.data.players.map(player => [player.id, this.assignedCharacters(player.id).reduce((sum, character) => sum + this.pack.lines.filter(line => line.character === character).length, 0)]));
    const free = this.pack.characters.filter(character => !this.data.roleAssignments[character]).map(character => ({ character, count: this.pack.lines.filter(line => line.character === character).length })).sort((a, b) => b.count - a.count);
    for (const { character, count } of free) {
      const playerId = [...weights].sort((a, b) => a[1] - b[1])[0][0];
      if (this.assignedCharacters(playerId).length >= this.roleLimit()) continue;
      this.assign(character, playerId);
      weights.set(playerId, weights.get(playerId) + count);
    }
  }
  startRecording() {
    if (!this.pack) fail("Select a pack first", 409);
    if (this.data.state === "playback") fail("Stop playback first", 409);
    if (this.data.state === "lobby") fail("Open the lobby first", 409);
    if (!this.canLockRoles()) fail(this.data.options.gameMode === "line" ? "Assign every line before recording" : "Assign every character before recording", 409);
    this.data.rolesLocked = true;
    this.data.recordingStarted = true;
    this.data.state = this.allComplete() && !this.hasActiveRetakes() ? "review" : "recording";
  }
  pause() {
    if (this.data.state !== "recording" && !(this.data.state === "paused" && this.data.pausedFrom === "recording")) fail("Session is not recording", 409);
    this.cancelAllRetakes();
    this.data.pausedFrom = this.data.state;
    this.data.state = "paused";
  }
  resume() {
    if (this.data.state !== "paused") fail("Session is not paused", 409);
    this.data.state = this.allComplete() ? "review" : "recording";
    this.data.pausedFrom = null;
  }
  openReview() {
    if (!["recording", "review", "paused"].includes(this.data.state)) fail("Review is not available now", 409);
    if (this.hasActiveRetakes()) fail("Players are finishing retakes", 409);
    this.data.state = "review";
    this.data.pausedFrom = null;
  }
  acceptAll() {
    if (!["recording", "review"].includes(this.data.state)) fail("Cannot accept takes in this phase", 409);
    for (const take of Object.values(this.data.lineTakes)) if (take.status === "recorded") take.status = "accepted";
    this.completionPhase();
  }
  requireOwner(playerId, lineId) {
    const line = this.line(lineId);
    if (!this.findPlayer(playerId) || this.ownerForLine(lineId) !== playerId) fail("Line belongs to another player", 403);
    if (this.data.state !== "recording") fail("Session is not recording", 409);
    return line;
  }
  beginRetake(lineId, playerId, attemptId = randomId(18)) {
    this.line(lineId);
    if (this.data.state !== "recording") fail("Retakes are only available during recording", 409);
    if (typeof attemptId !== "string" || attemptId.length < 1 || attemptId.length > 128) fail("Invalid retake attempt ID");
    this.requireOwner(playerId, lineId);
    const accepted = this.data.lineTakes[lineId];
    if (accepted?.status !== "accepted") fail("Only accepted lines can start a replacement retake", 409);
    const existing = this.data.activeRetakes[lineId];
    if (existing) {
      const sameAttempt = existing.playerId === playerId && existing.attemptId === attemptId &&
        existing.matchId === this.data.matchId && existing.lineVersion === (this.data.lineVersions[lineId] ?? 0) &&
        existing.acceptedTakeId === accepted.id;
      if (sameAttempt) return existing.id;
      fail(existing.playerId === playerId ? "A retake is already active in another tab" : "Another player is retaking this line", 409);
    }
    if (this.allComplete()) fail("All lines are complete; new retakes are closed", 409);
    if (Object.values(this.data.activeRetakes).some(retake => retake.playerId === playerId)) fail("Finish or cancel your active retake first", 409);
    const active = { id: randomId(24), attemptId, lineId, playerId, matchId: this.data.matchId, lineVersion: this.data.lineVersions[lineId] ?? 0, acceptedTakeId: accepted.id, startedAt: Date.now() };
    this.data.activeRetakes[lineId] = active;
    return active.id;
  }
  cancelPlayerRetake(lineId, { playerId, retakeId }) {
    const active = this.data.activeRetakes[lineId];
    if (!active || active.playerId !== playerId || active.id !== retakeId) fail("Retake changed; reload before cancelling", 409);
    this.cancelRetake(lineId);
    this.completionPhase();
  }
  discardCandidate(lineId, { playerId, takeId }) {
    this.requireOwner(playerId, lineId);
    if (this.data.activeRetakes[lineId]) fail("Cancel the active retake before discarding its replacement", 409);
    const candidate = this.data.lineTakes[lineId];
    if (!candidate || candidate.status !== "recorded") fail("No unaccepted take to discard", 404);
    if (candidate.playerId !== playerId || candidate.id !== takeId) fail("Take belongs to another player", 403);
    delete this.data.lineTakes[lineId];
    this.completionPhase();
  }
  storeTake({ playerId, lineId, id, mime, size, matchId, previousTakeId, lineVersion, retakeId }) {
    this.requireMatch(matchId);
    const line = this.requireOwner(playerId, lineId);
    if ((this.data.lineVersions[lineId] ?? 0) !== lineVersion) fail("Line changed during upload; retry", 409);
    const existing = this.data.lineTakes[lineId];
    let take;
    if (retakeId) {
      const active = this.data.activeRetakes[lineId];
      if (!active || active.id !== retakeId || active.playerId !== playerId || active.matchId !== matchId || active.lineVersion !== lineVersion) fail("Retake changed during upload; retry", 409);
      if (existing?.status !== "accepted" || existing.id !== active.acceptedTakeId) fail("Accepted take changed during upload", 409);
      const current = this.data.replacementTakes[lineId];
      if ((current?.id ?? null) !== previousTakeId) fail("Replacement changed during upload; retry", 409);
      take = { id, playerId, matchId, retakeId, lineId, lineVersion, acceptedTakeId: active.acceptedTakeId, character: line.character, startTime: line.startTime, endTime: line.endTime, status: "recorded", mime, size };
      this.data.replacementTakes[lineId] = take;
    } else {
      if (existing?.status === "accepted") fail("Accepted take requires an active replacement retake", 409);
      if (this.data.activeRetakes[lineId]) fail("Include the active retake ID", 409);
      if ((existing?.id ?? null) !== previousTakeId) fail("Take changed during upload; retry", 409);
      take = { id, playerId, matchId, character: line.character, startTime: line.startTime, endTime: line.endTime, status: "recorded", mime, size };
      this.data.lineTakes[lineId] = take;
    }
    return take;
  }
  accept(lineId, { playerId, takeId, retakeId } = {}) {
    const line = this.line(lineId);
    if (!["recording", "review"].includes(this.data.state)) fail("Cannot accept takes in this phase", 409);
    if (retakeId) {
      const active = this.data.activeRetakes[lineId];
      const candidate = this.data.replacementTakes[lineId];
      if (!playerId || !active || active.id !== retakeId || active.playerId !== playerId) fail("Retake changed; reload before accepting", 409);
      if (this.ownerForLine(lineId) !== playerId || active.matchId !== this.data.matchId || active.lineVersion !== (this.data.lineVersions[lineId] ?? 0)) fail("Line ownership changed during retake", 409);
      const accepted = this.data.lineTakes[lineId];
      if (accepted?.status !== "accepted" || accepted.id !== active.acceptedTakeId) fail("Accepted take changed during retake", 409);
      if (!candidate || candidate.retakeId !== retakeId || candidate.playerId !== playerId || candidate.id !== takeId || candidate.acceptedTakeId !== accepted.id) fail("Replacement take changed; reload before accepting", 409);
      this.data.lineTakes[lineId] = { ...candidate, status: "accepted" };
      delete this.data.replacementTakes[lineId];
      delete this.data.activeRetakes[lineId];
      this.completionPhase();
      return;
    }
    const take = this.data.lineTakes[lineId];
    if (!take) fail("No recorded take", 404);
    if (playerId) {
      if (this.ownerForLine(lineId) !== playerId || take.playerId !== playerId) fail("Take belongs to another player", 403);
      if (take.id !== takeId) fail("Take changed; reload before accepting", 409);
    }
    take.status = "accepted";
    this.completionPhase();
  }
  retake(lineId) {
    this.line(lineId);
    if (this.data.state === "playback") fail("Stop playback before requesting a retake", 409);
    this.cancelRetake(lineId);
    this.data.lineVersions[lineId] = (this.data.lineVersions[lineId] ?? 0) + 1;
    const previous = this.data.lineTakes[lineId];
    delete this.data.lineTakes[lineId];
    if (["recording", "review"].includes(this.data.state)) this.data.state = "recording";
    return previous;
  }
  startPlayback(allowMissing) {
    if (!this.pack) fail("Select a pack first", 409);
    if (!["recording", "review"].includes(this.data.state)) fail("Start recording first", 409);
    if (!this.allComplete() && !allowMissing) fail("Required lines are missing accepted takes", 409);
    if (this.hasActiveRetakes()) fail("Players are finishing retakes", 409);
    this.data.state = "playback";
    this.data.playback = { id: randomId(), startsAt: Date.now() + 5000 };
  }
  stopPlayback() {
    if (this.data.state !== "playback") fail("Playback has not started", 409);
    this.data.playback = null;
    this.data.state = "review";
  }
  async presence(playerId, delta) {
    if (!this.findPlayer(playerId)) return;
    const count = Math.max(0, (this.connections.get(playerId) ?? 0) + delta);
    this.connections.set(playerId, count);
    if (delta < 0 && count === 0) {
      await this.mutate(() => {
        for (const [lineId, retake] of Object.entries(this.data.activeRetakes)) if (retake.playerId === playerId) this.cancelRetake(lineId);
        this.completionPhase();
      });
    } else this.emit("change");
  }
}
