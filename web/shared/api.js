export class RuntimeClient extends EventTarget {
  constructor(viewer) {
    super(); this.viewer = viewer; this.state = null; this.socket = null; this.clockOffset = 0;
    this.bestRtt = Infinity; this.reconnectTimer = null; this.pingSent = 0;
    this.active = false;
  }
  async request(path, body, { multipart = false, method } = {}) {
    const response = await fetch(path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin', cache: 'no-store',
      headers: body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {},
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Server returned ${response.status}.`); }
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
    if (result.type === 'state') this.receive(result);
    return result;
  }
  receive(next) {
    if (this.state && next.session?.id === this.state.session?.id && next.revision < this.state.revision) return;
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
