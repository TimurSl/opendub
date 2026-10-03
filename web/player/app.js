import { RuntimeClient, node } from '../shared/api.js';
import { LineRecorder } from '../recorder/recorder.js';
import { DubPlayback } from '../playback/playback.js';

const $ = id => document.getElementById(id);
const client = new RuntimeClient('player');
let noticeKind = ''; let rolesFingerprint = null; let readyBusy = false; let visibleMode = null;
const roleBusy = new Set();
let connectionTimer;

function friendlyMessage(problem) {
  const name = problem?.name; const message = String(problem?.message || '');
  if (new Set([
    'Microphone access required', 'Recording failed — try again', 'Save failed — try again',
    'Press PLAY to hear the movie.', 'Press PLAY to hear the movie', 'Playback could not start. Press PLAY to try again.',
    'Playback is unavailable in this browser. Please try another browser.',
    'Video unavailable — ask host', 'The movie could not load. Press PLAY to try again.',
    'This movie could not play. Please try another browser.'
  ]).has(message)) return message;
  if (/origin|cross-site|proxy protocol/i.test(message)) return 'The host needs to check the proxy connection settings before you can join.';
  if (/already taken/i.test(message)) return 'Someone just picked that character. Choose another one.';
  if (/role limit/i.test(message)) return 'You have reached the role limit for this game.';
  if (/locked/i.test(message)) return 'The host locked role selection. Your choices are saved.';
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) return 'Allow microphone access, then try READY again.';
  if (name === 'NotFoundError') return 'Connect a microphone, then try READY again.';
  if (name === 'NotReadableError') return 'Close any app using your microphone, then try READY again.';
  if (/secure|HTTPS|localhost/i.test(message)) return 'Ask the host for a secure invitation so your microphone can work.';
  if (/audio|decode|sound|AudioContext/i.test(message)) return 'Sound could not start. Try again, or ask the host for help.';
  if (/video|scene|seek|timestamp/i.test(message)) return 'The scene could not play. Try again, or ask the host for help.';
  if (/upload|network|fetch|save|take changed/i.test(message)) return 'Your take is safe. Try NEXT again when the connection returns.';
  if (/assignment|roles|another player/i.test(message)) return 'Your characters changed. Check your roles and get ready again.';
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
for (const id of ['original', 'record', 'my-take', 'next', 'ready']) $(id).addEventListener('click', () => clearNotice('error'), { capture: true });
$('playback-root').addEventListener('click', event => { if (event.target.closest('button')) clearNotice('error'); }, { capture: true });

let roomId = null; let joinToken = null;
const roomMatch = location.pathname.match(/^\/join\/([^/]+)\/?$/);
try { if (roomMatch) roomId = decodeURIComponent(roomMatch[1]); } catch { /* Invalid invitations use the empty state. */ }
if (roomId) {
  const tokenKey = `open-dub-invitation:${roomId}`;
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fragmentToken) {
    joinToken = fragmentToken;
    try { sessionStorage.setItem(tokenKey, fragmentToken); } catch { /* The current page can still join when storage is disabled. */ }
  } else { try { joinToken = sessionStorage.getItem(tokenKey); } catch {} }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
const hasInvitation = !!(roomId && joinToken);
$('join-form').hidden = !hasInvitation; $('join-heading').hidden = !hasInvitation;
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
$('role-options').addEventListener('click', async event => {
  const button = event.target.closest('button[data-character]');
  if (!button || button.disabled) return;
  const character = button.dataset.character; const action = button.dataset.action; const restoreFocus = document.activeElement === button;
  roleBusy.add(character); render(client.state); clearNotice();
  try { await client.request(`/api/player/${action}`, { character }); }
  catch (problem) { error(problem); }
  finally {
    roleBusy.delete(character); if (client.state) render(client.state);
    if (restoreFocus) requestAnimationFrame(() => $('role-options').querySelector(`button[data-character="${CSS.escape(character)}"]`)?.focus({ preventScroll: true }));
  }
});
$('ready').addEventListener('click', async () => {
  const snapshot = client.state; if (!snapshot || readyBusy) return;
  const session = snapshot.session; const player = session.players.find(item => item.id === snapshot.viewer.playerId);
  if (!player || !snapshot.queue?.assignedCharacters.length) return;
  readyBusy = true; $('ready').disabled = true; clearNotice();
  try {
    if (player.ready && !session.rolesLocked) {
      await client.request('/api/player/ready', { ready: false });
    } else {
      await recorder.enableMicrophone();
      playback.unlock().catch(() => {});
      if (!session.rolesLocked && !player.ready) await client.request('/api/player/ready', { ready: true });
      $('ready-note').textContent = 'Microphone ready. You can record when the host starts.';
    }
  } catch (problem) { error(problem); }
  finally { readyBusy = false; if (client.state) render(client.state); }
});
$('effect-row').addEventListener('click', event => {
  const button = event.target.closest('button[data-effect]');
  if (!button || button.disabled) return;
  recorder.setEffect(button.dataset.effect);
  for (const option of $('effect-row').querySelectorAll('button[data-effect]')) {
    const selected = option === button;
    option.classList.toggle('is-selected', selected); option.setAttribute('aria-pressed', String(selected));
  }
});
client.addEventListener('connection', event => {
  clearTimeout(connectionTimer);
  if (event.detail) clearNotice('connection');
  else connectionTimer = setTimeout(() => showNotice('Connection lost. Your take stays safe. Try again when the host is back.', 'connection'), 3500);
});
client.addEventListener('state', event => render(event.detail));

function renderRoleSelection(snapshot) {
  const session = snapshot.session; const pack = session.pack; const characters = pack?.characters || [];
  const assignments = session.roleAssignments || {}; const players = session.players || [];
  const me = players.find(player => player.id === snapshot.viewer.playerId);
  const mine = snapshot.queue?.assignedCharacters || [];
  const settings = session.settings || {}; const locked = !!session.rolesLocked;
  const maxRoles = settings.allowMultipleRoles === false ? 1 : settings.maxRolesPerPlayer || Infinity;
  const limitReached = mine.length >= maxRoles;
  const freeCount = characters.filter(character => !assignments[character]).length;
  $('role-counts').textContent = `${freeCount} free · ${characters.length - freeCount} taken`;
  $('my-roles').textContent = mine.length ? mine.join(' · ') : 'Choose a character to begin';
  $('role-help').textContent = locked ? 'Roles are locked. Your choices are saved.' : settings.freeRolePicking === false ? 'The host is choosing characters. You can look around and mark yourself ready once your role is set.' : settings.allowMultipleRoles === false ? 'Tap one free character to claim it. You can release it before the host locks roles.' : `Tap a free character to claim it. You can choose up to ${Number.isFinite(maxRoles) ? maxRoles : 'any number'}.`;
  const list = $('role-options'); const activeCharacter = document.activeElement?.dataset?.character; const activeAction = document.activeElement?.dataset?.action;
  list.replaceChildren();
  for (const character of characters) {
    const owner = players.find(player => player.id === assignments[character]);
    const isMine = owner?.id === snapshot.viewer.playerId;
    const card = node('article', undefined, `role-tile${isMine ? ' is-mine' : ''}${owner ? ' is-taken' : ' is-free'}`);
    const name = node('strong', character); const taken = node('span', owner ? (isMine ? 'Yours' : `Taken by ${owner.nickname}`) : 'Free', 'role-state');
    const button = node('button', undefined, isMine ? 'release-role' : 'claim-role');
    button.type = 'button'; button.dataset.character = character; button.dataset.action = isMine ? 'release' : 'claim';
    const busy = roleBusy.has(character);
    button.textContent = busy ? '…' : isMine ? '− Release' : owner ? 'Taken' : settings.freeRolePicking === false ? 'Host assigns' : '+ Claim';
    button.disabled = busy || locked || (isMine ? false : !!owner || !settings.freeRolePicking || limitReached);
    button.setAttribute('aria-label', isMine ? `Release ${character}` : owner ? `${character}, taken by ${owner.nickname}` : `Claim ${character}`);
    card.append(name, taken, button); list.append(card);
  }
  if (activeCharacter && activeAction) {
    list.querySelector(`button[data-character="${CSS.escape(activeCharacter)}"]`)?.focus({ preventScroll: true });
  }
  $('ready').disabled = readyBusy || !mine.length || (locked && !!me?.ready);
  $('ready-label').textContent = me?.ready ? (locked ? 'Ready' : 'Not ready') : locked ? 'Check my mic' : 'I’m ready';
  $('ready-note').textContent = me?.ready ? locked ? 'You’re ready. The host will start the game.' : 'You’re marked ready.' : locked ? 'Tap to check microphone access before the first line.' : 'Get your microphone ready, then wait for the host.';
}
function render(snapshot) {
  if (snapshot.viewer.kind !== 'player') return;
  const session = snapshot.session; const pack = session.pack; const queue = snapshot.queue;
  if (roomId && session.id !== roomId) return;
  $('join-panel').hidden = true; $('room-panel').hidden = false;
  $('pack-title').textContent = pack?.metadata.title || 'Your dub';
  const currentRoleKey = JSON.stringify([session.id, [...(queue?.assignedCharacters || [])].sort()]);
  if (rolesFingerprint !== currentRoleKey) { rolesFingerprint = currentRoleKey; $('ready-note').textContent = ''; }
  const roleStage = session.state === 'assignment';
  const finalPlayback = session.state === 'playback';
  const lineId = queue?.pendingLines[0]; const line = pack?.lines.find(item => item.id === lineId);
  const recording = session.state === 'recording' && !!line;
  const pausedLine = session.state === 'paused' && !!line;
  if (pausedLine) recorder.pauseCapture();
  const done = ['recording', 'review', 'paused'].includes(session.state) && !!queue?.lines.length && !line;
  $('role-panel').hidden = !roleStage;
  $('recording-panel').hidden = !recording;
  $('playback-panel').hidden = !finalPlayback;
  $('waiting-panel').hidden = roleStage || recording || finalPlayback;
  $('line-number').hidden = !recording;
  $('effect-row').hidden = !session.settings?.voiceEffectsEnabled;
  $('effect-row').querySelectorAll('button').forEach(button => { button.disabled = !session.settings?.voiceEffectsEnabled || ['recording', 'countdown', 'requesting'].includes(recorder.mode); });
  document.body.classList.toggle('compact-controls', !!session.settings?.compactMobilePreferred && window.matchMedia('(max-width: 700px)').matches);
  recorder.setLine(pack, recording || pausedLine ? line : null, recording || pausedLine, session.settings);
  if (recording) {
    recorder.setCandidate(session.lineTakes[line.id]);
    $('line-number').textContent = `LINE ${queue.lines.indexOf(line.id) + 1} / ${queue.lines.length}`;
    $('line-character').textContent = line.character;
    $('line-caption').textContent = line.caption;
  }
  if (roleStage) renderRoleSelection(snapshot);
  if (session.state === 'lobby') {
    $('waiting-title').textContent = 'You’re in the lobby';
    $('waiting-message').textContent = 'The host is setting up your game. Your characters will show up here.';
    $('waiting-detail').hidden = true;
  } else if (session.state === 'paused') {
    $('waiting-title').textContent = 'Taking a quick pause';
    $('waiting-message').textContent = 'The host will continue the game soon.';
    $('waiting-detail').hidden = true;
  } else if (session.state === 'review') {
    $('waiting-title').textContent = done ? 'Your part is done' : 'The host is reviewing takes';
    $('waiting-message').textContent = done ? `You recorded all ${queue.lines.length} of your lines.` : 'Hang tight while the host checks the recordings.';
    $('waiting-detail').hidden = !done; $('waiting-detail').textContent = 'Waiting for everyone else.';
  } else if (session.state === 'recording') {
    $('waiting-title').textContent = done ? 'Your part is done' : 'Waiting for your characters';
    $('waiting-message').textContent = done ? `You recorded all ${queue.lines.length} of your lines.` : 'The host will assign your characters before your first line.';
    $('waiting-detail').hidden = !done; $('waiting-detail').textContent = 'Waiting for everyone else.';
  } else {
    $('waiting-title').textContent = 'Waiting for the host';
    $('waiting-message').textContent = 'The host is getting the game ready.';
    $('waiting-detail').hidden = true;
  }
  playback.setState(snapshot);
  const nextMode = finalPlayback ? 'playback' : roleStage ? 'roles' : recording ? 'recording' : 'waiting';
  const changed = visibleMode !== nextMode; visibleMode = nextMode;
  if (changed) requestAnimationFrame(() => {
    if (visibleMode !== nextMode) return;
    const focus = nextMode === 'roles' ? $('role-title') : nextMode === 'recording' ? $('record') : nextMode === 'waiting' ? $('waiting-title') : $('playback-root').querySelector('button');
    if (focus && !focus.disabled) focus.focus({ preventScroll: true });
  });
}

client.start().catch(() => { /* New visitors join with the host invitation. */ });
window.addEventListener('focus', () => { if (client.state) client.request('/api/state?viewer=player').catch(() => {}); });
