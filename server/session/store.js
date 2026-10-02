import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export function randomId(bytes = 18) { return randomBytes(bytes).toString("base64url"); }
export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const record = value => Object.assign(Object.create(null), value);
const publicPack = pack => pack ? ({
  id: pack.id, metadata: pack.metadata, videoUrl: pack.videoUrl, backingTrackUrl: pack.backingTrackUrl,
  iconUrl: pack.iconUrl, characters: pack.characters, lines: pack.lines,
}) : null;

export class SessionStore extends EventEmitter {
  constructor({ packs, dataDir, previewBefore = 1.5, previewAfter = 0.5 }) {
    super();
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
      id: randomId(), joinToken: randomId(24), state: "lobby", packId: null, players: [],
      roleAssignments: record({}), readyPlayers: record({}), rolesLocked: false,
      options: {
        freeRolePicking: true, allowMultipleRoles: true, maxRolesPerPlayer: 0,
        autoBalanceSuggestions: true, lockRolesWhenReady: true,
        referencePlaybackEnabled: true, voiceEffectsEnabled: true, compactMobilePreferred: false,
      },
      lineTakes: record({}), lineVersions: record({}), playback: null, pausedFrom: null,
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
        const currentIds = new Set(Object.values(this.data.lineTakes).map(take => take.id));
        for (const take of Object.values(oldData.lineTakes)) {
          if (!currentIds.has(take.id)) await fs.rm(this.takePath(take), { force: true }).catch(error => console.warn("Could not remove obsolete take:", error.message));
        }
        this.emit("change");
        return result;
      } catch (error) {
        this.data = oldData;
        this.data.roleAssignments = record(this.data.roleAssignments);
        this.data.lineTakes = record(this.data.lineTakes);
        this.data.lineVersions = record(this.data.lineVersions ?? {});
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
    if (["recording", "review"].includes(this.data.state) && this.allComplete()) this.data.state = "review";
  }
  queue(playerId) {
    const assignedCharacters = this.pack?.characters.filter(character => this.data.roleAssignments[character] === playerId) ?? [];
    const assigned = new Set(assignedCharacters);
    const lines = this.pack?.lines.filter(line => assigned.has(line.character)).map(line => line.id) ?? [];
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
    const players = this.data.players.map(player => {
      const queue = this.queue(player.id);
      return { id: player.id, nickname: player.nickname, connected: (this.connections.get(player.id) ?? 0) > 0, ready: !!this.data.readyPlayers[player.id], assignedCharacters: queue.assignedCharacters, progress: { currentQueueIndex: queue.currentQueueIndex, totalAssignedLines: queue.lines.length, completedLines: queue.completedLines.length, pendingLines: queue.pendingLines.length } };
    });
    const session = {
      id: this.data.id, state: this.data.state, pack: publicPack(this.pack), players,
      roleAssignments: this.data.roleAssignments, readyPlayers: this.data.readyPlayers,
      rolesLocked: this.data.rolesLocked, lineTakes,
      completedLineCount: Object.values(lineTakes).filter(take => take.status === "accepted").length,
      totalLineCount: this.pack?.lines.length ?? 0, playback: this.data.playback,
      settings: { ...this.settings, ...this.data.options },
    };
    if (viewer.kind === "admin") session.joinToken = this.data.joinToken;
    return { type: "state", revision: this.revision, serverTime: Date.now(), viewer, session, queue: viewer.kind === "player" ? this.queue(viewer.playerId) : null };
  }
  select(packId) {
    const pack = this.packs.get(packId);
    if (!pack) fail("Unknown pack", 404);
    this.reset();
    this.connections.clear();
    this.pack = pack;
    this.data.packId = packId;
    this.data.state = "lobby";
  }
  openLobby() {
    if (!this.pack) fail("Select a pack first", 409);
    if (this.data.state !== "lobby") fail("The lobby is already open", 409);
    this.data.state = "assignment";
  }
  configure(options) {
    if (this.data.state !== "lobby") fail("Session setup is closed", 409);
    const max = options.maxRolesPerPlayer;
    if (!Number.isInteger(max) || max < 0 || max > (this.pack?.characters.length ?? 0)) fail("Invalid maximum roles per player");
    this.data.options = { ...this.data.options, ...options };
    if (!this.data.options.allowMultipleRoles && this.data.options.maxRolesPerPlayer > 1) this.data.options.maxRolesPerPlayer = 1;
  }
  join({ roomId, joinToken, nickname }) {
    if (roomId !== this.data.id || joinToken !== this.data.joinToken) fail("Invalid room or join token", 403);
    if (!this.pack) fail("Host has not selected a pack", 409);
    if (typeof nickname !== "string" || nickname.trim().length < 1 || nickname.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(nickname)) fail("Nickname must be 1–40 printable characters");
    const player = { id: randomId(), token: randomId(32), nickname: nickname.trim(), connected: false };
    this.data.players.push(player);
    return player;
  }
  assign(character, playerId) {
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (!this.findPlayer(playerId)) fail("Unknown player", 404);
    if (this.data.state === "playback") fail("Stop playback before reassigning", 409);
    if (this.data.state === "lobby") fail("Open role selection before assigning characters", 409);
    if (this.data.roleAssignments[character] !== playerId) {
      for (const line of this.pack.lines.filter(line => line.character === character)) this.data.lineVersions[line.id] = (this.data.lineVersions[line.id] ?? 0) + 1;
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
  assignedCharacters(playerId) {
    return this.pack?.characters.filter(character => this.data.roleAssignments[character] === playerId) ?? [];
  }
  roleLimit() {
    if (!this.data.options.allowMultipleRoles) return 1;
    return this.data.options.maxRolesPerPlayer || Infinity;
  }
  canLockRoles() {
    return !!this.pack && this.pack.characters.every(character => this.findPlayer(this.data.roleAssignments[character]));
  }
  maybeLockRoles() {
    const ready = this.data.players.length > 0 && this.data.players.every(player => this.data.readyPlayers[player.id]);
    if (this.data.options.lockRolesWhenReady && ready && this.canLockRoles()) this.data.rolesLocked = true;
  }
  claimRole(character, playerId) {
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (!this.findPlayer(playerId)) fail("Unknown player", 404);
    if (this.data.state !== "assignment" || this.data.rolesLocked) fail("Role selection is locked", 409);
    if (!this.data.options.freeRolePicking) fail("The host is assigning roles", 403);
    const owner = this.data.roleAssignments[character];
    if (owner === playerId) return;
    if (owner) fail("That character is already taken", 409);
    if (this.assignedCharacters(playerId).length >= this.roleLimit()) fail("You have reached your role limit", 409);
    this.data.roleAssignments[character] = playerId;
    delete this.data.readyPlayers[playerId];
    this.maybeLockRoles();
  }
  releaseRole(character, playerId) {
    if (!this.pack?.characters.includes(character)) fail("Unknown character", 404);
    if (this.data.state !== "assignment" || this.data.rolesLocked) fail("Role selection is locked", 409);
    if (this.data.roleAssignments[character] !== playerId) fail("That character is not yours", 403);
    delete this.data.roleAssignments[character];
    delete this.data.readyPlayers[playerId];
  }
  setPlayerReady(playerId, ready) {
    if (!this.findPlayer(playerId)) fail("Unknown player", 404);
    if (this.data.state !== "assignment" || this.data.rolesLocked) fail("Role selection is locked", 409);
    if (ready && !this.assignedCharacters(playerId).length) fail("Choose at least one character first", 409);
    if (ready) this.data.readyPlayers[playerId] = true;
    else delete this.data.readyPlayers[playerId];
    this.maybeLockRoles();
  }
  lockRoles() {
    if (this.data.state !== "assignment") fail("Role selection is not open", 409);
    if (!this.canLockRoles()) fail("Assign every character before locking roles", 409);
    this.data.rolesLocked = true;
  }
  reopenRoles() {
    if (!["assignment", "recording", "review", "paused"].includes(this.data.state)) fail("Role selection cannot be reopened now", 409);
    this.data.state = "assignment";
    this.data.rolesLocked = false;
    this.data.readyPlayers = record({});
    this.data.pausedFrom = null;
  }
  distribute() {
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
    if (!this.pack.characters.every(character => this.findPlayer(this.data.roleAssignments[character]))) fail("Assign every character before recording", 409);
    this.data.rolesLocked = true;
    this.data.state = this.allComplete() ? "review" : "recording";
  }
  pause() {
    if (this.data.state !== "recording") fail("Session is not recording", 409);
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
    if (!this.findPlayer(playerId) || this.data.roleAssignments[line.character] !== playerId) fail("Line belongs to another player", 403);
    if (this.data.state !== "recording") fail("Session is not recording", 409);
    return line;
  }
  storeTake({ playerId, lineId, id, mime, size, sessionId, previousTakeId, lineVersion }) {
    if (sessionId !== this.data.id) fail("Room changed during upload", 409);
    const line = this.requireOwner(playerId, lineId);
    if ((this.data.lineVersions[lineId] ?? 0) !== lineVersion) fail("Line changed during upload; retry", 409);
    const existing = this.data.lineTakes[lineId];
    if (existing?.status === "accepted") fail("Accepted take requires a host retake request", 409);
    if ((existing?.id ?? null) !== previousTakeId) fail("Take changed during upload; retry", 409);
    const take = { id, playerId, character: line.character, startTime: line.startTime, endTime: line.endTime, status: "recorded", mime, size };
    this.data.lineTakes[lineId] = take;
    return take;
  }
  accept(lineId, { playerId, takeId } = {}) {
    const line = this.line(lineId);
    if (!["recording", "review"].includes(this.data.state)) fail("Cannot accept takes in this phase", 409);
    const take = this.data.lineTakes[lineId];
    if (!take) fail("No recorded take", 404);
    if (playerId) {
      if (this.data.roleAssignments[line.character] !== playerId || take.playerId !== playerId) fail("Take belongs to another player", 403);
      if (take.id !== takeId) fail("Take changed; reload before accepting", 409);
    }
    take.status = "accepted";
    this.completionPhase();
  }
  retake(lineId) {
    this.line(lineId);
    if (this.data.state === "playback") fail("Stop playback before requesting a retake", 409);
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
    this.connections.set(playerId, Math.max(0, (this.connections.get(playerId) ?? 0) + delta));
    this.emit("change");
  }
}
