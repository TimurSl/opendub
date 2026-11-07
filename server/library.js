import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { randomId } from "./session/store.js";

// The dub library: every finished match is saved under <data>/library/<entryId>/.
// It is the one deliberate exception to "a restart clears recordings": the live
// match is still wiped on startup, but saved entries survive.
export const MANIFEST_VERSION = 1;
const ENTRY_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TAKE_FILE = /^[A-Za-z0-9_-]+\.media$/;
const MAX_TITLE = 200;

const text = (value, max = 2048) => typeof value === "string" && value.length <= max;
const num = value => typeof value === "number" && Number.isFinite(value);
const plain = value => value && typeof value === "object" && !Array.isArray(value);

// Returns the manifest when it is well-formed and safe to serve, else throws.
// Only manifest-listed take files (matching TAKE_FILE, no separators) are ever
// served, so a hand-edited manifest cannot name a path.
export function validateManifest(manifest, expectedId) {
  const bad = reason => { throw new Error("Invalid library manifest: " + reason); };
  if (!plain(manifest)) bad("not an object");
  if (manifest.version !== MANIFEST_VERSION) bad("unsupported version");
  if (!ENTRY_ID.test(manifest.id ?? "") || (expectedId && manifest.id !== expectedId)) bad("id");
  if (!text(manifest.title, MAX_TITLE) || !manifest.title.trim()) bad("title");
  if (!num(manifest.createdAt) || !num(manifest.updatedAt)) bad("timestamps");
  if (!plain(manifest.pack) || !["id", "title", "language", "fingerprint"].every(key => text(manifest.pack[key], 512))) bad("pack");
  if (!plain(manifest.rules)) bad("rules");
  if (!Array.isArray(manifest.players) || manifest.players.length > 1000) bad("players");
  for (const player of manifest.players) {
    if (!plain(player) || !text(player.id, 128) || !text(player.nickname, 80)) bad("player");
  }
  if (!Array.isArray(manifest.lines) || manifest.lines.length > 10000) bad("lines");
  const files = new Set();
  for (const line of manifest.lines) {
    if (!plain(line) || !text(line.id, 256) || !text(line.character, 512) || !text(line.caption, 4096) || !num(line.startTime) || !num(line.endTime)) bad("line");
    if (line.take !== null) {
      const take = line.take;
      if (!plain(take) || !TAKE_FILE.test(take.file ?? "") || files.has(take.file) || !text(take.srcId, 128) || !text(take.mime, 64)) bad("take");
      if (!num(take.leadIn) || !num(take.tail) || take.leadIn < 0 || take.tail < 0) bad("take timing");
      files.add(take.file);
    }
  }
  if (typeof manifest.starred !== "boolean") bad("starred");
  return manifest;
}

const fingerprints = new WeakMap();
export async function packFingerprint(pack) {
  if (fingerprints.has(pack)) return fingerprints.get(pack);
  const hash = createHash("sha256");
  hash.update(JSON.stringify(pack.lines.map(line => [line.id, line.character, line.caption, line.startTime, line.endTime])));
  for (const file of [pack.video, pack.backingTrack]) hash.update(":" + (await fs.stat(file)).size);
  const value = hash.digest("hex").slice(0, 32);
  fingerprints.set(pack, value);
  return value;
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await fs.stat(target).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function placeFile(source, target) {
  // Hard link when possible (the live take is deleted later; the link keeps the data),
  // else copy. Always via a temporary name so a crash never leaves a half-written take.
  const temporary = target + "." + randomId(6) + ".tmp";
  try {
    try { await fs.link(source, temporary); } catch { await fs.copyFile(source, temporary); }
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export class Library {
  constructor({ dir, ffmpegPath = "ffmpeg", enabled = true, maxEntries = 200, maxBytes = 10 * 1024 ** 3 }) {
    this.dir = dir; this.ffmpegPath = ffmpegPath; this.enabled = enabled;
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.entries = new Map(); // id -> { manifest | null, damaged, reason, size }
    this.byMatch = new Map(); // matchId -> entry id (memory only: live matches never survive a restart)
    this.signatures = new Map();
    this.chain = Promise.resolve();
  }
  async init() {
    if (!this.enabled) return this;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const dirent of await fs.readdir(this.dir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !ENTRY_ID.test(dirent.name)) continue;
      const directory = path.join(this.dir, dirent.name);
      try {
        const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")), dirent.name);
        for (const line of manifest.lines) if (line.take) await fs.access(path.join(directory, "takes", line.take.file));
        this.entries.set(dirent.name, { manifest, damaged: false, size: await directorySize(directory) });
      } catch (error) {
        console.warn("Library entry " + dirent.name + " is damaged: " + error.message);
        this.entries.set(dirent.name, { manifest: null, damaged: true, reason: "Manifest or take files are missing or invalid", size: await directorySize(directory) });
      }
      // Leftovers from a crash mid-write.
      for (const name of await fs.readdir(path.join(directory, "takes")).catch(() => [])) if (name.endsWith(".tmp")) await fs.rm(path.join(directory, "takes", name), { force: true });
    }
    return this;
  }
  serial(task) { const run = this.chain.then(task); this.chain = run.catch(() => {}); return run; }
  flush() { return this.chain; }
  entryDir(id) { if (!ENTRY_ID.test(id)) return null; return path.join(this.dir, id); }
  summary(id, entry) {
    if (entry.damaged) return { id, damaged: true, reason: entry.reason, size: entry.size };
    const { manifest } = entry;
    const takes = manifest.lines.filter(line => line.take).length;
    return {
      id, damaged: false, title: manifest.title, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt, starred: manifest.starred,
      incomplete: !!manifest.incomplete, pack: manifest.pack, players: manifest.players, lineCount: manifest.lines.length, takeCount: takes,
      hasThumb: !!manifest.hasThumb, size: entry.size, rules: manifest.rules,
      duration: Math.max(0, ...manifest.lines.map(line => line.endTime)),
    };
  }
  list() {
    return [...this.entries].map(([id, entry]) => this.summary(id, entry)).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  get(id) { const entry = this.entries.get(id); return entry && !entry.damaged ? entry.manifest : null; }
  has(id) { return this.entries.has(id); }

  // Saves a match, or updates its entry when takes or player profiles changed.
  // Called while the match is in review or playback. `takePath(take)` locates live take files.
  syncMatch({ matchId, pack, data, takePath }) {
    if (!this.enabled || !matchId || !pack) return Promise.resolve(null);
    const accepted = pack.lines.map(line => [line, data.lineTakes[line.id]]).filter(([, take]) => take?.status === "accepted");
    if (!accepted.length) return Promise.resolve(null);
    const players = data.players.map(player => ({ id: player.id, nickname: player.nickname, color: player.color, avatar: player.avatar ?? null }));
    const signature = JSON.stringify([pack.id, accepted.map(([line, take]) => [line.id, take.id, take.recorder ?? null]), players, data.rules]);
    if (this.signatures.get(matchId) === signature) return Promise.resolve(this.byMatch.get(matchId) ?? null);
    // Snapshot everything the save needs now: the live data is mutated by later commits.
    const job = {
      matchId, signature, rules: structuredClone(data.rules), players,
      pack, lines: pack.lines.map(line => ({ line, take: data.lineTakes[line.id]?.status === "accepted" ? { ...data.lineTakes[line.id], path: takePath(data.lineTakes[line.id]) } : null })),
    };
    return this.serial(() => this.save(job));
  }
  async save(job) {
    const { matchId, pack } = job;
    const now = Date.now();
    let id = this.byMatch.get(matchId);
    const existing = id ? this.entries.get(id)?.manifest : null;
    if (!id) id = randomId(12);
    const directory = this.entryDir(id);
    const takesDirectory = path.join(directory, "takes");
    await fs.mkdir(takesDirectory, { recursive: true, mode: 0o700 });
    const previous = new Map((existing?.lines ?? []).map(line => [line.id, line.take]));
    const lines = [];
    const keep = new Set();
    let takesChanged = false;
    for (const [index, { line, take }] of job.lines.entries()) {
      let saved = null;
      if (take) {
        const old = previous.get(line.id);
        const file = `line-${index}.media`;
        if (!old || old.srcId !== take.id || old.file !== file) { await placeFile(take.path, path.join(takesDirectory, file)); takesChanged = true; }
        keep.add(file);
        saved = { file, srcId: take.id, recorderId: take.playerId, recorder: take.recorder ?? null, mime: take.mime, size: take.size ?? 0, leadIn: take.leadIn || 0, tail: take.tail || 0, card: take.card ?? null };
      }
      lines.push({ id: line.id, character: line.character, caption: line.caption, startTime: line.startTime, endTime: line.endTime, take: saved });
    }
    for (const name of await fs.readdir(takesDirectory)) if (!keep.has(name)) { await fs.rm(path.join(takesDirectory, name), { force: true }); takesChanged = true; }
    // A cached render is only valid for the takes it was made from.
    if (existing && takesChanged) await this.clearExports(id);
    const date = new Date(now).toISOString().slice(0, 10);
    const manifest = validateManifest({
      id, version: MANIFEST_VERSION, createdAt: existing?.createdAt ?? now, updatedAt: now,
      title: existing?.title ?? `${pack.metadata.title || "Untitled"} · ${date}`.slice(0, MAX_TITLE),
      pack: { id: pack.id, title: String(pack.metadata.title ?? ""), language: String(pack.metadata.language ?? ""), fingerprint: await packFingerprint(pack) },
      rules: job.rules, players: job.players, lines, cards: null, awards: null,
      starred: existing?.starred ?? false, incomplete: lines.some(line => !line.take), hasThumb: existing?.hasThumb ?? false,
    }, id);
    await this.writeManifest(id, manifest);
    this.byMatch.set(matchId, id);
    this.signatures.set(matchId, job.signature);
    this.entries.set(id, { manifest, damaged: false, size: await directorySize(directory) });
    // The video frame is cosmetic: never block or fail the save on it.
    if (!manifest.hasThumb) this.makeThumb(id, pack).catch(() => {});
    await this.prune();
    return id;
  }
  async writeManifest(id, manifest) {
    const directory = this.entryDir(id);
    const temporary = path.join(directory, "manifest.json." + randomId(6) + ".tmp");
    try {
      await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      await fs.rename(temporary, path.join(directory, "manifest.json"));
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async makeThumb(id, pack) {
    const directory = this.entryDir(id);
    const temporary = path.join(directory, "thumb." + randomId(6) + ".jpg");
    const ok = await new Promise(resolve => {
      const child = spawn(this.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, Math.max(...pack.lines.map(line => line.endTime)) / 2)), "-i", pack.video, "-frames:v", "1", "-vf", "scale=320:-2", "-y", temporary], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", code => resolve(code === 0));
    });
    if (!ok) { await fs.rm(temporary, { force: true }).catch(() => {}); return; }
    await this.serial(async () => {
      const entry = this.entries.get(id);
      if (!entry?.manifest) { await fs.rm(temporary, { force: true }); return; }
      await fs.rename(temporary, path.join(directory, "thumb.jpg"));
      entry.manifest = { ...entry.manifest, hasThumb: true };
      await this.writeManifest(id, entry.manifest);
    });
  }
  patch(id, { title, starred }) {
    return this.serial(async () => {
      const entry = this.entries.get(id);
      if (!entry?.manifest) return null;
      const next = { ...entry.manifest, updatedAt: Date.now() };
      if (title !== undefined) {
        if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(title)) { const error = new Error("Title must be 1–" + MAX_TITLE + " printable characters"); error.status = 400; throw error; }
        next.title = title.trim();
      }
      if (starred !== undefined) {
        if (typeof starred !== "boolean") { const error = new Error("Invalid starred"); error.status = 400; throw error; }
        next.starred = starred;
      }
      validateManifest(next, id);
      await this.writeManifest(id, next);
      entry.manifest = next;
      return next;
    });
  }
  remove(id) {
    return this.serial(async () => {
      if (!this.entries.has(id)) return false;
      await fs.rm(this.entryDir(id), { recursive: true, force: true });
      this.entries.delete(id);
      for (const [matchId, entryId] of this.byMatch) if (entryId === id) { this.byMatch.delete(matchId); this.signatures.delete(matchId); }
      return true;
    });
  }
  // Oldest unstarred entries go first. Starred entries are never pruned, even
  // when that leaves the library over its limits.
  async prune() {
    const total = () => [...this.entries.values()].reduce((sum, entry) => sum + entry.size, 0);
    const victims = [...this.entries].filter(([, entry]) => !entry.manifest?.starred)
      .sort((a, b) => (a[1].manifest?.createdAt ?? 0) - (b[1].manifest?.createdAt ?? 0));
    const protectedIds = new Set(this.byMatch.values());
    for (const [id] of victims) {
      if (this.entries.size <= this.maxEntries && total() <= this.maxBytes) break;
      if (protectedIds.has(id)) continue; // the entry of the match being played right now
      await fs.rm(this.entryDir(id), { recursive: true, force: true });
      this.entries.delete(id);
    }
  }
  // Resolves one served file. The name must be one the manifest lists (or a fixed
  // derived name); nothing from the client is ever joined into a path unchecked.
  async resolveFile(id, file) {
    const entry = this.entries.get(id);
    if (!entry?.manifest) return null;
    const directory = this.entryDir(id);
    let relative = null; let type = null;
    const line = entry.manifest.lines.find(candidate => candidate.take?.file === file);
    if (line) { relative = path.join("takes", file); type = line.take.mime; }
    else if (file === "thumb.jpg" && entry.manifest.hasThumb) { relative = "thumb.jpg"; type = "image/jpeg"; }
    else if (file === "export.mp4" || file === "export.m4a") { relative = file; type = file.endsWith(".mp4") ? "video/mp4" : "audio/mp4"; }
    if (!relative) return null;
    const target = path.join(directory, relative);
    try {
      const real = await fs.realpath(target);
      const root = await fs.realpath(directory);
      const check = path.relative(root, real);
      if (!check || check.startsWith("..") || path.isAbsolute(check)) return null;
      return { path: real, type };
    } catch { return null; }
  }
  // Library-held renders (export.mp4 / export.m4a).
  async storeExport(id, file, source) {
    return this.serial(async () => {
      const entry = this.entries.get(id);
      if (!entry?.manifest || !["export.mp4", "export.m4a"].includes(file)) return false;
      await placeFile(source, path.join(this.entryDir(id), file));
      entry.size = await directorySize(this.entryDir(id));
      return true;
    });
  }
  async clearExports(id) {
    for (const file of ["export.mp4", "export.m4a"]) await fs.rm(path.join(this.entryDir(id), file), { force: true }).catch(() => {});
  }
}
