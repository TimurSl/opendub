import { RuntimeClient, node } from '../shared/api.js';
import { LineRecorder } from '../recorder/recorder.js';
import { DubPlayback } from '../playback/playback.js';
import { canRecordSelectedLine } from './eligibility.js';
import { roleView } from './view-state.js';
import { renderPlayerChip, renderProfilePicker, loadProfileChoice, saveProfileChoice } from '../shared/identity.js';
import { colorHex } from '../shared/identity-data.js';

const $ = id => document.getElementById(id);
const client = new RuntimeClient('player');
let noticeKind = ''; let rolesFingerprint = null; let readyBusy = false; let visibleMode = null;
let preparedRoles = null; let readinessGeneration = 0; let previousPhase = null; let previousServerReady = false; let previousRolesLocked = false;
let currentMatchId = null; let selectedLineId = null; const rolePending = new Set();
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
  if (/already taken/i.test(message)) return 'Someone claimed that character first. Choose another one.';
  if (/take limit/i.test(message)) return 'You have used all your takes for this line. Ask the host if you need another.';
  if (/turned off player retakes/i.test(message)) return 'The host turned off retakes for this match.';
  if (/role limit/i.test(message)) return 'You have reached your role limit. Release a character before choosing another.';
  if (/host is assigning/i.test(message)) return 'The host is choosing roles. Wait for an assignment.';
  if (/locked/i.test(message)) return 'The host is getting ready to start. Try READY again.';
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
recorder.onModeChange = mode => {
  const locked = ['requesting', 'countdown', 'preroll', 'recording', 'settling', 'accepting'].includes(mode);
  $('line-picker').disabled = locked;
  $('cancel-retake').hidden = !(recorder.retakeId || recorder.retakeAttemptPending);
  $('cancel-retake').disabled = locked;
};
recorder.onAccepted = () => {
  selectedLineId = client.state?.queue?.pendingLines?.[0] || null;
  if (client.state) render(client.state);
};
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

const joinChoice = loadProfileChoice();
const joinPicker = renderProfilePicker($('join-profile-picker'), { ...joinChoice, onChange: saveProfileChoice });
$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); clearNotice(); $('join-button').disabled = true;
  try {
    const { color, avatar } = joinPicker.get();
    await client.request('/api/join', { roomId, joinToken, nickname: $('nickname').value.trim(), ...(color ? { color } : {}), ...(avatar ? { avatar } : {}) });
    await client.start();
  } catch (problem) { error(problem); }
  finally { $('join-button').disabled = false; }
});
async function startExport(format) {
  const button = $(format === 'mp4' ? 'export-video' : 'export-audio'); button.disabled = true; clearNotice();
  try { await client.request('/api/exports', { format }); $('export-status').textContent = 'Rendering. This page updates when it is ready.'; }
  catch (problem) { error(problem); }
  finally { button.disabled = false; }
}
$('export-video').addEventListener('click', () => startExport('mp4'));
$('export-audio').addEventListener('click', () => startExport('m4a'));
function renderExports(snapshot, visible) {
  const { session } = snapshot;
  const show = visible && !!session.exportsAllowed && ['review', 'playback'].includes(session.state) && !!session.pack;
  $('exports-section').hidden = !show;
  if (!show) return;
  const mine = (queueLines => queueLines.some(id => session.lineTakes[id]?.status === 'accepted'))(snapshot.queue?.lines || []);
  $('export-mine').hidden = !mine;
  const list = $('export-jobs'); list.replaceChildren();
  for (const job of session.exports || []) {
    const row = node('li', undefined, 'export-job'); const label = job.format === 'mp4' ? 'Video' : 'Audio';
    row.append(node('span', label));
    if (job.status === 'ready') { const link = node('a', 'DOWNLOAD', 'button-link'); link.href = job.url; link.download = job.filename; row.append(link); }
    else if (job.status === 'failed') row.append(node('span', 'This export failed. Ask the host to try again.', 'job-error'));
    else { const bar = node('progress'); bar.max = 1; bar.value = job.status === 'queued' ? 0 : job.progress; bar.setAttribute('aria-label', label + ' export progress'); row.append(bar); }
    list.append(row);
  }
}
let profilePicker = null; let profileEditorOpen = false;
async function changeProfile(patch) {
  const status = $('profile-status');
  try { await client.request('/api/player/profile', patch); status.textContent = ''; }
  catch (problem) {
    if (problem.status === 409 && problem.suggestion) {
      status.textContent = 'That color is taken, so the next free one was chosen.';
      try { await client.request('/api/player/profile', { ...patch, color: problem.suggestion }); } catch (retry) { error(retry); }
    } else error(problem);
  }
  if (client.state) render(client.state);
}
$('profile-toggle').addEventListener('click', () => {
  profileEditorOpen = !profileEditorOpen;
  $('profile-editor').hidden = !profileEditorOpen; $('profile-toggle').setAttribute('aria-expanded', String(profileEditorOpen));
});
function renderProfile(snapshot, visible) {
  const { session } = snapshot; const me = session.players.find(item => item.id === snapshot.viewer.playerId);
  $('profile-panel').hidden = !visible || !me;
  if (!visible || !me) return;
  $('profile-chip').replaceChildren(renderPlayerChip(me, { size: 32, label: me.nickname }));
  const taken = new Set(session.players.filter(item => item.id !== me.id).map(item => item.color));
  if (!profilePicker) {
    profilePicker = renderProfilePicker($('profile-picker'), { color: me.color, avatar: me.avatar, taken, onChange: ({ color, avatar }) => {
      const current = client.state?.session.players.find(item => item.id === client.state.viewer.playerId);
      const patch = {}; if (color !== current?.color) patch.color = color; if ((avatar || '') !== (current?.avatar || '')) patch.avatar = avatar || '';
      if (Object.keys(patch).length) { saveProfileChoice({ color, avatar }); changeProfile(patch); }
    } });
  } else profilePicker.set({ color: me.color, avatar: me.avatar, taken });
  const roster = $('roster'); roster.replaceChildren();
  for (const other of session.players) {
    const chip = renderPlayerChip(other, { size: 24 }); chip.setAttribute('role', 'listitem'); chip.classList.toggle('offline', !other.connected); roster.append(chip);
  }
}
function roleKey(snapshot) {
  return JSON.stringify([snapshot.session.id, snapshot.session.matchId, snapshot.session.pack?.id, snapshot.viewer.playerId, snapshot.session.settings?.gameMode, [...(snapshot.queue?.assignedCharacters || [])].sort(), [...(snapshot.queue?.lines || [])]]);
}
function microphoneReady() {
  return !!recorder.stream?.getAudioTracks().some(track => track.readyState === 'live');
}
$('ready').addEventListener('click', async () => {
  const snapshot = client.state;
  if (!snapshot || readyBusy || !(snapshot.session.settings?.gameMode === 'line' ? snapshot.queue?.lines.length : snapshot.queue?.assignedCharacters.length)) return;
  const key = roleKey(snapshot); const readiness = readinessGeneration;
  readyBusy = true; $('ready').disabled = true; clearNotice();
  try {
    // Unlock audio on the READY gesture, before waiting for microphone permission.
    playback.unlock().catch(() => {});
    recorder.audioContext?.resume().catch(() => {});
    await recorder.enableMicrophone();
    if (!microphoneReady() || !client.state || roleKey(client.state) !== key || readiness !== readinessGeneration) return;
    const latest = client.state;
    const player = latest.session.players.find(item => item.id === latest.viewer.playerId);
    if (latest.session.state === 'assignment' && !latest.session.rolesLocked && !player?.ready) {
      try { await client.request('/api/player/ready', { ready: true }); }
      catch (problem) {
        // The host can start or lock roles while microphone permission is open.
        if (client.state?.session.state === 'assignment' && !client.state.session.rolesLocked) throw problem;
      }
    }
    if (client.state && roleKey(client.state) === key && readiness === readinessGeneration) preparedRoles = key;
  } catch (problem) { error(problem); }
  finally { readyBusy = false; if (client.state) render(client.state); }
});
client.addEventListener('connection', event => {
  clearTimeout(connectionTimer);
  if (event.detail) clearNotice('connection');
  else connectionTimer = setTimeout(() => showNotice('Connection lost. Your take stays safe. Try again when the host is back.', 'connection'), 3500);
});
client.addEventListener('state', event => render(event.detail));
client.addEventListener('microphone', () => { if (client.state) render(client.state); });

async function chooseLine(lineId) {
  if (!client.state || lineId === selectedLineId) return;
  const previous = selectedLineId;
  if (['requesting', 'countdown', 'preroll', 'recording', 'settling', 'accepting'].includes(recorder.mode)) {
    $('line-picker').value = previous || '';
    return;
  }
  if ((recorder.hasUnacceptedTake() || recorder.retakeId || recorder.retakeAttemptPending) && !window.confirm('Discard your unaccepted take and leave this line?')) {
    $('line-picker').value = previous || '';
    return;
  }
  $('line-picker').disabled = true;
  try {
    if (recorder.hasUnacceptedTake() || recorder.retakeId || recorder.retakeAttemptPending) await recorder.discardCurrent();
    selectedLineId = lineId || null;
    render(client.state);
  } catch (problem) {
    error(problem);
    $('line-picker').value = previous || '';
  } finally {
    if (client.state) $('line-picker').disabled = ['requesting', 'countdown', 'preroll', 'recording', 'settling', 'accepting'].includes(recorder.mode);
  }
}
$('line-picker').addEventListener('change', () => chooseLine($('line-picker').value));
$('cancel-retake').addEventListener('click', async () => {
  $('cancel-retake').disabled = true;
  try { await recorder.cancelActiveRetake(); }
  catch (problem) { error(problem); }
  finally { if (client.state) render(client.state); }
});

function renderAssignedCharacters(characters, pack) {
  const list = $('my-roles');
  const content = characters.map(character => {
    const index = pack?.characters.indexOf(character) ?? -1;
    return `${character} · ${index >= 0 ? pack.characterLineCounts?.[index] ?? 0 : 0} lines`;
  });
  if (JSON.stringify(content) === list.dataset.characters) return;
  list.dataset.characters = JSON.stringify(content);
  list.replaceChildren(...content.map(character => node('li', character)));
}
function renderCharacterOptions(snapshot, canPick) {
  const pack = snapshot.session.pack; const list = $('character-options');
  if (!pack) { list.replaceChildren(); return; }
  const activeCharacter = document.activeElement?.dataset?.character;
  const assignments = snapshot.session.roleAssignments || {}; const players = snapshot.session.players || [];
  const mine = snapshot.queue?.assignedCharacters || []; const settings = snapshot.session.settings || {};
  const maxRoles = settings.allowMultipleRoles === false ? 1 : settings.maxRolesPerPlayer || Infinity;
  const limitReached = mine.length >= maxRoles; let free = 0; let taken = 0;
  list.replaceChildren();
  for (const [index, character] of pack.characters.entries()) {
    const ownerId = assignments[character]; const owner = players.find(player => player.id === ownerId);
    const isMine = ownerId === snapshot.viewer.playerId;
    if (owner) taken++; else free++;
    const card = node('div', undefined, `character-option${isMine ? ' is-mine' : ''}`); card.setAttribute('role', 'listitem');
    const name = node('strong', character); const count = node('small', `${pack.characterLineCounts?.[index] ?? 0} lines · ${owner ? isMine ? 'Yours' : `Taken by ${owner.nickname}` : 'Free'}`);
    const button = node('button', isMine ? 'Release' : owner ? 'Taken' : settings.freeRolePicking === false ? 'Host assigns' : 'Choose');
    button.type = 'button'; button.dataset.character = character;
    const pendingKey = `${snapshot.session.matchId}:${character}`;
    button.disabled = !canPick || rolePending.has(pendingKey) || settings.freeRolePicking === false || (isMine ? false : !!owner || limitReached);
    button.setAttribute('aria-label', isMine ? `Release ${character}` : owner ? `${character}, taken by ${owner.nickname}` : settings.freeRolePicking === false ? `${character}, host assigns this role` : `Choose ${character}`);
    button.addEventListener('click', () => changeRole(character, isMine ? 'release' : 'claim'));
    card.append(name, count, button); list.append(card);
  }
  const limit = Number.isFinite(maxRoles) ? maxRoles : 'no limit';
  $('role-counts').textContent = `${free} free · ${taken} taken · ${mine.length} of ${limit} chosen`;
  $('role-help').textContent = !canPick ? 'Role selection is locked. Check your microphone and wait for the host.'
    : settings.freeRolePicking === false ? 'The host is choosing roles. Check your microphone while you wait.'
      : `Choose at least one free character. You can take up to ${limit} ${limit === 1 ? 'role' : 'roles'}.`;
  if (activeCharacter) list.querySelector(`button[data-character="${CSS.escape(activeCharacter)}"]`)?.focus({ preventScroll: true });
}
async function changeRole(character, action) {
  const requestMatchId = client.state?.session.matchId; const pendingKey = `${requestMatchId}:${character}`;
  if (rolePending.has(pendingKey)) return;
  rolePending.add(pendingKey); clearNotice();
  if (client.state) render(client.state);
  try { await client.request(`/api/player/${action}`, { character }); }
  catch (problem) {
    if (problem.status === 409 || problem.status === 403) await client.request('/api/state?viewer=player').catch(() => {});
    error(problem);
  } finally {
    rolePending.delete(pendingKey);
    if (client.state) render(client.state);
  }
}
function render(snapshot) {
  if (snapshot.viewer.kind !== 'player') return;
  const session = snapshot.session; const pack = session.pack; const queue = snapshot.queue;
  if (roomId && session.id !== roomId) return;
  if (currentMatchId !== session.matchId) {
    currentMatchId = session.matchId; selectedLineId = null; preparedRoles = null; rolesFingerprint = null;
    rolePending.clear(); readinessGeneration++;
  }
  const player = session.players.find(item => item.id === snapshot.viewer.playerId);
  const currentRoleKey = roleKey(snapshot);
  if (rolesFingerprint !== currentRoleKey || (previousRolesLocked && !session.rolesLocked) || (previousServerReady && !player?.ready) || (session.state === 'assignment' && previousPhase && previousPhase !== 'assignment')) {
    preparedRoles = null; readinessGeneration++;
  }
  rolesFingerprint = currentRoleKey; previousServerReady = !!player?.ready; previousPhase = session.state; previousRolesLocked = !!session.rolesLocked;
  const lineMode = session.settings.gameMode === 'line';
  const hasTasks = !!queue?.lines.length;
  const prepared = preparedRoles === currentRoleKey && microphoneReady();
  const ownedLineIds = queue?.lines || [];
  if (selectedLineId && !ownedLineIds.includes(selectedLineId)) selectedLineId = null;
  if (!selectedLineId && queue?.pendingLines?.length) selectedLineId = queue.pendingLines[0];
  const line = pack?.lines.find(item => item.id === selectedLineId);
  const finalPlayback = session.state === 'playback';
  const hasUnfinishedRequiredLine = session.completedLineCount < session.totalLineCount;
  const { showRoles, canPick, canReady } = roleView({
    state: session.state, hasPack: !!pack, lineMode, hasTasks, rolesLocked: session.rolesLocked,
  });
  const recordingLine = ['recording', 'review', 'paused'].includes(session.state) && !!line && hasTasks;
  const recording = recordingLine;
  const ownedActiveRetake = line && session.activeRetakes?.find(item => item.lineId === line.id && item.playerId === snapshot.viewer.playerId);
  const hasRetakeAttemptForTab = !!(recorder.retakeId || recorder.retakeAttemptPending);
  const lineAllowed = canRecordSelectedLine({
    state: session.state, hasTasks, lineId: line?.id, hasUnfinishedRequiredLine,
    activeRetakeLineId: ownedActiveRetake?.lineId, hasRetakeAttemptForTab,
  });
  const done = ['recording', 'review', 'paused'].includes(session.state) && hasTasks && !queue.pendingLines.length;
  if (session.state === 'paused') recorder.pauseCapture();
  $('join-panel').hidden = true; $('room-panel').hidden = false;
  $('pack-title').textContent = pack?.metadata.title || 'Your party';
  $('pack-title').parentElement.hidden = finalPlayback;
  $('role-panel').hidden = !showRoles;
  $('recording-panel').hidden = !recording;
  $('recording-microphone-help').hidden = !recording || microphoneReady();
  $('playback-panel').hidden = !finalPlayback;
  $('waiting-panel').hidden = showRoles || recording || finalPlayback;
  renderProfile(snapshot, !recording && !finalPlayback);
  renderExports(snapshot, !recording);
  $('recording-panel').style.setProperty('--chip', colorHex(player?.color));
  const showLineNavigation = hasTasks && ['recording', 'review', 'paused'].includes(session.state);
  $('line-navigation').hidden = !showLineNavigation;
  const picker = $('line-picker'); const selectedWasFocused = document.activeElement === picker;
  picker.replaceChildren();
  if (done && ownedLineIds.length && !selectedLineId) {
    const option = node('option', 'DONE · choose an accepted line to review'); option.value = ''; picker.append(option);
  }
  for (const lineId of ownedLineIds) {
    const item = pack.lines.find(candidate => candidate.id === lineId); if (!item) continue;
    const index = pack.lines.indexOf(item); const accepted = session.lineTakes[item.id]?.status === 'accepted';
    const replacement = session.replacementTakes?.[item.id];
    const status = replacement ? 'Replacement ready' : accepted ? 'Accepted' : session.lineTakes[item.id]?.status === 'recorded' ? 'Ready for NEXT' : 'Needs a take';
    const caption = item.caption.length > 48 ? `${item.caption.slice(0, 45)}…` : item.caption;
    const option = node('option', `LINE ${index + 1} · ${item.character} · ${caption} · ${status}`);
    option.value = item.id; picker.append(option);
  }
  if (!ownedLineIds.length) { const option = node('option', 'No lines assigned'); option.value = ''; picker.append(option); }
  picker.value = selectedLineId || '';
  picker.disabled = ['requesting', 'countdown', 'preroll', 'recording', 'settling', 'accepting'].includes(recorder.mode);
  if (selectedWasFocused && !picker.disabled) picker.focus({ preventScroll: true });
  $('done-indicator').hidden = !done;
  $('done-indicator').textContent = done ? `DONE · ${queue.completedLines.length} of ${queue.lines.length} assigned lines accepted` : '';
  if (recorder.retakeId && !ownedActiveRetake && !session.replacementTakes?.[line?.id]) {
    recorder.retakeId = ''; recorder.retakeAttemptId = ''; recorder.retakeAttemptPending = false;
  } else if (recorder.retakeAttemptPending && !ownedActiveRetake && !session.replacementTakes?.[line?.id] && session.state !== 'recording') {
    recorder.retakeAttemptId = ''; recorder.retakeAttemptPending = false;
  }
  $('cancel-retake').hidden = !(recorder.retakeId || recorder.retakeAttemptPending);
  $('cancel-retake').disabled = picker.disabled;
  const viewLine = recordingLine ? line : null;
  recorder.setLine(pack, viewLine, lineAllowed, session.settings, session.state === 'paused', session.matchId);
  if (viewLine) recorder.setTakes(session.lineTakes[line.id], session.lineTakes[line.id]?.status === 'accepted' ? session.lineTakes[line.id] : null, session.replacementTakes?.[line.id]);
  if (recording) {
    $('line-number').hidden = false;
    $('line-number').textContent = `LINE ${queue.lines.indexOf(line.id) + 1} / ${queue.lines.length}`;
    $('line-character').textContent = line.character;
    $('line-caption').textContent = line.caption;
    if (visibleMode !== 'recording') requestAnimationFrame(() => recorder.drawWaveform());
  } else $('line-number').hidden = true;
  if (showRoles) {
    $('role-title').textContent = lineMode ? 'Check your line assignments' : 'Choose your characters';
    $('character-options').hidden = lineMode;
    $('line-setup-summary').hidden = !lineMode;
    $('my-roles').parentElement.hidden = lineMode;
    if (lineMode) {
      renderAssignedCharacters([], pack);
      const assigned = pack?.lines.filter(item => queue.lines.includes(item.id)) || [];
      const characters = [...new Set(assigned.map(item => item.character))];
      $('assigned-line-count').textContent = `${assigned.length} assigned ${assigned.length === 1 ? 'line' : 'lines'}`;
      $('assigned-character-summary').textContent = characters.length ? `Characters: ${characters.map(character => `${character} (${assigned.filter(item => item.character === character).length})`).join(' · ')}` : 'The host will deal lines among connected players.';
      $('role-counts').textContent = `${assigned.length} assigned lines · ${characters.length} ${characters.length === 1 ? 'character' : 'characters'}`;
    } else {
      renderCharacterOptions(snapshot, canPick);
      renderAssignedCharacters(queue?.assignedCharacters || [], pack);
      if (session.state === 'lobby') $('role-help').textContent = 'Choose your characters now. READY opens after the host finishes setup.';
    }
    $('role-help').textContent = lineMode
      ? 'Review your assigned lines and character summaries, then check your microphone.'
      : $('role-help').textContent;
    $('role-key-help').textContent = lineMode
      ? 'Use Tab to review your line summary and microphone controls.'
      : 'Use Tab and Enter to choose characters or check your microphone.';
    $('ready').disabled = readyBusy || !canReady;
    $('ready').setAttribute('aria-pressed', String(prepared));
    $('microphone-status').textContent = prepared ? 'Microphone ready. You can wait for the host.' : microphoneReady() ? 'Microphone connected. Press READY to confirm.' : 'Allow microphone access, then press READY.';
  }
  $('waiting-detail').hidden = true;
  if (done) {
    $('waiting-title').textContent = 'DONE';
    $('waiting-message').textContent = `You accepted all ${queue.lines.length} assigned lines.`;
    $('waiting-detail').textContent = session.activeRetakes?.length ? 'A replacement retake is holding completion open.' : 'Waiting for everyone else...';
    $('waiting-detail').hidden = false;
  } else if (session.state === 'paused') {
    $('waiting-title').textContent = 'Paused'; $('waiting-message').textContent = 'Waiting for the host to continue.';
  } else if (session.state === 'review') {
    $('waiting-title').textContent = 'Waiting for the host'; $('waiting-message').textContent = 'The host is reviewing the recordings.';
  } else if (session.state === 'lobby') {
    $('waiting-title').textContent = pack ? 'Pack selected' : 'Party is ready';
    $('waiting-message').textContent = pack ? 'The host is finishing setup. Roles will open when the host enables picking.' : 'The host will choose a pack. Stay on this page for the next match.';
  } else if (!hasTasks && session.state !== 'lobby') {
    $('waiting-title').textContent = lineMode ? 'Waiting for lines' : 'Waiting for your characters';
    $('waiting-message').textContent = lineMode ? 'You have no lines yet. Your host can deal lines or assign them to you. You do not need to enable your microphone.' : 'Your host will assign your characters.';
  } else {
    $('waiting-title').textContent = 'Waiting for the host'; $('waiting-message').textContent = 'The host will start recording soon.';
  }
  playback.setState(snapshot);
  const nextMode = finalPlayback ? 'playback' : showRoles ? 'roles' : recording ? 'recording' : 'waiting';
  const changed = visibleMode !== nextMode; visibleMode = nextMode;
  if (changed) requestAnimationFrame(() => {
    if (visibleMode !== nextMode) return;
    const focus = nextMode === 'roles' ? $('role-title') : nextMode === 'recording' ? $('record') : nextMode === 'waiting' ? $('waiting-title') : $('playback-root').querySelector('button');
    if (focus && !focus.disabled) focus.focus({ preventScroll: true });
  });
}

document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  const target = event.target;
  if (target?.matches?.('input,textarea,select,[contenteditable="true"],button')) return;
  if ($('recording-panel').hidden) return;
  const control = ({ o: 'original', r: 'record', t: 'my-take', n: 'next' })[event.key.toLowerCase()];
  if (!control || $(control).disabled) return;
  event.preventDefault(); $(control).click();
});

client.start().catch(() => { /* New visitors join with the host invitation. */ });
