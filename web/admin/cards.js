import { node } from '../shared/api.js';

const $ = id => document.getElementById(id);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const KIND_LABELS = { performance: 'Performance', effect: 'Effect', constraint: 'Constraint' };
export const cardKindLabel = kind => KIND_LABELS[kind] || kind;

// One line describing what an effect or constraint card does, for lists and the host's overview.
export function describeCard(card) {
  if (card.kind === 'effect') return `Voice effect: ${card.effect?.chain ?? (card.effect ? 'applied automatically' : '')}`.trim();
  if (card.kind === 'constraint') {
    const rules = [];
    const blind = card.constraint?.blind || {};
    if (blind.caption) rules.push('hidden caption');
    if (blind.reference) rules.push('no original audio');
    if (blind.scene) rules.push('hidden scene');
    if (card.constraint?.takeLimit) rules.push(`${plural(card.constraint.takeLimit, 'take')} per line`);
    return `Rules: ${rules.join(', ')}`;
  }
  return '';
}

// The host's Cards menu: browse, add one card, batch add, and manage decks. All data lives on the
// server (<data dir>/cards/decks.json); this file ships no cards.
export function initCards({ client, quietly, onError, onChange }) {
  let data = { decks: [], limits: {}, ffmpeg: true }; let deckId = null; let open = false; let tab = 'list';
  let editingId = null; let preview = null; let batchChoice = null;
  const deck = () => data.decks.find(item => item.id === deckId) || data.decks[0] || null;

  // `inline` leaves the message to the form that asked, instead of the studio-wide banner.
  async function request(path, body, method, { inline = false } = {}) {
    try { const result = await client.request(path, body, method ? { method } : undefined); if (result.decks) apply(result); return result; }
    catch (problem) { if (problem.status !== 401 && !inline) onError(problem); throw problem; }
  }
  function apply(result) {
    data = result;
    if (!data.decks.some(item => item.id === deckId)) deckId = data.decks[0]?.id ?? null;
    render(); onChange?.(data);
  }
  async function load() { try { apply(await client.request('/api/admin/cards')); } catch (problem) { if (problem.status !== 401) onError(problem); } }

  // ---- layout
  function setOpen(next, { restoreStudio = true } = {}) {
    open = next; $('cards-panel').hidden = !open;
    $('cards-toggle').setAttribute('aria-expanded', String(open)); $('cards-toggle').textContent = open ? 'Back to studio' : 'Cards';
    if (restoreStudio) $('admin-panel').hidden = open;
    if (open) quietly(load());
  }
  function showTab(name) {
    tab = name;
    $('cards-tab-list').hidden = name !== 'list'; $('card-form').hidden = name !== 'add'; $('batch-form').hidden = name !== 'batch';
    for (const button of document.querySelectorAll('#cards-panel [data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === name));
    if (name !== 'add') cancelEdit(false);
  }
  $('cards-toggle').addEventListener('click', () => {
    if (!open && $('library-toggle').getAttribute('aria-expanded') === 'true') $('library-toggle').click();
    setOpen(!open);
  });
  $('library-toggle').addEventListener('click', () => { if (open) setOpen(false, { restoreStudio: false }); });
  $('open-cards-from-setup').addEventListener('click', () => { if (!open) setOpen(true); });
  for (const button of document.querySelectorAll('#cards-panel [data-tab]')) button.addEventListener('click', () => showTab(button.dataset.tab));

  // ---- decks
  function renderDecks() {
    const select = $('deck-select'); select.replaceChildren();
    for (const item of data.decks) { const option = node('option', `${item.name} (${item.cards.length})`); option.value = item.id; select.append(option); }
    select.value = deck()?.id ?? '';
    $('deck-delete').disabled = data.decks.length < 2;
    $('cards-ffmpeg').hidden = data.ffmpeg !== false;
    $('card-kind').querySelector('option[value="effect"]').disabled = data.ffmpeg === false;
    const target = $('batch-target'); target.replaceChildren();
    for (const item of data.decks) { const option = node('option', item.name); option.value = item.id; target.append(option); }
    const fresh = node('option', 'A new deck…'); fresh.value = '__new__'; target.append(fresh);
    target.value = batchChoice && [...target.options].some(option => option.value === batchChoice) ? batchChoice : deck()?.id ?? '__new__';
    $('batch-new-wrap').hidden = target.value !== '__new__';
  }
  $('deck-select').addEventListener('change', () => { deckId = $('deck-select').value; render(); onChange?.(data); });
  $('deck-new').addEventListener('click', async () => {
    const name = window.prompt('Name for the new deck?'); if (!name?.trim()) return;
    const before = new Set(data.decks.map(item => item.id));
    await quietly(request('/api/admin/decks', { name: name.trim() }));
    deckId = data.decks.find(item => !before.has(item.id))?.id ?? deckId; render(); onChange?.(data);
  });
  $('deck-rename').addEventListener('click', async () => {
    const current = deck(); if (!current) return;
    const name = window.prompt('Rename this deck to:', current.name); if (!name?.trim() || name.trim() === current.name) return;
    await quietly(request(`/api/admin/decks/${encodeURIComponent(current.id)}`, { name: name.trim() }, 'PATCH'));
  });
  $('deck-delete').addEventListener('click', async () => {
    const current = deck(); if (!current || data.decks.length < 2) return;
    if (!window.confirm(`Delete the deck “${current.name}” and its ${plural(current.cards.length, 'card')}?\n\nThis cannot be undone. Export it first if you may want it back.`)) return;
    await quietly(request(`/api/admin/decks/${encodeURIComponent(current.id)}`, undefined, 'DELETE'));
  });
  $('deck-export').addEventListener('click', async () => {
    const current = deck(); if (!current) return;
    try {
      const exported = await client.request(`/api/admin/decks/${encodeURIComponent(current.id)}/export`);
      const link = node('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
      link.download = `open-dub-deck-${current.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'deck'}.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    } catch (problem) { onError(problem); }
  });

  // ---- card list
  function renderList() {
    const current = deck(); const list = $('card-list'); list.replaceChildren();
    const search = $('card-search').value.trim().toLowerCase(); const kind = $('card-kind-filter').value;
    const cards = (current?.cards || []).filter(card => (!kind || card.kind === kind) && (!search || `${card.title} ${card.text}`.toLowerCase().includes(search)));
    $('cards-count').textContent = String(current?.cards.length ?? 0);
    $('card-list-empty').hidden = cards.length > 0;
    $('card-list-empty').textContent = !current?.cards.length ? 'This deck has no cards yet. Use “Add one card” or “Batch add”.' : 'No cards match this search.';
    for (const card of cards) {
      const item = node('article', undefined, `card-item${card.enabled ? '' : ' is-disabled'}`);
      const body = node('div', undefined, 'card-item-body');
      const head = node('div', undefined, 'card-item-head');
      head.append(node('strong', card.title), node('span', cardKindLabel(card.kind), `badge badge-kind-${card.kind}`));
      if (card.weight > 1) head.append(node('span', `×${card.weight}`, 'chip-count'));
      if (!card.enabled) head.append(node('span', 'Off', 'badge badge-missing'));
      body.append(head);
      if (card.text) body.append(node('p', card.text));
      const detail = describeCard(card); if (detail) body.append(node('small', detail, 'help'));
      const actions = node('div', undefined, 'card-item-actions');
      const edit = node('button', 'Edit', 'secondary'); edit.type = 'button'; edit.addEventListener('click', () => startEdit(card));
      const toggle = node('button', card.enabled ? 'Turn off' : 'Turn on', 'secondary'); toggle.type = 'button';
      toggle.addEventListener('click', () => quietly(request(`/api/admin/cards/${encodeURIComponent(card.id)}`, { card: { enabled: !card.enabled } }, 'PATCH')));
      const remove = node('button', 'Delete', 'danger'); remove.type = 'button';
      remove.addEventListener('click', () => { if (window.confirm(`Delete the card “${card.title}”?`)) quietly(request(`/api/admin/cards/${encodeURIComponent(card.id)}`, undefined, 'DELETE')); });
      actions.append(edit, toggle, remove); item.append(body, actions); list.append(item);
    }
  }
  $('card-search').addEventListener('input', renderList);
  $('card-kind-filter').addEventListener('change', renderList);

  // ---- add or edit one card
  function updateKindFields() {
    const kind = $('card-kind').value;
    $('card-effect-fields').hidden = kind !== 'effect'; $('card-constraint-fields').hidden = kind !== 'constraint';
  }
  $('card-kind').addEventListener('change', updateKindFields);
  function readCard() {
    const kind = $('card-kind').value;
    const card = { title: $('card-title').value, text: $('card-text').value, kind, weight: Number($('card-weight').value || 1), enabled: $('card-enabled').checked, effect: null, constraint: null };
    if (kind === 'effect') card.effect = { chain: $('card-chain').value };
    if (kind === 'constraint') {
      const takes = Number($('card-c-takes').value || 0);
      card.constraint = { blind: { caption: $('card-c-caption').checked, reference: $('card-c-reference').checked, scene: $('card-c-scene').checked }, takeLimit: takes > 0 ? takes : null };
    }
    return card;
  }
  function fillForm(card) {
    $('card-title').value = card?.title ?? ''; $('card-text').value = card?.text ?? ''; $('card-kind').value = card?.kind ?? 'performance';
    $('card-weight').value = String(card?.weight ?? 1); $('card-enabled').checked = card?.enabled ?? true;
    $('card-chain').value = card?.effect?.chain ?? '';
    const blind = card?.constraint?.blind || {};
    $('card-c-caption').checked = !!blind.caption; $('card-c-reference').checked = !!blind.reference; $('card-c-scene').checked = !!blind.scene;
    $('card-c-takes').value = String(card?.constraint?.takeLimit ?? 0);
    updateKindFields();
  }
  function startEdit(card) {
    fillForm(card); showTab('add'); editingId = card.id;
    $('card-form-title').textContent = 'Edit card'; $('card-save').textContent = 'Save changes'; $('card-cancel').hidden = false; $('card-title').focus();
  }
  function cancelEdit(reset = true) {
    if (editingId === null && !reset) return;
    editingId = null; $('card-form-title').textContent = 'Add a card'; $('card-save').textContent = 'Add card'; $('card-cancel').hidden = true;
    if (reset) fillForm(null);
  }
  $('card-cancel').addEventListener('click', () => { cancelEdit(); showTab('list'); });
  $('card-form').addEventListener('submit', async event => {
    event.preventDefault();
    const current = deck(); if (!current) return;
    const status = $('card-form-status'); const button = $('card-save'); button.disabled = true; status.textContent = 'Saving…';
    try {
      if (editingId) { await request(`/api/admin/cards/${encodeURIComponent(editingId)}`, { card: readCard() }, 'PATCH', { inline: true }); status.textContent = ''; cancelEdit(); showTab('list'); }
      else { await request('/api/admin/cards', { deckId: current.id, card: readCard() }, undefined, { inline: true }); status.textContent = `Added “${$('card-title').value.trim()}”. Add another, or open the Cards tab.`; fillForm(null); $('card-title').focus(); }
    } catch (problem) { status.textContent = problem.message || 'The card was not saved.'; }
    finally { button.disabled = false; }
  });

  // ---- batch add
  const batchBody = extra => {
    const target = $('batch-target').value;
    return { format: $('batch-format').value, content: $('batch-content').value, ...(target === '__new__' ? { newDeckName: $('batch-new-name').value.trim() || 'Imported cards' } : { deckId: target }), ...extra };
  };
  function invalidatePreview() { preview = null; $('batch-preview-box').hidden = true; $('batch-status').textContent = ''; }
  for (const id of ['batch-format', 'batch-content', 'batch-target', 'batch-new-name']) $(id).addEventListener('input', invalidatePreview);
  $('batch-target').addEventListener('change', () => { batchChoice = $('batch-target').value; $('batch-new-wrap').hidden = batchChoice !== '__new__'; });
  $('batch-format').addEventListener('change', () => {
    $('batch-content').placeholder = $('batch-format').value === 'json'
      ? '[\n  { "title": "Whisper everything", "text": "Say every line in a whisper" },\n  { "title": "Robot", "kind": "effect", "effect": { "chain": "-af acrusher=bits=6:mix=0.8" } }\n]'
      : 'Whisper everything | Say every line in a whisper\nYou are a pirate | Arr! Pirate accent, all the way';
  });
  $('batch-file').addEventListener('change', async () => {
    const file = $('batch-file').files[0]; if (!file) return;
    if (file.size > 400_000) { $('batch-status').textContent = 'That file is too large for one import (400 KB).'; return; }
    $('batch-content').value = await file.text(); $('batch-format').value = /\.json$/i.test(file.name) ? 'json' : 'text';
    $('batch-file').value = ''; invalidatePreview();
  });
  $('batch-preview').addEventListener('click', async () => {
    const button = $('batch-preview'); button.disabled = true; $('batch-status').textContent = 'Checking…';
    try {
      const result = await client.request('/api/admin/cards/batch', batchBody({ dryRun: true }));
      preview = result; $('batch-status').textContent = '';
      $('batch-preview-box').hidden = false;
      $('batch-summary').textContent = result.invalid
        ? `${plural(result.valid, 'card')} ready, ${plural(result.invalid, 'row')} rejected. Nothing is saved yet.`
        : `All ${plural(result.valid, 'card')} look good. Nothing is saved yet.`;
      const rows = $('batch-rows'); rows.replaceChildren();
      for (const row of result.rows) {
        const item = node('li', undefined, row.ok ? 'is-valid' : 'is-invalid');
        item.append(node('span', row.ok ? '✓' : '✗', 'batch-mark'));
        const text = node('span'); text.append(node('strong', row.title || `Row ${row.index + 1}`));
        if (row.ok) text.append(document.createTextNode(` · ${cardKindLabel(row.kind)}${row.text ? ` · ${row.text.length > 80 ? `${row.text.slice(0, 77)}…` : row.text}` : ''}`));
        else text.append(node('small', `Row ${row.index + 1}: ${row.error}`, 'batch-error'));
        item.append(text); rows.append(item);
      }
      $('batch-import').disabled = !result.valid;
      $('batch-import').textContent = result.invalid ? `Import the ${plural(result.valid, 'valid card')} (skip ${result.invalid})` : `Import ${plural(result.valid, 'card')}`;
    } catch (problem) { invalidatePreview(); $('batch-status').textContent = problem.message || 'Could not read these cards.'; }
    finally { button.disabled = false; }
  });
  $('batch-import').addEventListener('click', async () => {
    if (!preview?.valid) return;
    const button = $('batch-import'); button.disabled = true; $('batch-status').textContent = 'Importing…';
    try {
      const result = await request('/api/admin/cards/batch', batchBody({ skipInvalid: preview.invalid > 0 }), undefined, { inline: true });
      $('batch-content').value = ''; invalidatePreview(); $('batch-status').textContent = `Imported ${plural(result.imported, 'card')}.`;
      showTab('list');
    } catch (problem) { $('batch-status').textContent = problem.message || 'Nothing was imported.'; button.disabled = false; }
  });

  function render() { renderDecks(); renderList(); }
  fillForm(null); render();
  return {
    load,
    get data() { return data; },
    get isOpen() { return open; },
    // Called on every snapshot: the studio is revealed by every render, so keep it hidden while this menu is open.
    update() { $('cards-toggle').hidden = false; if (open) $('admin-panel').hidden = true; },
  };
}
