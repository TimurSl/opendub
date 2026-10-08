import { RuntimeClient, node, showError, setBusy } from '../shared/api.js';
import { DubPlayback } from '../playback/playback.js';
import { filterPacks } from './pack-filters.js';
import { PendingButtons } from './pending-buttons.js';

const $ = id => document.getElementById(id);
const client = new RuntimeClient('admin');
const error = problem => showError($('error'), problem);
const playback = new DubPlayback($('playback-root'), client, error);
let publicLink = location.origin;
const publicLinkReady = fetch('/api/config', { credentials: 'same-origin', cache: 'no-store' })
  .then(async response => {
    if (!response.ok) return;
    const config = await response.json();
    if (typeof config.publicLink === 'string' && config.publicLink) publicLink = config.publicLink;
  })
  .catch(() => {});
const roleViews = new Map(); const takeRows = new Map(); const pendingButtons = new PendingButtons(); const pendingActionPaths = new Set();
let selectedPackId = null; let selectedRoomId = null; let selectedMatchId = null; let activePackList = [];
let viewedStage = null; let renderedPackListKey = null;

function beginPending(button, label = 'Working…') {
  return pendingButtons.begin(button, label);
}
function endPending(button) {
  pendingButtons.finish(button, () => { if (client.state) render(client.state); });
}
function renderPendingButtons() {
  pendingButtons.apply();
}
async function action(path, body = {}, button) {
  if (pendingActionPaths.has(path)) return null;
  pendingActionPaths.add(path);
  if (!beginPending(button)) { pendingActionPaths.delete(path); return null; }
  if (path === 'select') renderPackList(true);
  $('error').hidden = true;
  try { return await client.request(`/api/admin/${path}`, body); }
  catch (problem) { error(problem); throw problem; }
  finally { pendingActionPaths.delete(path); endPending(button); }
}
function readSessionSettings() {
  return {
    gameMode: $('game-mode').value,
    freeRolePicking: $('free-role-picking').checked,
    allowMultipleRoles: $('multiple-roles').checked,
    maxRolesPerPlayer: Number($('max-roles').value || 0),
    autoBalanceSuggestions: $('auto-balance').checked,
    lockRolesWhenReady: $('lock-when-ready').checked,
    referencePlaybackEnabled: $('reference-enabled').checked,
    voiceEffectsEnabled: $('effects-enabled').checked,
    compactMobilePreferred: $('compact-mobile').checked,
  };
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); setBusy($('login-button'), true, 'Open studio'); $('error').hidden = true;
  try {
    await publicLinkReady;
    await client.request('/api/admin/login', { token: $('admin-token').value });
    $('admin-token').value = ''; await client.start(); await refreshPacks();
  } catch (problem) { error(problem); }
  finally { setBusy($('login-button'), false, 'Open studio'); }
});
$('refresh-packs').addEventListener('click', () => refreshPacks().catch(error));
$('create-party').addEventListener('click', () => action('create-party', {}, $('create-party')).then(() => {
  viewedStage = 1;
  if (client.state) render(client.state);
}).catch(() => {}));
$('replace-party').addEventListener('click', async () => {
  if (!window.confirm('Replace this party? Its current invitation and all player credentials will stop working.')) return;
  viewedStage = 1;
  try { await action('create-party', {}, $('replace-party')); }
  catch {}
});
$('change-pack').addEventListener('click', () => {
  if (client.state?.session.state !== 'lobby') return;
  viewedStage = 1; render(client.state); refreshPacks().catch(error);
});
$('back-to-setup').addEventListener('click', () => {
  viewedStage = 2;
  if (client.state) render(client.state);
});
document.querySelector('.stage-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-stage]');
  if (!button) return;
  viewedStage = Number(button.dataset.stage);
  if (client.state) render(client.state);
});
$('copy-join').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('join-url').value); $('copy-join').textContent = 'Copied'; }
  catch { $('join-url').focus(); $('join-url').select(); $('copy-join').textContent = 'Select & copy'; }
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await action('settings', readSessionSettings(), $('save-settings')); }
  catch {}
});
$('multiple-roles').addEventListener('change', () => {
  if (!$('multiple-roles').checked && Number($('max-roles').value) > 1) $('max-roles').value = '1';
  updateMaxRoles();
});
$('open-lobby').addEventListener('click', async () => {
  const button = $('open-lobby'); button.disabled = true;
  try {
    await action('settings', readSessionSettings());
    await action('open-lobby', {}, button);
  } catch {}
  finally { if (client.state) render(client.state); else button.disabled = false; }
});
$('fill-unassigned').addEventListener('click', () => action('fill-unassigned', {}, $('fill-unassigned')).catch(() => {}));
$('recording-balance').addEventListener('click', () => action('fill-unassigned', {}, $('recording-balance')).catch(() => {}));
$('deal-lines').addEventListener('click', () => action('deal-lines', {}, $('deal-lines')).catch(() => {}));
$('lock-roles').addEventListener('click', () => action('lock-roles', {}, $('lock-roles')).catch(() => {}));
$('unlock-roles').addEventListener('click', () => action('reopen-roles', {}, $('unlock-roles')).catch(() => {}));
$('start-recording').addEventListener('click', () => action('start', {}, $('start-recording')).catch(() => {}));
$('pause-session').addEventListener('click', () => action('pause', {}, $('pause-session')).catch(() => {}));
$('resume-session').addEventListener('click', () => action('resume', {}, $('resume-session')).catch(() => {}));
$('reopen-roles').addEventListener('click', () => action('reopen-roles', {}, $('reopen-roles')).catch(() => {}));
$('continue-review').addEventListener('click', () => action('review', {}, $('continue-review')).catch(() => {}));
$('accept-all').addEventListener('click', () => action('accept-all', {}, $('accept-all')).catch(() => {}));
$('continue-recording').addEventListener('click', () => action('start', {}, $('continue-recording')).catch(() => {}));
async function startSharedPlayback(allowMissing, button) {
  if (!beginPending(button)) return;
  $('error').hidden = true;
  try {
    await playback.prepare();
    await action('playback', { allowMissing });
  } catch (problem) { error(problem); }
  finally { endPending(button); }
}
$('review-playback').addEventListener('click', () => startSharedPlayback(false, $('review-playback')));
$('skip-missing').addEventListener('click', () => startSharedPlayback(true, $('skip-missing')));
$('restart-playback').addEventListener('click', () => action('restart-playback', {}, $('restart-playback')).catch(() => {}));
$('stop-playback').addEventListener('click', () => action('stop-playback', {}, $('stop-playback')).catch(() => {}));
$('line-filter').addEventListener('change', () => { if (client.state) renderTakes(client.state.session); });
$('next-match-review').addEventListener('click', () => {
  viewedStage = 1;
  action('next-match', {}, $('next-match-review')).catch(() => {});
});
$('next-match-playback').addEventListener('click', () => {
  viewedStage = 1;
  action('next-match', {}, $('next-match-playback')).catch(() => {});
});
$('export-video').addEventListener('click', async () => {
  const button = $('export-video');
  if (!beginPending(button, 'Exporting…')) return;
  const matchId = client.state?.session.matchId;
  $('export-status').textContent = 'Building the video and mixing accepted takes…'; $('error').hidden = true;
  try {
    const result = await client.request('/api/admin/export', {});
    if (!matchId || client.state?.session.matchId !== matchId) {
      $('export-status').textContent = 'The match changed while exporting. Start a new export from the current match.';
      return;
    }
    const download = node('a'); download.href = result.url; download.download = result.filename;
    document.body.append(download); download.click(); download.remove();
    $('export-status').textContent = 'Export is ready. Your browser is downloading the MP4.';
  } catch (problem) { $('export-status').textContent = ''; error(problem); }
  finally { endPending(button); }
});
client.addEventListener('connection', event => { $('connection').textContent = event.detail ? 'Connected · host controls' : 'Reconnecting to local runtime'; });
client.addEventListener('state', event => render(event.detail));

const packFilterKey = 'open-dub-pack-filters';
try {
  const saved = JSON.parse(localStorage.getItem(packFilterKey) || '{}');
  $('pack-search').value = typeof saved.title === 'string' ? saved.title : '';
  $('pack-min-characters').value = Number.isInteger(saved.minimum) ? String(saved.minimum) : '';
  $('pack-max-characters').value = Number.isInteger(saved.maximum) ? String(saved.maximum) : '';
} catch { /* Filtering remains available when browser storage is disabled. */ }
function savePackFilters() {
  try {
    localStorage.setItem(packFilterKey, JSON.stringify({
      title: $('pack-search').value,
      minimum: $('pack-min-characters').value === '' ? null : Number($('pack-min-characters').value),
      maximum: $('pack-max-characters').value === '' ? null : Number($('pack-max-characters').value),
    }));
  } catch { /* Keep current filter values in the page when storage is unavailable. */ }
}
for (const id of ['pack-search', 'pack-min-characters', 'pack-max-characters']) $(id).addEventListener('input', () => {
  savePackFilters(); renderPackList(true);
});
$('clear-pack-filters').addEventListener('click', () => {
  $('pack-search').value = ''; $('pack-min-characters').value = ''; $('pack-max-characters').value = '';
  savePackFilters(); renderPackList(true); $('pack-search').focus();
});
function renderPackList(force = false) {
  const session = client.state?.session;
  const key = JSON.stringify([session?.partyCreated, session?.state, session?.matchId, session?.pack?.id, pendingActionPaths.has('select'), activePackList.map(pack => pack.id)]);
  if (!force && key === renderedPackListKey) return;
  renderedPackListKey = key;
  const container = $('packs'); container.replaceChildren();
  const minimum = $('pack-min-characters').value === '' ? null : Number($('pack-min-characters').value);
  const maximum = $('pack-max-characters').value === '' ? null : Number($('pack-max-characters').value);
  const title = $('pack-search').value;
  const filtered = filterPacks(activePackList, { title, minimum, maximum });
  $('pack-result-count').textContent = `${filtered.length} of ${activePackList.length} packs`;
  $('clear-pack-filters').disabled = !title.trim() && minimum === null && maximum === null;
  if (!activePackList.length) {
    container.append(node('p', 'No compatible packs found. Check the Workshop directory configured when starting the server.', 'muted'));
    return;
  }
  if (!filtered.length) {
    container.append(node('p', 'No packs match these filters.', 'muted'));
    return;
  }
  for (const pack of filtered) {
    const metadata = pack.metadata || pack; const row = node('article', undefined, 'pack');
    if (pack.iconUrl) { const image = node('img'); image.src = pack.iconUrl; image.alt = ''; row.append(image); }
    else row.append(node('div', 'OD', 'pack-icon'));
    const body = node('div', undefined, 'pack-body');
    body.append(node('h3', metadata.title || pack.id));
    body.append(node('p', (metadata.authors || []).join(', ') || 'Unknown authors', 'muted'));
    const counts = pack.characters.map((character, index) => pack.characterLineCounts?.[index] ?? 0);
    body.append(node('p', `${pack.lineCount ?? 0} lines, ${pack.characterCount ?? pack.characters?.length ?? 0} characters [${counts.join(',')}]`, 'help'));
    body.append(node('p', pack.characters.map((character, index) => `${character}: ${counts[index]}`).join(' · '), 'help'));
    const select = node('button', pendingActionPaths.has('select') ? 'Selecting…' : client.state?.session.pack?.id === pack.id ? 'Open setup' : 'Select pack');
    select.disabled = client.state?.session.state !== 'lobby' || pendingActionPaths.has('select');
    select.addEventListener('click', async () => {
      const current = client.state?.session.pack;
      if (current?.id === pack.id) { viewedStage = 2; if (client.state) render(client.state); return; }
      try {
        await action('select', { packId: pack.id }, select);
        viewedStage = 2;
        if (client.state) render(client.state);
      } catch {}
    });
    row.append(body, select); container.append(row);
  }
}
async function refreshPacks() {
  const button = $('refresh-packs'); button.disabled = true;
  try {
    const { packs, errors = [] } = await client.request('/api/admin/packs');
    activePackList = packs;
    $('pack-errors').hidden = !errors.length;
    $('pack-errors').textContent = errors.map(item => typeof item === 'string' ? item : item.error || item.message || JSON.stringify(item)).join('\n');
    renderPackList(true);
  } finally { button.disabled = false; }
}

function currentStage(session) {
  if (!session.partyCreated || !session.pack) return 1;
  return ({ lobby: 2, assignment: 3, recording: 4, paused: 4, review: 5, playback: 6 })[session.state] || 2;
}
function showStage(stage, progressStage, session) {
  const names = ['packs', 'setup', 'roles', 'recording', 'review', 'playback'];
  names.forEach((name, index) => { $(`screen-${name}`).hidden = index + 1 !== stage; });
  for (let index = 1; index <= 6; index++) {
    const item = $(`stage-indicator-${index}`);
    const button = $(`stage-button-${index}`);
    item.classList.toggle('is-current', index === stage);
    item.classList.toggle('is-complete', index < progressStage);
    button.disabled = progressStage === 1 && index !== 1;
    if (index === stage) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  }
  $('stage-heading').textContent = stage === 1 && !session.partyCreated ? 'Create party' : ['Choose a pack', 'Set up your session', 'Choose roles', 'Recording progress', 'Review the takes', 'Final playback'][stage - 1];
}
function render(snapshot) {
  if (snapshot.viewer.kind !== 'admin') return;
  const session = snapshot.session; const pack = session.pack;
  $('login-panel').hidden = true; $('admin-panel').hidden = false;
  const partyChanged = selectedRoomId !== session.id;
  const matchChanged = selectedMatchId !== session.matchId;
  if (partyChanged || matchChanged) {
    viewedStage = null; roleViews.clear(); takeRows.clear();
    ['roles', 'recording-roles', 'takes'].forEach(id => $(id).replaceChildren());
    $('export-status').textContent = '';
  }
  selectedRoomId = session.id; selectedMatchId = session.matchId; selectedPackId = pack?.id || null;
  $('party-create').hidden = !!session.partyCreated;
  $('pack-heading').hidden = !session.partyCreated;
  $('pack-filter-controls').hidden = !session.partyCreated;
  $('packs').hidden = !session.partyCreated;
  $('party-invite').hidden = !session.partyCreated;
  $('replace-party').hidden = !session.partyCreated;
  $('phase').textContent = session.partyCreated ? (pack ? session.state : 'party waiting') : 'no party';
  if (session.partyCreated) {
    const invitationUrl = new URL(`/join/${encodeURIComponent(session.id)}`, publicLink || location.origin);
    invitationUrl.hash = `token=${encodeURIComponent(session.joinToken)}`;
    if ($('join-url').value !== invitationUrl.href) { $('join-url').value = invitationUrl.href; $('copy-join').textContent = 'Copy link'; }
    $('room-code').textContent = session.id.slice(0, 6).toUpperCase();
  }
  if (!pack) {
    viewedStage = 1;
    showStage(1, 1, session);
    renderPacksIfNeeded();
    playback.setState(snapshot);
    renderPendingButtons();
    return;
  }
  const progressStage = currentStage(session);
  const stage = viewedStage ?? progressStage;
  showStage(stage, progressStage, session);
  $('change-pack').hidden = !session.pack || session.state !== 'lobby';
  $('back-to-setup').hidden = stage !== 1 || !session.pack;
  $('selected-title').textContent = pack.metadata.title || 'Dub pack';
  const counts = pack.characters.map((character, index) => pack.characterLineCounts?.[index] ?? 0);
  $('selected-metadata').textContent = `${(pack.metadata.authors || []).join(', ') || 'Unknown authors'} · ${pack.metadata.language || 'Unspecified language'} · ${pack.lines.length} lines, ${pack.characters.length} characters [${counts.join(',')}] · ${pack.characters.map((character, index) => `${character}: ${counts[index]}`).join(' · ')}`;
  renderSettings(session);
  $('settings-form').querySelectorAll('input,button').forEach(input => { input.disabled = session.state !== 'lobby'; });
  $('game-mode').disabled = session.state !== 'lobby';
  updateMaxRoles();
  const lineMode = session.settings.gameMode === 'line';
  const allAssigned = lineMode
    ? pack.lines.every(line => !!session.lineAssignments[line.id] && session.players.some(player => player.id === session.lineAssignments[line.id]))
    : pack.characters.every(character => !!session.roleAssignments[character]);
  $('character-assignment').hidden = lineMode;
  $('line-assignment').hidden = !lineMode;
  $('character-reassignment').hidden = lineMode;
  $('line-reassignment').hidden = !lineMode;
  $('review-line-reassignment').hidden = !lineMode;
  $('role-summary').textContent = `${pack.characters.filter(character => !session.roleAssignments[character]).length} free · ${pack.characters.filter(character => session.roleAssignments[character]).length} chosen`;
  $('role-player-count').textContent = `${session.players.length} joined`;
  if (!lineMode) {
    renderAssignmentRows('roles', session);
    renderAssignmentRows('recording-roles', session);
  }
  const lineCounts = new Map(session.players.map(player => [player.id, 0]));
  for (const ownerId of Object.values(session.lineAssignments || {})) if (lineCounts.has(ownerId)) lineCounts.set(ownerId, lineCounts.get(ownerId) + 1);
  $('line-assignment-summary').textContent = `${lineCounts.size ? `${[...lineCounts].map(([id, count]) => `${session.players.find(player => player.id === id)?.nickname}: ${count}`).join(' · ')} · ` : ''}${Object.keys(session.lineAssignments || {}).length} of ${pack.lines.length} lines assigned`;
  $('deal-lines').disabled = session.state !== 'assignment' || !!session.recordingStarted || !session.players.some(player => player.connected);
  $('deal-lines').textContent = Object.keys(session.lineAssignments || {}).length && !session.recordingStarted ? 'Redeal lines' : 'Deal lines';
  renderLineAssignmentRows('line-assignments', session);
  renderLineAssignmentRows('recording-line-assignments', session);
  renderLineAssignmentRows('review-line-assignments', session);
  renderPlayers('players', session); renderPlayers('recording-players', session);
  $('fill-unassigned').hidden = $('recording-balance').hidden = !session.settings.autoBalanceSuggestions;
  $('fill-unassigned').disabled = $('recording-balance').disabled = !session.players.length || !pack.characters.some(character => !session.roleAssignments[character]);
  $('lock-roles').disabled = session.rolesLocked || !allAssigned || !session.players.length;
  $('lock-roles').textContent = session.rolesLocked ? (lineMode ? 'Assignments locked' : 'Roles locked') : (lineMode ? 'Lock assignments' : 'Lock roles');
  $('start-recording').disabled = !session.players.length || !allAssigned || !['assignment'].includes(session.state);
  $('lock-roles').hidden = session.state !== 'assignment';
  $('unlock-roles').hidden = session.state !== 'assignment' || !session.rolesLocked;
  $('start-recording').hidden = session.state !== 'assignment';
  $('completion').textContent = `${session.completedLineCount} of ${session.totalLineCount} lines accepted`;
  $('recording-state').textContent = session.state === 'paused' ? 'Paused' : 'In progress';
  $('recording-title').textContent = session.state === 'paused' ? 'Recording is paused' : 'Everyone is recording';
  renderIncompleteLines(session);
  const activeRetakes = session.activeRetakes || [];
  $('active-retakes').hidden = !activeRetakes.length;
  $('active-retakes').textContent = activeRetakes.length ? `Waiting for ${activeRetakes.map(retake => `${retake.nickname} to finish line ${pack.lines.findIndex(line => line.id === retake.lineId) + 1}`).join(' and ')} before review can continue.` : '';
  $('pause-session').hidden = session.state !== 'recording';
  $('resume-session').hidden = session.state !== 'paused';
  $('reopen-roles').disabled = session.state === 'playback';
  $('continue-review').disabled = !['recording', 'paused'].includes(session.state) || activeRetakes.length > 0;
  $('continue-recording').hidden = session.state !== 'review' || session.completedLineCount >= session.totalLineCount;
  $('review-summary').textContent = `${session.completedLineCount} accepted · ${session.totalLineCount - session.completedLineCount} missing · ${Object.values(session.lineTakes).filter(take => take.status === 'recorded').length} to review`;
  const hasRecorded = Object.values(session.lineTakes).some(take => take.status === 'recorded');
  $('accept-all').disabled = !hasRecorded || !['recording', 'review'].includes(session.state);
  $('review-playback').disabled = session.completedLineCount < session.totalLineCount || session.state !== 'review' || activeRetakes.length > 0;
  $('skip-missing').disabled = session.state !== 'review';
  $('final-summary').textContent = `${session.completedLineCount} accepted lines · ${session.totalLineCount - session.completedLineCount} skipped`;
  $('restart-playback').disabled = $('stop-playback').disabled = session.state !== 'playback';
  $('next-match-review').disabled = session.state !== 'review';
  $('next-match-playback').disabled = session.state !== 'playback';
  $('export-video').disabled = !['review', 'playback'].includes(session.state);
  renderTakes(session); playback.setState(snapshot);
  renderPackList(); renderPendingButtons();
}
function renderPacksIfNeeded() {
  if (!activePackList.length) refreshPacks().catch(error);
}
function renderSettings(session) {
  const settings = session.settings || {};
  const values = {
    'game-mode': settings.gameMode || 'character',
    'free-role-picking': settings.freeRolePicking,
    'multiple-roles': settings.allowMultipleRoles,
    'max-roles': settings.maxRolesPerPlayer,
    'auto-balance': settings.autoBalanceSuggestions,
    'lock-when-ready': settings.lockRolesWhenReady,
    'reference-enabled': settings.referencePlaybackEnabled,
    'effects-enabled': settings.voiceEffectsEnabled,
    'compact-mobile': settings.compactMobilePreferred,
  };
  for (const [id, value] of Object.entries(values)) {
    const input = $(id);
    if (document.activeElement === input) continue;
    if (id === 'game-mode') input.value = value;
    else if (id === 'max-roles') { input.value = String(value ?? 0); input.max = String(session.pack.characters.length); }
    else input.checked = !!value;
  }
  const lineMode = settings.gameMode === 'line';
  for (const id of ['setting-free-role-picking', 'setting-multiple-roles', 'setting-max-roles', 'setting-auto-balance', 'setting-lock-ready']) $(id).hidden = lineMode;
}
function updateMaxRoles() {
  const input = $('max-roles');
  const multiple = $('multiple-roles').checked;
  if (!multiple) input.value = '1';
  input.disabled = !multiple || client.state?.session.state !== 'lobby';
}
function renderAssignmentRows(containerId, session) {
  const container = $(containerId); const pack = session.pack;
  let view = roleViews.get(containerId);
  if (!view) { view = new Map(); roleViews.set(containerId, view); }
  const rosterKey = JSON.stringify(session.players.map(player => [player.id, player.nickname, player.connected]));
  for (const character of pack.characters) {
    let row = view.get(character);
    if (!row) {
      const element = node('div', undefined, 'role-row'); const info = node('div', undefined, 'role-info');
      const name = node('strong', character); const status = node('small'); info.append(name, status);
      const select = node('select'); select.setAttribute('aria-label', `Assign ${character}`);
      select.addEventListener('change', () => {
        const path = select.value ? 'assign' : 'unassign';
        const body = select.value ? { character, playerId: select.value } : { character };
        action(path, body, select).catch(() => {});
      });
      select.addEventListener('blur', () => { if (client.state) renderAssignmentRows(containerId, client.state.session); });
      element.append(info, select); container.append(element); row = { element, name, status, select, rosterKey: null }; view.set(character, row);
    }
    if (row.rosterKey !== rosterKey && document.activeElement !== row.select) {
      row.select.replaceChildren();
      const empty = node('option', 'Unassigned'); empty.value = ''; row.select.append(empty);
      for (const player of session.players) { const option = node('option', `${player.nickname}${player.connected ? '' : ' · disconnected'}`); option.value = player.id; row.select.append(option); }
      row.rosterKey = rosterKey;
    }
    const ownerId = session.roleAssignments[character]; const owner = session.players.find(player => player.id === ownerId);
    row.status.textContent = owner ? `Taken by ${owner.nickname}${owner.ready ? ' · ready' : ''}` : 'Free';
    if (document.activeElement !== row.select) row.select.value = ownerId || '';
    row.select.disabled = session.state === 'playback' || session.state === 'lobby' || !session.players.length;
    row.element.classList.toggle('is-free', !owner);
  }
}
function renderLineAssignmentRows(containerId, session) {
  const container = $(containerId); const pack = session.pack;
  if (!pack || container.hidden) return;
  let view = roleViews.get(containerId);
  if (!view) { view = new Map(); roleViews.set(containerId, view); }
  const rosterKey = JSON.stringify(session.players.map(player => [player.id, player.nickname, player.connected]));
  for (const [index, line] of pack.lines.entries()) {
    let row = view.get(line.id);
    if (!row) {
      const element = node('div', undefined, 'role-row line-assignment-row'); const info = node('div', undefined, 'role-info');
      const name = node('strong', `${index + 1}. ${line.character}`); const caption = node('small', line.caption.length > 72 ? `${line.caption.slice(0, 69)}…` : line.caption);
      const status = node('small'); info.append(name, caption, status);
      const select = node('select'); select.setAttribute('aria-label', `Assign line ${index + 1}, ${line.character}`);
      select.addEventListener('change', () => action('assign-line', { lineId: line.id, playerId: select.value }, select).catch(() => {}));
      select.addEventListener('blur', () => { if (client.state) renderLineAssignmentRows(containerId, client.state.session); });
      element.append(info, select); container.append(element); row = { element, name, caption, status, select, rosterKey: null }; view.set(line.id, row);
    }
    if (row.rosterKey !== rosterKey && document.activeElement !== row.select) {
      row.select.replaceChildren();
      const empty = node('option', 'Unassigned'); empty.value = ''; row.select.append(empty);
      for (const player of session.players) { const option = node('option', `${player.nickname}${player.connected ? '' : ' · disconnected'}`); option.value = player.id; row.select.append(option); }
      row.rosterKey = rosterKey;
    }
    const ownerId = session.lineAssignments?.[line.id] || ''; const owner = session.players.find(player => player.id === ownerId);
    const take = session.lineTakes[line.id];
    row.status.textContent = `${owner ? `Assigned to ${owner.nickname}` : 'Unassigned'} · ${take?.status === 'accepted' ? 'accepted' : take?.status === 'recorded' ? 'needs review' : 'needs a take'}`;
    if (document.activeElement !== row.select) row.select.value = ownerId;
    row.select.disabled = !session.players.length || ['lobby', 'playback'].includes(session.state);
    row.element.classList.toggle('is-free', !owner);
  }
}
function renderPlayers(containerId, session) {
  const container = $(containerId); container.replaceChildren();
  if (!session.players.length) { container.append(node('p', 'No players yet. Share the invitation above.', 'muted')); return; }
  for (const player of session.players) {
    const row = node('article', undefined, 'player-row');
    const heading = node('div', undefined, 'player-heading');
    heading.append(node('strong', player.nickname), node('span', player.connected ? 'Connected' : 'Disconnected', player.connected ? 'presence connected' : 'presence'));
    const progress = node('progress'); progress.max = Math.max(1, player.progress.totalAssignedLines); progress.value = player.progress.completedLines;
    progress.setAttribute('aria-label', `${player.nickname}: ${player.progress.completedLines} of ${player.progress.totalAssignedLines} lines accepted`);
    const lineMode = session.settings.gameMode === 'line';
    const ready = player.ready ? 'Ready' : lineMode && player.progress.totalAssignedLines === 0 ? 'No lines assigned' : 'Waiting for READY';
    const lineNames = lineMode ? session.pack?.lines.filter(line => session.lineAssignments?.[line.id] === player.id).map(line => line.character) || [] : [];
    const characterSummary = lineMode
      ? [...new Set(lineNames)].map(character => `${character} (${lineNames.filter(name => name === character).length})`).join(', ') || 'No lines assigned'
      : player.assignedCharacters.join(', ') || 'No characters yet';
    row.append(heading, node('span', ready, player.ready ? 'ready-label' : 'muted'),
      node('span', `${player.progress.completedLines} / ${player.progress.totalAssignedLines} lines`, 'count'),
      progress, node('small', lineMode ? `Characters: ${characterSummary}` : characterSummary));
    container.append(row);
  }
}
function renderIncompleteLines(session) {
  const lines = session.pack.lines.filter(line => session.lineTakes[line.id]?.status !== 'accepted');
  const list = $('incomplete-lines'); list.replaceChildren();
  if (!lines.length) { list.append(node('li', 'Every line has an accepted take.')); return; }
  for (const line of lines) {
    const take = session.lineTakes[line.id];
    const status = take?.status === 'recorded' ? 'Ready for review' : 'Needs a take';
    list.append(node('li', `${line.character} · ${status} · ${line.caption}`));
  }
}
function renderTakes(session) {
  const pack = session.pack; if (!pack) return;
  const filter = $('line-filter').value;
  for (const [index, line] of pack.lines.entries()) {
    let row = takeRows.get(line.id);
    if (!row) {
      const element = node('article', undefined, 'take-row'); const description = node('div', undefined, 'take-description');
      const title = node('strong'); const status = node('small'); const caption = node('p');
      description.append(title, status, caption);
      const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.setAttribute('aria-label', `Play take for line ${index + 1}`);
      const actions = node('div', undefined, 'take-actions');
      const accept = node('button', 'Accept take', 'secondary'); const retake = node('button', 'Request retake', 'danger');
      accept.addEventListener('click', () => action('accept', { lineId: line.id }, accept).catch(() => {}));
      retake.addEventListener('click', () => action('retake', { lineId: line.id }, retake).catch(() => {}));
      actions.append(accept, retake); element.append(description, audio, actions); $('takes').append(element);
      row = { element, title, status, caption, audio, accept, retake, takeId: null }; takeRows.set(line.id, row);
    }
    const take = session.lineTakes[line.id];
    const ownerId = session.settings.gameMode === 'line' ? session.lineAssignments?.[line.id] : session.roleAssignments[line.character];
    const owner = session.players.find(player => player.id === ownerId);
    const status = take?.status || (owner?.connected ? 'missing' : 'missing');
    row.title.textContent = `${index + 1}. ${line.character}`;
    row.status.textContent = `${status} · ${owner?.nickname || 'no player assigned'} · ${line.startTime.toFixed(1)}–${line.endTime.toFixed(1)}s`;
    row.caption.textContent = line.caption;
    if (take?.id !== row.takeId) {
      row.takeId = take?.id; row.audio.pause();
      if (take) row.audio.src = take.url; else { row.audio.removeAttribute('src'); row.audio.load(); }
    }
    row.audio.hidden = !take; row.accept.hidden = take?.status !== 'recorded';
    row.accept.disabled = session.state === 'playback'; row.retake.hidden = !take;
    row.retake.disabled = session.state === 'playback';
    row.element.hidden = filter !== 'all' && (filter === 'pending' ? !!take : status !== filter);
  }
}

client.start().then(refreshPacks).catch(() => { /* Local login required for a fresh browser. */ });
