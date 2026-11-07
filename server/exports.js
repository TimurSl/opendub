import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";
import { spawn } from "node:child_process";
import { randomId, fail } from "./session/store.js";

export const EXPORT_FORMATS = Object.freeze({ mp4: { extension: "mp4", mime: "video/mp4" }, m4a: { extension: "m4a", mime: "audio/mp4" } });
export const EXPORT_ACCESS = Object.freeze(["host", "players", "players-after-playback"]);
const KEEP_JOBS = 8;

// Renders the finished dub. `takes` is [{ take: { path, leadIn, tail }, line }]. Audio-only output
// (m4a) skips the video input entirely. FFmpeg is spawned without a shell and every value in the
// filter graph is a number computed here.
export async function renderMix({ pack, directory, ffmpegPath, takes, format, onProgress }) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomId(18);
  const extension = EXPORT_FORMATS[format].extension;
  const output = path.join(directory, id + "." + extension);
  const work = path.join(directory, id + ".work");
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const video = format === "mp4";
  const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1"];
  if (video) args.push("-i", pack.video);
  args.push("-i", pack.backingTrack);
  const base = video ? 1 : 0;
  const voiceInputs = [];
  try {
    for (const [index, { take, line }] of takes.entries()) {
      const copy = path.join(work, index + ".audio");
      await fs.copyFile(take.path, copy);
      args.push("-i", copy);
      const leadIn = take.leadIn ?? 0; const tail = take.tail ?? 0;
      const timelineStart = line.startTime - leadIn;
      voiceInputs.push({ input: index + base + 1, delay: Math.max(0, Math.round(timelineStart * 1000)), skip: Math.max(0, -timelineStart), duration: (line.duration ?? (line.endTime - line.startTime)) + leadIn + tail, key: `voice${index}`, end: line.endTime + tail });
    }
    const filters = [`[${base}:a]asetpts=PTS-STARTPTS[base]`];
    for (const voice of voiceInputs) filters.push(`[${voice.input}:a]atrim=start=${voice.skip.toFixed(6)}:duration=${voice.duration.toFixed(6)},asetpts=PTS-STARTPTS,adelay=${voice.delay}:all=1[${voice.key}]`);
    const sources = ["[base]", ...voiceInputs.map(voice => `[${voice.key}]`)].join("");
    filters.push(`${sources}amix=inputs=${voiceInputs.length + 1}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
    args.push("-filter_complex", filters.join(";"));
    if (video) args.push("-map", "0:v:0", "-map", "[aout]", "-vf", "tpad=stop_mode=clone:stop_duration=2", // Let final-line audio finish after the last video frame.
      "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart");
    else args.push("-map", "[aout]", "-vn", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart");
    args.push("-y", output);
    const estimate = Math.max(1, ...voiceInputs.map(voice => voice.end), ...(pack.lines ?? []).map(line => line.endTime)) + 2;
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; let buffered = "";
      child.stderr.on("data", chunk => { if (stderr.length < 4000) stderr += chunk; });
      child.stdout.on("data", chunk => {
        buffered = (buffered + chunk).slice(-4096);
        const match = [...buffered.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
        if (match) onProgress?.(Math.min(0.99, Number(match[1]) / 1e6 / estimate));
      });
      child.on("error", () => { const error = new Error("ffmpeg is unavailable; install it or set FFMPEG_PATH"); error.status = 503; reject(error); });
      child.on("exit", code => {
        if (code === 0) resolve();
        else { const error = new Error("Export failed: " + stderr.trim().slice(-1800)); error.status = 422; reject(error); }
      });
    });
    return { id, output };
  } catch (error) {
    await fs.rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

const slug = value => String(value ?? "").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "x";
const extensionFor = mime => ({ "audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a" })[mime] ?? ".bin";

// File names inside the take archives: NN_character_player.ext plus credits.txt.
export function zipEntries({ title, lines, players }) {
  const width = Math.max(2, String(lines.length).length);
  const entries = []; const credits = [`${title}`, ""];
  for (const [index, { line, take }] of lines.entries()) {
    if (!take) continue;
    const player = players.get(take.recorder?.id ?? take.playerId);
    const nickname = take.recorder?.nickname ?? player?.nickname ?? "unknown";
    const number = String(index + 1).padStart(width, "0");
    entries.push({ name: `${number}_${slug(line.character)}_${slug(nickname)}${extensionFor(take.mime)}`, path: take.path });
    credits.push(`${number}. ${line.character} — ${nickname}`);
  }
  entries.push({ name: "credits.txt", data: Buffer.from(credits.join("\n") + "\n", "utf8") });
  return entries;
}

// A store-only ZIP streamed straight to the response: nothing is written to disk. CRCs need one
// extra read per file, so memory stays flat however large the takes are.
export async function streamZip(res, filename, entries) {
  const date = new Date(); const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const prepared = [];
  for (const entry of entries) {
    let size = 0; let crc = 0;
    if (entry.data) { size = entry.data.length; crc = crc32(entry.data); }
    else {
      for await (const chunk of createReadStream(entry.path)) { size += chunk.length; crc = crc32(chunk, crc); }
    }
    prepared.push({ ...entry, size, crc, nameBuffer: Buffer.from(entry.name, "utf8") });
  }
  res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` });
  const write = chunk => new Promise((resolve, reject) => { if (res.destroyed) return reject(new Error("closed")); res.write(chunk, error => error ? reject(error) : resolve()); });
  let offset = 0; const central = [];
  for (const entry of prepared) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(0, 8);
    header.writeUInt16LE(dosTime, 10); header.writeUInt16LE(dosDate, 12); header.writeUInt32LE(entry.crc >>> 0, 14);
    header.writeUInt32LE(entry.size, 18); header.writeUInt32LE(entry.size, 22); header.writeUInt16LE(entry.nameBuffer.length, 26); header.writeUInt16LE(0, 28);
    await write(Buffer.concat([header, entry.nameBuffer]));
    if (entry.data) await write(entry.data);
    else for await (const chunk of createReadStream(entry.path)) await write(chunk);
    central.push({ entry, offset }); offset += header.length + entry.nameBuffer.length + entry.size;
  }
  const directoryStart = offset; let directorySize = 0;
  for (const { entry, offset: local } of central) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(0, 10);
    record.writeUInt16LE(dosTime, 12); record.writeUInt16LE(dosDate, 14); record.writeUInt32LE(entry.crc >>> 0, 16); record.writeUInt32LE(entry.size, 20);
    record.writeUInt32LE(entry.size, 24); record.writeUInt16LE(entry.nameBuffer.length, 28); record.writeUInt32LE(local, 42);
    const row = Buffer.concat([record, entry.nameBuffer]); directorySize += row.length; await write(row);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(directoryStart, 16);
  await write(end);
  res.end();
}

// Render queue. One FFmpeg render at a time; the rest wait. Jobs belong to the match (or library entry)
// that created them, and progress is visible to everyone who may download the result.
export class ExportManager {
  constructor({ directory, ffmpegPath, resolveSource, onChange, onFinished, isStale }) {
    this.isStale = isStale ?? (() => false);
    this.directory = directory; this.ffmpegPath = ffmpegPath; this.resolveSource = resolveSource;
    this.onChange = onChange ?? (() => {}); this.onFinished = onFinished ?? (() => {});
    this.jobs = new Map(); this.running = false; this.lastNotify = 0;
  }
  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(this.directory)) await fs.rm(path.join(this.directory, name), { recursive: true, force: true });
    return this;
  }
  // `signature` identifies the exact inputs. An identical queued, running or ready job is reused unless `force`.
  enqueue({ format, source, signature, requesterId, force = false }) {
    if (!EXPORT_FORMATS[format]) fail("Unknown export format");
    if (!force) {
      const same = [...this.jobs.values()].find(job => job.signature === signature && job.status !== "failed");
      if (same) return same;
    }
    const job = { id: randomId(18), format, source, signature, requesterId: requesterId ?? null, status: "queued", progress: 0, error: null, file: null, createdAt: Date.now() };
    job.done = new Promise(resolve => { job.finish = resolve; });
    this.jobs.set(job.id, job);
    this.notify(true);
    this.pump();
    return job;
  }
  notify(force = false) {
    const now = Date.now();
    if (!force && now - this.lastNotify < 750) return;
    this.lastNotify = now; this.onChange();
  }
  async pump() {
    if (this.running) return;
    const job = [...this.jobs.values()].find(candidate => candidate.status === "queued");
    if (!job) return;
    this.running = true; job.status = "rendering"; this.notify(true);
    try {
      const input = await this.resolveSource(job);
      const result = await renderMix({ ...input, directory: this.directory, ffmpegPath: this.ffmpegPath, format: job.format, onProgress: value => { job.progress = value; this.notify(); } });
      job.file = result.output;
      const verdict = await this.onFinished(job);
      if (verdict === false) { await fs.rm(result.output, { force: true }); job.file = null; throw Object.assign(new Error("The match changed while the export was rendering"), { status: 409 }); }
      job.status = "ready"; job.progress = 1;
    } catch (error) {
      // Take files vanish when the match ends mid-render; report that instead of a raw ENOENT.
      const stale = this.isStale(job);
      job.status = "failed"; job.error = stale ? "The match changed while the export was rendering" : error.message; job.errorStatus = stale ? 409 : (error.status ?? 500);
    }
    job.finish(job);
    this.running = false;
    await this.trim();
    this.notify(true);
    this.pump();
  }
  async trim() {
    const finished = [...this.jobs.values()].filter(job => ["ready", "failed"].includes(job.status));
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_JOBS))) {
      if (job.file) await fs.rm(job.file, { force: true }).catch(() => {});
      this.jobs.delete(job.id);
    }
  }
  // Drops everything that belonged to a match that no longer exists.
  async forgetMatch(matchId) {
    for (const job of [...this.jobs.values()]) {
      if (job.source.kind !== "live" || job.source.matchId === matchId || job.status === "rendering") continue;
      if (job.file) await fs.rm(job.file, { force: true }).catch(() => {});
      this.jobs.delete(job.id);
    }
  }
  get(id) { return this.jobs.get(id) ?? null; }
}
