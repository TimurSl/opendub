// Pure card helpers for one match: weighted dealing, the guess shortlist and scoring. The store keeps
// the state (data.cards, data.cardGuesses); nothing here touches disk, the clock or a global RNG
// unless the caller passes none.
export const DECOYS = 3;
export const DECOY_POOL_MAX = 200;

export const keyFor = Object.freeze({
  player: id => "player:" + id,
  line: id => "line:" + id,
  character: name => "char:" + name,
});
export function parseKey(key) {
  const cut = key.indexOf(":");
  const scope = { player: "player", line: "line", char: "character" }[key.slice(0, cut)];
  return scope ? { scope, target: key.slice(cut + 1) } : null;
}

// The fields a match keeps of a card. A snapshot of the card at deal time: editing or deleting the
// card in the deck afterwards changes nothing for a game in progress.
export const cardFields = ({ id, title, text, kind, effect, constraint }) => ({ id, title, text, kind, effect: effect ?? null, constraint: constraint ?? null });

export function seededRandom(text) {
  let hash = 2166136261;
  for (const character of String(text)) { hash ^= character.codePointAt(0); hash = Math.imul(hash, 16777619) >>> 0; }
  let seed = hash >>> 0;
  return () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffled(items, random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) { const target = Math.floor(random() * (index + 1)); [copy[index], copy[target]] = [copy[target], copy[index]]; }
  return copy;
}

// Weighted draws without replacement. The whole pool is used before any card comes round again.
// `avoid` (a Set of card ids) is a preference: it is ignored when nothing else is left.
export function drawCards(pool, count, random = Math.random, { avoid = null } = {}) {
  const drawn = [];
  let remaining = [];
  while (drawn.length < count && pool.length) {
    if (!remaining.length) remaining = [...pool];
    const preferred = avoid ? remaining.filter(card => !avoid.has(card.id)) : remaining;
    const candidates = preferred.length ? preferred : remaining;
    const total = candidates.reduce((sum, card) => sum + (card.weight || 1), 0);
    let roll = random() * total; let pick = candidates[candidates.length - 1];
    for (const card of candidates) { roll -= card.weight || 1; if (roll < 0) { pick = card; break; } }
    remaining = remaining.filter(card => card !== pick);
    drawn.push(pick);
  }
  return drawn;
}

// Adds a card to every key without one (all keys when `existing` is null). Returns the new deal state.
export function dealTo({ keys, pool, existing = null, random = Math.random, deal, deckId, kinds }) {
  const state = existing
    ? structuredClone(existing)
    : { deal, deckId, kinds, cards: {}, holders: {}, vetoed: {}, decoyCards: {} };
  const missing = keys.filter(key => !state.holders[key]);
  const drawn = drawCards(pool, missing.length, random);
  missing.forEach((key, index) => { state.holders[key] = drawn[index].id; state.cards[drawn[index].id] = cardFields(drawn[index]); });
  state.decoyCards = Object.fromEntries(pool.slice(0, DECOY_POOL_MAX).map(card => [card.id, cardFields(card)]));
  return state;
}

// The same shortlist for everyone who guesses this player: the real card plus up to three decoys.
export function shortlistFor(state, matchId, targetPlayerId) {
  const real = state.holders[keyFor.player(targetPlayerId)];
  if (!real) return [];
  const random = seededRandom(`${matchId}:${targetPlayerId}`);
  const decoys = shuffled(Object.keys(state.decoyCards).filter(id => id !== real), random).slice(0, DECOYS);
  return shuffled([real, ...decoys], random);
}

// +1 to each player for every correct guess they make, and +1 to the holder for every correct guess about them.
export function scoreGuesses(state, guesses, playerIds) {
  const scores = Object.fromEntries(playerIds.map(id => [id, 0]));
  if (!state || state.deal !== "per-player") return scores;
  for (const [guesser, targets] of Object.entries(guesses)) {
    if (!(guesser in scores)) continue;
    for (const [target, cardId] of Object.entries(targets)) {
      if (target === guesser || !(target in scores)) continue;
      if (state.holders[keyFor.player(target)] === cardId) { scores[guesser]++; scores[target]++; }
    }
  }
  return scores;
}

// What the library keeps of a match's cards: the cards played, who held them, the guesses and the scores.
export function cardsSummary(data) {
  const state = data.cards;
  if (!state) return null;
  return structuredClone({
    deal: state.deal, deckId: state.deckId, cards: Object.values(state.cards), holders: state.holders, vetoed: state.vetoed,
    guesses: data.cardGuesses, scores: scoreGuesses(state, data.cardGuesses, data.players.map(player => player.id)),
  });
}
