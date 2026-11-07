import { node } from '../shared/api.js';
import { renderAvatar } from '../shared/identity.js';
import { DubPlayback } from '../playback/playback.js';

const $ = id => document.getElementById(id);
const when = ms => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export const clock = seconds => { const total = Math.max(0, Math.round(seconds)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
const megabytes = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`;

// Pure filter used by the grid (and tested): pack id, player id, starred-only.
export function filterEntries(entries, { pack = '', player = '', starred = false } = {}) {
  return entries.filter(entry => {
    if (entry.damaged) return !pack && !player && !starred;
    if (pack && entry.pack.id !== pack) return false;
    if (player && !entry.players.some(item => item.id === player)) return false;
    if (starred && !entry.starred) return false;
    return true;
  });
}

// Builds the session-shaped object DubPlayback expects from a saved entry, so replay
// reuses the live final-playback code instead of a second player.
export function replaySession(entry) {
  const lineTakes = {};
  for (const line of entry.lines) {
    if (!line.take) continue;
    lineTakes[line.id] = { id: line.take.srcId, status: 'accepted', url: line.take.url, leadIn: line.take.leadIn, tail: line.take.tail, character: line.character, recorder: line.take.recorder };
  }
  return {
    id: 'library:' + entry.id, matchId: 'library:' + entry.id, state: 'review', playback: null, lineTakes,
    pack: { id: entry.pack.id, videoUrl: entry.replay.videoUrl, backingTrackUrl: entry.replay.backingTrackUrl, lines: entry.lines.map(line => ({ id: line.id, character: line.character, startTime: line.startTime, endTime: line.endTime, duration: line.endTime - line.startTime })) },
  };
}

export function initLibrary({ client, quietly, onError }) {
  let entries = []; let open = false; let enabled = true; let replay = null; let lastKey = '';
  const status = text => { $('library-status').textContent = text; };
  const jobsFor = id => (client.state?.session.exports || []).filter(job => job.entryId === id);

  async function load() {
    try { ({ entries } = await client.request('/api/library')); enabled = true; }
    catch (problem) { if (problem.status === 404) { enabled = false; $('library-toggle').hidden = true; } else onError(problem); return; }
    fillFilters(); render();
  }
  function fillFilters() {
    const keep = { pack: $('library-pack').value, player: $('library-player').value };
    const packs = new Map(); const players = new Map();
    for (const entry of entries) if (!entry.damaged) { packs.set(entry.pack.id, entry.pack.title); for (const player of entry.players) players.set(player.id, player.nickname); }
    for (const [id, label, map, all] of [['library-pack', 'pack', packs, 'All packs'], ['library-player', 'player', players, 'Everyone']]) {
      const select = $(id); select.replaceChildren(); const first = node('option', all); first.value = ''; select.append(first);
      for (const [value, text] of map) { const option = node('option', text); option.value = value; select.append(option); }
      select.value = map.has(keep[label]) ? keep[label] : '';
    }
  }
  function card(entry) {
    const element = node('article', undefined, 'library-card');
    if (entry.damaged) {
      element.classList.add('is-damaged');
      element.append(node('strong', 'Damaged entry'), node('p', entry.reason, 'muted'));
      const remove = node('button', 'Delete', 'danger'); remove.type = 'button';
      remove.addEventListener('click', () => confirmDelete(entry, 'this damaged entry'));
      element.append(remove); return element;
    }
    const thumb = node('div', undefined, 'library-thumb');
    if (entry.hasThumb) { const image = node('img'); image.src = `/library-media/${entry.id}/thumb.jpg`; image.alt = ''; image.loading = 'lazy'; image.addEventListener('error', () => image.remove()); thumb.append(image); }
    element.append(thumb);
    const title = node('h3', entry.title); const star = node('button', entry.starred ? '★' : '☆', 'icon-button secondary');
    star.type = 'button'; star.setAttribute('aria-pressed', String(entry.starred)); star.setAttribute('aria-label', entry.starred ? 'Remove star' : 'Star this dub'); star.title = 'Starred dubs are never removed to save space';
    star.addEventListener('click', () => quietly(patch(entry, { starred: !entry.starred })));
    const head = node('div', undefined, 'library-card-head'); head.append(title, star); element.append(head);
    const cast = node('div', undefined, 'library-cast'); cast.setAttribute('aria-label', 'Players');
    for (const player of entry.players.slice(0, 8)) { const avatar = renderAvatar(player, { size: 26 }); avatar.title = player.nickname; cast.append(avatar); }
    if (entry.players.length > 8) cast.append(node('span', `+${entry.players.length - 8}`, 'muted'));
    element.append(cast);
    element.append(node('p', `${entry.pack.title} · ${clock(entry.duration)} · ${entry.takeCount}/${entry.lineCount} lines${entry.incomplete ? ' · incomplete' : ''}`, 'muted'), node('p', `${when(entry.createdAt)} · ${megabytes(entry.size)}`, 'muted small'));
    const actions = node('div', undefined, 'actions library-actions');
    const button = (label, handler, className = 'secondary') => { const b = node('button', label, className); b.type = 'button'; b.addEventListener('click', handler); actions.append(b); return b; };
    button('Replay', () => quietly(startReplay(entry)), '');
    button('Export MP4', () => quietly(exportEntry(entry, 'mp4')));
    button('Export audio', () => quietly(exportEntry(entry, 'm4a')));
    const zip = node('a', 'Takes (ZIP)', 'button-link secondary'); zip.href = `/library-media/${entry.id}/takes.zip`; zip.download = ''; actions.append(zip);
    button('Rename', () => quietly(rename(entry)));
    button('Delete', () => confirmDelete(entry, `“${entry.title}”`), 'danger');
    element.append(actions);
    const jobs = jobsFor(entry.id);
    if (jobs.length) {
      const list = node('ul', undefined, 'export-jobs');
      for (const job of jobs) list.append(jobRow(job));
      element.append(list);
    }
    return element;
  }
  function render() {
    const grid = $('library-grid'); grid.replaceChildren();
    const shown = filterEntries(entries, { pack: $('library-pack').value, player: $('library-player').value, starred: $('library-starred').checked });
    if (!shown.length) grid.append(node('p', entries.length ? 'No dubs match these filters.' : 'Nothing saved yet. Finish a match and it appears here.', 'muted'));
    for (const entry of shown) grid.append(card(entry));
  }
  async function patch(entry, body) { await client.request(`/api/library/${entry.id}`, body, { method: 'PATCH' }); await load(); }
  async function rename(entry) {
    const title = window.prompt('Name this dub', entry.title);
    if (title === null || !title.trim() || title.trim() === entry.title) return;
    await patch(entry, { title: title.trim() });
  }
  function confirmDelete(entry, label) {
    if (!window.confirm(`Delete ${label}?\n\nIts takes and renders are removed from this server and cannot be recovered.`)) return;
    quietly(client.request(`/api/library/${entry.id}`, undefined, { method: 'DELETE' }).then(load));
  }
  async function exportEntry(entry, format) {
    const result = await client.request(`/api/library/${entry.id}/export`, { format });
    if (result.ready) { const link = node('a'); link.href = result.url; link.download = ''; document.body.append(link); link.click(); link.remove(); status('Export downloaded from the library.'); }
    else status('Rendering in the background. The download appears on the card when it is ready.');
    render();
  }
  async function startReplay(entry) {
    closeReplay();
    const full = await client.request(`/api/library/${entry.id}`);
    if (!full.replay.replayable) { status(full.replay.reason + '. You can still download its takes.'); return; }
    $('library-replay-title').textContent = full.title; $('library-replay').hidden = false;
    const root = $('library-replay-root'); root.replaceChildren();
    const playback = new DubPlayback(root, { serverNow: () => Date.now() }, onError);
    const session = replaySession(full);
    playback.setState({ session });
    // Preparing needs the click gesture; once audio is decoded, start a private local epoch.
    playback.prepareButton.hidden = true;
    const play = node('button', 'Play'); play.type = 'button';
    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        await playback.prepare();
        if (playback.readyKey) playback.setState({ session: { ...session, playback: { id: 'local-' + Date.now(), startsAt: Date.now() + 600 } } });
      } catch (problem) { onError(problem); }
      finally { play.disabled = false; }
    });
    playback.actions.prepend(play);
    replay = playback; $('library-replay').scrollIntoView?.({ block: 'nearest' });
  }
  function closeReplay() {
    if (replay) { replay.stop(); replay.context?.close?.(); replay = null; }
    $('library-replay').hidden = true; $('library-replay-root').replaceChildren();
  }
  function jobRow(job) {
    const row = node('li', undefined, 'export-job'); row.dataset.status = job.status;
    const label = job.format === 'mp4' ? 'Video' : 'Audio';
    row.append(node('span', label, 'job-label'));
    if (job.status === 'ready') { const link = node('a', 'Download', 'job-link'); link.href = job.url; link.download = job.filename; row.append(link); }
    else if (job.status === 'failed') row.append(node('span', job.error || 'Failed', 'job-error'));
    else { const bar = node('progress'); bar.max = 1; bar.value = job.status === 'queued' ? 0 : job.progress; bar.setAttribute('aria-label', `${label} export progress`); row.append(bar, node('span', job.status === 'queued' ? 'Waiting' : `${Math.round(job.progress * 100)}%`, 'muted')); }
    return row;
  }
  for (const id of ['library-pack', 'library-player', 'library-starred']) $(id).addEventListener('change', render);
  $('library-replay-close').addEventListener('click', closeReplay);
  $('library-toggle').addEventListener('click', () => {
    open = !open; $('library-panel').hidden = !open; $('admin-panel').hidden = open;
    $('library-toggle').setAttribute('aria-expanded', String(open)); $('library-toggle').textContent = open ? 'Back to studio' : 'Library';
    if (open) quietly(load()); else closeReplay();
  });
  return {
    // Called on every snapshot: shows the button once logged in, and refreshes when the library may have changed.
    update(snapshot) {
      const session = snapshot.session;
      if (enabled) $('library-toggle').hidden = false;
      if (open) $('admin-panel').hidden = true; // render() reveals the studio on every snapshot
      const jobs = (session.exports || []).filter(job => job.entryId);
      const key = [session.state, session.matchId, jobs.map(job => job.id + job.status).join()].join('|');
      if (open && key !== lastKey) { lastKey = key; quietly(load()); }
      else if (open && jobs.some(job => job.status === 'rendering')) render();
    },
  };
}
