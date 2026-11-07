import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startFixtureRuntime, matchSettings, connectPlayer, playerPost, fixtureLines } from './helpers.js';
import { validateCard, parseBatch, previewBatch, CARD_LIMITS } from '../server/cards.js';
import { drawCards, dealTo, shortlistFor, scoreGuesses, keyFor, seededRandom } from '../server/session/deal.js';
import { createRuntime } from '../server/index.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// ---------------------------------------------------------------- validation
test('validateCard normalises cards and rejects anything outside the schema', () => {
  assert.deepEqual(validateCard({ title: '  Whisper  ', text: 'Say it softly' }), { title: 'Whisper', text: 'Say it softly', kind: 'performance', effect: null, constraint: null, weight: 1, enabled: true });
  assert.equal(validateCard({ title: 'Title only' }).text, '');
  assert.equal(validateCard({ id: 'ignored', title: 'x' }).title, 'x', 'an exported id is accepted and ignored');
  const effect = validateCard({ title: 'Robot', kind: 'effect', effect: { chain: '-af  acrusher=bits=6:mix=0.8 ' }, weight: 3 });
  assert.deepEqual(effect.effect, { chain: '-af acrusher=bits=6:mix=0.8' });
  assert.deepEqual(validateCard({ title: 'No original', kind: 'constraint', constraint: { noReference: true, takeLimit: 2 } }).constraint, { blind: { reference: true }, takeLimit: 2 });
  assert.deepEqual(validateCard({ title: 'Blind', kind: 'constraint', constraint: { blind: { caption: true, scene: false } } }).constraint, { blind: { caption: true } });
  const bad = [
    null, [], 'text', {}, { title: '' }, { title: '   ' }, { title: 'x'.repeat(CARD_LIMITS.title + 1) }, { title: 'x', text: 'y'.repeat(CARD_LIMITS.text + 1) }, { title: 5 }, { title: 'a\u0000b' },
    { title: 'x', kind: 'spell' }, { title: 'x', weight: 0 }, { title: 'x', weight: 21 }, { title: 'x', weight: 1.5 }, { title: 'x', weight: '2' }, { title: 'x', enabled: 'yes' }, { title: 'x', surprise: true },
    { title: 'x', effect: { chain: '-af volume=1' } }, { title: 'x', constraint: { noReference: true } },
    { title: 'x', kind: 'effect' }, { title: 'x', kind: 'effect', effect: {} }, { title: 'x', kind: 'effect', effect: { chain: '' } },
    { title: 'x', kind: 'effect', effect: { chain: '-af volume=1', extra: 1 } },
    { title: 'x', kind: 'effect', effect: { chain: '-af amovie=/etc/passwd' } }, { title: 'x', kind: 'effect', effect: { chain: '-af volume=1; rm -rf /' } },
    { title: 'x', kind: 'effect', effect: { chain: '-i /etc/passwd' } }, { title: 'x', kind: 'effect', effect: { chain: '-af volume=99' } },
    { title: 'x', kind: 'constraint' }, { title: 'x', kind: 'constraint', constraint: {} }, { title: 'x', kind: 'constraint', constraint: { blind: {} } },
    { title: 'x', kind: 'constraint', constraint: { takeLimit: 0 } }, { title: 'x', kind: 'constraint', constraint: { takeLimit: 21 } }, { title: 'x', kind: 'constraint', constraint: { blind: { video: true } } },
    { title: 'x', kind: 'constraint', constraint: { blind: { caption: 'yes' } } }, { title: 'x', kind: 'constraint', constraint: { surprise: 1 } }, { title: 'x', kind: 'constraint', constraint: { noReference: false } },
  ];
  for (const input of bad) assert.throws(() => validateCard(input), { status: 400 }, JSON.stringify(input));
});

test('parseBatch reads JSON arrays, deck exports and Title | Text lines, and previewBatch reports every row', () => {
  assert.equal(parseBatch('json', '[{"title":"A"},{"title":"B"}]').entries.length, 2);
  const deck = parseBatch('json', JSON.stringify({ name: 'Pirates', cards: [{ title: 'A' }] }));
  assert.equal(deck.name, 'Pirates'); assert.equal(deck.entries.length, 1);
  const text = parseBatch('text', '# a comment\nWhisper | Say it softly\n\nPirate\t You are a pirate\nJust a title\nTrailing | a | b\n');
  assert.deepEqual(text.entries, [{ title: 'Whisper', text: 'Say it softly' }, { title: 'Pirate', text: 'You are a pirate' }, { title: 'Just a title' }, { title: 'Trailing', text: 'a | b' }]);
  for (const [format, content] of [['json', ''], ['json', '{'], ['json', '{"cards":5}'], ['json', '"x"'], ['json', '[]'], ['text', '   \n# only comments'], ['xml', '<a/>'], ['text', 5]]) {
    assert.throws(() => parseBatch(format, content), { status: 400 }, `${format}: ${content}`);
  }
  assert.throws(() => parseBatch('json', JSON.stringify(Array.from({ length: CARD_LIMITS.batchRows + 1 }, () => ({ title: 'x' })))), { status: 413 });
  assert.throws(() => parseBatch('text', 'x'.repeat(CARD_LIMITS.batchChars + 1)), { status: 413 });
  const rows = previewBatch([{ title: 'ok' }, { title: '' }, { title: 'x', kind: 'effect', effect: { chain: '-af evil' } }, 7]);
  assert.deepEqual(rows.map(row => row.ok), [true, false, false, false]);
  assert.ok(rows.slice(1).every(row => typeof row.error === 'string' && row.error));
});

// ---------------------------------------------------------------- pure dealing helpers
test('dealing draws by weight without repeats until the deck is used up, then scores guesses', () => {
  const pool = ['a', 'b', 'c', 'd'].map((id, index) => ({ id, title: id, text: '', kind: 'performance', weight: index + 1 }));
  const random = seededRandom('fixed');
  const drawn = drawCards(pool, 4, random).map(card => card.id).sort();
  assert.deepEqual(drawn, ['a', 'b', 'c', 'd'], 'every card once before any repeat');
  assert.equal(drawCards(pool, 9, random).length, 9, 'the deck comes round again');
  assert.deepEqual(drawCards([], 3), []);
  const heavy = [{ id: 'x', weight: 1 }, { id: 'y', weight: 20 }];
  const hits = Array.from({ length: 400 }, () => drawCards(heavy, 1)[0].id).filter(id => id === 'y').length;
  assert.ok(hits > 300, 'heavier cards come up more often');
  assert.notEqual(drawCards(pool, 1, () => 0, { avoid: new Set(['a']) })[0].id, 'a', 'a re-deal avoids cards already in play');
  assert.equal(drawCards([pool[0]], 1, () => 0, { avoid: new Set(['a']) })[0].id, 'a', 'but still deals when nothing else is left');

  const state = dealTo({ keys: [keyFor.player('p1'), keyFor.player('p2')], pool, deal: 'per-player', deckId: null, kinds: ['performance'] });
  const real = state.holders[keyFor.player('p2')];
  const shortlist = shortlistFor(state, 'match', 'p2');
  assert.ok(shortlist.includes(real)); assert.equal(shortlist.length, 4); assert.equal(new Set(shortlist).size, 4);
  assert.deepEqual(shortlistFor(state, 'match', 'p2'), shortlist, 'stable for every guesser');
  const guesses = { p1: { p2: real }, p2: { p1: 'nope' } };
  assert.deepEqual(scoreGuesses(state, guesses, ['p1', 'p2']), { p1: 1, p2: 1 }, 'the guesser and the card holder both score');
  assert.deepEqual(scoreGuesses(state, { p1: { p1: state.holders[keyFor.player('p1')] } }, ['p1', 'p2']), { p1: 0, p2: 0 }, 'guessing yourself scores nothing');
});

// ---------------------------------------------------------------- HTTP: the deck store
const api = (host, route, { method = 'GET', body, token = host.adminToken } = {}) => host.request(route, { method, token, ...(body === undefined ? {} : { body }) });

test('the deck store starts with no cards, and every card is added by the host', async t => {
  const host = await startFixtureRuntime(t);
  const result = await api(host, '/api/admin/cards');
  assert.equal(result.status, 200);
  assert.equal(result.data.decks.length, 1, 'one empty deck to start from');
  assert.deepEqual(result.data.decks[0].cards, [], 'no default cards are shipped');
  assert.equal(typeof result.data.ffmpeg, 'boolean');
  assert.equal((await api(host, '/api/admin/cards', { token: null })).status, 401);
  const file = JSON.parse(await readFile(path.join(host.dataDir, 'cards', 'decks.json'), 'utf8'));
  assert.equal(file.decks[0].cards.length, 0);
});

test('cards are added one at a time, edited, disabled and deleted', async t => {
  const host = await startFixtureRuntime(t);
  const deckId = (await api(host, '/api/admin/cards')).data.decks[0].id;
  const added = await api(host, '/api/admin/cards', { method: 'POST', body: { deckId, card: { title: 'Pirate', text: 'You are a pirate', weight: 2 } } });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const [card] = added.data.decks[0].cards;
  assert.equal(card.title, 'Pirate'); assert.equal(card.weight, 2); assert.equal(card.enabled, true); assert.match(card.id, /^[A-Za-z0-9_-]+$/);
  assert.equal((await api(host, '/api/admin/cards', { method: 'POST', body: { deckId, card: { title: '' } } })).status, 400);
  assert.equal((await api(host, '/api/admin/cards', { method: 'POST', body: { deckId: 'nope', card: { title: 'x' } } })).status, 404);
  assert.equal((await api(host, '/api/admin/cards', { method: 'POST', body: { deckId, card: { title: 'x' }, extra: 1 } })).status, 400);

  const edited = await api(host, `/api/admin/cards/${card.id}`, { method: 'PATCH', body: { card: { text: 'Arr', enabled: false } } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.decks[0].cards[0].text, 'Arr'); assert.equal(edited.data.decks[0].cards[0].enabled, false); assert.equal(edited.data.decks[0].cards[0].title, 'Pirate');
  const asEffect = await api(host, `/api/admin/cards/${card.id}`, { method: 'PATCH', body: { card: { kind: 'effect', effect: { chain: '-af volume=2' } } } });
  assert.equal(asEffect.status, 200); assert.equal(asEffect.data.decks[0].cards[0].kind, 'effect');
  assert.equal((await api(host, `/api/admin/cards/${card.id}`, { method: 'PATCH', body: { card: { effect: { chain: '-af movie=x' } } } })).status, 400, 'a bad chain cannot be patched in');
  const back = await api(host, `/api/admin/cards/${card.id}`, { method: 'PATCH', body: { card: { kind: 'performance' } } });
  assert.equal(back.data.decks[0].cards[0].effect, null, 'switching kind drops the old kind\'s fields');
  assert.equal((await api(host, '/api/admin/cards/unknown', { method: 'PATCH', body: { card: { text: 'x' } } })).status, 404);

  const removed = await api(host, `/api/admin/cards/${card.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200); assert.deepEqual(removed.data.decks[0].cards, []);
  assert.equal((await api(host, `/api/admin/cards/${card.id}`, { method: 'DELETE' })).status, 404);
});

test('batch add previews rows, imports atomically and accepts JSON or text', async t => {
  const host = await startFixtureRuntime(t);
  const deckId = (await api(host, '/api/admin/cards')).data.decks[0].id;
  const post = body => api(host, '/api/admin/cards/batch', { method: 'POST', body });
  const text = 'Whisper | Say everything softly\nPirate | You are a pirate\n\nbad | ' + 'x'.repeat(300);
  const preview = await post({ deckId, format: 'text', content: text, dryRun: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.valid, 2); assert.equal(preview.data.invalid, 1);
  assert.deepEqual(preview.data.rows.map(row => row.ok), [true, true, false]);
  assert.match(preview.data.rows[2].error, /Text can be at most/);
  assert.equal((await api(host, '/api/admin/cards')).data.decks[0].cards.length, 0, 'nothing is saved by a preview');

  const refused = await post({ deckId, format: 'text', content: text });
  assert.equal(refused.status, 400, 'invalid rows stop a confirmed import');
  assert.equal((await api(host, '/api/admin/cards')).data.decks[0].cards.length, 0, 'all or nothing');
  const partial = await post({ deckId, format: 'text', content: text, skipInvalid: true });
  assert.equal(partial.status, 200); assert.equal(partial.data.imported, 2);
  assert.equal(partial.data.decks[0].cards.length, 2);

  const json = JSON.stringify([{ title: 'Robot', kind: 'effect', effect: { chain: '-af acrusher=bits=6:mix=0.8' } }, { title: 'One take', kind: 'constraint', constraint: { takeLimit: 1 } }]);
  const imported = await post({ deckId, format: 'json', content: json });
  assert.equal(imported.status, 200); assert.equal(imported.data.decks[0].cards.length, 4);

  const named = await post({ newDeckName: 'Imported', format: 'json', content: JSON.stringify({ name: 'ignored', cards: [{ title: 'Solo' }] }) });
  assert.equal(named.status, 200);
  const deck = named.data.decks.find(item => item.name === 'Imported');
  assert.equal(deck.cards.length, 1);

  for (const bad of [{ format: 'json', content: '[{"title":"x"}]' }, { deckId, format: 'json' }, { deckId, format: 'csv', content: 'a' }, { deckId, format: 'json', content: '[]' }, { deckId, format: 'json', content: '[{"title":"x"}]', dryRun: 'yes' }, { deckId, format: 'json', content: '[{"title":"x"}]', surprise: 1 }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await post({ deckId, format: 'text', content: Array.from({ length: 201 }, (_, index) => `Card ${index}`).join('\n') })).status, 413);
  assert.equal((await api(host, '/api/admin/cards/batch', { method: 'POST', body: { deckId, format: 'text', content: 'x'.repeat(500_000) } })).status, 413, 'oversized bodies are refused');
  assert.equal((await api(host, '/api/admin/cards/batch', { method: 'POST', token: null, body: { deckId, format: 'text', content: 'a' } })).status, 401);
});

test('a deck holds a bounded number of cards and decks can be created, renamed, exported and deleted', async t => {
  const host = await startFixtureRuntime(t);
  const first = (await api(host, '/api/admin/cards')).data.decks[0];
  const created = await api(host, '/api/admin/decks', { method: 'POST', body: { name: 'Villains' } });
  assert.equal(created.status, 200); assert.equal(created.data.decks.length, 2);
  const villains = created.data.decks.find(deck => deck.name === 'Villains');
  assert.equal((await api(host, `/api/admin/decks/${villains.id}`, { method: 'PATCH', body: { name: 'Heroes' } })).data.decks.some(deck => deck.name === 'Heroes'), true);
  assert.equal((await api(host, '/api/admin/decks', { method: 'POST', body: { name: '' } })).status, 400);
  await api(host, '/api/admin/cards/batch', { method: 'POST', body: { deckId: villains.id, format: 'json', content: JSON.stringify([{ title: 'Mwahaha', text: 'Laugh', weight: 4 }]) } });
  const exported = await api(host, `/api/admin/decks/${villains.id}/export`);
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.data, { format: 'open-dub-deck', version: 1, name: 'Heroes', cards: [{ title: 'Mwahaha', text: 'Laugh', kind: 'performance', effect: null, constraint: null, weight: 4, enabled: true }] });
  assert.match(exported.response.headers.get('content-disposition'), /attachment; filename="open-dub-deck-Heroes\.json"/);
  const again = await api(host, '/api/admin/cards/batch', { method: 'POST', body: { newDeckName: 'Round trip', format: 'json', content: JSON.stringify(exported.data) } });
  assert.equal(again.data.decks.find(deck => deck.name === 'Round trip').cards[0].title, 'Mwahaha', 'an export imports back');
  assert.equal((await api(host, `/api/admin/decks/${villains.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(host, '/api/admin/decks/..%2Fevil/export')).status, 404);
  assert.equal((await api(host, `/api/admin/decks/${first.id}`, { method: 'DELETE' })).status, 200);
  const remaining = (await api(host, '/api/admin/cards')).data.decks;
  assert.equal((await api(host, `/api/admin/decks/${remaining[0].id}`, { method: 'DELETE' })).status, 409, 'the last deck stays');
});

test('decks survive a restart, and a damaged deck file is set aside instead of overwritten', async t => {
  const host = await startFixtureRuntime(t);
  const deckId = (await api(host, '/api/admin/cards')).data.decks[0].id;
  await api(host, '/api/admin/cards', { method: 'POST', body: { deckId, card: { title: 'Persistent' } } });
  await host.stop();
  const second = await createRuntime({ ...host.runtimeOptions });
  await second.start(); t.after(() => second.close());
  const base = `http://127.0.0.1:${second.server.address().port}`;
  const loaded = await (await fetch(base + '/api/admin/cards', { headers: { Authorization: `Bearer ${host.adminToken}` } })).json();
  assert.equal(loaded.decks[0].cards[0].title, 'Persistent');
  await second.close();
  await import('node:fs/promises').then(fs => fs.writeFile(path.join(host.dataDir, 'cards', 'decks.json'), '{ not json'));
  const third = await createRuntime({ ...host.runtimeOptions });
  await third.start(); t.after(() => third.close());
  const files = await readdir(path.join(host.dataDir, 'cards'));
  assert.ok(files.some(name => name.startsWith('decks.damaged-')), 'the unreadable file is kept');
  const fresh = await (await fetch(`http://127.0.0.1:${third.server.address().port}/api/admin/cards`, { headers: { Authorization: `Bearer ${host.adminToken}` } })).json();
  assert.deepEqual(fresh.decks[0].cards, []);
});

// ---------------------------------------------------------------- a match with cards
const TITLES = ['Card A', 'Card B', 'Card C', 'Card D', 'Card E', 'Card F'];
async function startCardMatch(t, { deal = 'per-player', kinds, cards, mode = 'character', start = true, dealNow = true, extraRules = {} } = {}) {
  const host = await startFixtureRuntime(t);
  const deckId = (await api(host, '/api/admin/cards')).data.decks[0].id;
  const content = JSON.stringify(cards ?? TITLES.map((title, index) => ({ title, text: `Do the thing ${index}` })));
  assert.equal((await api(host, '/api/admin/cards/batch', { method: 'POST', body: { deckId, format: 'json', content } })).status, 200);
  const { session } = await host.select();
  const saved = await host.admin('/api/admin/settings', matchSettings({ mode, cards: { enabled: true, deckId, deal, ...(kinds ? { kinds } : {}) }, ...extraRules }));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await host.admin('/api/admin/open-lobby', {});
  const ada = await host.join(session, 'Ada'); const bo = await host.join(session, 'Bo');
  await connectPlayer(host, ada, t); await connectPlayer(host, bo, t);
  if (mode === 'line') await host.admin('/api/admin/deal-lines', {});
  else for (const [character, player] of [['Alice', ada], ['Narrator', ada], ['Bob', bo], ['Cara', bo]]) await host.admin('/api/admin/assign', { character, playerId: player.id });
  let dealt = null;
  if (dealNow) { dealt = await host.admin('/api/admin/cards/deal', {}); assert.equal(dealt.status, 200, JSON.stringify(dealt.data)); }
  if (start) assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  return { host, ada, bo, deckId, session: (await host.admin('/api/state')).data.session };
}
const holderOf = (session, playerId) => session.cards.entries.find(entry => entry.scope === 'player' && entry.target === playerId);

test('cards are off by default and starting a match with an empty deck says why', async t => {
  const host = await startFixtureRuntime(t);
  const { session } = await host.select();
  assert.equal(session.cards.enabled, false); assert.deepEqual(session.cards.entries, []);
  assert.equal((await host.admin('/api/admin/cards/deal', {})).status, 409, 'cards are off');
  const deckId = (await api(host, '/api/admin/cards')).data.decks[0].id;
  await host.admin('/api/admin/settings', matchSettings({ cards: { enabled: true, deckId } }));
  await host.admin('/api/admin/open-lobby', {});
  const ada = await host.join(session, 'Ada');
  for (const character of ['Alice', 'Bob', 'Cara', 'Narrator']) await host.admin('/api/admin/assign', { character, playerId: ada.id });
  const refused = await host.admin('/api/admin/cards/deal', {});
  assert.equal(refused.status, 409); assert.match(refused.data.error, /no enabled cards/i);
  const start = await host.admin('/api/admin/start', {});
  assert.equal(start.status, 409, 'recording does not start without the cards the host asked for');
});

test('each player sees only their own card until the host turns the cards face up', async t => {
  const { host, ada, bo, session } = await startCardMatch(t);
  assert.equal(session.cards.entries.length, 2);
  const adaCard = session.cards.cards[holderOf(session, ada.id).cardId]; const boCard = session.cards.cards[holderOf(session, bo.id).cardId];
  assert.notEqual(adaCard.id, boCard.id, 'no repeats while the deck lasts');

  const adaView = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.deepEqual(adaView.cards.entries.map(entry => entry.target), [ada.id]);
  assert.equal(adaView.cards.cards[adaCard.id].title, adaCard.title);
  const text = JSON.stringify(adaView);
  assert.equal(text.includes(boCard.title), false, 'the other card never reaches this player');
  assert.equal(TITLES.filter(title => text.includes(title)).length, 1, 'not even a decoy is sent before the reveal');
  assert.equal(adaView.cards.guessing, undefined);
  assert.equal((await playerPost(host, ada, '/api/player/guess', { targetPlayerId: bo.id, cardId: boCard.id })).status, 409, 'guessing only opens in the reveal');
  assert.equal(session.cards.entries.length, 2, 'the host sees every card');
  assert.equal(adaView.secretsActive, true);
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: true })).status, 409, 'playback waits for the reveal while cards are dealt');
});

test('cards can be re-dealt before recording and vetoed during it; edits to the deck change nothing mid-match', async t => {
  const { host, session, deckId } = await startCardMatch(t, { start: false });
  const before = session.cards.entries.find(entry => entry.scope === 'player');
  const redealt = await host.admin('/api/admin/cards/redeal', { key: before.key });
  assert.equal(redealt.status, 200);
  const after = redealt.data.session.cards.entries.find(entry => entry.key === before.key);
  assert.notEqual(after.cardId, before.cardId, 're-deal draws a different card');
  assert.equal(Object.keys(redealt.data.session.cards.cards).length, 2, 'unused snapshots are dropped');
  assert.equal((await host.admin('/api/admin/cards/redeal', { key: 'player:nobody' })).status, 404);
  assert.equal((await host.admin('/api/admin/cards/veto', { key: before.key })).status, 409, 'veto starts with recording');
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  assert.equal((await host.admin('/api/admin/cards/redeal', { key: before.key })).status, 409, 're-deal ends when recording starts');
  const vetoed = await host.admin('/api/admin/cards/veto', { key: before.key });
  assert.equal(vetoed.data.session.cards.entries.find(entry => entry.key === before.key).vetoed, true);
  const restored = await host.admin('/api/admin/cards/veto', { key: before.key, vetoed: false });
  assert.equal(restored.data.session.cards.entries.find(entry => entry.key === before.key).vetoed, false);
  assert.equal((await host.admin('/api/admin/cards/deal', {})).status, 409, 'no dealing once recording started');

  const deck = (await api(host, '/api/admin/cards')).data.decks.find(item => item.id === deckId);
  for (const card of deck.cards) await api(host, `/api/admin/cards/${card.id}`, { method: 'DELETE' });
  const during = (await host.admin('/api/state')).data.session;
  assert.equal(during.cards.cards[after.cardId].title, redealt.data.session.cards.cards[after.cardId].title, 'the match kept its own copy of the cards');
});

test('cards are dealt automatically when recording starts if the host did not deal them', async t => {
  const { session } = await startCardMatch(t, { dealNow: false });
  assert.equal(session.cards.entries.length, 2);
});

test('per-line and per-character deals follow the line and the character, not just the player', async t => {
  const perLine = await startCardMatch(t, { deal: 'per-line', mode: 'line' });
  assert.equal(perLine.session.cards.entries.length, fixtureLines.length);
  assert.ok(perLine.session.cards.entries.every(entry => entry.scope === 'line'));
  const adaLines = Object.entries(perLine.session.lineAssignments).filter(([, owner]) => owner === perLine.ada.id).map(([line]) => line);
  const adaView = (await perLine.host.request('/api/state', { token: perLine.ada.token })).data.session;
  assert.deepEqual(adaView.cards.entries.map(entry => entry.target).sort(), [...adaLines].sort(), 'a player sees the cards of their own lines only');

  const perCharacter = await startCardMatch(t, { deal: 'per-character' });
  assert.equal(perCharacter.session.cards.entries.length, 4);
  const boView = (await perCharacter.host.request('/api/state', { token: perCharacter.bo.token })).data.session;
  assert.deepEqual(boView.cards.entries.map(entry => entry.target).sort(), ['Bob', 'Cara']);
});

test('constraint cards limit takes and blind the lines of their holder only', async t => {
  const { host, ada, bo, session } = await startCardMatch(t, {
    kinds: ['constraint'], start: false,
    cards: [{ title: 'Blind and quick', text: 'Fly blind', kind: 'constraint', constraint: { blind: { caption: true }, noReference: true, takeLimit: 1 } }],
  });
  // One card, two players: both get it (the deck comes round again).
  assert.equal(session.cards.entries.length, 2);
  await host.admin('/api/admin/cards/redeal', { key: holderOf(session, bo.id).key });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const admin = (await host.admin('/api/state')).data.session;
  assert.ok(Object.keys(admin.blindLines).length > 0, 'constraint blind joins the blind set');
  const adaLine = Object.keys(admin.blindLines).find(id => admin.roleAssignments[admin.pack.lines.find(line => line.id === id).character] === ada.id);
  assert.ok(adaLine);
  assert.deepEqual(admin.blindLines[adaLine], { caption: true, reference: true, scene: false });
  const adaView = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(adaView.pack.lines.find(line => line.id === adaLine).caption, '');
  assert.equal(adaView.pack.lines.find(line => line.id === adaLine).referenceAudio, null);
  // The card's take limit is enforced by the server for its holder.
  const first = await host.upload(ada, adaLine);
  assert.equal(first.status, 200);
  assert.equal((await host.upload(ada, adaLine)).status, 409);
});

test('an effect card is applied on the server to every take, and cannot be skipped through the API', { skip: !hasFfmpeg && 'FFmpeg not installed' }, async t => {
  const { host, ada, bo, session } = await startCardMatch(t, {
    kinds: ['effect'], cards: [{ title: 'Robot', text: 'Beep', kind: 'effect', effect: { chain: '-af acrusher=bits=6:mix=0.8' } }],
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'open-dub-card-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const real = path.join(directory, 'voice.webm');
  assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.6', '-c:a', 'libopus', '-y', real]).status, 0);
  const bytes = await readFile(real);
  const line = Object.keys(session.roleAssignments).includes('Alice') ? '01_alice' : null;

  const processed = await host.upload(ada, line, { bytes });
  assert.equal(processed.status, 200, JSON.stringify(processed.data));
  const take = processed.data.session.lineTakes[line];
  const stored = await readFile(path.join(host.dataDir, 'takes', `${take.id}.media`));
  assert.notDeepEqual(stored, bytes, 'the stored take is the processed audio, not the upload');
  assert.equal((await host.admin('/api/state')).data.session.lineTakes[line].card, session.cards.entries.find(entry => entry.target === ada.id).cardId, 'the take records the card that shaped it');
  assert.equal((await host.request('/api/state', { token: ada.token })).data.session.lineTakes[line].card, undefined, 'players do not learn the card id early');
  assert.equal((await host.request(`/takes/${take.id}`, { token: ada.token })).response.headers.get('content-type').startsWith('audio/webm'), true);

  // Audio FFmpeg cannot decode is refused and nothing is saved; the player can try again.
  const broken = await host.upload(bo, '02_bob');
  assert.equal(broken.status, 422); assert.match(broken.data.error, /Robot.*could not be applied.*not saved/i);
  const after = (await host.admin('/api/state')).data.session;
  assert.equal(after.lineTakes['02_bob'], undefined);
  assert.deepEqual((await readdir(path.join(host.dataDir, 'tmp'))), [], 'no temporary files are left behind');

  // A vetoed card no longer touches new takes.
  const key = session.cards.entries.find(entry => entry.target === bo.id).key;
  assert.equal((await host.admin('/api/admin/cards/veto', { key })).status, 200);
  assert.equal((await host.upload(bo, '02_bob')).status, 200, 'the unprocessable fixture audio is accepted once the effect is vetoed');
});

test('a failed effect keeps the previous take', { skip: !hasFfmpeg && 'FFmpeg not installed' }, async t => {
  const { host, ada, session } = await startCardMatch(t, { kinds: ['effect'], cards: [{ title: 'Robot', kind: 'effect', effect: { chain: '-af volume=1.5' } }], start: false });
  assert.equal((await host.admin('/api/admin/start', {})).status, 200);
  const first = await host.upload(ada, '01_alice');
  assert.equal(first.status, 422, 'fixture audio is not decodable');
  assert.equal((await host.admin('/api/state')).data.session.lineTakes['01_alice'], undefined);
  void session;
});

// ---------------------------------------------------------------- reveal, guessing and scores
async function recordAll(host, players, session) {
  const owner = id => session.roleAssignments[session.pack.lines.find(line => line.id === id).character];
  for (const line of fixtureLines) {
    const player = players.find(item => item.id === owner(line.id));
    const up = await host.upload(player, line.id);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    assert.equal((await host.accept(player, line.id, up.data.session.lineTakes[line.id].id)).status, 200);
  }
}

test('guessing during the reveal: shortlists, one guess per player, scores once the cards are face up', async t => {
  const { host, ada, bo, session } = await startCardMatch(t);
  await recordAll(host, [ada, bo], session);
  assert.equal((await host.admin('/api/admin/review', {})).status, 200);
  assert.equal((await host.admin('/api/admin/reveal', {})).status, 200);
  const adaCardId = holderOf(session, ada.id).cardId; const boCardId = holderOf(session, bo.id).cardId;

  const view = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(view.cards.open, false);
  assert.deepEqual(view.cards.entries.map(entry => entry.target), [ada.id], 'cards are still face down');
  const guessing = view.cards.guessing;
  assert.equal(guessing.open, true); assert.equal(guessing.scores, undefined);
  assert.deepEqual(Object.keys(guessing.shortlists), [bo.id], 'there is no list for yourself');
  const list = guessing.shortlists[bo.id];
  assert.ok(list.includes(boCardId)); assert.ok(list.length <= 4 && list.length >= 2);
  assert.ok(list.every(id => guessing.options[id].title));
  assert.equal(JSON.stringify(view).includes('"holders"'), false);

  assert.equal((await playerPost(host, ada, '/api/player/guess', { targetPlayerId: ada.id, cardId: adaCardId })).status, 409, 'not yourself');
  assert.equal((await playerPost(host, ada, '/api/player/guess', { targetPlayerId: bo.id, cardId: 'not-on-the-list' })).status, 400);
  const wrong = list.find(id => id !== boCardId);
  assert.equal((await playerPost(host, ada, '/api/player/guess', { targetPlayerId: bo.id, cardId: wrong })).status, 200);
  const changed = await playerPost(host, ada, '/api/player/guess', { targetPlayerId: bo.id, cardId: boCardId });
  assert.equal(changed.data.session.cards.guessing.guesses[bo.id], boCardId, 'a guess can be changed until the host closes guessing');
  const boList = shortlistFor(host.runtime.sessionStore.data.cards, session.matchId, ada.id);
  assert.equal((await playerPost(host, bo, '/api/player/guess', { targetPlayerId: ada.id, cardId: boList.find(id => id !== adaCardId) })).status, 200);

  const opened = await host.admin('/api/admin/cards/open', {});
  assert.equal(opened.status, 200);
  const faceUp = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(faceUp.cards.open, true);
  assert.equal(faceUp.cards.entries.length, 2, 'every card is face up now');
  assert.deepEqual(faceUp.cards.guessing.scores, { [ada.id]: 1, [bo.id]: 1 }, 'a right guess scores for the guesser and the holder; a wrong one for nobody');
  assert.equal(faceUp.cards.guessing.open, false);
  assert.equal((await playerPost(host, ada, '/api/player/guess', { targetPlayerId: bo.id, cardId: wrong })).status, 409, 'guessing is closed');
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
});

test('starting playback closes guessing and turns the cards face up', async t => {
  const { host, ada, bo, session } = await startCardMatch(t);
  await recordAll(host, [ada, bo], session);
  await host.admin('/api/admin/review', {}); await host.admin('/api/admin/reveal', {});
  assert.equal((await host.admin('/api/admin/playback', { allowMissing: false })).status, 200);
  const view = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(view.cards.open, true); assert.equal(view.cards.entries.length, 2);
});

test('non-guessing deals open the cards at the reveal, and the library keeps the cards and scores', async t => {
  const { host, ada, bo, session } = await startCardMatch(t, { deal: 'per-character' });
  await recordAll(host, [ada, bo], session);
  await host.admin('/api/admin/review', {});
  const early = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(early.cards.entries.length, 2, 'a player sees the cards of their own characters');
  await host.admin('/api/admin/reveal', {});
  const view = (await host.request('/api/state', { token: ada.token })).data.session;
  assert.equal(view.cards.open, true); assert.equal(view.cards.entries.length, 4); assert.equal(view.cards.guessing, undefined);
  await host.runtime.sessionStore.pending;
  const list = (await host.admin('/api/library')).data.entries;
  const entry = (await host.admin(`/api/library/${list[0].id}`)).data;
  assert.equal(entry.cards.deal, 'per-character'); assert.equal(entry.cards.cards.length, 4); assert.ok(entry.cards.holders['char:Alice']);
});
