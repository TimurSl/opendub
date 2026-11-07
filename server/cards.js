import { promises as fs } from "node:fs";
import path from "node:path";
import { fail, randomId } from "./session/store.js";
import { BLIND_KEYS, CARD_KINDS, TAKE_LIMIT_MAX } from "./session/rules.js";
import { parseCustomAudioArgs, CustomAudioError } from "./custom-audio.js";

// Cards are data, never code. Nothing here ships a card: the deck store starts empty and the host
// fills it in the admin panel (one card at a time, or in batches). Every card, from every route,
// passes through validateCard, so a card cannot carry arbitrary FFmpeg arguments or unknown keys.
export const CARD_LIMITS = Object.freeze({
  title: 60, text: 280, weightMax: 20, perDeck: 500, decks: 50, batchRows: 200, batchChars: 200_000, deckName: 60,
});
const CARD_KEYS = new Set(["id", "title", "text", "kind", "effect", "constraint", "weight", "enabled"]);
const DECK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const printable = value => typeof value === "string" && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);

function onlyKeys(object, allowed, label) {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`Unknown ${label} key: ${key.slice(0, 40)}`);
}
function cardText(value, label, { min, max }) {
  if (!printable(value)) fail(`${label} must be text`);
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length < min) fail(`${label} is required`);
  if (text.length > max) fail(`${label} can be at most ${max} characters`);
  return text;
}

// Returns a normalised card (without an id) or throws a 400 with a message the host can act on.
export function validateCard(input) {
  if (!plain(input)) fail("A card must be an object");
  for (const key of Object.keys(input)) if (!CARD_KEYS.has(key)) fail(`Unknown card key: ${key.slice(0, 40)}`);
  const kind = input.kind ?? "performance";
  if (!CARD_KINDS.includes(kind)) fail(`Kind must be one of ${CARD_KINDS.join(", ")}`);
  const card = {
    title: cardText(input.title, "Title", { min: 1, max: CARD_LIMITS.title }),
    text: cardText(input.text ?? "", "Text", { min: 0, max: CARD_LIMITS.text }),
    kind, effect: null, constraint: null, weight: input.weight ?? 1, enabled: input.enabled ?? true,
  };
  if (!Number.isInteger(card.weight) || card.weight < 1 || card.weight > CARD_LIMITS.weightMax) fail(`Weight must be a whole number from 1 to ${CARD_LIMITS.weightMax}`);
  if (typeof card.enabled !== "boolean") fail("Enabled must be true or false");
  if (kind !== "effect" && input.effect != null) fail("Only effect cards can have an effect");
  if (kind !== "constraint" && input.constraint != null) fail("Only constraint cards can have a constraint");
  if (kind === "effect") {
    if (!plain(input.effect)) fail("An effect card needs effect: { chain: \"-af …\" }");
    onlyKeys(input.effect, ["chain"], "effect");
    try { card.effect = { chain: "-af " + parseCustomAudioArgs(input.effect.chain) }; }
    catch (error) { if (error instanceof CustomAudioError) fail(error.message); throw error; }
  }
  if (kind === "constraint") {
    if (!plain(input.constraint)) fail("A constraint card needs a constraint");
    onlyKeys(input.constraint, ["blind", "takeLimit", "noReference"], "constraint");
    const { blind = {}, takeLimit = null, noReference = false } = input.constraint;
    if (!plain(blind)) fail("constraint.blind must be an object");
    onlyKeys(blind, BLIND_KEYS, "constraint.blind");
    for (const key of BLIND_KEYS) if (blind[key] !== undefined && typeof blind[key] !== "boolean") fail(`constraint.blind.${key} must be true or false`);
    if (typeof noReference !== "boolean") fail("constraint.noReference must be true or false");
    if (takeLimit !== null && (!Number.isInteger(takeLimit) || takeLimit < 1 || takeLimit > TAKE_LIMIT_MAX)) fail(`constraint.takeLimit must be 1 to ${TAKE_LIMIT_MAX}`);
    const constraint = {};
    const hidden = Object.fromEntries(BLIND_KEYS.filter(key => blind[key]).map(key => [key, true]));
    if (noReference) hidden.reference = true;
    if (Object.keys(hidden).length) constraint.blind = hidden;
    if (takeLimit !== null) constraint.takeLimit = takeLimit;
    if (!Object.keys(constraint).length) fail("A constraint card must hide something or limit takes");
    card.constraint = constraint;
  }
  return card;
}

// Turns pasted text into raw entries. JSON: an array of cards, or a deck export ({ name, cards }).
// Text: one performance card per line as "Title | Text" (a tab works too, so a spreadsheet paste does);
// blank lines and lines starting with # are skipped.
export function parseBatch(format, content) {
  if (typeof content !== "string" || !content.trim()) fail("Paste some cards first");
  if (content.length > CARD_LIMITS.batchChars) fail("That is too much text for one import", 413);
  let entries; let name = null;
  if (format === "json") {
    let parsed;
    try { parsed = JSON.parse(content); } catch (error) { fail("This is not valid JSON: " + String(error.message).slice(0, 120)); }
    if (Array.isArray(parsed)) entries = parsed;
    else if (plain(parsed) && Array.isArray(parsed.cards)) { entries = parsed.cards; if (typeof parsed.name === "string") name = parsed.name; }
    else fail("Expected a JSON array of cards, or an object with a cards array");
  } else if (format === "text") {
    entries = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => {
      const cut = line.search(/[|\t]/);
      return cut < 0 ? { title: line } : { title: line.slice(0, cut).trim(), text: line.slice(cut + 1).trim() };
    });
  } else fail("Format must be json or text");
  if (!entries.length) fail("There are no cards in that text");
  if (entries.length > CARD_LIMITS.batchRows) fail(`Import at most ${CARD_LIMITS.batchRows} cards at a time`, 413);
  return { entries, name };
}

// Validates every row without saving anything: the preview step of a batch add.
export function previewBatch(entries) {
  return entries.map((entry, index) => {
    try { const card = validateCard(entry); return { index, ok: true, card }; }
    catch (error) { if (error.status === 400) return { index, ok: false, error: error.message, title: plain(entry) && typeof entry.title === "string" ? entry.title.slice(0, 60) : "" }; throw error; }
  });
}

const deckName = name => cardText(name, "Deck name", { min: 1, max: CARD_LIMITS.deckName });
const exportable = ({ title, text, kind, effect, constraint, weight, enabled }) => ({ title, text, kind, effect, constraint, weight, enabled });

export class CardStore {
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, "decks.json");
    this.state = { version: 1, decks: [] };
    this.chain = Promise.resolve();
  }
  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    let raw = null;
    try { raw = await fs.readFile(this.file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (raw !== null) {
      try { this.state = this.load(JSON.parse(raw)); }
      catch (error) {
        // Keep the unreadable file for the host to inspect instead of silently overwriting it.
        await fs.rename(this.file, path.join(this.dir, `decks.damaged-${Date.now()}.json`)).catch(() => {});
        console.warn("Card decks could not be read and were set aside:", error.message);
      }
    }
    // One empty deck so the admin panel has somewhere to add the first card. No cards are shipped.
    if (!this.state.decks.length) { this.state.decks.push({ id: randomId(9), name: "My cards", cards: [] }); await this.write(this.state); }
    return this;
  }
  load(parsed) {
    if (!plain(parsed) || parsed.version !== 1 || !Array.isArray(parsed.decks)) throw new Error("unsupported deck file");
    const decks = parsed.decks.slice(0, CARD_LIMITS.decks).map(deck => {
      if (!plain(deck) || !DECK_ID.test(deck.id ?? "") || !Array.isArray(deck.cards)) throw new Error("bad deck");
      const cards = [];
      for (const card of deck.cards.slice(0, CARD_LIMITS.perDeck)) {
        if (!plain(card) || !DECK_ID.test(card.id ?? "")) continue;
        try { cards.push({ id: card.id, ...validateCard(card) }); } catch { /* A hand-edited bad card is dropped, not trusted. */ }
      }
      return { id: deck.id, name: deckName(deck.name), cards };
    });
    return { version: 1, decks };
  }
  async write(state) {
    const temporary = this.file + "." + randomId(6) + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  // Mutations are serialised and written atomically; a failed validation changes nothing.
  update(mutator) {
    const task = this.chain.then(async () => {
      const next = structuredClone(this.state);
      const result = mutator(next);
      await this.write(next);
      this.state = next;
      return result;
    });
    this.chain = task.catch(() => {});
    return task;
  }
  list() { return structuredClone(this.state.decks); }
  deck(id) { return this.state.decks.find(deck => deck.id === id) ?? null; }
  find(cardId) {
    for (const deck of this.state.decks) { const card = deck.cards.find(item => item.id === cardId); if (card) return { deck, card }; }
    return null;
  }
  // Cards a match can deal: enabled cards of the chosen deck (the first deck when none is chosen).
  pool(deckId, kinds) {
    const deck = deckId ? this.deck(deckId) : this.state.decks[0];
    return deck ? structuredClone(deck.cards.filter(card => card.enabled && kinds.includes(card.kind))) : [];
  }
  exportDeck(id) {
    const deck = this.deck(id);
    if (!deck) fail("Unknown deck", 404);
    return { format: "open-dub-deck", version: 1, name: deck.name, cards: deck.cards.map(exportable) };
  }
  createDeck(name, entries = []) {
    return this.update(state => {
      if (state.decks.length >= CARD_LIMITS.decks) fail(`You can have at most ${CARD_LIMITS.decks} decks`, 409);
      const deck = { id: randomId(9), name: deckName(name), cards: [] };
      for (const entry of entries) deck.cards.push({ id: randomId(9), ...entry });
      state.decks.push(deck);
      return deck.id;
    });
  }
  renameDeck(id, name) {
    return this.update(state => { const deck = state.decks.find(item => item.id === id); if (!deck) fail("Unknown deck", 404); deck.name = deckName(name); });
  }
  deleteDeck(id) {
    return this.update(state => {
      if (!state.decks.some(deck => deck.id === id)) fail("Unknown deck", 404);
      if (state.decks.length === 1) fail("Keep at least one deck. Delete its cards instead", 409);
      state.decks = state.decks.filter(deck => deck.id !== id);
    });
  }
  // `entries` are validated card objects. All of them are saved, or none.
  addCards(deckId, entries) {
    return this.update(state => {
      const deck = state.decks.find(item => item.id === deckId);
      if (!deck) fail("Unknown deck", 404);
      if (deck.cards.length + entries.length > CARD_LIMITS.perDeck) fail(`A deck holds at most ${CARD_LIMITS.perDeck} cards`, 409);
      const ids = entries.map(entry => { const id = randomId(9); deck.cards.push({ id, ...entry }); return id; });
      return ids;
    });
  }
  updateCard(cardId, patch) {
    return this.update(state => {
      for (const deck of state.decks) {
        const index = deck.cards.findIndex(card => card.id === cardId);
        if (index < 0) continue;
        const { id, ...current } = deck.cards[index];
        if (!plain(patch)) fail("A card patch must be an object");
        // Switching kind drops the other kinds' fields unless the patch brings its own.
        const merged = { ...current, ...patch };
        if (patch.kind && patch.kind !== current.kind) {
          if (patch.effect === undefined) merged.effect = null;
          if (patch.constraint === undefined) merged.constraint = null;
        }
        deck.cards[index] = { id, ...validateCard(merged) };
        return id;
      }
      fail("Unknown card", 404);
    });
  }
  deleteCard(cardId) {
    return this.update(state => {
      for (const deck of state.decks) {
        const before = deck.cards.length;
        deck.cards = deck.cards.filter(card => card.id !== cardId);
        if (deck.cards.length !== before) return;
      }
      fail("Unknown card", 404);
    });
  }
}
