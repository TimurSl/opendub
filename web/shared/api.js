export class RuntimeClient extends EventTarget {
  constructor(viewer) {
    super(); this.viewer = viewer; this.state = null; this.socket = null; this.clockOffset = 0;
    this.bestRtt = Infinity; this.reconnectTimer = null; this.pingSent = 0;
    this.active = false; this.refreshInFlight = null;
  }
  async request(path, body, { multipart = false, method, retakeId, takeTiming } = {}) {
    const matchId = this.state?.session?.matchId;
    // Card decks belong to the host, not to a match. Only dealing, re-dealing, vetoing and turning the cards face up are match-scoped.
    const deckRoute = (path.startsWith('/api/admin/cards') || path.startsWith('/api/admin/decks')) && !['/api/admin/cards/deal', '/api/admin/cards/redeal', '/api/admin/cards/veto', '/api/admin/cards/open'].includes(path);
    const partyOnly = deckRoute || ['/api/admin/packs', '/api/admin/login', '/api/admin/create-party', '/api/admin/next-match', '/api/admin/select', '/api/admin/settings'].includes(path);
    const matchScoped = (path.startsWith('/api/player/') && path !== '/api/player/profile') || /^\/api\/takes\/[^/]+(?:\/accept|\/retake(?:\/cancel)?|\/discard)?$/.test(path) || (path.startsWith('/api/admin/') && !partyOnly);
    if (body !== undefined && !multipart && matchId && matchScoped) {
      body = { ...body, matchId };
    }
    const headers = body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {};
    if (path === '/api/admin/select' && this.state?.session?.partyCreated) body = { ...body, partyId: this.state.session.id };
    if (multipart && path.startsWith('/api/takes/') && matchId) headers['X-Match-ID'] = matchId;
    if (multipart && retakeId) headers['X-Retake-ID'] = retakeId;
    if (multipart && takeTiming) {
      headers['X-Take-Lead-In'] = String(takeTiming.leadIn);
      headers['X-Take-Tail'] = String(takeTiming.tail);
    }
    const response = await fetch(path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin', cache: 'no-store',
      headers,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error(`Server returned ${response.status}.`); }
    if (!response.ok) { const error = new Error(result.error || `Request failed (${response.status}).`); error.status = response.status; if (result.suggestion) error.suggestion = result.suggestion; throw error; }
    if (result.type === 'state') this.receive(result);
    return result;
  }
  async processCustomAudio(lineId, blob, args, retakeId = '') {
    const form = new FormData();
    form.append('args', args);
    form.append('take', blob, 'voice.' + (blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'));
    const response = await fetch('/api/takes/' + encodeURIComponent(lineId) + '/custom', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        'X-Match-ID': this.state?.session?.matchId || '',
        ...(retakeId ? { 'X-Retake-ID': retakeId } : {}),
      },
      body: form,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Custom effect failed (${response.status})`);
    }
    if (!response.headers.get('content-type')?.startsWith('audio/webm')) throw new Error('Unexpected Custom effect response');
    return response.blob();
  }
  async processSoundpadAudio(lineId, file, retakeId = '') {
    const form = new FormData();
    form.append('take', file, file.name || 'sound.mp3');
    const response = await fetch('/api/takes/' + encodeURIComponent(lineId) + '/soundpad', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: {
        'X-Match-ID': this.state?.session?.matchId || '',
        ...(retakeId ? { 'X-Retake-ID': retakeId } : {}),
      }, body: form,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Sound import failed (${response.status})`);
    }
    if (!response.headers.get('content-type')?.startsWith('audio/webm')) throw new Error('Unexpected sound conversion response');
    return response.blob();
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
  refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refreshing = this.request(`/api/state?viewer=${this.viewer}`);
    this.refreshInFlight = refreshing;
    // Never hold a failed or completed refresh as the next request's result.
    void refreshing.finally(() => { if (this.refreshInFlight === refreshing) this.refreshInFlight = null; }).catch(() => {});
    return refreshing;
  }
  async start() {
    await this.refresh();
    if (this.active) return;
    this.active = true; this.connect();
    this.pollTimer = setInterval(() => {
      // Reconcile even on an OPEN socket: a broken proxy can lose WS updates
      // without immediately closing the connection.
      this.refresh().catch(() => {});
    }, 8000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.refresh().catch(() => {});
    });
    if (typeof window !== 'undefined') window.addEventListener('focus', () => this.refresh().catch(() => {}));
  }
  connect() {
    if (!this.active) return;
    clearTimeout(this.reconnectTimer);
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?viewer=${this.viewer}`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return;
      this.dispatchEvent(new CustomEvent('connection', { detail: true })); this.ping();
      this.pingTimer = setInterval(() => this.ping(), 10000);
      this.refresh().catch(() => {});
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
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
      if (this.socket !== socket) return;
      this.socket = null;
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
