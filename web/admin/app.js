import { RuntimeClient, node, showError, setBusy } from '../shared/api.js';
import { DubPlayback } from '../playback/playback.js';

const $ = id => document.getElementById(id);
const client = new RuntimeClient('admin');
const error = problem => showError($('error'), problem);
const playback = new DubPlayback($('playback-root'), client, error);
const roleRows = new Map(); const takeRows = new Map(); let selectedPackId = null; let selectedRoomId = null;

async function action(path, body = {}, button) {
  $('error').hidden = true; if (button) button.disabled = true;
  try { return await client.request(`/api/admin/${path}`, body); }
  catch (problem) { error(problem); throw problem; }
  finally { if (client.state) render(client.state); else if (button) button.disabled = false; }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); setBusy($('login-button'), true, 'Open studio'); $('error').hidden = true;
  try {
    await client.request('/api/admin/login', { token: $('admin-token').value }); $('admin-token').value = '';
    await client.start(); await refreshPacks();
  } catch (problem) { error(problem); }
  finally { setBusy($('login-button'), false, 'Open studio'); }
});
$('refresh-packs').addEventListener('click', () => refreshPacks().catch(error));
$('copy-join').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('join-url').value); $('copy-join').textContent = 'Copied'; }
  catch { $('join-url').focus(); $('join-url').select(); $('copy-join').textContent = 'Select & copy'; }
});
$('distribute').addEventListener('click', () => action('distribute', {}, $('distribute')).catch(() => {}));
$('start-recording').addEventListener('click', () => action('start', {}, $('start-recording')).catch(() => {}));
$('stop-playback').addEventListener('click', () => action('stop-playback', {}, $('stop-playback')).catch(() => {}));
$('start-playback').addEventListener('click', async () => {
  $('start-playback').disabled = true; $('error').hidden = true;
  try { await playback.prepare(); await action('playback', { allowMissing: $('allow-missing').checked }); }
  catch (problem) { error(problem); }
  finally { if (client.state) render(client.state); }
});
$('allow-missing').addEventListener('change', () => { if (client.state) render(client.state); });
$('line-filter').addEventListener('change', () => { if (client.state) renderTakes(client.state.session); });
client.addEventListener('connection', event => { $('connection').textContent = event.detail ? 'Connected · host controls' : 'Reconnecting to local runtime'; });
client.addEventListener('state', event => render(event.detail));

async function refreshPacks() {
  $('refresh-packs').disabled = true;
  try {
    const { packs, errors = [] } = await client.request('/api/admin/packs');
    $('pack-errors').hidden = !errors.length;
    $('pack-errors').textContent = errors.map(item => typeof item === 'string' ? item : item.error || item.message || JSON.stringify(item)).join('\n');
    $('packs').replaceChildren();
    if (!packs.length) $('packs').append(node('p', 'No compatible packs found. Check the Workshop directory configured when starting the server.', 'muted'));
    for (const pack of packs) {
      const metadata = pack.metadata || pack; const row = node('div', undefined, 'pack');
      if (pack.iconUrl) { const image = node('img'); image.src = pack.iconUrl; image.alt = ''; row.append(image); }
      const body = node('div', undefined, 'pack-body');
      body.append(node('h3', metadata.title || pack.id), node('p', `${(metadata.authors || []).join(', ')} · ${metadata.language || 'Unspecified language'}`, 'muted'));
      const count = pack.lineCount ?? pack.lines?.length; const characters = pack.characterCount ?? pack.characters?.length;
      if (count !== undefined) body.append(node('p', `${count} lines${characters !== undefined ? ` · ${characters} characters` : ''}`, 'help'));
      const select = node('button', 'Select pack', 'secondary');
      select.addEventListener('click', async () => {
        if (client.state?.session.pack && !window.confirm('Selecting a pack creates a new room and discards current players, assignments, and saved recordings. Continue?')) return;
        try { await action('select', { packId: pack.id }, select); await refreshPacks(); } catch {}
      });
      row.append(body, select); $('packs').append(row);
    }
  } finally { $('refresh-packs').disabled = false; }
}

function render(snapshot) {
  if (snapshot.viewer.kind !== 'admin') return;
  const session = snapshot.session; const pack = session.pack;
  $('login-panel').hidden = true; $('admin-panel').hidden = false; $('session-panel').hidden = !pack;
  if (!pack) { playback.setState(snapshot); return; }
  if (selectedPackId !== pack.id || selectedRoomId !== session.id) {
    selectedPackId = pack.id; selectedRoomId = session.id; roleRows.clear(); takeRows.clear(); $('roles').replaceChildren(); $('takes').replaceChildren();
    $('allow-missing').checked = false;
  }
  $('selected-title').textContent = pack.metadata.title;
  $('selected-metadata').textContent = `${pack.metadata.authors.join(', ')} · ${pack.metadata.language} · ${pack.lines.length} lines`;
  $('phase').textContent = session.state;
  const invitation = `${location.origin}/join/${encodeURIComponent(session.id)}#token=${encodeURIComponent(session.joinToken)}`;
  if ($('join-url').value !== invitation) { $('join-url').value = invitation; $('copy-join').textContent = 'Copy invitation'; }
  $('completion').textContent = `${session.completedLineCount} / ${session.totalLineCount} accepted`;
  $('distribute').disabled = !session.players.length || session.state === 'playback';
  $('start-recording').disabled = !['lobby', 'assignment'].includes(session.state) || !session.players.length || pack.characters.some(character => !session.roleAssignments[character]);
  $('start-playback').disabled = session.state === 'playback' || !['recording', 'review'].includes(session.state) || (! $('allow-missing').checked && session.completedLineCount < session.totalLineCount);
  $('stop-playback').disabled = session.state !== 'playback';
  renderRoles(session); renderPlayers(session); renderTakes(session); playback.setState(snapshot);
}

function renderRoles(session) {
  const nextRosterKey = JSON.stringify(session.players.map(player => [player.id, player.nickname, player.connected]));
  for (const [index, character] of session.pack.characters.entries()) {
    let row = roleRows.get(character);
    if (!row) {
      const element = node('div', undefined, 'role-row'); const label = node('label', character); const select = node('select');
      select.id = `character-${index}`; label.htmlFor = select.id;
      select.addEventListener('change', () => action('assign', { character, playerId: select.value }, select).catch(() => {}));
      select.addEventListener('blur', () => { if (client.state) renderRoles(client.state.session); });
      element.append(label, select); $('roles').append(element); row = { element, select, optionsKey: null }; roleRows.set(character, row);
    }
    const select = row.select;
    // Keep the same select node so presence updates cannot steal keyboard focus.
    if (row.optionsKey !== nextRosterKey && document.activeElement !== select) {
      select.replaceChildren(); const empty = node('option', 'Unassigned'); empty.value = ''; empty.disabled = true; select.append(empty);
      for (const player of session.players) { const option = node('option', `${player.nickname}${player.connected ? '' : ' (disconnected)'}`); option.value = player.id; select.append(option); }
      row.optionsKey = nextRosterKey;
    }
    if (document.activeElement !== select || row.optionsKey === nextRosterKey) select.value = session.roleAssignments[character] || '';
    select.disabled = session.state === 'playback';
  }
}
function renderPlayers(session) {
  $('players').replaceChildren();
  if (!session.players.length) $('players').append(node('p', 'No players yet. Share the invitation above.', 'muted'));
  for (const player of session.players) {
    const row = node('div', undefined, 'player-row'); const progress = node('progress');
    progress.max = Math.max(1, player.progress.totalAssignedLines); progress.value = player.progress.completedLines;
    progress.setAttribute('aria-label', `${player.nickname} accepted lines`);
    row.append(node('strong', `${player.nickname}${player.connected ? '' : ' · disconnected'}`),
      node('span', `${player.progress.completedLines} / ${player.progress.totalAssignedLines}${player.progress.totalAssignedLines && !player.progress.pendingLines ? ' · done' : ''}`, 'count'),
      progress, node('small', player.assignedCharacters.join(', ') || 'No assigned characters'));
    $('players').append(row);
  }
}
function renderTakes(session) {
  const filter = $('line-filter').value;
  for (const [index, line] of session.pack.lines.entries()) {
    let row = takeRows.get(line.id);
    if (!row) {
      const element = node('div', undefined, 'take-row'); const description = node('div', undefined, 'take-description');
      const title = node('strong'); const status = node('small'); description.append(title, status);
      const audio = node('audio'); audio.controls = true; audio.preload = 'none'; audio.setAttribute('aria-label', `Take for line ${index + 1}`);
      const accept = node('button', 'Accept', 'secondary'); const retake = node('button', 'Request retake', 'danger');
      accept.addEventListener('click', () => action('accept', { lineId: line.id }, accept).catch(() => {}));
      retake.addEventListener('click', () => action('retake', { lineId: line.id }, retake).catch(() => {}));
      element.append(description, audio, accept, retake); $('takes').append(element);
      row = { element, title, status, audio, accept, retake, takeId: null }; takeRows.set(line.id, row);
    }
    const take = session.lineTakes[line.id]; const owner = session.players.find(player => player.id === session.roleAssignments[line.character]);
    const status = take?.status || (owner?.connected ? 'pending' : 'missing');
    row.title.textContent = `${index + 1}. ${line.character}`;
    row.status.textContent = `${line.startTime.toFixed(3)}–${line.endTime.toFixed(3)}s · ${status} · ${owner?.nickname || 'unassigned'}`;
    row.element.title = line.caption;
    if (take?.id !== row.takeId) {
      row.takeId = take?.id; row.audio.pause();
      if (take) row.audio.src = take.url; else { row.audio.removeAttribute('src'); row.audio.load(); }
    }
    row.audio.hidden = !take;
    row.accept.hidden = take?.status !== 'recorded'; row.accept.disabled = session.state === 'playback';
    row.retake.hidden = !take; row.retake.disabled = session.state === 'playback';
    row.element.hidden = filter !== 'all' && (filter === 'pending' ? !!take : status !== filter);
  }
}

client.start().then(refreshPacks).catch(() => { /* Local login required for a fresh browser. */ });
