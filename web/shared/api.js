export class RuntimeClient extends EventTarget {
  constructor(viewer) {
    super(); this.viewer = viewer; this.state = null; this.socket = null; this.clockOffset = 0;
    this.bestRtt = Infinity; this.reconnectTimer = null; this.pingSent = 0;
    this.active = false;
  }
  async request(path, body, { multipart = false, method, retakeId } = {}) {
    const matchId = this.state?.session?.matchId;
    const partyOnly = ['/api/admin/packs', '/api/admin/login', '/api/admin/create-party', '/api/admin/next-match', '/api/admin/select', '/api/admin/settings'].includes(path);
    const matchScoped = path.startsWith('/api/player/') || /^\/api\/takes\/[^/]+(?:\/accept|\/retake(?:\/cancel)?|\/discard)?$/.test(path) || (path.startsWith('/api/admin/') && !partyOnly);
    if (body !== undefined && !multipart && matchId && matchScoped) {
      body = { ...body, matchId };
    }
    const headers = body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {};
    if (path === '/api/admin/select' && this.state?.session?.partyCreated) body = { ...body, partyId: this.state.session.id };
    if (multipart && path.startsWith('/api/takes/') && matchId) headers['X-Match-ID'] = matchId;
    if (multipart && retakeId) headers['X-Retake-ID'] = retakeId;
    const response = await fetch(path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin', cache: 'no-store',
      headers,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Server returned ${response.status}.`); }
    if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    if (result.type === 'state') this.receive(result);
    return result;
  }
  receive(next) {
    const sameServer = next.serverId && next.serverId === this.state?.serverId;
    const sameParty = next.session?.id === this.state?.session?.id;
    if (this.state && (sameServer || sameParty) && next.revision < this.state.revision) return;
    if (!Number.isFinite(next.serverTime) || !next.session) return;
    if (!Number.isFinite(this.bestRtt)) this.clockOffset = next.serverTime - Date.now();
    this.state = next; this.dispatchEvent(new CustomEvent('state', { detail: next }));
  }
  serverNow() { return Date.now() + this.clockOffset; }
  async start() {
    await this.request(`/api/state?viewer=${this.viewer}`);
    if (this.active) return;
    this.active = true; this.connect();
    this.pollTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) this.request(`/api/state?viewer=${this.viewer}`).catch(() => {});
    }, 10000);
  }
  connect() {
    if (!this.active) return;
    clearTimeout(this.reconnectTimer);
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?viewer=${this.viewer}`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.dispatchEvent(new CustomEvent('connection', { detail: true })); this.ping();
      this.pingTimer = setInterval(() => this.ping(), 10000);
      this.request(`/api/state?viewer=${this.viewer}`).catch(() => {});
    });
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') this.receive(message);
        if (message.type === 'pong' && this.pingSent && Number.isFinite(message.serverTime)) {
          const now = Date.now(); const rtt = now - this.pingSent;
          if (rtt < this.bestRtt) {
            this.bestRtt = rtt; this.clockOffset = message.serverTime - (this.pingSent + now) / 2;
          }
          this.pingSent = 0;
        }
      } catch { /* Ignore malformed transport data; the next snapshot refreshes state. */ }
    });
    socket.addEventListener('error', () => socket.close());
    socket.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      this.dispatchEvent(new CustomEvent('connection', { detail: false }));
      if (this.active) this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
  }
  ping() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.pingSent = Date.now(); this.socket.send(JSON.stringify({ type: 'ping' }));
  }
}

export function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function showError(element, error) {
  element.textContent = error?.message || String(error); element.hidden = false;
}
export function setBusy(button, busy, original) {
  button.disabled = busy; button.textContent = busy ? 'Working…' : original;
}
export function mediaWarning(video, target) {
  const supported = video.canPlayType('video/ogg; codecs="theora, vorbis"');
  target.hidden = !!supported;
  target.textContent = 'This browser may not play Theora video. Ask the host to run with --transcode-video (ffmpeg required), then reload. Audio alone is insufficient for recording this scene.';
}
