import { node } from '../shared/api.js';
import { renderPlayerChip } from '../shared/identity.js';
import { rankClips } from '../shared/clips.js';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const KIND = { performance: 'Performance', effect: 'Voice effect', constraint: 'Rule' };

// Short labels for the rules in play, shown under the pack title.
export function modeBadges(session) {
  const rules = session.rules || {}; const badges = [];
  if (!session.pack) return badges;
  if (rules.mode === 'duet') badges.push('DUET');
  if (rules.mode === 'relay') badges.push(`RELAY · every ${plural(rules.relayEvery || 3, 'line')}`);
  if (rules.speed?.enabled) badges.push('SPEED ROUND');
  if (rules.mystery) badges.push('MYSTERY');
  if (rules.cards?.enabled) badges.push('CARDS');
  if (rules.takeLimit === 1 && !rules.speed?.enabled) badges.push('ONE TAKE');
  return badges;
}

// What a speed round allows for one line right now. The server owns the clock; this only mirrors it.
export function speedState(session, lineId, take, now) {
  if (!session.rules?.speed?.enabled || !lineId) return { enabled: false, canRecord: true, phase: 'off' };
  if (take) return { enabled: true, canRecord: true, phase: 'taken' };
  const clock = session.lineClocks?.[lineId];
  if (!clock) return { enabled: true, canRecord: false, phase: 'idle' };
  const remaining = clock.deadline - now;
  return remaining > 0 ? { enabled: true, canRecord: true, phase: 'running', remaining } : { enabled: true, canRecord: false, phase: 'expired', remaining: 0 };
}

export function describeConstraint(constraint) {
  const rules = []; const blind = constraint?.blind || {};
  if (blind.caption) rules.push('you cannot read the caption');
  if (blind.reference) rules.push('you cannot hear the original');
  if (blind.scene) rules.push('the scene is hidden');
  if (constraint?.takeLimit) rules.push(`you get ${plural(constraint.takeLimit, 'take')} per line`);
  return rules.length ? `Rules for you: ${rules.join(', ')}.` : '';
}

function faceFor(card, label) {
  const face = node('article', undefined, `card-face card-${card.kind}`);
  const head = node('div', undefined, 'card-face-head');
  head.append(node('span', KIND[card.kind] || card.kind, 'card-kind'));
  if (label) head.append(node('span', label, 'card-label'));
  face.append(head, node('h3', card.title));
  if (card.text) face.append(node('p', card.text, 'card-text'));
  if (card.kind === 'effect') face.append(node('p', 'Applied automatically after you record. You cannot turn it off.', 'card-note'));
  if (card.kind === 'constraint') { const rules = describeConstraint(card.constraint); if (rules) face.append(node('p', rules, 'card-note')); }
  return face;
}

// The card (or cards) that shape this player's lines, face up on their own screen only.
export function renderCards(session, selectedLineId, elements) {
  const cards = session.cards; const { panel, summary, body } = elements;
  let entries = cards?.enabled && !cards.open ? cards.entries : [];
  if (cards?.deal === 'per-line' && selectedLineId) entries = entries.filter(entry => entry.target === selectedLineId);
  panel.hidden = !entries.length;
  if (!entries.length) { body.replaceChildren(); body.dataset.key = ''; return; }
  const key = JSON.stringify([entries.map(entry => [entry.key, entry.cardId, entry.vetoed]), selectedLineId]);
  if (body.dataset.key === key) return;
  body.dataset.key = key;
  const lines = session.pack?.lines || [];
  summary.textContent = entries.length === 1 ? cards.cards[entries[0].cardId]?.title ?? '' : `${entries.length} cards`;
  body.replaceChildren(...entries.map(entry => {
    const card = cards.cards[entry.cardId];
    const label = entry.scope === 'line' ? `Line ${lines.findIndex(line => line.id === entry.target) + 1}` : entry.scope === 'character' ? entry.target : '';
    const face = faceFor(card, label);
    if (entry.vetoed) { face.classList.add('is-vetoed'); face.append(node('p', 'The host turned this card off.', 'card-note')); }
    return face;
  }));
}

// Redub requests: every accepted clip, most requested first. Tiles are updated in place so audio keeps playing.
export function createRedubGrid({ container, onVote }) {
  const tiles = new Map();
  function build(line) {
    const element = node('article', undefined, 'redub-tile');
    const head = node('div', undefined, 'redub-head'); const title = node('strong'); const count = node('span', undefined, 'redub-count'); head.append(title, count);
    const caption = node('p', undefined, 'redub-caption');
    const audio = node('audio'); audio.controls = true; audio.preload = 'none';
    const button = node('button', 'ASK TO REDUB', 'redub-button'); button.type = 'button'; button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => onVote(line.id, button.getAttribute('aria-pressed') !== 'true', button));
    element.append(head, caption, audio, button);
    const tile = { element, title, count, caption, audio, button, takeId: null };
    tiles.set(line.id, tile); container.append(element);
    return tile;
  }
  return {
    reset() { tiles.clear(); container.replaceChildren(); },
    render(session, { busy = new Set() } = {}) {
      const pack = session.pack; if (!pack) return 0;
      const votes = session.redubVotes || {}; const ranked = rankClips(pack.lines, votes);
      let shown = 0;
      ranked.forEach(({ line, index, count }, rank) => {
        const take = session.lineTakes[line.id]; const accepted = take?.status === 'accepted';
        const tile = tiles.get(line.id) ?? build(line);
        tile.element.hidden = !accepted; if (!accepted) return;
        shown++;
        tile.title.textContent = `LINE ${index + 1} · ${line.character}`;
        tile.count.textContent = count ? plural(count, 'request') : '';
        tile.caption.textContent = line.captionHidden ? '' : line.caption;
        tile.caption.hidden = !!line.captionHidden;
        if (tile.takeId !== take.id) { tile.takeId = take.id; tile.audio.pause(); tile.audio.src = take.url; }
        const mine = !!votes[line.id]?.mine;
        tile.button.setAttribute('aria-pressed', String(mine)); tile.button.textContent = mine ? 'REQUESTED · TAKE BACK' : 'ASK TO REDUB';
        tile.button.disabled = busy.has(line.id);
        tile.element.classList.toggle('is-requested', mine); tile.element.classList.toggle('has-requests', count > 0);
        tile.element.style.order = String(rank);
      });
      return shown;
    },
  };
}

// The reveal: guess each other's cards, then see every card and the scores.
export function renderCardReveal(session, viewerId, container, { onGuess, busy = false }) {
  const cards = session.cards; const guessing = cards?.guessing;
  const show = !!cards?.enabled && !!cards.dealt && !!session.revealed && (!!guessing || cards.open);
  container.hidden = !show;
  if (!show) { container.replaceChildren(); container.dataset.key = ''; return; }
  const key = JSON.stringify([cards.entries, cards.open, guessing, session.players.map(player => [player.id, player.nickname, player.color, player.avatar, player.marker]), busy]);
  if (container.dataset.key === key) return;
  container.dataset.key = key; container.replaceChildren();
  const playerOf = id => session.players.find(player => player.id === id) || { nickname: 'Player' };
  if (guessing?.open) {
    container.append(node('h3', 'Guess the cards'), node('p', 'Everyone was dealt a secret card. Pick the one you think each player had. You can change your mind until the host turns the cards face up.', 'help'));
    for (const [targetId, ids] of Object.entries(guessing.shortlists || {})) {
      const block = node('div', undefined, 'guess-block'); block.append(renderPlayerChip(playerOf(targetId), { size: 26 }));
      const options = node('div', undefined, 'guess-options'); options.setAttribute('role', 'radiogroup'); options.setAttribute('aria-label', `Guess the card of ${playerOf(targetId).nickname}`);
      for (const id of ids) {
        const option = guessing.options[id]; if (!option) continue;
        const picked = guessing.guesses?.[targetId] === id;
        const button = node('button', undefined, `guess-option${picked ? ' is-picked' : ''}`); button.type = 'button'; button.setAttribute('role', 'radio'); button.setAttribute('aria-checked', String(picked)); button.disabled = busy;
        button.append(node('strong', option.title)); if (option.text) button.append(node('small', option.text));
        button.addEventListener('click', () => onGuess(targetId, id));
        options.append(button);
      }
      block.append(options); container.append(block);
    }
    return;
  }
  container.append(node('h3', 'The cards'));
  const scores = guessing?.scores;
  const list = node('div', undefined, 'card-results');
  for (const entry of cards.entries) {
    const card = cards.cards[entry.cardId]; if (!card) continue;
    const row = node('article', undefined, 'card-result'); const who = node('div', undefined, 'card-result-who');
    if (entry.scope === 'player') who.append(renderPlayerChip(playerOf(entry.target), { size: 24 }));
    else who.append(node('strong', entry.scope === 'line' ? `Line ${(session.pack?.lines.findIndex(line => line.id === entry.target) ?? -1) + 1}` : entry.target));
    const guess = guessing?.guesses?.[entry.target];
    if (guess && entry.scope === 'player') who.append(node('span', guess === entry.cardId ? 'You guessed it' : 'Not your guess', guess === entry.cardId ? 'badge-ok' : 'badge-miss'));
    row.append(who, faceFor(card, '')); list.append(row);
  }
  container.append(list);
  if (scores) {
    container.append(node('h3', 'Scores'));
    const table = node('ol', undefined, 'score-list');
    for (const player of [...session.players].sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0))) {
      const item = node('li'); item.append(renderPlayerChip(player, { size: 24 }), node('strong', String(scores[player.id] ?? 0)));
      if (player.id === viewerId) item.classList.add('is-me'); table.append(item);
    }
    container.append(table);
  }
}
