import express from "express";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import https from "node:https";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { discoverPacks, parseIni, parseWorkshopIni, parseWorkshopPack } from "./workshop/parser.js";
import { SessionStore, fail, randomId } from "./session/store.js";
import { Library, packFingerprint } from "./library.js";
import { ExportManager, zipEntries, streamZip, EXPORT_FORMATS } from "./exports.js";
import { parseCustomAudioArgs, runCustomAudio } from "./custom-audio.js";
import { soundpadFormat, checkSoundpadFile, runSoundpadAudio } from "./soundpad-audio.js";
import { downloadWorkshopItem, workshopItemId, workshopAppId, workshopLimits, steamUsername, DUB_TOGETHER_APP_ID } from "./workshop/downloader.js";
import { secureEquals, initializeAdminToken, readAdminToken, tokenFile, parseWireGuardCidrs, wireGuardAddressAllowed } from "./admin-auth.js";
export { discoverPacks, parseIni, parseWorkshopIni, parseWorkshopPack, SessionStore };

const webDir = fileURLToPath(new URL("../web", import.meta.url));
function local(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}
function publicOrigin(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return "";
  if (typeof value !== "string") throw new Error("PUBLIC_LINK must be an absolute HTTP or HTTPS URL");
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error("PUBLIC_LINK must be an absolute HTTP or HTTPS URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("PUBLIC_LINK must be an absolute HTTP or HTTPS URL");
  }
  return parsed.origin;
}
function normalizedAddress(address) {
  if (typeof address !== "string" || address.includes("%")) return null;
  if (isIP(address) === 4) return address;
  if (isIP(address) !== 6) return null;
  const canonical = new URL("http://[" + address + "]").hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}
function trustedProxyAddresses(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return new Set();
  if (typeof value !== "string") throw new Error("TRUSTED_PROXY must be a comma-separated list of IP addresses");
  const addresses = value.split(",").map(address => normalizedAddress(address.trim()));
  if (addresses.some(address => !address)) throw new Error("TRUSTED_PROXY must be a comma-separated list of IP addresses");
  return new Set(addresses);
}
function requestProtocol(req, trustedProxy) {
  if (req.socket.encrypted) return "https:";
  // Only the directly connected proxy can attest to the public scheme. Never
  // use X-Forwarded-For/Host to extend that trust or grant local admin access.
  if (!trustedProxy.has(normalizedAddress(req.socket.remoteAddress))) return "http:";
  const forwarded = req.headers["x-forwarded-proto"];
  if (forwarded === undefined) return "http:";
  if (forwarded !== "http" && forwarded !== "https") fail("Invalid proxy protocol header", 403);
  return forwarded + ":";
}
function cookies(req) {
  const result = Object.create(null);
  for (const entry of (req.headers.cookie ?? "").split(";")) {
    const index = entry.indexOf("=");
    if (index >= 0) {
      try { result[entry.slice(0, index).trim()] = decodeURIComponent(entry.slice(index + 1)); } catch {}
    }
  }
  return result;
}
function validateBody(req, shape = {}) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("Expected a JSON object");
  if (Object.keys(body).some(key => !Object.hasOwn(shape, key))) fail("Unknown request field");
  for (const [key, type] of Object.entries(shape)) {
    const optional = type.endsWith("?");
    const expected = optional ? type.slice(0, -1) : type;
    if (optional && body[key] === undefined) continue;
    if (typeof body[key] !== expected) fail("Invalid " + key);
    if (type === "string" && body[key].length > 2048) fail("Invalid " + key);
  }
  return body;
}
function checkOrigin(req, trustedProxy) {
  const origin = req.headers.origin;
  if (req.headers["sec-fetch-site"] === "cross-site") fail("Cross-site requests are forbidden", 403);
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { fail("Invalid Origin", 403); }
  const protocol = requestProtocol(req, trustedProxy);
  if (parsed.protocol !== protocol || parsed.host !== req.headers.host) fail("Origin does not match runtime", 403);
}
async function signature(file, mime) {
  const handle = await fs.open(file, "r");
  const bytes = Buffer.alloc(16);
  let length;
  try { ({ bytesRead: length } = await handle.read(bytes, 0, 16, 0)); } finally { await handle.close(); }
  if (length < 8) fail("Recording file is too short");
  const valid = (mime === "audio/webm" && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) ||
    (mime === "audio/ogg" && bytes.subarray(0, 4).toString() === "OggS") ||
    (mime === "audio/mp4" && bytes.subarray(4, 8).toString() === "ftyp");
  if (!valid) fail("Recording content does not match its audio MIME type", 415);
}
async function transcode(pack, dataDir, ffmpegPath) {
  const stat = await fs.stat(pack.video);
  const cacheKey = createHash("sha256").update(pack.video + ":" + stat.size + ":" + stat.mtimeMs).digest("hex").slice(0, 32);
  const directory = path.join(dataDir, "video-cache");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, cacheKey + ".mp4");
  try { await fs.access(target); } catch {
    const temporary = target + "." + randomId() + ".mp4";
    try {
      await new Promise((resolve, reject) => {
        const process = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", pack.video, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", temporary], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        process.stderr.on("data", chunk => { if (stderr.length < 2048) stderr += chunk; });
        process.on("error", () => reject(new Error("ffmpeg is unavailable; install it or set FFMPEG_PATH")));
        process.on("exit", code => code === 0 ? resolve() : reject(new Error("Video conversion failed: " + stderr.trim())));
      });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  const assetId = "browser-video-" + cacheKey;
  pack.assets[assetId] = { path: target, type: "video/mp4", cached: true };
  pack.videoUrl = "/media/" + pack.id + "/" + assetId;
}
export async function createRuntime(options = {}) {
  const workshopDir = path.resolve(options.workshopDir ?? process.env.WORKSHOP_DIR ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? "./data");
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = Number(options.port ?? process.env.PORT ?? 7373);
  const downloadLimits = workshopLimits({
    maxFiles: options.workshopMaxFiles ?? process.env.WORKSHOP_MAX_FILES,
    maxBytes: options.workshopMaxBytes ?? process.env.WORKSHOP_MAX_BYTES,
  });
  const publicLink = publicOrigin(options.publicLink ?? process.env.PUBLIC_LINK);
  const trustedProxy = trustedProxyAddresses(options.trustedProxy ?? process.env.TRUSTED_PROXY);
  const tokenOverride = options.adminToken ?? process.env.ADMIN_TOKEN;
  const adminTokenFilename = tokenFile(dataDir);
  const adminToken = tokenOverride ?? await initializeAdminToken(adminTokenFilename);
  const currentAdminToken = () => tokenOverride ?? readAdminToken(adminTokenFilename);
  const wireGuardCidrs = parseWireGuardCidrs(options.wgAdminCidrs ?? process.env.WG_ADMIN_CIDRS ?? '');
  const clientAddress = req => {
    const direct = normalizedAddress(req.socket.remoteAddress);
    if (!trustedProxy.has(direct)) return direct;
    // Proxy MUST overwrite X-Real-IP, never append a user-controlled value.
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp !== 'string') return direct;
    return normalizedAddress(realIp.trim());
  };
  const wireGuardAdmin = req => wireGuardAddressAllowed(clientAddress(req), wireGuardCidrs);
  const maxUploadBytes = Number(options.maxUploadBytes ?? Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024);
  const previewBefore = Number(options.previewBefore ?? process.env.PREVIEW_BEFORE ?? 1.5);
  const previewAfter = Number(options.previewAfter ?? process.env.PREVIEW_AFTER ?? 0.5);
  if (typeof adminToken !== "string" || !adminToken.trim()) throw new Error("ADMIN_TOKEN cannot be empty");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be 0–65535");
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 16 || maxUploadBytes > 1024 * 1024 * 1024) throw new Error("Invalid upload byte limit");
  if (![previewBefore, previewAfter].every(value => Number.isFinite(value) && value >= 0 && value <= 30)) throw new Error("Preview padding must be 0–30 seconds");
  await fs.mkdir(workshopDir, { recursive: true, mode: 0o700 });
  const discovered = await discoverPacks(workshopDir);
  const store = await new SessionStore({ packs: discovered.packs, dataDir, previewBefore, previewAfter }).init();
  const libraryOff = (options.library ?? process.env.LIBRARY) === "off" || options.library === false;
  const library = await new Library({
    dir: path.join(dataDir, "library"), enabled: !libraryOff, ffmpegPath: options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
    maxEntries: Number(options.libraryMaxEntries ?? process.env.LIBRARY_MAX_ENTRIES ?? 200),
    maxBytes: Number(options.libraryMaxBytes ?? process.env.LIBRARY_MAX_BYTES ?? 10 * 1024 ** 3),
  }).init();
  // Save a match whenever it is in review or playback (first save, take replaced, profile changed).
  // Matches abandoned while recording are never saved.
  store.onCommit = ({ data, pack }) => {
    exportManager.forgetMatch(data.matchId).catch(() => {});
    return ["review", "playback"].includes(data.state)
      ? library.syncMatch({ matchId: data.matchId, pack, data, takePath: take => store.takePath(take) })
      : null;
  };
  const exportManager = await new ExportManager({
    directory: path.join(dataDir, "exports"), ffmpegPath: options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
    onChange: () => { store.revision++; store.emit("change"); },
    resolveSource: job => resolveExportSource(job),
    onFinished: job => finishExport(job),
    isStale: job => job.source.kind === "live" && store.data.matchId !== job.source.matchId,
  }).init();
  const transcodeVideo = options.transcodeVideo ?? process.env.TRANSCODE_VIDEO === "1";
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  let activeCustomAudioJobs = 0;
  const steamcmdPath = options.steamcmdPath ?? process.env.STEAMCMD_PATH ?? '';
  const steamcmdDir = path.resolve(options.steamcmdDir ?? process.env.STEAMCMD_DIR ?? path.join(dataDir, 'steamcmd'));
  const steamcmdAppId = workshopAppId(options.workshopAppId ?? process.env.WORKSHOP_APP_ID ?? DUB_TOGETHER_APP_ID);
  const steamcmdUsername = steamUsername(options.steamcmdUsername ?? process.env.STEAMCMD_USERNAME ?? 'anonymous');
  let workshopJob = null;
  if (transcodeVideo && store.pack) await transcode(store.pack, dataDir, ffmpegPath);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "no-store", "Permissions-Policy": "microphone=(self)" });
    res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try { if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) checkOrigin(req, trustedProxy); next(); } catch (error) { next(error); }
  });
  app.use(express.json({ limit: "16kb", strict: true }));
  app.get("/api/config", (req, res) => res.json({ publicLink }));
  function auth(req, requireKind) {
    const cookie = cookies(req);
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "")?.[1];
    const viewerPreference = new URL(req.url, "http://runtime.local").searchParams.get("viewer");
    const adminMatches = secureEquals(bearer ?? cookie.dub_admin, currentAdminToken());
    const wgAdmin = wireGuardAdmin(req);
    const player = store.findToken(bearer ?? cookie.dub_player);
    const kind = requireKind ?? viewerPreference;
    if (kind === "player") {
      if (player) return { kind: "player", playerId: player.id };
      if (adminMatches) fail("Player authorization required", 403);
      fail("Join the room first", 401);
    }
    if (kind === "admin") {
      if (!adminMatches && !wgAdmin) fail("Admin authorization required", player ? 403 : 401);
      return { kind: "admin" };
    }
    if (adminMatches || (wgAdmin && !player)) {
      return { kind: "admin" };
    }
    if (player) return { kind: "player", playerId: player.id };
    fail("Join the room first", 401);
  }
  const authenticated = kind => (req, res, next) => { try { req.viewer = auth(req, kind); next(); } catch (error) { next(error); } };
  const snapshot = (req, res) => res.json(store.snapshot(req.viewer));
  const setCookie = (req, res, name, token) => res.cookie(name, token, { httpOnly: true, sameSite: "strict", secure: requestProtocol(req, trustedProxy) === "https:", path: "/", maxAge: 30 * 24 * 60 * 60 * 1000 });
  app.post("/api/admin/login", async (req, res) => {
    if (requestProtocol(req, trustedProxy) !== "https:" && !local(req) && !wireGuardAdmin(req)) fail("Use HTTPS for admin login", 403);
    const { token } = validateBody(req, { token: "string" });
    if (!secureEquals(token, currentAdminToken())) fail("Invalid admin token", 401);
    setCookie(req, res, "dub_admin", currentAdminToken());
    res.json(store.snapshot({ kind: "admin" }));
  });
  app.get("/api/admin/packs", authenticated("admin"), async (req, res) => {
    const refreshed = await discoverPacks(workshopDir);
    discovered.packs = refreshed.packs;
    discovered.errors = refreshed.errors;
    store.packs = new Map(refreshed.packs.map(pack => [pack.id, pack]));
    res.json({ packs: discovered.packs.map(pack => ({ id: pack.id, metadata: pack.metadata, characters: pack.characters, characterLineCounts: pack.characterLineCounts, lineCount: pack.lines.length, characterCount: pack.characters.length, iconUrl: pack.icon ? `/api/admin/packs/${encodeURIComponent(pack.id)}/icon` : null })), errors: discovered.errors });
  });
  app.get('/api/admin/workshop/status', authenticated('admin'), (req, res) => {
    res.json({ enabled: !!steamcmdPath, appId: steamcmdAppId, job: workshopJob });
  });
  app.post('/api/admin/workshop/download', authenticated('admin'), (req, res) => {
    const { item } = validateBody(req, { item: 'string' });
    if (!steamcmdPath) fail('Workshop downloader is disabled: configure STEAMCMD_PATH', 503);
    if (workshopJob?.status === 'running') fail('Another Workshop download is running', 409);
    const id = workshopItemId(item);
    workshopJob = { id, status: 'running', startedAt: Date.now() };
    const job = workshopJob;
    // Async job: reverse proxy/browser request timeouts cannot interrupt the download.
    void (async () => {
      try {
        const result = await downloadWorkshopItem({ itemId: id, steamcmdPath, steamcmdDir, workshopDir, username: steamcmdUsername, appId: steamcmdAppId,
          ...downloadLimits,
          beforePublish: target => { if (store.pack?.directory === target) fail('Cannot update the pack while it is selected in an active match', 409); } });
        const refreshed = await discoverPacks(workshopDir);
        discovered.packs = refreshed.packs;
        discovered.errors = refreshed.errors;
        store.packs = new Map(refreshed.packs.map(pack => [pack.id, pack]));
        // Keep an in-progress session pinned to the previous object until the
        // next match, so downloading an update never changes its media mid-game.
        job.status = 'done'; job.packId = result.pack.id;
      } catch (error) {
        job.status = 'error'; job.error = String(error.message).slice(0, 400);
      } finally { job.finishedAt = Date.now(); }
    })();
    res.status(202).json({ job });
  });
  app.get("/api/admin/packs/:packId/icon", authenticated("admin"), async (req, res) => {
    const pack = store.packs.get(req.params.packId);
    if (!pack?.icon) fail("Pack icon not found", 404);
    const asset = Object.values(pack.assets).find(item => item.path === pack.icon);
    if (!asset) fail("Pack icon not found", 404);
    const real = await fs.realpath(asset.path);
    const relative = path.relative(pack.directory, real);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("Pack icon is outside its directory", 403);
    res.type(asset.type); res.sendFile(real, { dotfiles: "allow" });
  });
  const adminAction = (route, shape, operation, { matchScoped = true } = {}) => app.post("/api/admin/" + route, authenticated("admin"), async (req, res) => {
    const body = validateBody(req, matchScoped ? { ...shape, matchId: "string" } : shape);
    await store.mutate(() => {
      if (matchScoped) store.requireMatch(body.matchId);
      return operation(body);
    });
    snapshot(req, res);
  });
  adminAction("create-party", {}, () => store.createParty(), { matchScoped: false });
  app.post("/api/admin/select", authenticated("admin"), async (req, res) => {
    const { packId, partyId } = validateBody(req, { packId: "string", partyId: "string" });
    const pack = store.packs.get(packId);
    if (!pack) fail("Unknown pack", 404);
    if (transcodeVideo) await transcode(pack, dataDir, ffmpegPath);
    await store.mutate(() => store.select(packId, partyId));
    snapshot(req, res);
  });
  adminAction("settings", {
    gameMode: "string", rules: "object?",
    freeRolePicking: "boolean", allowMultipleRoles: "boolean", maxRolesPerPlayer: "number",
    autoBalanceSuggestions: "boolean", lockRolesWhenReady: "boolean",
    referencePlaybackEnabled: "boolean", voiceEffectsEnabled: "boolean", compactMobilePreferred: "boolean",
    libraryVisibleToPlayers: "boolean?", exportAccess: "string?",
  }, options => store.configure(options), { matchScoped: false });
  adminAction("next-match", {}, () => store.nextMatch(), { matchScoped: false });
  adminAction("open-lobby", {}, () => store.openLobby());
  adminAction("lock-roles", {}, () => store.lockRoles());
  adminAction("reopen-roles", {}, () => store.reopenRoles());
  adminAction("assign", { character: "string", playerId: "string" }, ({ character, playerId }) => store.assign(character, playerId));
  adminAction("unassign", { character: "string" }, ({ character }) => store.unassignRole(character));
  adminAction("deal-lines", {}, () => store.dealLines());
  adminAction("assign-line", { lineId: "string", playerId: "string" }, ({ lineId, playerId }) => store.assignLine(lineId, playerId));
  adminAction("distribute", {}, () => store.distribute());
  adminAction("fill-unassigned", {}, () => store.fillUnassigned());
  adminAction("start", {}, () => store.startRecording());
  adminAction("pause", {}, () => store.pause());
  adminAction("resume", {}, () => store.resume());
  adminAction("review", {}, () => store.openReview());
  adminAction("reveal", {}, () => store.openReveal());
  adminAction("accept-all", {}, () => store.acceptAll());
  adminAction("restart-playback", {}, () => {
    if (store.data.state !== "playback") fail("Playback is not active", 409);
    store.data.playback = { id: randomId(), startsAt: Date.now() + 5000 };
  });
  // ------------------------------------------------------------ exports
  const acceptedLiveTakes = () => store.pack ? store.pack.lines.flatMap(line => {
    const take = store.data.lineTakes[line.id];
    return take?.status === "accepted" ? [{ take: { ...take, path: store.takePath(take) }, line }] : [];
  }) : [];
  const liveTakesKey = () => acceptedLiveTakes().map(({ take }) => take.id).sort().join(",");
  const liveSource = () => ({ kind: "live", matchId: store.data.matchId, takesKey: liveTakesKey() });
  const liveSignature = format => `live:${store.data.matchId}:${format}:${liveTakesKey()}`;
  async function libraryTakes(manifest) {
    const takes = [];
    for (const line of manifest.lines) {
      if (!line.take) continue;
      const file = await library.resolveFile(manifest.id, line.take.file);
      if (file) takes.push({ take: { ...line.take, path: file.path }, line: { ...line, duration: line.endTime - line.startTime } });
    }
    return takes;
  }
  async function resolveExportSource(job) {
    if (job.source.kind === "live") {
      if (!store.pack || store.data.matchId !== job.source.matchId) fail("The match changed before the export started", 409);
      if (liveTakesKey() !== job.source.takesKey) fail("Takes changed while the export was queued", 409);
      return { pack: store.pack, takes: acceptedLiveTakes() };
    }
    const manifest = library.get(job.source.entryId);
    if (!manifest) fail("The library entry no longer exists", 404);
    const pack = store.packs.get(manifest.pack.id);
    if (!pack || await packFingerprint(pack) !== manifest.pack.fingerprint) fail("Install the original pack to export this dub", 409);
    return { pack, takes: await libraryTakes(manifest) };
  }
  // Called with the rendered file in place. Returning false discards it (the match moved on).
  async function finishExport(job) {
    const file = "export." + EXPORT_FORMATS[job.format].extension;
    if (job.source.kind === "library") { await library.storeExport(job.source.entryId, file, job.file); return true; }
    if (store.data.matchId !== job.source.matchId) return false;
    const entryId = library.byMatch.get(job.source.matchId);
    if (entryId) await library.storeExport(entryId, file, job.file).catch(error => console.warn("Could not store export in the library:", error.message));
    return true;
  }
  const jobView = job => ({
    id: job.id, format: job.format, status: job.status, progress: Math.round(job.progress * 100) / 100, error: job.error,
    mine: job.requesterId, source: job.source.kind, entryId: job.source.entryId ?? null,
    url: job.status === "ready" ? "/exports/" + job.id : null, filename: "open-dub-" + job.id.slice(0, 8) + "." + EXPORT_FORMATS[job.format].extension,
  });
  store.exportsView = viewer => {
    const jobs = [...exportManager.jobs.values()];
    if (viewer.kind === "admin") return jobs.map(jobView);
    if (!store.exportAllowedForPlayers()) return [];
    return jobs.filter(job => job.source.kind === "live" && job.source.matchId === store.data.matchId).map(jobView);
  };
  const canExport = viewer => viewer.kind === "admin" || store.exportAllowedForPlayers();
  const requireExportable = viewer => {
    if (!canExport(viewer)) fail("The host has not shared exports yet", 403);
    if (!store.pack || !["review", "playback"].includes(store.data.state)) fail("Finish review before exporting", 409);
    if (!acceptedLiveTakes().length) fail("There are no accepted takes to export", 409);
  };
  app.post("/api/exports", authenticated(), async (req, res) => {
    const { format, force } = validateBody(req, { format: "string", force: "boolean?" });
    if (!Object.hasOwn(EXPORT_FORMATS, format)) fail("Unknown export format");
    requireExportable(req.viewer);
    const job = exportManager.enqueue({
      format, source: liveSource(), signature: liveSignature(format),
      requesterId: req.viewer.playerId ?? null, force: req.viewer.kind === "admin" && !!force,
    });
    res.json({ jobId: job.id, job: jobView(job) });
  });
  // Take archives stream straight from the take files; nothing is written to disk.
  app.get("/exports/takes.zip", authenticated(), async (req, res) => {
    requireExportable(req.viewer);
    const lines = store.pack.lines.map(line => ({ line, take: store.data.lineTakes[line.id]?.status === "accepted" ? { ...store.data.lineTakes[line.id], path: store.takePath(store.data.lineTakes[line.id]) } : null }));
    await streamZip(res, "open-dub-takes.zip", zipEntries({ title: store.pack.metadata.title ?? "Open Dub", lines, players: new Map(store.data.players.map(player => [player.id, player])) }));
  });
  app.get("/exports/mine.zip", authenticated("player"), async (req, res) => {
    requireExportable(req.viewer);
    const lines = store.pack.lines.map(line => {
      const take = store.data.lineTakes[line.id];
      const mine = take?.status === "accepted" && (take.recorder?.id ?? take.playerId) === req.viewer.playerId;
      return { line, take: mine ? { ...take, path: store.takePath(take) } : null };
    });
    if (!lines.some(entry => entry.take)) fail("You have no accepted takes", 404);
    await streamZip(res, "open-dub-my-takes.zip", zipEntries({ title: store.pack.metadata.title ?? "Open Dub", lines, players: new Map(store.data.players.map(player => [player.id, player])) }));
  });
  app.get("/exports/:id", authenticated(), async (req, res) => {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(req.params.id)) fail("Unknown export", 404);
    const job = exportManager.get(req.params.id);
    if (!job || job.status !== "ready" || !job.file) fail("Unknown export", 404);
    if (req.viewer.kind !== "admin" && (!store.exportAllowedForPlayers() || job.source.kind !== "live" || job.source.matchId !== store.data.matchId)) fail("This export is not shared with you", 403);
    res.type(EXPORT_FORMATS[job.format].mime);
    res.download(job.file, jobView(job).filename);
  });
  // Compatibility: the original blocking export. It always renders fresh, then returns the link.
  app.post("/api/admin/export", authenticated("admin"), async (req, res) => {
    const { matchId } = validateBody(req, { matchId: "string" });
    store.requireMatch(matchId);
    requireExportable(req.viewer);
    const job = exportManager.enqueue({ format: "mp4", source: liveSource(), signature: liveSignature("mp4") + ":legacy:" + randomId(6), requesterId: null, force: true });
    await job.done;
    if (job.status === "failed") fail(job.error, job.errorStatus ?? 422);
    res.json({ url: "/api/admin/exports/" + job.id, filename: "open-dub-" + job.id + ".mp4" });
  });
  app.get("/api/admin/exports/:id", authenticated("admin"), async (req, res) => {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(req.params.id)) fail("Unknown export", 404);
    const job = exportManager.get(req.params.id);
    if (!job || job.status !== "ready") fail("Unknown export", 404);
    res.type(EXPORT_FORMATS[job.format].mime);
    res.sendFile(job.file);
  });
  app.post("/api/admin/retake", authenticated("admin"), async (req, res) => {
    const { lineId, matchId } = validateBody(req, { lineId: "string", matchId: "string" });
    const previous = await store.mutate(() => {
      store.requireMatch(matchId);
      return store.retake(lineId);
    });
    if (previous) await fs.rm(store.takePath(previous), { force: true });
    snapshot(req, res);
  });
  adminAction("accept", { lineId: "string" }, ({ lineId }) => store.accept(lineId));
  adminAction("playback", { allowMissing: "boolean" }, ({ allowMissing }) => store.startPlayback(allowMissing));
  adminAction("stop-playback", {}, () => store.stopPlayback());
  app.post("/api/join", async (req, res) => {
    const body = validateBody(req, { roomId: "string", joinToken: "string", nickname: "string", color: "string?", avatar: "string?" });
    const player = await store.mutate(() => store.join(body));
    setCookie(req, res, "dub_player", player.token);
    res.json({ ...store.snapshot({ kind: "player", playerId: player.id }), token: player.token });
  });
  const playerAction = (route, shape, operation) => app.post("/api/player/" + route, authenticated("player"), async (req, res) => {
    const body = validateBody(req, { ...shape, matchId: "string" });
    await store.mutate(() => {
      store.requireMatch(body.matchId);
      return operation(body, req.viewer.playerId);
    });
    snapshot(req, res);
  });
  // Profiles are not match-scoped: players can restyle themselves in the lobby
  // before any pack is chosen. A taken color answers 409 with the next free one.
  app.post("/api/player/profile", authenticated("player"), async (req, res) => {
    const body = validateBody(req, { nickname: "string?", color: "string?", avatar: "string?" });
    await store.mutate(() => store.updateProfile(req.viewer.playerId, body));
    snapshot(req, res);
  });
  playerAction("claim", { character: "string" }, ({ character }, playerId) => store.claimRole(character, playerId));
  playerAction("release", { character: "string" }, ({ character }, playerId) => store.releaseRole(character, playerId));
  playerAction("ready", { ready: "boolean" }, ({ ready }, playerId) => store.setPlayerReady(playerId, ready));
  app.post("/api/takes/:lineId/retake", authenticated("player"), async (req, res) => {
    const { matchId, attemptId } = validateBody(req, { matchId: "string", attemptId: "string?" });
    const retakeId = await store.mutate(() => {
      store.requireMatch(matchId);
      return store.beginRetake(req.params.lineId, req.viewer.playerId, attemptId);
    });
    res.json({ ...store.snapshot(req.viewer), retakeId });
  });
  app.post("/api/takes/:lineId/retake/cancel", authenticated("player"), async (req, res) => {
    const { matchId, retakeId } = validateBody(req, { matchId: "string", retakeId: "string" });
    await store.mutate(() => {
      store.requireMatch(matchId);
      return store.cancelPlayerRetake(req.params.lineId, { playerId: req.viewer.playerId, retakeId });
    });
    snapshot(req, res);
  });
  app.post("/api/takes/:lineId/discard", authenticated("player"), async (req, res) => {
    const { matchId, takeId } = validateBody(req, { matchId: "string", takeId: "string" });
    await store.mutate(() => {
      store.requireMatch(matchId);
      return store.discardCandidate(req.params.lineId, { playerId: req.viewer.playerId, takeId });
    });
    snapshot(req, res);
  });
  app.get("/api/state", authenticated(), snapshot);
  const upload = multer({
    dest: path.join(dataDir, "tmp"),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 100 },
    fileFilter(req, file, done) {
      const mime = file.mimetype.toLowerCase().split(";")[0].trim();
      if (!["audio/webm", "audio/ogg", "audio/mp4"].includes(mime)) { const error = new Error("Unsupported recording MIME type"); error.status = 415; done(error); }
      else { file.recordingMime = mime; done(null, true); }
    },
  }).single("take");
  const uploadCustom = multer({
    dest: path.join(dataDir, "tmp"),
    limits: { fileSize: Math.min(maxUploadBytes, 25 * 1024 * 1024), files: 1, fields: 1, parts: 2, fieldSize: 256, fieldNameSize: 100 },
    fileFilter(req, file, done) {
      const mime = file.mimetype.toLowerCase().split(";")[0].trim();
      if (!["audio/webm", "audio/ogg", "audio/mp4"].includes(mime)) { const error = new Error("Unsupported recording MIME type"); error.status = 415; done(error); }
      else { file.recordingMime = mime; done(null, true); }
    },
  }).single("take");
  const uploadSoundpad = multer({
    dest: path.join(dataDir, 'tmp'),
    limits: { fileSize: Math.min(maxUploadBytes, 25 * 1024 * 1024), files: 1, fields: 0, parts: 1, fieldNameSize: 100 },
    fileFilter(req, file, done) {
      const mime = file.mimetype.toLowerCase().split(';')[0].trim();
      if (!soundpadFormat(mime)) { const error = new Error('Unsupported sound format'); error.status = 415; done(error); }
      else { file.soundpadMime = mime; done(null, true); }
    },
  }).single('take');
  app.post('/api/takes/:lineId/soundpad', authenticated('player'), (req, res, next) => {
    try {
      req.soundMatchId = req.get('x-match-id');
      req.soundRetakeId = req.get('x-retake-id') || '';
      store.requireMatch(req.soundMatchId);
      store.requireOwner(req.viewer.playerId, req.params.lineId);
      if (activeCustomAudioJobs >= 2) fail('Sound processor is busy', 429);
      const accepted = store.data.lineTakes[req.params.lineId];
      const retake = store.data.activeRetakes[req.params.lineId];
      if (accepted?.status === 'accepted' && (!req.soundRetakeId || retake?.id !== req.soundRetakeId || retake.playerId !== req.viewer.playerId)) fail('Start a replacement retake first', 409);
      if (req.soundRetakeId && (retake?.id !== req.soundRetakeId || retake.playerId !== req.viewer.playerId || retake.matchId !== req.soundMatchId)) fail('Retake changed', 409);
      req.soundLineVersion = store.data.lineVersions[req.params.lineId] ?? 0;
      uploadSoundpad(req, res, next);
    } catch (error) { next(error); }
  }, async (req, res) => {
    let outputPath;
    try {
      if (!req.file) fail('Multipart field take is required');
      await checkSoundpadFile(req.file.path, req.file.soundpadMime);
      store.requireMatch(req.soundMatchId);
      const line = store.requireOwner(req.viewer.playerId, req.params.lineId);
      if ((store.data.lineVersions[req.params.lineId] ?? 0) !== req.soundLineVersion) fail('Line changed', 409);
      if (activeCustomAudioJobs >= 2) fail('Sound processor is busy', 429);
      activeCustomAudioJobs++;
      try {
        outputPath = path.join(dataDir, 'tmp', `soundpad-${randomId(24)}.webm`);
        await runSoundpadAudio(ffmpegPath, req.file.path, outputPath, req.file.soundpadMime, line.duration);
        const stats = await fs.stat(outputPath);
        if (!stats.size || stats.size > maxUploadBytes) fail('Sound conversion exceeded size limit', 413);
      } finally { activeCustomAudioJobs--; }
      store.requireMatch(req.soundMatchId);
      store.requireOwner(req.viewer.playerId, req.params.lineId);
      if ((store.data.lineVersions[req.params.lineId] ?? 0) !== req.soundLineVersion) fail('Line changed', 409);
      const retake = store.data.activeRetakes[req.params.lineId];
      if (req.soundRetakeId && (retake?.id !== req.soundRetakeId || retake.playerId !== req.viewer.playerId)) fail('Retake changed', 409);
      if (!req.soundRetakeId && store.data.lineTakes[req.params.lineId]?.status === 'accepted') fail('Take was accepted while processing', 409);
      res.type('audio/webm').send(await fs.readFile(outputPath));
    } finally {
      if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
      if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  });
  // This route is only for applying a tightly allowlisted -af chain to a
  // player's own recording. Raw FFmpeg argv/filtergraphs must never be exposed.
  app.post("/api/takes/:lineId/custom", authenticated("player"), (req, res, next) => {
    try {
      req.customMatchId = req.get("x-match-id");
      req.customRetakeId = req.get("x-retake-id") || "";
      store.requireMatch(req.customMatchId);
      store.requireOwner(req.viewer.playerId, req.params.lineId);
      if (store.data.options.voiceEffectsEnabled === false) fail("Voice effects are disabled", 403);
      if (activeCustomAudioJobs >= 2) fail("Custom audio processor is busy", 429);
      const accepted = store.data.lineTakes[req.params.lineId];
      const retake = store.data.activeRetakes[req.params.lineId];
      if (accepted?.status === "accepted" && (!req.customRetakeId || retake?.id !== req.customRetakeId || retake.playerId !== req.viewer.playerId)) fail("Start a replacement retake first", 409);
      if (req.customRetakeId && (retake?.id !== req.customRetakeId || retake.playerId !== req.viewer.playerId || retake.matchId !== req.customMatchId)) fail("Retake changed", 409);
      req.customLineVersion = store.data.lineVersions[req.params.lineId] ?? 0;
      uploadCustom(req, res, next);
    } catch (error) { next(error); }
  }, async (req, res) => {
    let outputPath;
    try {
      if (!req.file) fail("Multipart field take is required");
      const graph = parseCustomAudioArgs(req.body?.args);
      const mime = req.file.recordingMime;
      await signature(req.file.path, mime);
      store.requireMatch(req.customMatchId);
      const line = store.requireOwner(req.viewer.playerId, req.params.lineId);
      if ((store.data.lineVersions[req.params.lineId] ?? 0) !== req.customLineVersion) fail("Line changed", 409);
      if (activeCustomAudioJobs >= 2) fail("Custom audio processor is busy", 429);
      activeCustomAudioJobs++;
      try {
        outputPath = path.join(dataDir, "tmp", `custom-${randomId(24)}.webm`);
        await runCustomAudio(ffmpegPath, req.file.path, outputPath, graph, Math.min(118, line.duration));
        const stats = await fs.stat(outputPath);
        if (!stats.size || stats.size > maxUploadBytes) fail("Custom audio output exceeded size limit", 413);
      } finally { activeCustomAudioJobs--; }
      // State can change while FFmpeg is working; never return a stale result.
      store.requireMatch(req.customMatchId);
      store.requireOwner(req.viewer.playerId, req.params.lineId);
      if ((store.data.lineVersions[req.params.lineId] ?? 0) !== req.customLineVersion) fail("Line changed", 409);
      const retake = store.data.activeRetakes[req.params.lineId];
      if (req.customRetakeId && (retake?.id !== req.customRetakeId || retake.playerId !== req.viewer.playerId)) fail("Retake changed", 409);
      if (!req.customRetakeId && store.data.lineTakes[req.params.lineId]?.status === "accepted") fail("Take was accepted while processing", 409);
      const bytes = await fs.readFile(outputPath);
      res.type("audio/webm").send(bytes);
    } finally {
      if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
      if (outputPath) await fs.rm(outputPath, { force: true }).catch(() => {});
    }
  });
  app.post("/api/takes/:lineId", authenticated("player"), (req, res, next) => {
    try {
      req.uploadMatchId = req.get("x-match-id");
      req.uploadRetakeId = req.get("x-retake-id") || "";
      store.requireMatch(req.uploadMatchId);
      store.requireOwner(req.viewer.playerId, req.params.lineId);
      const existing = store.data.lineTakes[req.params.lineId];
      req.uploadLineVersion = store.data.lineVersions[req.params.lineId] ?? 0;
      const active = req.uploadRetakeId ? store.data.activeRetakes[req.params.lineId] : null;
      if (req.uploadRetakeId) {
        if (!active || active.id !== req.uploadRetakeId || active.playerId !== req.viewer.playerId || active.matchId !== req.uploadMatchId || active.lineVersion !== req.uploadLineVersion) fail("Retake changed before upload", 409);
        if (existing?.status !== "accepted" || existing.id !== active.acceptedTakeId) fail("Accepted take changed before upload", 409);
        req.previousTakeId = store.data.replacementTakes[req.params.lineId]?.id ?? null;
      } else {
        if (existing?.status === "accepted") fail("Start a replacement retake before recording this accepted line", 409);
        req.previousTakeId = existing?.id ?? null;
      }
      upload(req, res, next);
    } catch (error) { next(error); }
  }, async (req, res) => {
    let destination;
    let successful = false;
    try {
      if (!req.file) fail("Multipart field take is required");
      const mime = req.file.recordingMime ?? req.file.mimetype.toLowerCase().split(";")[0].trim();
      await signature(req.file.path, mime);
      const id = randomId(24);
      destination = store.takePath({ id });
      await store.mutate(async () => {
        // Ownership/lifecycle checks happen after the whole upload, too.
        const parseTiming = (key, maximum) => {
          const text = req.get(key);
          if (text == null) return 0; // Legacy clients record exactly on the cue.
          if (!/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(text)) fail('Invalid take timing', 400);
          const value = Number(text);
          if (!Number.isFinite(value) || value > maximum) fail('Invalid take timing', 400);
          return value;
        };
        const leadIn = parseTiming('x-take-lead-in', 1);
        const tail = parseTiming('x-take-tail', 2);
        store.storeTake({ playerId: req.viewer.playerId, lineId: req.params.lineId, id, mime, size: req.file.size, matchId: req.uploadMatchId, previousTakeId: req.previousTakeId, lineVersion: req.uploadLineVersion, retakeId: req.uploadRetakeId, leadIn, tail });
        await fs.rename(req.file.path, destination);
        await fs.chmod(destination, 0o600);
      });
      successful = true;
      snapshot(req, res);
    } finally {
      if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
      if (!successful && destination) await fs.rm(destination, { force: true }).catch(() => {});
    }
  });
  app.post("/api/takes/:lineId/accept", authenticated("player"), async (req, res) => {
    const { takeId, matchId, retakeId = "" } = validateBody(req, { takeId: "string", matchId: "string", retakeId: "string?" });
    await store.mutate(() => {
      store.requireMatch(matchId);
      return store.accept(req.params.lineId, { playerId: req.viewer.playerId, takeId, retakeId });
    });
    snapshot(req, res);
  });
  app.get("/media/:packId/:assetId", authenticated(), async (req, res) => {
    if (store.pack?.id !== req.params.packId) fail("Only the selected pack may be served", 404);
    const asset = store.pack.assets[req.params.assetId];
    if (!asset) fail("Unknown pack asset", 404);
    // Reference audio of blind lines stays secret from players until the reveal. Hiding the URL
    // is not enough: asset ids are stable, so the route enforces it too.
    if (req.viewer.kind === "player" && store.hiddenAssetIds().has(req.params.assetId)) fail("This audio is hidden until the reveal", 403);
    const real = await fs.realpath(asset.path);
    const permittedRoot = asset.cached ? path.join(dataDir, "video-cache") : store.pack.directory;
    const relative = path.relative(permittedRoot, real);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("Asset is outside selected pack", 403);
    res.type(asset.type);
    res.sendFile(real, { dotfiles: "allow" });
  });
  app.get("/takes/:takeId", authenticated(), (req, res) => {
    const acceptedTake = Object.values(store.data.lineTakes).find(take => take.id === req.params.takeId);
    const replacementTake = Object.values(store.data.replacementTakes).find(take => take.id === req.params.takeId);
    const take = acceptedTake || replacementTake;
    if (!take) fail("Unknown take", 404);
    if (replacementTake && (req.viewer.kind !== "player" || replacementTake.playerId !== req.viewer.playerId)) fail("Replacement take belongs to another player", 403);
    res.type(take.mime);
    res.sendFile(store.takePath(take));
  });
  // ------------------------------------------------------------ library
  // Admin always; players only when the host turned on libraryVisibleToPlayers.
  const libraryViewer = (req, res, next) => {
    if (!library.enabled) return next(Object.assign(new Error("The library is turned off"), { status: 404 }));
    if (req.viewer.kind !== "admin" && !store.data.options.libraryVisibleToPlayers) return next(Object.assign(new Error("The library is not shared with players"), { status: 403 }));
    next();
  };
  // Players must not read the live match's own entry (full captions) before the reveal.
  const hiddenFromPlayers = id => store.secretsActive() && id === library.byMatch.get(store.data.matchId);
  const entryId = req => {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(req.params.id) || !library.has(req.params.id)) fail("Unknown library entry", 404);
    if (req.viewer.kind !== "admin" && hiddenFromPlayers(req.params.id)) fail("This dub is hidden until the reveal", 403);
    return req.params.id;
  };
  // The pack must still be installed and identical for a replay.
  async function replayInfo(manifest) {
    const pack = store.packs.get(manifest.pack.id);
    if (!pack) return { replayable: false, reason: "Pack missing: install it again to replay this dub" };
    if (await packFingerprint(pack) !== manifest.pack.fingerprint) return { replayable: false, reason: "The installed pack differs from the one used for this dub" };
    return { replayable: true };
  }
  app.get("/api/library", authenticated(), libraryViewer, (req, res) => {
    const entries = library.list().filter(entry => req.viewer.kind === "admin" || (!entry.damaged && !hiddenFromPlayers(entry.id)));
    res.json({ enabled: true, entries });
  });
  app.get("/api/library/:id", authenticated(), libraryViewer, async (req, res) => {
    const manifest = library.get(entryId(req));
    if (!manifest) fail("This library entry is damaged", 409);
    const base = "/library-media/" + manifest.id + "/";
    const lines = manifest.lines.map(line => ({ ...line, take: line.take ? { ...line.take, url: base + line.take.file } : null }));
    const files = await Promise.all(["export.mp4", "export.m4a"].map(async file => [file, !!(await library.resolveFile(manifest.id, file))]));
    res.json({ ...manifest, lines, thumbUrl: manifest.hasThumb ? base + "thumb.jpg" : null, exports: Object.fromEntries(files), replay: { ...(await replayInfo(manifest)), videoUrl: base + "video", backingTrackUrl: base + "backing" } });
  });
  app.patch("/api/library/:id", authenticated("admin"), libraryViewer, async (req, res) => {
    const body = validateBody(req, { title: "string?", starred: "boolean?" });
    const manifest = await library.patch(entryId(req), body);
    if (!manifest) fail("This library entry is damaged", 409);
    res.json(library.summary(manifest.id, library.entries.get(manifest.id)));
  });
  app.delete("/api/library/:id", authenticated("admin"), libraryViewer, async (req, res) => {
    await library.remove(entryId(req));
    res.json({ ok: true });
  });
  app.post("/api/library/:id/export", authenticated("admin"), libraryViewer, async (req, res) => {
    const { format } = validateBody(req, { format: "string" });
    if (!Object.hasOwn(EXPORT_FORMATS, format)) fail("Unknown export format");
    const manifest = library.get(entryId(req));
    if (!manifest) fail("This library entry is damaged", 409);
    const file = "export." + EXPORT_FORMATS[format].extension;
    // A render made from the same takes is reused: the library drops it when takes change.
    if (await library.resolveFile(manifest.id, file)) return res.json({ ready: true, url: "/library-media/" + manifest.id + "/" + file });
    const info = await replayInfo(manifest);
    if (!info.replayable) fail(info.reason, 409);
    const job = exportManager.enqueue({ format, source: { kind: "library", entryId: manifest.id }, signature: `lib:${manifest.id}:${format}:${manifest.updatedAt}`, requesterId: null });
    res.json({ ready: false, jobId: job.id });
  });
  app.get("/library-media/:id/:file", authenticated(), libraryViewer, async (req, res) => {
    const manifest = library.get(entryId(req));
    if (!manifest) fail("Unknown library file", 404);
    if (req.params.file === "takes.zip") {
      const players = new Map(manifest.players.map(player => [player.id, player]));
      const lines = await Promise.all(manifest.lines.map(async line => ({ line, take: line.take ? { ...line.take, path: (await library.resolveFile(manifest.id, line.take.file))?.path } : null })));
      return streamZip(res, "open-dub-takes.zip", zipEntries({ title: manifest.title, lines: lines.map(entry => ({ line: entry.line, take: entry.take?.path ? entry.take : null })), players }));
    }
    if (req.params.file === "video" || req.params.file === "backing") {
      // Pack media is served from the installed pack only while it still matches this entry.
      const info = await replayInfo(manifest);
      if (!info.replayable) fail(info.reason, 409);
      const pack = store.packs.get(manifest.pack.id);
      const asset = req.params.file === "video" ? pack.assets[pack.videoUrl.split("/").pop()] : pack.assets[pack.backingTrackUrl.split("/").pop()];
      if (!asset) fail("Unknown library file", 404);
      res.type(asset.type);
      return res.sendFile(await fs.realpath(asset.path), { dotfiles: "allow" });
    }
    const file = await library.resolveFile(manifest.id, req.params.file);
    if (!file) fail("Unknown library file", 404);
    res.type(file.type);
    res.sendFile(file.path); // Range requests are handled by sendFile.
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "Unknown API route" }));
  app.use((req, res, next) => {
    let requested;
    try { requested = path.posix.normalize(decodeURIComponent(req.path)); } catch { return res.status(400).send("Invalid request path."); }
    // The login form is public, but all host APIs require a token or trusted WireGuard source.
    next();
  });
  app.get(["/admin", "/admin/"], (req, res) => res.sendFile(path.join(webDir, "admin.html")));
  app.get(["/", "/join/:roomId", "/join/:roomId/"], (req, res) => res.sendFile(path.join(webDir, "index.html")));
  app.use(express.static(webDir, { dotfiles: "deny", index: false, fallthrough: true }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status ?? 500;
    if (error instanceof multer.MulterError) status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    if (error.type === "entity.parse.failed") status = 400;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? "Runtime could not complete the request" : error.message, ...(status === 409 && error.suggestion ? { suggestion: error.suggestion } : {}) });
  });
  const tlsCert = options.tlsCert ?? process.env.TLS_CERT;
  const tlsKey = options.tlsKey ?? process.env.TLS_KEY;
  if (!!tlsCert !== !!tlsKey) throw new Error("Provide both TLS_CERT and TLS_KEY");
  const server = tlsCert ? https.createServer({ cert: await fs.readFile(tlsCert), key: await fs.readFile(tlsKey) }, app) : http.createServer(app);
  server.requestTimeout = 120000;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (new URL(req.url, "http://runtime.local").pathname !== "/ws") fail("Unknown WebSocket route", 404);
      checkOrigin(req, trustedProxy);
      const viewer = auth(req);
      websocket.handleUpgrade(req, socket, head, ws => websocket.emit("connection", ws, req, viewer));
    } catch (error) { socket.write("HTTP/1.1 " + (error.status ?? 400) + " Rejected\r\nConnection: close\r\n\r\n"); socket.destroy(); }
  });
  websocket.on("connection", (ws, req, viewer) => {
    ws.viewer = viewer;
    ws.wgAdmin = viewer.kind === 'admin' && wireGuardAdmin(req);
    ws.adminCredential = viewer.kind === 'admin' ? (/^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1] ?? cookies(req).dub_admin) : null;
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; });
    ws.roomId = store.data.id;
    if (viewer.kind === "player") store.presence(viewer.playerId, 1);
    ws.send(JSON.stringify(store.snapshot(viewer)));
    ws.on("message", (message, binary) => {
      let payload;
      try { payload = JSON.parse(message.toString()); } catch { ws.close(1008, "Invalid JSON"); return; }
      if (binary || !payload || typeof payload !== "object" || Array.isArray(payload) || payload.type !== "ping" || Object.keys(payload).length !== 1) { ws.close(1008, "Invalid message"); return; }
      ws.send(JSON.stringify({ type: "pong", serverTime: Date.now() }));
    });
    ws.on("error", () => {});
    ws.on("close", () => { if (viewer.kind === "player" && ws.roomId === store.data.id) store.presence(viewer.playerId, -1).catch(() => {}); });
  });
  const adminSocketAuthorized = ws => ws.viewer.kind !== 'admin' || ws.wgAdmin || secureEquals(ws.adminCredential, currentAdminToken());
  const broadcast = () => {
    for (const ws of websocket.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!adminSocketAuthorized(ws)) { ws.close(1008, "Admin token revoked"); continue; }
      if (ws.viewer.kind === "player" && (ws.roomId !== store.data.id || !store.findPlayer(ws.viewer.playerId))) { ws.close(1008, "Room changed"); continue; }
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1008, "Client is too slow"); continue; }
      ws.send(JSON.stringify(store.snapshot(ws.viewer)));
    }
  };
  store.on("change", broadcast);
  const heartbeat = setInterval(() => {
    for (const ws of websocket.clients) {
      if (!adminSocketAuthorized(ws)) { ws.close(1008, "Admin token revoked"); continue; }
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  let closing = false;
  return {
    app, server, adminToken, sessionStore: store,
    async start() {
      if (server.listening) return server.address();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.removeListener("error", reject); resolve(); }); });
      return server.address();
    },
    async close() {
      if (closing) return;
      closing = true;
      clearInterval(heartbeat);
      store.removeListener("change", broadcast);
      for (const ws of websocket.clients) ws.terminate();
      await new Promise(resolve => websocket.close(() => resolve()));
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      await store.pending;
      await library.flush();
    },
  };
}

async function main() {
  const options = {};
  const flags = { "--workshop-dir": "workshopDir", "--data-dir": "dataDir", "--port": "port", "--host": "host" };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--transcode-video") options.transcodeVideo = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Open Dub Runtime\nnode server/index.js [--workshop-dir PATH] [--data-dir PATH] [--port 7373] [--host 0.0.0.0] [--transcode-video]\nSee README.md for HTTPS and other environment settings.");
      return;
    } else if (flags[arg] && args[index + 1]) options[flags[arg]] = args[++index];
    else throw new Error("Unknown or incomplete option: " + arg);
  }
  const runtime = await createRuntime(options);
  const address = await runtime.start();
  const protocol = process.env.TLS_CERT ? "https" : "http";
  console.log("Open Dub Runtime listening on " + protocol + "://0.0.0.0:" + address.port);
  console.log("Local admin: " + protocol + "://localhost:" + address.port + "/admin");
  console.log("Admin token: run opendub-auth --data-dir " + (options.dataDir ?? process.env.DATA_DIR ?? "./data") + " (never logged)");
  console.log("LAN microphones need trusted HTTPS. See README.md.");
  if (!runtime.sessionStore.packs.size) console.log("No packs found. Configure WORKSHOP_DIR or use Workshop downloader.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await runtime.close(); process.exit(0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
