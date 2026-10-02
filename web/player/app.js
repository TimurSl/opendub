import { RuntimeClient, node } from '../shared/api.js';
import { LineRecorder } from '../recorder/recorder.js';
import { DubPlayback } from '../playback/playback.js';

const $ = id => document.getElementById(id);
const client = new RuntimeClient('player');
let noticeKind = ''; let readyFingerprint = null; let rolesFingerprint = null; let readyBusy = false;
let connectionTimer; let visibleMode = null;
function friendlyMessage(problem) {
  const name = problem?.name; const message = String(problem?.message || '');
  if (new Set([
    'Microphone access required', 'Recording failed — try again', 'Save failed — try again',
    'Press PLAY to hear the movie.', 'Press PLAY to hear the movie', 'Playback could not start. Press PLAY to try again.',
    'Playback is unavailable in this browser. Please try another browser.',
    'Video unavailable — ask host',
    'The movie could not load. Press PLAY to try again.',
    'This movie could not play. Please try another browser.'
  ]).has(message)) return message;
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) return 'Allow microphone access, then press READY again.';
  if (name === 'NotFoundError') return 'Connect a microphone, then press READY.';
  if (name === 'NotReadableError') return 'Close any app using your microphone, then press READY.';
  if (/secure|HTTPS|localhost/i.test(message)) return 'Ask the host for a secure invitation so your microphone can work.';
  if (/audio|decode|sound|AudioContext/i.test(message)) return 'Sound could not start. Try again, or ask the host to check the audio.';
  if (/video|scene|seek|timestamp/i.test(message)) return 'The scene could not play. Try again, or ask the host to check the video.';
  if (/upload|network|fetch|save|take changed/i.test(message)) return 'Your take is safe. Try NEXT again when the connection returns.';
  if (/assignment|roles|another player/i.test(message)) return 'Your characters changed. Check them and press READY again.';
  if (/room|join|token|invitation/i.test(message)) return 'This invitation no longer works. Ask the host for a new one.';
  return 'This step was interrupted. Try again, or ask the host for help.';
}
function showNotice(message, kind = 'error') {
  noticeKind = kind; $('notice').textContent = message; $('notice').hidden = false;
}
function clearNotice(kind) {
  if (!kind || noticeKind === kind) { $('notice').hidden = true; $('notice').textContent = ''; noticeKind = ''; }
}
const error = problem => showNotice(friendlyMessage(problem));
const recorder = new LineRecorder(client, error);
const playback = new DubPlayback($('playback-root'), client, error, { player: true });
for (const id of ['original', 'record', 'my-take', 'next']) {
  $(id).addEventListener('click', () => clearNotice('error'), { capture: true });
}
$('playback-root').addEventListener('click', event => {
  if (event.target.closest('button')) clearNotice('error');
}, { capture: true });

let roomId = null; let joinToken = null;
const roomMatch = location.pathname.match(/^\/join\/([^/]+)\/?$/);
try { if (roomMatch) roomId = decodeURIComponent(roomMatch[1]); } catch { /* Invalid invitations use the empty state. */ }
if (roomId) {
  const tokenKey = `open-dub-invitation:${roomId}`;
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fragmentToken) {
    joinToken = fragmentToken;
    try { sessionStorage.setItem(tokenKey, fragmentToken); } catch { /* The current page can still join when storage is disabled. */ }
  } else {
    try { joinToken = sessionStorage.getItem(tokenKey); } catch {}
  }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
const hasInvitation = !!(roomId && joinToken);
$('join-form').hidden = !hasInvitation;
$('join-heading').hidden = !hasInvitation;
$('invitation-missing').hidden = hasInvitation;
if (!hasInvitation) $('pack-title').textContent = 'Join the dub';

$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice(); $('join-button').disabled = true;
  try {
    await client.request('/api/join', { roomId, joinToken, nickname: $('nickname').value.trim() });
    await client.start();
  } catch (problem) { error(problem); }
  finally { $('join-button').disabled = false; }
});
$('ready').addEventListener('click', async () => {
  if (!client.state || readyBusy) return;
  const fingerprint = roleKey(client.state); readyBusy = true; clearNotice(); $('ready').disabled = true;
  // Both permission requests begin in the same user gesture; recording need not wait for audio output.
  const microphone = recorder.enableMicrophone();
  playback.unlock().catch(() => { /* The final PLAY gesture can unlock sound later. */ });
  try {
    await microphone;
    if (client.state && roleKey(client.state) === fingerprint) readyFingerprint = fingerprint;
  } catch (problem) { error(problem); }
  finally { readyBusy = false; $('ready').disabled = false; if (client.state) render(client.state); }
});
client.addEventListener('connection', event => {
  clearTimeout(connectionTimer);
  if (event.detail) clearNotice('connection');
  else connectionTimer = setTimeout(() => showNotice('Connection lost. Your take stays safe here. Keep recording, then try NEXT when the host returns.', 'connection'), 3500);
});
client.addEventListener('state', event => render(event.detail));

function roleKey(snapshot) {
  return JSON.stringify([snapshot.session.id, [...(snapshot.queue?.assignedCharacters || [])].sort()]);
}
function render(snapshot) {
  if (snapshot.viewer.kind !== 'player') return;
  const session = snapshot.session; const pack = session.pack; const queue = snapshot.queue;
  if (roomId && session.id !== roomId) return;
  $('join-panel').hidden = true; $('room-panel').hidden = false;
  $('pack-title').textContent = pack?.metadata.title || 'Your dub';
  const fingerprint = roleKey(snapshot); const characters = queue?.assignedCharacters || [];
  if (rolesFingerprint !== fingerprint) {
    readyFingerprint = null; rolesFingerprint = fingerprint;
    $('assigned-characters').replaceChildren(...characters.map(character => node('li', character)));
  }
  const acknowledged = readyFingerprint === fingerprint;
  const total = queue?.lines.length || 0;
  const lineId = queue?.pendingLines[0]; const line = pack?.lines.find(item => item.id === lineId);
  const recording = session.state === 'recording' && acknowledged && !!line;
  const finalPlayback = session.state === 'playback';
  const showRoles = !finalPlayback && characters.length > 0 && !acknowledged;
  $('role-panel').hidden = !showRoles;
  $('ready').disabled = readyBusy;
  $('recording-panel').hidden = !recording;
  $('playback-panel').hidden = !finalPlayback;
  $('waiting-panel').hidden = showRoles || recording || finalPlayback;
  $('line-number').hidden = !recording;
  recorder.setLine(pack, recording ? line : null, recording, session.settings);
  if (recording) {
    recorder.setCandidate(session.lineTakes[line.id]);
    $('line-number').textContent = `LINE ${queue.lines.indexOf(line.id) + 1} / ${total}`;
    $('line-character').textContent = line.character;
    $('line-caption').textContent = line.caption;
  }
  const done = total > 0 && !line && ['recording', 'review'].includes(session.state);
  $('waiting-detail').hidden = !done;
  if (done) {
    $('waiting-title').textContent = 'DONE';
    $('waiting-message').textContent = `You recorded all ${total} lines.`;
    $('waiting-detail').textContent = 'Waiting for everyone else.';
  } else {
    $('waiting-title').textContent = 'Waiting for the host';
    $('waiting-message').textContent = acknowledged ? 'You’re ready. The recording will start soon.' : 'You’ll get your characters soon.';
  }
  playback.setState(snapshot);
  const nextMode = finalPlayback ? 'playback' : showRoles ? 'roles' : recording ? 'recording' : 'waiting';
  const changed = visibleMode !== null && visibleMode !== nextMode; visibleMode = nextMode;
  if (changed) requestAnimationFrame(() => {
    if (visibleMode !== nextMode) return;
    const focus = nextMode === 'roles' ? $('ready') : nextMode === 'recording' ? $('record') : nextMode === 'waiting' ? $('waiting-title') : $('playback-root').querySelector('button');
    if (focus && !focus.disabled) focus.focus({ preventScroll: true });
  });
}

client.start().catch(() => { /* New visitors join with the host invitation. */ });
window.addEventListener('focus', () => { if (client.state) client.request('/api/state?viewer=player').catch(() => {}); });
