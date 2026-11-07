import { RuntimeClient, node, setBusy } from '../shared/api.js';
import { DubPlayback } from '../playback/playback.js';
import { filterPacks } from './pack-filters.js';
import { PendingButtons } from './pending-buttons.js';
import { currentStage, maxViewableStage, reconcileStage } from './stage.js';
import { renderPlayerChip } from '../shared/identity.js';
import { initLibrary } from './library.js';
import { colorHex } from '../shared/identity-data.js';
import { initCards, describeCard, cardKindLabel } from './cards.js';
import { createClipGrid, voterNodes, votersKey } from './clips.js';
import { clipOrder, requestSummary } from '../shared/clips.js';

const $ = id => document.getElementById(id);
const client = new RuntimeClient('admin');
function error(problem) {
  $('error-message').textContent = problem?.message || String(problem);
  $('error').hidden = false;
}
function clearError() { $('error').hidden = true; }
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
let selectedRoomId = null; let selectedMatchId = null; let activePackList = [];
let viewedStage = null; let previousProgressStage = null; let renderedPackListKey = null;
let copyResetTimer = null;

const DEAL_LABELS = { line: ['Deal lines', 'Deal again'], duet: ['Pair players', 'Pair again'], relay: ['Build relay', 'Build again'] };
const DEAL_HELP = {
  line: 'Deal shuffles every line among the players connected right now. Adjust individual lines afterwards if needed.',
  duet: 'Pairing gives every character two of the players connected right now; that character\'s lines alternate between them. Adjust single lines afterwards if needed.',
  relay: 'Building the relay hands each character from player to player every few lines, among the players connected right now. Adjust single lines afterwards if needed.',
};
const MODE_HELP = {
  character: 'Each character belongs to one player, who records all of that character\'s lines.',
  line: 'Every line is dealt to a player on its own, so one character can have several voices. Players with no lines simply wait.',
  duet: 'Every character gets two players, and that character\'s lines alternate between them. Best with at least twice as many players as characters.',
  relay: 'A character\'s lines pass from player to player a few at a time, so everyone voices every character a bit.',
};
const STAGE_TITLES = ['Choose a pack', 'Set up the match', 'Assign roles', 'Recording', 'Review the takes', 'Final playback'];
const PHASE_LABELS = { lobby: 'Setting up', assignment: 'Choosing roles', recording: 'Recording', paused: 'Paused', review: 'Reviewing', reveal: 'Revealing', playback: 'Playing' };
const ASSIGNMENT_CONTAINERS = ['roles', 'recording-roles', 'line-assignments', 'recording-line-assignments', 'review-line-assignments'];
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const lineNumber = (pack, lineId) => pack.lines.findIndex(line => line.id === lineId) + 1;

// The Library and Cards menus replace the studio while they are open; every render keeps it that way.
const menuOpen = () => ['library-toggle', 'cards-toggle'].some(id => $(id).getAttribute('aria-expanded') === 'true');
function render(snapshot) { renderAdmin(snapshot); }
function rerender() { if (client.state) render(client.state); }
function beginPending(button, label = 'Working…') {
  return pendingButtons.begin(button, label);
}
function endPending(button) {
  pendingButtons.finish(button, rerender);
}
function showLogin() { $('admin-panel').hidden = true; $('login-panel').hidden = false; $('library-toggle').hidden = true; $('cards-toggle').hidden = true; }
// `key` de-duplicates repeated clicks. Per-item actions (assigning one
// character, accepting one take) use their own key so quick changes to two
// different rows are both sent.
async function action(path, body = {}, button, label, key = path) {
  if (pendingActionPaths.has(key)) return null;
  pendingActionPaths.add(key);
  if (!beginPending(button, label)) { pendingActionPaths.delete(key); return null; }
  if (path === 'select') renderPackList(true);
  clearError();
  try { return await client.request(`/api/admin/${path}`, body); }
  catch (problem) {
    // A stale form (e.g. another host action advanced the phase) must refresh
    // before offering the same now-invalid controls again.
    if (problem.status === 409 || problem.status === 403) await client.refresh().catch(() => {});
    if (problem.status === 401) showLogin();
    error(problem); throw problem;
  }
  finally { pendingActionPaths.delete(key); endPending(button); }
}
const quietly = promise => promise.catch(() => {});

// ---------------------------------------------------------------- login
$('dismiss-error').addEventListener('click', clearError);
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); setBusy($('login-button'), true, 'Open studio'); clearError();
  try {
    await publicLinkReady;
    await client.request('/api/admin/login', { token: $('admin-token').value.trim() });
    $('admin-token').value = ''; await client.start(); await refreshPacks(); startWorkshopPolling(); quietly(cards.load());
  } catch (problem) { error(problem); }
  finally { setBusy($('login-button'), false, 'Open studio'); }
});

// ---------------------------------------------------------------- workshop
let workshopPolling = null; let lastWorkshopDone = null;
async function refreshWorkshopStatus() {
  const result = await client.request('/api/admin/workshop/status');
  $('workshop-panel').hidden = !result.enabled;
  if (!result.enabled) { clearInterval(workshopPolling); workshopPolling = null; return; }
  const job = result.job;
  $('workshop-download').disabled = job?.status === 'running';
  $('workshop-download').textContent = job?.status === 'running' ? 'Downloading…' : 'Download';
  if (job?.status === 'running') $('workshop-panel').open = true;
  $('workshop-status').textContent = job ?
    (job.status === 'running' ? `Downloading Workshop item ${job.id}… This can take a few minutes.` :
      job.status === 'done' ? `Workshop item ${job.id} is installed and listed below.` :
      `Workshop item ${job.id} failed: ${job.error}`) : '';
  if (job && job.status !== 'running') {
    clearInterval(workshopPolling); workshopPolling = null;
    if (job.status === 'done' && job.finishedAt !== lastWorkshopDone) {
      lastWorkshopDone = job.finishedAt; await refreshPacks();
    }
  }
}
$('workshop-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('workshop-download'); button.disabled = true; clearError();
  try {
    await client.request('/api/admin/workshop/download', { item: $('workshop-item').value.trim() });
    await refreshWorkshopStatus();
    clearInterval(workshopPolling);
    workshopPolling = setInterval(() => refreshWorkshopStatus().catch(error), 2000);
  } catch (problem) { error(problem); button.disabled = false; }
});
function startWorkshopPolling() {
  refreshWorkshopStatus().then(() => {
    if (!workshopPolling && $('workshop-download').disabled)
      workshopPolling = setInterval(() => refreshWorkshopStatus().catch(error), 2000);
  }).catch(error);
}

// ---------------------------------------------------------------- party & navigation
$('refresh-packs').addEventListener('click', () => refreshPacks().catch(error));
$('create-party').addEventListener('click', () => quietly(action('create-party', {}, $('create-party'), 'Creating…')));
$('replace-party').addEventListener('click', () => {
  if (!window.confirm('Replace this party?\n\nThe current invitation link and every player\'s login stop working. Everyone must join again with the new link, and the current match is discarded.')) return;
  quietly(action('create-party', {}, $('replace-party'), 'Replacing…'));
});
$('change-pack').addEventListener('click', () => {
  if (client.state?.session.state !== 'lobby') return;
  viewedStage = 1; rerender(); refreshPacks().catch(error);
});
$('back-to-setup').addEventListener('click', () => { viewedStage = 2; rerender(); });
$('return-to-current').addEventListener('click', () => { viewedStage = null; rerender(); });
document.querySelector('.stage-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-stage]');
  if (!button || button.disabled) return;
  viewedStage = Number(button.dataset.stage);
  rerender();
});
$('copy-join').addEventListener('click', async () => {
  clearTimeout(copyResetTimer);
  try { await navigator.clipboard.writeText($('join-url').value); $('copy-join').textContent = 'Copied ✓'; }
  catch { $('join-url').focus(); $('join-url').select(); $('copy-join').textContent = 'Press Ctrl+C'; }
  copyResetTimer = setTimeout(() => { $('copy-join').textContent = 'Copy link'; }, 2500);
});
$('join-url').addEventListener('focus', () => $('join-url').select());

// ---------------------------------------------------------------- settings (auto-saved)
const CARD_KIND_IDS = ['performance', 'effect', 'constraint'];
function readCardRules() {
  const kinds = CARD_KIND_IDS.filter(kind => $(`cards-kind-${kind}`).checked);
  return { enabled: $('cards-enabled').checked, deckId: $('cards-deck').value || null, deal: $('cards-deal').value, kinds: kinds.length ? kinds : [...CARD_KIND_IDS] };
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
    exportAccess: $('export-access').value, libraryVisibleToPlayers: $('library-visible').checked,
    rules: { mode: $('game-mode').value, takeLimit: Number($('take-limit').value || 0), allowPlayerRetakes: $('allow-retakes').checked, relayEvery: Number($('relay-every').value || 3), speed: { enabled: $('speed-enabled').checked, lineTimeLimitSec: Number($('speed-seconds').value || 10) }, mystery: $('mystery').checked, cards: readCardRules(), blind: { caption: $('blind-caption').checked, reference: $('blind-reference').checked, scene: $('blind-scene').checked, share: Number($('blind-share').value) / 100 } },
  };
}
const SETTINGS_HINT = 'Changes save automatically.';
let settingsChain = Promise.resolve(); let settingsSaving = 0; let settingsMessage = SETTINGS_HINT;
function setSettingsMessage(message) { settingsMessage = message; $('settings-status').textContent = message; }
function saveSettings() {
  const settings = readSessionSettings();
  if (!Number.isInteger(settings.rules.takeLimit) || settings.rules.takeLimit < 0 || settings.rules.takeLimit > 20) {
    setSettingsMessage('Take limit must be a whole number from 0 to 20.');
    return Promise.reject(new Error('Invalid take limit'));
  }
  if (!Number.isInteger(settings.rules.relayEvery) || settings.rules.relayEvery < 1 || settings.rules.relayEvery > 20) {
    setSettingsMessage('Relay hand-over must be a whole number of lines from 1 to 20.');
    return Promise.reject(new Error('Invalid relay hand-over'));
  }
  if (!Number.isInteger(settings.rules.speed.lineTimeLimitSec) || settings.rules.speed.lineTimeLimitSec < 3 || settings.rules.speed.lineTimeLimitSec > 60) {
    setSettingsMessage('Seconds to answer must be a whole number from 3 to 60.');
    return Promise.reject(new Error('Invalid speed limit'));
  }
  if (settings.rules.cards.enabled && !CARD_KIND_IDS.some(kind => $(`cards-kind-${kind}`).checked)) {
    setSettingsMessage('Choose at least one kind of card.');
    return Promise.reject(new Error('No card kinds'));
  }
  if (!Number.isInteger(settings.maxRolesPerPlayer) || settings.maxRolesPerPlayer < 0) {
    setSettingsMessage('Maximum roles must be a whole number (0 for no limit).');
    return Promise.reject(new Error('Invalid maximum roles'));
  }
  settingsSaving++; setSettingsMessage('Saving…'); clearError();
  const run = settingsChain.then(() => client.request('/api/admin/settings', settings)).then(
    () => { setSettingsMessage('All changes saved.'); },
    async problem => {
      setSettingsMessage('Changes were not saved.');
      if (problem.status === 401) showLogin();
      if (problem.status === 409) await client.refresh().catch(() => {});
      error(problem); throw problem;
    }).finally(() => { settingsSaving--; rerender(); });
  settingsChain = run.catch(() => {});
  return run;
}
$('settings-form').addEventListener('submit', event => { event.preventDefault(); quietly(saveSettings()); });
$('multiple-roles').addEventListener('change', () => {
  if (!$('multiple-roles').checked) $('max-roles').value = '1';
  else if ($('max-roles').value === '1') $('max-roles').value = '0';
  updateMaxRoles();
});
$('blind-share').addEventListener('input', () => { $('blind-share-value').textContent = `${$('blind-share').value}%`; });
$('game-mode').addEventListener('change', () => { updateGameModeView($('game-mode').value); });
$('settings-form').addEventListener('change', () => { updateRuleDependencies(); quietly(saveSettings()); });
$('open-lobby').addEventListener('click', async () => {
  const button = $('open-lobby');
  if (!beginPending(button, 'Opening…')) return;
  try { await saveSettings(); await action('open-lobby', {}); } catch { /* error already shown */ }
  finally { endPending(button); }
});

// ---------------------------------------------------------------- roles, recording, review
$('fill-unassigned').addEventListener('click', () => quietly(action('fill-unassigned', {}, $('fill-unassigned'))));
$('recording-balance').addEventListener('click', () => quietly(action('fill-unassigned', {}, $('recording-balance'))));
$('deal-lines').addEventListener('click', () => {
  const session = client.state?.session;
  if (Object.keys(session?.lineAssignments || {}).length && !window.confirm('Build the line assignments again? The current ones are replaced and players must press READY again.')) return;
  quietly(action('deal-lines', {}, $('deal-lines'), 'Dealing…'));
});
$('lock-roles').addEventListener('click', () => quietly(action('lock-roles', {}, $('lock-roles'))));
$('unlock-roles').addEventListener('click', () => quietly(action('reopen-roles', {}, $('unlock-roles'))));
$('start-recording').addEventListener('click', () => quietly(action('start', {}, $('start-recording'), 'Starting…')));
$('pause-session').addEventListener('click', () => quietly(action('pause', {}, $('pause-session'))));
$('resume-session').addEventListener('click', () => quietly(action('resume', {}, $('resume-session'))));
$('reopen-roles').addEventListener('click', () => {
  if (!window.confirm('Go back to role selection?\n\nRecording stops for everyone and retakes in progress are cancelled. Accepted takes are kept.')) return;
  quietly(action('reopen-roles', {}, $('reopen-roles')));
});
$('continue-review').addEventListener('click', () => quietly(action('review', {}, $('continue-review'))));
$('accept-all').addEventListener('click', () => quietly(action('accept-all', {}, $('accept-all'), 'Accepting…')));
$('continue-recording').addEventListener('click', () => quietly(action('start', {}, $('continue-recording'))));
async function startSharedPlayback(allowMissing, button) {
  if (!beginPending(button, 'Starting…')) return;
  clearError();
  try {
    await playback.prepare();
    await action('playback', { allowMissing });
  } catch (problem) { error(problem); }
  finally { endPending(button); }
}
$('reveal-blind').addEventListener('click', () => quietly(action('reveal', {}, $('reveal-blind'))));
$('show-cards').addEventListener('click', () => quietly(action('cards/open', {}, $('show-cards'), 'Opening…')));
$('review-playback').addEventListener('click', () => startSharedPlayback(false, $('review-playback')));
$('skip-missing').addEventListener('click', () => {
  const session = client.state?.session; if (!session) return;
  const missing = session.totalLineCount - session.completedLineCount;
  if (!window.confirm(`Start final playback without ${plural(missing, 'line')}?\n\nOnly accepted takes are played; missing lines stay silent.`)) return;
  startSharedPlayback(true, $('skip-missing'));
});
$('restart-playback').addEventListener('click', () => quietly(action('restart-playback', {}, $('restart-playback'))));
$('stop-playback').addEventListener('click', () => quietly(action('stop-playback', {}, $('stop-playback'))));
$('line-filter').addEventListener('change', () => { if (client.state) renderClips(client.state.session); });
function nextMatch(button) {
  if (!window.confirm('Start the next match?\n\nThis match is saved in the library, so you can replay and export it later. Players stay in the party.')) return;
  quietly(action('next-match', {}, button));
}
$('next-match-review').addEventListener('click', () => nextMatch($('next-match-review')));
$('next-match-playback').addEventListener('click', () => nextMatch($('next-match-playback')));
// Exports are background jobs: starting one returns immediately and progress arrives in the snapshot.
async function startExport(button, format, label) {
  if (!beginPending(button, 'Starting…')) return;
  clearError();
  try {
    await client.request('/api/exports', { format, force: true });
    $('export-status').textContent = `${label} export started. You can leave this page; it keeps rendering.`;
  } catch (problem) { $('export-status').textContent = ''; error(problem); }
  finally { endPending(button); }
}
$('export-video').addEventListener('click', () => startExport($('export-video'), 'mp4', 'Video'));
$('export-audio').addEventListener('click', () => startExport($('export-audio'), 'm4a', 'Audio'));
for (const id of ['export-access', 'library-visible']) $(id).addEventListener('change', () => quietly(saveSettings()));
function renderExports(session) {
  const visible = ['review', 'playback'].includes(session.state) && !!session.pack;
  $('exports-panel').hidden = !visible;
  if (!visible) return;
  const settings = session.settings || {};
  if (document.activeElement !== $('export-access')) $('export-access').value = settings.exportAccess || 'host';
  if (document.activeElement !== $('library-visible')) $('library-visible').checked = !!settings.libraryVisibleToPlayers;
  const list = $('export-jobs'); list.replaceChildren();
  for (const job of (session.exports || []).filter(item => item.source === 'live')) {
    const row = node('li', undefined, 'export-job'); row.dataset.status = job.status;
    const label = job.format === 'mp4' ? 'Video (MP4)' : 'Audio (M4A)';
    row.append(node('span', label, 'job-label'));
    if (job.status === 'ready') { const link = node('a', 'Download', 'job-link'); link.href = job.url; link.download = job.filename; row.append(link); }
    else if (job.status === 'failed') row.append(node('span', job.error || 'Export failed', 'job-error'));
    else { const bar = node('progress'); bar.max = 1; bar.value = job.status === 'queued' ? 0 : job.progress; bar.setAttribute('aria-label', `${label} progress`); row.append(bar, node('span', job.status === 'queued' ? 'Waiting for another render' : `${Math.round(job.progress * 100)}%`, 'muted')); }
    list.append(row);
  }
}
client.addEventListener('connection', event => {
  $('connection').textContent = event.detail ? 'Connected' : 'Reconnecting…';
  $('connection').classList.toggle('is-online', !!event.detail);
  $('connection').classList.toggle('is-offline', !event.detail);
});
const library = initLibrary({ client, quietly, onError: error });
const cards = initCards({ client, quietly, onError: error, onChange: () => { fillDeckSelect(client.state?.session.rules?.cards?.deckId ?? undefined); updateRuleDependencies(); if (client.state) { cardOverviewKeys.clear(); rerender(); cards.update(); library.update(client.state); } } });
client.addEventListener('state', event => { render(event.detail); renderExports(event.detail.session); library.update(event.detail); cards.update(event.detail); });

// ---------------------------------------------------------------- pack list
const packFilterKey = 'open-dub-pack-filters';
try {
  const saved = JSON.parse(localStorage.getItem(packFilterKey) || '{}');
  $('pack-search').value = typeof saved.title === 'string' ? saved.title : '';
  $('pack-min-characters').value = Number.isInteger(saved.minimum) ? String(saved.minimum) : '';
  $('pack-max-characters').value = Number.isInteger(saved.maximum) ? String(saved.maximum) : '';
} catch { /* Filtering remains available when browser storage is disabled. */ }
function filterNumber(id) {
  const value = $(id).value;
  if (value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function savePackFilters() {
  try {
    localStorage.setItem(packFilterKey, JSON.stringify({
      title: $('pack-search').value, minimum: filterNumber('pack-min-characters'), maximum: filterNumber('pack-max-characters'),
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
function characterSummary(characters, counts) {
  return characters.map((character, index) => `${character} (${counts[index] ?? 0})`).join(' · ');
}
function renderPackList(force = false) {
  const session = client.state?.session;
  const key = JSON.stringify([session?.partyCreated, session?.state, session?.matchId, session?.pack?.id, pendingActionPaths.has('select'), activePackList.map(pack => pack.id)]);
  if (!force && key === renderedPackListKey) return;
  renderedPackListKey = key;
  const container = $('packs'); container.replaceChildren();
  const minimum = filterNumber('pack-min-characters'); const maximum = filterNumber('pack-max-characters');
  const title = $('pack-search').value;
  const filtered = filterPacks(activePackList, { title, minimum, maximum });
  $('pack-result-count').textContent = filtered.length === activePackList.length ? plural(activePackList.length, 'pack') : `Showing ${filtered.length} of ${plural(activePackList.length, 'pack')}`;
  $('clear-pack-filters').disabled = !title.trim() && minimum === null && maximum === null;
  if (!activePackList.length) {
    container.append(node('p', 'No compatible packs found. Check the Workshop directory configured on the server, then press Refresh packs.', 'muted empty-filter'));
    return;
  }
  if (!filtered.length) {
    container.append(node('p', 'No packs match these filters.', 'muted empty-filter'));
    return;
  }
  const selecting = pendingActionPaths.has('select');
  for (const pack of filtered) {
    const metadata = pack.metadata || pack; const row = node('article', undefined, 'pack');
    const isCurrent = session?.pack?.id === pack.id;
    row.classList.toggle('is-selected', isCurrent);
    if (pack.iconUrl) { const image = node('img'); image.src = pack.iconUrl; image.alt = ''; row.append(image); }
    else row.append(node('div', 'OD', 'pack-icon'));
    const body = node('div', undefined, 'pack-body');
    const heading = node('h3', metadata.title || pack.id);
    if (isCurrent) heading.append(node('span', 'Selected', 'badge badge-accepted'));
    body.append(heading);
    const characterCount = pack.characterCount ?? pack.characters?.length ?? 0;
    const counts = pack.characters.map((character, index) => pack.characterLineCounts?.[index] ?? 0);
    body.append(node('p', `${(metadata.authors || []).join(', ') || 'Unknown authors'} · ${plural(pack.lineCount ?? 0, 'line')} · ${plural(characterCount, 'character')}`, 'muted'));
    body.append(node('p', characterSummary(pack.characters, counts), 'help'));
    const select = node('button', selecting ? 'Selecting…' : isCurrent ? 'Open setup' : 'Use this pack');
    select.type = 'button';
    if (isCurrent) select.className = 'secondary';
    select.disabled = session?.state !== 'lobby' || selecting || !session?.partyCreated;
    select.addEventListener('click', async () => {
      if (client.state?.session.pack?.id === pack.id) { viewedStage = 2; rerender(); return; }
      try {
        await action('select', { packId: pack.id }, select, 'Selecting…');
        viewedStage = 2; rerender();
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
    $('pack-errors').replaceChildren();
    if (errors.length) {
      $('pack-errors').append(node('strong', `${plural(errors.length, 'pack')} could not be loaded:`));
      const list = node('ul');
      for (const item of errors) list.append(node('li', typeof item === 'string' ? item : [item.pack || item.directory, item.error || item.message].filter(Boolean).join(': ') || JSON.stringify(item)));
      $('pack-errors').append(list);
    }
    renderPackList(true);
  } finally { button.disabled = false; }
}

// ---------------------------------------------------------------- render
function showStage(stage, progressStage, maxStage, session) {
  const names = ['packs', 'setup', 'roles', 'recording', 'review', 'playback'];
  names.forEach((name, index) => { $(`screen-${name}`).hidden = index + 1 !== stage; });
  for (let index = 1; index <= 6; index++) {
    const item = $(`stage-indicator-${index}`);
    const button = $(`stage-button-${index}`);
    item.classList.toggle('is-current', index === stage);
    item.classList.toggle('is-complete', index < progressStage);
    item.classList.toggle('is-active', index === progressStage && index !== stage);
    button.disabled = index > maxStage || (index === 1 && session.state !== 'lobby');
    if (index === stage) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  }
  $('stage-eyebrow').textContent = `STEP ${stage} OF 6`;
  $('stage-heading').textContent = stage === 1 && !session.partyCreated ? 'Start a party' : STAGE_TITLES[stage - 1];
}
function lineOwnerId(session, line) {
  return session.settings.assignmentStyle === 'line' ? session.lineAssignments?.[line.id] : session.roleAssignments[line.character];
}
function nextStepText(session, progressStage) {
  const players = session.players; const pack = session.pack;
  if (!session.partyCreated) return 'Create a party to get an invitation link for your players.';
  if (!pack) return players.length
    ? `${plural(players.length, 'player')} joined. Choose a pack for the next match.`
    : 'Share the invitation link with your players, then choose a pack. Players can join while you choose.';
  const lineMode = session.settings.assignmentStyle === 'line';
  switch (progressStage) {
    case 2: return 'Check the match settings, then press Open role selection.';
    case 3: {
      if (!players.length) return 'Waiting for players. Share the invitation link above.';
      if (lineMode) {
        const unassigned = pack.lines.filter(line => !players.some(player => player.id === session.lineAssignments?.[line.id])).length;
        if (unassigned) return `${plural(unassigned, 'line')} still need a player. Press ${(DEAL_LABELS[session.settings.gameMode] || DEAL_LABELS.line)[0]} to share them out.`;
      } else {
        const free = pack.characters.filter(character => !session.roleAssignments[character]).length;
        if (free) return `${plural(free, 'character')} still need a player. Pick players in the list${session.settings.autoBalanceSuggestions ? ' or press Balance free roles' : ''}.`;
      }
      const participating = players.filter(player => player.progress.totalAssignedLines > 0);
      const ready = participating.filter(player => player.ready).length;
      return `Everyone has ${lineMode ? 'lines' : 'a role'}. ${ready} of ${participating.length} players are ready. Press Start recording when you're set.`;
    }
    case 4: {
      if (session.state === 'paused') return 'Recording is paused. Press Resume recording when everyone is back.';
      const stuck = players.filter(player => !player.connected && player.progress.pendingLines > 0);
      if (stuck.length) return `${stuck.map(player => player.nickname).join(', ')} ${stuck.length === 1 ? 'is' : 'are'} disconnected with unfinished lines. Wait for them or reassign their ${lineMode ? 'lines' : 'characters'}.`;
      return `Players are recording on their own screens: ${session.completedLineCount} of ${session.totalLineCount} lines done. Press Continue to review when they finish.`;
    }
    case 5: {
      const toReview = Object.values(session.lineTakes).filter(take => take.status === 'recorded').length;
      const missing = session.totalLineCount - session.completedLineCount - toReview;
      const asked = requestSummary(session.redubVotes);
      if (session.state === 'reveal' && session.cards?.guessing?.open) return 'Players are guessing each other\'s cards. Close guessing when they are done, then start the final playback.';
      if (asked.clips && !toReview) return `Players asked to redub ${plural(asked.clips, 'clip')}. They are at the top of the list. Redub the ones you agree with, or start the final playback.`;
      if (toReview) return `Listen to ${plural(toReview, 'take')} waiting for review and accept or retake them.`;
      if (missing) return `${plural(missing, 'line')} have no take yet. Continue recording, or play without them.`;
      return 'Every line is accepted. Start the final playback for everyone!';
    }
    case 6: return 'The dub is playing for everyone. Export the video, or start the next match with the same players.';
    default: return '';
  }
}
function renderAdmin(snapshot) {
  if (snapshot.viewer.kind !== 'admin') return;
  const session = snapshot.session; const pack = session.pack;
  $('login-panel').hidden = true; $('admin-panel').hidden = menuOpen();
  const partyChanged = selectedRoomId !== session.id;
  const matchChanged = selectedMatchId !== session.matchId;
  const progressStage = currentStage(session); const maxStage = maxViewableStage(session);
  viewedStage = reconcileStage(viewedStage, previousProgressStage, progressStage, partyChanged || matchChanged, maxStage);
  previousProgressStage = progressStage;
  if (partyChanged || matchChanged) {
    roleViews.clear(); takeRows.clear(); clipGrid.reset(); cardOverviewKeys.clear();
    [...ASSIGNMENT_CONTAINERS, 'takes'].forEach(id => $(id).replaceChildren());
    $('export-status').textContent = ''; settingsMessage = SETTINGS_HINT;
  }
  selectedRoomId = session.id; selectedMatchId = session.matchId;
  const stage = pack ? viewedStage ?? progressStage : 1;
  $('party-create').hidden = !!session.partyCreated;
  for (const id of ['pack-heading', 'pack-filter-controls', 'packs']) $(id).hidden = !session.partyCreated;
  // Invitations only work while players can still join; afterwards the block
  // would just push the controls the host needs down the page.
  const joinOpen = session.state === 'lobby' || (session.state === 'assignment' && !session.rolesLocked);
  $('party-invite').hidden = !session.partyCreated || !(joinOpen || stage <= 3);
  $('invite-help').textContent = joinOpen
    ? 'Players join with this link and stay in the party between matches. Microphones need an HTTPS link.'
    : 'Joining is closed while roles are locked or recording is running. It reopens for the next match.';
  $('phase').textContent = session.partyCreated ? (pack ? PHASE_LABELS[session.state] || session.state : 'Waiting for a pack') : 'No party';
  $('phase').dataset.phase = session.partyCreated ? session.state : 'none';
  if (session.partyCreated) {
    const invitationUrl = new URL(`/join/${encodeURIComponent(session.id)}`, publicLink || location.origin);
    invitationUrl.hash = `token=${encodeURIComponent(session.joinToken)}`;
    if ($('join-url').value !== invitationUrl.href) { $('join-url').value = invitationUrl.href; $('copy-join').textContent = 'Copy link'; }
    $('room-code').textContent = session.id.slice(0, 6).toUpperCase();
  }
  $('next-step-text').textContent = nextStepText(session, progressStage);
  $('return-to-current').hidden = stage === progressStage;
  $('return-to-current').textContent = `Go to step ${progressStage}`;
  if (!pack) {
    showStage(1, 1, 1, session);
    $('back-to-setup').hidden = true;
    renderPacksIfNeeded();
    renderPackList();
    playback.setState(snapshot);
    pendingButtons.apply();
    return;
  }
  showStage(stage, progressStage, maxStage, session);
  $('change-pack').hidden = session.state !== 'lobby';
  $('back-to-setup').hidden = stage !== 1;
  renderSetup(session);
  const lineMode = session.settings.assignmentStyle === 'line';
  const allAssigned = lineMode
    ? pack.lines.every(line => session.players.some(player => player.id === session.lineAssignments?.[line.id]))
    : pack.characters.every(character => session.players.some(player => player.id === session.roleAssignments[character]));
  $('character-assignment').hidden = lineMode;
  $('line-assignment').hidden = !lineMode;
  $('character-reassignment').hidden = lineMode;
  $('line-reassignment').hidden = !lineMode;
  $('review-line-reassignment').hidden = !lineMode || session.completedLineCount >= session.totalLineCount;
  renderRoles(session, lineMode, allAssigned);
  renderRecording(session, lineMode);
  renderReview(session);
  renderPlaybackScreen(session);
  playback.setState(snapshot);
  renderPackList(); pendingButtons.apply();
}
function renderPacksIfNeeded() {
  if (!activePackList.length) refreshPacks().catch(error);
}

// ---------------------------------------------------------------- setup screen
function updateGameModeView(mode) {
  const lineMode = mode !== 'character';
  $('game-mode-help').textContent = MODE_HELP[mode] || MODE_HELP.character;
  for (const id of ['setting-free-role-picking', 'setting-multiple-roles', 'setting-max-roles', 'setting-auto-balance', 'setting-lock-ready']) $(id).hidden = lineMode;
  updateRuleDependencies();
}
// Settings that only make sense together: speed forces one take and no retakes, mystery needs a line-based
// mode, per-character cards need Character mode, and card options matter only while cards are on.
function updateRuleDependencies() {
  const mode = $('game-mode').value; const editable = client.state?.session.state === 'lobby';
  $('setting-relay-every').hidden = mode !== 'relay';
  if (mode === 'character') $('mystery').checked = false;
  $('mystery').disabled = mode === 'character' || !editable;
  const perCharacter = $('cards-deal').querySelector('option[value="per-character"]');
  perCharacter.disabled = mode !== 'character';
  if (mode !== 'character' && $('cards-deal').value === 'per-character') $('cards-deal').value = 'per-player';
  const speed = $('speed-enabled').checked;
  if (speed) { $('take-limit').value = '1'; $('allow-retakes').checked = false; }
  $('take-limit').disabled = speed || !editable; $('allow-retakes').disabled = speed || !editable; $('speed-seconds').disabled = !speed || !editable;
  const cardsOn = $('cards-enabled').checked;
  for (const id of ['cards-deck', 'cards-deal', ...CARD_KIND_IDS.map(kind => `cards-kind-${kind}`)]) $(id).disabled = !cardsOn || !editable;
  const effectAllowed = cards.data.ffmpeg !== false;
  $('cards-kind-effect').disabled = $('cards-kind-effect').disabled || !effectAllowed;
  if (!effectAllowed) $('cards-kind-effect').checked = false;
}
// The deck menu in setup lists the host's decks; the saved choice stays selected.
function fillDeckSelect(chosen) {
  const select = $('cards-deck'); const decks = cards.data.decks; const wanted = chosen ?? select.value ?? '';
  const key = JSON.stringify(decks.map(deck => [deck.id, deck.name, deck.cards.length]));
  if (select.dataset.key !== key) {
    select.dataset.key = key; select.replaceChildren();
    for (const deck of decks) { const option = node('option', `${deck.name} (${deck.cards.filter(card => card.enabled).length} cards)`); option.value = deck.id; select.append(option); }
  }
  select.value = decks.some(deck => deck.id === wanted) ? wanted : decks[0]?.id ?? '';
  const chosenDeck = decks.find(deck => deck.id === select.value);
  $('cards-deck-help').textContent = chosenDeck ? (chosenDeck.cards.some(card => card.enabled) ? '' : 'This deck has no cards that can be dealt yet.') : 'Open Manage cards to create a deck.';
}
function renderSetup(session) {
  const pack = session.pack;
  $('selected-title').textContent = pack.metadata.title || 'Dub pack';
  const counts = pack.characters.map((character, index) => pack.characterLineCounts?.[index] ?? 0);
  $('selected-metadata').textContent = `${(pack.metadata.authors || []).join(', ') || 'Unknown authors'} · ${pack.metadata.language || 'Unspecified language'} · ${plural(pack.lines.length, 'line')} · ${plural(pack.characters.length, 'character')}`;
  const chips = $('selected-characters'); const chipKey = JSON.stringify([pack.id, counts]);
  if (chips.dataset.key !== chipKey) {
    chips.dataset.key = chipKey; chips.replaceChildren();
    pack.characters.forEach((character, index) => {
      const chip = node('li', character); chip.append(node('span', String(counts[index]), 'chip-count'));
      chip.title = `${character}: ${plural(counts[index], 'line')}`; chips.append(chip);
    });
  }
  const editable = session.state === 'lobby';
  // Do not overwrite the form while the host's own change is still saving.
  if (!settingsSaving) {
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
      'take-limit': session.rules?.takeLimit ?? 0,
      'blind-caption': session.rules?.blind?.caption, 'blind-reference': session.rules?.blind?.reference, 'blind-scene': session.rules?.blind?.scene,
      'blind-share': Math.round((session.rules?.blind?.share ?? 1) * 100),
      'allow-retakes': session.rules?.allowPlayerRetakes ?? true,
      'relay-every': session.rules?.relayEvery ?? 3, 'speed-enabled': session.rules?.speed?.enabled, 'speed-seconds': session.rules?.speed?.lineTimeLimitSec ?? 10,
      'mystery': session.rules?.mystery, 'cards-enabled': session.rules?.cards?.enabled, 'cards-deal': session.rules?.cards?.deal ?? 'per-player',
      'cards-kind-performance': session.rules?.cards?.kinds?.includes('performance') ?? true, 'cards-kind-effect': session.rules?.cards?.kinds?.includes('effect') ?? true, 'cards-kind-constraint': session.rules?.cards?.kinds?.includes('constraint') ?? true,
    };
    fillDeckSelect(session.rules?.cards?.deckId ?? undefined);
    for (const [id, value] of Object.entries(values)) {
      const input = $(id);
      if (document.activeElement === input) continue;
      if (id === 'game-mode' || id === 'cards-deal') input.value = value;
      else if (id === 'relay-every' || id === 'speed-seconds') input.value = String(value);
      else if (id === 'take-limit' || id === 'blind-share') { input.value = String(value); if (id === 'blind-share') $('blind-share-value').textContent = `${value}%`; }
      else if (id === 'max-roles') { input.value = String(value ?? 0); input.max = String(pack.characters.length); }
      else input.checked = !!value;
    }
  }
  $('settings-form').querySelectorAll('input,select').forEach(input => { input.disabled = !editable; });
  if (!pendingButtons.has($('open-lobby'))) $('open-lobby').disabled = !editable;
  $('settings-status').textContent = editable ? settingsMessage : 'Settings are locked once role selection opens. Change them for the next match.';
  updateGameModeView($('game-mode').value);
  updateMaxRoles();
}
function updateMaxRoles() {
  const input = $('max-roles');
  const multiple = $('multiple-roles').checked;
  if (!multiple) input.value = '1';
  input.disabled = !multiple || client.state?.session.state !== 'lobby';
}

// ---------------------------------------------------------------- roles screen
function renderRoles(session, lineMode, allAssigned) {
  const pack = session.pack;
  const free = pack.characters.filter(character => !session.roleAssignments[character]).length;
  $('role-summary').textContent = `${pack.characters.length - free} of ${pack.characters.length} characters have a player`;
  $('role-help').textContent = session.settings.freeRolePicking
    ? 'Players can claim free characters on their screens. You can also pick a player for any character here.'
    : 'Pick a player for each character. Players cannot choose roles themselves in this match.';
  $('role-player-count').textContent = `${plural(session.players.length, 'player')} · ${session.players.filter(player => player.connected).length} online`;
  if (!lineMode) {
    renderAssignmentRows('roles', session);
    renderAssignmentRows('recording-roles', session);
  } else {
    renderLineAssignmentRows('line-assignments', session);
    renderLineAssignmentRows('recording-line-assignments', session);
    renderLineAssignmentRows('review-line-assignments', session);
  }
  const lineCounts = new Map(session.players.map(player => [player.id, 0]));
  for (const ownerId of Object.values(session.lineAssignments || {})) if (lineCounts.has(ownerId)) lineCounts.set(ownerId, lineCounts.get(ownerId) + 1);
  const assignedLines = [...lineCounts.values()].reduce((sum, count) => sum + count, 0);
  $('line-assignment-summary').textContent = `${assignedLines} of ${plural(pack.lines.length, 'line')} assigned${lineCounts.size ? ` · ${[...lineCounts].map(([id, count]) => `${session.players.find(player => player.id === id)?.nickname}: ${count}`).join(' · ')}` : ''}`;
  const connected = session.players.some(player => player.connected);
  if (!pendingButtons.has($('deal-lines'))) {
    $('deal-lines').disabled = session.state !== 'assignment' || !!session.recordingStarted || !connected;
    const labels = DEAL_LABELS[session.settings.gameMode] || DEAL_LABELS.line;
    $('deal-lines').textContent = assignedLines && !session.recordingStarted ? labels[1] : labels[0];
    $('deal-help').textContent = DEAL_HELP[session.settings.gameMode] || DEAL_HELP.line;
  }
  const balanceHidden = !session.settings.autoBalanceSuggestions;
  $('fill-unassigned').hidden = $('recording-balance').hidden = balanceHidden;
  $('fill-unassigned').disabled = $('recording-balance').disabled = !session.players.length || !free;
  $('fill-unassigned').title = $('recording-balance').title = free ? 'Give unclaimed characters to the players with the fewest lines' : 'Every character already has a player';
  const inAssignment = session.state === 'assignment';
  $('lock-roles').disabled = session.rolesLocked || !allAssigned || !session.players.length;
  $('lock-roles').textContent = lineMode ? 'Lock assignments' : 'Lock roles';
  $('lock-roles').hidden = !inAssignment || session.rolesLocked;
  $('unlock-roles').textContent = lineMode ? 'Unlock assignments' : 'Unlock roles';
  $('unlock-roles').hidden = !inAssignment || !session.rolesLocked;
  $('start-recording').disabled = !session.players.length || !allAssigned || !inAssignment;
  $('start-recording').hidden = !inAssignment;
  $('roles-hint').textContent = !inAssignment ? ''
    : !session.players.length ? 'Start recording becomes available once players join.'
    : !allAssigned ? (lineMode ? 'Every line needs a player before recording can start.' : 'Every character needs a player before recording can start.')
    : session.rolesLocked ? 'Roles are locked: players cannot change them. Starting recording keeps them locked.'
    : 'Starting recording locks the roles. Players who are not ready yet can still record their lines.';
  renderPlayers('players', session);
  renderCardsOverview('cards-overview', session);
}
function fillPlayerOptions(select, session) {
  select.replaceChildren();
  const empty = node('option', '— Nobody —'); empty.value = ''; select.append(empty);
  for (const player of session.players) { const option = node('option', `● ${player.nickname}${player.connected ? '' : ' (offline)'}`); option.value = player.id; option.style.color = colorHex(player.color); select.append(option); }
}
function renderAssignmentRows(containerId, session) {
  const container = $(containerId); const pack = session.pack;
  let view = roleViews.get(containerId);
  if (!view) { view = new Map(); roleViews.set(containerId, view); }
  const rosterKey = JSON.stringify(session.players.map(player => [player.id, player.nickname, player.connected, player.color, player.marker, player.avatar]));
  for (const character of pack.characters) {
    let row = view.get(character);
    if (!row) {
      const element = node('div', undefined, 'role-row'); const info = node('div', undefined, 'role-info');
      const name = node('strong', character); const owner = node('span', undefined, 'role-owner'); const status = node('small'); info.append(name, owner, status);
      const select = node('select'); select.setAttribute('aria-label', `Player for ${character}`);
      select.addEventListener('change', () => {
        const path = select.value ? 'assign' : 'unassign';
        const body = select.value ? { character, playerId: select.value } : { character };
        quietly(action(path, body, select, undefined, `role:${character}`));
      });
      select.addEventListener('blur', () => { if (client.state) renderAssignmentRows(containerId, client.state.session); });
      element.append(info, select); container.append(element); row = { element, name, owner: owner, status, select, rosterKey: null, ownerKey: null }; view.set(character, row);
    }
    if (row.rosterKey !== rosterKey && document.activeElement !== row.select) { fillPlayerOptions(row.select, session); row.rosterKey = rosterKey; }
    const ownerId = session.roleAssignments[character]; const owner = session.players.find(player => player.id === ownerId);
    const lines = pack.lines.filter(line => line.character === character);
    const accepted = lines.filter(line => session.lineTakes[line.id]?.status === 'accepted').length;
    const progress = session.recordingStarted ? ` · ${accepted}/${lines.length} accepted` : ` · ${plural(lines.length, 'line')}`;
    const ownerKey = owner ? `${owner.id}:${owner.nickname}:${owner.color}:${owner.marker}:${owner.avatar}` : '';
    if (row.ownerKey !== ownerKey) { row.ownerKey = ownerKey; row.owner.replaceChildren(...(owner ? [renderPlayerChip(owner, { size: 20 })] : [])); }
    row.status.textContent = owner ? `${owner.connected ? 'Online' : 'Offline'}${owner.ready && session.state === 'assignment' ? ' · ready' : ''}${progress}` : `No player yet${progress}`;
    if (document.activeElement !== row.select) row.select.value = ownerId || '';
    if (!pendingButtons.has(row.select)) row.select.disabled = session.state === 'playback' || session.state === 'lobby' || !session.players.length;
    row.element.classList.toggle('is-free', !owner);
    row.element.classList.toggle('is-offline', !!owner && !owner.connected && accepted < lines.length);
  }
}
function renderLineAssignmentRows(containerId, session) {
  const container = $(containerId); const pack = session.pack;
  let view = roleViews.get(containerId);
  if (!view) { view = new Map(); roleViews.set(containerId, view); }
  const rosterKey = JSON.stringify(session.players.map(player => [player.id, player.nickname, player.connected, player.color, player.marker, player.avatar]));
  // Outside role selection only unfinished lines are worth moving.
  const onlyOpen = containerId !== 'line-assignments';
  for (const [index, line] of pack.lines.entries()) {
    let row = view.get(line.id);
    if (!row) {
      const element = node('div', undefined, 'role-row line-assignment-row'); const info = node('div', undefined, 'role-info');
      const name = node('strong', `#${index + 1} · ${line.character}`); const caption = node('small', line.caption.length > 90 ? `${line.caption.slice(0, 87)}…` : line.caption);
      caption.title = line.caption;
      const ownerChip = node('span', undefined, 'role-owner'); const status = node('small'); info.append(name, caption, ownerChip, status);
      const select = node('select'); select.setAttribute('aria-label', `Player for line ${index + 1}, ${line.character}`);
      select.addEventListener('change', () => quietly(action('assign-line', { lineId: line.id, playerId: select.value }, select, undefined, `line:${line.id}`)));
      select.addEventListener('blur', () => { if (client.state) renderLineAssignmentRows(containerId, client.state.session); });
      element.append(info, select); container.append(element); row = { element, name, caption, owner: ownerChip, status, select, rosterKey: null, ownerKey: null }; view.set(line.id, row);
    }
    if (row.rosterKey !== rosterKey && document.activeElement !== row.select) { fillPlayerOptions(row.select, session); row.rosterKey = rosterKey; }
    const ownerId = session.lineAssignments?.[line.id] || ''; const owner = session.players.find(player => player.id === ownerId);
    const take = session.lineTakes[line.id];
    const lineOwnerKey = owner ? `${owner.id}:${owner.nickname}:${owner.color}:${owner.marker}:${owner.avatar}` : '';
    if (row.ownerKey !== lineOwnerKey) { row.ownerKey = lineOwnerKey; row.owner.replaceChildren(...(owner ? [renderPlayerChip(owner, { size: 20 })] : [])); }
    row.status.textContent = `${owner ? (owner.connected ? 'Online' : 'Offline') : 'No player yet'} · ${take?.status === 'accepted' ? 'accepted' : take?.status === 'recorded' ? 'needs review' : 'no take yet'}`;
    if (document.activeElement !== row.select) row.select.value = ownerId;
    if (!pendingButtons.has(row.select)) row.select.disabled = !session.players.length || ['lobby', 'playback'].includes(session.state);
    row.element.classList.toggle('is-free', !owner);
    row.element.classList.toggle('is-blind', !!session.blindLines?.[line.id]);
    row.element.classList.toggle('is-offline', !!owner && !owner.connected && take?.status !== 'accepted');
    row.element.hidden = onlyOpen && take?.status === 'accepted';
  }
}
// ---------------------------------------------------------------- dealt cards (host overview)
const cardOverviewKeys = new Map();
function cardHolder(session, entry) {
  const wrap = node('span', undefined, 'card-holder');
  if (entry.scope === 'player') { wrap.append(renderPlayerChip(session.players.find(player => player.id === entry.target) || { nickname: 'Player' }, { size: 22 })); return wrap; }
  if (entry.scope === 'line') {
    const index = session.pack.lines.findIndex(line => line.id === entry.target);
    wrap.append(node('strong', `Line #${index + 1}`), document.createTextNode(` · ${session.pack.lines[index]?.character ?? ''}`));
    const owner = session.players.find(player => player.id === lineOwnerId(session, session.pack.lines[index] || {}));
    if (owner) wrap.append(renderPlayerChip(owner, { size: 20 }));
    return wrap;
  }
  wrap.append(node('strong', entry.target));
  const owner = session.players.find(player => player.id === session.roleAssignments[entry.target]);
  if (owner) wrap.append(renderPlayerChip(owner, { size: 20 }));
  return wrap;
}
function renderCardsOverview(containerId, session) {
  const container = $(containerId); const cards = session.cards;
  const show = !!cards?.enabled && !!session.pack && ['assignment', 'recording', 'paused', 'review', 'reveal', 'playback'].includes(session.state);
  container.hidden = !show;
  if (!show) { cardOverviewKeys.delete(containerId); container.replaceChildren(); return; }
  const key = JSON.stringify([cards, session.state, session.recordingStarted, session.players.map(player => [player.id, player.nickname, player.color, player.marker, player.avatar]), session.lineAssignments, session.roleAssignments]);
  if (cardOverviewKeys.get(containerId) === key) return;
  cardOverviewKeys.set(containerId, key); container.replaceChildren();
  const canDeal = session.state === 'assignment' && !session.recordingStarted;
  const head = node('div', undefined, 'section-heading'); const title = node('div');
  const dealtText = cards.dealt ? `${plural(cards.entries.length, 'card')} dealt ${cards.deal === 'per-line' ? 'per line' : cards.deal === 'per-character' ? 'per character' : 'per player'}. Players see only their own until the reveal.` : 'No cards dealt yet. They are dealt automatically when recording starts.';
  title.append(node('p', 'CHALLENGE CARDS', 'eyebrow'), node('h2', 'Dealt cards'), node('p', dealtText, 'muted')); head.append(title);
  if (canDeal) {
    const deal = node('button', cards.dealt ? 'Deal again' : 'Deal cards', cards.dealt ? 'secondary' : ''); deal.type = 'button';
    deal.addEventListener('click', () => { if (cards.dealt && !window.confirm('Deal every card again? The current cards are replaced.')) return; quietly(action('cards/deal', {}, deal, 'Dealing…', 'cards:deal')); });
    head.append(deal);
  }
  container.append(head);
  const list = node('div', undefined, 'card-deal-list');
  for (const entry of cards.entries) {
    const card = cards.cards[entry.cardId]; if (!card) continue;
    const row = node('article', undefined, `card-deal-row${entry.vetoed ? ' is-vetoed' : ''}`);
    const body = node('div', undefined, 'card-deal-body'); const top = node('div', undefined, 'card-item-head');
    top.append(node('strong', card.title), node('span', cardKindLabel(card.kind), `badge badge-kind-${card.kind}`));
    if (entry.vetoed) top.append(node('span', 'Vetoed', 'badge badge-missing'));
    body.append(cardHolder(session, entry), top);
    if (card.text) body.append(node('p', card.text));
    const detail = describeCard(card); if (detail) body.append(node('small', detail, 'help'));
    row.append(body);
    const actions = node('div', undefined, 'card-item-actions');
    if (canDeal) {
      const redeal = node('button', 'Re-deal', 'secondary'); redeal.type = 'button';
      redeal.addEventListener('click', () => quietly(action('cards/redeal', { key: entry.key }, redeal, 'Dealing…', `redeal:${entry.key}`)));
      actions.append(redeal);
    } else if (session.recordingStarted && card.kind !== 'performance' && session.state !== 'playback') {
      const veto = node('button', entry.vetoed ? 'Restore' : 'Veto', 'secondary'); veto.type = 'button';
      veto.title = entry.vetoed ? 'Apply this card to new takes again' : 'Stop this card shaping new takes. Accepted takes keep what they got';
      veto.addEventListener('click', () => quietly(action('cards/veto', { key: entry.key, vetoed: !entry.vetoed }, veto, 'Working…', `veto:${entry.key}`)));
      actions.append(veto);
    }
    row.append(actions); list.append(row);
  }
  container.append(list);
  const guessing = cards.guessing;
  if (guessing && session.players.length > 1) {
    const expected = session.players.length * (session.players.length - 1);
    const made = Object.values(guessing.guesses || {}).reduce((sum, targets) => sum + Object.keys(targets).length, 0);
    const box = node('div', undefined, 'card-scores');
    if (guessing.scores) {
      box.append(node('h3', 'Guessing results'));
      const table = node('ol', undefined, 'score-list');
      for (const player of [...session.players].sort((a, b) => (guessing.scores[b.id] ?? 0) - (guessing.scores[a.id] ?? 0))) {
        const item = node('li'); item.append(renderPlayerChip(player, { size: 22 }), node('strong', String(guessing.scores[player.id] ?? 0))); table.append(item);
      }
      box.append(table);
    } else box.append(node('p', `Guessing is open: ${made} of ${expected} guesses are in.`, 'muted'));
    container.append(box);
  }
}
function playerStatus(player, session, lineMode) {
  const { totalAssignedLines: total, completedLines: done } = player.progress;
  if (session.state === 'lobby' || session.state === 'assignment') {
    if (player.ready) return ['Ready', 'ready-label'];
    if (!total) return [lineMode ? 'No lines yet' : 'No role yet', 'muted'];
    return ['Not ready yet', 'muted'];
  }
  if (!total) return ['No lines', 'muted'];
  if (done >= total) return ['Finished', 'ready-label'];
  if (!player.connected) return ['Waiting to reconnect', 'warning-label'];
  return [session.state === 'paused' ? 'Paused' : 'Recording', 'muted'];
}
function renderPlayers(containerId, session) {
  const container = $(containerId); container.replaceChildren();
  if (!session.players.length) { container.append(node('p', 'No players yet. Share the invitation link.', 'muted')); return; }
  const lineMode = session.settings.assignmentStyle === 'line';
  for (const player of session.players) {
    const row = node('article', undefined, 'player-row');
    row.classList.toggle('is-offline', !player.connected);
    const heading = node('div', undefined, 'player-heading');
    heading.append(renderPlayerChip(player, { size: 28 }), node('span', player.connected ? 'Online' : 'Offline', player.connected ? 'presence connected' : 'presence'));
    const progress = node('progress'); progress.max = Math.max(1, player.progress.totalAssignedLines); progress.value = player.progress.completedLines;
    progress.setAttribute('aria-label', `${player.nickname}: ${player.progress.completedLines} of ${player.progress.totalAssignedLines} lines accepted`);
    const [statusText, statusClass] = playerStatus(player, session, lineMode);
    const lineNames = lineMode ? session.pack?.lines.filter(line => session.lineAssignments?.[line.id] === player.id).map(line => line.character) || [] : [];
    const characters = lineMode
      ? [...new Set(lineNames)].map(character => `${character} (${lineNames.filter(name => name === character).length})`).join(', ')
      : player.assignedCharacters.join(', ');
    row.append(heading, node('span', statusText, statusClass),
      node('span', `${player.progress.completedLines}/${player.progress.totalAssignedLines} lines`, 'count'),
      progress, node('small', characters ? `${lineMode ? 'Lines for' : 'Plays'}: ${characters}` : (lineMode ? 'No lines assigned' : 'No characters yet')));
    container.append(row);
  }
}

// ---------------------------------------------------------------- recording screen
function renderRecording(session, lineMode) {
  const pack = session.pack; const paused = session.state === 'paused';
  $('completion').textContent = `${session.completedLineCount} of ${plural(session.totalLineCount, 'line')} accepted`;
  $('overall-progress').max = Math.max(1, session.totalLineCount); $('overall-progress').value = session.completedLineCount;
  $('recording-state').textContent = paused ? 'Paused' : session.state === 'recording' ? 'In progress' : PHASE_LABELS[session.state] || session.state;
  $('recording-title').textContent = paused ? 'Recording is paused' : session.state === 'recording' ? 'Players are recording' : 'Recording progress';
  const stuck = session.players.filter(player => !player.connected && player.progress.pendingLines > 0);
  $('recording-alert').hidden = !stuck.length || !['recording', 'paused'].includes(session.state);
  $('recording-alert').textContent = stuck.length
    ? `${stuck.map(player => `${player.nickname} (${plural(player.progress.pendingLines, 'line')} left)`).join(', ')} ${stuck.length === 1 ? 'is' : 'are'} offline. If they don't come back, reassign their ${lineMode ? 'lines' : 'characters'} below.`
    : '';
  renderPlayers('recording-players', session);
  renderCardsOverview('recording-cards', session);
  renderIncompleteLines(session);
  const activeRetakes = session.activeRetakes || [];
  $('active-retakes').hidden = !activeRetakes.length;
  $('active-retakes').textContent = activeRetakes.length ? `Waiting for ${activeRetakes.map(retake => `${retake.nickname} to finish a retake of line #${lineNumber(pack, retake.lineId)}`).join(' and ')}.` : '';
  $('pause-session').hidden = session.state !== 'recording';
  $('resume-session').hidden = !paused;
  $('reopen-roles').disabled = !['recording', 'paused', 'review'].includes(session.state);
  $('continue-review').disabled = !['recording', 'paused'].includes(session.state) || activeRetakes.length > 0;
  $('recording-hint').textContent = activeRetakes.length ? 'Continue to review becomes available when the retakes finish.'
    : ['recording', 'paused'].includes(session.state) ? 'Continue to review stops recording for everyone. You can come back with Continue recording.' : '';
}
function renderIncompleteLines(session) {
  const pack = session.pack;
  const lines = pack.lines.map((line, index) => ({ line, index })).filter(({ line }) => session.lineTakes[line.id]?.status !== 'accepted');
  $('incomplete-title').textContent = lines.length ? `Lines still in progress (${lines.length})` : 'All lines are accepted';
  const list = $('incomplete-lines'); list.replaceChildren();
  if (!lines.length) { list.append(node('li', 'Every line has an accepted take.')); return; }
  for (const { line, index } of lines) {
    const take = session.lineTakes[line.id];
    const owner = session.players.find(player => player.id === lineOwnerId(session, line));
    const item = node('li');
    item.append(node('strong', `#${index + 1} ${line.character}`), document.createTextNode(` · ${owner?.nickname || 'no player'} · ${take?.status === 'recorded' ? 'needs review' : 'no take yet'} · ${line.caption}`));
    list.append(item);
  }
}

// ---------------------------------------------------------------- review screen
const TAKE_STATUS = { accepted: ['Accepted', 'badge-accepted'], recorded: ['Needs review', 'badge-review'], pending: ['Missing', 'badge-missing'] };
function renderReview(session) {
  const takes = Object.values(session.lineTakes);
  const toReview = takes.filter(take => take.status === 'recorded').length;
  const accepted = session.completedLineCount; const missing = session.totalLineCount - accepted - toReview;
  $('review-summary').textContent = `${accepted} accepted · ${toReview} to review · ${missing} missing`;
  const filterLabels = { all: `All lines (${session.totalLineCount})`, recorded: `Needs review (${toReview})`, pending: `Missing (${missing})`, accepted: `Accepted (${accepted})` };
  for (const option of $('line-filter').options) option.textContent = filterLabels[option.value];
  const activeRetakes = session.activeRetakes || [];
  const inReview = ['review', 'reveal'].includes(session.state);
  const secret = !!session.secretsActive;
  if (!pendingButtons.has($('accept-all'))) $('accept-all').disabled = !toReview || !['recording', 'review'].includes(session.state);
  $('accept-all').hidden = !toReview;
  $('accept-all').textContent = `Accept ${toReview > 1 ? `all ${toReview} recorded takes` : 'the recorded take'}`;
  $('continue-recording').hidden = !inReview || accepted >= session.totalLineCount;
  $('reveal-blind').hidden = !secret || !['review', 'recording'].includes(session.state);
  const onlyBlind = !session.cards?.dealt && !session.rules?.mystery;
  if (!pendingButtons.has($('reveal-blind'))) $('reveal-blind').textContent = onlyBlind ? 'Reveal blind lines' : 'Reveal everything';
  const guessingOpen = session.state === 'reveal' && !!session.cards?.guessing?.open;
  $('show-cards').hidden = !guessingOpen;
  if (!pendingButtons.has($('show-cards'))) $('show-cards').disabled = !guessingOpen;
  if (!pendingButtons.has($('reveal-blind'))) $('reveal-blind').disabled = activeRetakes.length > 0 || session.state !== 'review';
  $('review-playback').disabled = accepted < session.totalLineCount || !inReview || activeRetakes.length > 0 || secret;
  $('skip-missing').hidden = !inReview || accepted >= session.totalLineCount;
  $('skip-missing').disabled = activeRetakes.length > 0 || secret;
  $('next-match-review').disabled = !inReview;
  $('next-match-review').hidden = !inReview;
  $('review-hint').textContent = ['recording', 'paused'].includes(session.state)
    ? 'Players are still recording. You can already listen to, accept, or retake uploaded takes here.'
    : secret && inReview ? 'Some things are still hidden from players. Press Reveal when you are ready; then start the final playback.'
    : guessingOpen ? 'Players are guessing each other\'s cards. Close guessing to turn the cards face up, or start the final playback, which does the same.'
    : session.state === 'reveal' ? 'Everything is revealed on the players\' screens. Start the final playback when you are ready.'
    : activeRetakes.length ? 'Waiting for a retake to finish before playback can start.'
    : toReview && !missing ? `Accept or retake ${plural(toReview, 'take')} to start the final playback.`
    : toReview || missing ? `${plural(session.totalLineCount - accepted, 'line')} without an accepted take. Accept them, continue recording, or play without them.`
    : '';
  renderClips(session);
}
async function askRetake(line, index, button) {
  const state = client.state?.session; if (!state) return;
  const owner = state.players.find(player => player.id === lineOwnerId(state, line));
  const asked = state.redubVotes?.[line.id]?.count ?? 0;
  if (!window.confirm(`Delete this take of line #${index + 1} (${line.character}) and ask ${owner?.nickname || 'its player'} to record it again?${asked ? `\n\n${plural(asked, 'player')} asked for this redub.` : ''}${state.state === 'review' ? '\n\nRecording reopens for this line.' : ''}`)) return;
  const fromStage = viewedStage ?? currentStage(state);
  try {
    await action('retake', { lineId: line.id }, button, 'Deleting…', `retake:${line.id}`);
    // A retake from Review reopens recording; keep the host on the list
    // they were working through instead of jumping to the Record screen.
    if (fromStage === 5 && client.state && maxViewableStage(client.state.session) >= 5) { viewedStage = 5; rerender(); }
  } catch {}
}
const canRetakeLine = (line, take) => !!take || !!client.state?.session.lineClocks?.[line.id];
const clipGrid = createClipGrid({
  container: $('clip-grid'),
  isPending: button => pendingButtons.has(button),
  onAccept: (line, button) => quietly(action('accept', { lineId: line.id }, button, 'Accepting…', `accept:${line.id}`)),
  onRedub: askRetake,
  onClear: (line, button) => quietly(action('clear-redub', { lineId: line.id }, button, 'Clearing…', `clear:${line.id}`)),
});
let clipView = 'grid';
try { if (localStorage.getItem('open-dub-clip-view') === 'list') clipView = 'list'; } catch { /* the grid is the default */ }
function setClipView(view) {
  clipView = view;
  try { localStorage.setItem('open-dub-clip-view', view); } catch { /* optional convenience */ }
  rerender();
}
$('view-grid').addEventListener('click', () => setClipView('grid'));
$('view-list').addEventListener('click', () => setClipView('list'));
// Both layouts show the same clips. Redub requests rank clips (most requests first) in either one.
function renderClips(session) {
  const pack = session.pack; if (!pack) return;
  const grid = clipView === 'grid';
  $('clip-grid').hidden = !grid; $('takes').hidden = grid;
  $('view-grid').setAttribute('aria-pressed', String(grid)); $('view-list').setAttribute('aria-pressed', String(!grid));
  const asked = requestSummary(session.redubVotes);
  $('redub-summary').hidden = !asked.clips;
  $('redub-summary').textContent = asked.clips ? `Players asked to redub ${plural(asked.clips, 'clip')} (${plural(asked.requests, 'request')}). The most requested clips are at the top.` : '';
  const filter = $('line-filter').value;
  const visible = grid
    ? clipGrid.render(session, { filter, ownerOf: line => session.players.find(player => player.id === lineOwnerId(session, line)), canRetake: canRetakeLine })
    : renderTakes(session, filter);
  $('takes-empty').hidden = visible > 0;
}
function renderTakes(session, filter) {
  const pack = session.pack;
  const order = clipOrder(pack.lines, session.redubVotes);
  let visible = 0;
  for (const [index, line] of pack.lines.entries()) {
    let row = takeRows.get(line.id);
    if (!row) {
      const element = node('article', undefined, 'take-row'); const description = node('div', undefined, 'take-description');
      const titleRow = node('div', undefined, 'take-title'); const title = node('strong'); const badge = node('span', '', 'badge');
      titleRow.append(title, badge);
      const status = node('small'); const caption = node('p');
      const requests = node('div', undefined, 'clip-requests'); const requestLabel = node('span', undefined, 'clip-request-count'); const voters = node('span', undefined, 'clip-voters'); requests.append(requestLabel, voters);
      description.append(titleRow, status, caption, requests);
      const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.setAttribute('aria-label', `Play take for line ${index + 1}`);
      const placeholder = node('span', 'No take yet', 'take-placeholder');
      const actions = node('div', undefined, 'take-actions');
      const accept = node('button', 'Accept'); accept.type = 'button';
      const retake = node('button', 'Redub', 'secondary'); retake.type = 'button';
      const clear = node('button', 'Dismiss requests', 'link-button'); clear.type = 'button';
      accept.addEventListener('click', () => quietly(action('accept', { lineId: line.id }, accept, 'Accepting…', `accept:${line.id}`)));
      retake.addEventListener('click', () => askRetake(line, index, retake));
      clear.addEventListener('click', () => quietly(action('clear-redub', { lineId: line.id }, clear, 'Clearing…', `clear:${line.id}`)));
      actions.append(accept, retake, clear); element.append(description, audio, placeholder, actions); $('takes').append(element);
      row = { element, title, badge, status, caption, audio, placeholder, accept, retake, clear, requests, requestLabel, voters, votersKey: null, takeId: null }; takeRows.set(line.id, row);
    }
    const take = session.lineTakes[line.id];
    const owner = session.players.find(player => player.id === lineOwnerId(session, line));
    const status = take?.status || 'pending';
    const [label, badgeClass] = TAKE_STATUS[status] || [status, ''];
    row.title.textContent = `#${index + 1} · ${line.character}`;
    row.badge.textContent = label; row.badge.className = `badge ${badgeClass}`;
    row.status.textContent = `${owner?.nickname || 'No player assigned'} · ${line.startTime.toFixed(1)}–${line.endTime.toFixed(1)} s`;
    row.caption.textContent = line.caption || (line.captionHidden ? '???' : '');
    if (take?.id !== row.takeId) {
      row.takeId = take?.id; row.audio.pause();
      if (take) row.audio.src = take.url; else { row.audio.removeAttribute('src'); row.audio.load(); }
    }
    row.audio.hidden = !take; row.placeholder.hidden = !!take;
    row.accept.hidden = take?.status !== 'recorded';
    if (!pendingButtons.has(row.accept)) row.accept.disabled = !['recording', 'review'].includes(session.state);
    row.element.classList.toggle('is-blind', !!session.blindLines?.[line.id]);
    const votes = session.redubVotes?.[line.id]; const count = votes?.count ?? 0;
    row.requests.hidden = !count; row.requestLabel.textContent = count ? plural(count, 'redub request') : '';
    const key = votersKey(votes, session.players);
    if (row.votersKey !== key) { row.votersKey = key; row.voters.replaceChildren(...voterNodes(votes, session.players)); }
    row.clear.hidden = !count; row.element.classList.toggle('has-requests', count > 0);
    row.retake.hidden = !canRetakeLine(line, take); row.retake.textContent = take?.status === 'accepted' ? 'Redub' : 'Ask for retake';
    if (!pendingButtons.has(row.retake)) row.retake.disabled = session.state === 'playback';
    row.element.dataset.status = status;
    row.element.style.order = String(order.get(line.id));
    row.element.hidden = filter !== 'all' && status !== filter;
    if (!row.element.hidden) visible++;
  }
  return visible;
}

// ---------------------------------------------------------------- playback screen
function renderPlaybackScreen(session) {
  const skipped = session.totalLineCount - session.completedLineCount;
  $('final-summary').textContent = `${plural(session.completedLineCount, 'accepted line')}${skipped ? ` · ${skipped} skipped` : ''}`;
  for (const id of ['restart-playback', 'stop-playback', 'next-match-playback']) if (!pendingButtons.has($(id))) $(id).disabled = session.state !== 'playback';
  if (!pendingButtons.has($('export-video'))) $('export-video').disabled = !['review', 'playback'].includes(session.state);
}

client.start().then(async () => { await refreshPacks(); startWorkshopPolling(); quietly(cards.load()); }).catch(() => { /* Login required outside approved WireGuard networks. */ });
