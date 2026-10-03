import express from "express";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import https from "node:https";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { timingSafeEqual, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isIP } from "node:net";
import { discoverPacks, parseIni, parseWorkshopIni, parseWorkshopPack } from "./workshop/parser.js";
import { SessionStore, fail, randomId } from "./session/store.js";
export { discoverPacks, parseIni, parseWorkshopIni, parseWorkshopPack, SessionStore };

const webDir = fileURLToPath(new URL("../web", import.meta.url));
function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
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
    if (typeof body[key] !== type) fail("Invalid " + key);
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
async function exportDub(pack, dataDir, ffmpegPath, acceptedTakes) {
  const directory = path.join(dataDir, "exports");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomId(18);
  const output = path.join(directory, id + ".mp4");
  const work = path.join(directory, id + ".work");
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const args = ["-hide_banner", "-loglevel", "error", "-i", pack.video, "-i", pack.backingTrack];
  const voiceInputs = [];
  try {
    for (const [index, { take, line }] of acceptedTakes.entries()) {
      const copy = path.join(work, index + ".audio");
      await fs.copyFile(take.path, copy);
      args.push("-i", copy);
      voiceInputs.push({ input: index + 2, delay: Math.max(0, Math.round(line.startTime * 1000)), duration: line.duration, key: `voice${index}` });
    }
    const filters = ["[1:a]asetpts=PTS-STARTPTS[base]"];
    for (const voice of voiceInputs) filters.push(`[${voice.input}:a]atrim=duration=${voice.duration.toFixed(6)},asetpts=PTS-STARTPTS,adelay=${voice.delay}:all=1[${voice.key}]`);
    const sources = ["[base]", ...voiceInputs.map(voice => `[${voice.key}]`)].join("");
    filters.push(`${sources}amix=inputs=${voiceInputs.length + 1}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
    args.push(
      "-filter_complex", filters.join(";"), "-map", "0:v:0", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "-y", output,
    );
    await new Promise((resolve, reject) => {
      const process = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      process.stderr.on("data", chunk => { if (stderr.length < 4000) stderr += chunk; });
      process.on("error", () => { const error = new Error("ffmpeg is unavailable; install it or set FFMPEG_PATH"); error.status = 503; reject(error); });
      process.on("exit", code => {
        if (code === 0) resolve();
        else { const error = new Error("Video export failed: " + stderr.trim().slice(-1800)); error.status = 422; reject(error); }
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

export async function createRuntime(options = {}) {
  const workshopDir = path.resolve(options.workshopDir ?? process.env.WORKSHOP_DIR ?? process.cwd());
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? "./data");
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const port = Number(options.port ?? process.env.PORT ?? 7373);
  const publicLink = publicOrigin(options.publicLink ?? process.env.PUBLIC_LINK);
  const trustedProxy = trustedProxyAddresses(options.trustedProxy ?? process.env.TRUSTED_PROXY);
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? randomId(32);
  const maxUploadBytes = Number(options.maxUploadBytes ?? Number(process.env.MAX_UPLOAD_MB ?? 25) * 1024 * 1024);
  const previewBefore = Number(options.previewBefore ?? process.env.PREVIEW_BEFORE ?? 1.5);
  const previewAfter = Number(options.previewAfter ?? process.env.PREVIEW_AFTER ?? 0.5);
  if (typeof adminToken !== "string" || !adminToken.trim()) throw new Error("ADMIN_TOKEN cannot be empty");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be 0–65535");
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 16 || maxUploadBytes > 1024 * 1024 * 1024) throw new Error("Invalid upload byte limit");
  if (![previewBefore, previewAfter].every(value => Number.isFinite(value) && value >= 0 && value <= 30)) throw new Error("Preview padding must be 0–30 seconds");
  const discovered = await discoverPacks(workshopDir);
  const store = await new SessionStore({ packs: discovered.packs, dataDir, previewBefore, previewAfter }).init();
  const exportDirectory = path.join(dataDir, "exports");
  await fs.mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  for (const filename of await fs.readdir(exportDirectory)) await fs.rm(path.join(exportDirectory, filename), { recursive: true, force: true });
  const exports = new Map();
  const transcodeVideo = options.transcodeVideo ?? process.env.TRANSCODE_VIDEO === "1";
  const ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
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
    const adminMatches = equalToken(bearer ?? cookie.dub_admin, adminToken);
    const player = store.findToken(bearer ?? cookie.dub_player);
    const kind = requireKind ?? viewerPreference;
    if (kind === "player") {
      if (player) return { kind: "player", playerId: player.id };
      if (adminMatches) fail("Player authorization required", 403);
      fail("Join the room first", 401);
    }
    if (kind === "admin") {
      if (!adminMatches) fail("Admin authorization required", player ? 403 : 401);
      if (!local(req)) fail("Admin interface is available only on the host PC", 403);
      return { kind: "admin" };
    }
    if (adminMatches) {
      if (!local(req)) fail("Admin interface is available only on the host PC", 403);
      return { kind: "admin" };
    }
    if (player) return { kind: "player", playerId: player.id };
    fail("Join the room first", 401);
  }
  const authenticated = kind => (req, res, next) => { try { req.viewer = auth(req, kind); next(); } catch (error) { next(error); } };
  const snapshot = (req, res) => res.json(store.snapshot(req.viewer));
  const setCookie = (req, res, name, token) => res.cookie(name, token, { httpOnly: true, sameSite: "strict", secure: requestProtocol(req, trustedProxy) === "https:", path: "/", maxAge: 30 * 24 * 60 * 60 * 1000 });
  app.post("/api/admin/login", async (req, res) => {
    if (!local(req)) fail("Admin login is available only on the host PC", 403);
    const { token } = validateBody(req, { token: "string" });
    if (!equalToken(token, adminToken)) fail("Invalid admin token", 401);
    setCookie(req, res, "dub_admin", adminToken);
    res.json(store.snapshot({ kind: "admin" }));
  });
  app.get("/api/admin/packs", authenticated("admin"), async (req, res) => {
    const refreshed = await discoverPacks(workshopDir);
    discovered.packs = refreshed.packs;
    discovered.errors = refreshed.errors;
    store.packs = new Map(refreshed.packs.map(pack => [pack.id, pack]));
    res.json({ packs: discovered.packs.map(pack => ({ id: pack.id, metadata: pack.metadata, characters: pack.characters, lineCount: pack.lines.length, characterCount: pack.characters.length, iconUrl: pack.icon ? `/api/admin/packs/${encodeURIComponent(pack.id)}/icon` : null })), errors: discovered.errors });
  });
  app.get("/api/admin/packs/:packId/icon", authenticated("admin"), async (req, res) => {
    const pack = store.packs.get(req.params.packId);
    if (!pack?.icon) fail("Pack icon not found", 404);
    const asset = Object.values(pack.assets).find(item => item.path === pack.icon);
    if (!asset) fail("Pack icon not found", 404);
    const real = await fs.realpath(asset.path);
    const relative = path.relative(pack.directory, real);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("Pack icon is outside its directory", 403);
    res.type(asset.type); res.sendFile(real);
  });
  const adminAction = (route, shape, operation) => app.post("/api/admin/" + route, authenticated("admin"), async (req, res) => {
    const body = validateBody(req, shape);
    await store.mutate(() => operation(body));
    snapshot(req, res);
  });
  adminAction("select", { packId: "string" }, async ({ packId }) => {
    const pack = store.packs.get(packId);
    if (!pack) fail("Unknown pack", 404);
    if (transcodeVideo) await transcode(pack, dataDir, ffmpegPath);
    store.select(packId);
  });
  adminAction("settings", {
    freeRolePicking: "boolean", allowMultipleRoles: "boolean", maxRolesPerPlayer: "number",
    autoBalanceSuggestions: "boolean", lockRolesWhenReady: "boolean",
    referencePlaybackEnabled: "boolean", voiceEffectsEnabled: "boolean", compactMobilePreferred: "boolean",
  }, options => store.configure(options));
  adminAction("open-lobby", {}, () => store.openLobby());
  adminAction("lock-roles", {}, () => store.lockRoles());
  adminAction("reopen-roles", {}, () => store.reopenRoles());
  adminAction("assign", { character: "string", playerId: "string" }, ({ character, playerId }) => store.assign(character, playerId));
  adminAction("unassign", { character: "string" }, ({ character }) => store.unassignRole(character));
  adminAction("distribute", {}, () => store.distribute());
  adminAction("fill-unassigned", {}, () => store.fillUnassigned());
  adminAction("start", {}, () => store.startRecording());
  adminAction("pause", {}, () => store.pause());
  adminAction("resume", {}, () => store.resume());
  adminAction("review", {}, () => store.openReview());
  adminAction("accept-all", {}, () => store.acceptAll());
  adminAction("restart-playback", {}, () => {
    if (store.data.state !== "playback") fail("Playback is not active", 409);
    store.data.playback = { id: randomId(), startsAt: Date.now() + 5000 };
  });
  app.post("/api/admin/export", authenticated("admin"), async (req, res) => {
    validateBody(req, {});
    if (!store.pack || !["review", "playback"].includes(store.data.state)) fail("Finish review before exporting the video", 409);
    const acceptedTakes = store.pack.lines.flatMap(line => {
      const take = store.data.lineTakes[line.id];
      return take?.status === "accepted" ? [{ take: { ...take, path: store.takePath(take) }, line }] : [];
    });
    const result = await exportDub(store.pack, dataDir, ffmpegPath, acceptedTakes);
    exports.set(result.id, result.output);
    while (exports.size > 5) {
      const oldest = exports.keys().next().value;
      exports.delete(oldest);
      await fs.rm(path.join(exportDirectory, oldest + ".mp4"), { force: true });
    }
    res.json({ url: "/api/admin/exports/" + result.id, filename: "open-dub-" + result.id + ".mp4" });
  });
  app.get("/api/admin/exports/:id", authenticated("admin"), async (req, res) => {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(req.params.id)) fail("Unknown export", 404);
    const filename = exports.get(req.params.id);
    if (!filename) fail("Unknown export", 404);
    res.type("video/mp4");
    res.sendFile(filename);
  });
  app.post("/api/admin/retake", authenticated("admin"), async (req, res) => {
    const { lineId } = validateBody(req, { lineId: "string" });
    const previous = await store.mutate(() => store.retake(lineId));
    if (previous) await fs.rm(store.takePath(previous), { force: true });
    snapshot(req, res);
  });
  adminAction("accept", { lineId: "string" }, ({ lineId }) => store.accept(lineId));
  adminAction("playback", { allowMissing: "boolean" }, ({ allowMissing }) => store.startPlayback(allowMissing));
  adminAction("stop-playback", {}, () => store.stopPlayback());
  app.post("/api/join", async (req, res) => {
    const body = validateBody(req, { roomId: "string", joinToken: "string", nickname: "string" });
    const player = await store.mutate(() => store.join(body));
    setCookie(req, res, "dub_player", player.token);
    res.json({ ...store.snapshot({ kind: "player", playerId: player.id }), token: player.token });
  });
  const playerAction = (route, shape, operation) => app.post("/api/player/" + route, authenticated("player"), async (req, res) => {
    const body = validateBody(req, shape);
    await store.mutate(() => operation(body, req.viewer.playerId));
    snapshot(req, res);
  });
  playerAction("claim", { character: "string" }, ({ character }, playerId) => store.claimRole(character, playerId));
  playerAction("release", { character: "string" }, ({ character }, playerId) => store.releaseRole(character, playerId));
  playerAction("ready", { ready: "boolean" }, ({ ready }, playerId) => store.setPlayerReady(playerId, ready));
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
  app.post("/api/takes/:lineId", authenticated("player"), (req, res, next) => {
    try {
      store.requireOwner(req.viewer.playerId, req.params.lineId);
      const existing = store.data.lineTakes[req.params.lineId];
      if (existing?.status === "accepted") fail("Accepted take requires a host retake request", 409);
      req.uploadSessionId = store.data.id;
      req.previousTakeId = existing?.id ?? null;
      req.uploadLineVersion = store.data.lineVersions[req.params.lineId] ?? 0;
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
        store.storeTake({ playerId: req.viewer.playerId, lineId: req.params.lineId, id, mime, size: req.file.size, sessionId: req.uploadSessionId, previousTakeId: req.previousTakeId, lineVersion: req.uploadLineVersion });
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
    const { takeId } = validateBody(req, { takeId: "string" });
    await store.mutate(() => store.accept(req.params.lineId, { playerId: req.viewer.playerId, takeId }));
    snapshot(req, res);
  });
  app.get("/media/:packId/:assetId", authenticated(), async (req, res) => {
    if (store.pack?.id !== req.params.packId) fail("Only the selected pack may be served", 404);
    const asset = store.pack.assets[req.params.assetId];
    if (!asset) fail("Unknown pack asset", 404);
    const real = await fs.realpath(asset.path);
    const permittedRoot = asset.cached ? path.join(dataDir, "video-cache") : store.pack.directory;
    const relative = path.relative(permittedRoot, real);
    if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) fail("Asset is outside selected pack", 403);
    res.type(asset.type);
    res.sendFile(real);
  });
  app.get("/takes/:takeId", authenticated(), (req, res) => {
    const take = Object.values(store.data.lineTakes).find(take => take.id === req.params.takeId);
    if (!take) fail("Unknown take", 404);
    res.type(take.mime);
    res.sendFile(store.takePath(take));
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "Unknown API route" }));
  app.use((req, res, next) => {
    let requested;
    try { requested = path.posix.normalize(decodeURIComponent(req.path)); } catch { return res.status(400).send("Invalid request path."); }
    if ((requested === "/admin" || requested === "/admin.html" || requested.startsWith("/admin/")) && !local(req)) return res.status(403).send("Admin interface is available only on the host PC.");
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
    res.status(status).json({ error: status >= 500 ? "Runtime could not complete the request" : error.message });
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
    ws.on("close", () => { if (viewer.kind === "player" && ws.roomId === store.data.id) store.presence(viewer.playerId, -1); });
  });
  const broadcast = () => {
    for (const ws of websocket.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.viewer.kind === "player" && (ws.roomId !== store.data.id || !store.findPlayer(ws.viewer.playerId))) { ws.close(1008, "Room changed"); continue; }
      if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1008, "Client is too slow"); continue; }
      ws.send(JSON.stringify(store.snapshot(ws.viewer)));
    }
  };
  store.on("change", broadcast);
  const heartbeat = setInterval(() => {
    for (const ws of websocket.clients) {
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
  console.log("Admin token: " + runtime.adminToken);
  console.log("LAN microphones need trusted HTTPS. See README.md.");
  if (!runtime.sessionStore.packs.size) console.log("No packs found. Configure WORKSHOP_DIR and restart.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await runtime.close(); process.exit(0); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
