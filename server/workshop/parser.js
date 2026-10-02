import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Workshop INI values are data, never executable JavaScript.
export function parseIni(text) {
  if (typeof text !== "string" || text.length > 2 * 1024 * 1024) throw new Error("INI file is too large");
  const data = Object.create(null);
  let section = "", pending = "";
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const row = raw.trim();
    if (!pending && (!row || /^[;#]/.test(row))) continue;
    if (!pending && /^\[.*\]$/.test(row)) { section = row.slice(1, -1).trim(); continue; }
    if (section !== "data") continue;
    pending += (pending ? "\n" : "") + row;
    const match = /^([A-Za-z_][A-Za-z_0-9]*)\s*=\s*([\s\S]*)$/.exec(pending);
    if (!match) throw new Error("Malformed INI assignment");
    let quoted = false, escaped = false, depth = 0;
    for (const char of match[2]) {
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
      if (!quoted && char === "[") depth++;
      if (!quoted && char === "]") depth--;
    }
    if (quoted || depth > 0) continue;
    let value;
    try { value = JSON.parse(match[2]); } catch { throw new Error("Invalid INI value for " + match[1]); }
    if (Object.hasOwn(data, match[1])) throw new Error("Duplicate INI field " + match[1]);
    data[match[1]] = value;
    pending = "";
  }
  if (pending) throw new Error("Unterminated INI value");
  return data;
}
export const parseWorkshopIni = parseIni;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative);
}
async function safeFile(root, name, required = true) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || path.isAbsolute(name)) throw new Error("Invalid pack asset name");
  const target = path.resolve(root, name);
  if (!inside(root, target)) throw new Error("Asset escapes pack directory");
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("Symbolic link assets are not supported");
    const real = await fs.realpath(target);
    if (!inside(root, real)) throw new Error("Asset symlink escapes pack directory");
    if (!(await fs.stat(real)).isFile()) throw new Error("Asset is not a file");
    return real;
  } catch (error) { if (!required && error.code === "ENOENT") return null; throw error; }
}
function strings(value, field, empty = false) {
  if (!Array.isArray(value) || (!empty && !value.length) || !value.every(item => typeof item === "string" && item.length && item.length <= 512)) throw new Error("Invalid " + field);
  return value;
}

export async function parseWorkshopPack(directory, { id } = {}) {
  const root = await fs.realpath(directory);
  const metadataIni = parseIni(await fs.readFile(await safeFile(root, "_pack_info.ini"), "utf8"));
  if (typeof metadataIni.title !== "string" || !metadataIni.title.trim()) throw new Error("Pack title is missing");
  const metadata = {
    title: metadataIni.title.slice(0, 1000),
    authors: metadataIni.authors === undefined ? [] : strings(metadataIni.authors, "authors", true),
    language: typeof metadataIni.language === "string" ? metadataIni.language.slice(0, 100) : "",
    icon: typeof metadataIni.icon === "string" ? metadataIni.icon : null,
  };
  const packId = id ?? createHash("sha256").update(root).digest("hex").slice(0, 20);
  const assets = Object.create(null);
  const addAsset = (filename, type) => {
    if (!filename) return null;
    const assetId = createHash("sha256").update(filename).digest("hex").slice(0, 24);
    assets[assetId] = { path: filename, type };
    return "/media/" + packId + "/" + assetId;
  };
  const video = await safeFile(root, "dub_video.ogv");
  const backingTrack = await safeFile(root, "_backing_track.ogg");
  const icon = metadata.icon ? await safeFile(root, metadata.icon) : null;
  const videoUrl = addAsset(video, "video/ogg");
  const backingTrackUrl = addAsset(backingTrack, "audio/ogg");
  const iconUrl = addAsset(icon, icon && [".jpg", ".jpeg"].includes(path.extname(icon).toLowerCase()) ? "image/jpeg" : "image/png");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const lines = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith(".ini") || entry.name.startsWith("_")) continue;
    const row = parseIni(await fs.readFile(await safeFile(root, entry.name), "utf8"));
    if (typeof row.caption !== "string") throw new Error(entry.name + ": caption must be text");
    const starts = row.dub_timestamps, ends = row.dub_ends;
    const characters = strings(row.dub_characters, entry.name + ": dub_characters");
    if (!Array.isArray(starts) || !Array.isArray(ends) || !starts.length || starts.length !== ends.length || starts.length !== characters.length) throw new Error(entry.name + ": timing and character arrays must have matching lengths");
    if (!starts.every((start, i) => Number.isFinite(start) && start >= 0 && Number.isFinite(ends[i]) && ends[i] > start)) throw new Error(entry.name + ": invalid timestamps");
    if (new Set(characters).size !== 1) throw new Error(entry.name + ": multiple characters in one task are not supported in this MVP");
    const segments = starts.map((startTime, i) => ({ startTime, endTime: ends[i], character: characters[i] }));
    const startTime = Math.min(...starts), endTime = Math.max(...ends);
    const stem = entry.name.slice(0, -4);
    const referenceFile = await safeFile(root, stem + ".mp3", false);
    lines.push({ id: stem, caption: row.caption, startTime, endTime, duration: endTime - startTime, character: characters[0], referenceAudio: addAsset(referenceFile, "audio/mpeg"), segments });
  }
  if (!lines.length) throw new Error("Pack contains no recording lines");
  lines.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  return { id: packId, directory: root, metadata, video, backingTrack, icon, videoUrl, backingTrackUrl, iconUrl, characters: [...new Set(lines.map(line => line.character))], lines, assets };
}

export async function discoverPacks(workshopDir, { maxDepth = 3 } = {}) {
  const root = await fs.realpath(workshopDir);
  const packs = [], errors = [];
  async function visit(directory, depth) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.name === "_pack_info.ini")) {
      try { packs.push(await parseWorkshopPack(directory)); }
      catch (error) { errors.push({ name: path.relative(root, directory) || path.basename(directory), error: error.message }); }
      return;
    }
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || ["node_modules", "data"].includes(entry.name)) continue;
      try { await visit(path.join(directory, entry.name), depth + 1); }
      catch (error) { errors.push({ name: path.relative(root, path.join(directory, entry.name)), error: error.message }); }
    }
  }
  await visit(root, 0);
  return { packs, errors };
}
